/*
 * Issue #425: `callers` had no test handling — a test file was listed as a
 * caller in the same shape as production code, with no label and no way to
 * leave it out. These pin the detection (moved to the search layer so grep,
 * callers and ask share one predicate) and the `hitLine` label that marks a
 * test-file edge `[test]`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestPath } from '../src/search/grep.js';
import { hitLine } from '../src/graph/traverse-cli.js';
import type { EdgeHit } from '../src/graph/traverse.js';
import type { NodeV1 } from '../src/graph/types.js';

function node(path: string): NodeV1 {
  return {
    id: `${path}#x`, name: 'x', kind: 'function', path, span: 'L1-L1',
    signature: null, exported: true, origin: 'ast', body_hash: '',
    summary_state: 'pending', summary: null, crux: null,
  };
}

function hit(path: string): EdgeHit {
  return { node: node(path), id: `${path}#x`, relation: 'calls', depth: 1 };
}

test('isTestPath covers the documented shapes, and nothing else (#425)', () => {
  const tests = [
    'src/service.test.ts', 'src/service.spec.js', 'src/__tests__/service.ts',
    'tests/service.ts', 'test/service.ts', 'spec/service.ts',
    'src/service_test.go', 'tests/conftest.py', 'tests/test_service.py',
  ];
  const production = ['src/service.ts', 'src/testing.ts', 'src/contest.py', 'src/latest.ts', 'README.md'];
  for (const p of tests) assert.equal(isTestPath(p), true, `${p} is a test path`);
  for (const p of production) assert.equal(isTestPath(p), false, `${p} is production`);
});

test('hitLine labels a test-file edge [test] and leaves production unlabelled (#425)', () => {
  const testLine = hitLine('in', hit('src/service.test.ts'), false);
  assert.match(testLine, /\[test\]$/, 'the test caller carries the label');
  const prodLine = hitLine('in', hit('src/home.ts'), false);
  assert.doesNotMatch(prodLine, /\[test\]/, 'production stays unlabelled');
  const unresolved = hitLine('in', { node: null, id: 'pkg#x', relation: 'calls', depth: 1 }, false);
  assert.doesNotMatch(unresolved, /\[test\]/, 'an unresolved import has no path to judge');
});
