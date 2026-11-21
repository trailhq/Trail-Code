import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { noteTargets } from "../src/notes/targets.js";
import { tmpRepo } from "./helpers.js";

function fixture() {
  const repo = tmpRepo("note-git-paths");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Trail Test");
  git("config", "user.email", "trail@example.test");
  git("config", "core.quotePath", "true");
  git("config", "status.renames", "true");
  git("config", "commit.gpgsign", "false");
  return { repo, git };
}

test("a learning's working-tree touches preserve Git paths and use the rename destination", () => {
  const { repo, git } = fixture();
  const modified = process.platform === "win32" ? "notes with spaces.ts" : "notes -> analysis.ts";
  writeFileSync(join(repo, modified), "before\n");
  writeFileSync(join(repo, "previous.ts"), "before\n");
  git("add", "--", modified, "previous.ts");
  git("commit", "-qm", "initial files");
  git("mv", "--", "previous.ts", "漢字.ts");
  writeFileSync(join(repo, modified), "after\n");
  writeFileSync(join(repo, ".ignore"), "unrelated\n");

  assert.deepEqual(noteTargets(repo)[0]?.touches.toSorted(), [modified, "漢字.ts"].toSorted());
});

test("a session learning's committed touches preserve Unicode paths and deduplicate across commits", () => {
  const { repo, git } = fixture();
  const since = Date.now() - 60_000;
  for (const path of ["検索.ts", "漢字.ts"]) {
    writeFileSync(join(repo, "common.ts"), path);
    writeFileSync(join(repo, path), "committed\n");
    git("add", "--", "common.ts", path);
    git("commit", "-qm", "edit files");
  }
  writeFileSync(join(repo, "uncommitted.ts"), "leave out\n");

  assert.deepEqual(noteTargets(repo, [], since, { read: [] })[0]?.touches.toSorted(), ["common.ts", "検索.ts", "漢字.ts"].toSorted());
});
