import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readWiring, computeStats } from './stats.js';
import { patchStats, releaseLock, resolveContextDir } from './state.js';
import { graftCliPath } from './paths.js';
import { contextDirFor } from '../context/node-file.js';
import { readGraph, wiringPath } from '../graph/write.js';
import { readWorkspace, writeWorkspace } from '../graph/workspace.js';
import { discoverWorkspaceChildren } from '../graph/scopes.js';

/** MONEY GUARD: plain `graft build` only — structural, $0, offline. Never --deep. */
function realBuild(dir: string): void {
  // GRAFT_TEST_CLI is the same seam hooks.ts's graftJson uses, so a test can
  // point this at a stub and inspect the exact argv it was invoked with.
  const cliPath = process.env.GRAFT_TEST_CLI ?? graftCliPath();
  const workspace = readWorkspace(dir, resolveContextDir(dir));
  const children = workspace ? discoverWorkspaceChildren(dir).sort() : [];
  const roots = workspace ? children.map((child) => join(dir, child)) : [dir];
  for (const root of roots) {
    // A workspace's override belongs to its index, never its children's graphs.
    const outDir = workspace ? contextDirFor(root) : resolveContextDir(root);
    const args = [cliPath, 'build', '.'];
    if (!workspace && process.env.GRAFT_DIR) args.push('--dir', outDir);
    const extensions = readGraph(wiringPath(outDir))?.meta?.extensions;
    if (extensions?.length) args.push('--extensions', ...extensions);
    const env = workspace ? { ...process.env, GRAFT_DIR: undefined } : process.env;
    execFileSync(process.execPath, args, { cwd: root, env, stdio: 'ignore', timeout: 120000, windowsHide: true });
  }
  if (workspace) writeWorkspace(dir, { version: 1, children }, resolveContextDir(dir));
}

export function runSync(dir: string, build: (d: string) => void = realBuild): void {
  try {
    build(dir);
    const w = readWiring(dir);
    if (!w && readWorkspace(dir, resolveContextDir(dir))) {
      // A workspace parent has no wiring.json of its own; its graph is workspace.json.
      patchStats(dir, { dirty: false, staleCount: 0, syncing: false, syncedAt: new Date().toISOString() });
      return;
    }
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
