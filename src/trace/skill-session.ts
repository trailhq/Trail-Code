/**
 * The skills session: the gate every skills hook starts with (design 3.0),
 * and the one locked read-modify-write of `~/.trail/sessions/<id>.json`
 * (2.8). That file holds two keys: `trace`, the transcript cursor, and
 * `skills`, this session's `SkillSessionState`. The catch-up (read what the
 * transcript gained, fold it, write sheets for the runs it closed) runs
 * inside the same lock as the state, so the cursor and the state can never
 * disagree.
 *
 * Two gates (0 rule 2): `fold` (runs and run sheets) needs an interactive,
 * top-level session outside CI and scratch folders, on any host; `learn`
 * (pool days, offers, credit, live saves) needs that and tier A. Headless
 * is decided by `CLAUDE_CODE_ENTRYPOINT` (D16), and on Codex by the rollout's
 * first line (4.17: `codex exec` and the MCP server); the lab's switch works only in
 * a lab box (D26); what the payload says about where a prompt came from is
 * never read (D34).
 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { payloadSessionId } from '../claude/hook-io.js';
import { repoPlace, type RepoPlace } from '../notes/home.js';
import { isSolo } from '../notes/solo.js';
import { trailHome } from '../notes/trail-home.js';
import { labInteractive, readSettings, trailNow } from '../skills/settings.js';
import { hostTier } from '../skills/host-facts.js';
import { codexMeta } from './codex.js';
import { readJsonSafe, withLock, writePrivate } from '../util/private-fs.js';
import type { TraceEvent } from './claude.js';
import { CLAUDE_DIALECT, dialectFor } from './dialect.js';
import { sessionPath, takePostMarks } from './gate-file.js';
import { detectHost } from './host.js';
import { checkedSuccess, foldEvents, runHelpers, writeRunSheet, type FoldContext, type FoldResult } from './runs.js';
import type { CodexMeta, RunState, SkillInjection, SkillSessionState } from './types.js';

export { housekeeping } from './housekeeping.js';

export type SkipWhy = 'no-hooks' | 'off' | 'no-session' | 'solo';
export type LearnOffWhy = 'host' | 'headless' | 'ci' | 'subagent' | 'scratch' | 'ephemeral';   // 'host': fold on, learn off; 'ephemeral': a Codex session with no rollout
export interface GateCtx {
  sessionId: string;
  sessionHash: string;          // sha256(sessionId).slice(0, 12)
  host: string;
  tier: 'A' | 'B' | 'C' | 'D';
  entry: 'interactive' | 'headless';
  permissionMode: string | null;
  subagent: boolean;            // agent_id in the payload
  /** Runs are folded and run sheets written: interactive, top level, not CI, not scratch, any host (4.1). */
  fold: boolean;
  /** fold and tier A: pool days, offers, credit, live saves (0 rule 2). */
  learn: boolean;
  learnOff: LearnOffWhy | null;
  dir: string;                  // project dir from the payload
  /** The checkout root of the payload's cwd; '' when it is not inside git. */
  checkout: string;
  repoKey: string;
  transcriptPath: string | null;
  env: NodeJS.ProcessEnv;
  now: Date;
  /** Codex only (4.17): the rollout's first line, read by the gate; the session keeps it in `st.codex.meta`. */
  codexMeta?: CodexMeta | null;
}

const set = (v: string | undefined) => typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

function scratchFolder(cwd: string): boolean {
  // Windows paths ignore case (c:\ and C:\ are one folder) and resolve() gives them '\'.
  const fold = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const p = fold(resolve(cwd));
  if (`${p}${sep}`.includes(`${sep}scratchpad${sep}`)) return true;
  const roots = [tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map((r) => fold(resolve(r)));
  return roots.some((r) => p === r || p.startsWith(r + sep));
}

/** 3.0. */
export function skillsGate(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, now?: Date): { ok: true; ctx: GateCtx } | { ok: false; why: SkipWhy } {
  if (set(env.TRAIL_NO_HOOKS)) return { ok: false, why: 'no-hooks' };
  if (readSettings(env).skills !== 'on') return { ok: false, why: 'off' };
  const p: Record<string, unknown> = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rawId = [p.session_id, p.sessionId, p.conversation_id].find((v) => typeof v === 'string' && v !== '');
  if (rawId === undefined) return { ok: false, why: 'no-session' };
  const sessionId = payloadSessionId(p);
  const info = detectHost(p);
  const tier = hostTier(info.host, info.tier, env);
  const subagent = info.subagent === true || (typeof p.agent_id === 'string' && p.agent_id !== '');
  const transcript = typeof p.transcript_path === 'string' ? p.transcript_path : typeof p.transcriptPath === 'string' ? p.transcriptPath : null;
  // 4.17: Codex says nothing of how it was started in the payload; the rollout's first line does (one positioned read).
  const codex = info.host === 'codex';
  const meta = codex && transcript ? codexMeta(transcript) : null;
  const codexScript = !!meta && (meta.originator === 'codex_exec' || meta.source === 'exec' || meta.source === 'mcp');
  // CLAUDE_CODE_ENTRYPOINT is Claude Code's: unset means a script started it. Other hosts never set it.
  const ep = env.CLAUDE_CODE_ENTRYPOINT;
  // `sdk` with or without a suffix, as the transcript reader treats it (claude.ts).
  const script = (typeof ep === 'string' && ep.startsWith('sdk')) || (!ep && info.host === 'claude') || codexScript;
  const entry: GateCtx['entry'] = script && !labInteractive(env) ? 'headless' : 'interactive';
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : dir;
  // Solo mode (notes/solo.ts): Part 2 off for this repo — no skills offers, credit, or live saves.
  if (isSolo(cwd, env)) return { ok: false, why: 'solo' };
  const learnOff: LearnOffWhy | null = subagent ? 'subagent'
    // A Codex session kept nowhere on disk (R18): nothing to fold or learn from, recall only.
    : codex && !transcript ? 'ephemeral'
    : entry === 'headless' ? 'headless'
    : set(env.CI) || set(env.GITHUB_ACTIONS) ? 'ci'
    : scratchFolder(cwd) ? 'scratch'
    : tier !== 'A' ? 'host'
    : null;
  const place = repoPlace(cwd, env);
  return {
    ok: true,
    ctx: {
      sessionId,
      sessionHash: createHash('sha256').update(sessionId).digest('hex').slice(0, 12),
      host: info.host,
      tier,
      entry,
      permissionMode: typeof p.permission_mode === 'string' ? p.permission_mode : null,
      subagent,
      fold: learnOff === null || learnOff === 'host',
      learn: learnOff === null,
      learnOff,
      dir,
      checkout: place.git ? place.checkout : '',
      repoKey: place.key,
      transcriptPath: transcript || null,
      env,
      now: now ?? trailNow(env),
      ...(codex ? { codexMeta: meta } : {}),
    },
  };
}

function newState(ctx: GateCtx): SkillSessionState {
  return {
    v: 1, sessionHash: ctx.sessionHash, host: ctx.host, tier: ctx.tier, learn: ctx.learn, scopeKeys: ctx.repoKey ? [ctx.repoKey] : [],
    epoch: 0, pendingBoundary: false, runs: [], pendingOffer: null, offerUsed: false, offerUsedBy: null, saveRequest: null,
    injected: [], credit: [], tampered: null, updatedAt: ctx.now.toISOString(),
  };
}

/** The stored state when it has the shape this version writes; null otherwise (a new one is made). */
function parseState(v: unknown): SkillSessionState | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = v as SkillSessionState;
  if (s.v !== 1 || typeof s.epoch !== 'number' || !Array.isArray(s.runs) || !Array.isArray(s.injected) || !Array.isArray(s.credit)) return null;
  if (!s.runs.every((r) => r && typeof r.id === 'string' && Array.isArray(r.calls))) return null;
  return s;
}

const statePath = (ctx: GateCtx) => sessionPath(ctx.sessionId, '.json', ctx.env);

function readBox(path: string): Record<string, unknown> {
  const raw = readJsonSafe<unknown>(path);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Writes `skills`, keeping `trace` (just moved by the catch-up) and any other key as they are on disk now. */
function save(path: string, st: SkillSessionState): void {
  const box = readBox(path);
  box.skills = st;
  writePrivate(path, JSON.stringify(box));
}

function foldContext(ctx: GateCtx, marks: FoldContext['marks']): FoldContext {
  const places = new Map<string, RepoPlace>();
  const place = (p: string) => {
    let v = places.get(p);
    if (!v) {
      v = repoPlace(p, ctx.env);
      places.set(p, v);
    }
    return v;
  };
  return {
    sessionHash: ctx.sessionHash,
    checkout: ctx.checkout,
    repoKey: ctx.repoKey,
    repoKeyOf: (p) => (place(p).git ? place(p).key : null),
    rootOf: (p) => (place(p).git ? place(p).checkout : null),
    trailHome: trailHome(ctx.env),
    transcriptPath: ctx.transcriptPath ?? '',
    marks,
    now: ctx.now,
  };
}

/** Sheets for closed runs with steps whose calls are still here (the ones this fold closed, or a write that failed before). */
function writeSheets(st: SkillSessionState, closed: RunState[], ctx: GateCtx): void {
  const runs = new Set<RunState>([...closed, ...st.runs.filter((r) => r.closed)]);
  for (const run of runs) {
    if (!run.closed || run.stepCalls <= 0 || !run.calls.length) continue;
    try {
      writeRunSheet(run, checkedSuccess(run, null), { host: ctx.host, tier: ctx.tier, sessionHash: ctx.sessionHash, helpers: runHelpers(run) }, ctx.env);
    } catch {
      /* the calls stay, so the next catch-up writes it */
    }
  }
}

/** Closed runs keep their calls only until their sheet is written (2.8). */
function flushCalls(st: SkillSessionState): void {
  for (const r of st.runs) if (r.closed && r.calls.length && (r.sheet !== 'none' || r.stepCalls <= 0)) r.calls = [];
}

/**
 * Locked read-modify-write of the `skills` key of sessions/<id>.json (lock wait default 200 ms).
 * With catchUp (ctx.fold only): takePostMarks, then the host dialect's readNewEvents(transcript, sessionStatePath(id))
 * (4.16; a host with no dialect keeps 1a's reader, so J24's Cursor and Copilot payloads still fold and are held)
 * then foldEvents, inside the
 * same lock (the `trace` cursor lives in the same file); then, for every run the fold closed with
 * stepCalls > 0 and sheet 'none', writeRunSheet(run, checkedSuccess(run, null)), then its calls are emptied.
 * Returns undefined when the lock timed out: the caller fails open.
 *
 * `fn` still sees the closed runs' calls (in `fold.closed`); they are emptied before the state is written. When `fn`
 * throws, the folded state is written as it was before `fn`, so the cursor that moved and the state agree.
 * `prepare` runs on the state first, before the catch-up: the Codex prompt hook records the prompt's keyed hash
 * there, so a typed line already in the rollout counts in this same read (P30).
 */
export function withSkillSession<T>(ctx: GateCtx, opts: { catchUp: boolean; waitMs?: number; prepare?: (st: SkillSessionState) => void },
  fn: (st: SkillSessionState, fold: (FoldResult & { events: TraceEvent[] }) | null) => T): T | undefined {
  const path = statePath(ctx);
  const done = withLock(path, () => {
    const st = parseState(readBox(path).skills) ?? newState(ctx);
    let fold: (FoldResult & { events: TraceEvent[] }) | null = null;
    // 4.17: the rollout's first line, kept once; the prompt hook's typed hashes stay as they are.
    if (ctx.host === 'codex' && ctx.codexMeta && !st.codex?.meta) st.codex = { meta: ctx.codexMeta, typedShas: st.codex?.typedShas ?? [] };
    opts.prepare?.(st);
    const dialect = dialectFor(ctx.host) ?? CLAUDE_DIALECT;
    if (opts.catchUp && ctx.fold && ctx.transcriptPath) {
      const marks = takePostMarks(ctx.sessionId, ctx.env);
      const events = dialect.readNewEvents(ctx.transcriptPath, path, { env: ctx.env, state: st });
      const res = foldEvents(st, events, foldContext(ctx, marks));
      writeSheets(st, res.closed, ctx);
      fold = { ...res, events };
    }
    const before = structuredClone(st);
    let value: T;
    try {
      value = fn(st, fold);
    } catch (e) {
      flushCalls(before);
      save(path, before);
      throw e;
    }
    flushCalls(st);
    save(path, st);
    return value;
  }, opts.waitMs ?? 200);
  return done.ok ? done.value : undefined;
}

/** Unlocked read (`trail skills`). A new state when none. */
export function loadSkillSession(ctx: GateCtx): SkillSessionState {
  return parseState(readBox(statePath(ctx)).skills) ?? newState(ctx);
}

export function currentRun(st: SkillSessionState): RunState | null {
  const last = st.runs[st.runs.length - 1];
  return last && !last.closed ? last : null;
}

export function injectedThisEpoch(st: SkillSessionState): SkillInjection[] {
  return st.injected.filter((i) => i.epoch === st.epoch);
}

export function liveInjections(st: SkillSessionState): SkillInjection[] {
  return st.injected.filter((i) => i.live);
}
