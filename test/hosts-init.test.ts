import { test } from 'node:test';
import assert from 'node:assert/strict';

// The MCP launch command is resolved from PATH at init time; pin it to the npx
// form so these expectations are the same on every machine.
process.env.GRAFT_MCP_NPX = '1';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runHostsInit } from '../src/hosts/init.js';
import { toPosixPath } from '../src/util/paths.js';
import { runCli, tmpRepo } from './helpers.js';

function fresh(): string { return tmpRepo('hostsinit'); }

test('writes only detected hosts by default', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.cursor'));
  const r = runHostsInit(repo, { home });
  assert.deepEqual(r.written.map((w) => w.id), ['cursor']);
  const mdc = readFileSync(join(repo, '.cursor', 'rules', 'graft.mdc'), 'utf8');
  assert.match(mdc, /alwaysApply: true/);
  assert.ok(!existsSync(join(repo, 'AGENTS.md')));
});

test('explicit agents list overrides detection and flags unknown ids', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['gemini', 'nope'] });
  assert.deepEqual(r.written.map((w) => w.id), ['gemini']);
  assert.deepEqual(r.unknown, ['nope']);
  assert.ok(readFileSync(join(repo, 'GEMINI.md'), 'utf8').includes('graft ask'));
});

test('all writes every host and re-run converges (idempotent)', () => {
  const home = fresh(); const repo = fresh();
  const first = runHostsInit(repo, { home, all: true });
  assert.equal(first.written.length, 10);
  const second = runHostsInit(repo, { home, all: true });
  assert.ok(second.written.every((w) => w.action === 'unchanged'));
  // `agents` and `antigravity` share AGENTS.md, but the fenced section is written once
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.equal(agents.match(/graft:start/g)!.length, 1);
});

test('preserves user content around the fenced section', () => {
  const home = fresh(); const repo = fresh();
  const target = join(repo, '.github', 'copilot-instructions.md');
  mkdirSync(join(repo, '.github'), { recursive: true });
  writeFileSync(target, '# House rules\n');
  const r = runHostsInit(repo, { home });
  assert.deepEqual(r.written.map((w) => w.id), ['copilot']);
  const text = readFileSync(target, 'utf8');
  assert.ok(text.startsWith('# House rules'));
  assert.ok(text.includes('graft ask'));
});

test('CLI: graft init --agents gemini writes GEMINI.md and exits 0', () => {
  const repo = fresh();
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'init', repo, '--no-build', '--agents', 'gemini'], {
    encoding: 'utf8',
  });
  assert.ok(readFileSync(join(repo, 'GEMINI.md'), 'utf8').includes('graft ask'));
});

test('CLI: unknown agent id exits non-zero', () => {
  const repo = fresh();
  assert.throws(() =>
    execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'init', repo, '--no-build', '--agents', 'nope'], {
      encoding: 'utf8', stdio: 'pipe',
    }),
  );
});

test('explicit empty agents list writes nothing, even when home has agent dirs (no fallback to detection)', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.cursor'));
  const r = runHostsInit(repo, { home, agents: [] });
  assert.deepEqual(r.written, []);
  assert.ok(!existsSync(join(repo, '.cursor')));
});

test('CLI: --agents claude with --no-build writes .claude/ but no other-agent files', () => {
  const repo = fresh();
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'init', repo, '--no-build', '--agents', 'claude'], {
    encoding: 'utf8',
  });
  assert.ok(existsSync(join(repo, '.claude')));
  assert.ok(!existsSync(join(repo, 'AGENTS.md')));
  assert.ok(!existsSync(join(repo, 'GEMINI.md')));
  assert.ok(!existsSync(join(repo, '.cursor')));
});

test('CLI: --agents claude gemini nope exits non-zero and leaves repo untouched (validation before writes)', () => {
  const repo = fresh();
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'init', repo, '--no-build', '--agents', 'claude', 'gemini', 'nope'],
      { encoding: 'utf8', stdio: 'pipe' },
    ),
  );
  assert.ok(!existsSync(join(repo, '.claude')));
  assert.ok(!existsSync(join(repo, 'GEMINI.md')));
  assert.ok(!existsSync(join(repo, 'AGENTS.md')));
});

test('runHostsInit registers MCP configs for selected hosts', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['cursor'] });
  assert.equal(r.mcp.length, 1);
  // An absolute filesystem path, so it carries the platform separator — assert the
  // shape, not the platform.
  assert.match(toPosixPath(r.mcp[0].path), /\.cursor\/mcp\.json$/);
  const cfg = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cfg.mcpServers.graft.command, 'npx');
});

test('mcp: false skips MCP registration', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['cursor'], mcp: false });
  assert.deepEqual(r.mcp, []);
  assert.ok(!existsSync(join(repo, '.cursor', 'mcp.json')));
});

test('CLI: --no-mcp writes the rule file but no MCP config', () => {
  const repo = fresh();
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'init', repo, '--no-build', '--agents', 'cursor', '--no-mcp'], { encoding: 'utf8' });
  assert.ok(existsSync(join(repo, '.cursor', 'rules', 'graft.mdc')));
  assert.ok(!existsSync(join(repo, '.cursor', 'mcp.json')));
});

test('runHostsInit installs hooks for the agents id when the CLI home exists', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const r = runHostsInit(repo, { home, agents: ['agents'] });
  assert.equal(r.hooks.length, 2);
  assert.ok(existsSync(join(home, '.codex', 'hooks', 'graft', 'graft-hooks.cjs')));
});

test('hooks: false skips hook installation', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const r = runHostsInit(repo, { home, agents: ['agents'], hooks: false });
  assert.deepEqual(r.hooks, []);
  assert.ok(!existsSync(join(home, '.codex', 'hooks.json')));
});

test('global: false keeps the instruction file but skips every ~ write', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const r = runHostsInit(repo, { home, agents: ['agents'], global: false });

  assert.deepEqual(r.written.map((w) => w.id), ['agents']);
  assert.ok(existsSync(join(repo, 'AGENTS.md')));
  assert.deepEqual(r.hooks, []);
  assert.ok(!existsSync(join(home, '.codex', 'hooks.json')));
  assert.ok(!existsSync(join(home, '.codex', 'config.toml')));
  // The repo-local opencode MCP config is not a global write, so it survives.
  assert.deepEqual(r.mcp.map((m) => m.id), ['opencode']);
  assert.ok(existsSync(join(repo, 'opencode.json')));
});

// --- CLI: choosing what gets written ------------------------------------

/**
 * Run `graft init` with a scratch home so tests never touch the real ~/.codex,
 * and return stderr. The child gets a pipe rather than a TTY, which is exactly
 * the non-interactive path we want to exercise.
 *
 * `runCli`'s `home` sets `USERPROFILE` as well as `HOME` — this used to set only
 * `HOME`, so on Windows the child read the *runner's* profile and reported
 * whichever agents it happened to have installed instead of the fixture's.
 */
function cliStderr(repo: string, home: string, extra: string[] = []): string {
  const res = runCli(['init', repo, '--no-build', ...extra], { home });
  assert.equal(res.status, 0, res.describe());
  return res.stderr ?? '';
}

test('CLI: no flags and no TTY writes nothing and names the detected agents', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.cursor'));
  const out = cliStderr(repo, home);
  assert.match(out, /nothing written/);
  assert.match(out, /detected: claude, cursor/);
  assert.match(out, /graft init --agents claude cursor/);
  assert.deepEqual(readdirSync(repo), []);
});

test('CLI: --dry-run prints the plan, both sections, and writes nothing', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const out = cliStderr(repo, home, ['--dry-run']);

  assert.match(out, /would write — this repo:/);
  // The plan prints display paths, which keep the platform separator.
  assert.ok(out.includes(join('.claude', 'settings.json')), out);
  assert.match(out, /AGENTS\.md/);
  assert.match(out, /affects ALL repos:/);
  assert.ok(out.includes(`~${sep}${join('.codex', 'hooks.json')}`), out);
  assert.match(out, /nothing was written/);

  assert.deepEqual(readdirSync(repo), []);
  assert.ok(!existsSync(join(home, '.codex', 'hooks.json')));
});

test('CLI: --yes wires every detected agent (the pre-0.8 default)', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.cursor'));
  cliStderr(repo, home, ['--yes']);
  assert.ok(existsSync(join(repo, '.claude', 'settings.json')));
  assert.ok(existsSync(join(repo, '.cursor', 'rules', 'graft.mdc')));
  // gemini was never installed in this scratch home, so it is not wired.
  assert.ok(!existsSync(join(repo, 'GEMINI.md')));
});

test('CLI: --no-global writes AGENTS.md but leaves ~/.codex alone', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const out = cliStderr(repo, home, ['--agents', 'agents', '--no-global', '--verbose']);
  assert.ok(existsSync(join(repo, 'AGENTS.md')));
  assert.deepEqual(readdirSync(join(home, '.codex')), []);
  assert.match(out, /skipped out-of-repo writes/);
});

test('CLI: the graph build is attempted even when claude is not selected', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.cursor'));
  // Regression: the build used to sit inside `if (wantClaude)`, so picking only
  // cursor wired .cursor/ and never built the graph its rule file points at.
  const out = cliStderr(repo, home, ['--agents', 'cursor']);
  assert.match(out, /(built the graph|graph built|skipped graph build|skipped the graph build)/);
});

test('CLI: --no-global stays quiet when the selection has nothing out-of-repo', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  // cursor writes only inside the repo, so there is nothing for --no-global to skip.
  const out = cliStderr(repo, home, ['--agents', 'cursor', '--no-global']);
  assert.ok(existsSync(join(repo, '.cursor', 'rules', 'graft.mdc')));
  assert.doesNotMatch(out, /skipped out-of-repo writes/);
});

test('CLI: --dry-run respects an explicit --agents list', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const out = cliStderr(repo, home, ['--agents', 'adal', '--dry-run']);
  assert.ok(out.includes(join('.adal', 'skills', 'graft', 'SKILL.md')), out);
  assert.doesNotMatch(out, /AGENTS\.md/);
  assert.doesNotMatch(out, /affects ALL repos/);
});
