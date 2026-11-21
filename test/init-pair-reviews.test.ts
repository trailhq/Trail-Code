/**
 * `trail init --pair CODE` run by a coding agent: the person asked for Trail on
 * its page, so this run reads the repo's merged PR reviews like the person's own
 * terminal does, and what the PRs show the team decided reaches the page as
 * found learnings. Without `--pair`, an agent's init still starts no `claude`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { GITHUB } from "./pr-reviews-fixtures.js";

/** Variables an agent sets: the run under test must not inherit the runner's. */
const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|OPENCODE.*|GEMINI_CLI|CURSOR_.*|ANTIGRAVITY_AGENT|COPILOT_.*|AI_AGENT|AGENT|TERM_PROGRAM|TRAIL_NO_FETCH|TRAIL_NO_LOOK_BACK|GH_TOKEN|GITHUB_TOKEN)$/;

/** A repo with the files the reviews were on, whose origin is a bare repo under a `github.com/` path. */
function githubRepo(): string {
  const repo = tmpRepo("pair-reviews");
  const origin = join(mkdtempSync(join(tmpdir(), "gh-origin-")), "github.com", "acme", "shop.git");
  mkdirSync(origin, { recursive: true });
  spawnSync("git", ["init", "-q", "--bare"], { cwd: origin });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  spawnSync("git", ["remote", "add", "origin", origin], { cwd: repo });
  mkdirSync(join(repo, "src", "api"), { recursive: true });
  writeFileSync(join(repo, "src", "api", "orders.ts"), "export async function orders(req) {\n  const rows = await db.query(sql);\n  return rows;\n}\n");
  writeFileSync(join(repo, "src", "api", "users.ts"), "export async function users(req) {\n  return db.query(sql);\n}\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.name=Bob", "-c", "user.email=bob@acme.test", "commit", "-qm", "api"], { cwd: repo });
  return repo;
}

/** A signed-in `gh` that answers the GraphQL call, and a `claude` that names one finding from the reviews (and `sessions` from past sessions); both log. */
function fakeTools(sessions: object[] | "fail" = [], requiredModel?: string): { bin: string; log: string } {
  const bin = mkdtempSync(join(tmpdir(), "pair-tools-"));
  const log = join(bin, "log");
  mkdirSync(log);
  const reviews = {
    findings: [
      {
        headline: "API handlers report database failures instead of hiding them",
        why: "Reviewers kept catching handlers that swallowed a failed query.",
        for_agent: "Handlers in `src/api/` log the db.query error and return a 500.",
        kind: "decided",
        evidence: [
          { source: "#41", quote: "swallows the error from db.query" },
          { source: "#38", quote: "must return a 500 when db.query fails" },
        ],
      },
    ],
  };
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("--version")) { console.log("9.9.9"); process.exit(0); }
let input = "";
process.stdin.on("data", (b) => (input += b));
process.stdin.on("end", () => {
  const review = input.startsWith("This repository's recent pull requests");
  const past = input.startsWith("Past Claude Code sessions in this repository");
  fs.writeFileSync(${JSON.stringify(log)} + (review ? "/reviews.txt" : past ? "/sessions.txt" : "/other.txt"), input);
  if (past && ${JSON.stringify(sessions === "fail")}) { console.log(JSON.stringify({ is_error: true, result: "API Error: overloaded" })); process.exit(1); }
  const requiredModel = ${JSON.stringify(requiredModel)};
  if (requiredModel && process.argv[process.argv.indexOf("--model") + 1] !== requiredModel) {
    console.log(JSON.stringify({ is_error: true, result: "Unavailable model" }));
    process.exit(1);
  }
  const answer = review ? ${JSON.stringify(reviews)} : past ? { findings: ${JSON.stringify(sessions === "fail" ? [] : sessions)} } : { findings: [] };
  if (process.argv.includes("stream-json")) {
    // As Claude Code streams it: the answer's JSON in pieces, then the result.
    const json = JSON.stringify(answer);
    for (let i = 0; i < json.length; i += 40) console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 40) } } }));
    // The answer is written; the run ends a little later, as a real one does.
    setTimeout(() => console.log(JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.01, structured_output: answer })), 1500);
    return;
  }
  console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.01, structured_output: answer }));
});
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)} + "/gh.txt", args.slice(0, 2).join(" ") + "\\n");
if (args[0] === "auth" && args[1] === "token") process.exit(0);
if (args[0] === "api" && args[1] === "graphql" && args.includes("owner={owner}")) { console.log(${JSON.stringify(JSON.stringify(GITHUB))}); process.exit(0); }
process.exit(1);
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}

/** A stand-in Trail that takes the handoff and its progress, keeping every body. */
async function standInTrail(features: string[] = []): Promise<{ url: string; progress: () => Array<Record<string, unknown>>; close: () => void }> {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
      const reply = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.url === "/api/cli/handoffs") return reply(201, { url: "http://127.0.0.1/connect?state=s", ...(features.length ? { features } : {}) });
      if (req.url === "/api/cli/handoffs/progress") return reply(202, {});
      return reply(410, { error: "gone" });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    progress: () => bodies.filter((b) => b.path === "/api/cli/handoffs/progress").map((b) => b.body),
    close: () => server.close(),
  };
}

/** `trail init` as Claude Code runs it: CLAUDECODE set, no TTY. */
async function agentInit(repo: string, home: string, bin: string, args: string[], model?: string): Promise<{ code: number | null; err: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!AGENT_VARS.test(k)) env[k] = v;
  delete env.TRAIL_INIT_MODEL;
  if (model !== undefined) env.TRAIL_INIT_MODEL = model;
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "init", repo, "--no-build", "--agents", "auto", ...args], {
    env: { ...env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), TRAIL_INVOKED_AS: "trail", DO_NOT_TRACK: "1", GRAFT_MCP_NPX: "1", GIT_TERMINAL_PROMPT: "0", CLAUDECODE: "1", PATH: `${bin}${delimiter}${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise<number | null>((ok) => child.on("close", ok));
  return { code, err };
}

/** A PATH with node (the stand-ins' shebang) and git, and nothing else from this machine: no `trail`, whatever it has installed. */
function gitOnly(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-only-"));
  const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  symlinkSync(git, join(dir, "git"));
  symlinkSync(process.execPath, join(dir, "node"));
  return dir;
}

type Found = { kind: string; title: string; path: string };
type PhaseRow = { id: string; status: string; count: string };

// The stand-ins are shebang scripts, which Windows won't run as `claude` or `gh`.
test("an agent's init --pair reads the merged PRs' reviews and hands what reviewers flagged to Trail's page", { skip: process.platform === "win32" }, async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("pair-reviews-home");
    mkdirSync(join(home, ".claude"));
    const repo = githubRepo();
    const { bin, log } = fakeTools();
    const r = await agentInit(repo, home, bin, ["--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url]);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(log, "reviews.txt")), `claude was asked about the reviews\n${r.err}`);

    const progress = trail.progress();
    const found = progress.flatMap((p) => (p.found as Found[] | undefined) ?? []);
    assert.deepEqual(found.filter((f) => f.kind === "decision").map((f) => f.title), ["API handlers report database failures instead of hiding them"], JSON.stringify(progress));
    const prs = progress.map((p) => (p.phases as PhaseRow[] | undefined)?.find((ph) => ph.id === "prs")).filter(Boolean).at(-1);
    assert.equal(prs?.status, "done");
    assert.equal(prs?.count, "4 PRs", "the merged PRs it read");
    assert.equal(readdirSync(join(repo, ".trail", "learnings")).filter((f) => f.endsWith(".md")).length, 1, "saved in the repo, for the person to keep or drop on the page");
  } finally {
    trail.close();
  }
});

test("a Trail that takes live learnings gets each one while init reads, then the final list in its place", { skip: process.platform === "win32" }, async () => {
  const trail = await standInTrail(["live_found"]);
  try {
    const home = tmpRepo("pair-live-home");
    mkdirSync(join(home, ".claude"));
    const repo = githubRepo();
    const { bin } = fakeTools();
    const r = await agentInit(repo, home, bin, ["--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url]);
    assert.equal(r.code, 0, r.err);
    const progress = trail.progress();
    const replaced = progress.findIndex((p) => p.replaceFound === true);
    assert.ok(replaced >= 0, `the final list replaces what was shown live\n${JSON.stringify(progress)}`);
    const live = progress.slice(0, replaced).flatMap((p) => (p.found as Found[] | undefined) ?? []);
    assert.deepEqual(live.map((f) => f.title), ["API handlers report database failures instead of hiding them"], "shown while reading");
    assert.equal(live[0]!.kind, "decision");
    assert.ok(progress.slice(0, replaced).every((p) => p.done === undefined), "before the read was done");
    const final = progress.slice(replaced).flatMap((p) => (p.found as Found[] | undefined) ?? []);
    assert.deepEqual(final.filter((f) => f.kind === "decision").map((f) => f.title), ["API handlers report database failures instead of hiding them"]);
    assert.notEqual(final[0]!.path, live[0]!.path, "the kept list has the learning's own file");
  } finally {
    trail.close();
  }
});

test("a Trail that doesn't say it takes live learnings gets only the final list, as before", { skip: process.platform === "win32" }, async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("pair-nolive-home");
    mkdirSync(join(home, ".claude"));
    const repo = githubRepo();
    const { bin } = fakeTools();
    const r = await agentInit(repo, home, bin, ["--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url]);
    assert.equal(r.code, 0, r.err);
    const progress = trail.progress();
    assert.ok(progress.every((p) => p.replaceFound === undefined));
    const found = progress.flatMap((p) => (p.found as Found[] | undefined) ?? []);
    assert.equal(found.length, 1, JSON.stringify(progress));
  } finally {
    trail.close();
  }
});

test("without --pair an agent's init still asks neither gh nor claude", { skip: process.platform === "win32" }, async () => {
  const home = tmpRepo("pair-reviews-nopair-home");
  mkdirSync(join(home, ".claude"));
  const repo = githubRepo();
  const { bin, log } = fakeTools();
  const r = await agentInit(repo, home, bin, []);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readdirSync(log), [], "neither gh nor claude ran");
});

// Trail's setup prompt is a request for Trail, whatever name ran it: an agent whose `npm install` of
// @trailhq/trail-code failed swaps in the `graft` it already has, and an old shim loads dist/cli.js with no name.
for (const [how, entry] of [["graft", join("src", "bin", "graft.ts")], ["no name (an old shim)", join("src", "cli.ts")]] as const) {
  test(`init --pair started as ${how} still sets up Trail: .trail/ in the repo, and the page told it read the PRs`, { skip: process.platform === "win32" }, async () => {
    const trail = await standInTrail();
    try {
      const home = tmpRepo("pair-graft-home");
      mkdirSync(join(home, ".claude"));
      const repo = githubRepo();
      const { bin } = fakeTools();
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (!AGENT_VARS.test(k) && k !== "TRAIL_INVOKED_AS") env[k] = v;
      const child = spawn(process.execPath, ["--import", "tsx", entry, "init", repo, "--no-build", "--agents", "claude", "--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url], {
        env: { ...env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), DO_NOT_TRACK: "1", GRAFT_MCP_NPX: "1", GIT_TERMINAL_PROMPT: "0", CLAUDECODE: "1", PATH: `${bin}${delimiter}${gitOnly()}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      const code = await new Promise<number | null>((ok) => child.on("close", ok));
      assert.equal(code, 0, err);
      assert.ok(existsSync(join(repo, ".trail", "hook.cjs")), `wired as Trail\n${err}`);
      const found = trail.progress().flatMap((p) => (p.found as Found[] | undefined) ?? []);
      assert.deepEqual(found.filter((f) => f.kind === "decision").map((f) => f.title), ["API handlers report database failures instead of hiding them"], err);
      // This machine has no `trail` command (PATH holds only the stand-ins and git): say how to get it.
      assert.match(err, /the trail command isn't installed here · npm install -g @trailhq\/trail-code/);
    } finally {
      trail.close();
    }
  });
}

/* ---- Both reads together: past sessions and the PRs ---- */

/** One past session in `repo`, today, where the person corrected Claude. */
function pastSession(repo: string, home: string): void {
  const dir = join(home, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const row = (o: object) => JSON.stringify({ cwd: repo, timestamp: at, sessionId: "abcdef12-3456", ...o });
  writeFileSync(
    join(dir, "abcdef12-3456.jsonl"),
    [
      row({ type: "user", message: { role: "user", content: "make the orders endpoint faster with a cache" } }),
      row({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I can add an in-memory cache in front of db.query for the orders list." }] } }),
      row({ type: "user", message: { role: "user", content: "no, we tried caching orders last month and it served stale totals, keep reading from the database" } }),
    ].join("\n") + "\n",
  );
}

const fromSessions = {
  headline: "Orders are read fresh from the database, not cached",
  why: "A cache was tried and served stale totals.",
  for_agent: "src/api/orders.ts reads with db.query on every request.",
  kind: "ruled_out",
  evidence: [{ source: "session abcdef12", quote: "we tried caching orders last month and it served stale totals" }],
};

const titlesIn = (repo: string) =>
  readdirSync(join(repo, ".trail", "learnings"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(repo, ".trail", "learnings", f), "utf8").match(/^title: "?(.*?)"?$/m)?.[1] ?? "")
    .sort();

test("init --pair reads past sessions and the PRs together: both learnings saved with plain titles, each said as it lands", { skip: process.platform === "win32" }, async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("both-reads-home");
    mkdirSync(join(home, ".claude"));
    const repo = githubRepo();
    pastSession(repo, home);
    const { bin, log } = fakeTools([fromSessions]);
    const r = await agentInit(repo, home, bin, ["--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url]);
    assert.equal(r.code, 0, r.err);
    const sent = readFileSync(join(log, "sessions.txt"), "utf8");
    assert.match(sent, /\[person\] no, we tried caching orders last month/);
    assert.match(sent, /\[claude\] I can add an in-memory cache/, "Claude's side is read too");
    assert.deepEqual(titlesIn(repo), ["API handlers report database failures instead of hiding them", "Orders are read fresh from the database, not cached"]);
    // Each learning said the moment its read checked it.
    assert.match(r.err, /· found "Orders are read fresh from the database, not cached" in your past sessions/);
    assert.match(r.err, /· found "API handlers report database failures instead of hiding them" in pull requests/);
    assert.doesNotMatch(r.err, /in pull requests\n[\s\S]*still reading pull requests/, "no 'still reading' after it already showed one");
    assert.doesNotMatch(r.err, /in your past sessions\n[\s\S]*still reading your past sessions/);
    assert.doesNotMatch(r.err, /nothing to keep from your past sessions/, "no line saying nothing was found beside what was");
    const decisions = trail.progress().map((p) => (p.phases as PhaseRow[] | undefined)?.find((ph) => ph.id === "decisions")).filter(Boolean).at(-1);
    assert.equal(decisions?.count, "1 learning", "the page counts what the session read found");
    const saved = readFileSync(join(repo, ".trail", "learnings", readdirSync(join(repo, ".trail", "learnings")).find((f) => f.includes("orders-are-read"))!), "utf8");
    assert.match(saved, /## Tried and ruled out\n- A cache was tried and served stale totals\.\n- In the code: src\/api\/orders\.ts reads with db\.query on every request\./);
    assert.match(saved, /src: init-sessions/);

    // Again: both reads are marked done for this repo, so Claude isn't asked twice.
    rmSync(log, { recursive: true });
    mkdirSync(log);
    const again = await agentInit(repo, home, bin, ["--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url]);
    assert.equal(again.code, 0, again.err);
    assert.ok(!existsSync(join(log, "sessions.txt")) && !existsSync(join(log, "reviews.txt")), "nothing read twice");
  } finally {
    trail.close();
  }
});

test("TRAIL_INIT_MODEL selects the Claude model for both day-one imports", { skip: process.platform === "win32" }, async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("init-model-home");
    const repo = githubRepo();
    pastSession(repo, home);
    const { bin } = fakeTools([fromSessions], "sonnet");
    const r = await agentInit(repo, home, bin, ["--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url], " sonnet ");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /found "Orders are read fresh from the database, not cached"/);
    assert.match(r.err, /found "API handlers report database failures instead of hiding them"/);
    assert.equal(titlesIn(repo).length, 2);
  } finally {
    trail.close();
  }
});

test("the same learning from past sessions and the PRs is saved once, as the PR one", { skip: process.platform === "win32" }, async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("same-twice-home");
    mkdirSync(join(home, ".claude"));
    const repo = githubRepo();
    pastSession(repo, home);
    const twin = { ...fromSessions, headline: "API handlers report database failures, never hiding them", evidence: [{ source: "abcdef12", quote: "keep reading from the database" }] };
    const { bin } = fakeTools([twin]);
    const r = await agentInit(repo, home, bin, ["--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(titlesIn(repo), ["API handlers report database failures instead of hiding them"]);
  } finally {
    trail.close();
  }
});

test("a session read Claude couldn't finish says why, and the page says skipped, not 0 learnings", { skip: process.platform === "win32" }, async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("sess-fail-home");
    mkdirSync(join(home, ".claude"));
    const repo = githubRepo();
    pastSession(repo, home);
    const { bin } = fakeTools("fail");
    const r = await agentInit(repo, home, bin, ["--pair", "X4GM5OQU4NIA65ZR", "--server", trail.url]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /so trail couldn't read your past sessions\. To try again: trail init --look-back/);
    const decisions = trail.progress().map((p) => (p.phases as PhaseRow[] | undefined)?.find((ph) => ph.id === "decisions")).filter(Boolean).at(-1);
    assert.equal(decisions?.count, "skipped");
  } finally {
    trail.close();
  }
});
