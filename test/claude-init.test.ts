import { test } from 'node:test';
import assert from 'node:assert/strict';

// The MCP launch command is resolved from PATH at init time; pin it to the npx
// form so these expectations are the same on every machine.
process.env.GRAFT_MCP_NPX = '1';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildGraphIfMissing, runInit } from '../src/claude/init.js';
import { formatInitEpilogue } from '../src/cli-epilogue.js';
import { readStamp } from '../src/upkeep.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-init-')); }

function runPostinstall(env: Record<string, string>): string {
  try {
    return execFileSync(process.execPath, ['scripts/postinstall.mjs'],
      { encoding: 'utf8', env: { ...process.env, ...env } });
  } catch { return ''; }
}

test('runInit scaffolds settings + both shims + the skill (build skipped)', () => {
  const d = fresh();
  const r = runInit(d, { build: false, home: fresh() });
  assert.ok(existsSync(join(d, '.claude', 'settings.json')));
  assert.ok(existsSync(join(d, '.claude', 'helpers', 'graft-statusline.cjs')));
  assert.ok(existsSync(join(d, '.claude', 'helpers', 'graft-hooks.cjs')));
  const skillPath = join(d, '.claude', 'skills', 'graft', 'SKILL.md');
  assert.ok(existsSync(skillPath), 'writes the graft skill');
  assert.equal(r.skill, skillPath);
  assert.match(readFileSync(skillPath, 'utf8'), /name: graft/);
  assert.equal(r.built, false);
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s.statusLine.command.includes('graft-statusline.cjs'));
  assert.ok(s.hooks.Stop[0].hooks[0].command.includes('graft-hooks.cjs'));
  assert.deepEqual(s.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('runInit overwrites a stale skill file', () => {
  const d = fresh();
  const skillPath = join(d, '.claude', 'skills', 'graft', 'SKILL.md');
  mkdirSync(join(d, '.claude', 'skills', 'graft'), { recursive: true });
  writeFileSync(skillPath, 'stale junk');
  runInit(d, { build: false, home: fresh() });
  assert.match(readFileSync(skillPath, 'utf8'), /name: graft/);
});

test('runInit preserves foreign settings and warns on foreign statusLine', () => {
  const d = fresh();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ model: 'x', statusLine: { command: 'mine' } }));
  const r = runInit(d, { build: false, home: fresh() });
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.statusLine.command, 'mine');
  assert.equal(r.warnings.length, 1);
});

test('runInit updates a prior Graft statusLine whose command still names the helper', () => {
  const d = fresh();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'node .claude/helpers/graft-statusline.cjs' },
  }));
  runInit(d, { build: false });
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s.statusLine.command.includes('graft-statusline.cjs'));
  assert.match(s.statusLine.command, /CLAUDE_PROJECT_DIR/);
});

test('runInit with statusline: false does not write a statusLine', () => {
  const d = fresh();
  runInit(d, { build: false, statusline: false });
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.statusLine, undefined);
  assert.equal(s.subagentStatusLine, undefined);
  assert.ok(existsSync(join(d, '.claude', 'helpers', 'graft-statusline.cjs')), 'shim still installed');
  assert.ok(s.hooks.Stop[0].hooks[0].command.includes('graft-hooks.cjs'));
});

test('CLI: --no-statusline leaves statusLine unset', () => {
  const d = fresh();
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'init', d, '--no-build', '--no-agents', '--no-statusline', '--verbose'],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /skipped Claude Code statusLine/);
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.statusLine, undefined);
  assert.equal(s.subagentStatusLine, undefined);
  assert.equal(readStamp(d)?.opts?.statusline, false);
});

test('runInit is idempotent', () => {
  const d = fresh();
  runInit(d, { build: false, home: fresh() });
  runInit(d, { build: false, home: fresh() });
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.hooks.PostToolUse.length, 2); // post-edit + tool-savings, not duplicated on re-init
  assert.deepEqual(s.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('runInit appends the allowlist to a pre-existing permissions block, preserving unrelated entries', () => {
  const d = fresh();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  runInit(d, { build: false, home: fresh() });
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.allow, ['Bash(ls)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('postinstall prints the nudge in a fresh dir', () => {
  const d = fresh();
  const out = runPostinstall({ INIT_CWD: d, CI: '' });
  assert.match(out, /npx graft init/);
});

test('postinstall is silent when already initialized', () => {
  const d = fresh();
  runInit(d, { build: false, home: fresh() });
  const out = runPostinstall({ INIT_CWD: d, CI: '' });
  assert.equal(out.trim(), '');
});

test('postinstall is silent under CI', () => {
  const out = runPostinstall({ INIT_CWD: fresh(), CI: '1' });
  assert.equal(out.trim(), '');
});

test('formatInitEpilogue: graph built shows stats, wordmark, and the 3-step list', () => {
  const out = formatInitEpilogue({ graphBuilt: true, nodes: 6398, edges: 10912 });
  assert.match(out, /\|___\/\s*$/m);
  assert.ok(out.includes('6,398 nodes · 10,912 edges'));
  assert.ok(out.includes('1. restart your agent'));
  assert.ok(out.includes('2. code as usual'));
  assert.ok(out.includes('3. explore by hand'));
  assert.ok(out.includes('graft ask'));
  assert.ok(!out.includes('build the graph'));
  assert.ok(!out.includes('OPENROUTER'));
  // graft/ is git-ignored now — the shareable artifact is .claude (wiring), not the graph.
  assert.ok(out.includes('git add .claude'));
});

test('formatInitEpilogue: graph not built shows "build the graph" as step 1, no stats, same column alignment', () => {
  const built = formatInitEpilogue({ graphBuilt: true, nodes: 4, edges: 4 });
  const notBuilt = formatInitEpilogue({ graphBuilt: false });
  assert.ok(notBuilt.includes('1. build the graph'));
  assert.ok(notBuilt.includes('2. restart your agent'));
  assert.ok(notBuilt.includes('3. code as usual'));
  assert.ok(notBuilt.includes('4. explore by hand'));
  assert.ok(!notBuilt.includes('nodes ·'));
  assert.ok(notBuilt.includes('git add .claude'));
  // the command column (after "restart your agent", the longest label) lines up
  // identically whether there are 3 or 4 numbered steps.
  const col = (text: string, marker: string) => text.split('\n').find((l) => l.includes(marker))!.indexOf('a new session');
  assert.equal(col(built, 'restart your agent'), col(notBuilt, 'restart your agent'));
});

test('CLI: graft init prints one line per step, and no banner', () => {
  const d = fresh();
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'init', d, '--no-build', '--no-agents'],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /skipped the graph build — run graft build/);
  assert.match(res.stderr, /✓ claude +\.claude[\\/], \.mcp\.json/);
  assert.match(res.stderr, /restart your agents so a new session picks up graft/);
  assert.match(res.stderr, /commit \.claude\/ \.mcp\.json to share it — graft\/ stays local and git-ignored/);
  assert.ok(!res.stderr.includes('|___/'), 'the banner is --verbose only');
  assert.ok(!res.stderr.includes('✓ wrote'), 'file-by-file lines are --verbose only');
});

test('CLI: graft init --verbose epilogue has the wordmark + next steps, and never mentions OPENROUTER', () => {
  const d = fresh();
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'init', d, '--no-build', '--no-agents', '--verbose'],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stderr.includes('|___/'), 'wordmark present');
  assert.ok(res.stderr.includes('code as usual'));
  assert.ok(res.stderr.includes('restart your agent'));
  assert.ok(res.stderr.includes('git add .claude'));
  assert.ok(res.stderr.includes('graft ask'));
  assert.ok(!res.stderr.includes('OPENROUTER'));
  // --no-build, never built before → "build the graph" is step 1
  assert.ok(res.stderr.includes('1. build the graph'));
});

// --- buildGraphIfMissing --------------------------------------------------
// Shared with the CLI's non-Claude path, so its guards are pinned here.

test('buildGraphIfMissing: build:false never spawns a build', () => {
  assert.equal(buildGraphIfMissing(fresh(), { build: false, cliPath: '/nonexistent/cli.js' }), false);
});

test('buildGraphIfMissing: no cliPath means nothing to spawn', () => {
  assert.equal(buildGraphIfMissing(fresh(), { build: true }), false);
});

test('buildGraphIfMissing: an existing graph is left alone', () => {
  const dir = fresh();
  mkdirSync(join(dir, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(dir, 'graft', '.graph', 'wiring.json'), '{}');
  // A bogus cliPath would throw if it were reached; the wiring check short-circuits.
  assert.equal(buildGraphIfMissing(dir, { build: true, cliPath: '/nonexistent/cli.js' }), false);
});
