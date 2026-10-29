/**
 * The contract tests. These are the ones that matter: they assert that a call
 * site cannot send something the published `TELEMETRY.md` does not list, even if
 * it tries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENTS,
  VALUES,
  countBucket,
  durationBucket,
  errorCode,
  filesBucket,
  hookMsBucket,
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
  for (const k of ['app_version', 'os', 'arch', 'node_major', 'ci', 'agent_host', 'cli_name']) {
    assert.ok(k in ev.properties, `missing common property ${k}`);
  }
  // distinct_id is the random install uuid and nothing else.
  assert.match(ev.distinct_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// Pinned rather than counted, so adding an event is a deliberate edit here and
// a matching row in TELEMETRY.md, never something that arrives with a feature.
test('the contract lists exactly the twenty-seven documented events', () => {
  assert.deepEqual(Object.keys(EVENTS).sort(), [
    'brain_signup_opened', 'brain_signup_settled', 'build_completed', 'build_failed',
    'cold_start', 'first_run', 'guardrail', 'hook_ms', 'init_completed', 'install', 'learnings_committed', 'note_saved', 'overlap_acted', 'overlap_warned', 'query', 'repo_seen', 'session_summary',
    'skill_answer', 'skill_changed', 'skill_offered', 'skill_promoted', 'skill_saved', 'skill_stale', 'skill_used', 'skill_value', 'team_pull', 'wall_hit',
  ]);
});

// --- the skills events (spec section 20): counts and closed sets, never content ---

/** Each skills event with the keys it may carry, as the spec lists them. */
const SKILL_EVENTS: Record<string, string[]> = {
  skill_offered: ['moment'],
  skill_answer: ['answer'],
  skill_saved: ['from', 'scope'],
  skill_changed: ['op'],
  skill_value: ['channel'],
  skill_promoted: ['to'],
  team_pull: ['outcome'],
  skill_used: ['outcome'],
  skill_stale: ['reason'],
  guardrail: ['class', 'outcome'],
  wall_hit: ['class', 'had_lesson'],
  hook_ms: ['event', 'bucket'],
};

test('learning_reused is gone: it counted learnings before they were deduped', () => {
  const home = sandbox('tel-no-reuse');
  assert.equal(track('learning_reused', { teammate: 'true', saved_tokens_bucket: '1-5k' }, { home, env: OPEN }), null);
  assert.equal(track('takeaway_saved', { new_skill: 'true' }, { home, env: OPEN }), null, 'trail learn is gone, and its event with it');
  assert.doesNotMatch(readFileSync(join(process.cwd(), 'src', 'cli.ts'), 'utf8'), /learning_reused/);
});

test('each skills event carries exactly the keys the spec lists, and every key has a closed set of values', () => {
  for (const [event, keys] of Object.entries(SKILL_EVENTS)) {
    assert.deepEqual([...EVENTS[event]!].sort(), [...keys].sort(), event);
    for (const k of keys) assert.ok(VALUES[event]?.[k]?.size, `${event}.${k} has no closed set`);
  }
  assert.deepEqual([...VALUES.skill_answer!.answer!].sort(), ['no', 'none', 'off', 'retire', 'show', 'yes']);
  assert.deepEqual([...VALUES.skill_saved!.scope!].sort(), ['personal', 'repo', 'team']);
  assert.deepEqual([...VALUES.skill_promoted!.to!].sort(), ['repo', 'team']);
  assert.deepEqual([...VALUES.skill_used!.outcome!].sort(), ['checked', 'failed', 'unchecked']);
  assert.deepEqual([...VALUES.wall_hit!.had_lesson!].sort(), ['false', 'true']);
});

test('a skills event drops content-like keys: names, titles, steps, commands, prompts and paths never go', () => {
  const home = sandbox('tel-skill-content-keys');
  const content = {
    name: 'release-npm',
    title: 'Release to npm',
    description: 'Publishes the package to npm',
    steps: 'git pull --ff-only origin main',
    command: 'npm publish',
    prompt: 'pull and publish 0.22.1',
    text: 'you forgot to push the tag',
    path: '/home/dev/acme/.agents/skills/release-npm/SKILL.md',
    repo: 'acme/api',
    skill: 'release-npm',
    lesson: 'push the tag first',
  };
  for (const [event, keys] of Object.entries(SKILL_EVENTS)) {
    const legal = Object.fromEntries(keys.map((k) => [k, [...VALUES[event]![k]!][0]!]));
    const ev = track(event, { ...content, ...legal }, { home, env: OPEN });
    assert.ok(ev, event);
    for (const k of Object.keys(content)) assert.equal(Object.hasOwn(ev.properties, k), false, `${event} kept ${k}`);
    for (const k of keys) assert.equal(ev.properties[k], legal[k], `${event}.${k}`);
    const wire = JSON.stringify(ev);
    for (const v of Object.values(content)) assert.equal(wire.includes(v), false, `${event} carried "${v}"`);
  }
});

test('a skills event drops a value outside its closed set, even under an allowed key', () => {
  const home = sandbox('tel-skill-content-values');
  const offered = track('skill_offered', { moment: 'pull and publish 0.22.1' }, { home, env: OPEN });
  assert.ok(offered);
  assert.equal(Object.hasOwn(offered.properties, 'moment'), false, 'a prompt is not a moment');
  const used = track('skill_used', { outcome: 'release-npm' }, { home, env: OPEN });
  assert.equal(Object.hasOwn(used!.properties, 'outcome'), false, 'a skill name is not an outcome');
  const wall = track('wall_hit', { class: 'npm ERR! code E401 /home/dev/.npmrc', had_lesson: 'true' }, { home, env: OPEN });
  assert.equal(Object.hasOwn(wall!.properties, 'class'), false, 'error text is not a class');
  assert.equal(wall!.properties.had_lesson, 'true');
  const ms = track('hook_ms', { event: 'prompt', bucket: '137' }, { home, env: OPEN });
  assert.equal(ms!.properties.event, 'prompt');
  assert.equal(Object.hasOwn(ms!.properties, 'bucket'), false, 'a raw number is not a bucket');
  assert.equal(track('hook_ms', { event: 'prompt', bucket: hookMsBucket(137) }, { home, env: OPEN })!.properties.bucket, '100-300ms');
});

test('no event in the contract has a key that names content', () => {
  const contentKeys = /^(name|title|text|body|prompt|query|path|file|files|steps?|skill|lesson|description|message|error|url|repo|remote|branch)$/;
  for (const [event, keys] of Object.entries(EVENTS)) for (const k of keys) assert.doesNotMatch(k, contentKeys, `${event}.${k}`);
});

test('hookMsBucket collapses a hook time to a label', () => {
  assert.equal(hookMsBucket(0), '<50ms');
  assert.equal(hookMsBucket(49), '<50ms');
  assert.equal(hookMsBucket(50), '50-100ms');
  assert.equal(hookMsBucket(299), '100-300ms');
  assert.equal(hookMsBucket(300), '300ms-1s');
  assert.equal(hookMsBucket(2999), '1-3s');
  assert.equal(hookMsBucket(60_000), '3s+');
});

// TELEMETRY.md is the published contract: an event or key it doesn't list must not be sendable.
test('TELEMETRY.md lists every event and every key the contract allows, and no event the contract lacks', () => {
  const doc = readFileSync(join(process.cwd(), 'TELEMETRY.md'), 'utf8');
  const rows = new Map<string, string>();
  for (const line of doc.split(/\r?\n/)) {
    const m = /^\| `([a-z_]+)` \|(.*)$/.exec(line);
    if (m && !['app_version', 'os', 'arch', 'node_major', 'ci', 'agent_host', 'cli_name', 'repo_id'].includes(m[1]!)) rows.set(m[1]!, m[2]!);
  }
  assert.deepEqual([...rows.keys()].sort(), Object.keys(EVENTS).sort());
  for (const [event, keys] of Object.entries(EVENTS)) {
    for (const k of keys) assert.ok(rows.get(event)!.includes(`\`${k}\``), `TELEMETRY.md's ${event} row doesn't name ${k}`);
    for (const [k, values] of Object.entries(VALUES[event] ?? {})) for (const v of values) assert.ok(rows.get(event)!.includes(`\`${v}\``), `TELEMETRY.md's ${event} row doesn't name ${k} value ${v}`);
  }
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
      error: 'timed out waiting for the browser — run `trail login` again',
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
