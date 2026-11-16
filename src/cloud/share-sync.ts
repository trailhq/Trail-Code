/**
 * Keeping on sharing, for the team-memory experiment. Once a person says yes
 * to `trail share-session` (which keeps sending unless run with `--once`), every
 * Claude Code session they start sends,
 * from a detached child of the session-start hook, what changed since the last
 * time: sessions that are new or have grown, and the setup when it changes.
 * Each is scrubbed exactly as the first send was, kept under
 * `~/.trail/share/sync/` so the person can read what went, and sent into the
 * same bundle, where Trail replaces the older copy of a session that grew.
 *
 * `--stop` ends it; `--delete <code>` takes everything back and ends it too.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { deleteHash, slug } from "./share-bundle.js";
import { anonymize, bundleSession, MAX_GZ_BYTES, sessionCwd, sessionsSince, type SessionFile } from "./share-session.js";
import { collectSetup } from "./share-setup.js";
import { QUIET_MS, readSyncState, syncDir, writeSyncState, type SyncState } from "./share-sync-state.js";
import type { SharedSession } from "./workspace.js";

export { maybeShareSyncInBackground, readSyncState, syncDir, syncDue, writeSyncState, type SyncState } from "./share-sync-state.js";

/** A lock older than this was left by a child that died. */
const LOCK_STALE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** This laptop's sessions as far back as the first send reached, and since. */
function sessionsInReach(s: SyncState, home: string, now: number): SessionFile[] {
  const reach = Math.max(1, Math.ceil((now - s.since) / DAY_MS) + s.days);
  return sessionsSince(reach, home, now);
}

/**
 * New, or not the size it was when last sent. The size tells, not the
 * last-written time: something on a laptop can move a transcript's time with
 * nothing written to it (one reset hundreds of sessions to a week before, and
 * every one went again, unchanged). A session sent before trail kept sizes
 * still goes by its time.
 */
function grown(s: SyncState, f: SessionFile): boolean {
  const size = s.sizes?.[f.id];
  if (size !== undefined) return f.size !== size;
  return (s.sessions[f.id] ?? 0) < f.mtime;
}

function due(s: SyncState, f: SessionFile, now: number): boolean {
  return now - f.mtime >= QUIET_MS && grown(s, f);
}

/** The sessions that are new or have grown since they were last sent, and have gone quiet. */
export function changedSessions(s: SyncState, home: string, now = Date.now()) {
  return sessionsInReach(s, home, now).filter((f) => due(s, f, now));
}

/**
 * A session sent before trail kept sizes, whose time hasn't moved since: its
 * size is written down now, without sending it, so a time that moves later
 * can't send it again.
 */
function learnSizes(s: SyncState, found: SessionFile[]): void {
  const sizes = (s.sizes ??= {});
  for (const f of found) {
    const at = s.sessions[f.id];
    if (sizes[f.id] === undefined && at !== undefined && f.mtime <= at) sizes[f.id] = f.size;
  }
}

function sentAs(s: SyncState, f: SessionFile): void {
  s.sessions[f.id] = f.mtime;
  (s.sizes ??= {})[f.id] = f.size;
}

type Send = (body: SharedSession) => Promise<{ id: string } | { error: string }>;

/**
 * Send what changed, one item at a time, writing the state after each, so a
 * run that dies picks up where it stopped. Skips if another run holds the lock.
 */
export async function runSync(opts: {
  home: string;
  who: string[];
  send: Send;
  trailVersion: string;
  repoOf?: (cwd: string) => string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<{ sent: number; skipped: number; error?: string } | null> {
  const now = opts.now ?? Date.now();
  const s = readSyncState(opts.env);
  if (!s || s.stoppedAt) return null;
  const dir = syncDir(opts.env);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  if (!takeLock(lock, now)) return null;
  let sent = 0;
  let skipped = 0;
  const base = { bundle_id: s.bundleId, delete_hash: deleteHash(s.secret), trail_version: opts.trailVersion };
  try {
    const cwds = new Set<string>(s.dirs.filter((d) => existsSync(d)));
    const found = sessionsInReach(s, opts.home, now);
    learnSizes(s, found);
    for (const f of found.filter((f) => due(s, f, now))) {
      const cwd = sessionCwd(f);
      const folder = cwd ? anonymize(cwd, opts.who).text : (f.folder ?? "");
      if (cwd && existsSync(cwd)) cwds.add(cwd);
      const b = bundleSession(f, opts.who);
      if (s.excluded.includes(folder) || b.gz.length > MAX_GZ_BYTES) {
        sentAs(s, f);
        skipped++;
        writeSyncState(s, opts.env);
        continue;
      }
      const file = join(dir, "sessions", slug(folder), `${f.id}.jsonl.gz`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, b.gz);
      const r = await opts.send({
        ...base,
        kind: "session",
        session_id: f.id,
        repo: cwd && opts.repoOf ? opts.repoOf(cwd) : "",
        title: b.title,
        messages: b.messages,
        subagents: b.subagents,
        bytes: b.bytes,
        redacted: Object.values(b.redacted).reduce((n, c) => n + c, 0),
        transcript_gz: b.gz.toString("base64"),
      });
      if ("error" in r) return finish({ sent, skipped, error: r.error });
      sentAs(s, f);
      sent++;
      writeSyncState(s, opts.env);
    }
    s.dirs = [...cwds].sort();
    const set = collectSetup({ home: opts.home, dirs: s.dirs, who: opts.who });
    const json = `${JSON.stringify(set.setup, null, 2)}\n`;
    const hash = createHash("sha256").update(json).digest("hex");
    if (hash !== s.setupHash) {
      writeFileSync(join(dir, "setup.json"), json);
      const r = await opts.send({
        ...base,
        kind: "setup",
        session_id: "setup",
        repo: "",
        title: "Claude setup",
        messages: 0,
        subagents: 0,
        bytes: Buffer.byteLength(json),
        redacted: Object.values(set.redacted).reduce((n, c) => n + c, 0),
        transcript_gz: gzipSync(json).toString("base64"),
      });
      if ("error" in r) return finish({ sent, skipped, error: r.error });
      s.setupHash = hash;
      sent++;
    }
    return finish({ sent, skipped });
  } catch (err) {
    return finish({ sent, skipped, error: err instanceof Error ? err.message : String(err) });
  } finally {
    rmSync(lock, { force: true });
  }

  /** Write down what this run did, so `trail share-session` can say. */
  function finish(r: { sent: number; skipped: number; error?: string }) {
    s!.lastRunAt = now;
    s!.lastRun = { at: now, sent: r.sent, ...(r.error ? { error: r.error } : {}) };
    writeSyncState(s!, opts.env);
    return r;
  }
}

/** The run's lock, taken in one step so two runs started together can't both get it. */
function takeLock(lock: string, now: number): boolean {
  for (let tries = 0; tries < 2; tries++) {
    try {
      closeSync(openSync(lock, "wx"));
      return true;
    } catch {
      try {
        if (now - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
        rmSync(lock, { force: true }); // left by a run that died
      } catch {
        // gone between the two calls: try again
      }
    }
  }
  return false;
}
