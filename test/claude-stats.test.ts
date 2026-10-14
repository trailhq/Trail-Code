import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeStats, readWiring } from '../src/claude/stats.js';
import { wiringPath, writeGraph } from '../src/graph/write.js';

const wiring = {
  meta: { version: 1, nodeCount: 3, edgeCount: 2, languages: ['typescript'] },
  nodes: [
    { id: 'a', summary_state: 'ready' },
    { id: 'b', summary_state: 'pending' },
    { id: 'c', summary_state: 'ready' },
  ],
  edges: [{ from: 'a', to: 'b' }, { from: 'c', to: 'a' }],
} as any;

test('computeStats derives counts and readyCount', () => {
  const s = computeStats(wiring);
  assert.equal(s.nodeCount, 3);
  assert.equal(s.edgeCount, 2);
  assert.deepEqual(s.languages, ['typescript']);
  assert.equal(s.totalCount, 3);
  assert.equal(s.readyCount, 2);
});

test('computeStats tolerates missing meta by counting arrays', () => {
  const s = computeStats({ nodes: [{ id: 'x', summary_state: 'pending' }], edges: [] } as any);
  assert.equal(s.nodeCount, 1);
  assert.equal(s.edgeCount, 0);
  assert.equal(s.readyCount, 0);
});

test('readWiring reads from a GRAFT_DIR-relocated context dir instead of <projectDir>/graft', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-stats-dir-'));
  mkdirSync(join(d, 'elsewhere', '.graph'), { recursive: true });
  writeFileSync(join(d, 'elsewhere', '.graph', 'wiring.json'), JSON.stringify(wiring));
  process.env.GRAFT_DIR = 'elsewhere';
  try {
    assert.deepEqual(readWiring(d), wiring);
  } finally {
    delete process.env.GRAFT_DIR;
  }
});

test('readWiring reads a graph over the string cap through the streaming reader', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-stats-big-'));
  const out = join(d, 'graft');
  const graph = {
    meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ['typescript'] },
    nodes: [{ id: 'a', name: 'a', kind: 'function', path: 'a.ts', span: 'L1-L1', summary_state: 'ready' }],
    edges: [],
  } as any;
  writeGraph(graph, out); // line-shaped, as every build writes it
  assert.deepEqual(readWiring(d, { maxStringLength: 16 }), JSON.parse(readFileSync(wiringPath(out), 'utf8')));
  // A one-line file over the cap is past what JSON.parse could take in one string:
  // only the line-shaped form is readable there, which proves which path ran.
  writeFileSync(wiringPath(out), JSON.stringify(graph));
  assert.equal(readWiring(d, { maxStringLength: 16 }), null);
  assert.equal(readWiring(join(d, 'missing')), null, 'no graph is still null');
});
