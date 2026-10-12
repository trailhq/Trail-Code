/**
 * `graft brain …` and `init --brain` were renamed to `trail`. The old spellings
 * are in docs, scripts and Trail pages already open, so they must keep working
 * — and only where they are the command, never as someone's argument.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLegacyNames } from '../src/legacy-args.js';

const run = (...args: string[]) => withLegacyNames(['node', 'graft', ...args]).slice(2);

test('graft brain … runs graft trail …', () => {
  assert.deepEqual(run('brain', 'push'), ['trail', 'push']);
  assert.deepEqual(run('trail', 'push'), ['trail', 'push']);
});

test('the command is found after global options, including ones that take a value', () => {
  assert.deepEqual(run('--dir', 'brain', 'brain', 'status'), ['--dir', 'brain', 'trail', 'status'], 'a --dir named brain stays');
  assert.deepEqual(run('--model', 'x', 'brain', 'pull'), ['--model', 'x', 'trail', 'pull']);
});

test('only the command word is renamed', () => {
  assert.deepEqual(run('ask', 'how does the brain work'), ['ask', 'how does the brain work']);
  assert.deepEqual(run('grep', 'brain'), ['grep', 'brain']);
});

test('init --brain runs init --trail, in both forms', () => {
  assert.deepEqual(run('init', '--brain', 'id:tok'), ['init', '--trail', 'id:tok']);
  assert.deepEqual(run('init', '--brain=id:tok'), ['init', '--trail=id:tok']);
});
