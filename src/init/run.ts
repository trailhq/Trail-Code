/**
 * `trail init`'s look-back, start to end (design 4.1 to 4.9): start the
 * no-model look-back in a worker while init wires the repo, then show what
 * it found and keep only what the person picks.
 *
 * - The person at their own terminal (`personAtTerminal().ok`): the naming
 *   call (and phase 0's PR-review read) may run, unless `--plain` or
 *   `TRAIL_NO_LOOK_BACK` (0 rule 4); then the review screen, whose keys keep.
 * - An agent (`agentRun`: CLAUDECODE, or a claude or pty-wrapper ancestor):
 *   never a `claude` process, even a stand-in; the relay with plain names
 *   for the agent to show as written, and `pending` for `trail keep` (P2).
 * - The person's own script (no TTY, not an agent): the same list without
 *   the agent's line (B9). `--yes` there keeps only the person's own typed
 *   preferences; an agent's `--yes` keeps nothing (R25, P37).
 *
 * Phase 0's find call, which sent typed messages to the model, is gone
 * (R60, D87): `lookBackOffThread` replaces it, skills on or off.
 *
 * #662's team rows share the screen, first and ticked: what reviewers made
 * authors change on merged PRs, tied to code that exists, and what Claude
 * Code keeps about the repo on this machine (no model). With no screen they
 * are kept as #662 keeps them, and the agent is told to ask about the commit
 * (D184).
 *
 * A memory export the person pasted from Claude.ai (`--claude-memory`) adds
 * its facts about code to the same screen, just for them, ticked; with no
 * screen they are kept just for them.
 */
import { createHash } from 'node:crypto';
import { anchoredReviews, finishReviewRead, beginReviewRead, type ReviewFinding, type ReviewRead, type ReviewResult } from '../notes/pr-reviews.js';
import { beginSessionRead, finishSessionRead, offeredSessions, type SessionRead, type SessionResult } from '../learn/sessions.js';
import { learningBody } from '../learn/bar.js';
import { LiveFeed, liveLine } from './live.js';
import { flatLine } from '../notes/flatten.js';
import type { Learning } from '../learn/bar.js';
import { exportCandidates } from '../notes/claude-export.js';
import { finishMemoryRead, memoryCandidates, offeredBefore, type MemoryCandidate } from '../notes/memory-notes.js';
import type { Note } from '../notes/notes.js';
import { repoPlace } from '../notes/home.js';
import { readSettings } from '../skills/settings.js';
import { nameTaken, personAtTerminal, type PersonCheck, type PersonDeps } from '../skills/store.js';
import { countBucket, durationBucket, initKindCounts } from '../telemetry/contract.js';
import { track } from '../telemetry/track.js';
import { candidateId, pickFive } from './candidates.js';
import { whyLine } from './claude-call.js';
import { lookBackOffThread } from './discover-worker.js';
import { newRunId, readInitRecord, uncompiledOf, updateInitRecord, type InitRun } from './init-record.js';
import { keepItems, prefLine, type KeepResult } from './keep.js';
import { leadWords } from './keep-answer.js';
import { lookBackDue, lookBackOff, markLookedBack, norm } from './look-back.js';
import type { LookBackResult } from './look-back-mine.js';
import type { LookBack } from './types.js';
import { NAME_MODEL, nameItems, type Named } from './name-call.js';
import { afterKeepLines, guardDoes, INIT_COPY, numbered, relayLines, repoNameOf, yesLine, type ScreenFacts } from './review-screen.js';
import { runScreen } from './review-tty.js';
import type { InitCandidate, InitItem } from './types.js';

/** An agent ran init: CLAUDECODE set, or a claude or pty-wrapper ancestor. A script the person runs with no TTY is !agentRun(env) (R17). */
export function agentRun(env: NodeJS.ProcessEnv, deps: PersonDeps = {}, person?: PersonCheck): boolean {
  if (env.CLAUDECODE !== undefined) return true;
  return (person ?? personAtTerminal(env, deps)).claudeAncestor;
}

/** 0 rule 4: the person at their own terminal, the look-back on, and no `--plain`. Never starts anything itself. */
export function mayCallClaude(env: NodeJS.ProcessEnv, flags: { plain: boolean }, deps: PersonDeps = {}, person?: PersonCheck): boolean {
  if (flags.plain || lookBackOff(env)) return false;
  return (person ?? personAtTerminal(env, deps)).ok;
}

export interface LookBackReads {
  lb: Promise<LookBackResult> | null;
  reviews: ReviewRead | null;
  /** What past sessions say was decided here, read by the person's own Claude Code; null when not read this run. */
  sessions: SessionRead | null;
  /** #662: Claude Code's memory notes about the repo, fit for the team. Read with no model, look-back due or not. */
  memory: MemoryCandidate[];
  /** The facts about code of a Claude.ai memory export the person passed, just for them. */
  claudeAi: MemoryCandidate[];
  person: PersonCheck;
  agent: boolean;
  model: boolean;
  plain: boolean;
  skills: boolean;
  env: NodeJS.ProcessEnv;
  started: number;
  /** Each learning the reads check, the moment it lands: init's terminal and Trail's page show them then. */
  live: LiveFeed;
}

/** Agent runs stop reading at 100 s so the tool call ends inside Claude Code's 120 s; the person's at 300 s (3.6). */
const AGENT_CAP_MS = 100_000;
const PERSON_CAP_MS = 300_000;

/** Start the look-back and the PR-review read; the lines to print now, before anything finishes. */
export function beginLookBack(repo: string, opts: { env?: NodeJS.ProcessEnv; plain?: boolean; again?: boolean; pair?: boolean; deps?: PersonDeps; claudeExport?: string } = {}):
  { reads: LookBackReads; lines: string[] } {
  const env = opts.env ?? process.env;
  const person = personAtTerminal(env, opts.deps ?? {});
  const agent = agentRun(env, opts.deps ?? {}, person);
  const plain = opts.plain === true;
  const model = !agent && mayCallClaude(env, { plain }, opts.deps ?? {}, person);
  const skills = readSettings(env).skills === 'on';
  const memory = memoryRows(repo, env.HOME);
  const exported = opts.claudeExport === undefined ? null : exportRows(repo, opts.claudeExport);
  const live = new LiveFeed();
  const reads: LookBackReads = { lb: null, reviews: null, sessions: null, memory, claudeAi: exported?.candidates ?? [], person, agent, model, plain, skills, env, started: Date.now(), live };
  const exportLine = exported ? [claudeAiLine(exported.total, exported.candidates.length)] : [];
  if (lookBackOff(env) || !(opts.again || lookBackDue(repo, env))) return { reads, lines: exportLine };
  reads.lb = lookBackOffThread(repo, { env, capMs: agent ? AGENT_CAP_MS : PERSON_CAP_MS, skills });
  const lines = ['· looking back at your past Claude Code sessions here (about a minute)'];
  // The PR-review read is phase 0's second call: only where the naming call may run (0 rule 4), or where the person
  // asked for Trail on its page (`--pair`), whoever runs init. An agent's read ends inside its tool call's limit.
  const reviews = model || (opts.pair === true && !plain);
  reads.reviews = reviews
    ? beginReviewRead(repo, env, 'gh', agent ? AGENT_CAP_MS : undefined, (f) => live.push({ title: f.title, body: f.body, from: 'prs' }))
    : null;
  if (reads.reviews) lines.push("· reading this repo's pull requests for what the team decided and ruled out");
  // The same rule starts the session read: it goes to the person's own Claude Code, on this machine.
  reads.sessions = reviews
    ? beginSessionRead(repo, env, {
      ...(agent ? { capMs: AGENT_CAP_MS } : {}),
      again: opts.again === true,
      onLearning: (l) => live.push({ title: l.headline, body: learningBody(l, '').trim(), from: 'sessions' }),
    })
    : null;
  // One line for both reads of the sessions: the look-back's and what was decided in them.
  if (reads.sessions) lines[0] = '· reading your past Claude Code sessions here for what was decided, with your Claude Code on this laptop (about a minute)';
  return { reads, lines: [...lines, ...exportLine] };
}

/** A Claude.ai export's facts about code, not offered before; none when it can't be read: init never stops for it. */
function exportRows(repo: string, text: string): { total: number; candidates: MemoryCandidate[] } {
  try {
    return exportCandidates(repo, text, { offered: offeredBefore(repo) });
  } catch {
    return { total: 0, candidates: [] };
  }
}

/** What init says it read in a Claude.ai export, before the look-back's lines finish. */
export function claudeAiLine(total: number, offered: number): string {
  if (!total) return "· found nothing in that file: ask Claude.ai to write out what it knows about you, and save its whole answer";
  if (!offered) return `· none of the ${total} things Claude.ai knows about you is about code and new here, so there's nothing to offer from it`;
  return `· init offers ${offered} of the ${total} things Claude.ai knows about you, the ones about code, just for you`;
}

/** #662's memory candidates, or none when they can't be read: init never stops for them. */
function memoryRows(repo: string, home?: string): MemoryCandidate[] {
  try {
    return memoryCandidates(repo, { ...(home ? { home } : {}), offered: offeredBefore(repo) });
  } catch {
    return [];
  }
}

/**
 * A PR-review finding (D24) as a team row: its words are model text, so it is shown on the screen only, never
 * relayed. Only the findings tied to code that exists (#662's anchoredReviews), ticked: the team's start ticked.
 */
function reviewItems(anchored: ReviewFinding[], repoKey: string, closed: Set<string>): InitItem[] {
  return anchored.map((f, n) => {
    const key = `review:${createHash('sha256').update(norm(f.title)).digest('hex').slice(0, 16)}`;
    return {
      id: candidateId('review', key), kind: 'review' as const, key, plainName: '', nameWords: leadWords(f.title),
      count: { days: f.prs.length, from: f.last, to: f.last }, scope: 'repo' as const, applies: repoKey, typed: false, ticked: true,
      review: { prs: f.prs }, detail: detailOf(f.body), evidence: [], rank: n + 1, n: 0, title: f.title, description: '',
    };
  }).filter((c) => !closed.has(c.id));
}

/** A learning's body as the lines its row opens to: "Decided: <why>", then "In the code: …"; one flat line each. */
function detailOf(body: string): string[] {
  const kind = body.match(/^## (.+)$/m)?.[1];
  const lines = body.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  if (kind && lines[0]) lines[0] = `${kind}: ${lines[0]}`;
  return lines.map((l) => flatLine(l, 300)).filter(Boolean);
}

/** What past sessions say was decided, as team rows: model text, so shown on the screen only, never relayed. Ticked. */
function sessionItems(offered: Learning[], repoKey: string, closed: Set<string>): InitItem[] {
  return offered.map((l, n) => {
    const key = `session:${createHash('sha256').update(norm(l.headline)).digest('hex').slice(0, 16)}`;
    return {
      id: candidateId('session', key), kind: 'session' as const, key, plainName: '', nameWords: leadWords(l.headline),
      count: { days: l.sources.length, from: l.last, to: l.last }, scope: 'repo' as const, applies: repoKey, typed: false, ticked: true,
      detail: detailOf(learningBody(l, '')), evidence: [], rank: n + 1, n: 0, title: l.headline, description: '',
    };
  }).filter((c) => !closed.has(c.id));
}

/**
 * #662's memory candidates as team rows, ticked; a Claude.ai export's facts as the person's own, ticked, whose whole
 * words `s` opens. Never relayed: with no screen, #662 keeps them itself.
 */
function memoryItems(memory: MemoryCandidate[], repoKey: string): InitItem[] {
  return memory.map((c, n) => {
    const kind = c.from ? 'claudeai' as const : 'claude' as const;
    const key = `${kind}:${createHash('sha256').update(c.path).digest('hex').slice(0, 16)}`;
    return {
      id: candidateId(kind, key), kind, key, plainName: '', nameWords: leadWords(c.title),
      count: { days: 0, from: c.updated, to: c.updated }, scope: c.forTeam ? 'repo' as const : 'personal' as const, applies: repoKey, typed: false, ticked: true,
      memory: { path: c.path }, ...(c.from ? { detail: [flatLine(c.body.replace(/^## .+\n/, ''), 300)] } : {}), evidence: [], rank: n + 1, n: 0, title: c.title, description: '',
    };
  });
}

/** Rows kept by their own read (#662's, and a Claude.ai export's), not by keepItems. */
const isTeam = (i: Pick<InitItem, 'kind'>) => i.kind === 'review' || i.kind === 'session' || i.kind === 'claude' || i.kind === 'claudeai';

/** For a run with no look-back (not due, or off), so #662's team rows can still be shown. */
const NO_LOOK_BACK: LookBack = {
  sessions: [], skipped: [], days: 0, from: null, to: null, parent: 0, candidates: [], alreadyKept: { here: 0, elsewhere: [] }, howtos: [], ms: 0, errors: [],
};

/** What #662's keeps saved with no screen, for init to say in #662's words (cli.ts). */
export interface TeamKept {
  fromReviews: { result: ReviewResult; saved: Note[]; kept: ReviewFinding[]; offered: number } | null;
  fromSessions: { result: SessionResult; saved: Note[]; kept: Learning[]; offered: number } | null;
  fromMemory: { saved: Note[]; offered: number } | null;
  fromClaudeAi: { saved: Note[]; offered: number } | null;
}

/** The shown items with their titles: the naming call's or the plain name, a guardrail's fixed words, the person's line read now. */
function itemsOf(picked: Array<InitCandidate & { n: number }>, named: Named, env: NodeJS.ProcessEnv): InitItem[] {
  const out: InitItem[] = [];
  for (const c of picked) {
    if (c.kind === 'skill') {
      const nm = named.names[c.id];
      out.push({ ...c, title: nm?.title ?? c.plainName, description: nm?.description ?? c.skill?.compiled.description ?? '' });
    } else if (c.kind === 'guardrail') {
      out.push({ ...c, title: c.plainName, description: guardDoes(c) });
    } else if (c.kind === 'preference') {
      const line = prefLine(c, env);
      if (line) out.push({ ...c, title: line, description: '' });
    }
  }
  // Numbers stay 1..k with no gap, by kind (a preference whose line is gone drops out).
  return out.map((i, k) => ({ ...i, n: k + 1 }));
}

/**
 * `team`: #662's team rows saved into `.trail/learnings/`, for the agent's commit ask; `teamKept`: what they were, with
 * no screen. `read`: what was looked at, for `init --pair` and `--connect` to count: the past sessions, and the merged
 * PRs (null when the PR reviews weren't read). `skills`: the skills the look-back found this run, each kept (or not) on
 * this machine only, for the pair page to list by name and day count: never their steps.
 */
export interface LookBackDone { kept: number; inRepo: boolean; team: number; teamKept?: TeamKept; read?: { sessions: number; prs: number | null }; skills?: FoundSkill[] }

/** A skill the look-back found, as `init --pair` names it to Trail's page: its name and title, and on how many days it came up. */
export interface FoundSkill { id: string; name: string; title: string; days: number }

/**
 * Wait for the reads, show what they found (screen, relay or the script's list), keep what the person picks, and
 * write the init record. `io` is the person's terminal for the screen. #662's team rows come first on the screen;
 * with no screen they are kept as #662 keeps them.
 */
export async function finishLookBack(repo: string, reads: LookBackReads,
  mode: { yes: boolean; say: (line: string) => void; io?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }; now?: Date; verbose?: boolean }): Promise<LookBackDone> {
  const none: LookBackDone = { kept: 0, inRepo: false, team: 0 };
  if (!reads.lb && !reads.memory.length && !reads.claudeAi.length) return none;
  const { env, agent, person } = reads;
  const say = mode.say;
  const now = mode.now ?? new Date();
  const looked = reads.lb !== null;
  // Each learning is said the moment its read checks it, before the reads finish. A read that streamed
  // none (a Claude Code too old to stream) still says what it found when it lands.
  const heard = { prs: 0, sessions: 0 };
  reads.live.listen((l) => {
    heard[l.from]++;
    say(liveLine(l));
  });
  const landed = (from: keyof typeof heard, n: number, where: string, top: string | undefined) =>
    n && !heard[from] ? say(`· found ${n} learning${n === 1 ? '' : 's'} ${where}${top ? `, e.g. "${flatLine(top, 100)}"` : ''}`) : undefined;
  void reads.sessions?.result.then((r) => landed('sessions', r.findings.length, 'in your past sessions', r.findings[0]?.headline), () => undefined);
  void reads.reviews?.result.then((r) => landed('prs', r.findings.length, "in this repo's pull requests", r.findings[0]?.title), () => undefined);
  let lb: LookBackResult = NO_LOOK_BACK;
  if (reads.lb) {
    let settled = false;
    void reads.lb.then(() => (settled = true));
    await Promise.resolve();
    if (!settled) say('· still looking back at your past sessions…');
    lb = await reads.lb;
  }
  const repoKey = repoPlace(repo, env).key;
  const record = readInitRecord(repoKey, env);
  const deferred = new Set(record.deferred);
  // An agent's init never shows what the person put off in their own terminal (4.5, B5).
  const found = lb.candidates.filter((c) => !(agent && deferred.has(c.id)));
  const first = pickFive(found);
  const skillsToName = first.filter((c) => c.kind === 'skill');
  const modelWhy = agent ? 'agent' : reads.plain ? 'plain' : !person.tty ? 'no-tty' : lookBackOff(env) ? 'off' : !person.ok ? 'not-person' : !skillsToName.length ? 'no-skills' : null;
  const namedP: Promise<Named> = reads.model && skillsToName.length
    ? nameItems(skillsToName, env, { taken: (n) => nameTaken(n, { repoKeys: [repoKey], checkout: repo, env }) !== null })
    : Promise.resolve({ names: {}, model: 'none', why: null, sentItems: 0, tokens: 0 });
  let reviewResult: ReviewResult | null = null;
  if (reads.reviews) {
    // Not after it already showed a learning: that line says it's reading.
    if (!reads.reviews.done && !heard.prs) say('· still reading pull requests…');
    reviewResult = await reads.reviews.result.catch(() => null);
  }
  let sessionResult: SessionResult | null = null;
  if (reads.sessions) {
    if (!reads.sessions.done && !heard.sessions) say('· still reading your past sessions…');
    sessionResult = await reads.sessions.result.catch(() => null);
  }
  const named = await namedP;
  const read = { sessions: lb.sessions.length, prs: reviewResult ? reviewResult.prs : null };
  // The look-back's own five, numbered 1..k for the relay and `trail keep`.
  const items = itemsOf(numbered(first), named, env);
  const skills: FoundSkill[] = items.filter((i) => i.kind === 'skill').map((i) => ({ id: i.id, name: i.plainName, title: i.title, days: i.count.days }));
  // #662's team rows: only findings tied to code that exists, and the memory notes; never relayed.
  const anchored = reviewResult ? anchoredReviews(repo, reviewResult.findings) : [];
  const done = new Set([...record.closed, ...record.runs.flatMap((r) => r.kept)]);
  // The same learning from the PRs and from past sessions is offered once: the PR one, which says where it came from.
  const prTitles = anchored.map((f) => ({ title: f.title, body: f.body }));
  const fromPast = sessionResult ? offeredSessions(repo, sessionResult.findings, prTitles) : [];
  const team = [...reviewItems(anchored, repoKey, done), ...sessionItems(fromPast, repoKey, done), ...memoryItems([...reads.memory, ...reads.claudeAi], repoKey)];
  const s = readSettings(env);
  const facts: ScreenFacts = {
    lookBack: lb, model: named.model, why: named.why, tokens: named.tokens, calls: (named.sentItems ? 1 : 0) + (reads.reviews ? 1 : 0) + (reads.sessions ? 1 : 0),
    offers: s.offers, offersOffAt: s.offersOffAt, repoName: repoNameOf(repoKey), agent, skills: reads.skills,
    sentSkills: named.sentItems, reviewsRead: reviewResult?.read ?? 0, ...(named.said ? { whySaid: named.said } : {}),
    ...(looked ? {} : { lookedBack: false }),
  };
  if (reviewResult?.why && reviewResult.why !== named.why) say(`· ${whyLine({ why: reviewResult.why, ...(reviewResult.said ? { said: reviewResult.said } : {}) }, 'pull requests')}`);
  if (sessionResult?.why && sessionResult.why !== named.why && sessionResult.why !== reviewResult?.why)
    say(`· ${whyLine({ why: sessionResult.why, ...(sessionResult.said ? { said: sessionResult.said } : {}) }, 'your past sessions')}`);

  // D135 (3): jobs that met the bar but didn't compile, as codes; said with --verbose.
  const uncompiled = uncompiledOf((lb.refused ?? []).map((u) => ({ job: u.job, days: u.days, why: u.why.split(', ') })));
  if (mode.verbose) for (const u of uncompiled) say(`· not offered as a skill: ${u.job}, on ${u.days} day${u.days === 1 ? '' : 's'} (${u.why.join(', ')})`);
  // One screen: the team rows first, then the look-back's items, numbered on from them.
  const shown = [...team, ...items].map((i, k) => ({ ...i, n: k + 1 }));
  const screen = person.ok && !agent && !mode.yes && !!mode.io && shown.length > 0;
  const run: InitRun = {
    id: newRunId(), at: now.toISOString(), by: agent ? 'agent' : person.ok ? 'person' : 'script', screen: screen ? 'tty' : agent ? 'relay' : 'list',
    reads: { sessions: lb.sessions.length, days: lb.days, from: lb.from, to: lb.to, parent: lb.parent, read: lb.sessions.map((x) => x.sh), skipped: lb.skipped,
      ...(uncompiled.length ? { uncompiled } : {}) },
    model: named.sentItems ? NAME_MODEL : 'none', modelWhy: named.why ?? modelWhy, calls: facts.calls, tokens: named.tokens, ms: lb.ms,
    shown: (screen ? shown : items).filter((i) => i.kind !== 'claude' && i.kind !== 'claudeai').map((i) => i.id), kept: [], closed: [], deferred: [],
  };
  if (looked) {
    updateInitRecord(repoKey, (r) => {
      r.runs.push(run);
    }, env);
  }
  const place = { dir: repo, repoKey, runId: run.id };
  const tele = (outcome: string, picked: number) => {
    if (!looked) return;
    track('cold_start', {
      source: 'sessions', outcome, sessions_bucket: countBucket(lb.sessions.length), offered_bucket: countBucket(items.length),
      picked_bucket: countBucket(picked), duration_bucket: durationBucket(Date.now() - reads.started), model: run.model, ...initKindCounts('offered', items),
    }, { repo });
  };
  /** #662's keeps, each with its own answer: the review rows and the memory rows picked, none, or null (asked again). */
  const keepTeam = async (pick: ((rows: InitItem[]) => InitItem[]) | null | 'auto') => {
    const choose = (rows: InitItem[]) => (pick === null ? null : pick === 'auto' ? undefined : pick(rows));
    const reviewRows = team.filter((i) => i.kind === 'review');
    /** One memory read: the rows picked, each kept where the screen left it (r moves a Claude.ai fact into the repo). */
    const keepMemory = async (kind: 'claude' | 'claudeai', candidates: MemoryCandidate[]) => {
      if (!candidates.length) return null;
      const chosen = choose(team.filter((i) => i.kind === kind));
      const scopes = new Map((chosen ?? []).map((i) => [i.memory?.path, i.scope]));
      const keep = chosen === undefined ? undefined
        : async (c: MemoryCandidate[]) => (chosen === null ? null : c.filter((x) => scopes.has(x.path)).map((x) => ({ ...x, forTeam: scopes.get(x.path) === 'repo' })));
      const r = await finishMemoryRead(repo, candidates, keep, kind === 'claudeai' ? 'claude_ai' : undefined);
      return { saved: r.saved, offered: candidates.length };
    };
    let fromReviews: TeamKept['fromReviews'] = null;
    if (reads.reviews) {
      const chosen = choose(reviewRows);
      const titles = new Set((chosen ?? []).map((i) => i.title));
      // anchoredReviews gives the same findings for the same repo: matched by title, as shown.
      const r = await finishReviewRead(repo, reads.reviews, chosen === undefined ? undefined : async (f) => (chosen === null ? null : f.filter((x) => titles.has(x.title))));
      fromReviews = { ...r, offered: anchored.length };
    }
    let fromSessions: TeamKept['fromSessions'] = null;
    if (reads.sessions) {
      const chosen = choose(team.filter((i) => i.kind === 'session'));
      const titles = new Set((chosen ?? []).map((i) => i.title));
      fromSessions = await finishSessionRead(repo, reads.sessions, chosen === undefined ? undefined : async (f) => (chosen === null ? null : f.filter((x) => titles.has(x.headline))), prTitles);
    }
    const fromMemory = await keepMemory('claude', reads.memory);
    const fromClaudeAi = await keepMemory('claudeai', reads.claudeAi);
    const saved = [...(fromReviews?.saved ?? []), ...(fromSessions?.saved ?? []), ...(fromMemory?.saved ?? []), ...(fromClaudeAi?.saved ?? [])];
    return { fromReviews, fromSessions, fromMemory, fromClaudeAi, team: saved.filter((n) => n.scope === 'repo').length };
  };

  if (!shown.length) {
    if (looked) {
      for (const l of relayLines([], facts)) say(l);
      if (!reads.skills) say(INIT_COPY.skillsOff!);
      if (!lb.errors.length) markLookedBack(repo, now, env);
    }
    if (reads.reviews) await finishReviewRead(repo, reads.reviews, async () => []);
    if (reads.sessions) await finishSessionRead(repo, reads.sessions, async () => []);
    tele('none_found', 0);
    return { ...none, read, skills };
  }

  if (screen) {
    const answer = await runScreen(shown, facts, mode.io!, { repoKey, env });
    const final = shown.map((i) => ({ ...i, ...(answer.scopes[i.n] ?? {}) }));
    let result: KeepResult = { kept: [], notKept: [], refused: [] };
    let teamSaved = 0;
    if (answer.how === 'esc') {
      if (looked) {
        updateInitRecord(repoKey, (r) => {
          const ids = items.map((i) => i.id);
          r.deferred = [...new Set([...r.deferred, ...ids])];
          const me = r.runs.find((x) => x.id === run.id);
          if (me) me.deferred = ids;
          r.pending = [];
          r.pendingFrom = null;
          r.handedAt = null;
          r.handover = null;
        }, env);
      }
      await keepTeam(null);
      tele('cancelled', 0);
    } else {
      const ticked = new Set(answer.how === 'enter' ? answer.ticked : []);
      const picked = final.filter((i) => ticked.has(i.n));
      const own = final.filter((i) => !isTeam(i));
      result = own.length ? keepItems(picked.filter((i) => !isTeam(i)), own, 'tty', env, now, place) : result;
      const keptTeam = picked.filter(isTeam);
      teamSaved = (await keepTeam((rows) => keptTeam.filter((k) => rows.some((r) => r.id === k.id)))).team;
      result = { ...result, kept: [...keptTeam, ...result.kept], notKept: final.filter((i) => !picked.includes(i)) };
      const offeredRow = (i: Pick<InitItem, 'kind'>) => i.kind === 'review' || i.kind === 'session';
      const keptReviews = keptTeam.filter(offeredRow);
      if (keptReviews.length || final.some((i) => offeredRow(i) && !picked.includes(i))) {
        updateInitRecord(repoKey, (r) => {
          r.closed = [...new Set([...r.closed, ...final.filter((i) => offeredRow(i) && !picked.includes(i)).map((i) => i.id)])];
          const me = r.runs.find((x) => x.id === run.id);
          if (me) me.kept = [...new Set([...me.kept, ...keptReviews.map((i) => i.id)])];
        }, env);
      }
      if (looked) markLookedBack(repo, now, env);
      tele('found', result.kept.filter((i) => !isTeam(i)).length);
    }
    for (const l of afterKeepLines({ ...result, how: answer.how }, facts)) say(l);
    return { kept: result.kept.length, inRepo: result.kept.some((i) => i.scope === 'repo'), team: teamSaved, read, skills };
  }

  // No screen: the relay (agent) or the script's list for the look-back's items. A PR-review finding is model text
  // and is never relayed; #662 keeps the team rows itself and says what it kept.
  let list = items;
  let kept = 0;
  if (mode.yes && !agent && list.length) {
    const own = list.filter((i) => i.kind === 'preference' && i.typed && !deferred.has(i.id));
    const r = keepItems(own, list, 'yes', env, now, place);
    kept = r.kept.length;
    say(yesLine(list, false));
    const gone = new Set(r.kept.map((i) => i.id));
    list = list.filter((i) => !gone.has(i.id)).map((i, k) => ({ ...i, n: k + 1 }));
  } else if (mode.yes && agent && list.length) {
    say(yesLine(list, true));
  }
  // The look-back found nothing to keep: its found line and why, but not "nothing to keep", beside the team rows it did find.
  if (looked && !items.length) {
    for (const l of relayLines([], facts)) if (l !== INIT_COPY.nothing) say(l);
    if (!lb.errors.length) markLookedBack(repo, now, env);
  }
  const fromTeam = await keepTeam('auto');
  if (list.length) {
    updateInitRecord(repoKey, (r) => {
      r.pending = list.map((i) => ({ ...i }));
      r.pendingFrom = run.id;
      r.shownAt = now.toISOString();
      r.handedAt = null;
      r.handover = null;
    }, env);
    for (const l of relayLines(list, facts)) say(l);
  }
  if (looked && !reads.skills) say(INIT_COPY.skillsOff!);
  tele('relayed', kept);
  const teamKept = (fromTeam.fromReviews?.saved.length ?? 0) + (fromTeam.fromSessions?.saved.length ?? 0) + (fromTeam.fromMemory?.saved.length ?? 0) + (fromTeam.fromClaudeAi?.saved.length ?? 0);
  return {
    kept: kept + teamKept, inRepo: fromTeam.team > 0, team: fromTeam.team, read, skills,
    teamKept: { fromReviews: fromTeam.fromReviews, fromSessions: fromTeam.fromSessions, fromMemory: fromTeam.fromMemory, fromClaudeAi: fromTeam.fromClaudeAi },
  };
}
