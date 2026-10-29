/**
 * A learning may be stale when a file or symbol under its `touches:` is gone
 * from the checkout or the code map. It is marked where it's shown, so Claude
 * checks it before following it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { standingDirective } from '../src/claude/format.js';
import { contextDirFor } from '../src/context/node-file.js';
import type { NodeV1 } from '../src/graph/types.js';
import { writeGraph } from '../src/graph/write.js';
import { formatNoteHits, type Note } from '../src/notes/notes.js';
import { goneTouches, markStale } from '../src/notes/stale.js';
import { EVENTS } from '../src/telemetry/contract.js';
import { tmpRepo } from './helpers.js';

const BODY = '## Decided\n- Retry with jitter.\n';
const note = (touches: string[], extra: Partial<Note> = {}): Note => ({ path: '/r/.trail/learnings/a.md', id: 'l-1234abcd', title: 'Retry with jitter', author: 'Priya', date: '2026-10-07', touches, body: BODY, scope: 'repo', ...extra });

/** A file node, or a symbol node: `Backoff.delay` is the method named `delay`, as the code map keeps it. */
function node(path: string, sym?: string): NodeV1 {
  const name = sym ? sym.split('.').pop()! : path;
  return { id: sym ? `${path}#${sym}` : path, name, kind: sym ? 'function' : 'file', path, span: 'L1-L2', signature: null, exported: true, origin: 'ast', body_hash: '' };
}

/** A repo with src/retry.ts and README.md; its code map has `withJitter`, and `Backoff.delay` in another file. */
function repo(): string {
  const dir = tmpRepo('stale');
  mkdirSync(join(dir, '.trail', 'learnings'), { recursive: true });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'retry.ts'), 'export function withJitter() {}\n');
  writeFileSync(join(dir, 'README.md'), '# r\n');
  const nodes = [node('src/retry.ts'), node('src/retry.ts', 'withJitter'), node('src/moved.ts', 'Backoff.delay')];
  writeGraph({ meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: ['typescript'] }, nodes, edges: [] }, contextDirFor(dir));
  return dir;
}

test('a touched file not in the checkout is gone; a doc the code map leaves out is not', () => {
  const dir = repo();
  assert.deepEqual(goneTouches(note(['src/retry.ts', 'README.md', 'src/gone.ts']), dir), ['src/gone.ts']);
});

test('a touched symbol is gone when no symbol in the code map has its name; one that moved is not', () => {
  const dir = repo();
  assert.deepEqual(goneTouches(note(['src/retry.ts#withJitter', 'src/retry.ts#withBackoff']), dir), ['src/retry.ts#withBackoff']);
  assert.deepEqual(goneTouches(note(['src/retry.ts#Backoff.delay']), dir), [], 'delay is in the code map, in another file');
});

test("with no code map, only files are judged; a teammate's unmerged learning isn't judged", () => {
  const dir = tmpRepo('stale-nomap');
  writeFileSync(join(dir, 'a.ts'), '');
  assert.deepEqual(goneTouches(note(['a.ts#anything', 'b.ts']), dir), ['b.ts']);
  assert.deepEqual(goneTouches(note(['b.ts'], { ref: 'origin/kumar/jitter' }), dir), []);
});

test('markStale sets and clears the mark, and ask shows it under the title', () => {
  const dir = repo();
  const [stale, fine] = markStale([note(['src/gone.ts']), note(['src/retry.ts'], { stale: ['old'] })], dir);
  assert.deepEqual(stale!.stale, ['src/gone.ts']);
  assert.equal(fine!.stale, undefined);
  const lines = formatNoteHits([{ note: stale!, score: 1, shared: [] }]);
  assert.match(lines[0]!, /· Retry with jitter$/);
  assert.match(lines[1]!, /^ {2}may be stale {2}src\/gone\.ts is gone from the code\. Check it against the code before you follow it; .*trail note --replaces l-1234abcd$/);
  assert.doesNotMatch(formatNoteHits([{ note: fine!, score: 1, shared: [] }]).join('\n'), /may be stale/);
});

test("a gone file's gone symbol is named once", () => {
  const lines = formatNoteHits([{ note: note([], { stale: ['src/retry.ts', 'src/retry.ts#withJitter'] }), score: 1, shared: [] }]);
  assert.match(lines[1]!, /may be stale {2}src\/retry\.ts#withJitter is gone from the code\./);
});

test('the session-start list marks a stale standing learning', () => {
  const text = standingDirective([note(['src/gone.ts', 'src/a.ts', 'src/b.ts'], { standing: true, stale: ['src/gone.ts', 'src/a.ts', 'src/b.ts'] })]);
  assert.match(text, /\n {4}may be stale: src\/gone\.ts, src\/a\.ts and 1 more are gone from the code\./);
});

test('query may carry how many shown learnings may be stale', () => {
  assert.ok(EVENTS.query!.has('stale'));
});
