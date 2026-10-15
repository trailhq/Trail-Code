/**
 * Where "here" is when a query names no directory. An agent session — or a plain
 * shell — started in a subdirectory of an indexed repo should still find the
 * graph, so the implicit root is the nearest ANCESTOR holding a graft index,
 * without crossing the current repository boundary:
 * either a repo's own wiring graph (`graft/.graph/wiring.json`) or a workspace
 * parent's children index (`graft/workspace.json`). Nothing indexed anywhere
 * above → the current repository root (when one exists), otherwise the start
 * dir itself. The boundary matters for a worktree nested inside another checkout:
 * walking through its `.git` file would otherwise select the parent checkout's
 * graph before worktree seeding has a chance to run.
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

/** The nearest ancestor of `start` (inclusive) that holds a graft index, else `start`. */
export function nearestGraftRoot(start: string, override?: string): RootResolution {
  const from = resolve(start);
  if (override) return { root: from, levels: 0 };
  let dir = from;
  for (let levels = 0; ; levels++) {
    if (hasGraftIndex(dir)) return { root: dir, levels };
    if (existsSync(join(dir, ".git"))) return { root: dir, levels };
    const up = dirname(dir);
    if (up === dir) return { root: from, levels: 0 }; // hit the filesystem root, nothing indexed
    dir = up;
  }
}
