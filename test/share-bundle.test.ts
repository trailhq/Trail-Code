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
  sendAsk,
  unfinishedCopy,
  writeSent,
} from "../src/cloud/share-bundle.js";
import { bundleSession } from "../src/cloud/share-session.js";
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

test("prepareBundle: a session the scrub fails on is left out and named in the summary; the rest still go", () => {
  const home = fakeHome();
  const out = join(home, ".trail", "share", "2026-11-05-1200");
  const bad = "aaaa1111-0000-4000-8000-000000000002";
  const m = prepareBundle({
    days: 30,
    home,
    who: [home],
    out,
    now: NOW,
    scrub: (s, who) => {
      if (s.id === bad) throw new RangeError("Maximum call stack size exceeded");
      return bundleSession(s, who);
    },
  });
  assert.deepEqual(
    m.items.filter((it) => it.kind === "session").map((it) => it.id).sort(),
    ["aaaa1111-0000-4000-8000-000000000001", "bbbb2222-0000-4000-8000-000000000001"],
    "one session stopped nothing: before, the whole share ended there with nothing sent",
  );
  assert.deepEqual(m.unreadable, [{ folder: "/work/web", id: bad, mtime: NOW - 2 * 24 * 60 * 60 * 1000 }]);
  assert.ok(!existsSync(join(out, "sessions", "work-web", `${bad}.jsonl.gz`)), "nothing of it is written, so nothing of it can go");
  assert.match(readFileSync(join(out, "SUMMARY.md"), "utf8"), /^## Left out: trail couldn't scrub these\n\n- \/work\/web · Nov 3 · session aaaa1111$/m);
  assert.match(bundlePreviewLines(m, "~/x", { url: "https://team.trailhq.com" }).join("\n"), /^ {2}1 session trail couldn't scrub, so it isn't sent$/m);
});

test("bundlePreviewLines: what's sent, from which folders, what's removed, what happens after yes, then where the copy is", () => {
  const { m } = prepared();
  const lines = bundlePreviewLines(m, "~/.trail/share/2026-11-05-1200", { url: "https://team.trailhq.com" });
  const out = lines.join("\n");
  assert.match(out, /^Send your Claude to the Trail team, once$/m);
  assert.match(out, /^ {2}Sessions {3}3 from the last 30 days \(Nov 2 – Nov 4\), .* zipped$/m);
  assert.match(out, /^ {2}Setup {6}nothing beyond Claude Code's defaults$/m);
  assert.match(out, /^ {2}Memory {5}1 note$/m);
  assert.match(out, /^From these folders\n {2}1 {2}\/work\/web {2}2 sessions\n {2}2 {2}\/work\/api {3}1 session$/m);
  assert.match(out, /^Removed before sending\n {2}\d+ secrets?, like passwords, tokens and API keys$/m);
  assert.match(out, /^ {2}· It goes to team\.trailhq\.com, without your name\.$/m);
  assert.match(out, /^ {2}· You get a code that deletes everything you sent\.$/m);
  assert.doesNotMatch(out, /Each new Claude Code session/, "keep-sending is promised only when it's on");
  assert.match(lines.at(-1)!, /^Read every file first: ~[\\/]\.trail[\\/]share[\\/]2026-11-05-1200[\\/]SUMMARY\.md$/, "the copy is the last line, so the send question comes right after it");
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
  assert.match(bundlePreviewLines(next, "~/x", { url: "https://team.trailhq.com" }).join("\n"), /^ {2}1 folder you left out: \/work\/api$/m);
  assert.equal(parseLeaveOut("2", next), null, "a folder already left out is no longer on the list");
});

test("sendAsk: says what to type, folder numbers included while more than one folder is in, then asks about the rest", () => {
  const { out, m } = prepared();
  // A teammate saw only "→ Send it? [y/N]" and asked how to keep a folder back: the numbers worked, nothing said so.
  assert.equal(sendAsk(m), "Type y to send it all, n to send nothing, or folder numbers to leave out (like 2).\n→ ");
  const one = leaveOut(out, m, [2]);
  assert.equal(sendAsk(one, true), "Type y to send the rest, or n to send nothing.\n→ ", "one folder left: leaving it out would send nothing");
  assert.equal(sendAsk({ ...m, folders: [m.folders[0]!] }), "Type y to send it, or n to send nothing.\n→ ");
  const three = { ...m, folders: [...m.folders, { n: 3, label: "/work/docs", sessions: 1 }] };
  assert.equal(sendAsk(three), "Type y to send it all, n to send nothing, or folder numbers to leave out (like 2 3).\n→ ", "the example never names every folder");
  assert.equal(sendAsk({ ...three, dropped: ["/work/api"] }, true), "Type y to send the rest, n to send nothing, or more folder numbers to leave out (like 3).\n→ ");
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
