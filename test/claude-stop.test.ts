/**
 * The one Stop handler (src/claude/stop.ts). A sign in the transcript (#663:
 * here a check that failed, then passed after an edit) ends the turn with
 * #663's ask to save a learning, once per sign; otherwise Stop writes nothing,
 * while the turn-end bookkeeping (the cost of the turn, the background graph
 * sync) still runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { main } from '../src/claude/hooks.js';
import { handleStopEvent, stopTakesContext, transcriptVersion } from '../src/claude/stop.js';
import { emptyStats, readSession, readStats, writeStats } from '../src/claude/state.js';
import { ensureRepoHome } from '../src/notes/home.js';

const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const call = (command: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: Math.random().toString(36), name: 'Bash', input: { command } }] } });
const result = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
let ids = 0;
/** A Bash call with its own result, so a failed one reads as failed. */
const bash = (command: string, out = 'ok', error = false) => {
  const id = `tu${++ids}`;
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out, is_error: error }] } },
  ];
};
const jsonl = (entries: object[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Everything a call writes to stdout. */
async function captured(fn: () => unknown): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? ((out += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

async function stop(stdin: string): Promise<string> {
  process.env.GRAFT_TEST_STDIN = stdin;
  try {
    return await captured(() => main('stop'));
  } finally {
    delete process.env.GRAFT_TEST_STDIN;
  }
}

/** A repo under trail that keeps learnings, the case the old ask fired in. */
function trailRepo(): { dir: string; transcript: string } {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'stop-home-'));
  process.env[BRAND_ENV] = 'trail';
  const dir = mkdtempSync(join(tmpdir(), 'stop-repo-'));
  mkdirSync(join(dir, 'graft', '.cache', 'session'), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = dir;
  ensureRepoHome(dir);
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, jsonl([prompt('why does the retry hang'), call('trail ask "retry"'), result(), call('sed -n 1,9p client.go'), result(), call('go test ./...'), result(), call('grep -n x client.go'), result()]));
  return { dir, transcript };
}

test("a turn of digging asks nothing; a check that failed, then passed after an edit, gets #663's ask, once per sign", async () => {
  const { dir, transcript } = trailRepo();
  assert.equal(await stop(JSON.stringify({ session_id: 's0', transcript_path: transcript })), '', 'tool calls alone are no sign');
  const fixed = join(dir, 'fixed.jsonl');
  writeFileSync(fixed, jsonl([prompt('fix the retry'), ...bash('go test ./...', 'FAIL', true), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(dir, 'client.go'), old_string: 'a', new_string: 'b' } }] } }, ...bash('go test ./...', 'ok')]));
  for (const session of ['s1', 's2']) {
    const out = JSON.parse(await stop(JSON.stringify({ session_id: session, transcript_path: fixed })));
    assert.equal(out.decision, 'block', `the ask in ${session}`);
    assert.match(out.reason, /^\[trail\] go test failed once, then passed after your change to client\.go\./);
    assert.equal(await stop(JSON.stringify({ session_id: session, transcript_path: fixed })), '', `once in ${session}`);
  }
});

test('the Stop hook writes nothing, whatever it is given', async () => {
  const { transcript } = trailRepo();
  for (const stdin of ['{}', 'not json', '[]', 'null', JSON.stringify({ session_id: 's1', transcript_path: transcript, stop_hook_active: true }), JSON.stringify({ session_id: 's1', transcript_path: '/no/such/file.jsonl' })]) {
    assert.equal(await stop(stdin), '', stdin);
  }
});

test('handleStopEvent still bills the turn and starts the background sync', async () => {
  const { dir } = trailRepo();
  const t = join(dir, 'billed.jsonl');
  writeFileSync(t, jsonl([
    prompt('a question'),
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', id: 'msg_1', model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } } },
  ]));
  writeStats(dir, { ...emptyStats(), dirty: true });
  const syncRun = join(dir, 'sync-run-stub.js');
  writeFileSync(syncRun, '// test stub: spawned as a detached no-op child\n');
  process.env.GRAFT_TEST_SYNC_RUN = syncRun;
  try {
    const out = await captured(() => handleStopEvent({ session_id: 's1', transcript_path: t }, dir));
    assert.equal(out, '');
  } finally {
    delete process.env.GRAFT_TEST_SYNC_RUN;
  }
  const s = readSession(dir, 's1');
  assert.equal(s.inputTokensBilled, 100, 'the turn was billed');
  assert.equal(s.inputCostMicros, 500, '100 tokens at $5/Mtok');
  assert.equal(readStats(dir)?.syncing, true, 'a dirty graph starts its sync');
});

test('handleStopEvent takes any input without throwing or writing', async () => {
  const { dir } = trailRepo();
  for (const input of [null, undefined, 'x', 7, [], { session_id: 42, transcript_path: {} }]) {
    assert.equal(await captured(() => handleStopEvent(input, dir)), '', String(JSON.stringify(input)));
  }
});

/** The fix-after-a-failure transcript, every entry stamped with the Claude Code `version` that wrote it, as Claude Code does. */
function fixedAt(dir: string, version: string | null): string {
  const t = join(dir, `fixed-${version ?? 'none'}.jsonl`);
  const entries = [prompt('fix the retry'), ...bash('go test ./...', 'FAIL', true), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(dir, 'client.go'), old_string: 'a', new_string: 'b' } }] } }, ...bash('go test ./...', 'ok')];
  writeFileSync(t, jsonl(version === null ? entries : entries.map((e) => ({ ...e, version }))));
  return t;
}

test('Claude Code 2.1.163 and later get the ask as Stop additionalContext, so it never reads "Stop hook error"; older builds get the block', async () => {
  const { dir } = trailRepo();
  for (const [version, session] of [['2.1.163', 'v1'], ['2.1.317', 'v2'], ['2.2.0', 'v3']] as const) {
    const out = JSON.parse(await stop(JSON.stringify({ session_id: session, transcript_path: fixedAt(dir, version) })));
    assert.equal(out.decision, undefined, version);
    assert.equal(out.hookSpecificOutput.hookEventName, 'Stop', version);
    assert.match(out.hookSpecificOutput.additionalContext, /^\[trail\] go test failed once, then passed after your change to client\.go\./, version);
  }
  for (const [version, session] of [['2.1.162', 'o1'], ['2.0.999', 'o2'], [null, 'o3']] as const) {
    const out = JSON.parse(await stop(JSON.stringify({ session_id: session, transcript_path: fixedAt(dir, version) })));
    assert.equal(out.decision, 'block', String(version));
    assert.match(out.reason, /^\[trail\] go test failed once/, String(version));
  }
  // The stop that follows either form has stop_hook_active (Claude Code 2.1.317), and asks nothing.
  assert.equal(await stop(JSON.stringify({ session_id: 'v4', transcript_path: fixedAt(dir, '2.1.317'), stop_hook_active: true })), '');
});

test('only Claude Code\'s main agent, by its transcript\'s version, takes the Stop as additionalContext; anything else keeps the block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stop-ctx-'));
  const t = join(dir, 'a.jsonl');
  writeFileSync(t, jsonl([{ type: 'user', version: '2.1.100', message: { role: 'user', content: 'x' } }, { type: 'assistant', version: '2.1.317', message: { role: 'assistant', content: [] } }]) + '{"type":"assistant","vers');
  assert.equal(transcriptVersion(t), '2.1.317', 'the last whole entry that names one; a cut line is skipped');
  const claude = { session_id: 's1', transcript_path: t, hook_event_name: 'Stop' };
  assert.equal(stopTakesContext(claude, {}), true);
  assert.equal(stopTakesContext({ ...claude, agent_id: 'a1' }, {}), false, 'a subagent');
  assert.equal(stopTakesContext(claude, { CLAUDE_CODE_SIMPLE: '1' }), false, 'a bare run ends the turn on it');
  assert.equal(stopTakesContext(claude, { CLAUDE_CODE_SIMPLE: '0' }), true, 'Desktop sets it to 0');
  assert.equal(stopTakesContext({ ...claude, turn_id: 'x' }, {}), false, 'Codex');
  assert.equal(stopTakesContext({ ...claude, timestamp: '2026-11-16T00:00:00Z' }, {}), false, 'Copilot CLI on a .claude/settings.json');
  assert.equal(stopTakesContext({ ...claude, conversation_id: 'c' }, {}), false, 'Cursor');
  assert.equal(stopTakesContext({ ...claude, transcript_path: join(dir, 'gone.jsonl') }, {}), false, 'no transcript to read');
  const none = join(dir, 'none.jsonl');
  writeFileSync(none, jsonl([{ type: 'user', message: { role: 'user', content: 'x' } }]));
  assert.equal(transcriptVersion(none), null);
  assert.equal(stopTakesContext({ ...claude, transcript_path: none }, {}), false, 'no version');
  // A last line longer than the tail read leaves no whole entry: unknown, so the block.
  const long = join(dir, 'long.jsonl');
  writeFileSync(long, jsonl([{ type: 'user', version: '2.1.317', message: { role: 'user', content: 'x' } }]));
  appendFileSync(long, JSON.stringify({ type: 'user', version: '2.1.317', message: { role: 'user', content: 'y'.repeat(300 * 1024) } }) + '\n');
  assert.equal(transcriptVersion(long), null);
});
