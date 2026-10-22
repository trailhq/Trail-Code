/**
 * The other agents' files under trail's names.
 *
 * A machine with only `@trailhq/trail-code` has no `graft` command, so a repo
 * wired by trail tells every agent to run `trail …`, names the files the tool
 * owns after trail (as Claude Code's skill and shims are), and registers the
 * MCP server as `trail`. A repo moving from graft's names to trail's ends up
 * with trail's files only, and uninstall removes either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the MCP launch command to the npx form, whatever this machine has installed.
process.env.GRAFT_MCP_NPX = '1';
process.env.TRAIL_NO_FETCH = '1';
delete process.env.GRAFT_NO_TRAIL_SWITCH;

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHostsInit } from '../src/hosts/init.js';
import { HOSTS, hostRelPath, hostWiringName } from '../src/hosts/registry.js';
import { instructionBody, cursorRule } from '../src/hosts/instructions.js';
import { trailSpelling } from '../src/claude/skill-template.js';
import { GRAFT_MARKERS, TRAIL_MARKERS, fencedBlock, upsertSection } from '../src/hosts/sections.js';
import { registerMcpConfigs } from '../src/hosts/mcp-config.js';
import { changed, runRetract } from '../src/hosts/retract.js';
import { runInit } from '../src/claude/init.js';
import { runUpkeep } from '../src/upkeep-run.js';
import { readStamp, runningVersion, wiredHostIds } from '../src/upkeep.js';
import { BRAND_ENV } from '../src/brand.js';
import { tmpRepo } from './helpers.js';

const ALL = HOSTS.map((h) => h.id);
/** A graft command an agent would be told to run. `graft/` (the code map's folder) is not one. */
const GRAFT_COMMAND = /\bgraft (ask|grep|callers|skeleton|map|build|check|stats|note|mcp)\b/;

/** Every file under `dir`, repo-relative, skipping the graph and git. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'graft') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** A scratch home where every agent with a machine-wide config is installed. */
function agentHome(): string {
  const home = tmpRepo('trail-hosts-home');
  for (const d of [['.codex'], ['.config', 'opencode'], ['.gemini', 'config']]) mkdirSync(join(home, ...d), { recursive: true });
  return home;
}

test('trail spelling: renamed commands, the name in prose, the code map folder moved', () => {
  assert.equal(trailSpelling('run `graft check` in CI'), 'run `trail build --check` in CI');
  assert.equal(trailSpelling('`graft stats --json`'), '`trail status --json`');
  assert.equal(trailSpelling('`graft checkout x` and `graft ask "q"`'), '`trail checkout x` and `trail ask "q"`');
  assert.equal(trailSpelling('## Graft — see graft/INDEX.md, graft-hooks.cjs, graft_find_code'), '## Trail — see .trail/cache/INDEX.md, graft-hooks.cjs, graft_find_code');
  assert.equal(trailSpelling('`graft/` holds it, unlike .claude/skills/graft/ or @nanonets/graft/x'), '`.trail/cache/` holds it, unlike .claude/skills/graft/ or @nanonets/graft/x');
});

test('the instruction text under trail names trail commands only; under graft it is what it was', () => {
  const trail = instructionBody('trail');
  assert.match(trail, /^## Trail — repo context graph/);
  assert.match(trail, /`trail ask "<your question>" --source`/);
  assert.match(trail, /`trail grep "<literal>"`/);
  assert.match(trail, /`trail callers <symbol>`/);
  assert.match(trail, /`\.trail\/cache\/INDEX\.md`/, 'under trail the code map is in .trail/cache/');
  assert.doesNotMatch(trail, GRAFT_COMMAND);
  assert.match(cursorRule('trail'), /^---\ndescription: Use the Trail context graph in \.trail\/cache\/ before exploring source\nalwaysApply: true\n---\n## Trail/);
  assert.equal(instructionBody('graft'), instructionBody());
  assert.match(instructionBody(), /^## Graft — repo context graph/);
});

test('trail init for every agent: trail-named files, trail commands, a trail server', () => {
  const home = agentHome();
  const repo = tmpRepo('trail-hosts');
  const r = runHostsInit(repo, { all: true, home, brand: 'trail' });
  assert.equal(r.written.length, ALL.length);

  const files = filesUnder(repo);
  assert.deepEqual(files.filter((f) => /\bgraft\b/.test(f)), [], `no graft-named file in the repo: ${files.join(', ')}`);
  for (const rel of [
    join('.cursor', 'rules', 'trail.mdc'),
    join('.cursor', 'hooks', 'trail-hooks.cjs'),
    join('.kiro', 'steering', 'trail.md'),
    join('.windsurf', 'rules', 'trail.md'),
    join('.adal', 'skills', 'trail', 'SKILL.md'),
    join('.grok', 'skills', 'trail', 'SKILL.md'),
  ]) assert.ok(files.includes(rel), `${rel} written`);

  // Every instruction file tells the agent to run trail, never graft.
  for (const host of HOSTS) {
    const text = readFileSync(join(repo, hostRelPath(host, 'trail')), 'utf8');
    assert.doesNotMatch(text, GRAFT_COMMAND, `${host.id} names a graft command`);
    assert.match(text, /\btrail (ask|grep)\b/, `${host.id} names trail's`);
  }
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.equal(agents.split(TRAIL_MARKERS.start).length - 1, 1, 'one block, shared by three hosts');
  assert.ok(!agents.includes(GRAFT_MARKERS.start));
  assert.match(readFileSync(join(repo, '.adal', 'skills', 'trail', 'SKILL.md'), 'utf8'), /^---\nname: trail\n/);

  // The MCP server is trail's, under trail's name, in every config.
  const npx = { command: 'npx', args: ['-y', '@trailhq/trail-code', 'mcp'] };
  for (const rel of [join('.cursor', 'mcp.json'), join('.gemini', 'settings.json'), join('.kiro', 'settings', 'mcp.json')]) {
    assert.deepEqual(JSON.parse(readFileSync(join(repo, rel), 'utf8')).mcpServers, { trail: npx }, rel);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(repo, 'opencode.json'), 'utf8')).mcp, { trail: { type: 'local', command: ['npx', '-y', '@trailhq/trail-code', 'mcp'], enabled: true } });
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers, { trail: npx });
  for (const toml of [join(repo, '.grok', 'config.toml'), join(home, '.codex', 'config.toml')]) {
    assert.equal(readFileSync(toml, 'utf8'), '[mcp_servers.trail]\ncommand = "npx"\nargs = ["-y", "@trailhq/trail-code", "mcp"]\n', toml);
  }
  assert.ok(existsSync(join(home, '.gemini', 'skills', 'trail', 'SKILL.md')));
  assert.ok(!existsSync(join(home, '.gemini', 'skills', 'graft')));
  const hooks = JSON.parse(readFileSync(join(repo, '.cursor', 'hooks.json'), 'utf8'));
  assert.match(hooks.hooks.postToolUse[0].command, /trail-hooks\.cjs" cursor-post-tool$/);

  // A teammate on graft refreshing the same repo writes the same files: it never flips back.
  assert.equal(hostWiringName(repo), 'trail');
  const again = runHostsInit(repo, { all: true, home });
  assert.ok(again.written.every((w) => w.action === 'unchanged'), JSON.stringify(again.written));
  assert.ok(again.mcp.every((w) => w.action === 'unchanged'), JSON.stringify(again.mcp));
});

test('a graft-wired repo moved to trail keeps one copy of everything, under trail', () => {
  const home = agentHome();
  const repo = tmpRepo('graft-to-trail-hosts');
  writeFileSync(join(repo, 'AGENTS.md'), '# House rules\n\nBe kind.\n');
  runHostsInit(repo, { all: true, home });
  assert.ok(readFileSync(join(repo, 'AGENTS.md'), 'utf8').includes(GRAFT_MARKERS.start), 'wired as graft');
  assert.equal(hostWiringName(repo), 'graft');

  runHostsInit(repo, { all: true, home, brand: 'trail' });
  const files = filesUnder(repo);
  assert.deepEqual(files.filter((f) => /\bgraft\b/.test(f)), [], `graft's copies are gone: ${files.join(', ')}`);
  assert.ok(!existsSync(join(repo, '.adal', 'skills', 'graft')), 'and their folders');
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.equal(agents, `# House rules\n\nBe kind.\n\n${fencedBlock(instructionBody('trail'), '\n', TRAIL_MARKERS)}\n`, 'the graft block became the trail one, in place');
  for (const rel of ['GEMINI.md', join('.github', 'copilot-instructions.md')]) {
    const text = readFileSync(join(repo, rel), 'utf8');
    assert.ok(!text.includes(GRAFT_MARKERS.start) && text.split(TRAIL_MARKERS.start).length === 2, rel);
  }
  for (const rel of [join('.cursor', 'mcp.json'), join('.gemini', 'settings.json'), join('.kiro', 'settings', 'mcp.json')]) {
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(repo, rel), 'utf8')).mcpServers), ['trail'], rel);
  }
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(repo, 'opencode.json'), 'utf8')).mcp), ['trail']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers), ['trail']);
  for (const toml of [join(repo, '.grok', 'config.toml'), join(home, '.codex', 'config.toml')]) {
    const text = readFileSync(toml, 'utf8');
    assert.ok(!text.includes('[mcp_servers.graft]') && text.includes('[mcp_servers.trail]'), toml);
  }
  assert.ok(!existsSync(join(home, '.gemini', 'skills', 'graft')));
  const hooks = JSON.parse(readFileSync(join(repo, '.cursor', 'hooks.json'), 'utf8'));
  for (const [event, entries] of Object.entries<unknown[]>(hooks.hooks)) {
    assert.equal(entries.length, 1, `${event}: one entry`);
    assert.match(JSON.stringify(entries), /trail-hooks\.cjs/);
  }
});

test('a file holding both blocks keeps one: trail\'s, where trail\'s was', () => {
  const dir = tmpRepo('both-blocks');
  const graft = fencedBlock('old graft text', '\n', GRAFT_MARKERS);
  const trail = fencedBlock('old trail text', '\n', TRAIL_MARKERS);
  const want = fencedBlock('new text', '\n', TRAIL_MARKERS);
  const cases: Array<[string, string]> = [
    [`# Notes\n\n${trail}\n\n${graft}\n`, `# Notes\n\n${want}\n`],
    [`${graft}\n\n${trail}\n`, `${want}\n`],
    [`# Notes\n\n${graft}\n\nMore notes.\n`, `# Notes\n\n${want}\n\nMore notes.\n`],
    [`# Notes\r\n\r\n${graft.replace(/\n/g, '\r\n')}\r\n`, `# Notes\r\n\r\n${want.replace(/\n/g, '\r\n')}\r\n`],
  ];
  for (const [i, [before, after]] of cases.entries()) {
    const f = join(dir, `AGENTS-${i}.md`);
    writeFileSync(f, before);
    assert.equal(upsertSection(f, 'new text', TRAIL_MARKERS, [GRAFT_MARKERS]).action, 'replaced');
    assert.equal(readFileSync(f, 'utf8'), after, `case ${i}`);
    assert.equal(upsertSection(f, 'new text', TRAIL_MARKERS, [GRAFT_MARKERS]).action, 'unchanged', `case ${i} converged`);
  }
});

test('a graft repo leaves a machine-wide trail server alone instead of adding graft\'s beside it', () => {
  const home = agentHome();
  const codex = join(home, '.codex', 'config.toml');
  const trailTable = '[mcp_servers.trail]\ncommand = "trail"\nargs = ["mcp"]\n';
  writeFileSync(codex, trailTable);
  const ag = join(home, '.gemini', 'config', 'mcp_config.json');
  writeFileSync(ag, `${JSON.stringify({ mcpServers: { trail: { command: 'trail', args: ['mcp'] } } }, null, 2)}\n`);
  const repo = tmpRepo('graft-repo-trail-machine');
  const ws = registerMcpConfigs(repo, ['agents', 'antigravity', 'cursor'], { home });
  assert.deepEqual(ws.map((w) => [w.id, w.action]), [['codex', 'unchanged'], ['opencode', 'created'], ['antigravity', 'unchanged'], ['cursor', 'created']]);
  assert.equal(readFileSync(codex, 'utf8'), trailTable);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(ag, 'utf8')).mcpServers), ['trail']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8')).mcpServers), ['graft'], 'the repo\'s own config is still graft\'s');
});

test('uninstall removes the wiring under either name, keeping the user\'s words', () => {
  const home = agentHome();
  const repo = tmpRepo('uninstall-both');
  writeFileSync(join(repo, 'AGENTS.md'), '# House rules\n');
  runHostsInit(repo, { all: true, home, brand: 'trail' });
  // A teammate on an older graft added its copies back beside trail's.
  writeFileSync(join(repo, 'AGENTS.md'), `${readFileSync(join(repo, 'AGENTS.md'), 'utf8')}\n${fencedBlock('graft', '\n', GRAFT_MARKERS)}\n`);
  mkdirSync(join(repo, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'rules', 'graft.mdc'), 'old\n');
  writeFileSync(join(repo, '.grok', 'config.toml'), `${readFileSync(join(repo, '.grok', 'config.toml'), 'utf8')}\n[mcp_servers.graft]\ncommand = "graft"\n`);
  mkdirSync(join(home, '.gemini', 'skills', 'graft'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'skills', 'graft', 'SKILL.md'), 'old\n');

  assert.ok(changed(runRetract(repo, { home, apply: true })).length > 0);
  assert.deepEqual(filesUnder(repo), ['AGENTS.md']);
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), '# House rules\n');
  assert.ok(!existsSync(join(home, '.gemini', 'skills', 'trail')) && !existsSync(join(home, '.gemini', 'skills', 'graft')));
  assert.ok(!existsSync(join(home, '.codex', 'config.toml')));
  assert.deepEqual(changed(runRetract(repo, { home, apply: true })), [], 'a second sweep finds nothing');
});

test('a session start that moves a graft repo to trail moves the other agents too', () => {
  const repo = tmpRepo('move-hosts');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const home = mkdtempSync(join(tmpdir(), 'move-hosts-home-'));
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TRAIL_HOME: process.env.TRAIL_HOME, [BRAND_ENV]: process.env[BRAND_ENV] };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, '.trail') });
  try {
    delete process.env[BRAND_ENV];
    runInit(repo, { build: false, global: false });
    runHostsInit(repo, { agents: ['agents', 'cursor', 'gemini', 'kiro'], home, global: false });
    runUpkeep(repo, runningVersion(), { background: false, home });
    const hosts = readStamp(repo)?.hosts;
    assert.deepEqual(hosts, ['agents', 'antigravity', 'claude', 'cursor', 'gemini', 'hermes', 'kiro', 'pi'], 'AGENTS.md reads as all four of its hosts');

    const bin = mkdtempSync(join(tmpdir(), 'bin-trail-'));
    writeFileSync(join(bin, 'trail'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'trail'), 0o755);
    process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
    assert.match(runUpkeep(repo, runningVersion(), { background: false, home }).lines.join('\n'), /just moved to it/);

    const files = filesUnder(repo);
    assert.deepEqual(files.filter((f) => /\bgraft\b/.test(f)), [], `nothing graft-named left: ${files.join(', ')}`);
    for (const rel of ['AGENTS.md', 'GEMINI.md', join('.cursor', 'rules', 'trail.mdc'), join('.kiro', 'steering', 'trail.md')]) {
      const text = readFileSync(join(repo, rel), 'utf8');
      assert.doesNotMatch(text, GRAFT_COMMAND, rel);
      assert.ok(!text.includes(GRAFT_MARKERS.start), `${rel}: no graft block left`);
    }
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8')).mcpServers), ['trail']);
    assert.deepEqual(wiredHostIds(repo).sort(), hosts, 'the same agents, found under trail\'s names');
    assert.doesNotMatch(runUpkeep(repo, runningVersion(), { background: false, home }).lines.join('\n'), /just moved/, 'once');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('CLI: trail init --dry-run names trail\'s files', () => {
  const repo = tmpRepo('trail-dry');
  const home = tmpRepo('trail-dry-home');
  const r = spawnSync(process.execPath, ['--import', 'tsx', join('src', 'bin', 'trail.ts'), 'init', repo, '--no-build', '--agents', 'cursor', 'kiro', 'adal', '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, DO_NOT_TRACK: '1', TRAIL_INVOKED_AS: undefined, TRAIL_HOME: undefined },
  });
  assert.equal(r.status, 0, r.stderr);
  for (const rel of [join('.cursor', 'rules', 'trail.mdc'), join('.kiro', 'steering', 'trail.md'), join('.adal', 'skills', 'trail', 'SKILL.md')]) {
    assert.ok(r.stderr.includes(rel), `${rel} in ${r.stderr}`);
  }
  assert.doesNotMatch(r.stderr, /graft\.mdc|steering[\\/]graft\.md|skills[\\/]graft/);
  assert.deepEqual(readdirSync(repo), [], 'a dry run writes nothing');
});
