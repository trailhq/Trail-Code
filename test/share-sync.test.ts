/**
 * `trail share-session --sync` keeps sending: after the person's yes, each
 * Claude Code session they start sends, from a detached child, the sessions
 * that are new or have grown and gone quiet, and the setup when it changes,
 * into the same bundle. Left-out folders never go; a run that breaks resumes;
 * one run at a time; `--stop` ends it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { newSentState } from "../src/cloud/share-bundle.js";
import { changedSessions, maybeShareSyncInBackground, readSyncState, runSync, syncDir, syncDue, writeSyncState, type SyncState } from "../src/cloud/share-sync.js";
import { QUIET_MS } from "../src/cloud/share-sync-state.js";
import type { SharedSession } from "../src/cloud/workspace.js";
import { secretReason } from "../src/notes/secrets.js";

const OPENAI = "sk-" + "proj-" + "Q7x2Lm9Pz4Rt8Vb1Nc6Kw3Hy5Jd0Fs";
const NOW = Date.parse("2026-11-05T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function session(home: string, folder: string, id: string, cwd: string, said: string, at: number): string {
  const dir = join(home, ".claude", "projects", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "user", timestamp: new Date(at).toISOString(), sessionId: id, cwd, message: { role: "user", content: `${said}, key ${OPENAI}` } }) + "\n");
  utimesSync(path, new Date(at), new Date(at));
  return path;
}

/** A home with three sessions, and sync turned on an hour ago with the first already sent. */
function synced(): { home: string; env: NodeJS.ProcessEnv; state: SyncState; paths: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), "sync-home-"));
  const env = { ...process.env, TRAIL_HOME: join(home, ".trail") };
  const paths = {
    old: session(home, "-work-web", "aaaa0000-0000-4000-8000-000000000001", "/work/web", "sent already", NOW - 3 * HOUR),
    fresh: session(home, "-work-web", "aaaa0000-0000-4000-8000-000000000002", "/work/web", "new since", NOW - 2 * HOUR),
    private: session(home, "-work-private", "bbbb0000-0000-4000-8000-000000000001", "/work/private", "left out", NOW - 2 * HOUR),
    live: session(home, "-work-web", "aaaa0000-0000-4000-8000-000000000003", "/work/web", "still going", NOW - 60_000),
  };
  const s = newSentState();
  const state: SyncState = {
    bundleId: s.bundleId,
    secret: s.secret,
    since: NOW - HOUR,
    days: 30,
    url: "http://trail.test",
    excluded: ["/work/private"],
    dirs: [],
    sessions: { "aaaa0000-0000-4000-8000-000000000001": NOW - 3 * HOUR },
    lastRunAt: NOW - HOUR,
  };
  writeSyncState(state, env);
  return { home, env, state, paths };
}

function collector(failAfter: number | null = null) {
  const got: SharedSession[] = [];
  const send = async (body: SharedSession) => {
    if (failAfter !== null && got.length >= failAfter) return { error: "the database is busy" };
    got.push(body);
    return { id: `row${got.length}` };
  };
  return { got, send };
}

test("syncDue: every session start, while it's on and not stopped", () => {
  const { state } = synced();
  assert.equal(syncDue(null), false);
  assert.equal(syncDue(state), true);
  assert.equal(syncDue({ ...state, lastRunAt: Date.now() }), true, "a run a moment ago doesn't hold the next one back");
  assert.equal(syncDue({ ...state, stoppedAt: NOW - 1 }), false);
});

test("changedSessions: new or grown, and quiet for ten minutes; one already sent and unchanged isn't", () => {
  const { home, state } = synced();
  assert.deepEqual(changedSessions(state, home, NOW).map((f) => f.id).sort(), ["aaaa0000-0000-4000-8000-000000000002", "bbbb0000-0000-4000-8000-000000000001"]);
  assert.ok(changedSessions(state, home, NOW + QUIET_MS).some((f) => f.id.endsWith("3")), "the live one goes once it's quiet");
});

test("runSync: sends what changed into the same bundle, scrubbed, keeps a readable copy, never the left-out folder, and the setup once", async () => {
  const { home, env, state, paths } = synced();
  const c = collector();
  const r = await runSync({ home, who: [home], send: c.send, trailVersion: "0.29.0", env, now: NOW });
  assert.deepEqual(r, { sent: 2, skipped: 1 });
  assert.deepEqual(c.got.map((b) => `${b.kind} ${b.session_id}`), ["session aaaa0000-0000-4000-8000-000000000002", "setup setup"]);
  for (const b of c.got) {
    assert.equal(b.bundle_id, state.bundleId);
    assert.match(b.delete_hash, /^[0-9a-f]{64}$/);
  }
  const jsonl = gunzipSync(Buffer.from(c.got[0]!.transcript_gz, "base64")).toString("utf8");
  assert.match(jsonl, /new since/);
  assert.equal(secretReason(jsonl), null);
  assert.ok(existsSync(join(syncDir(env), "sessions", "work-web", "aaaa0000-0000-4000-8000-000000000002.jsonl.gz")), "the person can read what went");
  assert.ok(!existsSync(join(syncDir(env), "sessions", "work-private")), "a left-out folder isn't even copied");
  const after = readSyncState(env)!;
  assert.equal(after.lastRunAt, NOW);
  assert.deepEqual(after.lastRun, { at: NOW, sent: 2 }, "the run writes down what it did, for the status to show");
  assert.ok(after.setupHash);
  assert.ok(after.sessions["bbbb0000-0000-4000-8000-000000000001"], "a left-out session is passed over for good");
  assert.equal(after.sizes?.["aaaa0000-0000-4000-8000-000000000002"], statSync(paths.fresh).size, "a sent session's size is kept");
  assert.equal(after.sizes?.["aaaa0000-0000-4000-8000-000000000001"], statSync(paths.old).size, "one sent before sizes were kept learns its size, without going again");

  // Nothing changed: nothing goes.
  const quiet = collector();
  assert.deepEqual(await runSync({ home, who: [home], send: quiet.send, trailVersion: "0.29.0", env, now: NOW + 1000 }), { sent: 0, skipped: 0 });

  // A sent session grows: it goes again, in the same bundle, for Trail to replace.
  appendFileSync(paths.fresh, JSON.stringify({ type: "user", message: { role: "user", content: "and one more thing" } }) + "\n");
  utimesSync(paths.fresh, new Date(NOW - HOUR), new Date(NOW - HOUR));
  const grown = collector();
  await runSync({ home, who: [home], send: grown.send, trailVersion: "0.29.0", env, now: NOW + 2000 });
  assert.deepEqual(grown.got.map((b) => b.session_id), ["aaaa0000-0000-4000-8000-000000000002"]);
  assert.equal(grown.got[0]!.bundle_id, state.bundleId);
  assert.match(gunzipSync(Buffer.from(grown.got[0]!.transcript_gz, "base64")).toString("utf8"), /and one more thing/);
});

test("runSync: a session whose time moves with nothing written isn't sent again", async () => {
  const { home, env, paths } = synced();
  await runSync({ home, who: [home], send: collector().send, trailVersion: "0.29.0", env, now: NOW });
  // Something on the laptop moves session files' times forward without writing to them.
  for (const p of [paths.old, paths.fresh, paths.private]) utimesSync(p, new Date(NOW - HOUR), new Date(NOW - HOUR));
  const again = collector();
  assert.deepEqual(await runSync({ home, who: [home], send: again.send, trailVersion: "0.29.0", env, now: NOW + 1000 }), { sent: 0, skipped: 0 });
  assert.deepEqual(again.got, []);
  assert.deepEqual(changedSessions(readSyncState(env)!, home, NOW + 1000), [], "and none counts as changed");
});

test("runSync: a session sent before sizes were kept, whose time has moved, goes once more, then by its size", async () => {
  const { home, env, paths } = synced();
  const OLD = "aaaa0000-0000-4000-8000-000000000001";
  utimesSync(paths.old, new Date(NOW - HOUR), new Date(NOW - HOUR));
  const first = collector();
  await runSync({ home, who: [home], send: first.send, trailVersion: "0.29.0", env, now: NOW });
  assert.ok(first.got.some((b) => b.session_id === OLD), "with no size to go by, its time is all there is");
  utimesSync(paths.old, new Date(NOW - 30 * 60_000), new Date(NOW - 30 * 60_000));
  const second = collector();
  await runSync({ home, who: [home], send: second.send, trailVersion: "0.29.0", env, now: NOW + 1000 });
  assert.ok(!second.got.some((b) => b.session_id === OLD), "its size is kept now, so a moved time alone doesn't send it");
});

test("runSync: a send that fails stops there and keeps what went; the next run sends only the rest", async () => {
  const { home, env } = synced();
  const broke = collector(0);
  const r = await runSync({ home, who: [home], send: broke.send, trailVersion: "0.29.0", env, now: NOW });
  assert.equal(r!.error, "the database is busy");
  assert.deepEqual(readSyncState(env)!.lastRun, { at: NOW, sent: 0, error: "the database is busy" }, "a failed run says so, instead of looking fine");
  const next = collector();
  await runSync({ home, who: [home], send: next.send, trailVersion: "0.29.0", env, now: NOW + 1000 });
  assert.deepEqual(next.got.map((b) => b.kind), ["session", "setup"]);
});

test("runSync: one run at a time, and none once stopped or never turned on", async () => {
  const { home, env, state } = synced();
  mkdirSync(syncDir(env), { recursive: true });
  writeFileSync(join(syncDir(env), ".lock"), "123");
  assert.equal(await runSync({ home, who: [home], send: collector().send, trailVersion: "0.29.0", env, now: Date.now() }), null);
  writeSyncState({ ...state, stoppedAt: NOW }, env);
  assert.equal(await runSync({ home, who: [home], send: collector().send, trailVersion: "0.29.0", env, now: NOW }), null);
  const empty = { ...process.env, TRAIL_HOME: mkdtempSync(join(tmpdir(), "sync-none-")) };
  assert.equal(await runSync({ home, who: [home], send: collector().send, trailVersion: "0.29.0", env: empty, now: NOW }), null);
});

test("runSync: a lock left by a run that died over an hour ago is taken over", async () => {
  const { home, env } = synced();
  mkdirSync(syncDir(env), { recursive: true });
  const lock = join(syncDir(env), ".lock");
  writeFileSync(lock, "123");
  const old = new Date(Date.now() - 2 * HOUR);
  utimesSync(lock, old, old);
  const r = await runSync({ home, who: [home], send: collector().send, trailVersion: "0.29.0", env, now: Date.now() });
  assert.ok(r && !r.error, "it ran");
  assert.ok(!existsSync(lock), "and let go of the lock");
});

test("maybeShareSyncInBackground: starts a run at every session start while it's on, and none once stopped", () => {
  const { env, state } = synced();
  assert.equal(maybeShareSyncInBackground(env), true);
  assert.equal(maybeShareSyncInBackground(env), true, "the next session starts one too; the run's lock keeps them from overlapping");
  assert.equal(readSyncState(env)!.lastRunAt, state.lastRunAt, "starting a run doesn't claim it ran");
  writeSyncState({ ...state, stoppedAt: NOW }, env);
  assert.equal(maybeShareSyncInBackground(env), false);
  const off = { ...process.env, TRAIL_HOME: mkdtempSync(join(tmpdir(), "sync-off-")) };
  assert.equal(maybeShareSyncInBackground(off), false);
});
