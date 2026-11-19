import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)']);
  try {
    lockOf(d, live.pid!, 0);
    assert.equal(lockHeldByOther(cacheDir(d)), true, 'another live process is building — wait');
  } finally {
    live.kill();
  }
  const gone = spawnSync(process.execPath, ['-e', '']); // already exited
  lockOf(d, gone.pid!, 0);
  assert.equal(lockHeldByOther(cacheDir(d)), false, 'a dead owner holds nothing — take over instead of waiting (#635)');
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

/*
 * Issue #635: the host SIGKILLs a prompt hook mid-rebuild; the lock file
 * survives naming a pid that no longer exists. The pid-liveness check in
 * lockStale only ran after LOCK_STALE_MS, so for the next five minutes every
 * query waited out the lock and answered from a stale graph. A dead owner
 * holds nothing — the pid check must come before the age floor. The age
 * floors stay exactly as they are for live owners (a slow first build keeps
 * its lock for LOCK_STALE_MS, any owner past LOCK_MAX_MS yields).
 */
test('a lock with a dead pid is reclaimable immediately, not after five minutes (#635)', () => {
  const d = fresh();
  lockOf(d, deadPid(), 1000); // one second old — the SIGKILL just happened
  assert.equal(lockHeldIn(cacheDir(d)), false, 'a dead owner holds nothing');
  assert.equal(acquireLock(d), true, 'reclaimed immediately');
});

test('a young lock with a live pid stays held — the age rule still protects slow builds (#635)', () => {
  const d = fresh();
  lockOf(d, process.pid, 1000);
  assert.equal(lockHeldIn(cacheDir(d)), true);
  assert.equal(acquireLock(d), false, 'a running build keeps its fresh lock');
});

test('a lock payload with no readable pid keeps the age rule (#635)', () => {
  // No pid to interrogate: age alone must decide, both ways. The garbage
  // payload goes in first and the mtime is backdated after, so the write
  // itself does not reset the age.
  const d = fresh();
  const young = lockOf(d, process.pid, 1000);
  writeFileSync(young, 'not json at all');
  assert.equal(lockHeldIn(cacheDir(d)), true, 'young garbage stays held');

  const d2 = fresh();
  const old = lockOf(d2, process.pid, LOCK_STALE_MS + 1000);
  writeFileSync(old, 'not json at all');
  const t = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
  utimesSync(old, t, t);
  assert.equal(lockHeldIn(cacheDir(d2)), false, 'old garbage is reclaimable');
});
