import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cacheDir, patchStats, readStats, resolveContextDir } from './state.js';
import { graftCliPath } from './paths.js';

/**
 * The statusline's stale count, worked out off the edit's critical path.
 *
 * post-edit used to run `graft check` synchronously under an 8s child timeout.
 * On a mid-size repo (~900 files) the check alone takes 6.5–9.5s, so every edit
 * blocked for the full budget and, when it timed out, the null result was
 * written as `staleCount: 0` (#483). post-edit now spawns this detached; the
 * edit returns at once and the real count lands when the check finishes.
 */

const LOCK_FILE = 'stale-check.lock';
/**
 * ~3x the slowest mid-size repo measured (9.5s). Deliberately not sync-run's
 * 120s: a tree too big to check in 30s would burn a core for two minutes per
 * edit burst and still return nothing.
 */
export const CHECK_TIMEOUT_MS = 30000;
/** A lock older than the child's own timeout belongs to a process that is gone. */
const LOCK_STALE_MS = CHECK_TIMEOUT_MS + 10000;

/**
 * Its own lock, not the sync lock: a sync holds that one for the whole build,
 * and this must not stop the end-of-turn sync from taking it. One check at a
 * time is enough — a check already running sees this edit's tree too.
 */
function acquire(cache: string): string | null {
  const p = join(cache, LOCK_FILE);
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try {
    mkdirSync(cache, { recursive: true });
    writeFileSync(p, payload, { flag: 'wx' });
    return p;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') return null;
    try {
      if (Date.now() - statSync(p).mtimeMs < LOCK_STALE_MS) return null;
      rmSync(p);
      writeFileSync(p, payload, { flag: 'wx' });
      return p;
    } catch {
      return null; // another process reclaimed it first
    }
  }
}
/** Only ours: a lock reclaimed as stale by a later run belongs to that run. */
function release(p: string): void {
  try { if (JSON.parse(readFileSync(p, 'utf8')).pid === process.pid) rmSync(p); } catch { /* already gone */ }
}

/** Stale nodes per `graft check`, or null when it timed out or printed nothing usable. */
export function countStale(dir: string): number | null {
  // GRAFT_TEST_CLI is the same seam hooks.ts's graftJson and sync-run's realBuild use.
  const args = [process.env.GRAFT_TEST_CLI ?? graftCliPath(), 'check', '.', '--json'];
  if (process.env.GRAFT_DIR) args.push('--dir', resolveContextDir(dir));
  let out: string;
  try {
    out = execFileSync(process.execPath, args,
      { cwd: dir, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch (e: any) {
    // `graft check` exits non-zero when the graph is stale but still prints the JSON.
    out = typeof e?.stdout === 'string' ? e.stdout : '';
  }
  try {
    const g = JSON.parse(out)?.graph ?? {};
    return (g.changed?.length ?? 0) + (g.added?.length ?? 0) + (g.removed?.length ?? 0);
  } catch {
    return null;
  }
}

export function runStaleCount(dir: string, count: (d: string) => number | null = countStale): void {
  const lock = acquire(cacheDir(dir));
  if (!lock) return;
  const startedAt = Date.now();
  try {
    const n = count(dir);
    // Unknown is not zero: leave the last count standing rather than report a clean graph.
    if (n === null) return;
    // The end-of-turn sync rebuilds the graph and writes dirty:false, staleCount:0.
    // If it ran or is running since this check started, its answer is the newer one.
    const s = readStats(dir);
    const syncedSinceStart = !!s?.syncedAt && Date.parse(s.syncedAt) >= startedAt;
    if (!s?.dirty || s.syncing || syncedSinceStart) return;
    patchStats(dir, { staleCount: n });
  } finally {
    release(lock);
  }
}

export function main(): void {
  const dir = process.argv[2];
  if (dir) runStaleCount(dir);
}

// Run only when executed directly (node dist/claude/stale-count-run.js <dir>), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
