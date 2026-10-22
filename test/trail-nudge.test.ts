/**
 * Connecting a workspace, offered by the agent: once a person has a learning,
 * `trail ask`, `trail note` and `trail check` hand the agent a link to end its
 * reply with, at most once a session and in wording that changes from one
 * session to the next. A background wait registers the link with Trail, picks
 * up the sign-in, uploads the picked repos' learnings, and the next command
 * says so once. Connected, a repo outside the workspace gets one question.
 * All of it is off unless TRAIL_CLOUD=1, or the machine is already connected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { rememberRepo } from "../src/notes/home.js";
import { writeNote } from "../src/notes/notes.js";
import { cloudLines, NUDGE_WORDS, waitForConnect } from "../src/cloud/nudge.js";
import { readCloud, writeCloud, type Cloud } from "../src/cloud/workspace.js";
import { tmpRepo } from "./helpers.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_URL = "http://trail.test";
process.env.TRAIL_NO_FETCH = "1";
process.env.TRAIL_CLOUD = "1";

/** A fresh ~/.trail for each test, so links, sessions and connections never leak between them. */
function freshHome(): NodeJS.ProcessEnv {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "nudge-trail-home-"));
  return process.env;
}

function git(d: string, args: string[]) {
  spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: d });
}

let n = 0;
/** A GitHub-backed repo, with a learning in its .trail/ unless `learnings` is false. */
function repo(learnings = true): { dir: string; key: string } {
  const dir = tmpRepo("nudge");
  const name = `acme/extract-${++n}`;
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Priya Raman"]);
  git(dir, ["remote", "add", "origin", `https://github.com/${name}.git`]);
  if (learnings) writeNote(dir, { title: "Retries trip the rate limit", body: "## Decided\nThree retries.", author: "Priya", date: "2026-10-07", touches: [] });
  else rememberRepo(dir);
  return { dir, key: `github.com/${name}` };
}

const noWait = () => {};

function lines(d: string, command: "ask" | "note" | "check", session: string, opts: { agent?: boolean; now?: number } = {}) {
  return cloudLines(d, { command, agent: opts.agent ?? true, env: { ...process.env, CLAUDE_CODE_SESSION_ID: session }, now: opts.now, startWait: noWait });
}

function stateOf(): { pending?: { state: string } } {
  return JSON.parse(readFileSync(join(process.env.TRAIL_HOME!, "cloud-nudge.json"), "utf8"));
}

test("with signing in off, nobody is offered a link, learnings or not", () => {
  freshHome();
  const { dir } = repo();
  const off = cloudLines(dir, { command: "ask", agent: true, env: { ...process.env, TRAIL_CLOUD: undefined, CLAUDE_CODE_SESSION_ID: "s1" }, startWait: noWait });
  assert.deepEqual(off, []);
});

test("no learning yet: nobody is asked to sign in", () => {
  freshHome();
  assert.deepEqual(lines(repo(false).dir, "ask", "s1"), []);
});

test("a repo with no remote is never offered a workspace", () => {
  freshHome();
  const d = tmpRepo("nudge-local");
  git(d, ["init", "-q"]);
  writeNote(d, { title: "x", body: "## Decided\ny", author: "Priya", date: "2026-10-07" });
  assert.deepEqual(lines(d, "ask", "s1"), []);
});

test("once a session, a connect link the agent ends its reply with, in wording that changes per session", () => {
  freshHome();
  const { dir } = repo();
  const first = lines(dir, "ask", "s1");
  assert.match(first[0]!, /^\[trail\] End your reply with this line, word for word: \[Share your learnings with your team\?\]\(http:\/\/trail\.test\/connect\?state=[\w-]{32}\)$/);
  assert.match(first[1]!, /don't run trail login yourself/);
  assert.deepEqual(lines(dir, "note", "s1"), [], "not twice in one session");
  const second = lines(dir, "check", "s2");
  assert.ok(second[0]!.includes(NUDGE_WORDS[1]), "the next session reads differently");
  assert.ok(second[0]!.includes(stateOf().pending!.state), "the same link, while it's good");
});

test("at a terminal it's one plain line", () => {
  freshHome();
  const { dir } = repo();
  const out = lines(dir, "ask", "s1", { agent: false });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /^· Share your learnings with your team\? http:\/\/trail\.test\/connect\?state=/);
});

/** A Trail that answers the handoff routes from memory, and records what it was sent. */
function fakeTrail(opts: { finishAfter?: number; expire?: boolean } = {}) {
  const sent: Array<{ path: string; body: any; auth?: string }> = [];
  let claims = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ path, body, auth: (init.headers as Record<string, string>)?.authorization });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/cli/handoffs") return json(201, { url: `http://trail.test/connect?state=${body.state}` });
    if (path === "/api/cli/handoffs/claim") {
      if (opts.expire) return json(410, { error: "expired" });
      if (++claims < (opts.finishAfter ?? 1)) return json(202, { pending: true });
      return json(200, {
        token: "trl_test",
        user: { name: "Priya", email: "priya@acme.test" },
        workspace: { id: "w1", name: "Acme", slug: "acme", url: "http://trail.test/w/acme", invite_url: "http://trail.test/join/abc" },
        repos: sent.find((s) => s.path === "/api/cli/handoffs")!.body.repo ? [sent.find((s) => s.path === "/api/cli/handoffs")!.body.repo.key] : [],
      });
    }
    if (path === "/api/cli/learnings") return json(200, { repo: body.repo.key, learnings: body.learnings.length, added: body.learnings.length });
    if (path === "/api/cli/activity") return json(200, { stored: body.events.length });
    return json(404, { error: "no route" });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

test("the background wait registers the link with the picker's repos, then connects and uploads the picked repo's learnings", async () => {
  freshHome();
  const { dir, key } = repo();
  const other = repo(false);
  lines(dir, "ask", "s1");
  const trail = fakeTrail({ finishAfter: 2 });
  const got = await waitForConnect({ fetchImpl: trail.fetchImpl, sleep: async () => {} });
  assert.ok(got && "cloud" in got);

  const reg = trail.sent.find((s) => s.path === "/api/cli/handoffs")!.body;
  assert.equal(reg.state, stateOf().pending?.state ?? reg.state);
  assert.deepEqual(reg.repo, { key, name: key.replace("github.com/", "") });
  assert.deepEqual(new Set(reg.repos.map((r: any) => r.key)), new Set([key, other.key]), "every repo trail knows here, for the picker");
  assert.equal(reg.repos.find((r: any) => r.key === key).learnings, 1);
  assert.equal(reg.author, "Priya");

  const cloud = readCloud()!;
  assert.equal(cloud.token, "trl_test");
  assert.equal(cloud.workspace.name, "Acme");
  assert.deepEqual(cloud.repos, [key]);
  const up = trail.sent.find((s) => s.path === "/api/cli/learnings")!;
  assert.equal(up.auth, "Bearer trl_test");
  assert.equal(up.body.repo.key, key);
  assert.equal(up.body.learnings.length, 1);
  assert.match(up.body.learnings[0].path, /^\.trail\/learnings\/2026-10-07-retries-trip-the-rate-limit-priya\.md$/);
  assert.equal(up.body.learnings[0].ref, "");

  // The next command says so, once, and asks the agent to tell the person.
  const told = lines(dir, "ask", "s2");
  assert.equal(told[0], "✓ connected to workspace Acme");
  assert.match(told[1]!, /^✓ shared 1 learning from 1 repo · http:\/\/trail\.test\/w\/acme$/);
  assert.match(told[2]!, /Tell the user once/);
  assert.deepEqual(lines(dir, "ask", "s3"), [], "only once");
});

test("connecting sends nothing queued before it, whatever its timestamp", async () => {
  freshHome();
  const { dir, key } = repo();
  lines(dir, "ask", "s1");
  // What an older trail left: a search from before anyone signed in, in this repo and another.
  const at = new Date(Date.now() + 60_000).toISOString();
  const old = (repo: string) => JSON.stringify({ repo, kind: "search", asker: "Priya", session: "s0", query: "rate limit", files: ["a.go"], shown_paths: ["x.md"], shown_authors: ["Priya"], at });
  const outbox = join(process.env.TRAIL_HOME!, "outbox.jsonl");
  writeFileSync(outbox, `${old(key)}\n${old("github.com/acme/private")}\n`);
  const trail = fakeTrail();
  const got = await waitForConnect({ fetchImpl: trail.fetchImpl, sleep: async () => {} });
  assert.ok(got && "cloud" in got);
  assert.equal(trail.sent.filter((s) => s.path === "/api/cli/activity").length, 0, "no activity sent");
  assert.equal(existsSync(outbox), false, "and none kept to send later");
  rmSync(join(process.env.TRAIL_HOME!, "cloud.json"));
});

test("a spent link stops the wait and is forgotten, so the next session mints a new one", async () => {
  freshHome();
  const { dir } = repo();
  lines(dir, "ask", "s1");
  const before = stateOf().pending!.state;
  const got = await waitForConnect({ fetchImpl: fakeTrail({ expire: true }).fetchImpl, sleep: async () => {} });
  assert.ok(got && "error" in got && got.reason === "expired");
  assert.equal(readCloud(), null);
  const next = lines(dir, "ask", "s2");
  assert.ok(next.length > 0);
  assert.ok(!next[0]!.includes(before), "a new link");
});

function connect(repos: string[]): void {
  const c: Cloud = {
    url: "http://trail.test",
    token: "trl_test",
    user: { name: "Priya", email: "priya@acme.test" },
    workspace: { id: "w1", name: "Acme", slug: "acme", url: "http://trail.test/w/acme", invite_url: "http://trail.test/join/abc" },
    repos,
    linkedAt: Date.now(),
  };
  writeCloud(c);
}

test("connected: a repo with learnings outside the workspace gets one question, ever", () => {
  freshHome();
  const inside = repo();
  const outside = repo();
  connect([inside.key]);
  assert.deepEqual(lines(inside.dir, "ask", "s1"), [], "nothing to say about a repo already in it");
  const asked = lines(outside.dir, "ask", "s1");
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /^\[trail\] Ask the user once, at the end of your reply: add acme\/extract-\d+ to their Trail workspace Acme/);
  assert.match(asked[0]!, /run `trail workspace add`/);
  assert.deepEqual(lines(outside.dir, "ask", "s2"), [], "never again");
  rmSync(join(process.env.TRAIL_HOME!, "cloud.json"));
});
