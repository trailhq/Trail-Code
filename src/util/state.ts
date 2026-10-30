/**
 * The `graft/.cache/` sidecar state: the statusline's stats snapshot and the
 * build lock that serializes rebuilds.
 *
 * Lives in `util/` rather than `claude/` because two very different callers need
 * it: the Claude Code hooks (which flip `dirty` on an edit and clear it after a
 * background sync) and the graph's own pre-query auto-refresh
 * (`graph/refresh.ts`), which must take the same lock so the two never rebuild
 * on top of each other. `claude/state.ts` re-exports all of this, so nothing
 * outside had to change when it moved.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync, openSync, writeSync, closeSync, fchmodSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, isAbsolute } from 'node:path';
import { mapDirFor } from '../context/map-dir.js';

export interface Stats {
  nodeCount: number; edgeCount: number; languages: string[];
  totalCount: number; readyCount: number;
  staleCount: number; dirty: boolean; syncing: boolean;
  syncedAt: string | null; lastFile: string | null;
}

export const LOCK_STALE_MS = 300000;
/** Past this, a lock is taken over even when its pid is alive: that pid may be a new
 * process that got a dead one's number. Longer than any build's own time limit (a
 * first build gets 10 minutes, `graph/refresh.ts`), so a build that is still running
 * keeps its lock. */
export const LOCK_MAX_MS = 15 * 60_000;

export function emptyStats(): Stats {
  return { nodeCount: 0, edgeCount: 0, languages: [], totalCount: 0, readyCount: 0,
    staleCount: 0, dirty: false, syncing: false, syncedAt: null, lastFile: null };
}

const LOCK_FILE = '.sync.lock';

/**
 * Where the pieces this module manages (the stats cache, the sync lock,
 * per-session state, the upkeep stamp) actually live when no caller-supplied
 * override is available. The Claude Code hooks, `sync-run`, the statusline,
 * and `upkeep` all resolve a bare project dir and never see an explicit
 * `--dir` — unlike a direct CLI invocation, which threads one through
 * `contextDirFor` (`context/node-file.ts`). This mirrors that same override
 * precedence for those entry points: `GRAFT_DIR` wins over the default
 * `<projectDir>/graft`, the same env var `resolveConfig` already honors for
 * the `--deep` LLM path. A relative `GRAFT_DIR` resolves against `projectDir`
 * so it holds regardless of the caller's cwd.
 */
export function resolveContextDir(projectDir: string): string {
  const override = process.env.GRAFT_DIR;
  if (!override) return mapDirFor(projectDir);
  return isAbsolute(override) ? override : join(projectDir, override);
}

export function cacheDir(projectDir: string): string { return join(resolveContextDir(projectDir), '.cache'); }
function statsPath(d: string): string { return join(cacheDir(d), 'stats.json'); }

export function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; }
}
/**
 * Write JSON to `p` via a scratch file and a rename, so a concurrent reader sees
 * either the whole old file or the whole new one — never a truncated prefix. The
 * pid in the temp name keeps two concurrent writers off each other's scratch file.
 *
 * `compact` drops the indentation, for the caches only a machine ever opens —
 * it's ~30% of the bytes on a big, deep object.
 *
 * A failed write takes its scratch file with it. Every CLI invocation is a new pid,
 * so the names never collide and never get reused: leaving them behind means a repo
 * that fails this write repeatedly (ENOSPC, or a Windows indexer holding the target
 * open) accumulates one full-size file per attempt, and nothing in graft ever lists
 * `.cache/` to clean them up.
 */
export function writeJsonAtomic(p: string, value: unknown, compact = false, mode?: number): void {
  mkdirSync(dirname(p), { recursive: true });
  // A name no one can guess, opened new-only and never through a link: a link
  // planted where the temp file goes is neither written through nor renamed
  // into place (D85).
  const tmp = `${p}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    // `mode` applies to the new file before it's renamed into place, so a
    // secret is never readable by others even for a moment.
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode ?? 0o666);
    try {
      if (mode !== undefined && process.platform !== 'win32') fchmodSync(fd, mode);
      const buf = Buffer.from(compact ? JSON.stringify(value) : JSON.stringify(value, null, 2), 'utf8');
      for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing more we can do */ }
    throw e;
  }
}

export function readStats(d: string): Stats | null { return readJson<Stats>(statsPath(d)); }
export function writeStats(d: string, s: Stats): void { writeJsonAtomic(statsPath(d), s); }

/**
 * Persisted per-repo build configuration. Explicit CLI choices live here so
 * later no-flag builds and automatic refreshes enumerate the same file set.
 * Missing fields always retain backwards-compatible defaults.
 */
export interface BuildConfig {
  /** SKIP_DIRS names to include in this repo's walks, persisted so a LATER
   * no-flag build — and the fingerprint/refresh path, which never sees CLI
   * flags at all — behave identically to the invocation that set it. */
  includeDirs?: string[];
  /** Whether initialized Git submodules (gitlinks) are folded into this repo's
   * graph. Absent/false keeps the historical boundary at the superproject. */
  followSubmodules?: boolean;
  /** Whether nested Git clones the index does not track — how manifest-driven
   * multi-repo tools check dependencies out, and how an ad-hoc local clone lands
   * in the tree — are folded into this repo's graph. Deliberately SEPARATE from
   * `followSubmodules`: a submodule is a dependency the parent pins, a nested
   * clone is invisible to the parent's index and may equally be a scratch
   * checkout someone parked in the tree. Absent/false keeps the historical
   * boundary. */
  followNestedRepos?: boolean;
}

/** Local, Git-ignored repository configuration. Kept outside generated
 * `graft/` output so deleting/replacing that cache, workspace federation, and
 * custom `--dir` builds cannot erase or redirect the persisted choice. */
export const BUILD_CONFIG_DIR = '.graft';

export function buildConfigPath(d: string): string { return join(d, BUILD_CONFIG_DIR, 'config.json'); }

/** Keep local build configuration out of Git without coupling it to the
 * generated graph directory. Best-effort, matching graph-cache ignore setup. */
function ensureBuildConfigIgnored(d: string): void {
  const noGitignore = process.env.GRAFT_NO_GITIGNORE;
  if (noGitignore && noGitignore !== '0' && noGitignore !== 'false') return;
  const path = join(d, '.gitignore');
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch { /* no .gitignore yet */ }
  const present = current.split('\n').some((line) => {
    const value = line.trim();
    return value === BUILD_CONFIG_DIR || value === `${BUILD_CONFIG_DIR}/` || value === `/${BUILD_CONFIG_DIR}/`;
  });
  if (present) return;
  const gap = current === '' ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  const block = `${gap}# graft's local repository settings — not committed.\n/${BUILD_CONFIG_DIR}/\n`;
  try { writeFileSync(path, current + block); } catch { /* best-effort */ }
}

export function readBuildConfig(d: string): BuildConfig | null { return readJson<BuildConfig>(buildConfigPath(d)); }
export function writeBuildConfig(d: string, c: BuildConfig): void {
  ensureBuildConfigIgnored(d);
  writeJsonAtomic(buildConfigPath(d), c);
}

/** Merge explicit CLI choices into the existing local config, so updating one
 * persisted build option cannot erase another. */
export function patchBuildConfig(d: string, patch: BuildConfig): void {
  writeBuildConfig(d, { ...(readBuildConfig(d) ?? {}), ...patch });
}

/** The persisted `--include-dir` override for repo `d`, as a Set — `undefined`
 * when nothing was ever persisted (or the persisted list is empty), which every
 * `shouldSkipDir`/`walkDir` caller treats as "today's default behavior". Shared
 * by every walkDir-driven entry point (source-files.ts, scopes.ts) so a build,
 * a later no-flag rebuild, and the hooks/refresh path all agree. */
export function readIncludeDirs(d: string): Set<string> | undefined {
  const dirs = readBuildConfig(d)?.includeDirs;
  return dirs && dirs.length ? new Set(dirs) : undefined;
}

/** Missing and explicit false both retain the backwards-compatible default. */
export function readFollowSubmodules(d: string): boolean {
  return readBuildConfig(d)?.followSubmodules === true;
}

/** Missing and explicit false both retain the backwards-compatible default. */
export function readFollowNestedRepos(d: string): boolean {
  return readBuildConfig(d)?.followNestedRepos === true;
}
// Best-effort read-modify-write; not atomic across concurrent processes, but acceptable
// for episodic hook writes (worst case is a lost update, not corruption).
export function patchStats(d: string, patch: Partial<Stats>): Stats {
  const next: Stats = { ...(readStats(d) ?? emptyStats()), ...patch };
  writeStats(d, next);
  return next;
}

export function acquireLock(d: string): boolean {
  return acquireLockIn(cacheDir(d));
}
export function releaseLock(d: string): void {
  releaseLockIn(cacheDir(d));
}

/**
 * The lock, addressed by cache dir rather than project dir. For the default layout
 * `<root>/graft/.cache` these are the same file, which is the point: the Claude Code
 * hooks lock by project dir and the graph's auto-refresh locks by the context dir it
 * is actually writing, and the two must collide so they can't rebuild at once.
 */
export function acquireLockIn(cache: string): boolean {
  const p = join(cache, LOCK_FILE);
  mkdirSync(cache, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try {
    writeFileSync(p, payload, { flag: 'wx' }); // atomic exclusive create
    return true;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    if (!lockStale(p)) return false;
    try { rmSync(p); } catch { /* another process reclaimed it */ }
    try { writeFileSync(p, payload, { flag: 'wx' }); return true; }
    catch (e2: any) { if (e2?.code === 'EEXIST') return false; throw e2; }
  }
}
export function releaseLockIn(cache: string): void {
  try { rmSync(join(cache, LOCK_FILE)); } catch { /* already gone */ }
}
/** Whether someone holds the lock in `cache`: the file is there and not yet reclaimable. */
export function lockHeldIn(cache: string): boolean {
  const p = join(cache, LOCK_FILE);
  try { statSync(p); } catch { return false; }
  return !lockStale(p);
}

/**
 * Put this process's pid in a lock it was handed. `claude/sync-run.ts` runs the build
 * for whoever took the lock and then exited, so the lock must name the process that
 * is actually building, or it reads as abandoned once LOCK_STALE_MS passes.
 */
export function claimLock(d: string): void {
  try { writeFileSync(join(cacheDir(d), LOCK_FILE), JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch { /* the age rule still covers it */ }
}

/**
 * Whether another live process holds the lock in `cache`: a build or sync of this map
 * is already running. Our own pid and our parent's don't count: `sync-run` holds the
 * lock for the `build` it starts.
 */
export function lockHeldByOther(cache: string): boolean {
  if (!lockHeldIn(cache)) return false;
  const pid = lockPid(join(cache, LOCK_FILE));
  return pid !== null && pid !== process.pid && pid !== process.ppid;
}

/**
 * A lock is reclaimable when its owner is gone and it is older than LOCK_STALE_MS, or
 * when it is older than LOCK_MAX_MS whoever holds it. Age alone used to be enough, so a
 * first build past five minutes on a slow laptop lost its lock to the next query, which
 * started a second full build beside it, and five minutes later a third.
 */
function lockStale(p: string): boolean {
  let age: number;
  try { age = Date.now() - statSync(p).mtimeMs; } catch { return true; }
  if (age >= LOCK_MAX_MS) return true;
  if (age < LOCK_STALE_MS) return false;
  const pid = lockPid(p);
  return pid === null || !pidAlive(pid);
}

function lockPid(p: string): number | null {
  const pid = readJson<{ pid?: unknown }>(p)?.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}
