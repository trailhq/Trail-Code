/**
 * Under trail, a learning reaches the agent when it opens or changes a file the
 * learning lists, through the hooks on its own Read, Edit and shell calls, so it
 * arrives without the agent ever choosing to run trail. Once a session each.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { notesOnTouch } from '../src/claude/format.js';
import { main, withTouchLearnings } from '../src/claude/hooks.js';
import type { SessionState } from '../src/claude/state.js';
import { writeNote, type Note } from '../src/notes/notes.js';

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
  assert.match(out, /\(e\.g\. "📝 Started from Anirudh's learning"\), and in this reply only, end that line with " · did it help\? 👍\/👎":/);
});
