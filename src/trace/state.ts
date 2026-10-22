/**
 * Where Trail keeps what it knows about one live session on this machine:
 * `~/.trail/sessions/<id>.json` (the transcript offset, the epoch, a pending
 * offer). Only offsets, ids and counts go there, never what anyone typed.
 * Folders are 0700 and files 0600: a session file says what someone was
 * working on.
 */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { trailHome } from "../notes/trail-home.js";
import { writeJsonAtomic } from "../util/state.js";

const POSIX = process.platform !== "win32";
/** Opens a folder, and refuses a link (ELOOP) where the platform has O_NOFOLLOW. */
const DIR_NOFOLLOW = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

/**
 * A folder only its owner can open, made if missing and tightened if it was
 * looser. A link is left as it is: a chmod would follow it and tighten what
 * it points to, which may be a folder that isn't Trail's (a person's dotfiles
 * can link the Trail home; skills/own-folder.ts refuses links in place of
 * Trail's own folders before anything is written). The mode is set through a
 * descriptor that refuses a link, so one swapped in after the check isn't
 * followed either.
 */
export function ensurePrivateDir(dir: string): void {
  try {
    if (lstatSync(dir).isSymbolicLink()) return;
  } catch {
    /* missing: made below */
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!POSIX || constants.O_NOFOLLOW === undefined) return;
  try {
    const fd = openSync(dir, DIR_NOFOLLOW);
    try {
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    // A folder its owner can't read can't be opened, but can still be tightened.
    if ((e as NodeJS.ErrnoException).code !== "EACCES") return;
    try {
      if (!lstatSync(dir).isSymbolicLink()) chmodSync(dir, 0o700);
    } catch {
      /* not ours to change */
    }
  }
}

/**
 * JSON only its owner can read, written whole or not at all. Folders it has
 * to make are made private; a folder that already exists is left as it is
 * (a cursor kept beside a caller's own files must not lock them away).
 */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeJsonAtomic(path, value, true, 0o600);
}

/**
 * A session id as a file name. Hosts send UUIDs; anything else (a path, a
 * dot, a very long string) is hashed, so a payload can never point the file
 * outside the folder.
 */
function fileId(sessionId: string): string {
  if (/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return sessionId;
  return `h-${createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16)}`;
}

/** `~/.trail/sessions/<id>.json`; the folder exists (0700) once this returns, when it can be made. */
export function sessionStatePath(sessionId: string): string {
  const dir = join(trailHome(), "sessions");
  try {
    ensurePrivateDir(dir);
  } catch {
    /* read-only home: the caller's write fails and it fails open */
  }
  return join(dir, `${fileId(sessionId)}.json`);
}

/**
 * `~/.trail/sessions/<id>.hooks.json`: where the turn-end hooks keep their
 * own transcript cursor and what they carry between reads (the reply in
 * progress, the responses already billed). Apart from `<id>.json`, whose
 * cursor belongs to the skills catch-up, so neither reader moves the
 * other's offset.
 */
export function hookCursorPath(sessionId: string): string {
  return sessionStatePath(sessionId).replace(/\.json$/, ".hooks.json");
}
