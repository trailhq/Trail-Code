/**
 * Ready probes (design 4.15, 4.5 step 11, spec 11): before a run block goes
 * in, the hook checks what the skill needs locally, so the block can say
 * "Uncommitted changes here" or "This checkout is on fix/x, not beta" up
 * front instead of the agent finding out at step 4.
 *
 * Only these forms ever run, each without a shell:
 *   command -v NAME                       a PATH lookup, nothing executed
 *   test -[SfdeE] PATH, [ -S PATH ]       a stat
 *   git status --porcelain                passes on empty output, or only trail init's own files (D116)
 *   git rev-parse --verify REF
 *   git rev-parse --abbrev-ref HEAD = B   passes when the branch is B
 * Anything else in a skill's `ready` line is never run, whoever wrote it:
 * a SKILL.md can be edited by hand. Git runs with optional locks and the
 * fsmonitor off, so a probe never writes the repo and starts nothing else.
 * Nothing here touches the network (`check-first` lines are the agent's).
 *
 * 300 ms in all. A probe not done in time is left out, never reported
 * failed. Results are cached 10 minutes in `state/probes.json`, keyed by a
 * hash of checkout and probe.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ParsedSkill } from './types.js';
import { flatLine } from '../notes/flatten.js';
import { readJsonSafe, trailPath, writePrivate } from '../util/private-fs.js';
import { onlyTrailChanges } from './probe-clean.js';
import { pathDirs, programFiles } from '../trace/guard-fast.js';

export interface ProbeResult { probe: string; ok: boolean; why?: string; fix?: string }

/** What runs git for a probe; tests stub it. `code` null when it didn't finish. */
export type ProbeGit = (args: string[], cwd: string, timeoutMs: number) => { code: number | null; out: string; timedOut: boolean };
export interface ProbeOpts {
  /** At most 300; the prompt hook passes what its deadline leaves. */
  budgetMs?: number;
  git?: ProbeGit;
}

export const PROBE_BUDGET_MS = 300;
const GIT_MS = 150;
const CACHE_MS = 10 * 60_000;
const MAX_PROBES = 6;

type Form =
  | { kind: 'which'; name: string }
  | { kind: 'stat'; flag: string; path: string }
  | { kind: 'clean' }
  | { kind: 'verify'; ref: string }
  | { kind: 'branch'; branch: string };

const NAME = /^[A-Za-z0-9._+-]+$/;
const PATH_TOKEN = /^(?:\$HOME\/|\$\{HOME\}\/|~\/)?[A-Za-z0-9._@%+,:=/-]+$/;
const REF = /^(?!-)[A-Za-z0-9._/@^~-]+$/;
const BRANCH = /^(?!-)[A-Za-z0-9._/-]+$/;

/** The allowlisted form of a probe, or null: never run. */
function formOf(probe: string): Form | null {
  const p = probe.trim().replace(/\s+/g, ' ');
  let m = /^command -v (\S+)$/.exec(p);
  if (m) return NAME.test(m[1]!) ? { kind: 'which', name: m[1]! } : null;
  m = /^test -([SfdeE]) (\S+)$/.exec(p) ?? /^\[ -([SfdeE]) (\S+) \]$/.exec(p);
  if (m) return PATH_TOKEN.test(m[2]!) && !m[2]!.includes('..') ? { kind: 'stat', flag: m[1]!, path: m[2]! } : null;
  if (p === 'git status --porcelain') return { kind: 'clean' };
  m = /^git rev-parse --verify (\S+)$/.exec(p);
  if (m) return REF.test(m[1]!) ? { kind: 'verify', ref: m[1]! } : null;
  m = /^git rev-parse --abbrev-ref HEAD = (\S+)$/.exec(p);
  if (m) return BRANCH.test(m[1]!) ? { kind: 'branch', branch: m[1]! } : null;
  return null;
}

/** The probes of a skill's `ready` line, in order. */
export function readyProbes(s: Pick<ParsedSkill, 'meta'>): string[] {
  return String(s.meta.ready ?? '').split(' ; ').map((x) => x.trim()).filter(Boolean).slice(0, MAX_PROBES);
}

const shown = (t: string) => flatLine(t, 80);

/** A passed probe in words, for the run block's ready line; null for a form that never runs. */
export function probePassWords(probe: string): string | null {
  const f = formOf(probe);
  if (!f) return null;
  switch (f.kind) {
    case 'which': return `${shown(f.name)} installed`;
    case 'stat': return `${shown(f.path)} there`;
    case 'clean': return 'no uncommitted changes';
    case 'verify': return `${shown(f.ref)} exists`;
    case 'branch': return `on ${shown(f.branch)}`;
  }
}

function socketWords(path: string): { why: string; fix: string } {
  if (/\.colima\b/i.test(path)) return { why: "Colima's socket isn't there", fix: 'Start it first: colima start' };
  if (/docker/i.test(path)) return { why: "Docker's socket isn't there", fix: 'Start Docker first, or ask the person.' };
  return { why: `${shown(path)} isn't there`, fix: 'Start what it belongs to first, or ask the person.' };
}

const defaultGit: ProbeGit = (args, cwd, timeoutMs) => {
  try {
    const out = execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
      cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
    });
    return { code: 0, out, timedOut: false };
  } catch (e: any) {
    const timedOut = e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM';
    return { code: timedOut ? null : typeof e?.status === 'number' ? e.status : null, out: String(e?.stdout ?? ''), timedOut };
  }
};

function statOf(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** A path token with $HOME and ~ expanded; relative to the checkout. null when it can't be placed. */
function placed(token: string, checkout: string, env: NodeJS.ProcessEnv): string | null {
  const home = env.HOME || homedir();
  const t = token.replace(/^(?:\$HOME|\$\{HOME\}|~)\//, `${home}/`);
  if (isAbsolute(t)) return t;
  return checkout ? resolve(checkout, t) : null;
}

/** On PATH: an executable file of that name, or on Windows git.exe, npm.cmd and the like (PATHEXT; no exec bit there). */
function which(name: string, env: NodeJS.ProcessEnv): boolean {
  const names = programFiles(name, env);
  for (const dir of pathDirs(env)) {
    for (const n of names) {
      const p = join(dir, n);
      if (!statOf(p)?.isFile()) continue;
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch { /* not executable: look further */ }
    }
  }
  return false;
}

/** One probe: a result, or null when it was left out (no time, no checkout, an answer git couldn't give). */
function runOne(probe: string, f: Form, checkout: string, env: NodeJS.ProcessEnv, gitRun: ProbeGit, left: () => number): ProbeResult | null {
  switch (f.kind) {
    case 'which':
      return which(f.name, env) ? { probe, ok: true }
        : { probe, ok: false, why: `${shown(f.name)} isn't installed here`, fix: "Tell the person; don't install it for them." };
    case 'stat': {
      const p = placed(f.path, checkout, env);
      if (!p) return null;
      const st = statOf(p);
      const ok = !!st && (f.flag === 'S' ? st.isSocket() : f.flag === 'f' ? st.isFile() : f.flag === 'd' ? st.isDirectory() : true);
      if (ok) return { probe, ok: true };
      return f.flag === 'S' ? { probe, ok: false, ...socketWords(f.path) } : { probe, ok: false, why: `${shown(f.path)} isn't there`, fix: 'Tell the person before going on.' };
    }
    default: {
      if (!checkout) return null;
      const ms = Math.min(GIT_MS, left());
      if (ms <= 0) return null;
      const args = f.kind === 'clean' ? ['status', '--porcelain'] : f.kind === 'verify' ? ['rev-parse', '--verify', '--quiet', f.ref] : ['rev-parse', '--abbrev-ref', 'HEAD'];
      const r = gitRun(args, checkout, ms);
      if (r.timedOut || r.code === null) return null;
      if (f.kind === 'clean') {
        if (r.code !== 0) return null;
        // D120 (2): the paths `trail init` recorded writing here, still as it left them, are not the person's.
        const clean = r.out.trim() === '' || onlyTrailChanges(r.out, checkout, gitRun, Math.max(1, Math.min(GIT_MS, left())), env);
        return clean ? { probe, ok: true } : { probe, ok: false, why: 'Uncommitted changes here', fix: "Tell the person; don't commit or stash for them." };
      }
      if (f.kind === 'verify') {
        if (r.code === 0) return { probe, ok: true };
        return r.code === 1 ? { probe, ok: false, why: `${shown(f.ref)} isn't here`, fix: 'Fetch it first, or ask the person.' } : null;
      }
      if (r.code !== 0) return null;
      const cur = r.out.trim();
      if (cur === f.branch) return { probe, ok: true };
      return { probe, ok: false, why: `This checkout is on ${cur === 'HEAD' ? 'a detached commit' : shown(cur)}, not ${shown(f.branch)}`, fix: 'Ask the person before switching.' };
    }
  }
}

interface CacheEntry { at: string; ok: boolean; why?: string; fix?: string }
interface CacheFile { v: 1; entries: Record<string, CacheEntry> }

const cachePath = (env?: NodeJS.ProcessEnv) => trailPath(env, 'state', 'probes.json');
const cacheKey = (checkout: string, probe: string) => createHash('sha256').update(`${checkout}\0${probe}`).digest('hex').slice(0, 24);

function readCache(env?: NodeJS.ProcessEnv): CacheFile {
  const raw = readJsonSafe<CacheFile>(cachePath(env));
  const entries = raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries) ? raw.entries : {};
  return { v: 1, entries };
}

const fresh = (e: CacheEntry | undefined, now: Date) => {
  const at = e ? Date.parse(e.at) : NaN;
  return !Number.isNaN(at) && now.getTime() - at < CACHE_MS && at - now.getTime() < 60_000;
};

/** Allowlisted local probes only, without a shell, 300 ms total, cached 10 min in <home>/state/probes.json keyed by checkout+probe. */
export function runProbes(s: ParsedSkill, checkout: string, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env, opts: ProbeOpts = {}): ProbeResult[] {
  const budget = Math.max(0, Math.min(PROBE_BUDGET_MS, opts.budgetMs ?? PROBE_BUDGET_MS));
  const deadline = Date.now() + budget;
  const left = () => deadline - Date.now();
  const probes = readyProbes(s).map((p) => ({ probe: p, form: formOf(p) })).filter((x): x is { probe: string; form: Form } => x.form !== null);
  if (!probes.length) return [];
  const cache = readCache(env);
  const out: ProbeResult[] = [];
  let changed = false;
  for (const { probe, form } of probes) {
    const key = cacheKey(checkout, probe);
    const hit = cache.entries[key];
    if (hit && fresh(hit, now)) {
      out.push({ probe, ok: hit.ok, ...(hit.why ? { why: hit.why } : {}), ...(hit.fix ? { fix: hit.fix } : {}) });
      continue;
    }
    if (left() <= 0) continue;
    const r = runOne(probe, form, checkout, env, opts.git ?? defaultGit, left);
    if (!r) continue;
    out.push(r);
    cache.entries[key] = { at: now.toISOString(), ok: r.ok, ...(r.why ? { why: r.why } : {}), ...(r.fix ? { fix: r.fix } : {}) };
    changed = true;
  }
  if (changed) {
    for (const [k, e] of Object.entries(cache.entries)) if (!fresh(e, now)) delete cache.entries[k];
    try { writePrivate(cachePath(env), JSON.stringify(cache)); } catch { /* the next prompt probes again */ }
  }
  return out;
}
