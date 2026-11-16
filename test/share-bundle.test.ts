/**
 * `trail share-session` with no session named scrubs a person's whole Claude
 * into a copy on their laptop first: every session from the last N days,
 * grouped and numbered by folder, the setup, and a SUMMARY.md. The person
 * leaves folders out by number, a send that stops resumes, and a delete code
 * takes it all back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  bundlePreviewLines,
  deleteCode,
  deleteHash,
  itemPayload,
  leaveOut,
  newCopyDir,
  newSentState,
  parseDeleteCode,
  parseLeaveOut,
  prepareBundle,
  readManifest,
  unfinishedCopy,
  writeSent,
} from "../src/cloud/share-bundle.js";
import { secretReason } from "../src/notes/secrets.js";

const OPENAI = "sk-" + "proj-" + "Q7x2Lm9Pz4Rt8Vb1Nc6Kw3Hy5Jd0Fs";
const NOW = Date.parse("2026-11-05T12:00:00Z");

/** Sessions in three Claude Code folders: two in one repo, one in another, one too old. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "bundle-home-"));
  const session = (folder: string, id: string, cwd: string, said: string, at: number) => {
    const dir = join(home, ".claude", "projects", folder);
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "user", timestamp: new Date(at).toISOString(), sessionId: id, cwd, message: { role: "user", content: said } },
      { type: "assistant", timestamp: new Date(at + 60_000).toISOString(), message: { id: `msg_${id}`, role: "assistant", content: [{ type: "text", text: `ok, and rotate ${OPENAI}` }] } },
    ];
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    utimesSync(join(dir, `${id}.jsonl`), new Date(at), new Date(at));
  };
  const day = 24 * 60 * 60 * 1000;
  session("-work-web", "aaaa1111-0000-4000-8000-000000000001", "/work/web", "fix the order reader", NOW - day);
  session("-work-web", "aaaa1111-0000-4000-8000-000000000002", "/work/web", "why does login fail", NOW - 2 * day);
  session("-work-api", "bbbb2222-0000-4000-8000-000000000001", "/work/api", "add the audit client", NOW - 3 * day);
  session("-work-old", "cccc3333-0000-4000-8000-000000000001", "/work/old", "ancient", NOW - 40 * day);
  mkdirSync(join(home, ".claude", "projects", "-work-web", "memory"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "-work-web", "memory", "orders.md"), "Use the shared order reader.\n");
  return home;
}

function prepared() {
  const home = fakeHome();
  const out = join(home, ".trail", "share", "2026-11-05-1200");
  const m = prepareBundle({ days: 30, home, who: [home], out, now: NOW, repoOf: (cwd) => (cwd === "/work/web" ? "github.com/acme/web" : "") });
  return { home, out, m };
}

test("prepareBundle: the last 30 days of sessions from every folder, numbered by folder, plus the setup, all written to the copy", () => {
  const { out, m } = prepared();
  assert.deepEqual(m.items.map((it) => it.kind), ["setup", "session", "session", "session"]);
  assert.deepEqual(m.folders, [
    { n: 1, label: "/work/web", sessions: 2 },
    { n: 2, label: "/work/api", sessions: 1 },
  ]);
  const web = m.items.find((it) => it.id === "aaaa1111-0000-4000-8000-000000000001")!;
  assert.equal(web.repo, "github.com/acme/web");
  assert.equal(web.file, "sessions/work-web/aaaa1111-0000-4000-8000-000000000001.jsonl.gz", "always /, so SUMMARY.md reads the same on Windows");
  const jsonl = gunzipSync(readFileSync(join(out, web.file))).toString("utf8");
  assert.match(jsonl, /fix the order reader/);
  assert.equal(secretReason(jsonl), null, "the copy is already scrubbed");
  assert.equal(m.setup.memory, 1);
  assert.ok(m.redacted["an API key"]! >= 3);
  for (const f of ["manifest.json", "SUMMARY.md", "setup.json"]) assert.ok(existsSync(join(out, f)), f);
  const summary = readFileSync(join(out, "SUMMARY.md"), "utf8");
  assert.match(summary, /^ {2}1\. \/work\/web · 2 sessions$/m);
  assert.match(summary, /^- Nov 4 · fix the order reader · 2 messages · .*`sessions\/work-web\/aaaa1111/m);
  assert.deepEqual(readManifest(out), m);
});

test("bundlePreviewLines: what goes, from where, how it was scrubbed, where the copy is, and that it can be taken back", () => {
  const { m } = prepared();
  const out = bundlePreviewLines(m, "~/.trail/share/2026-11-05-1200", { url: "https://team.trailhq.com" }).join("\n");
  assert.match(out, /^Your Claude, last 30 days, ready to send to the Trail team$/m);
  assert.match(out, /^Sessions {2}3 sessions in 2 folders · Nov 2 – Nov 4 · .* zipped$/m);
  assert.match(out, /^ {12}1 {2}\/work\/web {2}2 sessions$/m);
  assert.match(out, /^Setup {5}nothing set up beyond Claude Code's defaults$/m);
  assert.match(out, /^Memory {4}1 note$/m);
  assert.match(out, /^Secrets {3}\d+ redacted: API key ×\d+$/m);
  assert.match(out, /other people's names stay$/m);
  assert.match(out, /^Copy {6}~\/\.trail\/share\/2026-11-05-1200 {2}every file exactly as it will go/m);
  assert.match(out, /^Goes to {3}the Trail team on team\.trailhq\.com, for the team-memory experiment, without your name$/m);
  assert.match(out, /^Delete {4}any time/m);
});

test("parseLeaveOut and leaveOut: folder numbers drop those folders' files from the copy, and the summary says so", () => {
  const { out, m } = prepared();
  assert.equal(parseLeaveOut("y", m), null);
  assert.equal(parseLeaveOut("3", m), null, "only listed folders");
  assert.deepEqual(parseLeaveOut("2, 2", m), [2]);
  const next = leaveOut(out, m, [2]);
  assert.deepEqual(next.items.map((it) => it.folder), ["", "/work/web", "/work/web"]);
  assert.deepEqual(next.dropped, ["/work/api"]);
  assert.ok(!existsSync(join(out, "sessions", "work-api")));
  assert.deepEqual(readdirSync(join(out, "sessions")), ["work-web"]);
  assert.match(readFileSync(join(out, "SUMMARY.md"), "utf8"), /2\. \/work\/api · 1 session · left out/);
  assert.match(bundlePreviewLines(next, "~/x", { url: "https://team.trailhq.com" }).join("\n"), /^Dropped {3}you left out 1 folder: \/work\/api$/m);
});

test("itemPayload: a session goes as its zipped file, the setup zipped on the way", () => {
  const { out, m } = prepared();
  const setup = JSON.parse(gunzipSync(Buffer.from(itemPayload(out, m.items[0]!), "base64")).toString("utf8"));
  assert.equal(setup.kind, "claude-setup");
  const s = m.items[1]!;
  assert.deepEqual(Buffer.from(itemPayload(out, s), "base64"), readFileSync(join(out, s.file)));
});

test("delete codes: one string the person keeps, and Trail gets only the sha256 of its secret", () => {
  const s = newSentState();
  const code = deleteCode(s);
  assert.deepEqual(parseDeleteCode(code), { bundleId: s.bundleId, secret: s.secret });
  assert.deepEqual(parseDeleteCode(`  ${code}\n`), { bundleId: s.bundleId, secret: s.secret });
  assert.equal(parseDeleteCode("not-a-code"), null);
  assert.equal(parseDeleteCode(s.bundleId), null);
  assert.equal(deleteHash(s.secret), createHash("sha256").update(s.secret).digest("hex"));
  assert.notEqual(newSentState().secret, s.secret);
});

test("unfinishedCopy: the newest copy that hasn't all gone; once it's sent or deleted there's none", () => {
  const { home, out, m } = prepared();
  const root = join(home, ".trail", "share");
  assert.equal(unfinishedCopy(root)!.dir, out);
  assert.equal(unfinishedCopy(root)!.sent, null);
  const s = { ...newSentState(), sent: [m.items[0]!.id] };
  writeSent(out, s);
  assert.deepEqual(unfinishedCopy(root)!.sent!.sent, ["setup"]);
  writeSent(out, { ...s, finishedAt: NOW });
  assert.equal(unfinishedCopy(root), null);
  assert.equal(unfinishedCopy(join(home, "nowhere")), null);
});

test("newCopyDir: one folder per run, named for the minute, never reused", () => {
  const root = mkdtempSync(join(tmpdir(), "copies-"));
  const at = new Date(2026, 10, 5, 14, 2).getTime();
  const a = newCopyDir(root, at);
  assert.match(a, /2026-11-05-1402$/);
  mkdirSync(a);
  assert.match(newCopyDir(root, at), /2026-11-05-1402-2$/);
});
