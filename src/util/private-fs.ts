/**
 * The one way the skills code writes under `~/.trail`: files 0600 (a copied
 * helper script 0700), folders 0700, whole files by temp file and rename,
 * log lines by one O_APPEND write, and a lock that gives up.
 *
 * The lock gives up rather than waits forever or barges in: a hook that can't
 * get it in time does nothing, because a fold that ran twice would count
 * every call twice, and a lost update is better than a double one. A lock
 * older than 10 s belongs to a process that died, so it is taken over, by one
 * process at a time (a second lock, held for microseconds, guards the
 * takeover), and a holder only ever removes its own lock.
 *
 * Nothing here writes through a symlink: an append refuses one, and a whole
 * file replaces the link itself, never what it points to.
 */
import {
  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeSync, type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { trailHome } from '../notes/trail-home.js';
import { ensurePrivateDir } from '../trace/state.js';

export { ensurePrivateDir, writePrivateJson } from '../trace/state.js';

const POSIX = process.platform !== 'win32';
/** One append is one write: a line this long or longer is refused. */
const MAX_LINE_BYTES = 4096;
const LOCK_POLL_MS = 10;
const LOCK_STALE_MS = 10_000;
/** A takeover takes microseconds; a takeover lock this old belongs to a process that died mid-way. */
const STEAL_STALE_MS = 2_000;
/** O_APPEND that refuses a symlink (ELOOP) where the platform has O_NOFOLLOW. */
/** O_NONBLOCK: a FIFO planted at the path can't hold the open (D100 18); the fstat below then refuses it. */
const APPEND_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
}

/** tmp file + rename; mode 0o600 unless given (0o700 for a copied helper script). */
export function writePrivate(path: string, data: string, mode = 0o600): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    const fd = openSync(tmp, 'wx', mode);
    try {
      if (POSIX) fchmodSync(fd, mode);
      writeAll(fd, data);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    throw e;
  }
}

/**
 * O_APPEND, 0600, adds '\n'. Throws on a line of 4 KB or more, so one append stays one write. Throws on a symlink,
 * and on anything that isn't a regular file (a FIFO, a device) without blocking or writing to it.
 */
export function appendPrivateLine(path: string, line: string): void {
  if (/[\r\n]/.test(line)) throw new Error('appendPrivateLine takes one line: it holds a line break');
  if (Buffer.byteLength(line, 'utf8') >= MAX_LINE_BYTES) throw new Error('appendPrivateLine: a line of 4 KB or more is refused');
  ensurePrivateDir(dirname(path));
  const fd = openSync(path, APPEND_FLAGS, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('appendPrivateLine: not a regular file');
    if (POSIX) fchmodSync(fd, 0o600);
    writeAll(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}

/** null on a missing file or bad JSON. */
export function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export type Locked<T> = { ok: true; value: T } | { ok: false };

const SLEEP_CELL = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;
function pause(ms: number): void {
  if (SLEEP_CELL) Atomics.wait(SLEEP_CELL, 0, 0, ms);
  else {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin: no SharedArrayBuffer here */ }
  }
}

const lstatOrNull = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const sameFile = (a: Stats, b: Stats) => a.ino === b.ino && a.dev === b.dev;
const readOrNull = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const aside = (p: string) => `${p}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.stale`;
/** A file, a link or an empty folder; never a folder's contents. */
const removeAny = (p: string) => {
  try {
    unlinkSync(p);
  } catch {
    try { rmdirSync(p); } catch { /* left as it is, under a name nobody locks */ }
  }
};

/**
 * Take `<lock>` over if it is older than 10 s. True when it is gone (taken over, or released) and a retry
 * may win. Under `<lock>.steal` (open wx), so two processes that both saw the old lock can't both take
 * it: the second one would move aside the first one's new lock. The lock is moved aside and checked to
 * be the old one; a fresh one moved by mistake is linked back.
 */
function stealStale(lock: string): boolean {
  const seen = lstatOrNull(lock);
  if (!seen) return true; // released between our open and our look
  if (Date.now() - seen.mtimeMs <= LOCK_STALE_MS) return false;
  const guard = `${lock}.steal`;
  let fd: number;
  try {
    fd = openSync(guard, 'wx', 0o600);
  } catch {
    const g = lstatOrNull(guard);
    if (g && Date.now() - g.mtimeMs > STEAL_STALE_MS) {
      const moved = aside(guard);
      try { renameSync(guard, moved); removeAny(moved); } catch { /* another process cleared it */ }
    }
    return false;
  }
  closeSync(fd);
  try {
    const now = lstatOrNull(lock);
    if (!now) return true;
    if (!sameFile(now, seen) || Date.now() - now.mtimeMs <= LOCK_STALE_MS) return false;
    const moved = aside(lock);
    try {
      renameSync(lock, moved);
    } catch {
      return true;
    }
    const was = lstatOrNull(moved);
    if (was && (!sameFile(was, seen) || Date.now() - was.mtimeMs <= LOCK_STALE_MS)) {
      // A fresh lock replaced the old one after our look: put it back, unless someone holds the path again.
      try { linkSync(moved, lock); } catch { /* the path is taken: that holder goes on */ }
      removeAny(moved);
      return false;
    }
    removeAny(moved);
    return true;
  } finally {
    try { unlinkSync(guard); } catch { /* gone already */ }
  }
}

/**
 * Lock `<path>.lock` (open with wx). Polls every 10 ms up to waitMs (default 200). Steals a lock
 * older than 10 s. On timeout returns { ok: false } and does NOT run fn: a fold that ran twice
 * would count every call twice, and a lost update is better than a double one. EPERM or EBUSY on
 * the open (Windows, while another process deletes the lock) counts as busy too.
 */
export function withLock<T>(path: string, fn: () => T, waitMs = 200): Locked<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + Math.max(0, waitMs);
  let fd = -1;
  let held = false;
  let backoff = 1;
  for (;;) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') held = true;
      else if (code === 'EPERM' || code === 'EBUSY') {
        // Windows answers an open of a file another process is deleting with EPERM (or EBUSY): the lock is
        // being let go, so this is a busy lock, not a stale one. Retry, backing off. If nothing was ever seen
        // holding it by the deadline, the folder itself refuses us: that error is the real one.
        if (Date.now() >= deadline) {
          if (!held) throw e;
          return { ok: false };
        }
        pause(Math.min(backoff, Math.max(1, deadline - Date.now())));
        backoff = Math.min(backoff * 2, LOCK_POLL_MS);
        continue;
      } else throw e;
    }
    // The deadline is checked on every turn: a lock that can't be taken over (a dangling symlink, a
    // folder we can't move) must not spin forever.
    const gone = stealStale(lock);
    if (Date.now() >= deadline) return { ok: false };
    if (!gone) pause(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  let mine: Stats | null = null;
  // The pid, and a nonce: Linux hands a freed inode to the next file at once, so a lock that was taken over
  // can have our inode number; its text tells it apart.
  const token = `${process.pid} ${Math.random().toString(16).slice(2, 10)}`;
  let wrote = false;
  try {
    try { mine = fstatSync(fd); } catch { /* checked below */ }
    try { writeAll(fd, token); wrote = true; } catch { /* the lock is the file, not its text */ }
    closeSync(fd);
    return { ok: true, value: fn() };
  } finally {
    // Only our own lock: if fn ran past 10 s and another process took over, the path is theirs now.
    const now = lstatOrNull(lock);
    if (now && mine && sameFile(now, mine) && (!wrote || readOrNull(lock) === token)) {
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  }
}

/** join(trailHome(env), ...parts). */
export function trailPath(env: NodeJS.ProcessEnv | undefined, ...parts: string[]): string {
  return join(trailHome(env ?? process.env), ...parts);
}
