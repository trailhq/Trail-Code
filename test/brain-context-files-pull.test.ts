/**
 * `graft trail pull` writes accepted changes into every context file, not only
 * the root CLAUDE.md. It edits files people also edit by hand, so the tests are
 * about restraint: a whole-file change never overwrites someone's file, a
 * replace only lands on the file it was computed against, a path from Trail
 * never escapes the repo, and files for agents nobody picked are left alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { planContextFile, readByWired, safeRelPath, writePlannedFile, type ContextFile } from '../src/brain/context-files.js';
import { runTrailPull } from '../src/brain/pull.js';
import type { BrainLink } from '../src/brain/link.js';
import { tmpRepo } from './helpers.js';

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const AGENTS = ['# api', '', '## Commands', '', '- `make test` runs the unit tests.', '', '## Style', '', '- gofmt everything.', ''].join('\n');

test('edit and add patch the file exactly as the CLAUDE.md pull does', () => {
  const root = tmpRepo('ctx-edit');
  put(root, 'services/api/AGENTS.md', AGENTS);
  const plan = planContextFile(root, {
    kind: 'agents_md',
    path: 'services/api/AGENTS.md',
    changes: [
      { id: 'e1', kind: 'edit', heading: 'Commands', find: '- `make test` runs the unit tests.', text: '- `make test` runs unit and integration tests.' },
      { id: 'a1', kind: 'add', heading: 'Money', after_heading: 'Commands', text: 'Amounts are integer cents.' },
    ],
  });
  assert.equal(plan.status, 'M');
  assert.deepEqual(plan.written.map((c) => c.id), ['e1', 'a1']);
  assert.match(plan.text!, /## Commands\n\n- `make test` runs unit and integration tests\.\n\n## Money\n\nAmounts are integer cents\.\n\n## Style/);
  assert.match(plan.text!, /- gofmt everything\./, 'untouched sections come back as they were');
});

test('create writes a new file, folders and all', () => {
  const root = tmpRepo('ctx-create');
  const plan = planContextFile(root, {
    kind: 'cursor_rule',
    path: '.cursor/rules/money.mdc',
    changes: [{ id: 'c1', kind: 'create', text: '---\ndescription: money\n---\nAmounts are integer cents.' }],
  });
  assert.equal(plan.status, 'A');
  writePlannedFile(root, plan);
  assert.equal(readFileSync(join(root, '.cursor/rules/money.mdc'), 'utf8'), '---\ndescription: money\n---\nAmounts are integer cents.\n');
});

test('create over an identical file counts as applied and writes nothing', () => {
  const root = tmpRepo('ctx-same');
  put(root, 'web/CLAUDE.md', '# web\r\n\r\nPascalCase components.\r\n');
  const plan = planContextFile(root, {
    kind: 'folder_claude_md',
    path: 'web/CLAUDE.md',
    changes: [{ id: 'c2', kind: 'create', text: '# web\n\nPascalCase components.' }],
  });
  assert.equal(plan.status, '');
  assert.deepEqual(plan.present.map((c) => c.id), ['c2']);
});

test('create over a different file is a conflict, and the file is left alone', () => {
  const root = tmpRepo('ctx-conflict');
  put(root, 'web/CLAUDE.md', '# web\n\nOurs.\n');
  const plan = planContextFile(root, {
    kind: 'folder_claude_md',
    path: 'web/CLAUDE.md',
    changes: [{ id: 'c3', kind: 'create', text: '# web\n\nTheirs.\n' }],
  });
  assert.equal(plan.status, '');
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].why, /other content/);
});

test('create over a file graft owns replaces it', () => {
  const root = tmpRepo('ctx-managed');
  put(root, '.cursor/rules/graft.mdc', 'old graft rule\n');
  const plan = planContextFile(root, {
    kind: 'cursor_rule',
    path: '.cursor/rules/graft.mdc',
    managed_by_graft: true,
    changes: [{ id: 'c4', kind: 'create', text: 'new graft rule\n' }],
  });
  assert.equal(plan.status, 'M');
  assert.equal(plan.text, 'new graft rule\n');
});

test('replace lands only on the file it was computed against', () => {
  const root = tmpRepo('ctx-replace');
  put(root, '.cursor/rules/style.mdc', 'Use tabs.\r\n');
  const change = { id: 'r1', kind: 'replace' as const, find: 'Use tabs.\n', text: 'Use two spaces.\n' };
  const ok = planContextFile(root, { kind: 'cursor_rule', path: '.cursor/rules/style.mdc', changes: [change] });
  assert.equal(ok.status, 'M');
  assert.equal(ok.text, 'Use two spaces.\n');

  put(root, '.cursor/rules/style.mdc', 'Use tabs. And semicolons.\n');
  const moved = planContextFile(root, { kind: 'cursor_rule', path: '.cursor/rules/style.mdc', changes: [change] });
  assert.equal(moved.status, '');
  assert.match(moved.skipped[0].why, /changed here since Trail read it/);

  put(root, '.cursor/rules/style.mdc', 'Use two spaces.\n');
  const done = planContextFile(root, { kind: 'cursor_rule', path: '.cursor/rules/style.mdc', changes: [change] });
  assert.deepEqual(done.present.map((c) => c.id), ['r1']);
});

test('an edit to a file that is not here yet creates it', () => {
  const root = tmpRepo('ctx-missing');
  const plan = planContextFile(root, {
    kind: 'folder_claude_md',
    path: 'web/CLAUDE.md',
    changes: [{ id: 'e2', kind: 'edit', heading: 'Frontend', find: '', text: 'Components are PascalCase.' }],
  });
  assert.equal(plan.status, 'A');
  assert.equal(plan.text, '## Frontend\n\nComponents are PascalCase.\n');
});

test('a path from Trail never leaves the repo', () => {
  const root = tmpRepo('ctx-safe');
  for (const bad of ['../outside.md', '/etc/passwd', 'a/../../b.md', '.git/config', 'C:/x.md', '']) {
    assert.equal(safeRelPath(root, bad), null, bad);
  }
  assert.equal(safeRelPath(root, 'web/CLAUDE.md'), 'web/CLAUDE.md');
  const plan = planContextFile(root, { kind: 'agents_md', path: '../AGENTS.md', changes: [{ id: 'x', kind: 'create', text: 'x' }] });
  assert.equal(plan.status, '');
  assert.equal(plan.skipped.length, 1);
});

test('files are only for the agents that were picked', () => {
  assert.equal(readByWired('cursor_rule', ['claude']), false);
  assert.equal(readByWired('agents_md', ['claude', 'agents']), true);
  assert.equal(readByWired('skill', ['claude']), true);
  assert.equal(readByWired('cursor_rule', []), true, 'nothing wired means no choice to respect');
});

// --- the whole pull, against a fake Trail ---------------------------------------

const link = { brainId: 'b1', token: 'gbt_1.x', baseUrl: 'http://trail.test' } as unknown as BrainLink;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeTrail(files: ContextFile[], opts: { contextFiles?: 'ok' | 'missing'; repo?: unknown; claudeMd?: unknown[] } = {}) {
  const applied: Record<string, string[]> = {};
  const f = (async (u: string, init?: RequestInit) => {
    const path = new URL(u).pathname;
    if (path.endsWith('/rules/anchors')) return json({ anchors: [] });
    if (path.endsWith('/claude-md')) {
      return json({ path: 'CLAUDE.md', head_sha: 'abc', changes: opts.claudeMd ?? [{ id: 'm1', kind: 'add', heading: 'Money', after_heading: '', text: 'Integer cents.' }] });
    }
    if (path.endsWith('/repo') && opts.repo) return json(opts.repo);
    if (path.endsWith('/context-files')) {
      return opts.contextFiles === 'missing' ? json({ error: 'not found' }, 404) : json({ head_sha: 'abc', files });
    }
    if (path.endsWith('/applied')) {
      applied[path] = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      return json({ applied: 1 });
    }
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;
  return { f, applied };
}

test('a pull writes the CLAUDE.md changes, then every other file, and tells Trail which', async () => {
  const root = tmpRepo('ctx-pull');
  put(root, 'CLAUDE.md', '# app\n\n## Commands\n\n- `npm test`\n');
  put(root, 'web/CLAUDE.md', '# web\n\nOurs.\n');
  const { f, applied } = fakeTrail([
    { kind: 'agents_md', path: 'AGENTS.md', changes: [{ id: 'g1', kind: 'create', text: '# agents\n\nInteger cents.\n' }] },
    { kind: 'folder_claude_md', path: 'web/CLAUDE.md', changes: [{ id: 'w1', kind: 'create', text: '# web\n\nTheirs.\n' }] },
    { kind: 'cursor_rule', path: '.cursor/rules/money.mdc', changes: [{ id: 'k1', kind: 'create', text: 'cents\n' }] },
  ]);
  const lines: string[] = [];
  const code = await runTrailPull(root, link, { home: root, wired: ['claude', 'agents'], fetchImpl: f, write: (l) => lines.push(l) });
  const out = lines.join('\n');

  assert.equal(code, 1, 'the conflict makes it exit non-zero, as claude-md pull did');
  assert.match(out, /✓ wrote 2 accepted changes/);
  assert.match(out, /  M CLAUDE\.md +\+ Money/);
  assert.match(out, /  A AGENTS\.md/);
  assert.match(out, /⚠ skipped web\/CLAUDE\.md — a file with other content is already there; edit it in Trail, then pull again/);
  assert.doesNotMatch(out, /money\.mdc/, 'cursor was not picked, so its rule is neither listed nor written');
  assert.match(out, /review with git diff, then commit/);

  assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /## Money\n\nInteger cents\./);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# agents\n\nInteger cents.\n');
  assert.equal(readFileSync(join(root, 'web/CLAUDE.md'), 'utf8'), '# web\n\nOurs.\n');
  assert.ok(!existsSync(join(root, '.cursor/rules/money.mdc')));

  assert.deepEqual(applied['/api/public/brains/b1/claude-md/applied'], ['m1']);
  assert.deepEqual(applied['/api/public/brains/b1/context-files/applied'], ['g1'], 'only what was written, never the conflict');
});

test('a dry run writes nothing and tells Trail nothing', async () => {
  const root = tmpRepo('ctx-dry');
  const { f, applied } = fakeTrail([
    { kind: 'agents_md', path: 'AGENTS.md', changes: [{ id: 'g1', kind: 'create', text: 'x\n' }] },
  ]);
  const lines: string[] = [];
  await runTrailPull(root, link, { home: root, wired: [], dryRun: true, fetchImpl: f, write: (l) => lines.push(l) });
  assert.match(lines.join('\n'), /✓ would write 2 accepted changes/);
  assert.match(lines.join('\n'), /dry run — nothing written, and Trail was not told/);
  assert.ok(!existsSync(join(root, 'AGENTS.md')) && !existsSync(join(root, 'CLAUDE.md')));
  assert.deepEqual(applied, {});
});

test('a Trail without context files still pulls CLAUDE.md, silently', async () => {
  const root = tmpRepo('ctx-older');
  const { f } = fakeTrail([], { contextFiles: 'missing' });
  const lines: string[] = [];
  const code = await runTrailPull(root, link, { home: root, wired: ['claude'], fetchImpl: f, write: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /✓ wrote 1 accepted change\n  A CLAUDE\.md +\+ Money/);
  assert.doesNotMatch(lines.join('\n'), /✗/);
});

/** Trail's GET /repo mid-review: 3 CLAUDE.md suggestions, 2 skills, 4 Cursor rules. */
const REVIEWING = {
  repo: { status: 'completed', rule_count: 75 },
  claude_md: { status: 'ready', changes: 3 },
  context_files: true,
  context_files_progress: {
    changes: 6,
    files: [
      { kind: 'skill', path: '.claude/skills/a/SKILL.md', changes: 2 },
      { kind: 'cursor_rule', path: '.cursor/rules/a.mdc', changes: 4 },
    ],
  },
};

test('with nothing accepted, a pull says how many suggestions are waiting for the wired agents', async () => {
  const root = tmpRepo('ctx-waiting');
  const { f } = fakeTrail([], { repo: REVIEWING, claudeMd: [] });
  const lines: string[] = [];
  const code = await runTrailPull(root, link, { home: root, wired: ['claude'], dryRun: true, fetchImpl: f, write: (l) => lines.push(l) });
  const out = lines.join('\n');
  assert.equal(code, 0);
  assert.match(out, /● 5 suggested so far for the files claude read, none accepted yet\n  review: \S+\/brain\/b1\/context-files/);
  assert.doesNotMatch(out, /nothing accepted in Trail yet/);
});

test('a dry run with accepted changes also says how many were suggested, and where to review', async () => {
  const root = tmpRepo('ctx-waiting-dry');
  const { f } = fakeTrail([], { repo: REVIEWING });
  const lines: string[] = [];
  await runTrailPull(root, link, { home: root, wired: ['claude', 'cursor'], dryRun: true, fetchImpl: f, write: (l) => lines.push(l) });
  const out = lines.join('\n');
  assert.match(out, /✓ would write 1 accepted change/);
  assert.match(out, /● 9 suggested so far for the files claude and cursor read, 1 of them accepted\n  review: /);
  assert.match(out, /dry run — nothing written/);
});

test('a Trail that sends no counts leaves the pull as it was', async () => {
  const root = tmpRepo('ctx-no-counts');
  const { f } = fakeTrail([], { claudeMd: [] });
  const lines: string[] = [];
  await runTrailPull(root, link, { home: root, wired: ['claude'], fetchImpl: f, write: (l) => lines.push(l) });
  assert.match(lines.join('\n'), /· nothing accepted in Trail yet — review:/);
  assert.doesNotMatch(lines.join('\n'), /suggested so far/);
});
