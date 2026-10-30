/**
 * Under trail, a learning reaches the agent when it opens or changes a file the
 * learning lists, through the hooks on its own Read, Edit and shell calls, so it
 * arrives without the agent ever choosing to run trail. Once a session each.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { notesOnTouch } from '../src/claude/format.js';
import { main, withTouchLearnings } from '../src/claude/hooks.js';
import type { SessionState } from '../src/claude/state.js';
import { writeNote, type Note } from '../src/notes/notes.js';
import { otherCheckout } from '../src/notes/home.js';
import { CI_ENV_VARS } from '../src/telemetry/gate.js';
import { queuePath } from '../src/telemetry/queue.js';

const BODY = '## Decided\n- Take the workspace from server-held data.\n\n## Watch out\n- The request body is client-controlled.\n';
const note = (title: string, touches: string[], extra: Partial<Note> = {}): Note => ({ path: `/r/.trail/learnings/${title}.md`, title, author: 'Priya', date: '2026-10-07', touches, body: BODY, scope: 'repo', ...extra });
const session = (): SessionState => ({ lastQuery: null, perAgentQuery: {}, graftReads: 0, sourceReads: 0, savedTokens: 0 });

test('a learning comes with the file it lists, once a session', () => {
  const s = session();
  const notes = [note('workspace from server', ['tool/workspace.py#resolve']), note('unrelated', ['web/app.ts'])];
  const first = notesOnTouch(notes, { file: 'tool/workspace.py', verb: 'opened' }, s);
  assert.match(first ?? '', /a learning earlier sessions left on the file you just opened, tool\/workspace\.py/);
  assert.match(first ?? '', /from Priya's learning · .* · workspace from server/);
  assert.match(first ?? '', /decided {5}Take the workspace from server-held data\./);
  assert.doesNotMatch(first ?? '', /unrelated/);
  assert.equal(notesOnTouch(notes, { file: 'tool/workspace.py', verb: 'changed' }, s), null, 'once a session');
});

test('a shell command that names the file brings the learning, a longer path does not', () => {
  const notes = [note('a', ['src/a.ts'])];
  assert.notEqual(notesOnTouch(notes, { command: 'sed -n 1,40p src/a.ts' }, session()), null);
  assert.notEqual(notesOnTouch(notes, { command: 'npx tsx --test "src/a.ts"' }, session()), null);
  assert.equal(notesOnTouch(notes, { command: 'sed -n 1,40p src/a.tsx' }, session()), null);
  assert.equal(notesOnTouch(notes, { command: 'cat lib/src/a.ts.bak' }, session()), null);
});

test('standing learnings are left to the session-start list, and two at most come at once', () => {
  const notes = [note('rule', ['x.go'], { standing: true }), note('one', ['x.go']), note('two', ['x.go']), note('three', ['x.go'])];
  const text = notesOnTouch(notes, { file: 'x.go', verb: 'opened' }, session()) ?? '';
  assert.doesNotMatch(text, /· rule/);
  assert.match(text, /· one/);
  assert.match(text, /· two/);
  assert.doesNotMatch(text, /· three/);
});

async function hook(event: string, input: object): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  // Only the hook's strings: the test runner's own reports pass through, as the other hook tests do.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? ((out += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.env.GRAFT_TEST_STDIN = JSON.stringify(input);
  try {
    await main(event);
  } finally {
    process.stdout.write = write;
    delete process.env.GRAFT_TEST_STDIN;
  }
  return out;
}

test('the Read hook puts a committed learning in front of the agent', async () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'touch-home-'));
  process.env[BRAND_ENV] = 'trail';
  const d = mkdtempSync(join(tmpdir(), 'touch-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  mkdirSync(join(d, 'graft', '.cache', 'session'), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = d;
  writeNote(d, { title: 'Take workspace from server-held data', body: BODY, author: 'Priya', date: '2026-10-07', touches: ['tool/workspace.py'] }, 'repo');

  const out = await hook('tool-savings', { session_id: 't1', tool_name: 'Read', tool_input: { file_path: join(d, 'tool', 'workspace.py') }, tool_response: 'x' });
  const ctx = JSON.parse(out).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'PostToolUse');
  assert.match(ctx.additionalContext, /Take workspace from server-held data/);
  assert.equal(await hook('tool-savings', { session_id: 't1', tool_name: 'Read', tool_input: { file_path: join(d, 'tool', 'workspace.py') }, tool_response: 'x' }), '', 'once a session');
  assert.equal(await hook('tool-savings', { session_id: 't2', tool_name: 'Bash', tool_input: { command: 'trail skeleton tool/workspace.py' }, tool_response: 'x' }), '', "trail's own output already carries it");
  assert.match(await hook('tool-savings', { session_id: 't3', tool_name: 'Bash', tool_input: { command: 'sed -n 1,80p tool/workspace.py' }, tool_response: 'x' }), /Take workspace/);
});

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=Priya', '-c', 'user.email=p@acme.test', '-c', 'commit.gpgsign=false', ...args], { cwd });

/** A main checkout with a committed learning, and a worktree under `.claude/worktrees/` as Claude Desktop makes, with one more on its branch. The session's project is the main checkout. */
function worktreeSession(): { d: string; tree: string } {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'touch-home-'));
  process.env[BRAND_ENV] = 'trail';
  const d = mkdtempSync(join(tmpdir(), 'touch-repo-'));
  git(d, 'init', '-q', '-b', 'main');
  mkdirSync(join(d, 'graft', '.cache', 'session'), { recursive: true });
  writeNote(d, { title: 'Take workspace from server-held data', body: BODY, author: 'Priya', date: '2026-10-07', touches: ['tool/workspace.py'] }, 'repo');
  git(d, 'add', '.trail');
  git(d, 'commit', '-qm', 'learning');
  const tree = join(d, '.claude', 'worktrees', 'tidy');
  git(d, 'worktree', 'add', '-q', '-b', 'tidy', tree);
  writeNote(tree, { title: 'Pagination cursors are opaque', body: BODY, author: 'Kumar', date: '2026-10-08', touches: ['tool/pages.py'] }, 'repo');
  process.env.CLAUDE_PROJECT_DIR = d;
  return { d, tree };
}

test("in a worktree session, where the project is the main checkout, the worktree's copy of a file brings its learnings", async () => {
  const { d, tree } = worktreeSession();

  const read = await hook('tool-savings', { session_id: 'w1', tool_name: 'Read', tool_input: { file_path: join(tree, 'tool', 'workspace.py') }, tool_response: 'x' });
  assert.match(JSON.parse(read).hookSpecificOutput.additionalContext, /Take workspace from server-held data/);
  const edit = await hook('pre-edit', { session_id: 'w2', tool_name: 'Edit', tool_input: { file_path: join(tree, 'tool', 'pages.py'), old_string: 'a', new_string: 'b' } });
  assert.match(JSON.parse(edit).hookSpecificOutput.additionalContext, /Pagination cursors are opaque/, "a learning on the worktree's branch counts too");

  const elsewhere = mkdtempSync(join(tmpdir(), 'touch-other-'));
  git(elsewhere, 'init', '-q', '-b', 'main');
  assert.equal(otherCheckout(d, join(elsewhere, 'tool', 'workspace.py')), null, 'another repo is not this one');
  assert.equal(otherCheckout(d, join(d, 'tool', 'workspace.py')), null, 'the main checkout is the project already');
});

test('each learning that reaches the agent on touch is counted, with whether it came through a worktree', async () => {
  const keys = ['HOME', 'USERPROFILE', 'GRAFT_POSTHOG_KEY', 'GRAFT_POSTHOG_HOST', 'DO_NOT_TRACK', ...CI_ENV_VARS];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const home = mkdtempSync(join(tmpdir(), 'touch-telemetry-'));
  try {
    Object.assign(process.env, { HOME: home, USERPROFILE: home, GRAFT_POSTHOG_KEY: 'phc_test_key', GRAFT_POSTHOG_HOST: 'http://127.0.0.1:9' });
    for (const k of ['DO_NOT_TRACK', ...CI_ENV_VARS]) delete process.env[k];
    const { d, tree } = worktreeSession();
    await hook('tool-savings', { session_id: 'm1', tool_name: 'Read', tool_input: { file_path: join(tree, 'tool', 'workspace.py') }, tool_response: 'x' });
    await hook('tool-savings', { session_id: 'm2', tool_name: 'Read', tool_input: { file_path: join(d, 'tool', 'workspace.py') }, tool_response: 'x' });
    const sent = readFileSync(queuePath(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'learnings_on_touch');
    assert.deepEqual(sent.map((e) => [e.properties.via, e.properties.worktree]), [['read', 'true'], ['read', 'false']]);
  } finally {
    for (const k of keys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
});

test("a Bash call's learnings join the skills part's context in one answer, and a block stays the whole answer", () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'touch-home-'));
  process.env[BRAND_ENV] = 'trail';
  const d = mkdtempSync(join(tmpdir(), 'touch-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  mkdirSync(join(d, 'graft', '.cache', 'session'), { recursive: true });
  writeNote(d, { title: 'Take workspace from server-held data', body: BODY, author: 'Priya', date: '2026-10-07', touches: ['tool/workspace.py'] }, 'repo');
  const bash = (session_id: string) => ({ session_id, tool_name: 'Bash', tool_input: { command: 'cat tool/workspace.py' } });

  const held = withTouchLearnings({ block: 'stop here' }, bash('m1'), d);
  assert.deepEqual(held, { block: 'stop here' });
  const merged = withTouchLearnings({ context: 'skills context', notice: 'for the person' }, bash('m1'), d);
  assert.equal(merged.notice, 'for the person');
  assert.match(merged.context ?? '', /^skills context\n\n.*Take workspace from server-held data/s, 'not used up by the block');
  assert.match(withTouchLearnings({}, bash('m2'), d).context ?? '', /Take workspace/);
});

test('a learning with no measured cost is credited without a saving, never "· null"', () => {
  const out = notesOnTouch([note('workspace from server', ['tool/workspace.py'])], { file: 'tool/workspace.py', verb: 'opened' }, session()) ?? '';
  assert.doesNotMatch(out, /null/);
  assert.match(out, /\(e\.g\. "📝 Started from Anirudh's learning"\):/);
});
