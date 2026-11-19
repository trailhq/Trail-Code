/*
 * Issue #833: dozens of concurrent `_update-check` / `_telemetry-flush`
 * helpers spawn at once. The re-read after the timestamp write closes the
 * sequential hole but not the concurrent one — N callers starting in the same
 * millisecond all read the stale window, all pass, all spawn. The claim file
 * is the cross-process mutex: one winner per window, a crashed winner's claim
 * expires, and a corrupt claim never blocks forever.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { claimWindow } from '../src/util/state.js';
import { FLUSH_TTL_MS, maybeFlushInBackground } from '../src/telemetry/flush.js';
import { statePath } from '../src/telemetry/identity.js';
import { queuePath } from '../src/telemetry/queue.js';
import { CI_ENV_VARS } from '../src/telemetry/gate.js';
import { maybeRefreshInBackground, updateCachePath, UPDATE_TTL_MS } from '../src/upkeep.js';
import { homeEnv, tmpRepo } from './helpers.js';

const EVENT = { event: 'query', properties: { command: 'ask' }, distinct_id: 'test-install' };
const ENV_KEYS = ['GRAFT_POSTHOG_KEY', 'DO_NOT_TRACK', ...CI_ENV_VARS];
let savedEnv: Record<string, string | undefined>;
let homes: string[] = [];

function flushReadyHome(): string {
  const home = tmpRepo('claim-flush');
  homes.push(home);
  mkdirSync(join(home, '.graft'), { recursive: true });
  writeFileSync(statePath(home), JSON.stringify({
    installId: 'test-install', enabled: true, flushedAt: 0,
    firstRunAt: '2026-01-01', noticeShownAt: '2026-01-01',
  }));
  writeFileSync(queuePath(home), JSON.stringify(EVENT) + '\n');
  return home;
}

function interceptSpawn() {
  const spawn = mock.method(childProcess, 'spawn', () => ({ unref() {} }) as ChildProcess);
  syncBuiltinESMExports();
  return spawn;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_key';
  homes = [];
});

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test('claimWindow: one winner, an immediate second caller loses, stale and corrupt claims are reclaimable (#833)', () => {
  const home = tmpRepo('claim-window');
  homes.push(home);
  mkdirSync(join(home, '.graft'), { recursive: true });
  const claim = join(home, '.graft', 'unit.claim');
  const now = 1_700_000_000_000;
  assert.equal(claimWindow(claim, 10 * 60_000, now), true, 'the first caller wins');
  assert.equal(claimWindow(claim, 10 * 60_000, now), false, 'a fresh claim blocks the second caller');
  assert.equal(claimWindow(claim, 10 * 60_000, now + 10 * 60_000), true, 'a stale claim is reclaimed, so a crashed winner cannot block forever');
  writeFileSync(claim, 'garbage{');
  assert.equal(claimWindow(claim, 10 * 60_000, now + 11 * 60_000), true, 'a corrupt claim does not block forever either');
});

test('a fresh foreign claim suppresses the flush storm: 8 callers, 0 spawns; without it, exactly one (#833)', () => {
  const home = flushReadyHome();
  const spawn = interceptSpawn();
  const now = FLUSH_TTL_MS + 1;
  const claim = `${statePath(home)}.claim`;
  writeFileSync(claim, JSON.stringify({ claimedAt: now })); // a concurrent winner, same millisecond
  for (let i = 0; i < 8; i++) {
    assert.equal(maybeFlushInBackground(home, now), false, `concurrent caller ${i} must not spawn`);
  }
  assert.equal(spawn.mock.callCount(), 0, 'no storm behind a fresh claim');
  rmSync(claim);
  assert.equal(maybeFlushInBackground(home, now), true, 'the first caller without a claim wins');
  assert.equal(maybeFlushInBackground(home, now + 1), false, 'the saved timestamp suppresses the next caller');
  assert.equal(spawn.mock.callCount(), 1, 'exactly one helper for the window');
});

test('the same claim guards the update-check storm (#833)', () => {
  const home = tmpRepo('upkeep-claim');
  homes.push(home);
  mkdirSync(join(home, '.graft'), { recursive: true });
  const spawn = interceptSpawn();
  const now = 1_700_000_000_000;
  const claim = `${updateCachePath(home)}.claim`;
  writeFileSync(claim, JSON.stringify({ claimedAt: now })); // a concurrent winner, same millisecond
  for (let i = 0; i < 8; i++) {
    assert.equal(maybeRefreshInBackground(home, now, {}), false, `update-check caller ${i} must not spawn`);
  }
  assert.equal(spawn.mock.callCount(), 0, 'no storm behind a fresh claim');
  rmSync(claim);
  assert.equal(maybeRefreshInBackground(home, now, {}), true, 'one winner without a claim');
  assert.equal(spawn.mock.callCount(), 1, 'exactly one helper for the window');
});
