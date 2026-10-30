import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Why `trail init` won't set up `dir`, or null when it will. Only the home
 * folder is refused: run there, init wired it, mapped every code file under it
 * and said to commit, though nobody shares learnings for a whole home folder.
 */
export function homeFolderRefusal(dir: string, home: string = homedir()): string | null {
  if (resolve(dir) !== resolve(home)) return null;
  return "✗ ~ is your home folder, not a repo.\n  cd into the repo you want to set up, then run trail init again.";
}

/** Whether `dir` is inside a git work tree, so there is something to commit learnings to. */
export function isGitWorkTree(dir: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8", windowsHide: true });
  return r.status === 0 && r.stdout.trim() === "true";
}

/**
 * `init --pair` outside git: Trail's page shares a repo with the team, and a
 * folder with none would be set up with nothing to share, so it is refused.
 */
export const NOT_GIT_PAIR_REFUSAL =
  "✗ this folder isn't a git repo.\n  Open your agent inside the repo you want Trail to learn, then run the setup prompt again.";

/** Said instead of the commit line when init ran outside git: there is nothing to commit to. */
export const NOT_GIT_LINE =
  "· this folder isn't a git repo, so its learnings stay on this machine. Run trail init inside a repo to share them with your team";
