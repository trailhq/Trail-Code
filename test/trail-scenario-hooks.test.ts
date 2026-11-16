/**
 * Trail at the moments a session needs it, without waiting for the agent to
 * run a trail command: a file's learnings before the edit, `trail check`
 * before a commit, push or PR, the save signs for a conflict shipped anyway and
 * for a deploy step fixed, and the workspace link when a hook just put a
 * teammate's learning in front of the agent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { notesOnTouch } from '../src/claude/format.js';
import { noteAsk, noteSignals } from '../src/claude/note-signals.js';
import { SHIP_CHECK_STOPS, shipCheck, shipReason } from '../src/claude/pre-bash-check.js';
import { preBashContext } from '../src/claude/pre-bash.js';
import { SHIP_COMMAND } from '../src/claude/pre-bash.js';
import type { ShipConflict as CheckFinding } from '../src/claude/pre-bash-check.js';
import { hookNotice, linkedNews } from '../src/cloud/nudge.js';
import { writeNote, type Note } from '../src/notes/notes.js';
import { tmpRepo } from './helpers.js';

process.env.DO_NOT_TRACK = '1';
process.env[BRAND_ENV] = 'trail';
process.env.TRAIL_TEST_SERVER = 'http://trail.test';
process.env.TRAIL_NO_FETCH = '1';

let n = 0;
const uid = () => `u${++n}`;
const prompt = (text: string) => [{ type: 'user', uuid: uid(), message: { role: 'user', content: text } }];
function tool(name: string, input: object, out = 'ok', error = false) {
  const id = `tu${++n}`;
  return [
    { type: 'assistant', uuid: uid(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', uuid: uid(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out, is_error: error }] } },
  ];
}
const bash = (command: string, out = 'ok', error = false) => tool('Bash', { command }, out, error);
const REPO = '/work/app';
const edit = (file: string) => tool('Edit', { file_path: join(REPO, file), old_string: 'a', new_string: 'b' });
const jsonl = (...parts: object[][]) => parts.flat().map((e) => JSON.stringify(e)).join('\n');
const kinds = (text: string) => noteSignals(text, REPO).map((s) => s.kind);

const conflict: CheckFinding = {
  file: 'src/retry.ts',
  line: 12,
  verdict: 'conflict',
  summary: 'retries again on a 429',
  source: { kind: 'note', title: 'Retries trip the rate limit', author: 'Priya', path: '.trail/learnings/2026-10-07-retries-trip-priya.md' },
};

test('the learnings on a file are worded for the edit about to happen', () => {
  const note = { title: 'Retries trip the rate limit', path: '.trail/learnings/r.md', touches: ['src/retry.ts'], author: 'Priya', body: '## Decided\nThree retries.', date: '2026-10-07' } as unknown as Note;
  const text = notesOnTouch([note], { file: 'src/retry.ts', verb: 'editing' }, {});
  assert.match(text ?? '', /left on the file you're about to change, src\/retry\.ts\. Read it before going on/);
  assert.match(notesOnTouch([note], { file: 'src/retry.ts', verb: 'changed' }, {}) ?? '', /the file you just changed, src\/retry\.ts/);
});

test('a commit, a push and a PR are what the check runs before; nothing else pays for it', () => {
  for (const c of ['git commit -m "x"', 'cd app && git push origin HEAD', 'gh pr create --fill', 'git -C app push', 'git -c user.email=a@b.c -c user.name="A B" commit -am x', "git -c 'core.hooksPath=/dev/null' commit", 'git --no-pager commit -m x']) assert.ok(SHIP_COMMAND.test(c), c);
  for (const c of ['git status', 'git log --oneline', 'gh pr view 12', 'npm test', 'git -C app status', 'git log --grep commit', 'git show HEAD:push.md']) assert.ok(!SHIP_COMMAND.test(c), c);
});

test('for now a conflict warns before the commit, once per set of conflicts, and the commit runs', () => {
  assert.equal(SHIP_CHECK_STOPS, false, "a stop waits for trail check's matching to improve");
  const dir = tmpRepo('ship-warn');
  const input = { session_id: 'warn-1', tool_name: 'Bash', tool_input: { command: 'git commit -m "retry on 429"' } };
  const first = shipCheck(input, dir, 'git commit -m "retry on 429"', () => [conflict]);
  assert.ok(first && 'warn' in first, 'a warning, not a decision');
  assert.match(first.warn, /^trail check found 1 conflict with the team's learnings before this commit:\n- src\/retry\.ts:12: retries again on a 429 \(Retries trip the rate limit, Priya\)\n/);
  assert.match(first.warn, /It goes ahead; the check can flag a word match that isn't a real conflict\. Read each one: if it's real, fix the change next and tell the user; if not, carry on\./);
  assert.equal(shipCheck(input, dir, 'git commit -m "retry on 429"', () => [conflict]), null, 'said once');
  const out = JSON.parse(preBashContext(input, first.warn));
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName'], 'no permission decision: the command runs as it would have');
  assert.equal(preBashContext({ ...input, turn_id: 't1' }, first.warn), '', 'Codex has no field for it: nothing, and the command runs');
});

test("in a hook, with no TRAIL_INVOKED_AS, a repo wired for trail still gets the check; a graft repo doesn't", () => {
  const wired = tmpRepo('ship-wired');
  mkdirSync(join(wired, '.trail'), { recursive: true });
  writeFileSync(join(wired, '.trail', 'hook.cjs'), '');
  const input = { session_id: 'wired-1', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } };
  const found = shipCheck(input, wired, 'git commit -m x', () => [conflict], {});
  assert.ok(found && 'warn' in found, 'the check ran with no brand in the environment');
  const plain = tmpRepo('ship-graft');
  assert.equal(shipCheck({ ...input, session_id: 'wired-2' }, plain, 'git commit -m x', () => [conflict], {}), null);
});

test('with the stop on, a conflict stops the commit once, saying what and the way through; the same try again goes', () => {
  const dir = tmpRepo('ship-check');
  const input = { session_id: 'ship-1', tool_name: 'Bash', tool_input: { command: 'git commit -m "retry on 429"' } };
  const stop = (i: unknown, c: string, found: () => CheckFinding[] | null) => shipCheck(i, dir, c, found, process.env, true);
  const first = stop(input, 'git commit -m "retry on 429"', () => [conflict]);
  assert.ok(first && 'permissionDecision' in first);
  assert.equal(first.permissionDecision, 'deny');
  assert.match(first.reason, /^trail check found 1 conflict with the team's learnings before this commit:\n- src\/retry\.ts:12: retries again on a 429 \(Retries trip the rate limit, Priya\)\n/);
  assert.match(first.reason, /say why in the commit message or PR description and run the same command again: it goes through then\. If the learning no longer holds, save a new learning that says what changed, with `--replaces 2026-10-07-retries-trip-priya\.md`\./);
  assert.equal(stop(input, 'git commit -m "retry on 429"', () => [conflict]), null, 'the second try goes through');
  const other = { ...conflict, file: 'src/client.ts' };
  const again = stop(input, 'git push', () => [conflict, other]);
  assert.ok(again && 'permissionDecision' in again && again.permissionDecision === 'deny', 'a conflict it has not seen stops it again');
  assert.equal(stop({ ...input, session_id: 'ship-2' }, 'git commit', () => []), null, 'no conflict, no stop');
  assert.equal(stop({ ...input, session_id: 'ship-3' }, 'git commit', () => null), null, 'a check that could not say lets it run');
  assert.match(shipReason([conflict], 'gh pr create --fill', true), /before opening this PR:/);
});

test('a conflict the work shipped anyway, files untouched, asks for a replacing learning', () => {
  const stop = shipReason([conflict], 'git commit -m x', true);
  const overrode = jsonl(prompt('ship it'), edit('src/retry.ts'), bash('git commit -m x', stop, true), bash('git commit -m "x: 429 is retried once by design"'));
  assert.deepEqual(kinds(overrode), ['overrode', 'shipped']);
  const s = noteSignals(overrode, REPO)[0]!;
  assert.match(noteAsk(s), /^\[trail\] trail check found this change goes against a learning, and it shipped anyway\. If the learning no longer holds, save what changed and why/);
  assert.match(noteAsk(s), /--replaces <the old learning's file>/);

  const fixed = jsonl(prompt('ship it'), edit('src/retry.ts'), bash('git commit -m x', stop, true), edit('src/retry.ts'), bash('git commit -m x'));
  assert.ok(!kinds(fixed).includes('overrode'), 'the named file changed after the stop: fixed, not overridden');
  const byHand = jsonl(prompt('ship it'), edit('src/a.ts'), bash('trail check', '✗ src/a.ts:3\n  goes against …', true), bash('git push'));
  assert.ok(kinds(byHand).includes('overrode'), "trail check's own exit 1, then a push");
  assert.ok(!kinds(jsonl(prompt('x'), edit('src/a.ts'), bash('trail check', '✗ src/a.ts:3', true))).includes('overrode'), 'nothing shipped');
});

test('a check run from another folder (go -C, npm --prefix) is still a check', () => {
  const goC = jsonl(prompt('fix it'), bash('go -C backend test -run TestX ./internal/taskstate/ 2>&1 | tail -30', '--- FAIL: TestX\nFAIL'), edit('backend/internal/taskstate/apply.go'), bash('go -C backend test -count=1 ./internal/taskstate/', 'ok  \tgithub.com/x/taskstate\t0.9s'));
  assert.deepEqual(kinds(goC), ['fixed']);
  assert.match(noteSignals(goC, REPO)[0]!.what, /^go -C backend test failed once, then passed after your change to backend\/internal\/taskstate\/apply\.go\.$/);
  assert.deepEqual(kinds(jsonl(prompt('x'), bash('npm --prefix web test', '1 failed', true), edit('web/a.ts'), bash('npm --prefix web test', 'ok'))), ['fixed']);
});

test('a deploy or CI step that failed, then passed after an edit, is a fix', () => {
  const tf = jsonl(prompt('fix the plan'), bash('terraform plan', 'Error: Invalid reference', true), edit('infra/main.tf'), bash('terraform plan', 'Plan: 1 to add'));
  assert.deepEqual(kinds(tf), ['fixed']);
  const kube = jsonl(prompt('x'), bash('kubectl apply -f deploy/app.yml', 'error: unable', true), edit('deploy/app.yml'), bash('kubectl apply -f deploy/app.yml'));
  assert.deepEqual(kinds(kube), ['fixed']);
  assert.deepEqual(kinds(jsonl(prompt('x'), bash('docker build .', 'ERROR', true), edit('Dockerfile'), bash('docker build .'))), ['fixed']);
});

test('the workspace link reaches the person when a hook used trail: once a session, with why it comes now', () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'scenario-trail-home-'));
  process.env.TRAIL_CLOUD = '1';
  const dir = tmpRepo('hook-link');
  const git = (args: string[]) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir });
  git(['init', '-q', '-b', 'main']);
  git(['remote', 'add', 'origin', 'https://github.com/acme/hooks.git']);
  writeNote(dir, { title: 'Retries trip the rate limit', body: '## Decided\nThree retries.', author: 'Priya', date: '2026-10-07', touches: [] });
  const noWait = () => {};
  const shown = hookNotice(dir, "Claude just got your team's learnings for this", { session: 'h1', startWait: noWait });
  assert.match(shown ?? '', /^trail · Claude just got your team's learnings for this · Share your learnings with your team: sign in to Trail at http:\/\/trail\.test\/connect\?state=/);
  assert.equal(hookNotice(dir, 'again', { session: 'h1', startWait: noWait }), null, 'once a session');
  assert.match(hookNotice(dir, 'next', { session: 'h2', startWait: noWait }) ?? '', /^trail · next · /);
  assert.equal(linkedNews(), null, 'no news before connecting');
  delete process.env.TRAIL_CLOUD;
});
