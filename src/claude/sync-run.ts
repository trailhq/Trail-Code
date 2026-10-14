import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readWiring, computeStats } from './stats.js';
import { patchStats, readStats, releaseLock, resolveContextDir } from './state.js';
import { graftCliPath } from './paths.js';

/** MONEY GUARD: plain `graft build` only — structural, $0, offline. Never --deep. */
function realBuild(dir: string): void {
  // GRAFT_TEST_CLI is the same seam hooks.ts's graftJson uses, so a test can
  // point this at a stub and inspect the exact argv it was invoked with.
  const cliPath = process.env.GRAFT_TEST_CLI ?? graftCliPath();
  const args = [cliPath, 'build', '.'];
  // Mirrors `withContextDirArg` in hooks.ts: a no-op unless GRAFT_DIR is set, so an
  // unconfigured repo's rebuild sees byte-identical argv to before this existed.
  if (process.env.GRAFT_DIR) args.push('--dir', resolveContextDir(dir));
  execFileSync(process.execPath, args, { cwd: dir, stdio: 'ignore', timeout: 120000 });
}

/**
 * How long to wait after the Nth consecutive failure, doubling up to a cap.
 *
 * The first retry waits a full minute because the build itself is allowed two:
 * coming back sooner than the thing that just timed out cannot tell the user
 * anything new. The cap is fifteen minutes — long enough that a tree which
 * cannot be indexed costs a probe every quarter hour instead of a build every
 * turn, short enough that fixing the cause is picked up in the same session.
 */
export const SYNC_BACKOFF_BASE_MS = 60000;
export const SYNC_BACKOFF_MAX_MS = 900000;

export function syncBackoffMs(failures: number): number {
  if (failures <= 1) return SYNC_BACKOFF_BASE_MS;
  return Math.min(SYNC_BACKOFF_BASE_MS * 2 ** (failures - 1), SYNC_BACKOFF_MAX_MS);
}

/**
 * One bounded line naming the failure. `stats.json` is re-read by the statusline
 * on every prompt, so this is a first line only — a child process error carries
 * a signal name and a whole path — and capped so a pathological message can't
 * grow the file it lives in.
 */
function failureReason(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return (message.split('\n')[0] ?? '').slice(0, 200);
}

/**
 * A failed sync: stop pretending it will be retried on the next turn, and say
 * why instead. `dirty` deliberately stays true — the graph really is stale, the
 * statusline really should keep warning — but the retry deadline is what stops
 * the next `Stop` from spending another two minutes of CPU on it.
 */
function recordFailure(dir: string, reason: string): void {
  const failures = (readStats(dir)?.syncFailures ?? 0) + 1;
  patchStats(dir, {
    syncing: false,
    syncFailures: failures,
    syncError: reason,
    syncRetryAt: new Date(Date.now() + syncBackoffMs(failures)).toISOString(),
  });
}

export function runSync(dir: string, build: (d: string) => void = realBuild): void {
  try {
    build(dir);
    const w = readWiring(dir);
    if (!w) { recordFailure(dir, 'build produced no readable graph'); return; }
    patchStats(dir, {
      dirty: false, staleCount: 0, syncing: false, syncedAt: new Date().toISOString(),
      // A success is what clears the backoff: the next edit is entitled to a
      // rebuild immediately, whatever the last one did.
      syncFailures: 0, syncError: null, syncRetryAt: null,
      ...computeStats(w),
    });
  } catch (e) {
    recordFailure(dir, failureReason(e));
  } finally {
    releaseLock(dir);
  }
}

export function main(): void {
  const dir = process.argv[2];
  if (dir) runSync(dir);
}

// Run only when executed directly (node dist/claude/sync-run.js <dir>), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
