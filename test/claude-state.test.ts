import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyStats, readStats, writeStats, patchStats,
  readSession, writeSession, acquireLock, releaseLock, cacheDir, LOCK_STALE_MS, writeJsonAtomic,
} from '../src/claude/state.js';
import { LOCK_MAX_MS, lockHeldByOther, lockHeldIn } from '../src/util/state.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-state-')); }

test('stats round-trip and patch merge', () => {
  const d = fresh();
  assert.equal(readStats(d), null);
  writeStats(d, { ...emptyStats(), nodeCount: 319, edgeCount: 730 });
  assert.equal(readStats(d)!.nodeCount, 319);
  const patched = patchStats(d, { dirty: true, staleCount: 4 });
  assert.equal(patched.dirty, true);
  assert.equal(patched.staleCount, 4);
  assert.equal(readStats(d)!.edgeCount, 730, 'patch preserves other fields');
});

test('session defaults and round-trip', () => {
  const d = fresh();
  const s = readSession(d, 'abc');
  assert.deepEqual(s, { graftReads: 0, sourceReads: 0, savedTokens: 0, injectedPointers: [], nudges: 0 });
  s.promptAsks = 1; s.graftReads = 2;
  writeSession(d, 'abc', s);
  assert.equal(readSession(d, 'abc').promptAsks, 1);
  assert.equal(readSession(d, 'abc').graftReads, 2);
  assert.equal(readSession(d, 'xyz').graftReads, 0, 'other sessions isolated');
});

test('lock is exclusive then releasable', () => {
  const d = fresh();
  assert.equal(acquireLock(d), true);
  assert.equal(acquireLock(d), false, 'second acquire blocked while held');
  assert.ok(existsSync(join(cacheDir(d), '.sync.lock')));
  releaseLock(d);
  assert.equal(acquireLock(d), true, 'reacquire after release');
});

/** A lock held by `pid`, last written `ageMs` ago. */
function lockOf(d: string, pid: number, ageMs: number): string {
  mkdirSync(cacheDir(d), { recursive: true });
  const p = join(cacheDir(d), '.sync.lock');
  writeFileSync(p, JSON.stringify({ pid, at: new Date().toISOString() }));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}
/** The pid of a process that has already exited. */
function deadPid(): number { return spawnSync(process.execPath, ['-e', '']).pid!; }

test('acquireLock reclaims a stale lock whose owner is gone', () => {
  const d = fresh();
  lockOf(d, deadPid(), LOCK_STALE_MS + 1000);
  assert.equal(lockHeldIn(cacheDir(d)), false);
  assert.equal(acquireLock(d), true, 'stale lock reclaimed');
});

test('a lock older than five minutes stays with an owner that is still running', () => {
  // A first build on a slow laptop runs past LOCK_STALE_MS; taking its lock started a
  // second full build beside it.
  const d = fresh();
  lockOf(d, process.pid, LOCK_STALE_MS + 1000);
  assert.equal(lockHeldIn(cacheDir(d)), true);
  assert.equal(acquireLock(d), false, 'the build still running keeps its lock');
});

test('past LOCK_MAX_MS a lock is reclaimed even with a live pid', () => {
  // The pid may be a new process that got a dead owner's number.
  const d = fresh();
  lockOf(d, process.pid, LOCK_MAX_MS + 1000);
  assert.equal(acquireLock(d), true);
});

test('lockHeldByOther: another live process, not this one or its parent', () => {
  const d = fresh();
  assert.equal(lockHeldByOther(cacheDir(d)), false, 'no lock');
  lockOf(d, process.pid, 0);
  assert.equal(lockHeldByOther(cacheDir(d)), false, 'our own lock');
  lockOf(d, process.ppid, 0);
  assert.equal(lockHeldByOther(cacheDir(d)), false, 'our parent: sync-run holding it for its build');
  const other = spawnSync(process.execPath, ['-e', '']); // gone, but its fresh lock is still another's
  lockOf(d, other.pid!, 0);
  assert.equal(lockHeldByOther(cacheDir(d)), true);
});

test('writeJsonAtomic leaves no scratch file behind when the write fails', () => {
  const d = fresh();
  const dir = join(d, 'locked');
  mkdirSync(dir, { recursive: true });

  // The failure is injected by putting a *directory* where the file belongs, so the
  // rename fails. This replaces a read-only parent dir (`chmod 0o500`), which was
  // both non-portable — Windows ignores it, and so does root, hence the skip this
  // test used to carry — and weaker: the tmp file was never created there, so there
  // was never anything that could have been left behind. Here it definitely is.
  const target = join(dir, 'out.json');
  mkdirSync(target);

  // Every CLI invocation is a new pid, so a repeatedly failing write would leave one
  // full-size `<path>.<pid>.tmp` per attempt, and nothing in graft ever lists these
  // directories to clean them up — on a nearly-full disk that accelerates the ENOSPC
  // that caused it.
  assert.throws(() => writeJsonAtomic(target, { pad: 'x'.repeat(1024) }));
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    [],
    'no .tmp residue',
  );
});
