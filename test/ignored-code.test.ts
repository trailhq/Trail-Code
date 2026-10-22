/**
 * An empty `trail grep` names the git-ignored code it never searched, instead
 * of saying all the code was searched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ignoredCode } from "../src/search/ignored-code.js";
import { zeroHitNote } from "../src/search/grep-cli.js";
import { tmpRepo } from "./helpers.js";

test("git-ignored code is found, and dependency folders and non-code files are not", () => {
  const d = tmpRepo("ignored-code");
  spawnSync("git", ["init", "-q"], { cwd: d });
  writeFileSync(join(d, ".gitignore"), "connectpay/source_models/\nnode_modules/\n*.log\nsecrets.py\n");
  mkdirSync(join(d, "connectpay", "source_models", "payroll"), { recursive: true });
  writeFileSync(join(d, "connectpay", "source_models", "payroll", "fraud_gate.py"), "def fraud_gate(doc):\n    return True\n");
  mkdirSync(join(d, "node_modules", "x"), { recursive: true });
  writeFileSync(join(d, "node_modules", "x", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(d, "run.log"), "log\n");
  writeFileSync(join(d, "secrets.py"), "KEY = 1\n");
  writeFileSync(join(d, "connectpay", "agent.py"), "def run():\n    return 1\n");
  spawnSync("git", ["add", "-A"], { cwd: d });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: d });
  assert.deepEqual(ignoredCode(d).sort(), ["connectpay/source_models/", "secrets.py"]);
  assert.deepEqual(ignoredCode(tmpRepo("not-git")), [], "outside git there is nothing to say");
});

test("the zero-hit note names ignored code instead of claiming everything was searched", () => {
  const miss = { pattern: "fraud_gate", filesSearched: 322, totalHits: 0, groups: [], truncated: { files: 0 } } as unknown as Parameters<typeof zeroHitNote>[0];
  const note = zeroHitNote(miss, ["connectpay/source_models/", "octanelending/source_models/", "a/", "b/"]);
  assert.match(note, /Git-ignored code isn't indexed and wasn't searched: connectpay\/source_models\/, octanelending\/source_models\/, a\/ and 1 more\. Run grep -rn there/);
  assert.doesNotMatch(note, /All indexed code was searched/);
  assert.match(zeroHitNote(miss), /All indexed code was searched/);
});
