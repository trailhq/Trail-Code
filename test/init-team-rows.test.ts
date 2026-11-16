/**
 * D184: `trail init` shows #662's team rows (what reviewers made authors change, tied to code, and what Claude Code
 * keeps about the repo) and the skills look-back on one screen, each with its own consent: the team rows first and
 * ticked (#662), the look-back's items ticked only for the person's own typed words (D23). With no screen, #662
 * keeps the team rows itself and the agent is told to ask about the commit, while the look-back is relayed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { beginLookBack, finishLookBack } from "../src/init/run.js";
import { screenLines } from "../src/init/review-screen.js";
import { detailLines } from "../src/init/review-tty.js";
import type { InitItem } from "../src/init/types.js";
import { claudeProjectDir } from "../src/notes/session-cost.js";
import { factsOf, REPO_KEY, threeItems } from "./init-screen-fixtures.js";
import { tmpRepo } from "./helpers.js";

const TEAM = "For your whole team. These go into this repo, and your teammates' Claude gets them once you commit.";
const FOR_YOU = "For your Claude only. Your teammates' Claude doesn't get these.";

const teamRow = (over: Partial<InitItem>): InitItem => ({
  id: "i-0000000001", kind: "review", key: "review:x", plainName: "", nameWords: [], count: { days: 2, from: "2026-10-10", to: "2026-10-10" },
  scope: "repo", applies: REPO_KEY, typed: false, ticked: true, evidence: [], rank: 1, n: 1, title: "Return a 500 when db.query fails in src/api",
  description: "", review: { prs: [41, 38] }, ...over,
});

test("one screen: the team rows first under their own heading and ticked, then the look-back's items as before", () => {
  const team = [teamRow({}), teamRow({ id: "i-0000000002", kind: "claude", key: "claude:y", review: undefined, title: "Retries stay at 4 because the gateway times out", n: 2 })];
  const look = threeItems().map((i, k) => ({ ...i, n: k + 3 }));
  const lines = screenLines([...team, ...look], { cursor: 0, open: null }, factsOf());
  const at = (l: string) => lines.indexOf(l);
  assert.ok(at(TEAM) > 0, lines.join("\n"));
  assert.ok(lines.includes("› [x] 1  Return a 500 when db.query fails in src/api"));
  assert.ok(lines.includes("         From PR #41 and #38."));
  assert.ok(lines.includes("  [x] 2  Retries stay at 4 because the gateway times out"));
  assert.ok(lines.includes("         From what your Claude keeps about this repo."));
  assert.equal(lines.filter((l) => l === TEAM).length, 1, "one heading for both sources");
  assert.ok(at(TEAM) < at(FOR_YOU) && at(FOR_YOU) < at("Skills") && at("Skills") < at("Learnings"));
  assert.ok(lines.includes("  [ ] 3  release-npm (this repo only)"), "nothing Claude drafted starts ticked");
  assert.ok(lines.includes("  [x] 5  \"explain it simply, one example first\" (every repo)"));
});

test("a screen with only team rows (no look-back this time) has no found line", () => {
  const lines = screenLines([teamRow({})], { cursor: 0, open: null }, factsOf({ lookedBack: false }));
  assert.equal(lines[0], "");
  assert.equal(lines[1], TEAM);
  assert.ok(!lines.some((l) => /looked back|no past Claude Code sessions/.test(l)));
});

// The spawned run is a shebang-free tsx run, but `git` and the transcript paths are POSIX here.
test("run by an agent, init keeps the team's memory row as #662 does, asks about the commit, and still relays the look-back", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "team-rows-home-"));
  const repo = tmpRepo("team-rows");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "retry.ts"), "export const MAX = 4;\n");
  const project = claudeProjectDir(repo, home);
  mkdirSync(join(project, "memory"), { recursive: true });
  for (const [id, at] of [["aaaaaaaa-1111", "2026-10-01T10:00:00Z"], ["bbbbbbbb-2222", "2026-10-03T10:00:00Z"]])
    writeFileSync(join(project, `${id}.jsonl`), [
      { type: "user", cwd: repo, timestamp: at, message: { role: "user", content: "never use em dashes in the copy" } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(project, "memory", "retry.md"), "---\nname: retry-budget\ndescription: Retries stay at 4 because the gateway times out at 30 s\ntype: project\n---\n\nKeep MAX at 4 in src/retry.ts.\n\n**Why:** 4 tries × 7 s fit under the gateway's 30 s.\n");
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "src", "bin", "trail.ts"), "init", repo, "--agents", "claude", "--no-build", "--no-global"], {
    encoding: "utf8",
    cwd: repo,
    env: { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), DO_NOT_TRACK: "1", CLAUDECODE: "1", TRAIL_NO_LOOK_BACK: undefined, TRAIL_INVOKED_AS: undefined },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /✓ looked back at 2 Claude Code sessions about this repo/, "the look-back is relayed");
  assert.match(r.stderr, /✓ kept 1 of the 1 notes your Claude keeps about this repo\n {4}for your team · Retries stay at 4 because the gateway times out at 30 s/);
  assert.match(r.stderr, /→ 1 team learning in \.trail\/learnings\/ isn't committed yet\. Ask the user: "Commit it so your teammates' Claude starts from it\? \(yes \/ no\)"/);
  const dir = join(repo, ".trail", "learnings");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  assert.equal(files.length, 1, "only the team row: the look-back keeps nothing without the person");
  assert.match(readFileSync(join(dir, files[0]!), "utf8"), /_From Claude Code's memory of this repo, last updated /);
});

/* ---- the screen, in process: enter keeps the ticked team row, esc keeps nothing and asks again ---- */

function fakeTty(keys: string[]) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: (b: boolean) => unknown };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  let out = "";
  const stdout = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.isTTY = true;
  let k = 0;
  const next = () => {
    if (k < keys.length) {
      (stdin as unknown as PassThrough).write(keys[k++]!);
      setTimeout(next, 5);
    }
  };
  setTimeout(next, 50);
  return { io: { stdin, stdout }, out: () => out };
}

const ME = 4242;
const atTerminal = { stdinTTY: true, stdoutTTY: true, pid: ME, ps: () => [
  { pid: 1, ppid: 0, comm: "/sbin/launchd", args: "/sbin/launchd" },
  { pid: 10, ppid: 1, comm: "/bin/zsh", args: "-zsh" },
  { pid: ME, ppid: 10, comm: "node", args: "node trail init" },
] };

async function withMemoryRepo(tag: string, fn: (repo: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), `${tag}-home-`));
  const repo = tmpRepo(tag);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "retry.ts"), "export const MAX = 4;\n");
  const project = claudeProjectDir(repo, home);
  mkdirSync(join(project, "memory"), { recursive: true });
  writeFileSync(join(project, "s1.jsonl"), JSON.stringify({ type: "user", cwd: repo, message: { content: "hi" } }) + "\n");
  writeFileSync(join(project, "memory", "retry.md"), "---\nname: retry-budget\ndescription: Retries stay at 4 because the gateway times out at 30 s\ntype: project\n---\n\nKeep MAX at 4 in src/retry.ts.\n\n**Why:** 4 tries × 7 s fit under the gateway's 30 s.\n");
  const saved = { trail: process.env.TRAIL_HOME, dnt: process.env.DO_NOT_TRACK };
  process.env.TRAIL_HOME = join(home, ".trail");
  process.env.DO_NOT_TRACK = "1";
  try {
    await fn(repo, { HOME: home, TRAIL_HOME: join(home, ".trail"), PATH: "/usr/bin:/bin", TRAIL_NO_FETCH: "1", DO_NOT_TRACK: "1" });
  } finally {
    for (const [k, v] of [["TRAIL_HOME", saved.trail], ["DO_NOT_TRACK", saved.dnt]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const learningsIn = (repo: string) => (existsSync(join(repo, ".trail", "learnings")) ? readdirSync(join(repo, ".trail", "learnings")).filter((f) => f.endsWith(".md")) : []);

test("at the person's terminal the team row is on the screen, ticked; enter keeps it into .trail/learnings/", { skip: process.platform === "win32" }, async () => {
  await withMemoryRepo("team-rows-enter", async (repo, env) => {
    const said: string[] = [];
    const t = fakeTty(["\r"]);
    const { reads } = beginLookBack(repo, { env, deps: atTerminal, plain: true });
    assert.equal(reads.memory.length, 1);
    const r = await finishLookBack(repo, reads, { yes: false, say: (l) => said.push(l), io: t.io });
    assert.match(t.out(), /For your whole team\. These go into this repo, and your teammates' Claude gets them once you commit\.\n› \[x\] 1 {2}Retries stay at 4 because the gateway times out at 30 s/);
    assert.equal(r.team, 1);
    assert.equal(learningsIn(repo).length, 1);
    assert.ok(said.some((l) => /added to this repo's \.trail\/learnings/.test(l)), said.join("\n"));
  });
});

test("esc on the screen keeps no team row and marks none offered, so the next init asks again", { skip: process.platform === "win32" }, async () => {
  await withMemoryRepo("team-rows-esc", async (repo, env) => {
    const t = fakeTty(["\x1b"]);
    const { reads } = beginLookBack(repo, { env, deps: atTerminal, plain: true });
    const r = await finishLookBack(repo, reads, { yes: false, say: () => {}, io: t.io });
    assert.equal(r.team, 0);
    assert.deepEqual(learningsIn(repo), []);
    assert.equal(beginLookBack(repo, { env, deps: atTerminal, plain: true }).reads.memory.length, 1, "offered again");
  });
});

test("s on a learning from past sessions or the PRs shows what its file will say, before it's kept", () => {
  const row = teamRow({ kind: "session", key: "session:x", review: undefined, title: "Sign up comes first", detail: ["Decided: the owner reversed a read-first build.", "In the code: every /start page sends signed-out people to sign up."] });
  assert.deepEqual(detailLines(row, process.env), ["Decided: the owner reversed a read-first build.", "In the code: every /start page sends signed-out people to sign up."]);
  assert.deepEqual(detailLines(teamRow({ detail: ["Watch out: handlers must return a 500."] }), process.env), ["Watch out: handlers must return a 500."]);
});
