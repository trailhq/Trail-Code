import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/claude/init.js';
import { planInit } from '../src/hosts/plan.js';
import { readStamp } from '../src/upkeep.js';
import { runUpkeep } from '../src/upkeep-run.js';
import { homeEnv, runCli, tmpRepo } from './helpers.js';

test('graft init skips Claude hook and MCP writes when both are declined', () => {
  const repo = tmpRepo('no-claude-wiring');
  const home = tmpRepo('no-claude-wiring-home');
  const env = { ...homeEnv(home), TRAIL_HOME: join(home, '.trail'), TRAIL_INVOKED_AS: 'graft', DO_NOT_TRACK: '1' };
  const result = runCli(['init', repo, '--no-build', '--agents', 'claude', '--no-hooks', '--no-mcp'], { env });
  assert.equal(result.status, 0, result.describe());
  for (const file of [
    join(repo, '.mcp.json'),
    join(repo, '.claude', 'helpers', 'graft-hooks.cjs'),
    join(home, '.claude.json'),
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'helpers', 'graft-hooks.cjs'),
  ]) assert.ok(!existsSync(file), file);
  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.statusLine);
  assert.equal(settings.hooks, undefined);
  const stamp = readStamp(repo);
  assert.equal(stamp?.opts?.hooks, false);
  assert.equal(stamp?.opts?.mcp, false);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  try {
    runUpkeep(repo, '99.0.0', { background: false, home });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(readStamp(repo)?.version, '99.0.0');
  assert.ok(!existsSync(join(repo, '.mcp.json')));
  assert.ok(!existsSync(join(repo, '.claude', 'helpers', 'graft-hooks.cjs')));
  assert.ok(!existsSync(join(home, '.claude.json')));
  assert.ok(!existsSync(join(home, '.claude', 'settings.json')));
  const plan = planInit(repo, { home, hooks: false, mcp: false }).find((host) => host.id === 'claude');
  assert.ok(plan);
  assert.ok(plan.writes.every((write) => write.kind !== 'hook' && write.kind !== 'mcp'));
});

test('Claude opt-outs keep hook and MCP registration independent', () => {
  const hooksRepo = tmpRepo('claude-only-hooks');
  const hooksHome = tmpRepo('claude-only-hooks-home');
  const mcpRepo = tmpRepo('claude-only-mcp');
  const mcpHome = tmpRepo('claude-only-mcp-home');
  runInit(hooksRepo, { build: false, home: hooksHome, mcp: false });
  runInit(mcpRepo, { build: false, home: mcpHome, hooks: false });
  for (const [repo, home, hooks] of [[hooksRepo, hooksHome, true], [mcpRepo, mcpHome, false]] as const) {
    assert.equal(existsSync(join(repo, '.mcp.json')), !hooks);
    assert.equal(existsSync(join(home, '.claude.json')), !hooks);
    assert.equal(existsSync(join(repo, '.claude', 'helpers', 'graft-hooks.cjs')), hooks);
    assert.equal(existsSync(join(home, '.claude', 'settings.json')), hooks);
  }
});

test('trail init preserves existing hook and MCP config when those writes are declined', () => {
  const repo = tmpRepo('no-trail-claude-wiring');
  const home = tmpRepo('no-trail-claude-wiring-home');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  const settingsPath = join(repo, '.claude', 'settings.json');
  const localPath = join(repo, '.claude', 'settings.local.json');
  const mcpPath = join(repo, '.mcp.json');
  const settings = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"project-hook"}]}]}}\n';
  const mcp = '{"mcpServers":{"graft":{"command":"graft","args":["mcp"]}}}\n';
  writeFileSync(settingsPath, settings);
  const localHooks = { Stop: [{ hooks: [{ type: 'command', command: 'node "./.trail/hook.cjs" stop' }] }] };
  writeFileSync(localPath, JSON.stringify({ hooks: localHooks }));
  writeFileSync(mcpPath, mcp);
  writeFileSync(join(home, '.claude.json'), mcp);
  runInit(repo, { build: false, brand: 'trail', home, statusline: true, hooks: false, mcp: false });
  assert.equal(readFileSync(settingsPath, 'utf8'), settings);
  assert.equal(readFileSync(mcpPath, 'utf8'), mcp);
  assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), mcp);
  assert.deepEqual(JSON.parse(readFileSync(localPath, 'utf8')).hooks, localHooks);
  assert.ok(!existsSync(join(repo, '.trail', 'hook.cjs')));
  assert.ok(existsSync(join(repo, '.trail', 'statusline.cjs')));
});
