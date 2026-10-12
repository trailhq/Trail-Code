/**
 * The contract tests. These are the ones that matter: they assert that a call
 * site cannot send something the published `TELEMETRY.md` does not list, even if
 * it tries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENTS,
  countBucket,
  durationBucket,
  errorCode,
  filesBucket,
  isTrackedCommand,
  langsValue,
  savedTokensBucket,
} from '../src/telemetry/contract.js';
import { track } from '../src/telemetry/track.js';
import { peek } from '../src/telemetry/queue.js';
import { tmpRepo } from './helpers.js';

/** An env where every gate is open, so the allowlist is what's under test. */
const OPEN: NodeJS.ProcessEnv = {};

function sandbox(tag: string): string {
  const home = tmpRepo(tag);
  mkdirSync(join(home, '.graft'), { recursive: true });
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_key';
  return home;
}

// --- the allowlist ---

test('an event that is not in the contract is dropped whole', () => {
  const home = sandbox('tel-unknown-event');
  assert.equal(track('exfiltrate', { anything: 'here' }, { home, env: OPEN }), null);
  assert.deepEqual(peek(home), []);
});

test('an unlisted property is dropped, and the rest of the event survives', () => {
  const home = sandbox('tel-unknown-prop');
  const ev = track(
    'query',
    { command: 'ask', surface: 'cli', path: '/Users/someone/secret/repo/src/auth.ts' },
    { home, env: OPEN },
  );
  assert.ok(ev);
  assert.equal(ev.properties.command, 'ask');
  assert.equal(ev.properties.surface, 'cli');
  assert.equal('path' in ev.properties, false, 'a path must never survive the allowlist');
  assert.equal(JSON.stringify(ev).includes('secret'), false);
});

test('a non-string value is dropped even under an allowed key', () => {
  const home = sandbox('tel-nonstring');
  // A caller passing a raw count instead of a bucket: the key is legal, the
  // value is not, and the raw number must not reach the wire.
  const ev = track('build_completed', { files_bucket: 4127 as unknown as string }, { home, env: OPEN });
  assert.ok(ev);
  assert.equal('files_bucket' in ev.properties, false);
});

test('every event carries the common properties, and no identifier beyond them', () => {
  const home = sandbox('tel-common');
  const ev = track('first_run', {}, { home, env: OPEN });
  assert.ok(ev);
  for (const k of ['app_version', 'os', 'arch', 'node_major', 'ci', 'agent_host']) {
    assert.ok(k in ev.properties, `missing common property ${k}`);
  }
  // distinct_id is the random install uuid and nothing else.
  assert.match(ev.distinct_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// Pinned rather than counted, so adding an event is a deliberate edit here and
// a matching row in TELEMETRY.md, never something that arrives with a feature.
test('the contract lists exactly the twelve documented events', () => {
  assert.deepEqual(Object.keys(EVENTS).sort(), [
    'brain_signup_opened', 'brain_signup_settled', 'build_completed', 'build_failed',
    'first_run', 'init_completed', 'install', 'query', 'session_summary', 'trail_autopush', 'trail_pulled',
    'trail_watch_exit',
  ]);
});

test('only the known commands are tracked', () => {
  assert.equal(isTrackedCommand('ask'), true);
  assert.equal(isTrackedCommand('init'), false, 'init has its own event, not a query');
  assert.equal(isTrackedCommand('telemetry'), false);
  assert.equal(isTrackedCommand('_telemetry-flush'), false);
});

// --- buckets: no raw number ever crosses ---

test('filesBucket collapses a repo size to a label', () => {
  assert.equal(filesBucket(0), '0');
  assert.equal(filesBucket(1), '1-49');
  assert.equal(filesBucket(49), '1-49');
  assert.equal(filesBucket(50), '50-199');
  assert.equal(filesBucket(999), '200-999');
  assert.equal(filesBucket(4999), '1000-4999');
  assert.equal(filesBucket(5000), '5000+');
});

test('durationBucket collapses wall-clock to a label', () => {
  assert.equal(durationBucket(999), '<1s');
  assert.equal(durationBucket(1000), '1-5s');
  assert.equal(durationBucket(29_999), '5-30s');
  assert.equal(durationBucket(600_000), '10m+');
});

test('countBucket and savedTokensBucket cover their boundaries', () => {
  assert.equal(countBucket(0), '0');
  assert.equal(countBucket(4), '1-4');
  assert.equal(countBucket(5), '5-19');
  assert.equal(countBucket(200), '200+');
  assert.equal(savedTokensBucket(0), '0');
  assert.equal(savedTokensBucket(999), '<1k');
  assert.equal(savedTokensBucket(1000), '1-5k');
  assert.equal(savedTokensBucket(100_000), '100k+');
});

test('langsValue sorts, dedupes and caps so it cannot fingerprint a repo', () => {
  assert.equal(langsValue(['ts', 'go', 'TS']), 'go,ts');
  assert.equal(langsValue([]), '');
  assert.equal(langsValue(['a','b','c','d','e','f','g','h','i','j']).split(',').length, 8);
});

// --- error codes: a message is never a code ---

test('errorCode maps to the enum and never returns the message', () => {
  const err = new Error('cannot parse /Users/someone/private/src/secrets.ts:42');
  assert.equal(errorCode(err), 'E_PARSE');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'EACCES' })), 'E_PERMISSION');
  assert.equal(errorCode(Object.assign(new Error('x'), { status: 429 })), 'E_RATE_LIMIT');
  assert.equal(errorCode(new Error('something nobody classified')), 'E_UNKNOWN');
});

test('a build_failed event carries a code, never the error text', () => {
  const home = sandbox('tel-build-failed');
  const err = new Error('ENOENT: /Users/someone/private-repo/src/index.ts');
  const ev = track('build_failed', { stage: 'graph', code: errorCode(err) }, { home, env: OPEN });
  assert.ok(ev);
  assert.equal(JSON.stringify(ev).includes('private-repo'), false);
  assert.equal(ev.properties.stage, 'graph');
});

// --- the allowlist must reject by design, not by exception ---

test('a prototype key is not an event: EVENTS.constructor must not look like a hit', () => {
  const home = sandbox('tel-proto-event');
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(track(name, { command: 'ask' }, { home, env: OPEN }), null, `${name} was accepted`);
  }
  assert.deepEqual(peek(home), []);
});

test('a prototype key as a PROPERTY name is dropped like any other unlisted key', () => {
  const home = sandbox('tel-proto-prop');
  const ev = track('query', { command: 'ask', __proto__: 'x', constructor: 'y' } as never, { home, env: OPEN });
  assert.ok(ev);
  assert.equal(ev.properties.command, 'ask');
  assert.equal(Object.hasOwn(ev.properties, 'constructor'), false);
});

test('langsValue drops anything that is not a plain language token', () => {
  // The failure this guards: a value that carries file or path metadata rather
  // than a language name.
  assert.equal(langsValue(['ts', 'src/secret project/auth.ts']), 'ts');
  assert.equal(langsValue(['go', 'a'.repeat(40)]), 'go');
  assert.equal(langsValue(['ts', '../../etc/passwd']), 'ts');
  assert.equal(langsValue(['ts', 'my repo']), 'ts', 'a space is not a language token');
  // Real language labels survive, including the awkward ones.
  assert.equal(langsValue(['c++', 'c#', 'objective-c', 'f#']), 'c#,c++,f#,objective-c');
});

// --- the brain signup handoff ---

// The push handoff is the one flow that spans both products, and the outcome is
// the half that can vanish: a user who reads the URL and walks away kills the
// process. Only an event already queued survives that, which is why `opened` is
// the denominator and `settled` is not.
test('brain signup: the outcome is a category, never the sentence the user saw', () => {
  const home = sandbox('tel-brain-signup-outcome');
  const ev = track(
    'brain_signup_settled',
    {
      outcome: 'timed_out',
      duration_bucket: durationBucket(5 * 60 * 1000),
      error: 'timed out waiting for the browser — run `graft trail push` again',
    },
    { home, env: OPEN },
  );
  assert.equal(ev?.properties.outcome, 'timed_out');
  assert.equal(ev?.properties.duration_bucket, '2-10m');
  // The printed sentence names the repo and the link, so it must not ride along
  // even when a call site passes it.
  assert.equal(ev?.properties.error, undefined);
});

test('brain signup: opened carries only whether an agent ran it', () => {
  const home = sandbox('tel-brain-signup-opened');
  const ev = track('brain_signup_opened', { mode: 'agent', repo: 'acme/app', port: '51234' }, { home, env: OPEN });
  assert.ok(ev);
  assert.equal(ev.properties.mode, 'agent');
  assert.equal(ev.properties.repo, undefined);
  assert.equal(ev.properties.port, undefined);
});

test('brain signup: both events are in the contract', () => {
  assert.ok(EVENTS.brain_signup_opened);
  assert.ok(EVENTS.brain_signup_settled);
});

// --- trail pull ---

test('trail pull: counts travel as buckets, and a path never rides along', () => {
  const home = sandbox('tel-trail-pulled');
  const ev = track(
    'trail_pulled',
    { outcome: 'written', kinds: 'agents_md,claude_md', files_bucket: '1-4', changes_bucket: '5-19', skipped_bucket: '0', suggested_bucket: '20-49', path: 'web/CLAUDE.md' },
    { home, env: OPEN },
  );
  assert.equal(ev?.properties.outcome, 'written');
  assert.equal(ev?.properties.kinds, 'agents_md,claude_md');
  assert.equal(ev?.properties.changes_bucket, '5-19');
  assert.equal(ev?.properties.suggested_bucket, '20-49');
  assert.equal(ev?.properties.path, undefined);
});

// --- the trail watcher and the background push ---

test('trail_watch_exit carries buckets and a reason, never the files or the link', () => {
  const home = sandbox('tel-trail-watch');
  const ev = track(
    'trail_watch_exit',
    {
      reason: 'accepted',
      suggested_bucket: countBucket(9),
      accepted_bucket: countBucket(3),
      duration_bucket: durationBucket(61_000),
      files: 'CLAUDE.md (Commands)',
      review_url: 'https://app.trailhq.com/brain/b1/context-files',
    },
    { home, env: OPEN },
  );
  assert.equal(ev?.properties.reason, 'accepted');
  assert.equal(ev?.properties.suggested_bucket, '5-19');
  assert.equal(ev?.properties.accepted_bucket, '1-4');
  assert.equal(ev?.properties.duration_bucket, '30s-2m');
  assert.equal(JSON.stringify(ev).includes('CLAUDE.md'), false);
  assert.equal(JSON.stringify(ev).includes('trailhq'), false);
});

test('trail_autopush carries only whether it started and why not', () => {
  const home = sandbox('tel-trail-autopush');
  const ev = track('trail_autopush', { outcome: 'skipped', reason: 'throttled', head: 'a'.repeat(40) }, { home, env: OPEN });
  assert.equal(ev?.properties.outcome, 'skipped');
  assert.equal(ev?.properties.reason, 'throttled');
  assert.equal(ev?.properties.head, undefined);
});
