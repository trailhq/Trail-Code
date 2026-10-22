/**
 * Files only their owner can read: what Trail keeps for upload (the workspace
 * outbox, the usage-stats queue) and the workspace connection.
 *
 * A mode given when a file is created does nothing to a file an older version
 * already made, and a folder made by `mkdirSync` without one is world-readable,
 * so both are set again on every write. One `chmod` each is all that costs.
 * Windows has no owner-only mode bits (the profile folder's ACL guards it), so
 * nothing is changed there.
 */
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

const POSIX = process.platform !== "win32";

/** Opens a folder, and refuses a link (ELOOP) where the platform has O_NOFOLLOW. */
const DIR_NOFOLLOW = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

/**
 * Make `dir` if it's missing and leave it owner-only. Throws like `mkdirSync`; a folder that isn't ours is left
 * as it is. A link is left alone too: a chmod would follow it and tighten what it points to, which may be a folder
 * that isn't Trail's. The mode is set through a descriptor that refuses a link, so one swapped in after the check
 * isn't followed either (as trace/state.ts ensurePrivateDir).
 */
export function ensurePrivateDir(dir: string): void {
  try {
    if (lstatSync(dir).isSymbolicLink()) return;
  } catch {
    /* missing: made below */
  }
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (!POSIX || constants.O_NOFOLLOW === undefined) return;
  try {
    const fd = openSync(dir, DIR_NOFOLLOW);
    try {
      fchmodSync(fd, PRIVATE_DIR_MODE);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    // A folder its owner can't read can't be opened, but can still be tightened.
    if ((e as NodeJS.ErrnoException).code !== "EACCES") return;
    try {
      if (!lstatSync(dir).isSymbolicLink()) chmodSync(dir, PRIVATE_DIR_MODE);
    } catch {
      /* not ours to change: the file itself is still owner-only */
    }
  }
}

/** Write `text` to `path` through one descriptor that is owner-only before anything is written. */
function writePrivate(path: string, text: string, flags: "a" | "w"): void {
  ensurePrivateDir(dirname(path));
  const fd = openSync(path, flags, PRIVATE_FILE_MODE);
  try {
    if (POSIX) fchmodSync(fd, PRIVATE_FILE_MODE);
    // One write on an O_APPEND descriptor, as appendFileSync makes, so lines from two
    // processes don't interleave; the loop only matters if the disk takes part of it.
    const buf = Buffer.from(text, "utf8");
    for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}

/** Append `text` to `path`, owner-only, folder included. Throws like `appendFileSync`. */
export function appendPrivateFile(path: string, text: string): void {
  writePrivate(path, text, "a");
}

/** Replace `path` with `text`, owner-only, folder included. Throws like `writeFileSync`. */
export function writePrivateFile(path: string, text: string): void {
  writePrivate(path, text, "w");
}
