/**
 * `trail share-session`: a Trail teammate sends one of their Claude Code
 * sessions to the Trail team, whole, with secrets taken out on the laptop,
 * and only after a yes. Anyone outside the Trail team's workspace gets one
 * line and nothing is read or sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { BRAND_ENV } from "../src/brand.js";
import { anonymize, bundleSession, pickSession, previewLines, redactedCount, sessionsHere, whoIAm, type SessionFile } from "../src/cloud/share-session.js";
import { deleteSharedBundle, shareAllowed, shareSession, type Cloud } from "../src/cloud/workspace.js";
import { claudeProjectDir } from "../src/notes/session-cost.js";
import { secretReason } from "../src/notes/secrets.js";
import { REDACTED, redactText } from "../src/trace/redact.js";
import { EVENTS, sessionMessagesBucket, sessionSizeBucket, VALUES } from "../src/telemetry/contract.js";

const require = createRequire(import.meta.url);

// Built in pieces so no scanner reads a real-looking key in this file.
const OPENAI = "sk-" + "proj-" + "Q7x2Lm9Pz4Rt8Vb1Nc6Kw3Hy5Jd0Fs";
const GH = "ghp_" + "Zx81Qw72Er63Ty54Ui45Op36As27Df18";
const AWS = "AKIA" + "Z7Q2" + "X9W4" + "V6B3" + "N8M1";
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA1x2y3z", "q9w8e7r6t5y4u3i2o1p0", "-----END RSA PRIVATE KEY-----"].join("\n");

test("redactText: a text with no secret comes back as it was", () => {
  const text = "ran npm test · 412 passed\nsession 984257d6-89cc-4c7c-b05b-6a6e8749f9e0 at src/cloud/workspace.ts:263, sha 4f09cfdb2084ccef";
  assert.deepEqual(redactText(text), { text, found: [] });
});

test("redactText: keys go and what's around them stays: a name keeps its NAME=, a link its host, a header its Bearer", () => {
  const cases: Array<[string, RegExp]> = [
    [`export OPENAI_API_KEY=${OPENAI}`, /^export OPENAI_API_KEY=\[redacted\]$/],
    [`git clone https://${GH}@github.com/acme/web`, /\[redacted\]/],
    [`curl -H "Authorization: Bearer ${OPENAI.slice(3)}" https://api.acme.test`, /Authorization: Bearer \[redacted\]" https:\/\/api\.acme\.test$/],
    [`DATABASE_URL=postgres://app:s3cretPassw0rd@db.internal:5432/app`, /^DATABASE_URL=\[redacted\]$|postgres:\/\/app:\[redacted\]@db\.internal/],
    [`{"password": "hunter2hunter2", "user": "maya"}`, /"password": "\[redacted\]", "user": "maya"/],
    [`aws configure set aws_access_key_id ${AWS}`, /aws_access_key_id \[redacted\]$/],
  ];
  for (const [input, want] of cases) {
    const got = redactText(input);
    assert.match(got.text, want, input);
    assert.equal(secretReason(got.text), null, `nothing secret is left in ${got.text}`);
    assert.ok(got.found.length >= 1, `${input} counts what it took out`);
    for (const r of got.found) assert.doesNotMatch(r.kind, /hunter|sk-|ghp_|AKIA/, "a kind names the secret's kind, never the secret");
  }
});

test("redactText: a private key goes whole, BEGIN to END, and the lines around it stay", () => {
  const got = redactText(`before\n${PEM}\nafter`);
  assert.equal(got.text, `before\n${REDACTED} private key\nafter`);
  assert.deepEqual(got.found.map((r) => r.kind), ["a private key"]);
});

test("redactText: only the line with the secret changes", () => {
  const got = redactText(`line one\nTOKEN=${GH}\nline three`);
  assert.equal(got.text, "line one\nTOKEN=[redacted]\nline three");
});

test("anonymize: a distinctive name goes wherever it stands, glued to an escape, a URL-encoded slash or a longer word; a short one only as its own word", () => {
  const who = ["/Users/maya.okafor", "mayaokafor", "okafor", "maya"];
  const got = anonymize("cd /Users/maya.okafor/src\\nokafor said hi; see github.com%2Fmayaokafor-acme and okafors-branch. maya and mayans and Okafor, mail maya@acme.test", who);
  assert.equal(got.text, "cd ~/src\\n[you] said hi; see github.com%2F[you]-acme and [you]s-branch. [you] and mayans and [you], mail [email]");
  assert.equal(got.n, 7);
});

test("whoIAm: a machine login like runner or ubuntu names nobody, so it isn't hidden", () => {
  assert.ok(!whoIAm(["runner", "ubuntu", "Maya Okafor"]).some((w) => ["runner", "ubuntu"].includes(w)));
  assert.ok(whoIAm(["Maya Okafor"]).includes("Maya Okafor"));
});

/** A Claude Code project folder with one session in it, under a scratch home. */
function fakeSession(): { home: string; repo: string; id: string } {
  const home = mkdtempSync(join(tmpdir(), "share-home-"));
  // Real: macOS temp folders are a symlink, and Claude Code names the folder after the real cwd.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "share-repo-")));
  const id = "5a1e0c2d-1111-4222-8333-944455556666";
  const folder = claudeProjectDir(repo, home);
  mkdirSync(join(folder, id, "subagents"), { recursive: true });
  mkdirSync(join(folder, id, "tool-results"), { recursive: true });
  // Inside the session, a fixed folder: a temp folder's random name (`/tmp/…-wRSnEe/…-aB3cD9`) can look like a key and change the counts.
  const cwd = "/work/web";
  const at = (m: number) => `2026-10-29T10:${String(m).padStart(2, "0")}:00.000Z`;
  const lines = [
    { type: "user", timestamp: at(0), sessionId: id, cwd, message: { role: "user", content: "<system-reminder>\nctx\n</system-reminder>\n\n\nwhy does the stop hook skip my corrections?" } },
    { type: "assistant", timestamp: at(1), message: { id: "msg_01", role: "assistant", content: [{ type: "thinking", thinking: "look at note-signals", signature: "EpYBCkYIBhgCKkB" + "x".repeat(300) }] } },
    { type: "assistant", timestamp: at(1), message: { id: "msg_01", role: "assistant", content: [{ type: "tool_use", id: "toolu_env", name: "Read", input: { file_path: `${cwd}/.env.local` } }] } },
    { type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_env", content: "     1→DB_HOST=prod.db.internal\n     2→STRIPE_KEY=whatever-it-is\n     3→# a comment\n     4→EMPTY=" }] }, toolUseResult: { file: { content: "DB_HOST=prod.db.internal\nSTRIPE_KEY=whatever-it-is" } } },
    { type: "assistant", timestamp: at(3), message: { id: "msg_02", role: "assistant", content: [{ type: "text", text: `Your key ${OPENAI} is in the log; rotate it.` }] } },
    { type: "user", timestamp: at(4), message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo" + "A".repeat(2000) } }, { type: "text", text: "here's the screen" }] } },
    { type: "custom-title", customTitle: "Stop hook misses Desktop corrections", sessionId: id },
  ];
  writeFileSync(join(folder, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const sub = { type: "user", isSidechain: true, agentId: "a1", sessionId: id, timestamp: at(5), message: { role: "user", content: "map the hook files" } };
  writeFileSync(join(folder, id, "subagents", "agent-a1.jsonl"), JSON.stringify(sub) + "\n");
  writeFileSync(join(folder, id, "tool-results", "big.txt"), `long output\nGITHUB_TOKEN=${GH}\n`);
  writeFileSync(join(folder, id, "tool-results", "shot.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  // An older session, written first.
  writeFileSync(join(folder, "0ld0ld00-0000-4000-8000-000000000000.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "old" } }) + "\n");
  utimesSync(join(folder, "0ld0ld00-0000-4000-8000-000000000000.jsonl"), new Date("2026-10-01"), new Date("2026-10-01"));
  return { home, repo, id };
}

test("bundleSession: every line of the session and its subagents goes, secrets and .env values out, images left out", () => {
  const { home, repo, id } = fakeSession();
  const sessions = sessionsHere(repo, home);
  assert.equal(sessions[0]!.id, id, "newest first");
  const b = bundleSession(sessions[0]!);
  const text = gunzipSync(b.gz).toString("utf8");
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));

  assert.equal(b.title, "Stop hook misses Desktop corrections");
  assert.equal(b.subagents, 1);
  assert.equal(b.messages, 6, "two lines of one reply (msg_01) count once; the subagent's message counts");
  assert.equal(b.leftOut, 2, "the pasted screenshot and the jpg in tool-results");
  assert.equal(b.bytes, Buffer.byteLength(text));
  assert.equal(lines.length, 7 + 1 + 1, "7 session lines, 1 subagent line, 1 text tool-result file");

  assert.equal(secretReason(text), null, "nothing secret-shaped is left anywhere in what goes");
  assert.match(text, /DB_HOST=\[redacted\]/, "a .env value goes even when it doesn't look secret");
  assert.match(text, /STRIPE_KEY=\[redacted\]/);
  assert.match(text, /# a comment/);
  assert.deepEqual(b.redacted, { "a .env value": 2, "an API key": 2 }, "each secret once, though Claude keeps a tool's output twice");
  assert.equal(redactedCount(b), 4);
  assert.match(text, /why does the stop hook skip my corrections\?/, "what the person typed goes in full");
  assert.match(text, /"thinking":"look at note-signals","signature":"\[left out\]"/, "the thinking goes; its signature, Anthropic's opaque bytes, doesn't");
  assert.match(text, /\[left out: image or file bytes\]/);
  const file = lines.find((l) => l.type === "trail-share-file");
  assert.equal(file.path, "tool-results/big.txt");
  assert.match(file.content, /GITHUB_TOKEN=\[redacted\]/);
  assert.equal(lines.find((l) => l.agentId === "a1")?.message.content, "map the hook files");
});

test("a .env file counts as read only when a command reads it, not when its name is in a script's text", () => {
  const { home, repo } = fakeSession();
  const folder = claudeProjectDir(repo, home);
  const id = "7b2e0c2d-1111-4222-8333-944455556666";
  const call = (n: number, command: string) => [
    { type: "assistant", message: { id: `msg_${n}`, role: "assistant", content: [{ type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: "PORT=8787\nREGION=us-west-2" }] } },
  ];
  const lines = [
    ...call(1, "set -a && source .env && npm run dev"),
    ...call(2, "cat .env.example"),
    ...call(3, "python3 - <<'EOF'\nprint('a .env value')\nEOF"),
    ...call(4, "docker compose --env-file ./deploy/prod.env config"),
  ];
  writeFileSync(join(folder, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const b = bundleSession(sessionsHere(repo, home).find((s) => s.id === id)!);
  const out = gunzipSync(b.gz).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const result = (n: number) => out.find((l) => l.message?.content?.[0]?.tool_use_id === `toolu_${n}`).message.content[0].content;
  assert.equal(result(1), "PORT=[redacted]\nREGION=[redacted]");
  assert.equal(result(2), "PORT=8787\nREGION=us-west-2", "a template holds no values");
  assert.equal(result(3), "PORT=8787\nREGION=us-west-2", "a script that only says .env reads nothing");
  assert.equal(result(4), "PORT=[redacted]\nREGION=[redacted]");
});

test("pickSession: by number in the list, by id or its start; an unknown or ambiguous one is null", () => {
  const s = (id: string): SessionFile => ({ id, path: `/x/${id}.jsonl`, mtime: 0, size: 1 });
  const list = [s("aaaa1111"), s("aaaa2222"), s("bbbb3333")];
  assert.equal(pickSession(list, undefined)!.id, "aaaa1111");
  assert.equal(pickSession(list, "3")!.id, "bbbb3333");
  assert.equal(pickSession(list, "bbbb")!.id, "bbbb3333");
  assert.equal(pickSession(list, "aaaa"), null, "two start with it");
  assert.equal(pickSession(list, "9"), null);
});

test("previewLines: says what goes, how big, how many secrets came out and where it goes", () => {
  const { home, repo } = fakeSession();
  const b = bundleSession(sessionsHere(repo, home)[0]!);
  const out = previewLines(b, { workspace: "Trail - Brand", url: "https://team.trailhq.com" }, Date.parse("2026-10-29T18:00:00Z")).join("\n");
  assert.match(out, /^Session {3}Stop hook misses Desktop corrections$/m);
  assert.match(out, /5a1e0c2d · .* · 6 messages · 1 subagent$/m);
  assert.match(out, /^Secrets {3}4 redacted: \.env value ×2, API key ×2$/m);
  assert.match(out, /^Left out  2 images/m);
  assert.match(out, /^You {7}nothing that names you found$/m);
  assert.match(out, /^Goes to   Trail - Brand on team\.trailhq\.com, read only by the Trail team, without your name$/m);
});

const CLOUD: Cloud = {
  url: "http://trail.test",
  token: "trl_test",
  user: { name: "", email: "" },
  workspace: { id: "w1", name: "Trail - Brand", slug: "trail-brand", url: "", invite_url: "" },
  repos: [],
  linkedAt: 1,
};

function answering(status: number, body: object) {
  const sent: Array<{ url: string; method?: string; auth?: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method, auth: (init.headers as Record<string, string>).authorization, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

test("shareAllowed: Trail decides; a workspace it refuses is a no, and a Trail without the route says so", async () => {
  const yes = answering(200, { ok: true });
  assert.equal(await shareAllowed(CLOUD, yes.fetchImpl), true);
  assert.equal(yes.sent[0]!.url, "http://trail.test/api/cli/shared-sessions/allowed");
  assert.equal(yes.sent[0]!.auth, "Bearer trl_test");
  assert.equal(await shareAllowed(CLOUD, answering(403, { error: "no" }).fetchImpl), false);
  const old = await shareAllowed(CLOUD, answering(404, { error: "not found" }).fetchImpl);
  assert.ok(typeof old === "object" && /doesn't take shared sessions yet/.test(old.error));
  const noBucket = await shareAllowed(CLOUD, answering(503, { error: "no bucket" }).fetchImpl);
  assert.ok(typeof noBucket === "object" && /doesn't take shared sessions yet/.test(noBucket.error));
});

test("shareSession: posts the zipped session and its counts, nothing about the person", async () => {
  const t = answering(201, { id: "u1", gz_bytes: 10 });
  const body = { bundle_id: "4f6c0e2a-1111-4222-8333-944455556666", kind: "session" as const, delete_hash: "ab".repeat(32), session_id: "s1", repo: "github.com/acme/web", trail_version: "0.28.0", title: "t", messages: 3, subagents: 0, bytes: 100, redacted: 1, transcript_gz: "H4sI" };
  assert.deepEqual(await shareSession(CLOUD, body, t.fetchImpl), { id: "u1", gz_bytes: 10 });
  assert.equal(t.sent[0]!.method, "POST");
  assert.equal(t.sent[0]!.url, "http://trail.test/api/cli/shared-sessions");
  assert.deepEqual(Object.keys(t.sent[0]!.body as object).sort(), ["bundle_id", "bytes", "delete_hash", "kind", "messages", "redacted", "repo", "session_id", "subagents", "title", "trail_version", "transcript_gz"]);
});

test("deleteSharedBundle: sends the code to the bundle's own address, and Trail says how many went", async () => {
  const t = answering(200, { deleted: 37 });
  assert.deepEqual(await deleteSharedBundle(CLOUD, "4f6c0e2a-1111-4222-8333-944455556666", "s3cret-part", t.fetchImpl), { deleted: 37 });
  assert.equal(t.sent[0]!.method, "DELETE");
  assert.equal(t.sent[0]!.url, "http://trail.test/api/cli/shared-sessions/bundles/4f6c0e2a-1111-4222-8333-944455556666");
  assert.deepEqual(t.sent[0]!.body, { delete_code: "s3cret-part" });
});

test("session_shared carries only its size and message count, as fixed labels", () => {
  assert.deepEqual([...EVENTS.session_shared!].sort(), ["messages_bucket", "size_bucket"]);
  assert.equal(sessionSizeBucket(3 * 1024 * 1024), "1-5MB");
  assert.equal(sessionMessagesBucket(412), "200-499");
  assert.ok(VALUES.session_shared!.size_bucket!.has(sessionSizeBucket(0)));
  assert.ok(!VALUES.session_shared!.messages_bucket!.has("412"));
});

/* the command, end to end ---------------------------------------------------- */

const CLI = resolve(process.cwd(), "src/cli.ts");
const TSX = pathToFileURL(require.resolve("tsx")).href;

function cliEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), [BRAND_ENV]: "trail", DO_NOT_TRACK: "1", TRAIL_CLOUD: "1", TRAIL_SHARE_SESSION: "1" };
}

/** A stand-in Trail on this machine that allows or refuses, and keeps what it was sent. */
async function standIn(allowed: boolean): Promise<{ url: string; got: Array<{ method: string; path: string; body: string }>; close: () => void; failPostsAfter: number | null }> {
  const got: Array<{ method: string; path: string; body: string }> = [];
  const self = { url: "", got, close: () => {}, failPostsAfter: null as number | null };
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    got.push({ method: req.method!, path: req.url!, body });
    if (req.method === "POST" && self.failPostsAfter !== null && got.filter((g) => g.method === "POST").length > self.failPostsAfter) {
      got.pop();
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "the database is busy" }));
      return;
    }
    if (!allowed) {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "sharing a session is for the Trail team only" }));
      return;
    }
    if (req.url === "/api/cli/shared-sessions/allowed") res.writeHead(200).end(JSON.stringify({ ok: true }));
    else if (req.method === "DELETE") res.writeHead(200).end(JSON.stringify({ deleted: got.filter((g) => g.method === "POST").length }));
    else res.writeHead(201).end(JSON.stringify({ id: "u1", gz_bytes: 1 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  self.url = `http://127.0.0.1:${port}`;
  self.close = () => server.close();
  return self;
}

function signIn(home: string, url: string): void {
  mkdirSync(join(home, ".trail"), { recursive: true });
  writeFileSync(join(home, ".trail", "cloud.json"), JSON.stringify({ ...CLOUD, url }));
}

test("trail share-session: off in this release unless TRAIL_SHARE_SESSION=1, with nothing read or sent; --stop works without it", async () => {
  const { home, repo } = fakeSession();
  const trail = await standIn(true);
  try {
    signIn(home, trail.url);
    const env = { ...cliEnv(home), TRAIL_SHARE_SESSION: "" };
    const off = spawnSync(process.execPath, ["--import", TSX, CLI, "share-session", "--sync"], { cwd: repo, encoding: "utf8", timeout: 60_000, env });
    assert.equal(off.status, 1, off.stderr);
    assert.equal(off.stdout, "");
    assert.equal(off.stderr.trim(), "✗ share-session isn't on in this release yet; to try it, run TRAIL_SHARE_SESSION=1 trail share-session");
    assert.deepEqual(trail.got, [], "not even the check goes out");
    assert.ok(!existsSync(join(home, ".trail", "share")), "nothing is scrubbed or copied");
    const stop = spawnSync(process.execPath, ["--import", TSX, CLI, "share-session", "--stop"], { cwd: repo, encoding: "utf8", timeout: 60_000, env });
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stderr, /nothing to stop/);
  } finally {
    trail.close();
  }
});

test("trail share-session: not signed in, one line and nothing read or sent", () => {
  const { home, repo } = fakeSession();
  const r = spawnSync(process.execPath, ["--import", TSX, CLI, "share-session"], { cwd: repo, encoding: "utf8", timeout: 60_000, env: cliEnv(home) });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim(), "✗ internal only: share-session is for the Trail team, signed in to team.trailhq.com with a trailhq.com or nanonets.com email");
});

test("trail share-session: signed in to another workspace, the same one line, and only the check is sent", async () => {
  const { home, repo } = fakeSession();
  const trail = await standIn(false);
  try {
    signIn(home, trail.url);
    const done = await spawnAsync(repo, home, []);
    assert.equal(done.status, 1, done.stderr);
    assert.match(done.stderr, /^✗ internal only/);
    assert.deepEqual(trail.got.map((g) => g.path), ["/api/cli/shared-sessions/allowed"]);
  } finally {
    trail.close();
  }
});

test("trail share-session <session>: without a terminal it shows what would go and sends nothing; --yes sends it", async () => {
  const { home, repo, id } = fakeSession();
  const trail = await standIn(true);
  try {
    signIn(home, trail.url);
    const shown = await spawnAsync(repo, home, ["1"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^Session {3}Stop hook misses Desktop corrections$/m);
    assert.match(shown.stdout, /nothing sent\. Show the person what's above; only if they say yes, run trail share-session 5a1e0c2d --yes/);
    assert.ok(!trail.got.some((g) => g.method === "POST"), "nothing is posted without a yes");

    const sent = await spawnAsync(repo, home, ["5a1e0c2d", "--yes"]);
    assert.equal(sent.status, 0, sent.stderr);
    assert.match(sent.stderr, /✓ sent 5a1e0c2d to the Trail team/);
    assert.match(sent.stderr, /take it back any time: trail share-session --delete [0-9a-f-]{36}\.[A-Za-z0-9_-]{16,}/);
    const post = trail.got.find((g) => g.method === "POST")!;
    assert.equal(post.path, "/api/cli/shared-sessions");
    const body = JSON.parse(post.body);
    assert.equal(body.session_id, id);
    assert.equal(body.kind, "session");
    assert.match(body.delete_hash, /^[0-9a-f]{64}$/);
    assert.equal(body.subagents, 1);
    const jsonl = gunzipSync(Buffer.from(body.transcript_gz, "base64")).toString("utf8");
    assert.match(jsonl, /why does the stop hook skip my corrections/);
    assert.equal(secretReason(jsonl), null);

    const list = await spawnAsync(repo, home, ["--list"]);
    assert.match(list.stdout, /^ {3}1 {2}.*Stop hook misses Desktop corrections/m);
    assert.match(list.stdout, /^ {3}2 {2}Oct 1 .*old/m);
  } finally {
    trail.close();
  }
});

test("trail share-session --once: without a terminal it scrubs the whole Claude into a copy, shows it and sends nothing; --yes sends that copy; --delete takes it back", async () => {
  const { home, repo, id } = fakeSession();
  const trail = await standIn(true);
  try {
    signIn(home, trail.url);
    const shown = await spawnAsync(repo, home, ["--once"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^Your Claude, last 30 days, ready to send to the Trail team$/m);
    assert.match(shown.stdout, /^Sessions {2}1 session in 1 folder · [A-Z][a-z]{2} \d{1,2} · /m);
    assert.match(shown.stdout, /^ {12}1 {2}\/work\/web {2}1 session$/m);
    assert.match(shown.stdout, /^Copy {6}~[\\/]\.trail[\\/]share[\\/]\d{4}-\d{2}-\d{2}-\d{4} {2}every file exactly as it will go/m);
    assert.match(shown.stdout, /nothing sent\. Show the person what's above and the copy at ~[\\/]\.trail[\\/]share[\\/][\d-]+; only if they say yes, run trail share-session --once --yes/);
    assert.ok(!trail.got.some((g) => g.method === "POST"), "nothing is posted without a yes");
    const root = join(home, ".trail", "share");
    const copy = join(root, readdirSync(root)[0]!);
    for (const f of ["SUMMARY.md", "setup.json", "manifest.json"]) assert.ok(existsSync(join(copy, f)), f);

    const sent = await spawnAsync(repo, home, ["--once", "--yes"]);
    assert.equal(sent.status, 0, sent.stderr);
    assert.match(sent.stderr, /✓ sent your Claude to the Trail team: 2 items/);
    assert.doesNotMatch(sent.stderr, /from now on/, "a one-time send doesn't keep sending");
    assert.ok(!existsSync(join(home, ".trail", "share", "sync.json")));
    const posts = trail.got.filter((g) => g.method === "POST").map((g) => JSON.parse(g.body));
    assert.deepEqual(posts.map((p) => p.kind), ["setup", "session"]);
    assert.equal(new Set(posts.map((p) => p.bundle_id)).size, 1, "one bundle");
    assert.equal(posts[1].session_id, id);
    const jsonl = gunzipSync(Buffer.from(posts[1].transcript_gz, "base64")).toString("utf8");
    assert.match(jsonl, /why does the stop hook skip my corrections/);
    assert.equal(secretReason(jsonl), null);
    const code = /--delete (\S+)/.exec(sent.stderr)![1]!;
    const [bundleId, secret] = code.split(".");
    assert.equal(posts[0].bundle_id, bundleId);
    assert.equal(posts[0].delete_hash, createHash("sha256").update(secret!).digest("hex"));
    assert.ok(!JSON.stringify(posts).includes(secret!), "the secret never leaves");

    const again = await spawnAsync(repo, home, ["--once", "--yes"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing sent\./, "a sent copy isn't sent again; a new one is shown first");
    assert.equal(trail.got.filter((g) => g.method === "POST").length, 2);

    const del = await spawnAsync(repo, home, ["--delete", code]);
    assert.equal(del.status, 0, del.stderr);
    assert.match(del.stderr, /✓ deleted 2 items from the Trail team/);
    const d = trail.got.find((g) => g.method === "DELETE")!;
    assert.equal(d.path, `/api/cli/shared-sessions/bundles/${bundleId}`);
    assert.deepEqual(JSON.parse(d.body), { delete_code: secret });
    assert.ok(JSON.parse(readFileSync(join(copy, "sent.json"), "utf8")).deletedAt, "the copy knows it was taken back");
  } finally {
    trail.close();
  }
});

test("trail share-session --yes: a send that stops partway picks up where it stopped, in the same bundle", async () => {
  const { home, repo } = fakeSession();
  const trail = await standIn(true);
  try {
    signIn(home, trail.url);
    await spawnAsync(repo, home, []);
    trail.failPostsAfter = 1;
    const broke = await spawnAsync(repo, home, ["--yes"]);
    assert.equal(broke.status, 1, broke.stderr);
    assert.match(broke.stderr, /✗ couldn't send it · the database is busy/);
    assert.match(broke.stderr, /1 of 2 went; run trail share-session again to send the rest, or take back what went with --delete /);
    trail.failPostsAfter = null;
    const rest = await spawnAsync(repo, home, ["--yes"]);
    assert.equal(rest.status, 0, rest.stderr);
    const posts = trail.got.filter((g) => g.method === "POST").map((g) => JSON.parse(g.body));
    assert.deepEqual(posts.map((p) => p.kind), ["setup", "session"], "each item once");
    assert.equal(new Set(posts.map((p) => p.bundle_id)).size, 1);
  } finally {
    trail.close();
  }
});

test("trail share-session --delete: a code that isn't one says so and sends nothing", async () => {
  const { home, repo } = fakeSession();
  const trail = await standIn(true);
  try {
    signIn(home, trail.url);
    const r = await spawnAsync(repo, home, ["--delete", "nope"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /that isn't a delete code/);
    assert.ok(!trail.got.some((g) => g.method === "DELETE"));
  } finally {
    trail.close();
  }
});

test("trail share-session keeps sending by default: says so, --yes turns it on, a later run sends what grew into the same bundle, --stop ends it", async () => {
  const { home, repo, id } = fakeSession();
  const transcript = join(claudeProjectDir(repo, home), `${id}.jsonl`);
  const ago = (min: number) => new Date(Date.now() - min * 60_000);
  utimesSync(transcript, ago(30), ago(30));
  const trail = await standIn(true);
  try {
    signIn(home, trail.url);
    const shown = await spawnAsync(repo, home, []);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^Your Claude, last 30 days and from now on, ready to send to the Trail team$/m);
    assert.match(shown.stdout, /^Keeps on  after this, each Claude Code session you start sends what changed since, .* trail share-session --stop stops it$/m);
    assert.match(shown.stdout, /only if they say yes, run trail share-session --yes,/);
    assert.match(shown.stdout, /^Hook {6}one entry in ~\/\.claude\/settings\.json, so it runs in every folder/m);
    assert.ok(!existsSync(join(home, ".claude", "settings.json")), "nothing is added before the yes");
    assert.ok(!trail.got.some((g) => g.method === "POST"));

    const on = await spawnAsync(repo, home, ["--yes"]);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stderr, /and from now on: each Claude Code session you start, in any folder, sends what changed since/);
    assert.match(on.stderr, /added one hook to ~[\\/]\.claude[\\/]settings\.json so this runs in every folder, in the terminal and in Claude Desktop/);
    const settings = () => (existsSync(join(home, ".claude", "settings.json")) ? readFileSync(join(home, ".claude", "settings.json"), "utf8") : "");
    assert.match(settings(), /graft-hooks\.cjs\\" share-sync \|\| exit 0/);
    assert.match(on.stderr, /stop any time: trail share-session --stop/);
    const first = trail.got.filter((g) => g.method === "POST").map((g) => JSON.parse(g.body));
    assert.deepEqual(first.map((p) => p.kind), ["setup", "session"]);

    const status = await spawnAsync(repo, home, []);
    assert.match(status.stdout, /^Sending to the Trail team since .*: 1 session so far/m);
    assert.match(status.stdout, /no background run yet/);
    assert.match(status.stdout, /its hook is in ~[\\/]\.claude[\\/]settings\.json/);
    assert.equal(trail.got.filter((g) => g.method === "POST").length, 2, "asking again only shows where it stands");

    const oldSwitch = await spawnAsync(repo, home, ["--sync"]);
    assert.match(oldSwitch.stdout, /^Sending to the Trail team since /m, "--sync, the old switch, still works");

    appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "and one more thing" } }) + "\n");
    utimesSync(transcript, ago(15), ago(15));
    const ran = await spawnTrail(repo, home, ["_share-sync"]);
    assert.equal(ran.status, 0, ran.stderr);
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    const after = await spawnAsync(repo, home, []);
    assert.match(after.stdout, /last run .*: sent 1/, "the status says what the last run did");
    assert.match(after.stdout, /put its hook back in ~[\\/]\.claude[\\/]settings\.json/, "a hook something took out is put back");
    assert.match(settings(), /share-sync/);
    const later = trail.got.filter((g) => g.method === "POST").map((g) => JSON.parse(g.body)).slice(2);
    assert.deepEqual(later.map((p) => p.session_id), [id]);
    assert.equal(later[0].bundle_id, first[0].bundle_id);
    assert.equal(later[0].delete_hash, first[0].delete_hash);
    assert.match(gunzipSync(Buffer.from(later[0].transcript_gz, "base64")).toString("utf8"), /and one more thing/);

    const stop = await spawnAsync(repo, home, ["--stop"]);
    assert.match(stop.stderr, /✓ stopped: nothing more is sent/);
    assert.match(stop.stderr, /took its hook out of ~[\\/]\.claude[\\/]settings\.json/);
    assert.doesNotMatch(settings(), /share-sync/);
    assert.match(stop.stderr, /stays with the Trail team until you take it back: trail share-session --delete /);
    appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "after stopping" } }) + "\n");
    utimesSync(transcript, ago(12), ago(12));
    await spawnTrail(repo, home, ["_share-sync"]);
    assert.equal(trail.got.filter((g) => g.method === "POST").length, 3, "nothing goes once stopped");
  } finally {
    trail.close();
  }
});

/** trailIn, without blocking the stand-in server's event loop. */
function spawnAsync(cwd: string, home: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return spawnTrail(cwd, home, ["share-session", ...args]);
}

function spawnTrail(cwd: string, home: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", TSX, CLI, ...args], {
      cwd,
      env: cliEnv(home),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}
