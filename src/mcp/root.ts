/** Per-call checkout selection for a server shared by agents in linked worktrees. */
import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitEnvForDirectory } from '../util/git-env.js';
import { tag } from '../brand.js';

/** Git must inspect the requested directory, even when the host inherited a
 * repository override (for example from a Git hook). */
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, 'rev-parse', ...args], {
    env: gitEnvForDirectory(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000, maxBuffer: 64 * 1024,
  }).trim();
}

function checkout(root: string): { root: string; common: string } {
  const top = realpathSync(git(root, '--show-toplevel'));
  const common = realpathSync(git(root, '--path-format=absolute', '--git-common-dir'));
  return { root: top, common };
}

/** Missing `root` preserves the server's existing selection, including workspace
 * and non-Git roots. Explicit paths choose a checkout, never an ancestor graph.
 * Repository identity is the on-disk common Git directory: equal remote URLs
 * do not grant access to an independent clone or submodule. */
export function resolveToolRoot(serverRoot: string, requested: unknown, dirOverride?: string): string {
  if (requested === undefined) return serverRoot;
  if (typeof requested !== 'string' || !requested.trim()) {
    throw new Error('root must be a non-empty checkout path');
  }
  const path = resolve(serverRoot, requested);
  let target: ReturnType<typeof checkout>;
  let server: ReturnType<typeof checkout>;
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory');
    target = checkout(path);
    server = checkout(serverRoot);
  } catch {
    throw new Error(`cannot select root ${path} — root and server must be existing Git checkouts of the same repository`);
  }
  if (target.common !== server.common) {
    throw new Error(`refusing root ${target.root} — it is not a checkout of the server's Git repository (${server.root})`);
  }
  // A --dir graph is pinned to one source tree. Sharing it between worktrees
  // would overwrite the parent's graph during the ordinary refresh step.
  if (dirOverride !== undefined) {
    if (target.root !== server.root) {
      throw new Error('cannot select another root while --dir pins the graph directory — start a server without --dir to query another worktree');
    }
    // Preserve the source scope too: an explicit server root may be a repo
    // subdirectory with a custom graph built only from that subdirectory.
    return serverRoot;
  }
  return target.root;
}

/** Read each time: a long-lived server must notice checkout/commit changes.
 * HEAD identifies the checkout, not a claim that uncommitted files are absent. */
export function rootNote(root: string): string {
  let head = 'unavailable';
  try { head = git(root, '--verify', 'HEAD'); } catch { /* non-Git/unborn checkout */ }
  return `${tag()} root: ${resolve(root)} · HEAD: ${head}`;
}
