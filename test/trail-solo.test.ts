/**
 * Solo mode (src/notes/solo.ts): `trail init --solo` or `trail solo` turns Part 2
 * off for this repo (learnings, skills offers, look-back) while the graft map stays.
 * `trail solo` again turns learnings back on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { uncommittedDirective } from "../src/claude/hooks.js";
import { attachNotes } from "../src/notes/ask-notes.js";
import { writeNote } from "../src/notes/notes.js";
import { isSolo, learningsOn, setSolo, SOLO_DIRECTIVE } from "../src/notes/solo.js";
import { cloudLines } from "../src/cloud/nudge.js";
import { skillsGate } from "../src/trace/skill-session.js";
import { tmpRepo } from "./helpers.js";
import type { AskResult } from "../src/ask/ask.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_TEST_SERVER = "http://trail.test";
process.env.TRAIL_NO_FETCH = "1";
process.env.TRAIL_CLOUD = "1";

function git(d: string, ...args: string[]): string {
  return spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: d, encoding: "utf8" }).stdout;
}

let n = 0;
/** A GitHub-backed repo with one commit, and a fresh ~/.trail for it. */
function repo(): string {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "solo-home-"));
  const dir = tmpRepo("solo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Priya Raman");
  git(dir, "config", "user.email", "priya@example.com");
  git(dir, "remote", "add", "origin", `https://github.com/acme/solo-${++n}.git`);
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

const note = { title: "Retries trip the rate limit", body: "## Decided\nThree retries.", author: "Priya", date: "2026-11-02", touches: [] };

test("isSolo / setSolo / learningsOn round-trip", () => {
  const dir = repo();
  assert.equal(isSolo(dir), false);
  assert.equal(learningsOn(dir), false, "no trail home yet");
  mkdirSync(join(dir, ".trail"), { recursive: true });
  assert.equal(learningsOn(dir), true);
  setSolo(dir, true);
  assert.equal(isSolo(dir), true);
  assert.equal(learningsOn(dir), false);
  setSolo(dir, false);
  assert.equal(isSolo(dir), false);
  assert.equal(learningsOn(dir), true);
});

test("writeNote refuses under solo; attachNotes and cloud nudge no-op", () => {
  const dir = repo();
  mkdirSync(join(dir, ".trail", "learnings"), { recursive: true });
  writeNote(dir, note);
  setSolo(dir, true);
  assert.throws(() => writeNote(dir, note), /solo: learnings are off/);
  const ask: AskResult = { query: "retries", mode: "empty", hits: [], notesChecked: false };
  assert.equal(attachNotes(ask, dir).notes, undefined);
  assert.equal(attachNotes(ask, dir).notesChecked, false);
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "s1" };
  assert.deepEqual(cloudLines(dir, { command: "ask", agent: true, env, startWait: () => {} }), []);
  assert.ok(uncommittedDirective(dir).includes(SOLO_DIRECTIVE));
});

test("skillsGate skips a solo repo", () => {
  const dir = repo();
  const home = process.env.TRAIL_HOME!;
  mkdirSync(join(home), { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ v: 1, skills: "on" }));
  setSolo(dir, true);
  const g = skillsGate({ session_id: "s1", cwd: dir, transcript_path: join(dir, "t.jsonl") }, dir, {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: "cli",
    TRAIL_HOME: home,
  });
  assert.deepEqual(g, { ok: false, why: "solo" });
});

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (status) => resolve({ status, stderr, stdout }));
  });
}

test("trail init --solo sets the mark, skips look-back copy, and refuses with --look-back", async () => {
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), "solo-cli-"));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TRAIL_HOME: join(home, ".trail"),
    TRAIL_INVOKED_AS: "trail",
  };
  const bad = await run(["init", dir, "--solo", "--look-back", "--agents", "claude", "--no-global", "--no-build"], env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--solo turns learnings off/);

  const mine = await run(["init", dir, "--solo", "--team", "--agents", "claude", "--no-global", "--no-build"], env);
  assert.equal(mine.status, 0, mine.stderr);
  assert.equal(isSolo(dir, env), true);
  assert.match(mine.stderr, /solo {2}graft map only/);
  assert.doesNotMatch(mine.stderr, /look back|Reading past Claude|found \d+ /i);
});

test("trail solo toggles on then off; note and check refuse while on", async () => {
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), "solo-toggle-"));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TRAIL_HOME: join(home, ".trail"),
    TRAIL_INVOKED_AS: "trail",
    TRAIL_NO_LOOK_BACK: "1",
  };
  await run(["init", dir, "--team", "--agents", "claude", "--no-global", "--no-build"], env);
  assert.equal(isSolo(dir, env), false);

  const on = await run(["solo", dir], env);
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stderr, /solo on/);
  assert.equal(isSolo(dir, env), true);

  const noteCmd = await run(["note", dir, "--title", "x", "-m", "## Decided\ny"], env);
  assert.equal(noteCmd.status, 1);
  assert.match(noteCmd.stderr, /solo mode is on/);

  const check = await run(["check", dir], env);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /solo mode is on/);

  const off = await run(["solo", dir], env);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, /solo off/);
  assert.equal(isSolo(dir, env), false);
});
