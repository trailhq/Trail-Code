/**
 * Getting a pull request onto disk.
 *
 * The ref names are the fiddly part and the easiest to get silently wrong:
 * `refs/pull/N/merge` is GitHub's own merge of the PR into its base — what will
 * actually land — and reviewing the head branch instead would report a radius
 * for code that was never going to exist. A local bare repository stands in for
 * GitHub here, so this exercises the real git commands with no network.
 *
 * The other half of these tests is the closed pull request, where GitHub has
 * deleted `refs/pull/N/merge` and `refs/pull/N/head` is all that is left. What
 * has to be checked there is not that the fetch succeeds — it is that the diff
 * is still the pull request's own change, because the obvious implementation
 * (diff the head against the base tip) reports NOTHING for a PR that merged as a
 * merge commit, and an empty blast radius posted confidently is worse than the
 * fetch error it replaced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutPullRequest, redact } from "../src/app/checkout.js";

const git = (cwd: string, ...args: string[]): string =>
  // stderr piped, not inherited: `git merge --squash` chats about the strategy it
  // chose even under `--quiet`, and it lands in the middle of the TAP stream. A
  // failure still carries it, on the thrown error.
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });

/**
 * How the pull request stands on the fake GitHub.
 *
 * `open` is the only one with a merge ref: GitHub deletes it on close, which is
 * exactly what the other three reproduce. They differ in how the branch landed,
 * because that is what decides the diff:
 *  - `merged`: a merge commit, so the head commit is an ancestor of `main`.
 *  - `squashed`: new commits on `main`, so the head commit is not.
 *  - `merged-far-behind`: a merge commit, then more commits on `main` than the
 *    shallow fetch reaches back — the months-old pull request.
 */
type PrState = "open" | "merged" | "squashed" | "merged-far-behind";

/**
 * A stand-in for GitHub: a mirror holding `main` and the PR's refs.
 *
 * `--mirror`, not `--bare`: a bare clone copies branches and tags, and the refs
 * that matter here live under `refs/pull/`.
 */
function fakeGitHub(state: PrState = "open"): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "graft-origin-"));
  const work = join(root, "work");
  execFileSync("git", ["init", "--quiet", "-b", "main", work]);
  git(work, "config", "user.email", "t@e");
  git(work, "config", "user.name", "t");
  writeFileSync(join(work, "base.txt"), "base\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "base");

  git(work, "checkout", "--quiet", "-b", "feature");
  writeFileSync(join(work, "feature.txt"), "feature\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "feature");
  git(work, "checkout", "--quiet", "main");

  // The head ref exists in every state, in the BASE repository — which is why it
  // outlives both the branch and the whole fork.
  git(work, "update-ref", "refs/pull/7/head", "refs/heads/feature");

  if (state === "open") {
    // GitHub publishes the merge commit under refs/pull/N/merge; reproduce it.
    git(work, "merge", "--quiet", "--no-ff", "-m", "merge", "feature");
    git(work, "update-ref", "refs/pull/7/merge", "HEAD");
    git(work, "checkout", "--quiet", "main");
    git(work, "reset", "--hard", "--quiet", "HEAD~1");
    execFileSync("git", ["clone", "--quiet", "--mirror", work, join(root, "demo.git")]);
    return { root, repo: "demo" };
  }

  // Everything below is a landed pull request: `main` had moved on before it
  // landed, it landed, and `main` moved on again afterwards. No merge ref.
  writeFileSync(join(work, "base.txt"), "base\nmore\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "other work");

  if (state === "squashed") {
    git(work, "merge", "--quiet", "--squash", "feature");
    git(work, "commit", "--quiet", "-m", "squashed #7");
  } else {
    git(work, "merge", "--quiet", "--no-ff", "-m", "Merge pull request #7", "feature");
  }

  // Empty commits: the point is only how FAR the merge is behind the tip.
  const after = state === "merged-far-behind" ? 55 : 1;
  for (let i = 0; i < after; i += 1) git(work, "commit", "--quiet", "--allow-empty", "-m", `after ${i}`);

  // The branch is deleted on merge, as GitHub offers to do.
  git(work, "branch", "-D", "feature");
  execFileSync("git", ["clone", "--quiet", "--mirror", work, join(root, "demo.git")]);
  return { root, repo: "demo" };
}

/** The remote is built as `${api}/${owner}/${repo}.git`, so `api` points at the
 * directory holding the mirror and `owner` is a no-op path segment. */
function checkout(origin: { root: string; repo: string }, number = 7): { logs: string[]; c: ReturnType<typeof checkoutPullRequest> } {
  const logs: string[] = [];
  const c = checkoutPullRequest({
    owner: ".",
    repo: origin.repo,
    number,
    baseRef: "main",
    token: "ghs_secret_token",
    api: `file://${origin.root}`,
    log: (msg) => logs.push(msg),
  });
  return { logs, c };
}

/** What `changedFiles` will ask git, run the same way: three dots, not two. */
const changed = (dir: string, base: string): string =>
  execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: dir, encoding: "utf8" }).trim();

test("checkout: lands on the merge ref, with the base fetched to diff against", () => {
  const origin = fakeGitHub();
  const { c, logs } = checkout(origin);

  try {
    // The merge ref carries BOTH sides; the base branch alone carries neither.
    assert.equal(readFileSync(join(c.dir, "feature.txt"), "utf8"), "feature\n");
    assert.equal(readFileSync(join(c.dir, "base.txt"), "utf8"), "base\n");

    const diff = execFileSync("git", ["diff", "--name-only", c.base, "HEAD"], { cwd: c.dir, encoding: "utf8" });
    assert.equal(diff.trim(), "feature.txt", "the base ref is present and diffs to the PR's change");

    // The head ref exists too, and must not have been preferred over the merge.
    assert.equal(c.ref, "merge");
    assert.deepEqual(logs, ["./demo#7: reviewing refs/pull/7/merge against main"]);

    // The token must not be recoverable from the checkout it produced.
    const config = readFileSync(join(c.dir, ".git", "config"), "utf8");
    assert.ok(!config.includes("ghs_secret_token"), "no token in .git/config");
    assert.ok(!config.includes(Buffer.from("x-access-token:ghs_secret_token").toString("base64")), "nor encoded");
  } finally {
    c.cleanup();
  }
  rmSync(origin.root, { recursive: true, force: true });
});

test("checkout: falls back to the head ref once GitHub has deleted the merge ref", () => {
  const origin = fakeGitHub("merged");
  const { c, logs } = checkout(origin);

  try {
    assert.equal(c.ref, "head");
    // The head ref is the branch as the author pushed it: their file, and the
    // base file WITHOUT the "other work" commit that landed beside them.
    assert.equal(readFileSync(join(c.dir, "feature.txt"), "utf8"), "feature\n");
    assert.equal(readFileSync(join(c.dir, "base.txt"), "utf8"), "base\n");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\.\/demo#7: no refs\/pull\/7\/merge .*reviewing refs\/pull\/7\/head against main as it stood at the merge \([0-9a-f]{7}\)$/);
  } finally {
    c.cleanup();
  }
  rmSync(origin.root, { recursive: true, force: true });
});

test("checkout: a merged pull request still diffs to its own change, not an empty diff", () => {
  const origin = fakeGitHub("merged");
  const { c } = checkout(origin);

  try {
    // The head commit is an ancestor of `main` now, so `main...HEAD` would resolve
    // its merge base to the head commit itself and report nothing at all. The
    // basis has to be the base branch as it stood at the merge instead.
    assert.equal(changed(c.dir, "refs/graft/base"), "feature.txt");
    const tip = execFileSync("git", ["rev-parse", "refs/graft/head"], { cwd: c.dir, encoding: "utf8" }).trim();
    const base = execFileSync("git", ["rev-parse", c.base], { cwd: c.dir, encoding: "utf8" }).trim();
    assert.notEqual(base, tip, "the base must not have been left where the merge base lands");
    assert.equal(changed(c.dir, tip), "", "sanity: diffing against the head commit is the empty diff being avoided");
  } finally {
    c.cleanup();
  }
  rmSync(origin.root, { recursive: true, force: true });
});

test("checkout: a squash-merged pull request diffs against the fork point", () => {
  const origin = fakeGitHub("squashed");
  const { c, logs } = checkout(origin);

  try {
    // A squash lands NEW commits, so the head commit is not in `main`'s history
    // and the ordinary three-dot diff against the base tip is already right —
    // no rewriting of the base, and the log says so.
    assert.equal(c.ref, "head");
    assert.equal(changed(c.dir, c.base), "feature.txt");
    assert.match(logs[0], /reviewing refs\/pull\/7\/head against main \(merge base [0-9a-f]{7}\)/);
  } finally {
    c.cleanup();
  }
  rmSync(origin.root, { recursive: true, force: true });
});

test("checkout: deepens when the base branch has moved past the shallow window", () => {
  const origin = fakeGitHub("merged-far-behind");
  const { c } = checkout(origin);

  try {
    // 55 commits landed on `main` after the merge, so the shallow fetch reaches
    // no shared commit at all: without the deepening, git has no merge base and
    // `git diff base...HEAD` fails outright.
    assert.equal(c.ref, "head");
    assert.equal(changed(c.dir, c.base), "feature.txt");
  } finally {
    c.cleanup();
  }
  rmSync(origin.root, { recursive: true, force: true });
});

test("checkout: with neither ref fetchable, the error names both attempts", () => {
  const origin = fakeGitHub();
  try {
    // Pull request 8 has no refs at all — the shape of a repository whose base
    // branch is gone, or an installation that lost access.
    checkout(origin, 8);
    assert.fail("expected the fetch to fail");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /failed at fetch/);
    assert.match(msg, /refs\/pull\/8\/merge/, "the merge ref that was tried first");
    assert.match(msg, /falling back to refs\/pull\/8\/head/, "and that the fallback was tried too");
    assert.ok(!msg.includes("ghs_secret_token"), "git's error text is redacted before it is thrown");
  } finally {
    rmSync(origin.root, { recursive: true, force: true });
  }
});

test("checkout: a failure names the step and never leaks the token", () => {
  const parent = mkdtempSync(join(tmpdir(), "graft-empty-"));
  try {
    checkoutPullRequest({
      owner: ".",
      repo: "does-not-exist",
      number: 1,
      baseRef: "main",
      token: "ghs_secret_token",
      api: `file://${parent}`,
    });
    assert.fail("expected the fetch to fail");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /failed at fetch/, "says which step, so a missing merge ref is not read as a permissions problem");
    assert.ok(!msg.includes("ghs_secret_token"), "git's error text is redacted before it is thrown");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("redact: removes the token in both the shapes it appears in", () => {
  const encoded = Buffer.from("x-access-token:ghs_abc").toString("base64");
  const text = `fatal: auth failed for ghs_abc using Basic ${encoded}`;

  const clean = redact(text, "ghs_abc");
  assert.ok(!clean.includes("ghs_abc"));
  assert.ok(!clean.includes(encoded));
  assert.match(clean, /fatal: auth failed for \[token\] using Basic \[token\]/);
});

function fakeIndirectGitHub(integrate: boolean): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "graft-indirect-origin-"));
  const work = join(root, "work");
  execFileSync("git", ["init", "--quiet", "-b", "main", work]);
  const fixed = (...args: string[]): string => execFileSync("git", args, {
    cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
      GIT_AUTHOR_DATE: "@1700000000 +0000", GIT_COMMITTER_DATE: "@1700000000 +0000" },
  });
  writeFileSync(join(work, "base.txt"), "base\n");
  fixed("add", "-A"); fixed("commit", "--quiet", "-m", "base");
  fixed("checkout", "--quiet", "-b", "feature");
  writeFileSync(join(work, "feature.txt"), "feature\n");
  fixed("add", "-A"); fixed("commit", "--quiet", "-m", "feature");
  fixed("update-ref", "refs/pull/7/head", "HEAD");
  fixed("checkout", "--quiet", "-b", "unrelated", "main");
  writeFileSync(join(work, "unrelated.txt"), "unrelated\n");
  fixed("add", "-A"); fixed("commit", "--quiet", "-m", "unrelated");
  if (integrate) {
    fixed("checkout", "--quiet", "feature");
    fixed("merge", "--quiet", "--no-ff", "-m", "feature-side merge", "unrelated");
    fixed("checkout", "--quiet", "main");
    writeFileSync(join(work, "base.txt"), "base\nmore\n");
    fixed("add", "-A"); fixed("commit", "--quiet", "-m", "other work");
    fixed("merge", "--quiet", "--no-ff", "-m", "base integration", "feature");
  } else {
    fixed("checkout", "--quiet", "main");
    fixed("merge", "--quiet", "--ff-only", "feature");
    fixed("merge", "--quiet", "--no-ff", "-m", "unrelated merge", "unrelated");
  }
  fixed("branch", "-D", "feature");
  fixed("clone", "--quiet", "--mirror", work, join(root, "demo.git"));
  return { root, repo: "demo" };
}

test("checkout: a fast-forward followed by another merge still has no diff base", () => {
  const origin = fakeIndirectGitHub(false);
  let c: ReturnType<typeof checkoutPullRequest> | undefined;
  try {
    assert.throws(() => { c = checkout(origin).c; }, /failed at diff base.*fast-forward merge/s);
  } finally {
    c?.cleanup();
    rmSync(origin.root, { recursive: true, force: true });
  }
});

test("checkout: skips feature-side first-parent merges to find base integration", () => {
  const origin = fakeIndirectGitHub(true);
  let c: ReturnType<typeof checkoutPullRequest> | undefined;
  try {
    c = checkout(origin).c;
    assert.equal(c.ref, "head");
    assert.equal(changed(c.dir, c.base), "feature.txt");
  } finally {
    c?.cleanup();
    rmSync(origin.root, { recursive: true, force: true });
  }
});

function fakeSecondParentGitHub(): { root: string; repo: string; mainParent: string } {
  const root = mkdtempSync(join(tmpdir(), "graft-second-parent-origin-"));
  const work = join(root, "work");
  execFileSync("git", ["init", "--quiet", "-b", "main", work]);
  const fixed = (...args: string[]): string => execFileSync("git", args, {
    cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
      GIT_AUTHOR_DATE: "@1700000000 +0000", GIT_COMMITTER_DATE: "@1700000000 +0000" },
  });
  writeFileSync(join(work, "base.txt"), "base\n");
  fixed("add", "-A"); fixed("commit", "--quiet", "-m", "root");
  const rootSha = fixed("rev-parse", "HEAD").trim();
  writeFileSync(join(work, "already.txt"), "already on main\n");
  fixed("add", "-A"); fixed("commit", "--quiet", "-m", "shared base");
  fixed("checkout", "--quiet", "-b", "feature");
  writeFileSync(join(work, "feature.txt"), "feature\n");
  fixed("add", "-A"); fixed("commit", "--quiet", "-m", "feature");
  fixed("update-ref", "refs/pull/7/head", "HEAD");
  fixed("checkout", "--quiet", "-b", "unrelated", rootSha);
  writeFileSync(join(work, "unrelated.txt"), "unrelated\n");
  fixed("add", "-A"); fixed("commit", "--quiet", "-m", "unrelated");
  fixed("merge", "--quiet", "--no-ff", "-m", "feature-side second-parent merge", "feature");
  fixed("checkout", "--quiet", "main");
  writeFileSync(join(work, "base.txt"), "base\nmore\n");
  fixed("add", "-A"); fixed("commit", "--quiet", "-m", "other work");
  const mainParent = fixed("rev-parse", "HEAD").trim();
  fixed("merge", "--quiet", "--no-ff", "-m", "base integration", "unrelated");
  fixed("branch", "-D", "feature");
  fixed("clone", "--quiet", "--mirror", work, join(root, "demo.git"));
  return { root, repo: "demo", mainParent };
}

test("checkout: chooses the base landing instead of a feature-side second-parent merge", () => {
  const origin = fakeSecondParentGitHub();
  let c: ReturnType<typeof checkoutPullRequest> | undefined;
  try {
    c = checkout(origin).c;
    assert.equal(changed(c.dir, c.base), "feature.txt");
    assert.equal(git(c.dir, "rev-parse", c.base).trim(), origin.mainParent);
  } finally {
    c?.cleanup();
    rmSync(origin.root, { recursive: true, force: true });
  }
});
