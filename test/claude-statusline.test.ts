import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStats } from '../src/claude/statusline.js';
import { renderStatusline } from '../src/claude/format.js';
import { writeStats, emptyStats } from '../src/claude/state.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function repo(): string { return mkdtempSync(join(tmpdir(), 'graft-sl-')); }
function writeWiring(dir: string, obj: unknown): void {
  mkdirSync(join(dir, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(dir, 'graft', '.graph', 'wiring.json'), JSON.stringify(obj));
}

test('resolveStats returns the hook-maintained cache when present and non-empty', () => {
  const d = repo();
  writeStats(d, { ...emptyStats(), nodeCount: 5, edgeCount: 9, dirty: true, staleCount: 2 });
  const s = resolveStats(d)!;
  assert.equal(s.nodeCount, 5);
  assert.equal(s.dirty, true, 'cache is the source of truth when present');
});

test('resolveStats falls back to wiring.json when no cache (manual graft build / fresh checkout)', () => {
  const d = repo();
  writeWiring(d, {
    meta: { nodeCount: 42, edgeCount: 100, languages: ['typescript'] },
    nodes: [{ id: 'a', summary_state: 'ready' }, { id: 'b', summary_state: 'pending' }],
    edges: [],
  });
  const s = resolveStats(d)!;
  assert.equal(s.nodeCount, 42, 'reflects the graph immediately instead of "not built"');
  assert.equal(s.readyCount, 1);
  assert.equal(s.dirty, false, 'defaults to synced — no drift signal available from the graph alone');
});

test('resolveStats prefers the cache over the graph even when both exist', () => {
  const d = repo();
  writeWiring(d, { meta: { nodeCount: 42, edgeCount: 100, languages: [] }, nodes: [], edges: [] });
  writeStats(d, { ...emptyStats(), nodeCount: 7, edgeCount: 3, dirty: true, staleCount: 4 });
  const s = resolveStats(d)!;
  assert.equal(s.nodeCount, 7, 'cache wins (it carries live drift state the graph cannot)');
  assert.equal(s.staleCount, 4);
});

test('resolveStats returns null when neither cache nor graph exists', () => {
  assert.equal(resolveStats(repo()), null);
});

test('empty wiring.json is a built graph: statusline shows 0 nodes, not "not built"', () => {
  const d = repo();
  writeWiring(d, { meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] });
  const s = resolveStats(d)!;
  assert.equal(s.nodeCount, 0);
  assert.equal(s.edgeCount, 0);
  const line = strip(renderStatusline(s, null, { ctxPct: null })[0]);
  assert.doesNotMatch(line, /not built/);
  assert.doesNotMatch(line, /graft build/);
  assert.match(line, /0 nodes \/ 0 edges/);
});

test('a 0-node cache without wiring.json is still not built', () => {
  const d = repo();
  writeStats(d, { ...emptyStats(), nodeCount: 0, edgeCount: 0 });
  assert.equal(resolveStats(d), null, 'no artifact → missing, not an empty graph');
  const line = strip(renderStatusline(null, null, { ctxPct: null })[0]);
  assert.match(line, /not built/);
  assert.match(line, /graft build/);
});

test('the statusline counts learnings, not notes', () => {
  const d = repo();
  writeWiring(d, { meta: { nodeCount: 1, edgeCount: 0, languages: [] }, nodes: [], edges: [] });
  const s = resolveStats(d)!;
  assert.match(strip(renderStatusline(s, null, { ctxPct: null, notes: 1 })[0]), /· 1 learning(?!s)/);
  assert.match(strip(renderStatusline(s, null, { ctxPct: null, notes: 2 })[0]), /· 2 learnings/);
  assert.doesNotMatch(strip(renderStatusline(s, null, { ctxPct: null, notes: 2 })[0]), /note/);
});
