/**
 * Where a repo's code map lives.
 *
 * In a repo on trail, `.trail/cache/`: inside the one folder a team commits,
 * and kept out of git by `.trail/.gitignore`, so neither the repo's own
 * `.gitignore` nor a root `.ignore` has to name it. Everywhere else `graft/`,
 * as before. Being a hidden folder, `.trail/cache/` is skipped by a grep from
 * the repo root; the agent reaches it through `trail ask` and the path the
 * session-start hook names, and a grep given that path searches it.
 *
 * A map still in `graft/` from before the repo moved to trail is renamed into
 * place the first time anyone asks where the map is, so a session never
 * rebuilds what's already on disk.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { repoWiredForTrail } from "../brand.js";
import { ignoreInTrailDir } from "../notes/repo-trail.js";

/** The map's folder in a repo on trail, relative to the repo. */
export const TRAIL_MAP_DIR = join(".trail", "cache");
/** The map's folder everywhere else. */
export const GRAFT_MAP_DIR = "graft";

/**
 * Absolute path of `root`'s code map folder. A repo is on trail once its
 * hooks say so or it has `.trail/learnings/`, which `trail init` makes before
 * anything else, so nothing it writes lands in `graft/` first.
 */
export function mapDirFor(root: string): string {
  const trail = join(root, TRAIL_MAP_DIR);
  if (existsSync(trail)) return trail;
  if (!existsSync(join(root, ".trail", "learnings")) && !repoWiredForTrail(root)) return join(root, GRAFT_MAP_DIR);
  moveOldMap(root, trail);
  return trail;
}

/** Whether `dir` is a repo's trail map folder, which `.trail/.gitignore` keeps out of git. */
export function isTrailMapDir(root: string, dir: string): boolean {
  return join(root, TRAIL_MAP_DIR) === join(dir);
}

/**
 * `graft/` holding a map from before the repo moved to trail: renamed to
 * `.trail/cache/`. Left alone when git tracks it (a map committed back when
 * it was shared), since moving it would delete committed files.
 */
function moveOldMap(root: string, to: string): void {
  const from = join(root, GRAFT_MAP_DIR);
  if (!existsSync(join(from, "INDEX.md")) && !existsSync(join(from, ".graph"))) return;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", "graft/INDEX.md"], { cwd: root, stdio: "ignore", timeout: 3000, windowsHide: true });
    return;
  } catch {
    // untracked, or not a git checkout: ours to move
  }
  try {
    mkdirSync(join(root, ".trail"), { recursive: true });
    ignoreInTrailDir(root, "cache/");
    renameSync(from, to);
  } catch {
    // Another process moved it first, or it can't move: the next build makes a new one.
  }
}
