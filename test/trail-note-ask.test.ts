/**
 * Under trail, a turn that took real digging and left no note is asked, once
 * a session, to leave one: the Stop hook blocks the stop with the reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { main, NOTE_ASK, turnWantsNote } from '../src/claude/hooks.js';
import { ensureRepoHome } from '../src/notes/home.js';

const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const call = (command: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: Math.random().toString(36), name: 'Bash', input: { command } }] } });
const result = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const jsonl = (entries: object[]) => entries.map((e) => JSON.stringify(e)).join('\n');

test('a turn of real digging with no note wants one', () => {
  const dig = [prompt('why does Do hang'), call('trail ask "do"'), result(), call('sed -n 1,9p client.go'), result(), call('go test ./...'), result(), call('grep -n x client.go'), result()];
  assert.equal(turnWantsNote(jsonl(dig)), true);
  assert.equal(turnWantsNote(jsonl(dig.slice(0, 7))), true, 'three calls are');
  assert.equal(turnWantsNote(jsonl(dig.slice(0, 5))), false, 'two calls are not digging');
  assert.equal(turnWantsNote(jsonl([...dig, prompt('thanks'), call('ls')])), false, 'only the last turn counts');
  assert.equal(turnWantsNote(jsonl([call('trail note --title "x" <<EOF'), result(), ...dig])), false, 'a note this session is enough');
  assert.equal(turnWantsNote('not json\n'), false);
});

async function stop(input: object): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => ((out += String(chunk)), true)) as typeof process.stdout.write;
  process.env.GRAFT_TEST_STDIN = JSON.stringify(input);
  try {
    await main('stop');
  } finally {
    process.stdout.write = write;
    delete process.env.GRAFT_TEST_STDIN;
  }
  return out;
}

test('the Stop hook asks once a session, and never on the stop after a block', async () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'note-ask-home-'));
  process.env[BRAND_ENV] = 'trail';
  const d = mkdtempSync(join(tmpdir(), 'note-ask-repo-'));
  mkdirSync(join(d, 'graft', '.cache', 'session'), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = d;
  ensureRepoHome(d);
  const t = join(d, 't.jsonl');
  writeFileSync(t, jsonl([prompt('dig'), call('a'), result(), call('b'), result(), call('c'), result(), call('d'), result()]));

  assert.equal(await stop({ session_id: 's1', transcript_path: t, stop_hook_active: true }), '', 'not on the stop a block caused');
  const first = await stop({ session_id: 's1', transcript_path: t });
  assert.deepEqual(JSON.parse(first), { decision: 'block', reason: NOTE_ASK });
  assert.equal(await stop({ session_id: 's1', transcript_path: t }), '', 'once a session');
  assert.notEqual(await stop({ session_id: 's2', transcript_path: t }), '', 'a new session is asked again');
});
