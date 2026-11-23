/**
 * First-class Google Antigravity host (#62): AGENTS.md instructions, MCP registration
 * in Antigravity's OWN config path (not Gemini CLI's), and the shared skill. Detection
 * keys off Antigravity-specific markers so a plain Gemini-CLI user isn't dragged in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHosts } from '../src/hosts/registry.js';
import { mcpTargets } from '../src/hosts/mcp-config.js';
import { installAntigravitySkill, antigravitySkillTargets } from '../src/hosts/antigravity.js';
import { runHostsInit } from '../src/hosts/init.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-agy-')); }
const probe = (home: string, repo: string, dirs: string[]) => ({
  home, repo, dirExists: (p: string) => dirs.some((d) => p === join(home, d) || p === join(repo, d)),
});

test("Antigravity detects on its own markers, not bare ~/.gemini", () => {
  const home = fresh(), repo = fresh();
  const ids = (dirs: string[]) => detectHosts(probe(home, repo, dirs)).map((h) => h.id);
  // Antigravity's global config dir → antigravity (Gemini CLI needs bare ~/.gemini)
  assert.ok(ids([join('.gemini', 'config')]).includes('antigravity'), 'config dir → antigravity');
  // a workspace .agents dir → antigravity
  assert.ok(ids(['.agents']).includes('antigravity'), '.agents → antigravity');
  // bare ~/.gemini alone is Gemini CLI, NOT Antigravity
  const bare = ids(['.gemini']);
  assert.ok(bare.includes('gemini') && !bare.includes('antigravity'), 'bare ~/.gemini is gemini only');
});

test("Antigravity MCP registers in ~/.gemini/config/mcp_config.json (global, mcpServers)", () => {
  const home = fresh();
  const [t] = mcpTargets('/repo', ['antigravity'], { home });
  assert.ok(t, 'a target exists');
  assert.equal(t.path, join(home, '.gemini', 'config', 'mcp_config.json'));
  assert.equal(t.scope, 'global', 'applies to every workspace');
  assert.equal(t.format, 'json');
  assert.equal(t.topKey, 'mcpServers');
});

test("Antigravity skill lands in ~/.gemini/skills/graft/SKILL.md, idempotently", () => {
  const home = fresh();
  const [target] = antigravitySkillTargets(home);
  assert.equal(target.path, join(home, '.gemini', 'skills', 'graft', 'SKILL.md'));

  const first = installAntigravitySkill(home);
  assert.equal(first[0].action, 'created');
  assert.ok(existsSync(target.path) && readFileSync(target.path, 'utf8').includes('graft ask'));
  const second = installAntigravitySkill(home);
  assert.equal(second[0].action, 'unchanged', 're-run is a no-op');
});

test("runHostsInit --agents antigravity writes AGENTS.md + MCP + hooks + skill", () => {
  const home = fresh(), repo = fresh();
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  const r = runHostsInit(repo, { agents: ['antigravity'], home });
  assert.deepEqual(r.written.map((w) => w.id), ['antigravity']);
  assert.ok(readFileSync(join(repo, 'AGENTS.md'), 'utf8').includes('graft ask'), 'AGENTS.md written');
  assert.ok(r.mcp.some((w) => w.path.endsWith(join('.gemini', 'config', 'mcp_config.json'))), 'MCP registered');
  assert.ok(r.hooks.some((w) => w.path.endsWith(join('.gemini', 'config', 'hooks.json'))), 'hooks registered');
  assert.ok(r.hooks.some((w) => w.path.endsWith(join('skills', 'graft', 'SKILL.md'))), 'skill placed');
  // --no-hooks skips the hook layer while keeping MCP + skill
  const noHooksHome = fresh();
  mkdirSync(join(noHooksHome, '.gemini', 'config'), { recursive: true });
  const noHooks = runHostsInit(fresh(), { agents: ['antigravity'], home: noHooksHome, hooks: false });
  assert.ok(noHooks.mcp.length > 0, 'MCP survives --no-hooks');
  assert.ok(!noHooks.hooks.some((w) => w.path.endsWith('hooks.json')), 'hooks skipped under --no-hooks');
  assert.ok(noHooks.hooks.some((w) => w.path.endsWith(join('skills', 'graft', 'SKILL.md'))), 'skill survives --no-hooks');
  // --no-global suppresses all global writes (MCP + hooks + skill), keeps AGENTS.md
  const noGlobal = runHostsInit(fresh(), { agents: ['antigravity'], home: fresh(), global: false });
  assert.equal(noGlobal.mcp.length, 0, 'no MCP write under --no-global');
  assert.equal(noGlobal.hooks.length, 0, 'no skill or hook write under --no-global');
});
