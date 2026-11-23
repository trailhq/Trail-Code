/**
 * The change `trail check` looks at: everything this branch would put in a
 * pull request, committed or not, measured from where it left its base.
 */
import { execFileSync } from "node:child_process";

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
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

/** The empty tree: what a root commit is diffed against, since it has no parent. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Whether the branch's commits add a learning to `.trail/learnings/`, so what it pushes carries one.
 * A learning counts when it is added or changed on the branch: one already tracked at the base
 * and only edited here is still a learning the branch ships.
 *
 * When the branch left its base nowhere — the merge-base is `HEAD` itself, which is what
 * happens working directly on the default branch with no remote-tracking base
 * (`defaultBase` resolves to the branch checked out), or when HEAD is behind its base —
 * the range is empty and the diff can never name a file. Then the commit being shipped
 * is HEAD itself, so diff it against its first parent (the empty tree for a root
 * commit). A plain `git show` would not do: on a merge commit it prints a combined
 * diff, which omits a learning the merged side branch brings in.
 */
export function branchAddsLearning(repo: string, base = defaultBase(repo)): boolean {
  const from = git(repo, ["merge-base", "HEAD", base])?.trim() || base;
  if (from === git(repo, ["rev-parse", "HEAD"])?.trim()) {
    const parent = git(repo, ["rev-parse", "HEAD^1"])?.trim();
    if (parent) {
      return !!git(repo, ["diff", "--name-only", "--diff-filter=AMR", parent, "HEAD", "--", ".trail/learnings"])?.trim();
    }
    // No parent object: a root commit, or a shallow boundary whose parent was never
    // fetched. Only a root commit may be diffed against the empty tree — a shallow
    // tip would otherwise inherit every learning already in the tree. The commit
    // object still records its parent, even when the object itself is absent, so
    // the header says which case this is; when it cannot be read, fail safe.
    const raw = git(repo, ["cat-file", "-p", "HEAD"]);
    if (raw === null) return false;
    const header = raw.split("\n\n")[0] ?? "";
    if (header.includes("\nparent ")) return false;
    return !!git(repo, ["diff", "--name-only", "--diff-filter=AMR", EMPTY_TREE, "HEAD", "--", ".trail/learnings"])?.trim();
  }
  return !!git(repo, ["diff", "--name-only", "--diff-filter=AMR", from, "HEAD", "--", ".trail/learnings"])?.trim();
}

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
