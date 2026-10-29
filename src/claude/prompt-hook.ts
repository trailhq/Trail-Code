/**
 * The prompt hook: what the agent reads alongside what the person just typed.
 *
 * Two lookups, independent of each other. The learnings that bear on the
 * prompt are matched here, by their words, from a 3-character prompt up: "ff
 * to prod" is too short to ask the graph about, and an ask that fails or runs
 * out of time must not take the learnings down with it. The graph ask (`graft
 * ask`, pointers only) runs for prompts of MIN_PROMPT_CHARS and up, and when it
 * answers it also brings the learnings that touch the files its hits point into,
 * the teammates' branches on the same code, and the retrieval pack.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { brand, tag } from '../brand.js';
import { scopeOf, scopesOfGraph } from '../graph/scopes.js';
import { keepsNotes } from '../notes/home.js';
import { hookNotice, linkedNews } from '../cloud/nudge.js';
import { findNotes, listNotes, type NoteHit } from '../notes/notes.js';
import { INJECTED_POINTERS_CAP, notesForPrompt, relevantRetrieval, type AskJson } from './format.js';
import { CHILD_TIMEOUT_MS, emitHook, graftJsonWithin, payloadSessionId, withContextDirArg } from './hook-io.js';
import { promptPart } from './skills-wiring.js';
import { recordSkillUse, skillOfPrompt } from './skill-use.js';
import { settleVote } from './learning-vote.js';
import { readSession, readStats, writeSession } from './state.js';
import { readWiring } from './stats.js';
import { ownText, PASTE_MARK } from '../trace/claude.js';

/** Prompts shorter than this never trigger the graph ask — they are almost always
 * conversational ("yes go ahead", "thanks") and the coverage gate can't judge
 * them reliably with so few terms. */
export const MIN_PROMPT_CHARS = 12;

/** Prompts shorter than this match nothing at all, learnings included: no
 * word in them is long enough to look up. "ff to prod" (10) and "ship it" (7)
 * clear it. */
export const MIN_CUE_CHARS = 3;

/**
 * The most the prompt hook takes in all, graph ask included: the person's
 * prompt waits on it before the agent starts. The learnings are matched first
 * and never wait on the ask; the ask gets only what is left. A large repo's
 * ask took 13 s at p95 before this (the lab, on main).
 */
export const PROMPT_BUDGET_MS = 4000;
/** Kept back after the ask for the hook's own work: format, write the session, emit. */
const AFTER_ASK_MS = 250;
/** An ask with less time than this left isn't started: it would only be cut off. */
const MIN_ASK_MS = 500;

/** Headroom left for the hook's own work (read stdin, score, write session, emit)
 * after its `graft ask` child returns, inside the installed timeout. */
const HOOK_OVERHEAD_MS = 2000;
/** Floor for an install from before 0.23 (a timeout meant as ms), so a hand-edited tiny one can't leave the child no time at all. */
const MIN_CHILD_TIMEOUT_MS = 4000;
/** An installed timeout at or over this was written as milliseconds (before 0.23); under it, seconds. */
const LEGACY_MS_FROM = 1000;

/**
 * How long the prompt hook may let `graft ask` run, from the timeout that is
 * *actually installed* (repo and user settings), not from what the current
 * `settings-merge.ts` would install: an upgrade doesn't rewrite settings until
 * the next init or upkeep, and a child that outlives the installed timeout
 * gets the whole hook killed (no learnings, no session write).
 *
 * Claude Code reads `timeout` in seconds, which Trail writes from 0.23 on. A
 * number of 1000 or more is an install from before, meant as milliseconds,
 * and read that way. 0 means no room for an ask at all. The hook's own total
 * budget (PROMPT_BUDGET_MS) cuts this further.
 */
export function promptAskTimeout(dir: string): number {
  const installed = installedHookTimeout(dir, 'UserPromptSubmit');
  if (installed === null) return CHILD_TIMEOUT_MS - HOOK_OVERHEAD_MS;
  if (installed.legacy) return Math.max(MIN_CHILD_TIMEOUT_MS, installed.ms - HOOK_OVERHEAD_MS);
  const room = installed.ms - HOOK_OVERHEAD_MS;
  return room >= MIN_ASK_MS ? room : 0;
}

/**
 * Every settings file Claude Code merges hook definitions from, for a session
 * rooted at `dir`. The per-repo file is not the only place graft's hooks can be
 * installed: declaring them once at the user level wires every repo on the
 * machine at once, and such a repo has no `.claude/settings.json` at all.
 */
function hookSettingsFiles(dir: string): string[] {
  const user = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return [
    join(dir, '.claude', 'settings.json'),
    join(dir, '.claude', 'settings.local.json'),
    join(user, 'settings.json'),
  ];
}

/** An installed timeout in ms, and whether it was written as ms (before 0.23). */
interface Installed {
  ms: number;
  legacy: boolean;
}

/** The timeout on one settings file's graft hook entry for `event`, or null if it
 * can't be read (no settings file, hand-edited shape, unparseable JSON). */
function hookTimeoutIn(file: string, event: string): Installed | null {
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8')) as any;
    const blocks = settings?.hooks?.[event];
    if (!Array.isArray(blocks)) return null;
    for (const block of blocks) {
      for (const h of block?.hooks ?? []) {
        if (typeof h?.command === 'string' && /(graft|trail)-hooks\.cjs|\/\.trail\/hook\.cjs/.test(h.command) && typeof h.timeout === 'number' && h.timeout > 0) {
          const legacy = h.timeout >= LEGACY_MS_FROM;
          return { ms: legacy ? h.timeout : h.timeout * 1000, legacy };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The budget this hook is actually running under, or null when no settings file
 * declares one.
 *
 * The smallest declared timeout wins rather than the nearest, because when more
 * than one file declares the hook Claude Code runs every matching entry and this
 * process cannot tell which one launched it. Guessing high is the expensive
 * mistake: an overrunning child gets the whole hook SIGKILLed, so `emit()` and
 * `writeSession()` never run and the turn silently gets no retrieval at all.
 * Guessing low only shortens one query.
 */
function installedHookTimeout(dir: string, event: string): Installed | null {
  let smallest: Installed | null = null;
  for (const file of hookSettingsFiles(dir)) {
    const timeout = hookTimeoutIn(file, event);
    if (timeout === null) continue;
    if (smallest === null || timeout.ms < smallest.ms) smallest = timeout;
  }
  return smallest;
}

/**
 * The "you're working in backend/, weight it" hint: on a multi-scope repo,
 * narrow the prompt hook's `ask` call to whatever scope the last-edited file
 * (`stats.lastFile`, captured at {@link handlePostEdit}) sits in.
 *
 * `lastFile` is only a basename (not a repo-relative path — see
 * `handlePostEdit`), so this is a best-effort lookup against the CURRENT
 * graph: any file node whose path ends in `/<lastFile>` (or equals it, for a
 * repo-root file). Fails soft in every direction a hook must never crash on —
 * no graph, a single-scope graph, a lastFile no longer in the graph (moved,
 * deleted, or edited before the first build), or a basename that lands in
 * more than one scope (ambiguous: could be either sub-project) all skip the
 * hint silently, logging one line to stderr so the miss is visible without
 * ever failing the hook.
 */
export function lastFileScopeHint(dir: string, lastFile: string | null | undefined): string | null {
  if (!lastFile) return null;
  try {
    const w = readWiring(dir);
    if (!w) return null;
    const scopes = scopesOfGraph(w);
    if (scopes.length <= 1) return null; // single-scope: no hint, no --in
    const matches = (w.nodes ?? []).filter(
      (n) => n.kind === 'file' && (n.path === lastFile || n.path.endsWith(`/${lastFile}`)),
    );
    if (matches.length === 0) {
      console.error(`${tag()} prompt hook: lastFile "${lastFile}" not found in the graph, so no scope hint`);
      return null;
    }
    const prefixes = new Set(matches.map((n) => scopeOf(n.path, scopes).prefix));
    if (prefixes.size > 1) {
      console.error(`${tag()} prompt hook: lastFile "${lastFile}" matches more than one scope, so no scope hint`);
      return null;
    }
    const [prefix] = prefixes;
    return prefix === '' ? null : prefix; // root scope: nothing to narrow
  } catch (e: any) {
    console.error(`${tag()} prompt hook: scope hint lookup failed (${e?.message ?? e}), so no scope hint`);
    return null;
  }
}

/**
 * The learnings that bear on `prompt`, best first: the ones whose title or
 * text share its words, matched here with no graph ask needed, joined by the
 * ones the ask matched on the files its hits point into when it answered. One
 * learning is one entry, at its better score. Empty for a repo that keeps no
 * learnings on this machine, and on any read failure: a missing learning costs
 * one prompt, a broken hook costs the turn.
 */
export function promptLearnings(dir: string, prompt: string, ask: AskJson | null, byWords: NoteHit[] = learningsByWords(dir, prompt)): NoteHit[] {
  const best = new Map<string, NoteHit>();
  const add = (h: NoteHit | undefined) => {
    const key = h?.note && (h.note.path || h.note.title);
    if (!key) return;
    const had = best.get(key);
    if (!had || h.score > had.score) best.set(key, h);
  };
  for (const h of byWords) add(h);
  for (const h of ask?.notes ?? []) add(h);
  return [...best.values()].sort((a, b) => b.score - a.score || String(b.note.date).localeCompare(String(a.note.date)));
}

/** The learnings whose title or text share the prompt's words: no graph needed. Empty on any read failure. */
function learningsByWords(dir: string, prompt: string): NoteHit[] {
  try {
    return keepsNotes(dir) ? findNotes(listNotes(dir), prompt) : [];
  } catch {
    // Nothing matched by words this time; the ask's own matches still count.
    return [];
  }
}

/**
 * The graph ask for `prompt`: pointers only, narrowed to the last-edited
 * file's scope. Null when it fails, runs out of time, or there is no time
 * left before `deadline` to start one.
 */
async function askGraph(dir: string, prompt: string, deadline: number): Promise<AskJson | null> {
  // Pointers-only, small, gated. No --source: per-prompt injected tokens are
  // fresh full-price input on every turn (unlike the cached SessionStart
  // orientation), so the pack carries locators, never inlined code — the agent
  // pulls spans itself via `graft ask --source` when a pointer looks right.
  // relevantRetrieval then drops the pack entirely when the prompt barely
  // overlaps the top hit or when every hit was already injected this session.
  // The prompt goes on stdin (`-`), never in argv, where any process on the
  // machine can read it with `ps`.
  const askArgs = withContextDirArg(dir, ['ask', '-', '.', '--json', '-n', '3']);
  // "You're working in backend/, weight it": only fires on a multi-scope
  // repo whose lastFile resolves cleanly to one scope — see lastFileScopeHint.
  const scopeHint = lastFileScopeHint(dir, readStats(dir)?.lastFile);
  if (scopeHint) askArgs.push('--in', scopeHint);
  const timeout = Math.min(promptAskTimeout(dir), deadline - Date.now() - AFTER_ASK_MS);
  if (timeout < MIN_ASK_MS) return null;
  const ask = await graftJsonWithin(dir, askArgs, timeout, prompt);
  return ask && typeof ask === 'object' ? (ask as AskJson) : null;
}

/**
 * The person's own words in the prompt slot, the shared filter's way: IDE
 * context and reminders stripped, a pasted block left out, and '' when what
 * arrived is harness text (a task notice, a command wrapper, a hand-back).
 */
export function promptWords(raw: unknown): string {
  return ownText(String(raw ?? '')).split(PASTE_MARK).join(' ').trim();
}

/**
 * UserPromptSubmit. Ends inside `budgetMs` (PROMPT_BUDGET_MS by default): the
 * learned-skills part first (its own 400 ms deadline), then the learnings
 * matched by their words, then the graph ask in what is left; whatever was
 * found goes out in one object even when the ask is cut. A skills block (a
 * bare "no" where the host shows it) is the whole answer, with no ask.
 *
 * The skills part comes before the 3-character floor: an answer to an offer
 * can be shorter than that ("no", "y", "ok"), and it only matches what the
 * person typed.
 */
export async function handlePrompt(input: any, dir: string, opts: { budgetMs?: number } = {}): Promise<void> {
  // Background completion notices are machine events, not user queries: no skills answer, no ask (#551).
  if (String(input?.prompt ?? '').trimStart().startsWith('<task-notification>')) return;
  const deadline = Date.now() + (opts.budgetMs ?? PROMPT_BUDGET_MS);
  // `/name` for one of the repo's skills is a run of it; the name only goes.
  recordSkillUse(skillOfPrompt(input?.prompt), input, dir);
  const skills = await promptPart(input, dir);
  if (skills.block) return void emitHook('UserPromptSubmit', { block: skills.block });
  // That this machine just connected reaches the person on the next prompt, whatever it is.
  const news = linkedNews();
  const say = (txt: string, offer?: string | null) =>
    emitHook('UserPromptSubmit', { context: [skills.context, txt].filter(Boolean).join('\n\n'), notice: [skills.notice, news ?? offer].filter(Boolean).join('\n') || undefined });
  const prompt = promptWords(input?.prompt);
  // The reply before asked whether a learning helped: this prompt is the answer, or moves on.
  settleVote(dir, payloadSessionId(input), prompt);
  if (prompt.length < MIN_CUE_CHARS) return say('');
  const underTrail = brand() === 'trail';
  // Learnings first: matched by their words, before and whatever the ask does.
  const byWords = underTrail ? learningsByWords(dir, prompt) : [];
  const ask = prompt.length >= MIN_PROMPT_CHARS ? await askGraph(dir, prompt, deadline) : null;
  // Under graft, learnings come only with the ask; nothing else to say without it.
  if (!ask && !underTrail) return say('');
  const id = payloadSessionId(input);
  const s = readSession(dir, id);
  // What an earlier session worked out matters more than where code is.
  // Part 7: a learning the run block already says (its step repeats it, or it wins over a step) is said once, there.
  const said = new Set(skills.said ?? []);
  const all = underTrail ? promptLearnings(dir, prompt, ask, byWords) : [];
  const learnings = all.filter((h) => !said.has(h.note.id));
  // The session's one shown list, which on-touch reads too: a learning the block said is not shown again on a file open.
  if (said.size) s.injectedNotes = [...(s.injectedNotes ?? []), ...saidPaths(dir, said)].slice(-INJECTED_POINTERS_CAP);
  const notes = learnings.length ? notesForPrompt({ query: prompt, mode: 'learnings', hits: [], notes: learnings }, s) : null;
  const retrieval = ask ? relevantRetrieval(ask, s) : null;
  // A count, never the prompt: nothing the person typed is kept (spec section 6).
  if (ask) s.promptAsks = (s.promptAsks ?? 0) + 1;
  // Teammates' branches on the same code come after an edit instead (hooks.ts editOverlap).
  // A teammate's learning just reached the agent: the moment the person gets the workspace link.
  const offer = notes ? hookNotice(dir, "Claude just got your team's learnings for this", { session: id }) : null;
  say([notes, retrieval].filter(Boolean).join('\n\n'), offer);
  if (ask || notes || said.size) writeSession(dir, id, s);
}

/** The paths the session's shown list knows the learnings `ids` by (as `listNotes` gives them). [] on a read failure. */
function saidPaths(dir: string, ids: ReadonlySet<string>): string[] {
  try {
    return listNotes(dir, { branches: false }).filter((n) => ids.has(n.id)).map((n) => n.path || n.title);
  } catch {
    return [];
  }
}
