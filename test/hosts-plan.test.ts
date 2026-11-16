import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { planInit, selectedWrites } from '../src/hosts/plan.js';
import { runHostsInit } from '../src/hosts/init.js';
import { hostIds } from '../src/hosts/registry.js';
import { toPosixPath } from '../src/util/paths.js';
import { tmpRepo } from './helpers.js';

function fresh(): string { return tmpRepo('plan'); }

/** A home with every CLI graft can detect installed. */
function fullHome(): string {
  const home = fresh();
  for (const d of ['.codex', '.cursor', '.gemini', '.kiro', '.adal', join('.codeium', 'windsurf'), join('.config', 'opencode')]) {
    mkdirSync(join(home, d), { recursive: true });
  }
  return home;
}

test('planInit covers claude plus every registry host, claude first', () => {
  const plan = planInit(fresh(), { home: fresh() });
  assert.equal(plan.length, hostIds().length + 1);
  assert.equal(plan[0].id, 'claude');
  assert.deepEqual(plan.map((p) => p.id).slice(1), hostIds());
});

test('planInit writes nothing — it only describes', () => {
  const repo = fresh(); const home = fullHome();
  const plan = planInit(repo, { home });
  assert.ok(plan.length > 0);
  for (const p of plan) for (const w of p.writes) assert.ok(w.path.length > 0);
  // The repo gained nothing.
  assert.deepEqual(readdirSync(repo), []);
});

/**
 * The claude layer used to be entirely repo-scoped. It no longer is, deliberately:
 * a repo-only install is invisible to a `git worktree add` of a repo whose
 * `.gitignore` covers `.mcp.json` / `.claude/settings.json`, and the user-level copy
 * is the only place a `.gitignore` cannot reach. See src/hosts/claude-global.ts.
 */
test('claude writes: five in the repo, three in ~ that no .gitignore can eat', () => {
  const home = fullHome();
  const repo = fresh();
  const claude = planInit(repo, { home, ids: ['claude'] })[0];

  const repoWrites = claude.writes.filter((w) => w.scope === 'repo');
  assert.equal(repoWrites.length, 5);
  assert.ok(repoWrites.every((w) => w.path.startsWith(repo)));

  const globals = claude.writes.filter((w) => w.scope === 'global');
  assert.deepEqual(
    globals.map((w) => toPosixPath(w.path.slice(home.length))).sort(),
    ['/.claude.json', '/.claude/helpers/graft-hooks.cjs', '/.claude/settings.json'],
  );
  assert.ok(globals.every((w) => !w.path.startsWith(repo)), 'nothing global lands in the repo');
});

test('the three ~/.codex writes are scoped global', () => {
  const home = fullHome();
  const agents = planInit(fresh(), { home, ids: ['agents'] })[0];
  const globals = agents.writes.filter((w) => w.scope === 'global');
  assert.equal(globals.length, 3);
  // Real filesystem paths, so compared in posix form rather than the platform's.
  assert.deepEqual(
    globals.map((w) => toPosixPath(w.path.slice(home.length))).sort(),
    ['/.codex/config.toml', '/.codex/hooks.json', '/.codex/hooks/graft/graft-hooks.cjs'],
  );
});

test('global writes vanish when the CLI is not installed', () => {
  const agents = planInit(fresh(), { home: fresh(), ids: ['agents'] })[0];
  assert.deepEqual(agents.writes.filter((w) => w.scope === 'global'), []);
  // AGENTS.md is still planned — the instruction file does not depend on ~.
  assert.equal(agents.writes.length, 1);
  assert.match(agents.writes[0].path, /AGENTS\.md$/);
});

test('detected mirrors detectHosts; claude is always available', () => {
  const home = fresh(); mkdirSync(join(home, '.adal'));
  const plan = planInit(fresh(), { home });
  const detected = plan.filter((p) => p.detected).map((p) => p.id).sort();
  assert.deepEqual(detected, ['adal', 'claude']);
});

test('adal is an instruction-only host — no MCP target', () => {
  const adal = planInit(fresh(), { home: fullHome(), ids: ['adal'] })[0];
  assert.equal(adal.writes.length, 1);
  assert.equal(adal.writes[0].kind, 'instruction');
  assert.match(toPosixPath(adal.writes[0].path), /\.adal\/skills\/graft\/SKILL\.md$/);
});

// The assertion that keeps the plan honest: whatever a real run writes must be
// exactly what the plan said it would.
test('every path a real runHostsInit writes was in the plan, and vice versa', () => {
  const repo = fresh(); const home = fullHome();
  const ids = hostIds();

  const planned = new Set(selectedWrites(planInit(repo, { home }), ids).map((w) => w.path));
  const r = runHostsInit(repo, { home, agents: ids });
  const actual = new Set([
    ...r.written.map((w) => w.path),
    ...r.mcp.map((m) => m.path),
    ...r.hooks.map((h) => h.path),
  ]);

  assert.deepEqual([...actual].sort(), [...planned].sort());
});

test('selectedWrites filters to the chosen hosts only', () => {
  const repo = fresh();
  const plan = planInit(repo, { home: fullHome() });
  const writes = selectedWrites(plan, ['claude', 'adal']);
  assert.deepEqual([...new Set(writes.map((w) => w.hostId))].sort(), ['adal', 'claude']);
});

test('planInit honors --no-mcp / --no-hooks / --no-global like runHostsInit does (#329)', () => {
  const repo = fresh(); const home = fullHome();
  const byId = (plan: ReturnType<typeof planInit>, id: string) => plan.find((p) => p.id === id)!.writes;

  const full = planInit(repo, { home });
  assert.ok(byId(full, 'agents').some((w) => w.scope === 'global'), 'default plan lists the ~/.codex writes');
  assert.ok(byId(full, 'cursor').some((w) => w.path.endsWith('hooks.json')), 'default plan lists the Cursor hooks');

  const noMcp = planInit(repo, { home, mcp: false });
  for (const p of noMcp) for (const w of p.writes) {
    if (p.id === 'claude') continue;
    assert.ok(!/mcp|config\.toml|settings\.json/.test(w.path) || w.path.endsWith('hooks.json'), `--no-mcp still plans ${w.path}`);
  }

  const noHooks = planInit(repo, { home, hooks: false });
  assert.ok(!byId(noHooks, 'agents').some((w) => /hooks/.test(w.path)), '--no-hooks drops the Codex hooks');
  assert.ok(!byId(noHooks, 'cursor').some((w) => w.path.endsWith('hooks.json')), '--no-hooks drops the Cursor hooks');

  const noGlobal = planInit(repo, { home, global: false });
  for (const p of noGlobal) for (const w of p.writes) {
    assert.notEqual(w.scope, 'global', `--no-global still plans ${w.path}`);
    assert.ok(!toPosixPath(w.path).startsWith(toPosixPath(home)), `--no-global still plans ${w.path} under ~`);
  }
  assert.ok(byId(noGlobal, 'cursor').some((w) => w.path.endsWith('hooks.json')), 'Cursor hooks are repo-local and survive --no-global');

  const suppressed = planInit(repo, { home, mcp: false, hooks: false, global: false });
  assert.deepEqual(byId(suppressed, 'agents').map((w) => toPosixPath(w.path)), [toPosixPath(join(repo, 'AGENTS.md'))]);
});
