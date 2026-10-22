/**
 * `trail init` in the home folder: refused before anything is written. In any
 * other folder outside git it still sets up, but says the learnings stay on
 * this machine instead of telling the person to commit them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeFolderRefusal, isGitWorkTree, NOT_GIT_LINE } from "../src/init-guard.js";
import { homeEnv, tmpRepo } from "./helpers.js";

function run(args: string[], home: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_HOME: undefined, TRAIL_NO_FETCH: "1" },
  });
  return { status: r.status, err: r.stderr };
}

test("only the home folder is refused", () => {
  const home = mkdtempSync(join(tmpdir(), "guard-home-"));
  assert.match(homeFolderRefusal(home, home) ?? "", /is your home folder, not a repo/);
  assert.equal(homeFolderRefusal(join(home, "code", "assign"), home), null);
});

test("trail init in the home folder writes nothing and exits 1", () => {
  const home = mkdtempSync(join(tmpdir(), "guard-home-"));
  writeFileSync(join(home, "notes.py"), "print('hi')\n");
  const r = run(["init", home, "--agents", "claude", "--no-global"], home);
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /✗ ~ is your home folder, not a repo\.\n {2}cd into the repo you want to set up, then run trail init again\./);
  assert.ok(!existsSync(join(home, ".trail")), "no .trail/");
  assert.ok(!existsSync(join(home, ".claude", "settings.json")), "no .claude/settings.json");
});

test("outside git, init says learnings stay on this machine instead of saying to commit", () => {
  const home = mkdtempSync(join(tmpdir(), "guard-home-"));
  const d = tmpRepo("guard-plain");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "main.py"), "def main():\n    return 1\n");
  assert.equal(isGitWorkTree(d), false);
  const r = run(["init", d, "--agents", "claude", "--no-global"], home);
  assert.equal(r.status, 0, r.err);
  assert.ok(r.err.includes(NOT_GIT_LINE), r.err);
  assert.doesNotMatch(r.err, /· commit /);
});
