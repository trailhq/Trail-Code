/** What `trail check` reads: the branch's changes, without the wiring `trail init` wrote. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchAddsLearning, branchDiff } from "../src/cloud/diff.js";
import { tmpRepo } from "./helpers.js";

function git(d: string, args: string[]) {
  spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd: d });
}

function learning(d: string, name = "retry.md", body = "# Decided\nUse a channel.\n") {
  mkdirSync(join(d, ".trail", "learnings"), { recursive: true });
  writeFileSync(join(d, ".trail", "learnings", name), body);
}

test("trail check leaves out the files trail init writes", () => {
  const d = tmpRepo("check-diff");
  writeFileSync(join(d, "client.go"), "package x\n\nconst defaultRetryMax = 4\n");
  git(d, ["init", "-q", "-b", "main"]);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "init"]);
  // The wiring, committed on main but never pushed, then a branch with a real change.
  mkdirSync(join(d, ".claude", "skills", "trail"), { recursive: true });
  writeFileSync(join(d, ".claude", "skills", "trail", "SKILL.md"), "# trail\n");
  writeFileSync(join(d, ".mcp.json"), "{}\n");
  writeFileSync(join(d, "client.go"), "package x\n\nconst defaultRetryMax = 10\n");
  git(d, ["add", "-A"]); // staged, so plain git diff would show every one of them
  const r = branchDiff(d, "HEAD");
  assert.deepEqual(r?.files, ["client.go"]);
  assert.doesNotMatch(r!.diff, /SKILL\.md|mcp\.json/);
  assert.match(r!.diff, /defaultRetryMax = 10/);
});

test("branchAddsLearning: a commit on the default branch with no remote still counts (#899)", () => {
  const d = tmpRepo("check-learning-default-branch");
  writeFileSync(join(d, "client.go"), "package x\n");
  git(d, ["init", "-q", "-b", "main"]);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "init"]);
  // No remote at all, and the work lands directly on main: the merge-base of
  // HEAD and its base is HEAD itself, so the branch range is empty.
  learning(d);
  writeFileSync(join(d, "client.go"), "package x\n\nconst defaultRetryMax = 10\n");
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "fix retry, add learning"]);
  assert.equal(branchAddsLearning(d), true, "the shipped commit adds a learning");
  // Control: the next commit on the same branch carries no learning of its own.
  writeFileSync(join(d, "client.go"), "package x\n\nconst defaultRetryMax = 11\n");
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "review fix"]);
  assert.equal(branchAddsLearning(d), false, "a later commit with no learning does not inherit the earlier one");
});

test("branchAddsLearning: a merge that brings a learning in still counts (#899)", () => {
  const d = tmpRepo("check-learning-merge");
  writeFileSync(join(d, "client.go"), "package x\n");
  git(d, ["init", "-q", "-b", "main"]);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "init"]);
  git(d, ["checkout", "-qb", "side"]);
  learning(d);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "add learning on side"]);
  git(d, ["checkout", "-q", "main"]);
  git(d, ["merge", "-q", "--no-ff", "side", "-m", "merge side"]);
  // No remote, on main: the merge commit is the tip and the branch range is empty.
  // A plain `git show` of a merge prints a combined diff and omits the learning.
  assert.equal(branchAddsLearning(d), true, "the merge ships the learning");
});

test("branchAddsLearning: a shallow clone's tip does not inherit learnings already in the tree (#899)", () => {
  const src = tmpRepo("check-learning-shallow-src");
  writeFileSync(join(src, "client.go"), "package x\n");
  learning(src);
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-qm", "init with learning"]);
  writeFileSync(join(src, "client.go"), "package x\n\nconst defaultRetryMax = 10\n");
  git(src, ["add", "-A"]);
  git(src, ["commit", "-qm", "code only"]);
  // A depth-1 clone of the code-only tip: HEAD's parent object was never fetched,
  // so diffing against the empty tree would list every learning already in it.
  // A plain path clone ignores --depth, so clone over file://.
  const d = tmpRepo("check-learning-shallow");
  spawnSync("git", ["clone", "-q", "--depth", "1", `file://${src}`, d]);
  assert.equal(branchAddsLearning(d), false, "the shallow tip ships no learning of its own");
});

test("branchAddsLearning: a root commit that adds a learning counts", () => {
  const d = tmpRepo("check-learning-root");
  writeFileSync(join(d, "client.go"), "package x\n");
  learning(d);
  git(d, ["init", "-q", "-b", "main"]);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "init with learning"]);
  assert.equal(branchAddsLearning(d), true, "the root commit adds a learning");
});

test("branchAddsLearning: a learning only edited on the branch counts, a code-only branch does not", () => {
  const d = tmpRepo("check-learning-edited");
  writeFileSync(join(d, "client.go"), "package x\n");
  learning(d, "retry.md", "# Decided\nOld way.\n");
  git(d, ["init", "-q", "-b", "main"]);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "init"]);
  git(d, ["checkout", "-qb", "feature"]);
  learning(d, "retry.md", "# Decided\nNew way.\n");
  writeFileSync(join(d, "client.go"), "package x\n\nconst defaultRetryMax = 10\n");
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "fix retry, update learning"]);
  assert.equal(branchAddsLearning(d, "main"), true, "editing a tracked learning is still shipping one");

  const e = tmpRepo("check-learning-absent");
  writeFileSync(join(e, "client.go"), "package x\n");
  git(e, ["init", "-q", "-b", "main"]);
  git(e, ["add", "-A"]);
  git(e, ["commit", "-qm", "init"]);
  git(e, ["checkout", "-qb", "feature"]);
  writeFileSync(join(e, "client.go"), "package x\n\nconst defaultRetryMax = 10\n");
  git(e, ["add", "-A"]);
  git(e, ["commit", "-qm", "fix retry"]);
  assert.equal(branchAddsLearning(e, "main"), false, "a branch with no learning anywhere");
});
