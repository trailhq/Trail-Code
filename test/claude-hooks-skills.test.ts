/**
 * The skills parts of the hooks as the host reads them (design 0.2, 1.7):
 * one JSON object at most per hook, in the shape each event takes. A block
 * is the whole answer; a notice is what the person reads; context is what
 * the agent reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitHook } from '../src/claude/hook-io.js';
import type { HookOut } from '../src/skills/types.js';

function written(fn: () => void): string {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => ((out += String(chunk)), true)) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

test('emitHook writes nothing for an empty answer', () => {
  for (const out of [{}, { context: '' }, { notice: '' }, { block: '' }, { context: '', notice: '', block: '' }] as HookOut[]) {
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) assert.equal(written(() => emitHook(ev, out)), '', `${ev} ${JSON.stringify(out)}`);
  }
});

test('emitHook: context for the agent, a notice for the person, in one object', () => {
  assert.deepEqual(JSON.parse(written(() => emitHook('UserPromptSubmit', { context: '[trail] Skill x fits' }))),
    { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[trail] Skill x fits' } });
  assert.deepEqual(JSON.parse(written(() => emitHook('UserPromptSubmit', { context: 'c', notice: 'trail: using skill x (v1, worked Oct 14)' }))),
    { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'c' }, systemMessage: 'trail: using skill x (v1, worked Oct 14)' });
  assert.deepEqual(JSON.parse(written(() => emitHook('SessionStart', { notice: 'n' }))), { systemMessage: 'n' });
  assert.deepEqual(JSON.parse(written(() => emitHook('PostToolUse', { context: 'p' }))), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'p' } });
});

test('emitHook: a block is the whole answer, never with a notice or context', () => {
  for (const ev of ['Stop', 'UserPromptSubmit']) {
    const text = written(() => emitHook(ev, { block: '[trail] Before you finish', notice: 'n', context: 'c' }));
    assert.deepEqual(JSON.parse(text), { decision: 'block', reason: '[trail] Before you finish' }, ev);
  }
});

test("emitHook: a Stop's context is dropped (its additionalContext keeps the turn going), only a notice", () => {
  for (const opts of [{}, { stopContext: true }]) {
    assert.equal(written(() => emitHook('Stop', { context: 'c' }, opts)), '');
    assert.deepEqual(JSON.parse(written(() => emitHook('Stop', { context: 'c', notice: 'trail: x, 6 commands, 0 failed' }, opts))), { systemMessage: 'trail: x, 6 commands, 0 failed' });
  }
});

test('emitHook: with stopContext a Stop block goes out as additionalContext, which Claude Code shows as feedback, not an error', () => {
  const text = written(() => emitHook('Stop', { block: '[trail] Before you finish', notice: 'n', context: 'c' }, { stopContext: true }));
  assert.deepEqual(JSON.parse(text), { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '[trail] Before you finish' } });
  const prompt = written(() => emitHook('UserPromptSubmit', { block: 'no' }, { stopContext: true }));
  assert.deepEqual(JSON.parse(prompt), { decision: 'block', reason: 'no' }, 'only a Stop');
});

import { allowedValue } from '../src/telemetry/contract.js';

test('hook_ms takes the skills part of PostToolUse as post-bash, and nothing that is not a hook', () => {
  for (const e of ['post-bash', 'post-bash-fail', 'stop', 'prompt', 'session-start']) assert.ok(allowedValue('hook_ms', 'event', e), e);
  assert.equal(allowedValue('hook_ms', 'event', 'npm publish'), false);
});

test("note_asked's form names how the ask reached the agent, and nothing else", () => {
  for (const f of ['block', 'feedback']) assert.ok(allowedValue('note_asked', 'form', f), f);
  assert.equal(allowedValue('note_asked', 'form', 'Stop hook error'), false);
});
