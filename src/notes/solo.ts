/**
 * Solo mode: the graft map only, for one repo.
 *
 * `trail init --solo` or `trail solo` marks the repo so learnings, skills
 * offers, look-back and the rest of Part 2 stay off. The code map (build,
 * ask, grep, map, callers, blast, orientation) keeps working. `trail solo`
 * again takes the mark off.
 *
 * The mark sits in the repo's folder in ~/.trail, so every clone and worktree
 * of the repo reads the same answer. Existing learnings on disk are left alone;
 * solo only stops using and creating Part 2 surfaces.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureRepoHome, keepsNotes, repoPlace } from "./home.js";

const MARK = "solo";

/** This repo is on solo mode: graft map only. Reads only; false outside git. */
export function isSolo(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const place = repoPlace(dir, env);
    return place.git && existsSync(join(place.dir, MARK));
  } catch {
    return false;
  }
}

/** Mark `dir`'s repo as solo (Part 2 off), or take the mark off. */
export function setSolo(dir: string, on: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const mark = join(ensureRepoHome(dir, env).place.dir, MARK);
  if (on) {
    writeFileSync(
      mark,
      "trail solo: learnings are off in this repo; only the graft map stays on. Run trail solo again to turn learnings back on.\n",
    );
  } else rmSync(mark, { force: true });
}

/**
 * Part 2 is on: this checkout keeps learnings and is not in solo mode.
 * Prefer this over `keepsNotes` wherever learnings are injected, saved, or checked.
 */
export function learningsOn(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return keepsNotes(dir, env) && !isSolo(dir, env);
}

/** What the session-start text tells the agent in a solo repo. */
export const SOLO_DIRECTIVE =
  "Trail is on in this repo in solo mode: only the graft code map is on. Learnings, skills offers and saving notes are off. Do not offer to save a learning, follow always-follow learnings, or run trail note / trail skills offers. Use trail ask, grep, map, callers and blast for the code. If they want learnings back, the command is trail solo.";
