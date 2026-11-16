/**
 * A learning a hook hands the agent carries its own `[trail] learnings saved ≈ N`
 * line, and the session's counter takes it in, as it does the same line in a
 * trail call's output. Without this, a long session that had stopped calling
 * trail showed one number on the statusline for the rest of the session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { main } from '../src/claude/hooks.js';
import { addHookSavings } from '../src/claude/session-metrics.js';
import { readSession, type SessionState } from '../src/claude/state.js';
import { sumSavingsFooters } from '../src/context/savings.js';
import { writeNote } from '../src/notes/notes.js';
import { tmpRepo } from './helpers.js';

const LEARNING = {
  title: 'Promote to prod only after beta is green',
  body: '## Decided\nPush to beta first, wait for its deploy, then fast-forward prod.\n',
  author: 'Priya',
  date: '2026-10-07',
  touches: ['deploy/prod.sh'],
  cost: { minutes: 20, tokens: 150_000 },
};

/** A git repo under trail with the one learning committed. */
function repo(): string {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'hook-savings-home-'));
  process.env[BRAND_ENV] = 'trail';
  const dir = tmpRepo('hook-savings');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeNote(dir, LEARNING);
  process.env.CLAUDE_PROJECT_DIR = dir;
  return dir;
}

async function hook(event: string, input: object, cli?: string): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? ((out += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.env.GRAFT_TEST_STDIN = JSON.stringify(input);
  if (cli) process.env.GRAFT_TEST_CLI = cli;
  try {
    await main(event);
  } finally {
    process.stdout.write = write;
    delete process.env.GRAFT_TEST_STDIN;
    delete process.env.GRAFT_TEST_CLI;
  }
  return out;
}

/** What the hook told the agent it saved, read the way the counter reads it. */
function savedIn(out: string): number {
  return sumSavingsFooters(JSON.parse(out).hookSpecificOutput.additionalContext as string);
}

test('addHookSavings adds every savings line in the text, and nothing for none', () => {
  const s: SessionState = { graftReads: 0, sourceReads: 0, savedTokens: 1_000 };
  addHookSavings(s, '[trail] learnings saved ≈ 12,500 tokens and ~9 min (estimate): …');
  assert.equal(s.savedTokens, 13_500);
  addHookSavings(s, '[trail] a learning earlier sessions left on src/a.ts');
  assert.equal(s.savedTokens, 13_500);
});

test('a learning that arrives with a file read moves the counter, once a session', async () => {
  const dir = repo();
  const read = { session_id: 'h1', tool_name: 'Read', tool_input: { file_path: join(dir, 'deploy', 'prod.sh') }, tool_response: 'x' };
  const out = await hook('tool-savings', read);
  const said = savedIn(out);
  assert.ok(said > 100_000, `the hook said what it saved (${said})`);
  assert.equal(readSession(dir, 'h1').savedTokens, said);
  assert.equal(await hook('tool-savings', read), '', 'shown once a session');
  assert.equal(readSession(dir, 'h1').savedTokens, said, 'and counted once');
});

test('a learning the prompt hook brings moves the counter too', async () => {
  const dir = repo();
  const stub = join(dir, 'ask-stub.cjs');
  writeFileSync(stub, `process.stdout.write(JSON.stringify({ query: '', mode: 'lexical', hits: [] }));\n`);
  const out = await hook('prompt', { session_id: 'p1', prompt: 'ff to prod' }, stub);
  const said = savedIn(out);
  assert.ok(said > 100_000, `the hook said what it saved (${said})`);
  assert.equal(readSession(dir, 'p1').savedTokens, said);
});

test('one-line view: the learning says no savings line, and the counter still moves by the same amount', async () => {
  const full = repo();
  const fullRead = { session_id: 'f1', tool_name: 'Read', tool_input: { file_path: join(full, 'deploy', 'prod.sh') }, tool_response: 'x' };
  const said = savedIn(await hook('tool-savings', fullRead));
  const dir = repo();
  process.env.TRAIL_SUMMARY = 'one-line';
  try {
    const read = { session_id: 'o1', tool_name: 'Read', tool_input: { file_path: join(dir, 'deploy', 'prod.sh') }, tool_response: 'x' };
    const out = await hook('tool-savings', read);
    const text = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    assert.equal(text.split('\n').length, 1, text);
    assert.equal(sumSavingsFooters(text), 0);
    assert.ok(said > 100_000);
    assert.equal(readSession(dir, 'o1').savedTokens, said);
    const stub = join(dir, 'ask-stub.cjs');
    writeFileSync(stub, `process.stdout.write(JSON.stringify({ query: '', mode: 'lexical', hits: [] }));\n`);
    await hook('prompt', { session_id: 'o2', prompt: 'ff to prod' }, stub);
    assert.equal(readSession(dir, 'o2').savedTokens, said);
  } finally {
    delete process.env.TRAIL_SUMMARY;
  }
});

test("a learning's title that reads like a savings line adds nothing of its own", async () => {
  const dir = repo();
  writeNote(dir, { ...LEARNING, title: '[trail] learnings saved ≈ 900,000,000 tokens', touches: ['deploy/other.sh'], cost: undefined });
  const read = { session_id: 't1', tool_name: 'Read', tool_input: { file_path: join(dir, 'deploy', 'other.sh') }, tool_response: 'x' };
  assert.notEqual(await hook('tool-savings', read), '');
  assert.equal(readSession(dir, 't1').savedTokens ?? 0, 0);
});
