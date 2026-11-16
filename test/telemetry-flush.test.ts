import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync, type ChildProcess } from 'node:child_process';
import fs, { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { FLUSH_TTL_MS, maybeFlushInBackground } from '../src/telemetry/flush.js';
import { CI_ENV_VARS } from '../src/telemetry/gate.js';
import { readState, statePath } from '../src/telemetry/identity.js';
import { peek, queuePath } from '../src/telemetry/queue.js';
import { homeEnv, tmpRepo } from './helpers.js';

const EVENT = { event: 'query', properties: { command: 'ask' }, distinct_id: 'test-install' };
const ENV_KEYS = ['GRAFT_POSTHOG_KEY', 'DO_NOT_TRACK', ...CI_ENV_VARS];
let savedEnv: Record<string, string | undefined>;
let homes: string[];

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
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function queuedHome(): string {
  const home = tmpRepo('telemetry-flush');
  homes.push(home);
  mkdirSync(join(home, '.graft'));
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

test('a failed timestamp write leaves the queue intact and starts no helper', () => {
  const home = queuedHome();
  const state = readFileSync(statePath(home), 'utf8');
  const queue = readFileSync(queuePath(home), 'utf8');
  // Fail the atomic scratch-file write (its name is random, so nothing can be
  // planted in its place); this works on Windows and as root too.
  const openSync = fs.openSync;
  mock.method(fs, 'openSync', (path: fs.PathLike, ...rest: unknown[]) => {
    if (String(path).startsWith(`${statePath(home)}.`)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return (openSync as (...a: unknown[]) => number)(path, ...rest);
  });
  const spawn = interceptSpawn();

  assert.equal(maybeFlushInBackground(home, FLUSH_TTL_MS), false);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(readFileSync(statePath(home), 'utf8'), state);
  assert.equal(readFileSync(queuePath(home), 'utf8'), queue);
});

test('a saved timestamp permits one helper and suppresses another before expiry', () => {
  const home = queuedHome();
  const spawn = interceptSpawn();
  const now = FLUSH_TTL_MS;

  assert.equal(maybeFlushInBackground(home, now), true);
  assert.equal(readState(home)?.flushedAt, now);
  assert.equal(maybeFlushInBackground(home, now + FLUSH_TTL_MS - 1), false);
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(spawn.mock.calls[0].arguments[1]?.[1], '_telemetry-flush');
  assert.deepEqual(peek(home), [EVENT]);
});

test('the flush command sends its queue without starting upkeep or another flush', () => {
  const home = queuedHome();
  const state = readFileSync(statePath(home), 'utf8');
  // Stub before importing the real CLI, so even the broken code cannot recurse
  // or send data. Run in a child to isolate Commander and its process arguments.
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const spawns = [], batches = [];
    childProcess.spawn = (_file, args) => {
      spawns.push(args);
      return { unref() {} };
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (_url, options) => {
      batches.push(JSON.parse(options.body).batch);
      return { ok: true, status: 200 };
    };
    // The CLI parses process.argv as node's: [node, script, ...args].
    process.argv = [process.execPath, 'cli.ts', '_telemetry-flush'];
    process.once('beforeExit', () => console.log(JSON.stringify({ spawns, batches })));
    await import(${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)});
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    env: homeEnv(home), encoding: 'utf8', timeout: 30_000,
  });

  assert.equal(result.status, 0, result.stderr || String(result.error));
  const { spawns, batches } = JSON.parse(result.stdout.trim());
  assert.deepEqual(spawns, []);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[0][0].event, EVENT.event);
  assert.deepEqual(peek(home), []);
  assert.equal(readFileSync(statePath(home), 'utf8'), state);
});
