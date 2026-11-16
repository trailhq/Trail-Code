/**
 * Where "here" is when a query names no directory. An agent session — or a plain
 * shell — started in a subdirectory of an indexed repo should still find the
 * graph, so the implicit root is the nearest ancestor holding a graft index.
 * Once the walk reaches a Git checkout root, it stops there. A parent graph must
 * not silently retarget a repository whose own graph is absent or stale.
 * Workspace federation remains available from a directory outside a checkout,
 * or through an explicit directory argument.
 *
 * Only the IMPLICIT case walks. An explicit `[dir]` argument is taken at face
 * value, and a `--dir` override short-circuits entirely: `contextDirFor` returns
 * an override verbatim and ignores the root it is handed, so every ancestor
 * would report the same context dir and the walk would answer "level 0" for a
 * dir that isn't the repo.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { wiringPath } from "./write.js";
import { workspacePath } from "./workspace.js";

/** True when `dir` is a graft root of either shape — a built repo or a workspace parent. */
export function hasGraftIndex(dir: string): boolean {
  return existsSync(wiringPath(contextDirFor(dir))) || existsSync(workspacePath(dir));
}

export interface RootResolution {
  /** Absolute dir to run the command against. */
  root: string;
  /** Directory levels walked up; 0 when the start dir was already the root (the common case). */
  levels: number;
}

/**
 * True when `dir/.git` is a FILE pointing into another repo's `.git/modules/`,
 * i.e. `dir` is a submodule checkout. A `--follow-submodules` build indexes it
 * into the superproject's graph, so it must not bound the walk. A `.git`
 * directory (a standalone clone) and a linked worktree (`.../worktrees/<name>`,
 * its own checkout of the same repo) both still bound it. String inspection of
 * a small read only: the gitdir path is never followed.
 */
function isSubmoduleCheckout(dir: string): boolean {
  const dotGit = join(dir, ".git");
  let fd: number | undefined;
  try {
    if (!statSync(dotGit).isFile()) return false;
    fd = openSync(dotGit, "r");
    const buf = Buffer.alloc(1024);
    const text = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return false;
    const gitdir = m[1].replace(/\\/g, "/").replace(/\/+$/, "");
    if (/\/worktrees\/[^/]+$/.test(gitdir)) return false; // linked worktree, even of a submodule
    return /(^|\/)\.git\/modules\//.test(gitdir);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Nearest checkout roots at or above `start`: `first` is any `.git`; `bound` skips submodules. */
function gitRoots(start: string): { first: string | null; bound: string | null } {
  let first: string | null = null;
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      first ??= dir;
      if (!isSubmoduleCheckout(dir)) return { first, bound: dir };
    }
    const up = dirname(dir);
    if (up === dir) return { first, bound: null };
    dir = up;
  }
}

/**
 * The nearest ancestor of `start` with a graph, bounded by its Git checkout.
 * A submodule does not bound the walk (its superproject's graph may index it);
 * if nothing is indexed, the answer is still the nearest checkout, so `build`
 * inside a submodule of an unbuilt superproject means the submodule.
 */
export function nearestGraftRoot(start: string, override?: string): RootResolution {
  const from = resolve(start);
  if (override) return { root: from, levels: 0 };
  const { first, bound } = gitRoots(from);
  let dir = from;
  let firstLevels = 0;
  for (let levels = 0; ; levels++) {
    if (hasGraftIndex(dir)) return { root: dir, levels };
    if (dir === first) firstLevels = levels;
    if (bound && dir === bound) return { root: first ?? bound, levels: firstLevels };
    const up = dirname(dir);
    if (up === dir) return first ? { root: first, levels: firstLevels } : { root: from, levels: 0 };
    dir = up;
  }
}
