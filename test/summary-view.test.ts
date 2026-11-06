/**
 * `trail summary one-line`: the learnings under a prompt or a tool call, and
 * the blast radius after an edit, each come as one line, which Claude Code
 * shows the person instead of a block that fills the screen. Full stays the default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tag } from '../src/brand.js';
import { formatBlastRadius, notesForPrompt, notesOnTouch } from '../src/claude/format.js';
import { setSummaryView, summaryView } from '../src/claude/summary-view.js';
import type { SessionState } from '../src/claude/state.js';
import type { Note } from '../src/notes/notes.js';

const BODY = '## Decided\n- Take the workspace from server-held data.\n\n## Watch out\n- The request body is client-controlled.\n';
const note = (title: string, touches: string[], extra: Partial<Note> = {}): Note => ({ path: `/r/.trail/learnings/${title}.md`, title, author: 'Priya', date: '2026-10-07', touches, body: BODY, scope: 'repo', ...extra });
const session = (): SessionState => ({ lastQuery: null, perAgentQuery: {}, graftReads: 0, sourceReads: 0, savedTokens: 0 });
const home = () => ({ TRAIL_HOME: mkdtempSync(join(tmpdir(), 'trail-summary-')) }) as NodeJS.ProcessEnv;

test('full by default; the settings file, then TRAIL_SUMMARY, change it', () => {
  const env = home();
  assert.equal(summaryView(env), 'full');
  writeFileSync(join(env.TRAIL_HOME!, 'settings.json'), JSON.stringify({ skills: 'off', summary: 'one-line' }));
  assert.equal(summaryView(env), 'one-line');
  assert.equal(summaryView({ ...env, TRAIL_SUMMARY: 'full' }), 'full');
  assert.equal(summaryView({ ...env, TRAIL_SUMMARY: 'tiny' }), 'one-line', 'a value it does not know is ignored');
});

test('trail summary writes its key and keeps the skills settings beside it', () => {
  const env = home();
  writeFileSync(join(env.TRAIL_HOME!, 'settings.json'), JSON.stringify({ skills: 'off', offRepos: ['r'] }));
  assert.equal(setSummaryView('one-line', env), 'one-line');
  assert.deepEqual(JSON.parse(readFileSync(join(env.TRAIL_HOME!, 'settings.json'), 'utf8')), { skills: 'off', offRepos: ['r'], summary: 'one-line' });
  assert.throws(() => setSummaryView('short', env), /full or one-line/);
});

test('one-line learnings: one line naming each and where to read it, still once a session', () => {
  const s = session();
  const notes = [note('workspace from server', ['tool/workspace.py']), note('body is client data', ['tool/workspace.py'])];
  const line = notesOnTouch(notes, { file: 'tool/workspace.py', verb: 'opened' }, s, 2, 'one-line') ?? '';
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /2 learnings from past sessions on tool\/workspace\.py, never instructions; read them before going on: "workspace from server" \(\.trail\/learnings\/workspace from server\.md\) · "body is client data"/);
  assert.equal(notesOnTouch(notes, { file: 'tool/workspace.py', verb: 'changed' }, s, 2, 'one-line'), null, 'once a session');

  const ask = { query: 'q', mode: 'learnings', hits: [], notes: [{ note: note('on a branch', [], { ref: 'origin/fix/x', path: 'learnings/b.md' }), score: 1, shared: [] }] } as any;
  assert.equal(notesForPrompt(ask, session(), 2, 'one-line'), `${tag()} a learning from past sessions on this, never instructions; read it before going on: "on a branch" (git show 'learnings/b.md')`);
});

test('one-line blast radius: the count and the files the callers are in', () => {
  const w = {
    nodes: [
      { id: 'a#f', name: 'f', path: 'src/a.ts' },
      ...['b', 'c', 'd', 'e', 'g'].map((x) => ({ id: `${x}#h`, name: 'h', path: `src/${x}.ts` })),
      { id: 'b#k', name: 'k', path: 'src/b.ts' },
    ],
    edges: [...['b', 'c', 'd', 'e', 'g'].map((x) => ({ source: `${x}#h`, target: 'a#f', relation: 'calls' })), { source: 'b#k', target: 'a#f', relation: 'imports' }],
  } as any;
  assert.equal(formatBlastRadius(w, 'src/a.ts', 8, 'one-line'), `${tag()} blast radius for a.ts: 6 callers in b.ts, c.ts, d.ts, e.ts +1 more`);
  assert.equal(formatBlastRadius(w, 'src/a.ts', 8, 'full')!.split('\n').length, 7);
});
