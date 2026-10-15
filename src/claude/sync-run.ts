import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readWiring, computeStats } from './stats.js';
import { patchStats, releaseLock, resolveContextDir } from './state.js';
import { graftCliPath } from './paths.js';

/**
 * Options for the rebuild call. `windowsHide` is load-bearing on Windows: this runs inside the
 * sync-run child that handleStop spawns *detached*, and a detached process has no console. A
 * console program started from it without windowsHide is given a brand-new, visible console —
 * with Windows Terminal as the default terminal, a black window that steals focus for the whole
 * build, at the end of every turn that edited a file. With stdio 'ignore', windowsHide makes Node
 * pass CREATE_NO_WINDOW, so the build runs exactly the same, unseen. No-op elsewhere.
 */
export function buildSpawnOptions(dir: string): ExecFileSyncOptions {
  return { cwd: dir, stdio: 'ignore', timeout: 120000, windowsHide: true };
}

/** MONEY GUARD: plain `graft build` only — structural, $0, offline. Never --deep. */
function realBuild(dir: string): void {
  // GRAFT_TEST_CLI is the same seam hooks.ts's graftJson uses, so a test can
  // point this at a stub and inspect the exact argv it was invoked with.
  const cliPath = process.env.GRAFT_TEST_CLI ?? graftCliPath();
  const args = [cliPath, 'build', '.'];
  // Mirrors `withContextDirArg` in hooks.ts: a no-op unless GRAFT_DIR is set, so an
  // unconfigured repo's rebuild sees byte-identical argv to before this existed.
  if (process.env.GRAFT_DIR) args.push('--dir', resolveContextDir(dir));
  execFileSync(process.execPath, args, buildSpawnOptions(dir));
}

export function runSync(dir: string, build: (d: string) => void = realBuild): void {
  try {
    build(dir);
    const w = readWiring(dir);
    if (!w) { patchStats(dir, { syncing: false }); return; } // build ran but output unreadable — stay dirty, retry
    patchStats(dir, {
      dirty: false, staleCount: 0, syncing: false, syncedAt: new Date().toISOString(),
      ...computeStats(w),
    });
  } catch {
    patchStats(dir, { syncing: false }); // leave dirty=true; retry next turn
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
