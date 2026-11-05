/**
 * `trail init`'s last lines: Trail helping on the person's own work before
 * they close the terminal, not a promise about a later session nobody
 * notices (2026-11-04: of 9 developers asked, 6 never saw a learning used).
 *
 * 1. Their last task here: the newest past Claude Code session in the repo
 *    with {@link TASK_MESSAGES} or more typed messages, its day and opening
 *    words, its active minutes and the messages that corrected Claude, and
 *    the learnings the prompt hook's own matching (findNotes) brings up on
 *    its messages, each with where it came from.
 * 2. The learnings themselves, a title and one line each, at most
 *    {@link MAX_SHOWN}: the last task's, then what this run kept. With
 *    neither (no past sessions here, or the read kept nothing), the ones the
 *    team already committed, each with whose and when (2026-11-04: a
 *    teammate's learning applied is the aha a clone with no sessions can
 *    still have). A person at their own terminal answers "right? (y/n)"
 *    for each; the answer stays on this machine, in the repo's Trail home.
 * 3. A first prompt that brings one of them up, shown only once
 *    promptLearnings, the prompt hook's path, returns that learning first
 *    for it.
 * 4. No learning at all, or no prompt that passes: one live lookup on the
 *    repo's map, its top file:line and the tokens it saved.
 *
 * Offline: the transcripts, learnings and map on this machine. No model call.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookupOnHub, notProductCode, shortBody } from '../cloud/onboarding.js';
import { MIN_CUE_CHARS, promptLearnings, promptWords } from '../claude/prompt-hook.js';
import { flatLine } from '../notes/flatten.js';
import { noteAuthor } from '../notes/git-facts.js';
import { ensureRepoHome } from '../notes/home.js';
import { liveLearnings } from '../notes/learning-fields.js';
import { findNotes, shortDate, type Note, type NoteHit } from '../notes/notes.js';
import { IDLE_MS } from '../notes/session-cost.js';
import { countBucket } from '../telemetry/contract.js';
import { track } from '../telemetry/track.js';
import { isCorrection } from '../trace/typed.js';
import { readJson, writeJsonAtomic } from '../util/state.js';
import type { PastSession } from './sessions.js';
import { dayOf, eachLine } from './transcript.js';

/** A session with fewer typed messages is a question, not a task. */
export const TASK_MESSAGES = 3;
/** The most learnings the ending lists. */
export const MAX_SHOWN = 5;
/** The most learnings said to bear on the last task. */
const MAX_FOR_TASK = 3;
/** A task's messages read for matching: the start of the work is where a learning would have been handed over. */
const MAX_TASK_PROMPTS = 60;
/** The repo's learnings past the listed ones tried for a first prompt, when none listed passes. */
const MAX_MORE_TRIES = 15;

/** The last task, as the ending says it. Only what the transcript says: no figure is guessed. */
export interface TaskFacts {
  id: string;
  /** YYYY-MM-DD of its last typed message, this machine's time zone. */
  day: string;
  /** YYYY-MM-DD of its first, when that was an earlier day: a session typed into over weeks says so. */
  since?: string;
  /** The person's opening words, one line. */
  what: string;
  /** Typed messages. */
  messages: number;
  /** Active minutes (gaps over 10 minutes count as nothing, as for a learning's cost); absent when the times aren't there. */
  minutes?: number;
  /** Typed messages Trail's correction check flags. */
  corrections: number;
}

/** One learning the ending lists. */
export interface Shown {
  note: Note;
  /** One short line of it. */
  line: string;
  /** Where it came from: "from that session", "from your past sessions, Nov 3", "Shrish, Oct 27". */
  from: string;
  /** Why it's listed: the last task's messages brought it up, this run kept it, or the repo already has it. */
  group: 'task' | 'kept' | 'repo';
}

/** A first prompt, and the number of the listed learning it brings up. */
export interface TryPrompt { prompt: string; n: number; title: string }

/** One live lookup: the question, its top answer and what it saved against reading the files whole. */
export interface Lookup { question: string; top: string; saved: number; pct: number; files: number }

export interface Ending {
  task: TaskFacts | null;
  shown: Shown[];
  tryPrompt: TryPrompt | null;
  lookup: Lookup | null;
}

/* -------------------------------------------------------------------------- */
/* 1. the last task                                                           */
/* -------------------------------------------------------------------------- */

const lastAt = (s: PastSession) => s.prompts.reduce((m, p) => (p.at && p.at > m ? p.at : m), s.at);

/** The newest session with {@link TASK_MESSAGES} or more typed messages, by its last one. */
export function pickLastTask(sessions: PastSession[]): PastSession | null {
  let best: PastSession | null = null;
  for (const s of sessions) {
    if (s.prompts.length < TASK_MESSAGES) continue;
    if (!best || lastAt(s) > lastAt(best)) best = s;
  }
  return best;
}

/** The person's own words in a typed message, the prompt hook's way: no pasted block, no harness text. */
const own = (text: string) => promptWords(text);

/** A line that labels what follows (`Repo: acme/shop (…)`, `Background:`) rather than asking for something. */
const HEADER = /^[\w ()'/-]{1,40}:(\s|$)/;

/**
 * What a task was about, in the person's words: the first line of their
 * messages that asks for something, three words or more. "hi", "continue"
 * and a pasted context header don't say what the work was.
 */
export function openingWords(s: Pick<PastSession, 'prompts'>): string {
  for (const p of s.prompts) {
    for (const line of p.text.split('\n')) {
      const w = own(line);
      if (w.split(/\s+/).length >= 3 && !HEADER.test(w)) return flatLine(w, 90);
    }
  }
  return flatLine(own(s.prompts[0]?.text ?? ''), 90);
}

/** The task's days, opening words, size and corrections. `minutes` comes from {@link activeMinutes}. */
export function taskFacts(s: PastSession, minutes?: number): TaskFacts {
  const day = dayOf(lastAt(s)) || dayOf(s.at);
  const since = dayOf(s.at);
  return {
    id: s.id,
    day,
    ...(since && since < day ? { since } : {}),
    what: openingWords(s),
    messages: s.prompts.length,
    ...(minutes ? { minutes } : {}),
    corrections: s.prompts.filter((p) => isCorrection(p.text)).length,
  };
}

const TIMESTAMP = /"timestamp":"([^"]+)"/;

/**
 * The active minutes in a session's transcript (its in-repo stretch for one
 * started above the repo): every entry's time, gaps over IDLE_MS counted as
 * nothing, as a learning's cost counts them. Undefined when there are no
 * times to read.
 */
export function activeMinutes(s: Pick<PastSession, 'path' | 'stretch'>): number | undefined {
  if (!s.path) return undefined;
  let prev = 0;
  let active = 0;
  try {
    eachLine(s.path, (line) => {
      const m = TIMESTAMP.exec(line);
      const t = m ? Date.parse(m[1]!) : NaN;
      if (!Number.isFinite(t)) return;
      const gap = t - prev;
      if (prev && gap > 0 && gap <= IDLE_MS) active += gap;
      if (t > prev) prev = t;
    }, s.stretch);
  } catch {
    return undefined;
  }
  const minutes = Math.round(active / 60_000);
  return minutes > 0 ? minutes : undefined;
}

/**
 * The learnings the prompt hook's word match (findNotes, as learningsByWords
 * calls it) brings up on the task's messages, the most often brought up
 * first. The graph ask's file matches are left out: the map then is not the
 * map now.
 */
export function learningsForTask(s: PastSession, notes: Note[]): NoteHit[] {
  const best = new Map<string, NoteHit & { times: number }>();
  for (const p of s.prompts.slice(0, MAX_TASK_PROMPTS)) {
    const words = own(p.text);
    if (words.length < MIN_CUE_CHARS) continue;
    for (const h of findNotes(notes, words)) {
      const key = h.note.path || h.note.title;
      const had = best.get(key);
      best.set(key, { ...h, score: Math.max(h.score, had?.score ?? 0), times: (had?.times ?? 0) + 1 });
    }
  }
  return [...best.values()].sort((a, b) => b.times - a.times || b.score - a.score).map(({ times: _t, ...h }) => h);
}

/* -------------------------------------------------------------------------- */
/* 2. the learnings                                                           */
/* -------------------------------------------------------------------------- */

/** The provenance line init writes under a learning it saved: `_From PR #12 here, Oct 2._`. */
const PROVENANCE = /^_(From [^\n]+?)\._\s*$/m;

/**
 * Where a learning came from, in a few words. `fromTask`: the learnings this
 * run saved from the last task's own session. `me`: the person's name as
 * their learnings carry it.
 */
export function sourceOf(note: Note, ctx: { me?: string; fromTask?: ReadonlySet<string> } = {}): string {
  if (note.id && ctx.fromTask?.has(note.id)) return 'from that session';
  const said = PROVENANCE.exec(note.body)?.[1];
  if (said) {
    const sessions = /^From past Claude sessions here, (.+)$/.exec(said);
    // A teammate's init wrote the same line about their own sessions.
    if (sessions) return ctx.me && note.author && note.author !== ctx.me ? `from ${note.author}'s past sessions, ${sessions[1]}` : `from your past sessions, ${sessions[1]}`;
    return said[0]!.toLowerCase() + said.slice(1);
  }
  return whoAndWhen(note, ctx.me);
}

/** Whose a learning is and when it was saved: "Shrish, Oct 27", "you, Nov 4". */
export function whoAndWhen(note: Pick<Note, 'author' | 'date'>, me?: string): string {
  const who = me && note.author === me ? 'you' : note.author;
  return [who, shortDate(note.date)].filter(Boolean).join(', ');
}

/** One short line of a learning: what was decided, or the trap, cut to fit a terminal. */
export function lineOf(note: Note): string {
  return flatLine(shortBody(note.body).replace(/^In the code:\s*/i, ''), 110);
}

/** The ending's list: what bears on the last task first, then what this run kept, at most {@link MAX_SHOWN}. */
export function shownLearnings(forTask: Note[], kept: Note[], ctx: { me?: string; fromTask?: ReadonlySet<string> } = {}): Shown[] {
  const out: Shown[] = [];
  const seen = new Set<string>();
  const add = (note: Note, group: Shown['group']) => {
    const key = note.path || note.title;
    if (seen.has(key) || out.length >= MAX_SHOWN) return;
    seen.add(key);
    out.push({ note, line: lineOf(note), from: sourceOf(note, ctx), group });
  };
  for (const n of forTask.slice(0, MAX_FOR_TASK)) add(n, 'task');
  for (const n of kept) add(n, 'kept');
  return out;
}

/** Where the person's "right? (y/n)" answers live on this machine: the repo's Trail home, by learning id. */
export function checksPath(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(ensureRepoHome(repo, env).place.dir, 'learning-checks.json');
}

export interface Checks { checks: Record<string, { right: boolean; at: string }> }

/** Saves one answer. Never throws: a lost answer costs one data point, not the init. */
export function saveCheck(repo: string, note: Pick<Note, 'id' | 'path'>, right: boolean, now = new Date(), env: NodeJS.ProcessEnv = process.env): void {
  try {
    const key = note.id || note.path;
    if (!key) return;
    const file = checksPath(repo, env);
    const had = readJson<Checks>(file) ?? { checks: {} };
    had.checks = { ...(had.checks ?? {}), [key]: { right, at: now.toISOString() } };
    writeJsonAtomic(file, had);
  } catch {
    /* not saved this time */
  }
}

/* -------------------------------------------------------------------------- */
/* 3. a first prompt                                                          */
/* -------------------------------------------------------------------------- */

/** An identifier a learning names in backticks: `personAtTerminal`, `run_upgrade()`. */
const SYMBOL = /`([A-Za-z_][A-Za-z0-9_]*[a-z][A-Z_][A-Za-z0-9_]*)(?:\(\))?`/;

/** Whether a file of the repo holds a name: a symbol from a learning's text is paired only with a file it's in. */
export function fileHolds(repo: string): (file: string, sym: string) => boolean {
  return (file, sym) => {
    try {
      return readFileSync(join(repo, file), 'utf8').includes(sym);
    } catch {
      return false;
    }
  };
}

/**
 * Prompts a person might type before touching what a learning is about,
 * built from the code it names: the file and symbol it touches, a symbol in
 * its text with a touched file that `holds` it, a file, else that symbol.
 * Never its title: a prompt that repeats the learning back would show nothing.
 */
export function promptsFor(note: Pick<Note, 'touches' | 'body'>, holds: (file: string, sym: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const ask = (what: string) => `I'm about to change ${what}. What should I know first?`;
  const touches = note.touches.filter((t) => t && !notProductCode(t.split('#')[0]!)).slice(0, 3);
  for (const t of touches) {
    const [file, sym] = t.split('#');
    if (sym) out.push(ask(`${sym} in ${file}`));
  }
  const sym = SYMBOL.exec(note.body)?.[1];
  const file = sym ? touches.map((t) => t.split('#')[0]!).find((f) => holds(f, sym)) : undefined;
  if (sym && file) out.push(ask(`${sym} in ${file}`));
  for (const t of touches) out.push(ask(t.split('#')[0]!));
  if (sym) out.push(ask(sym));
  return [...new Set(out)];
}

/**
 * Whether the prompt hook, given `prompt`, hands Claude `note` first: the
 * same words filter and the same match (promptLearnings with no graph ask,
 * which the hook runs whatever the ask does).
 */
export function bringsUp(repo: string, prompt: string, note: Pick<Note, 'path' | 'title'>): boolean {
  const words = promptWords(prompt);
  if (words.length < MIN_CUE_CHARS) return false;
  const top = promptLearnings(repo, words, null)[0]?.note;
  return Boolean(top && (top.path || top.title) === (note.path || note.title));
}

/**
 * The first prompt that passes {@link bringsUp}, trying the listed learnings
 * in order. Only those: with none listed (no past sessions, nothing kept) the
 * ending looks one thing up instead (4).
 */
export function firstPrompt(repo: string, shown: Note[], check = bringsUp): TryPrompt | null {
  const holds = fileHolds(repo);
  for (const [i, note] of shown.entries()) {
    for (const prompt of promptsFor(note, holds)) if (check(repo, prompt, note)) return { prompt, n: i + 1, title: note.title };
  }
  return null;
}

/**
 * The list when the person's own sessions gave none: the repo's committed
 * learnings, newest first, at most {@link MAX_SHOWN}, each with whose and
 * when, and a first prompt for one of them. When none listed passes, the
 * next {@link MAX_MORE_TRIES} are tried, and one that passes takes the last
 * place, so the prompt's learning is always on the list.
 */
export function repoLearnings(repo: string, notes: Note[], me?: string, check = bringsUp): { shown: Shown[]; tryPrompt: TryPrompt | null } {
  const team = liveLearnings(notes).filter((n) => n.scope === 'repo' && !n.ref);
  const listed = team.slice(0, MAX_SHOWN);
  let tryPrompt = firstPrompt(repo, listed, check);
  for (const note of tryPrompt ? [] : team.slice(MAX_SHOWN, MAX_SHOWN + MAX_MORE_TRIES)) {
    const prompt = promptsFor(note, fileHolds(repo)).find((p) => check(repo, p, note));
    if (!prompt) continue;
    listed[MAX_SHOWN - 1] = note;
    tryPrompt = { prompt, n: MAX_SHOWN, title: note.title };
    break;
  }
  return { shown: listed.map((note) => ({ note, line: lineOf(note), from: whoAndWhen(note, me), group: 'repo' as const })), tryPrompt };
}

/* -------------------------------------------------------------------------- */
/* 4. one live lookup                                                         */
/* -------------------------------------------------------------------------- */

/** One `trail ask` on the repo's most central symbol: its top file:line and what it saved. Null without a map. */
export function liveLookup(repo: string, contextDir?: string): Lookup | null {
  const hub = lookupOnHub(repo, { ...(contextDir ? { contextDir } : {}), tries: 3 });
  if (!hub || !hub.top) return null;
  return { question: `how does ${hub.symbol} work`, top: hub.top, saved: hub.saved, pct: hub.pct, files: hub.files };
}

/* -------------------------------------------------------------------------- */
/* the lines                                                                  */
/* -------------------------------------------------------------------------- */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The task's heading and its one line of facts: only the figures the transcript gave. */
export function taskLines(t: TaskFacts, forTask: number): string[] {
  const facts = [
    `${plural(t.messages, 'message')} from you`,
    ...(t.minutes ? [`about ${t.minutes < 60 ? `${t.minutes} min` : `${Math.floor(t.minutes / 60)} h ${t.minutes % 60} min`} of work`] : []),
    ...(t.corrections ? [`${t.corrections} of them corrected Claude`] : []),
  ];
  return [
    `Your last task here, ${t.since ? `${shortDate(t.since)} to ` : ''}${shortDate(t.day)}: "${t.what}"`,
    `  ${facts.join(', ')}`,
    `  Trail now has ${plural(forTask, 'learning')} for work like it:`,
  ];
}

/** One listed learning: its number and title, its line, where it came from. The last line is where "right? (y/n)" goes. */
export function learningLines(s: Shown, n: number): string[] {
  const pad = ' '.repeat(`  ${n}. `.length);
  return [`  ${n}. ${s.note.title}`, ...(s.line ? [`${pad}${s.line}`] : []), `${pad}${s.from}`];
}

/** What "n" says: the answer is kept, and the learning is still read until a new one replaces it. */
export function wrongLine(n: number): string {
  const pad = ' '.repeat(`  ${n}. `.length);
  return `${pad}saved on this laptop · Claude still reads it until a new learning replaces it: tell Claude what's wrong and it saves one`;
}

/** The learnings' part, numbered on across it: the task's under the task, then what this run kept, then what the repo already has, each under its own heading. */
export function listLines(e: Pick<Ending, 'task' | 'shown'>): Array<{ line: string; ask?: { n: number; s: Shown } }> {
  const out: Array<{ line: string; ask?: { n: number; s: Shown } }> = [];
  const forTask = e.task ? e.shown.filter((s) => s.group === 'task') : [];
  const kept = e.shown.filter((s) => s.group === 'kept' || (s.group === 'task' && !forTask.includes(s)));
  const repo = e.shown.filter((s) => s.group === 'repo');
  let n = 0;
  const items = (list: Shown[]) => {
    for (const s of list) {
      const lines = learningLines(s, ++n);
      const at = n;
      lines.forEach((line, i) => out.push(i === lines.length - 1 ? { line, ask: { n: at, s } } : { line }));
    }
  };
  if (e.task && forTask.length) {
    out.push({ line: '' }, ...taskLines(e.task, forTask.length).map((line) => ({ line })));
    items(forTask);
  }
  if (kept.length) {
    out.push({ line: '' }, { line: forTask.length ? 'Also kept from your past sessions:' : 'Kept from your past sessions:' });
    items(kept);
  }
  if (repo.length) {
    out.push({ line: '' }, { line: "Your team's learnings in this repo:" });
    items(repo);
  }
  return out;
}

/** The last lines: a prompt to paste that brings a learning up, else the live lookup. Empty with neither. */
export function tryLines(e: Pick<Ending, 'tryPrompt' | 'lookup'>): string[] {
  const t = e.tryPrompt;
  if (t) {
    return [
      '',
      'Try it now. Start a new Claude Code session here and paste:',
      `  "${t.prompt}"`,
      `  Trail hands Claude learning ${t.n} with it, before Claude reads any code.`,
    ];
  }
  if (e.lookup) {
    const l = e.lookup;
    return [
      '',
      `Try it now. Trail just answered "${l.question}" from this repo's map:`,
      `  ${l.top}`,
      `  ~${l.saved.toLocaleString('en-US')} tokens saved (${l.pct}%) against reading the ${plural(l.files, 'file')} whole`,
      '  Ask Claude the same in a new session here: it starts from that answer instead of reading files.',
    ];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* putting it together                                                        */
/* -------------------------------------------------------------------------- */

export interface EndingInput {
  repo: string;
  /** The repo's live learnings, as the prompt hook reads them. */
  notes: Note[];
  /** The learnings this run kept, newest first. */
  kept: Note[];
  /** Ids of the learnings this run saved, with the session ids (8 characters) each came from. */
  sources?: Map<string, string[]>;
  /** The repo's past sessions: null when they weren't read. */
  sessions: PastSession[] | null;
  contextDir?: string;
}

/** Everything the ending says, worked out before anything is printed. Never throws. */
export function planEnding(input: EndingInput): Ending {
  try {
    const { repo, notes } = input;
    const last = input.sessions && notes.length ? pickLastTask(input.sessions) : null;
    const hits = last ? learningsForTask(last, notes).map((h) => h.note) : [];
    const task = last && hits.length ? taskFacts(last, activeMinutes(last)) : null;
    const fromTask = new Set<string>();
    if (last) for (const [id, from] of input.sources ?? []) if (from.includes(last.id.slice(0, 8))) fromTask.add(id);
    const me = noteAuthor(repo);
    let shown = shownLearnings(task ? hits : [], input.kept, { me, fromTask });
    let tryPrompt = firstPrompt(repo, shown.map((s) => s.note));
    // Nothing from the person's own sessions: what the team already committed here.
    if (!shown.length) ({ shown, tryPrompt } = repoLearnings(repo, notes, me));
    // Only with no prompt to try: one live lookup instead.
    const lookup = tryPrompt ? null : liveLookup(repo, input.contextDir);
    return { task, shown, tryPrompt, lookup };
  } catch {
    return { task: null, shown: [], tryPrompt: null, lookup: null };
  }
}

/** The answer a key gives: y, n, enter (skip) or a way out (esc, q, Ctrl-C, a closed stdin). */
export type Answer = 'y' | 'n' | 'skip' | 'stop';

/** The answer in one chunk of keys, or null for a key that answers nothing. */
export function answerOf(chunk: string): Answer | null {
  const c = chunk[0];
  if (c === 'y' || c === 'Y') return 'y';
  if (c === 'n' || c === 'N') return 'n';
  if (c === '\r' || c === '\n') return 'skip';
  if (c === '\x1b' || c === '\x03' || c === 'q' || c === 'Q') return 'stop';
  return null;
}

/** One key, raw, on the person's own terminal; the terminal goes back as it was on every way out. */
export function readAnswer(stdin: NodeJS.ReadStream): Promise<Answer> {
  return new Promise((resolve) => {
    const wasRaw = (stdin as { isRaw?: boolean }).isRaw === true;
    const done = (a: Answer) => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('close', onEnd);
      stdin.off('error', onEnd);
      try { stdin.setRawMode?.(wasRaw); } catch { /* not a TTY any more */ }
      try { stdin.pause(); } catch { /* gone */ }
      resolve(a);
    };
    const onData = (b: Buffer | string) => {
      const a = answerOf(typeof b === 'string' ? b : b.toString('utf8'));
      if (a) done(a);
    };
    const onEnd = () => done('stop');
    try { stdin.setRawMode?.(true); } catch { /* read as lines then */ }
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('close', onEnd);
    stdin.on('error', onEnd);
    stdin.resume();
  });
}

/**
 * Says the ending. With `io` (a person at their own terminal, not `--yes`),
 * each listed learning ends with "right? (y/n)" and waits for one key; y or
 * n is saved on this machine, enter skips, esc or q stops asking. One
 * `cold_start` event (`source: check`) counts the answers, never which.
 */
export async function sayEnding(e: Ending, repo: string, opts: {
  say: (line: string) => void;
  io?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };
  /** False under --verbose: the epilogue's steps carry the prompt instead. */
  tryIt?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ answered: number; right: number }> {
  const tally = { answered: 0, right: 0 };
  let stopped = false;
  for (const { line, ask } of listLines(e)) {
    if (!ask || stopped || !opts.io) {
      opts.say(line);
      continue;
    }
    opts.io.stdout.write(`${line} · right? (y/n) `);
    const a = await readAnswer(opts.io.stdin);
    opts.io.stdout.write(`${a === 'y' || a === 'n' ? a : ''}\n`);
    if (a === 'stop') stopped = true;
    if (a !== 'y' && a !== 'n') continue;
    saveCheck(repo, ask.s.note, a === 'y', new Date(), opts.env);
    tally.answered++;
    if (a === 'y') tally.right++;
    else opts.say(wrongLine(ask.n));
  }
  // How many were answered and how many were right, as buckets: never which learning, never its words.
  if (opts.io && (tally.answered || stopped)) {
    track('cold_start', { source: 'check', outcome: stopped ? 'cancelled' : 'kept', offered_bucket: countBucket(tally.answered), picked_bucket: countBucket(tally.right) }, { repo, ...(opts.env ? { env: opts.env } : {}) });
  }
  if (opts.tryIt !== false) for (const l of tryLines(e)) opts.say(l);
  return tally;
}
