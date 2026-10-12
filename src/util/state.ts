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
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';

export interface Stats {
  nodeCount: number; edgeCount: number; languages: string[];
  totalCount: number; readyCount: number;
  staleCount: number; dirty: boolean; syncing: boolean;
  syncedAt: string | null; lastFile: string | null;
}

export const LOCK_STALE_MS = 300000;

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
  if (!override) return join(projectDir, 'graft');
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
export function writeJsonAtomic(p: string, value: unknown, compact = false): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
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
  /** The Trail brain this repo's rules come from: the brain id and the token to
   * read it with. Persisted here — in the git-ignored `.graft/` — rather than in
   * `~/.graft/`, because a brain belongs to one repository and two checkouts on
   * one machine must not share one. `undefined` clears it. */
  brain?: { brainId: string; token: string; baseUrl?: string };
  /** A sign-up an agent-run `graft trail push` opened and has not collected
   * yet: the state in its link, and which repository it was for. Cleared once
   * collected. `undefined` clears it. */
  pendingSignup?: { state: string; repo: string; createdAt: number };
  /** `false` turns off the once-a-day background `graft trail push` the
   * session-start hook starts for a repo with a trail (see brain/autopush.ts).
   * Absent means on. GRAFT_TRAIL_AUTOPUSH=0 does the same for every repo. */
  trailAutoPush?: boolean;
}

/** Local, Git-ignored repository configuration. Kept outside generated
 * `graft/` output so deleting/replacing that cache, workspace federation, and
 * custom `--dir` builds cannot erase or redirect the persisted choice. */
export const BUILD_CONFIG_DIR = '.graft';

export function buildConfigPath(d: string): string { return join(d, BUILD_CONFIG_DIR, 'config.json'); }

/** Keep local build configuration out of Git without coupling it to the
 * generated graph directory. Best-effort, matching graph-cache ignore setup. */
function ensureBuildConfigIgnored(d: string): void {
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
    let stale: boolean;
    try { stale = Date.now() - statSync(p).mtimeMs >= LOCK_STALE_MS; } catch { stale = true; }
    if (!stale) return false;
    try { rmSync(p); } catch { /* another process reclaimed it */ }
    try { writeFileSync(p, payload, { flag: 'wx' }); return true; }
    catch (e2: any) { if (e2?.code === 'EEXIST') return false; throw e2; }
  }
}
export function releaseLockIn(cache: string): void {
  try { rmSync(join(cache, LOCK_FILE)); } catch { /* already gone */ }
}
