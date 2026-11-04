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
import { existsSync } from "node:fs";
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

/** The nearest Git checkout root at or above `start`, or null outside a checkout. */
function nearestGitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The nearest ancestor of `start` with a graph, bounded by its Git checkout. */
export function nearestGraftRoot(start: string, override?: string): RootResolution {
  const from = resolve(start);
  if (override) return { root: from, levels: 0 };
  const gitRoot = nearestGitRoot(from);
  let dir = from;
  for (let levels = 0; ; levels++) {
    if (hasGraftIndex(dir)) return { root: dir, levels };
    if (gitRoot && dir === gitRoot) return { root: gitRoot, levels };
    const up = dirname(dir);
    if (up === dir) return { root: from, levels: 0 }; // outside a checkout, nothing indexed
    dir = up;
  }
}
