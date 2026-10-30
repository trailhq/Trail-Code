/**
 * `trail share-session`: a Trail teammate sends one of their Claude Code
 * sessions to the Trail team, whole, with secrets taken out on the laptop,
 * and only after a yes. Anyone outside the Trail team's workspace gets one
 * line and nothing is read or sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { BRAND_ENV } from "../src/brand.js";
import { bundleSession, pickSession, previewLines, redactedCount, sessionsHere, type SessionFile } from "../src/cloud/share-session.js";
import { shareAllowed, shareSession, type Cloud } from "../src/cloud/workspace.js";
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

/** A Claude Code project folder with one session in it, under a scratch home. */
function fakeSession(): { home: string; repo: string; id: string } {
  const home = mkdtempSync(join(tmpdir(), "share-home-"));
  // Real: macOS temp folders are a symlink, and Claude Code names the folder after the real cwd.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "share-repo-")));
  const id = "5a1e0c2d-1111-4222-8333-944455556666";
  const folder = claudeProjectDir(repo, home);
  mkdirSync(join(folder, id, "subagents"), { recursive: true });
  mkdirSync(join(folder, id, "tool-results"), { recursive: true });
  const at = (m: number) => `2026-10-29T10:${String(m).padStart(2, "0")}:00.000Z`;
  const lines = [
    { type: "user", timestamp: at(0), sessionId: id, cwd: repo, message: { role: "user", content: "<system-reminder>\nctx\n</system-reminder>\n\n\nwhy does the stop hook skip my corrections?" } },
    { type: "assistant", timestamp: at(1), message: { id: "msg_01", role: "assistant", content: [{ type: "thinking", thinking: "look at note-signals", signature: "EpYBCkYIBhgCKkB" + "x".repeat(300) }] } },
    { type: "assistant", timestamp: at(1), message: { id: "msg_01", role: "assistant", content: [{ type: "tool_use", id: "toolu_env", name: "Read", input: { file_path: `${repo}/.env.local` } }] } },
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
  assert.match(out, /^Goes to   Trail - Brand on team\.trailhq\.com, read only by the Trail team$/m);
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
});

test("shareSession: posts the zipped session and its counts, nothing about the person", async () => {
  const t = answering(201, { id: "u1", gz_bytes: 10 });
  const body = { session_id: "s1", repo: "github.com/acme/web", trail_version: "0.28.0", title: "t", messages: 3, subagents: 0, bytes: 100, redacted: 1, transcript_gz: "H4sI" };
  assert.deepEqual(await shareSession(CLOUD, body, t.fetchImpl), { id: "u1", gz_bytes: 10 });
  assert.equal(t.sent[0]!.method, "POST");
  assert.equal(t.sent[0]!.url, "http://trail.test/api/cli/shared-sessions");
  assert.deepEqual(Object.keys(t.sent[0]!.body as object).sort(), ["bytes", "messages", "redacted", "repo", "session_id", "subagents", "title", "trail_version", "transcript_gz"]);
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
  return { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), [BRAND_ENV]: "trail", DO_NOT_TRACK: "1", TRAIL_CLOUD: "1" };
}

/** A stand-in Trail on this machine that allows or refuses, and keeps what it was sent. */
async function standIn(allowed: boolean): Promise<{ url: string; got: Array<{ method: string; path: string; body: string }>; close: () => void }> {
  const got: Array<{ method: string; path: string; body: string }> = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    got.push({ method: req.method!, path: req.url!, body });
    if (!allowed) {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "sharing a session is for the Trail team only" }));
      return;
    }
    if (req.url === "/api/cli/shared-sessions/allowed") res.writeHead(200).end(JSON.stringify({ ok: true }));
    else res.writeHead(201).end(JSON.stringify({ id: "u1", gz_bytes: 1 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, got, close: () => server.close() };
}

function signIn(home: string, url: string): void {
  mkdirSync(join(home, ".trail"), { recursive: true });
  writeFileSync(join(home, ".trail", "cloud.json"), JSON.stringify({ ...CLOUD, url }));
}

test("trail share-session: not signed in, one line and nothing read or sent", () => {
  const { home, repo } = fakeSession();
  const r = spawnSync(process.execPath, ["--import", TSX, CLI, "share-session"], { cwd: repo, encoding: "utf8", timeout: 60_000, env: cliEnv(home) });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim(), "✗ internal only: share-session is for the Trail team, signed in to its workspace on team.trailhq.com");
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

test("trail share-session: without a terminal it shows what would go and sends nothing; --yes sends it", async () => {
  const { home, repo, id } = fakeSession();
  const trail = await standIn(true);
  try {
    signIn(home, trail.url);
    const shown = await spawnAsync(repo, home, []);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^Session {3}Stop hook misses Desktop corrections$/m);
    assert.match(shown.stdout, /nothing sent\. Show the person what's above; only if they say yes, run trail share-session 5a1e0c2d --yes/);
    assert.ok(!trail.got.some((g) => g.method === "POST"), "nothing is posted without a yes");

    const sent = await spawnAsync(repo, home, ["5a1e0c2d", "--yes"]);
    assert.equal(sent.status, 0, sent.stderr);
    assert.match(sent.stderr, /✓ sent 5a1e0c2d to the Trail team/);
    const post = trail.got.find((g) => g.method === "POST")!;
    assert.equal(post.path, "/api/cli/shared-sessions");
    const body = JSON.parse(post.body);
    assert.equal(body.session_id, id);
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

/** trailIn, without blocking the stand-in server's event loop. */
function spawnAsync(cwd: string, home: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", TSX, CLI, "share-session", ...args], {
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
