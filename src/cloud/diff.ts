/**
 * The change `trail check` looks at: everything this branch would put in a
 * pull request, committed or not, measured from where it left its base.
 */
import { execFileSync } from "node:child_process";

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** origin's default branch (`origin/main`), else `main` or `master` if one exists. */
export function defaultBase(repo: string): string {
  const head = git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])?.trim();
  if (head) return head;
  for (const b of ["origin/main", "origin/master", "main", "master"]) {
    if (git(repo, ["rev-parse", "--verify", "--quiet", b])?.trim()) return b;
  }
  return "HEAD";
}

export interface BranchDiff {
  base: string;
  /** Where the branch left \`base\`: the commit the diff is taken from. */
  from: string;
  diff: string;
  files: string[];
  /** The diff was longer than `maxBytes` and was cut. */
  truncated: boolean;
}

/**
 * What `trail init` writes to wire agents up. Never a decision anyone made, so
 * never part of what a check reads: on a branch cut before the wiring was
 * committed upstream, it would otherwise be most of the diff.
 */
export const WIRING = [
  ".claude/skills/trail",
  ".claude/skills/graft",
  ".claude/helpers/trail-hooks.cjs",
  ".claude/helpers/graft-hooks.cjs",
  ".cursor/rules/trail.mdc",
  ".cursor/rules/graft.mdc",
  ".mcp.json",
  ".ignore",
];

const NOT_WIRING = ["--", ".", ...WIRING.map((p) => `:(exclude)${p}`)];

/** The branch's diff against its base's merge base, working tree included, without trail's own wiring. Null outside a git repo. */
export function branchDiff(repo: string, base = defaultBase(repo), maxBytes = 400 * 1024): BranchDiff | null {
  const from = git(repo, ["merge-base", "HEAD", base])?.trim() || base;
  const files = git(repo, ["diff", "--name-only", from, ...NOT_WIRING]);
  if (files === null) return null;
  let diff = git(repo, ["diff", "--unified=3", from, ...NOT_WIRING]) ?? "";
  const truncated = Buffer.byteLength(diff) > maxBytes;
  if (truncated) diff = Buffer.from(diff).subarray(0, maxBytes).toString("utf8");
  return {
    base,
    from,
    diff,
    files: files.split("\n").map((f) => f.trim()).filter(Boolean),
    truncated,
  };
}
