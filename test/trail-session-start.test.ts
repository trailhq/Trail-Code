/**
 * The session-start hook's two trail jobs: one line of context when the trail
 * has something waiting, and a background push at most once a day when HEAD has
 * moved. Both run inside a hook, so the tests are mostly about when they do
 * nothing — no trail, nothing waiting, Trail too slow, HEAD where it was, a push
 * already today — and about never reaching the network or spawning for a repo
 * without a trail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main, trailAtSessionStart } from '../src/claude/hooks.js';
import {
  AUTOPUSH_INTERVAL_MS,
  decideAutopush,
  maybeAutopush,
  readTrailPushState,
  recordTrailPush,
  trailPushStatePath,
} from '../src/brain/autopush.js';
import { writeLink, type BrainLink } from '../src/brain/link.js';
import { patchBuildConfig } from '../src/util/state.js';
import { tmpRepo } from './helpers.js';

const link: BrainLink = { brainId: 'b1', token: 'gbt_1.x', baseUrl: 'http://trail.test' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function linkedRepo(tag: string): string {
  const root = tmpRepo(tag);
  writeLink(root, link);
  return root;
}

/** A Trail with `suggested` CLAUDE.md suggestions and these accepted changes. */
function fakeTrail(suggested: number, claudeMd: unknown[] = []) {
  let calls = 0;
  const f = (async (u: string) => {
    calls++;
    const path = new URL(u).pathname;
    if (path.endsWith('/claude-md')) return json({ path: 'CLAUDE.md', head_sha: 'abc', changes: claudeMd });
    if (path.endsWith('/context-files')) return json({ head_sha: 'abc', files: [] });
    if (path.endsWith('/repo')) return json({ repo: { status: 'completed', rule_count: 3 }, claude_md: { changes: suggested } });
    return json({}, 500);
  }) as typeof fetch;
  return { f, calls: () => calls };
}

/** Autopush deps that never touch git or spawn anything. */
function noPush() {
  const started: string[] = [];
  return { started, deps: { head: () => 'a'.repeat(40), start: (r: string) => (started.push(r), true), env: {} } };
}

// --- the context line ---------------------------------------------------------

test('accepted changes waiting: the line names the files and asks about a pull', async () => {
  const root = linkedRepo('ss-accepted');
  writeFileSync(join(root, 'CLAUDE.md'), '# app\n\n## Commands\n\n- `npm test`\n');
  const { f } = fakeTrail(9, [
    { id: 'm1', kind: 'edit', heading: 'Commands', find: '', text: '- lint' },
    { id: 'm2', kind: 'add', heading: 'Testing', after_heading: 'Commands', text: 'node:test' },
  ]);
  const line = await trailAtSessionStart(root, { fetchImpl: f, autopush: noPush().deps });
  assert.equal(line, 'Trail: 2 accepted changes are waiting (CLAUDE.md: Commands, Testing). Ask the user whether to run graft trail pull.');
});

test('only suggestions: the line points at the review page', async () => {
  const root = linkedRepo('ss-suggested');
  const { f } = fakeTrail(5);
  const line = await trailAtSessionStart(root, { fetchImpl: f, autopush: noPush().deps });
  assert.match(line ?? '', /^Trail: 5 suggestions are waiting for review at \S+\/brain\/b1\/context-files\.$/);
});

test('the same suggestions next session say nothing; more say only how many are new', async () => {
  const root = linkedRepo('ss-repeat');
  const push = noPush().deps;
  const first = await trailAtSessionStart(root, { fetchImpl: fakeTrail(5).f, autopush: push });
  assert.match(first ?? '', /^Trail: 5 suggestions are waiting for review at /, 'first check with nothing stored: mentioned once');
  assert.equal(readTrailPushState(root).seenSuggested, 5);

  assert.equal(await trailAtSessionStart(root, { fetchImpl: fakeTrail(5).f, autopush: push }), null, 'unchanged: no nag');

  const grown = await trailAtSessionStart(root, { fetchImpl: fakeTrail(8).f, autopush: push });
  assert.match(grown ?? '', /^Trail: 3 new suggestions since your last session are waiting for review at \S+\/brain\/b1\/context-files\.$/);
  assert.equal(readTrailPushState(root).seenSuggested, 8);

  const one = await trailAtSessionStart(root, { fetchImpl: fakeTrail(9).f, autopush: push });
  assert.match(one ?? '', /^Trail: 1 new suggestion since your last session is waiting for review at /);
  assert.equal(await trailAtSessionStart(root, { fetchImpl: fakeTrail(9).f, autopush: push }), null);
});

test('accepted changes are mentioned every session, and still move the suggestions mark', async () => {
  const root = linkedRepo('ss-accepted-repeat');
  const accepted = [{ id: 'm1', kind: 'add', heading: 'Money', after_heading: '', text: 'Integer cents.' }];
  const push = noPush().deps;
  for (let i = 0; i < 2; i++) {
    const line = await trailAtSessionStart(root, { fetchImpl: fakeTrail(6, accepted).f, autopush: push });
    assert.equal(line, 'Trail: 1 accepted change is waiting (CLAUDE.md: Money). Ask the user whether to run graft trail pull.');
  }
  assert.equal(readTrailPushState(root).seenSuggested, 6);
  // Pulled since: the six suggestions were already known, so nothing to say.
  assert.equal(await trailAtSessionStart(root, { fetchImpl: fakeTrail(6).f, autopush: push }), null);
});

test('a failed check leaves the suggestions mark where it was', async () => {
  const root = linkedRepo('ss-mark-kept');
  const push = noPush().deps;
  await trailAtSessionStart(root, { fetchImpl: fakeTrail(4).f, autopush: push });
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.equal(await trailAtSessionStart(root, { fetchImpl: down, autopush: push }), null);
  assert.equal(readTrailPushState(root).seenSuggested, 4);
  assert.match((await trailAtSessionStart(root, { fetchImpl: fakeTrail(7).f, autopush: push })) ?? '', /^Trail: 3 new suggestions/);
});

test('nothing waiting: no line', async () => {
  const root = linkedRepo('ss-zero');
  assert.equal(await trailAtSessionStart(root, { fetchImpl: fakeTrail(0).f, autopush: noPush().deps }), null);
});

test('no trail attached: no line, no request, no push', async () => {
  const root = tmpRepo('ss-unlinked');
  const { f, calls } = fakeTrail(5);
  const push = noPush();
  assert.equal(await trailAtSessionStart(root, { fetchImpl: f, autopush: push.deps }), null);
  assert.equal(calls(), 0);
  assert.deepEqual(push.started, []);
  assert.equal(existsSync(trailPushStatePath(root)), false);
});

test('a Trail that does not answer costs the cap and no more', async () => {
  const root = linkedRepo('ss-slow');
  // Ignores the abort signal on purpose: the race, not the abort, is the guarantee.
  const never = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  const t0 = Date.now();
  const line = await trailAtSessionStart(root, { fetchImpl: never, capMs: 50, autopush: noPush().deps });
  assert.equal(line, null);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('a failing Trail is a missing line, never an error', async () => {
  const root = linkedRepo('ss-down');
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.equal(await trailAtSessionStart(root, { fetchImpl: down, autopush: noPush().deps }), null);
});

test('session-start puts the trail line in the context it emits', async () => {
  const root = linkedRepo('ss-main');
  const realFetch = globalThis.fetch;
  const writes: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  globalThis.fetch = fakeTrail(3).f;
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.GRAFT_TEST_STDIN = '{}';
  // Off, so this end-to-end run never spawns a real push.
  process.env.GRAFT_TRAIL_AUTOPUSH = '0';
  (process.stdout as { write: unknown }).write = (chunk: string) => (writes.push(String(chunk)), true);
  try {
    await main('session-start');
  } finally {
    (process.stdout as { write: unknown }).write = realWrite;
    globalThis.fetch = realFetch;
    delete process.env.GRAFT_TEST_STDIN;
    delete process.env.GRAFT_TRAIL_AUTOPUSH;
  }
  const out = JSON.parse(writes.join(''));
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /Trail: 3 suggestions are waiting for review at /);
});

// --- the background push --------------------------------------------------------

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const NOW = 1_700_000_000_000;

test('decideAutopush: every reason not to push, and the one to', () => {
  const base = { linked: true, enabled: true, head: NEXT, state: {}, now: NOW };
  assert.deepEqual(decideAutopush({ ...base, linked: false }), { start: false, reason: 'no_trail' });
  assert.deepEqual(decideAutopush({ ...base, enabled: false }), { start: false, reason: 'disabled' });
  assert.deepEqual(decideAutopush({ ...base, head: null }), { start: false, reason: 'no_head' });
  assert.deepEqual(decideAutopush({ ...base, state: { pushedHead: NEXT } }), { start: false, reason: 'head_unchanged' });
  assert.deepEqual(decideAutopush({ ...base, state: { autoPushHead: NEXT, autoPushAt: 0 } }), { start: false, reason: 'head_unchanged' });
  assert.deepEqual(
    decideAutopush({ ...base, state: { pushedHead: HEAD, autoPushAt: NOW - AUTOPUSH_INTERVAL_MS + 1 } }),
    { start: false, reason: 'throttled' },
  );
  assert.deepEqual(decideAutopush({ ...base, state: { pushedHead: HEAD, autoPushAt: NOW - AUTOPUSH_INTERVAL_MS } }), { start: true, head: NEXT });
  assert.deepEqual(decideAutopush(base), { start: true, head: NEXT }, 'no push recorded counts as moved');
});

test('autopush starts once, stamps first, and is then throttled for a day', () => {
  const root = linkedRepo('ap-throttle');
  const started: string[] = [];
  const start = (r: string) => (started.push(r), true);
  recordTrailPush(root, HEAD, NOW - 3 * AUTOPUSH_INTERVAL_MS);

  assert.deepEqual(maybeAutopush(root, { env: {}, now: NOW, head: () => NEXT, start }), { start: true, head: NEXT });
  assert.deepEqual(started, [root]);
  assert.equal(readTrailPushState(root).autoPushAt, NOW);
  assert.equal(readTrailPushState(root).autoPushHead, NEXT);

  // Another commit an hour later: still today's push.
  const later = 'c'.repeat(40);
  assert.deepEqual(maybeAutopush(root, { env: {}, now: NOW + 3_600_000, head: () => later, start }), { start: false, reason: 'throttled' });
  // A day on, it may go again.
  assert.deepEqual(maybeAutopush(root, { env: {}, now: NOW + AUTOPUSH_INTERVAL_MS, head: () => later, start }), { start: true, head: later });
  assert.equal(started.length, 2);
});

test('autopush skips a HEAD the last push already covered', () => {
  const root = linkedRepo('ap-unchanged');
  recordTrailPush(root, HEAD, NOW - 5 * AUTOPUSH_INTERVAL_MS);
  const started: string[] = [];
  const d = maybeAutopush(root, { env: {}, now: NOW, head: () => HEAD, start: (r) => (started.push(r), true) });
  assert.deepEqual(d, { start: false, reason: 'head_unchanged' });
  assert.deepEqual(started, []);
});

test('autopush never runs for a repo without a saved trail', () => {
  const unlinked = tmpRepo('ap-none');
  let headRead = false;
  const start = () => {
    throw new Error('must not start');
  };
  const head = () => ((headRead = true), HEAD);
  assert.deepEqual(maybeAutopush(unlinked, { env: {}, now: NOW, head, start }), { start: false, reason: 'no_trail' });
  assert.equal(headRead, false, 'not even HEAD is read');
  assert.equal(existsSync(trailPushStatePath(unlinked)), false);

  // A link from the environment alone is CI's way of attaching a trail: no push from a hook there either.
  process.env.GRAFT_BRAIN_TOKEN = 'gbt_env';
  process.env.GRAFT_BRAIN_ID = 'b-env';
  try {
    assert.deepEqual(maybeAutopush(unlinked, { env: {}, now: NOW, head, start }), { start: false, reason: 'no_trail' });
  } finally {
    delete process.env.GRAFT_BRAIN_TOKEN;
    delete process.env.GRAFT_BRAIN_ID;
  }
});

test('autopush is off with GRAFT_TRAIL_AUTOPUSH=0 or trailAutoPush: false', () => {
  const root = linkedRepo('ap-off');
  const start = () => {
    throw new Error('must not start');
  };
  assert.deepEqual(maybeAutopush(root, { env: { GRAFT_TRAIL_AUTOPUSH: '0' }, now: NOW, head: () => NEXT, start }), { start: false, reason: 'disabled' });
  patchBuildConfig(root, { trailAutoPush: false });
  assert.deepEqual(maybeAutopush(root, { env: {}, now: NOW, head: () => NEXT, start }), { start: false, reason: 'disabled' });
  assert.equal(readTrailPushState(root).autoPushAt, undefined, 'nothing stamped when off');
});

test('a spawn that fails is reported, and still counts as today\'s attempt', () => {
  const root = linkedRepo('ap-spawn-fail');
  mkdirSync(join(root, '.graft'), { recursive: true });
  assert.deepEqual(maybeAutopush(root, { env: {}, now: NOW, head: () => NEXT, start: () => false }), { start: false, reason: 'spawn_failed' });
  assert.equal(readTrailPushState(root).autoPushAt, NOW);
});
