/**
 * Trail just for one person in a repo (src/notes/just-me.ts): `trail init --just-me`, or "just me" at init's
 * question, leaves git seeing nothing of trail's, keeps every learning in ~/.trail, and turns off the commit and
 * share lines. `trail init --team` shares it again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BRAND_ENV } from "../src/brand.js";
import { askJustMe, isJustMe, JUST_ME_DIRECTIVE, setJustMe } from "../src/notes/just-me.js";
import { writeNote } from "../src/notes/notes.js";
import { cloudLines } from "../src/cloud/nudge.js";
import { uncommittedDirective } from "../src/claude/hooks.js";
import { keepOutOfGit, letGitSee, runInit } from "../src/claude/init.js";
import { tmpRepo } from "./helpers.js";

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
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "just-me-home-"));
  const dir = tmpRepo("just-me");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Priya Raman");
  git(dir, "config", "user.email", "priya@example.com");
  git(dir, "remote", "add", "origin", `https://github.com/acme/just-me-${++n}.git`);
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

const note = { title: "Retries trip the rate limit", body: "## Decided\nThree retries.", author: "Priya", date: "2026-11-02", touches: [] };

/** init's question, answered with `lines` typed one at a time, then the input closed: what it returns and printed. */
async function answer(...lines: string[]): Promise<{ justMe: boolean | null; shown: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (d) => (shown += d));
  const asked = askJustMe({ input, output });
  for (const line of lines) {
    input.write(`${line}\n`);
    await new Promise((ok) => setTimeout(ok, 20));
  }
  input.end();
  return { justMe: await asked, shown };
}

test("init's question: enter picks the team, 2 picks just me, anything else asks again, and closed input cancels", async () => {
  const enter = await answer("");
  assert.equal(enter.justMe, false);
  assert.match(enter.shown, /1 {2}my team: .*\n {2}2 {2}just me: .*\n1 or 2 \(enter for 1\): /);
  assert.equal((await answer("1")).justMe, false);
  assert.equal((await answer("2")).justMe, true);
  const again = await answer("me", "2");
  assert.equal(again.justMe, true);
  assert.equal(again.shown.match(/1 or 2 \(enter for 1\)/g)?.length, 2);
  assert.equal((await answer()).justMe, null);
});

test("a learning for the repo stays in ~/.trail while the repo is just for this person, and goes to .trail/ again after", () => {
  const dir = repo();
  assert.equal(isJustMe(dir), false);
  setJustMe(dir, true);
  assert.equal(isJustMe(dir), true);
  const mine = writeNote(dir, note);
  assert.equal(mine.scope, "personal");
  assert.ok(mine.path.startsWith(process.env.TRAIL_HOME!), mine.path);
  assert.equal(existsSync(join(dir, ".trail", "learnings")), false);
  setJustMe(dir, false);
  assert.equal(writeNote(dir, note).scope, "repo");
});

test("no sign-in link to share, and the session start says there is nothing to commit", () => {
  const dir = repo();
  writeNote(dir, note);
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "s1" };
  setJustMe(dir, true);
  assert.deepEqual(cloudLines(dir, { command: "ask", agent: true, env, startWait: () => {} }), []);
  assert.ok(uncommittedDirective(dir).includes(JUST_ME_DIRECTIVE));
  setJustMe(dir, false);
  assert.notDeepEqual(cloudLines(dir, { command: "ask", agent: true, env, startWait: () => {} }), []);
});

test("the Claude Code wiring leaves .claude/settings.json alone, and takes back out what an earlier init put there", () => {
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), "just-me-claude-"));
  const settings = join(dir, ".claude", "settings.json");
  runInit(dir, { build: false, global: false, home, brand: "trail" });
  assert.match(readFileSync(settings, "utf8"), /\.trail\/hook\.cjs/);
  setJustMe(dir, true);
  runInit(dir, { build: false, global: false, home, brand: "trail" });
  assert.equal(existsSync(settings), false);
  // The person's own settings there stay, without trail's entry.
  setJustMe(dir, false);
  runInit(dir, { build: false, global: false, home, brand: "trail" });
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), model: "opus" }));
  setJustMe(dir, true);
  runInit(dir, { build: false, global: false, home, brand: "trail" });
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { model: "opus" });
});

test("keepOutOfGit and letGitSee hide .trail/ for this clone and show it again", () => {
  const dir = repo();
  mkdirSync(join(dir, ".trail"), { recursive: true });
  writeFileSync(join(dir, ".trail", "README.md"), "x\n");
  keepOutOfGit(dir, ".trail");
  assert.equal(git(dir, "status", "--porcelain"), "");
  letGitSee(dir, ".trail");
  assert.match(git(dir, "status", "--porcelain"), /\.trail\//);
});

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

test("trail init --just-me leaves git status clean, and --team brings back what to commit", async () => {
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), "just-me-cli-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), TRAIL_NO_LOOK_BACK: "1", TRAIL_INVOKED_AS: "trail" };
  const mine = await run(["init", dir, "--just-me", "--agents", "claude", "--no-global", "--no-build"], env);
  assert.equal(mine.status, 0, mine.stderr);
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.match(mine.stderr, /just for you: git sees nothing trail added, so there's nothing to commit\. To share it with your team later, run trail init --team/);
  assert.doesNotMatch(mine.stderr, /· commit /);

  const team = await run(["init", dir, "--team", "--agents", "claude", "--no-global", "--no-build"], env);
  assert.equal(team.status, 0, team.stderr);
  assert.match(git(dir, "status", "--porcelain"), /\?\? \.claude\/\n\?\? \.trail\//);
  assert.match(team.stderr, /· commit \.claude\/settings\.json and \.trail\/ once/);
});
