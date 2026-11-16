/**
 * Init's look-back without a model (design 4.1 to 4.5, P3, R60): discovery,
 * replay through 1a's fold, the miners, Claude Code's how-to files and the
 * candidates, in one pass. `lookBackOffThread` (discover-worker.ts) runs it
 * in a worker; it runs here when a worker can't start.
 *
 * Sessions are read newest first, one at a time, each dropped once mined:
 * at most 4 sheets per job and only preference-shaped typed lines are held
 * across sessions (R36). It stops reading new sessions at `capMs` and says
 * how many it read.
 *
 * What it writes: wall facts to walls.json (classes, programs, days, session
 * hashes; counted once per session through `read`, R45, R57), and the pool
 * days of skills the screen won't show (P10). Never a typed word, a command
 * or a how-to's text. The typed lines it read go when it returns: the
 * candidates hold pointers, and a preference's lead words in memory only.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { everyRepoLearnings } from '../notes/every-repo.js';
import { repoPlace } from '../notes/home.js';
import { parseNote } from '../notes/notes.js';
import { learningsDir } from '../notes/repo-trail.js';
import { trailHome } from '../notes/trail-home.js';
import { timeoutOnPath } from '../trace/guard-fast.js';
import { noteWalls, readWalls } from '../trace/wall-state.js';
import { buildCandidates, pickFive, seedNeverShown } from './candidates.js';
import { readPlain } from './plain-file.js';
import { readHowtos } from './howtos.js';
import { JobMiner, mineWalls } from './miners.js';
import { isPreferenceShape, MAX_PREF_LINES, minePreferences, repoWordsOf } from './prefs.js';
import { replaySession, sessionHashOf, type Replay } from './replay-runs.js';
import { discoverSessions } from './sessions.js';
import { dayOf } from './transcript.js';
import type { InitCandidate, LookBack } from './types.js';

export interface LookBackOpts {
  env: NodeJS.ProcessEnv;
  /** Stop reading new sessions after this long (100 s for an agent run, 300 s for the person, 4.2). */
  capMs: number;
  /** Skills on: skill items too (R60). */
  skills: boolean;
  now?: Date;
  onProgress?: (p: { phase: 'discover' | 'read' | 'compile'; done: number; total: number }) => void;
  /** PR-review findings (D24), as phase 0 builds them. */
  reviews?: InitCandidate[];
  /** What earlier inits here decided; read from `init/<key>.json` when not given (b6 owns that record). */
  decisions?: { closed: Set<string>; closedV1: Set<string>; kept: Set<string>; deferred: Set<string> };
  /** A deferred item is left out only on an agent run (4.5). */
  agent?: boolean;
}

const PROGRESS_MS = 2000;

/** The look-back, plus the jobs that met the bar but didn't compile, with compile's refusal word (the record and
 *  `--verbose`, 4.5). Kept out of `LookBack` itself, whose fields are b0's contract. */
export type LookBackResult = LookBack & { refused?: Array<{ job: string; why: string; days?: number }> };

/** What earlier inits decided, read tolerantly from `init/<key>.json`: v2 ids, or a phase 0 file's quote hashes (R33). */
function decisionsOf(repoKey: string, env: NodeJS.ProcessEnv): NonNullable<LookBackOpts['decisions']> {
  const out = { closed: new Set<string>(), closedV1: new Set<string>(), kept: new Set<string>(), deferred: new Set<string>() };
  const ids = (v: unknown, into: Set<string>, re: RegExp) => {
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && re.test(x)) into.add(x);
  };
  const ID = /^i-[0-9a-f]{10}$/;
  const V1 = /^[0-9a-f]{16}$/;
  try {
    const parts = repoKey.split('/').filter((p) => p && p !== '.' && p !== '..');
    // Never a link or a FIFO planted at the record (b5 review).
    const raw = JSON.parse(readPlain(join(trailHome(env), 'init', ...parts) + '.json', 1024 * 1024) ?? 'null') as Record<string, unknown>;
    if (raw.v === 2) {
      ids(raw.closed, out.closed, ID);
      ids(raw.closedV1, out.closedV1, V1);
      ids(raw.deferred, out.deferred, ID);
      if (Array.isArray(raw.runs)) for (const r of raw.runs) ids((r as { kept?: unknown })?.kept, out.kept, ID);
    } else if (Array.isArray(raw.closed)) {
      for (const c of raw.closed) ids((c as { quotes?: unknown })?.quotes, out.closedV1, V1);
    }
  } catch { /* none yet */ }
  return out;
}

/** An https origin with no credential helper: git-https-auth is still true here (4.5). */
function httpsNoHelper(checkout: string): boolean {
  const git = (...args: string[]) => spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const url = git('remote', 'get-url', 'origin');
  if (url.status !== 0 || !/^https:\/\//.test(url.stdout.trim())) return false;
  const helper = git('config', '--get-all', 'credential.helper');
  return !helper.stdout.trim();
}

/** Kept learnings' titles and bodies, here and in every repo: a preference one of them says is not offered again. */
function keptLearnings(checkout: string, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  try {
    for (const n of everyRepoLearnings(env)) out.push(`${n.title}\n${n.body}`);
  } catch { /* none */ }
  // This repo's learnings and this machine's personal ones for it, through `env` (never a home path, 0 rule 11).
  for (const dir of [learningsDir(checkout), join(repoPlace(checkout, env).dir, 'notes')]) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.md')).slice(0, 500);
    } catch { /* none */ }
    for (const f of names) {
      try {
        const text = readPlain(join(dir, f), 64 * 1024);
        const n = text === null ? null : parseNote(text, join(dir, f));
        if (n) out.push(`${n.title}\n${n.body}`);
      } catch { /* unreadable: skip */ }
    }
  }
  return out;
}

/** The look-back, in this thread. Never throws: a part that fails says so in `errors` and gives nothing. */
export function lookBack(dir: string, opts: LookBackOpts): LookBackResult {
  const t0 = Date.now();
  const env = opts.env;
  const now = opts.now ?? new Date();
  const home = env.HOME || homedir();
  const lb: LookBackResult = { sessions: [], skipped: [], days: 0, from: null, to: null, parent: 0, candidates: [], alreadyKept: { here: 0, elsewhere: [] }, howtos: [], ms: 0, errors: [] };
  const fail = (what: string, e: unknown) => lb.errors.push(`couldn't read ${what} this time (${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)})`);
  const progress = opts.onProgress;
  let lastTick = 0;
  const tick = (phase: 'discover' | 'read' | 'compile', done: number, total: number, force = false) => {
    if (!progress || (!force && Date.now() - lastTick < PROGRESS_MS)) return;
    lastTick = Date.now();
    try {
      progress({ phase, done, total });
    } catch { /* a progress line never stops the look-back */ }
  };
  try {
    tick('discover', 0, 0, true);
    const place = repoPlace(dir, env);
    const repoKey = place.key;
    const checkout = place.checkout;
    const found = discoverSessions(dir, home, now, env);
    lb.skipped = (found.skipped ?? []).map((s) => ({ sh: sessionHashOf(s.path), why: s.why }));
    lb.parent = found.bySource.ancestor;

    const deadline = t0 + Math.max(0, opts.capMs);
    const walls0 = readWalls(env);
    const miner = new JobMiner();
    const wallsAdd: Required<ReturnType<typeof mineWalls>> = { seen: [], fixed: [], read: {}, worked: [] };
    const typed: Replay['typed'] = [];
    const programs = new Set<string>();
    const days = new Set<string>();
    const total = found.sessions.length;
    let done = 0;
    for (const s of found.sessions) {
      if (Date.now() >= deadline) break;
      tick('read', done, total);
      if (!s.path || !s.stretch) continue;
      const r = replaySession(s.path, s.stretch, repoKey, now, { env, maxMs: Math.max(1, Math.min(60_000, deadline - Date.now())) });
      done += 1;
      if (r.headless) {
        lb.skipped.push({ sh: r.sh, why: 'headless' });
        continue;
      }
      miner.add(r);
      const w = mineWalls([r], walls0.read);
      wallsAdd.seen.push(...(w.seen ?? []));
      wallsAdd.fixed.push(...(w.fixed ?? []));
      Object.assign(wallsAdd.read, w.read ?? {});
      // Sessions come newest first: past a few times what minePreferences clusters, older lines add nothing but memory.
      for (const t of r.typed) if (typed.length < 4 * MAX_PREF_LINES && isPreferenceShape(t.text)) typed.push(t);
      for (const p of r.programs) programs.add(p);
      const sDays = new Set(s.prompts.map((p) => dayOf(p.at ?? s.at)).filter(Boolean));
      for (const d of sDays) days.add(d);
      lb.sessions.push({ sh: r.sh, how: s.source ?? 'own', days: sDays.size });
    }
    if (done < total) lb.errors.push(`couldn't read ${total - done} of ${total} sessions this time (out of time)`);
    const sorted = [...days].sort();
    lb.days = sorted.length;
    lb.from = sorted[0] ?? null;
    lb.to = sorted[sorted.length - 1] ?? null;

    tick('compile', done, total, true);
    if (wallsAdd.seen.length || wallsAdd.fixed.length || Object.keys(wallsAdd.read).length) noteWalls(wallsAdd, env);
    const walls = readWalls(env);
    const jobs = miner.result();
    let howtos: ReturnType<typeof readHowtos> = [];
    try {
      const keys = [...new Set(found.sessions.map((s) => (s.path ? basename(dirname(s.path)) : '')).filter(Boolean))];
      howtos = readHowtos(keys, env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
      lb.howtos = [...new Set(howtos.map((h) => h.file))];
    } catch (e) {
      fail('your Claude Code how-to files', e);
    }
    const d = opts.decisions ?? decisionsOf(repoKey, env);
    const skipped: Array<{ job: import('../trace/types.js').JobClass; why: string; days?: number }> = [];
    lb.candidates = buildCandidates({
      jobs, walls, prefs: minePreferences(typed, now), howtos, reviews: opts.reviews ?? [], repoKey, repoWords: repoWordsOf(checkout, programs),
      skills: opts.skills, closed: d.closed, closedV1: d.closedV1, kept: d.kept, deferred: opts.agent ? d.deferred : new Set(), env, checkout,
      machine: { timeoutMissing: !timeoutOnPath(env), httpsNoHelper: httpsNoHelper(checkout) }, learnings: keptLearnings(checkout, env), skipped,
    }, now);
    if (skipped.length) lb.refused = skipped;
    try {
      lb.alreadyKept.here = everyRepoLearnings(env).length;
    } catch { /* none */ }
    try {
      seedNeverShown(jobs, lb.candidates, pickFive(lb.candidates), repoKey, env, now);
    } catch (e) {
      fail('the pool', e);
    }
  } catch (e) {
    fail('your past sessions', e);
  }
  lb.ms = Date.now() - t0;
  return lb;
}
