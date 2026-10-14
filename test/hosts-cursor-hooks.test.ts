import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCursorHooks, cursorHookTargets } from '../src/hosts/cursor-hooks.js';
import { runHostsInit } from '../src/hosts/init.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-cursorhooks-')); }

const HAS_EXEC_BIT = process.platform !== 'win32';
function assertRunnableShim(shim: string, note: string): void {
  assert.ok(existsSync(shim), `${note}: shim missing at ${shim}`);
  if (HAS_EXEC_BIT) assert.ok(statSync(shim).mode & 0o111, note);
}

const shimPath = (repo: string) => join(repo, '.cursor', 'hooks', 'graft-hooks.cjs');
const cfgPath = (repo: string) => join(repo, '.cursor', 'hooks.json');

test('cursorHookTargets are repo-local and always present (no CLI-home gate)', () => {
  const repo = fresh();
  const t = cursorHookTargets(repo);
  assert.equal(t.length, 2);
  assert.ok(t.every((w) => w.scope === 'repo' && w.hostId === 'cursor'));
  assert.deepEqual(t.map((w) => w.path).sort(), [cfgPath(repo), shimPath(repo)].sort());
});

test('writes shim + hooks.json (version 1), idempotent on re-run', () => {
  const repo = fresh();
  const w = installCursorHooks(repo);
  assert.equal(w.length, 2);
  assertRunnableShim(shimPath(repo), 'shim is executable');
  const cfg = JSON.parse(readFileSync(cfgPath(repo), 'utf8'));
  assert.equal(cfg.version, 1, 'Cursor hooks.json carries a schema version');
  const sub = (event: string) => cfg.hooks[event][0].command.match(/graft-hooks\.cjs (\S+)$/)?.[1];
  assert.equal(sub('postToolUse'), 'cursor-post-tool');
  assert.equal(sub('afterMCPExecution'), 'cursor-mcp');
  assert.equal(sub('sessionEnd'), 'cursor-session-end');
  // Commands reference the shim relative to the repo root (Cursor runs project
  // hooks from there), so no checkout path leaks into the committed config.
  for (const ev of ['postToolUse', 'afterMCPExecution', 'sessionEnd']) {
    const command = cfg.hooks[ev][0].command;
    assert.equal(command, `node .cursor/hooks/graft-hooks.cjs ${sub(ev)}`);
    assert.ok(!command.includes(repo), `${ev} command carries an absolute checkout path`);
  }
  // postToolUse filters to the read/shell tools; the MCP + end hooks take every event.
  assert.match(cfg.hooks.postToolUse[0].matcher, /Read\|Grep\|Glob\|Search\|Shell/);
  assert.ok(!('matcher' in cfg.hooks.afterMCPExecution[0]), 'no matcher on afterMCPExecution');
  assert.ok(!('matcher' in cfg.hooks.sessionEnd[0]), 'no matcher on sessionEnd');

  const again = installCursorHooks(repo);
  assert.deepEqual(again.map((x) => x.action), ['unchanged', 'unchanged'], 'idempotent');
  const after = JSON.parse(readFileSync(cfgPath(repo), 'utf8'));
  for (const ev of ['postToolUse', 'afterMCPExecution', 'sessionEnd'])
    assert.equal(after.hooks[ev].length, 1, `${ev} not duplicated on re-run`);
});

test('foreign hook entries and a pre-existing version are preserved; stale graft entries replaced', () => {
  const repo = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  writeFileSync(cfgPath(repo), JSON.stringify({
    version: 1,
    hooks: {
      postToolUse: [
        { command: 'other-tool.sh' },
        { command: 'node /old/graft-hooks.cjs cursor-post-tool' },
      ],
    },
  }));
  installCursorHooks(repo);
  const entries = JSON.parse(readFileSync(cfgPath(repo), 'utf8')).hooks.postToolUse;
  assert.equal(entries.length, 2, 'foreign kept, stale graft replaced by fresh');
  assert.ok(entries.some((e: any) => e.command === 'other-tool.sh'), 'foreign entry preserved');
  assert.ok(entries.some((e: any) => e.command === 'node .cursor/hooks/graft-hooks.cjs cursor-post-tool'), 'fresh graft entry present');
  assert.ok(!JSON.stringify(entries).includes('/old/'), 'stale graft entry removed');
});

test('unparseable hooks.json is never rewritten', () => {
  const repo = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  writeFileSync(cfgPath(repo), '{ nope');
  const w = installCursorHooks(repo);
  assert.ok(w.some((x) => x.action === 'skipped-unparseable'));
  assert.equal(readFileSync(cfgPath(repo), 'utf8'), '{ nope');
});

// ── runHostsInit wiring ─────────────────────────────────────────────────────

test('runHostsInit --agents cursor writes repo-local hooks and never touches ~/.cursor', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['cursor'] });
  assert.ok(existsSync(cfgPath(repo)), 'hooks.json written in the repo');
  assert.ok(existsSync(shimPath(repo)), 'shim written in the repo');
  assert.ok(r.hooks.some((h) => h.id === 'cursor-hooks'), 'reported in result.hooks');
  // Nothing user-level: the home dir stays empty.
  assert.ok(!existsSync(join(home, '.cursor')), 'no ~/.cursor writes');
});

test('cursor hooks are repo-local, so --no-global does NOT suppress them', () => {
  const home = fresh(); const repo = fresh();
  runHostsInit(repo, { home, agents: ['cursor'], global: false });
  assert.ok(existsSync(cfgPath(repo)), '--no-global keeps the repo-local Cursor hooks');
});

test('--no-hooks skips the Cursor hook files (rule file still written)', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['cursor'], hooks: false });
  assert.ok(!existsSync(cfgPath(repo)), 'no hooks.json under --no-hooks');
  assert.ok(!existsSync(shimPath(repo)), 'no shim under --no-hooks');
  assert.ok(!r.hooks.some((h) => h.id?.startsWith('cursor')), 'no cursor hook writes reported');
  assert.ok(existsSync(join(repo, '.cursor', 'rules', 'graft.mdc')), 'the rule file is still written');
});
