import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { changedFiles } from "../src/blast/diff.js";
import { tmpRepo } from "./helpers.js";

function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const configurations: [string, [string, string][]][] = [
  ["default", []],
  ["mnemonic", [["diff.mnemonicPrefix", "true"]]],
  ["no prefix", [["diff.noprefix", "true"]]],
  ["custom", [["diff.srcPrefix", "before/"], ["diff.dstPrefix", "after/"]]],
];

for (const [name, settings] of configurations) {
  for (const comparison of ["working tree", "base branch", "last commit"] as const) {
    test(`diff: ${name} configuration preserves paths and hunks for ${comparison}`, (t) => {
      const dir = tmpRepo("diff-prefix");
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      git(dir, "init", "-b", "main");
      git(dir, "config", "user.name", "Test");
      git(dir, "config", "user.email", "test@example.com");
      // Set defaults locally so the fixture is independent of the contributor's
      // global preferences, then enable the configuration under test.
      for (const [key, value] of [
        ["diff.mnemonicPrefix", "false"], ["diff.noprefix", "false"],
        ["diff.srcPrefix", "a/"], ["diff.dstPrefix", "b/"], ...settings,
      ]) git(dir, "config", key, value);

      // A real b/ directory catches the ambiguity in stripping a presumed
      // prefix when the user's diff.noprefix setting removed it already.
      mkdirSync(join(dir, "b"));
      writeFileSync(join(dir, "b/changed file.ts"), "export function value() {\n  return 1;\n}\n");
      const renameBody = "// stable first line\n// stable second line\n// stable third line\n// stable fourth line\n";
      writeFileSync(join(dir, "b/old.ts"), `${renameBody}export const old = 1;\n`);
      writeFileSync(join(dir, "b/deleted.ts"), "export const deleted = true;\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-m", "initial");
      git(dir, "checkout", "-b", "feature");

      writeFileSync(join(dir, "b/changed file.ts"), "export function value() {\n  return 2;\n}\n");
      renameSync(join(dir, "b/old.ts"), join(dir, "b/renamed.ts"));
      writeFileSync(join(dir, "b/renamed.ts"), `${renameBody}export const old = 2;\n`);
      writeFileSync(join(dir, "b/added.ts"), "export const added = true;\n");
      rmSync(join(dir, "b/deleted.ts"));
      git(dir, "add", "-A");
      // Keep both staged and unstaged edits in the working-tree comparison.
      writeFileSync(join(dir, "b/changed file.ts"), "export function value() {\n  return 3;\n}\n");
      if (comparison !== "working tree") {
        git(dir, "add", "-A");
        git(dir, "commit", "-m", "edit files");
      }

      const configBefore = git(dir, "config", "--local", "--list");
      const result = changedFiles(dir, comparison === "base branch" ? "main" : undefined);
      assert.ok(result);
      assert.equal(result.basis, comparison === "working tree" ? "working tree vs HEAD" : comparison === "base branch" ? "main...HEAD" : "HEAD~1...HEAD");
      const files = new Map(result.files.map((file) => [file.path, file]));
      assert.equal(files.size, 4);
      assert.deepEqual(files.get("b/changed file.ts")?.ranges, [{ start: 2, end: 2 }]);
      assert.deepEqual(files.get("b/changed file.ts")?.hunks[0].lines, [
        { n: null, sign: "-", text: "  return 1;" },
        { n: 2, sign: "+", text: "  return 3;" },
      ]);
      assert.equal(files.get("b/added.ts")?.status, "added");
      assert.deepEqual(files.get("b/added.ts")?.ranges, [{ start: 1, end: 1 }]);
      assert.equal(files.get("b/renamed.ts")?.status, "renamed");
      assert.equal(files.get("b/renamed.ts")?.oldPath, "b/old.ts");
      assert.deepEqual(files.get("b/renamed.ts")?.ranges, [{ start: 5, end: 5 }]);
      assert.equal(files.get("b/deleted.ts")?.status, "deleted");
      assert.deepEqual(files.get("b/deleted.ts")?.ranges, []);
      assert.deepEqual(files.get("b/deleted.ts")?.hunks, []);
      assert.equal(git(dir, "config", "--local", "--list"), configBefore);
    });
  }
}
