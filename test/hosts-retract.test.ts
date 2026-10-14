import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the MCP launch form so expectations don't depend on whether the machine
// running the tests happens to have graft on PATH.
process.env.GRAFT_MCP_NPX = '1';

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { planRetract, runRetract, changed } from '../src/hosts/retract.js';
import { runInit } from '../src/claude/init.js';
import { runHostsInit } from '../src/hosts/init.js';
import { registerMcpConfigs } from '../src/hosts/mcp-config.js';
import { mergeGraftSettings } from '../src/claude/settings-merge.js';

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'graft-retract-'));
}

function write(dir: string, rel: string, body: string): string {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** A retraction report keyed by path, for asserting one target at a time. */
function byPath(rs: ReturnType<typeof runRetract>): Map<string, string> {
  return new Map(rs.map((r) => [r.path, r.action]));
}

const BLOCK = '<!-- graft:start -->\n## Graft — old text\nstale guidance\n<!-- graft:end -->';

// --------------------------------------------------------------------------
// instruction files
// --------------------------------------------------------------------------

test('an owned instruction file is deleted outright', () => {
  const d = fresh();
  const rule = write(d, join('.cursor', 'rules', 'graft.mdc'), 'stale cursor rule\n');
  const r = byPath(runRetract(d, { apply: true, global: false }));
  assert.equal(r.get(rule), 'deleted');
  assert.ok(!existsSync(rule));
});

test('a fenced section is stripped and the user\'s prose survives intact', () => {
  const d = fresh();
  const agents = write(d, 'AGENTS.md', `# My repo\n\nUser notes here.\n\n${BLOCK}\n\nMore user notes.\n`);
  runRetract(d, { apply: true, global: false });
  assert.equal(readFileSync(agents, 'utf8'), '# My repo\n\nUser notes here.\n\nMore user notes.\n');
});

test('a file that held nothing but the graft block is deleted, not left blank', () => {
  const d = fresh();
  const gemini = write(d, 'GEMINI.md', `${BLOCK}\n`);
  const r = byPath(runRetract(d, { apply: true, global: false }));
  assert.equal(r.get(gemini), 'deleted');
  assert.ok(!existsSync(gemini), 'an empty GEMINI.md is residue too');
});

test('a shared file with no graft block is reported absent and never touched', () => {
  const d = fresh();
  const agents = write(d, 'AGENTS.md', '# Just my notes\n');
  const r = byPath(runRetract(d, { apply: true, global: false }));
  assert.equal(r.get(agents), 'absent');
  assert.equal(readFileSync(agents, 'utf8'), '# Just my notes\n');
});

// --------------------------------------------------------------------------
// JSON configs
// --------------------------------------------------------------------------

test('mcpServers.graft is removed and foreign servers are preserved', () => {
  const d = fresh();
  const mcp = write(d, '.mcp.json', JSON.stringify({
    mcpServers: { graft: { command: 'graft', args: ['mcp'] }, other: { command: 'x' } },
  }));
  runRetract(d, { apply: true, global: false });
  const root = JSON.parse(readFileSync(mcp, 'utf8'));
  assert.deepEqual(Object.keys(root.mcpServers), ['other']);
});

test('a JSON config holding only the graft server is deleted', () => {
  const d = fresh();
  const kiro = write(d, join('.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { graft: {} } }));
  const r = byPath(runRetract(d, { apply: true, global: false }));
  assert.equal(r.get(kiro), 'deleted');
  assert.ok(!existsSync(kiro), 'no orphan {} left behind');
});

test('unparseable JSON is reported and left byte-for-byte alone', () => {
  const d = fresh();
  const body = '{ "mcpServers": { "graft": }  // trailing junk\n';
  const mcp = write(d, '.mcp.json', body);
  const r = byPath(runRetract(d, { apply: true, global: false }));
  assert.equal(r.get(mcp), 'skipped-unparseable');
  assert.equal(readFileSync(mcp, 'utf8'), body);
});

// --------------------------------------------------------------------------
// TOML
// --------------------------------------------------------------------------

test('[mcp_servers.graft] is removed and the neighbouring table survives', () => {
  const d = fresh();
  const toml = write(d, join('.grok', 'config.toml'),
    '[mcp_servers.graft]\ncommand = "npx"\nargs = ["-y","@nanonets/graft","mcp"]\n\n[mcp_servers.keepme]\ncommand = "y"\n');
  runRetract(d, { apply: true, global: false });
  const text = readFileSync(toml, 'utf8');
  assert.ok(!text.includes('mcp_servers.graft'));
  assert.ok(text.includes('[mcp_servers.keepme]'));
  assert.ok(!text.startsWith('\n'), 'no leading blank line left behind');
});

// --------------------------------------------------------------------------
// .claude/settings.json — graft's fragments inside a file the user owns
// --------------------------------------------------------------------------

test('graft settings fragments are removed and the user\'s own settings kept', () => {
  const d = fresh();
  const settings = write(d, join('.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'node ".claude/helpers/graft-statusline.cjs"' },
    hooks: {
      PostToolUse: [
        { matcher: 'Write', hooks: [{ type: 'command', command: 'node graft-hooks.cjs post-edit' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'node graft-hooks.cjs stop' }] }],
    },
    footerLinksRegexes: ['graft/[\\w./-]+\\.md', 'docs/.*'],
    permissions: { allow: ['Bash(graft:*)', 'Bash(ls:*)'] },
    model: 'opus',
  }));
  runRetract(d, { apply: true, global: false });
  const root = JSON.parse(readFileSync(settings, 'utf8'));

  assert.equal(root.statusLine, undefined, 'graft statusline gone');
  assert.equal(root.hooks.Stop, undefined, 'graft-only event dropped entirely');
  assert.equal(root.hooks.PostToolUse.length, 1);
  assert.equal(root.hooks.PostToolUse[0].hooks[0].command, 'my-own-hook.sh', 'foreign hook kept');
  assert.deepEqual(root.footerLinksRegexes, ['docs/.*']);
  assert.deepEqual(root.permissions.allow, ['Bash(ls:*)']);
  assert.equal(root.model, 'opus', 'unrelated settings untouched');
});

test('an older statusline shape is still recognized as graft\'s own', () => {
  const d = fresh();
  // A hypothetical v4 command: different wrapper, same shim path.
  const settings = write(d, join('.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'sh -c \'node .claude/helpers/graft-statusline.cjs\'' },
  }));
  const r = byPath(runRetract(d, { apply: true, global: false }));
  assert.equal(r.get(settings), 'deleted', 'matched by shim path, not string equality');
});

test('a statusline the user actually wrote is left alone', () => {
  const d = fresh();
  const settings = write(d, join('.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'my-prompt.sh' },
  }));
  runRetract(d, { apply: true, global: false });
  const root = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(root.statusLine.command, 'my-prompt.sh');
});

// --------------------------------------------------------------------------
// the cache + ignore entries
// --------------------------------------------------------------------------

test('graft/ and its ignore entries go, and the user\'s ignores stay', () => {
  const d = fresh();
  mkdirSync(join(d, 'graft'), { recursive: true });
  writeFileSync(join(d, 'graft', 'INDEX.md'), '# index\n');
  const gitignore = write(d, '.gitignore', 'node_modules/\ndist/\n\n# graft\'s local graph cache — regenerable, not committed (run `graft build`).\n/graft/\n');
  runRetract(d, { apply: true, global: false });
  assert.ok(!existsSync(join(d, 'graft')));
  assert.equal(readFileSync(gitignore, 'utf8'), 'node_modules/\ndist/\n');
});

test('--keep-cache leaves graft/ and .gitignore untouched', () => {
  const d = fresh();
  mkdirSync(join(d, 'graft'), { recursive: true });
  const gitignore = write(d, '.gitignore', '/graft/\n');
  runRetract(d, { apply: true, global: false, cache: false });
  assert.ok(existsSync(join(d, 'graft')), 'cache kept');
  assert.equal(readFileSync(gitignore, 'utf8'), '/graft/\n');
});

// --------------------------------------------------------------------------
// contract-level properties
// --------------------------------------------------------------------------

test('planRetract is pure — it reports without touching anything', () => {
  const d = fresh();
  const rule = write(d, join('.cursor', 'rules', 'graft.mdc'), 'stale\n');
  const agents = write(d, 'AGENTS.md', `notes\n\n${BLOCK}\n`);
  const plan = planRetract(d, { global: false });

  assert.ok(existsSync(rule), 'plan did not delete');
  assert.equal(readFileSync(agents, 'utf8'), `notes\n\n${BLOCK}\n`);
  const p = new Map(plan.map((r) => [r.path, r.action]));
  assert.equal(p.get(rule), 'deleted');
  assert.equal(p.get(agents), 'removed');
});

test('a full init is fully retractable, and retraction is idempotent', () => {
  const d = fresh();
  runInit(d, { build: false, home: fresh() });
  runHostsInit(d, { agents: ['cursor', 'agents'], home: d, global: false });

  const first = changed(runRetract(d, { apply: true, global: false }));
  assert.ok(first.length > 0, 'init left something to retract');

  // Everything init wrote for those hosts is gone.
  for (const rel of [
    join('.claude', 'settings.json'),
    join('.claude', 'helpers', 'graft-statusline.cjs'),
    join('.claude', 'helpers', 'graft-hooks.cjs'),
    join('.claude', 'skills', 'graft', 'SKILL.md'),
    join('.cursor', 'rules', 'graft.mdc'),
    '.mcp.json',
  ]) {
    assert.ok(!existsSync(join(d, rel)), `${rel} should be gone`);
  }

  // A second sweep finds nothing — no residue, no double-removal.
  const second = changed(runRetract(d, { apply: true, global: false }));
  assert.deepEqual(second, [], `second sweep should be a no-op, got ${JSON.stringify(second)}`);
});

test('exclude spares the hosts init is about to rewrite', () => {
  const d = fresh();
  const cursor = write(d, join('.cursor', 'rules', 'graft.mdc'), 'cursor\n');
  const kiro = write(d, join('.kiro', 'steering', 'graft.md'), 'kiro\n');
  runRetract(d, { apply: true, global: false, exclude: ['cursor'] });
  assert.ok(existsSync(cursor), 'selected host kept');
  assert.ok(!existsSync(kiro), 'unselected host retracted');
});

test('--no-global never reaches outside the repo', () => {
  const d = fresh();
  const home = fresh();
  // A machine-level Codex install with graft's hook shim in it.
  write(home, join('.codex', 'hooks', 'graft', 'graft-hooks.cjs'), 'shim\n');
  const rs = runRetract(d, { apply: true, home, global: false });
  assert.equal(rs.filter((r) => r.scope === 'global').length, 0, 'no global targets even considered');
  assert.ok(existsSync(join(home, '.codex', 'hooks', 'graft', 'graft-hooks.cjs')));
});

test('global sweep strips graft hook entries from Codex hooks.json, keeping foreign ones', () => {
  const d = fresh();
  const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const cfg = write(home, join('.codex', 'hooks.json'), JSON.stringify({
    hooks: {
      PostToolUse: [
        { hooks: [{ type: 'command', command: 'node "/x/graft-hooks.cjs" post-edit' }] },
        { hooks: [{ type: 'command', command: 'their-hook.sh' }] },
      ],
    },
  }));
  runRetract(d, { apply: true, home, global: true });
  const root = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(root.hooks.PostToolUse.length, 1);
  assert.equal(root.hooks.PostToolUse[0].hooks[0].command, 'their-hook.sh');
});

test('emptied directories are pruned, not left hollow', () => {
  const d = fresh();
  write(d, join('.claude', 'skills', 'graft', 'SKILL.md'), 'skill\n');
  runRetract(d, { apply: true, global: false });
  assert.ok(!existsSync(join(d, '.claude', 'skills', 'graft')), 'graft/ skill dir pruned');
  assert.ok(!existsSync(join(d, '.claude', 'skills')), 'now-empty skills/ pruned too');
});

// --------------------------------------------------------------------------
// the two append-only writers, now converging
// --------------------------------------------------------------------------

test('a stale [mcp_servers.graft] is replaced, not skipped', () => {
  const d = fresh();
  const cfg = write(d, join('.grok', 'config.toml'),
    '[mcp_servers.keepme]\ncommand = "y"\n\n[mcp_servers.graft]\ncommand = "OLD-BINARY"\nargs = ["stale"]\n');
  const [w] = registerMcpConfigs(d, ['grok'], { home: d });

  assert.equal(w.action, 'updated', 'an existing section used to freeze the launch command');
  const text = readFileSync(cfg, 'utf8');
  assert.ok(!text.includes('OLD-BINARY'), 'stale command gone');
  assert.ok(text.includes('[mcp_servers.keepme]'), 'foreign table preserved');
  assert.equal((text.match(/\[mcp_servers\.graft\]/g) ?? []).length, 1, 'exactly one graft section');

  // Second run is a no-op, not a churn.
  assert.equal(registerMcpConfigs(d, ['grok'], { home: d })[0].action, 'unchanged');
  assert.equal(readFileSync(cfg, 'utf8'), text, 'byte-identical on re-run');
});

test('a renamed allowlist entry is dropped; the user\'s own rules stay', () => {
  const { merged } = mergeGraftSettings({
    permissions: { allow: ['Bash(graft-dev:*)', 'Bash(ls:*)', 'Bash(graft-mytool:*)'] },
  });
  const allow: string[] = merged.permissions.allow;
  assert.ok(allow.includes('Bash(ls:*)'), 'unrelated rule kept');
  assert.ok(allow.includes('Bash(graft-mytool:*)'), 'the user\'s own graft-prefixed rule kept');
  assert.equal(allow.filter((a) => a === 'Bash(graft-dev:*)').length, 1, 'no duplicate of graft\'s own entry');
});

test('a superseded footer regex is replaced rather than stacked', () => {
  const { merged } = mergeGraftSettings({
    footerLinksRegexes: ['graft/OLD-PATTERN\\.md', 'docs/.*'],
  });
  assert.ok(!merged.footerLinksRegexes.includes('graft/OLD-PATTERN\\.md'), 'old graft pattern gone');
  assert.ok(merged.footerLinksRegexes.includes('docs/.*'), 'user pattern kept');
  assert.equal(merged.footerLinksRegexes.filter((r: string) => r.startsWith('graft/')).length, 1);
});

test('mergeGraftSettings stays idempotent over repeated runs', () => {
  const once = mergeGraftSettings({}).merged;
  const twice = mergeGraftSettings(structuredClone(once)).merged;
  assert.deepEqual(twice, once, 'a re-init must not grow the file');
});

test('a shared AGENTS.md is spared when any host that writes it is kept', () => {
  const d = fresh();
  // Three registry hosts name AGENTS.md: agents, hermes, antigravity.
  const agents = write(d, 'AGENTS.md', `# Notes\n\n${BLOCK}\n`);
  runRetract(d, { apply: true, global: false, exclude: ['agents'] });
  assert.ok(readFileSync(agents, 'utf8').includes('graft:start'),
    'hermes/antigravity must not strip the block that the kept `agents` host owns');
});

test('hosts sharing one path produce a single retraction, not one each', () => {
  const d = fresh();
  const agents = write(d, 'AGENTS.md', `# Notes\n\n${BLOCK}\n`);
  const rs = runRetract(d, { global: false }).filter((r) => r.path === agents);
  assert.equal(rs.length, 1, `AGENTS.md should be queued once, got ${rs.length}`);
});

// ---------------------------------------------------------------------------
// Issue #546: retract removes dotted subtables, not just the parent table
// ---------------------------------------------------------------------------

test('[mcp_servers.graft.env] orphan does not survive retract', () => {
  const d = fresh();
  const toml = write(d, join('.grok', 'config.toml'),
    '[mcp_servers.graft]\ncommand = "npx"\nargs = ["-y","@nanonets/graft","mcp"]\n\n[mcp_servers.graft.env]\nDO_NOT_TRACK = "1"\n\n[mcp_servers.keepme]\ncommand = "y"\n');
  runRetract(d, { apply: true, global: false });
  const text = readFileSync(toml, 'utf8');
  assert.ok(!text.includes('mcp_servers.graft'), 'no graft residue of any depth');
  assert.ok(text.includes('[mcp_servers.keepme]'), 'foreign table preserved');
});

test('orphan-only graft subtable is removed by retract', () => {
  const d = fresh();
  const toml = write(d, join('.grok', 'config.toml'),
    '[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.graft.env]\nDO_NOT_TRACK = "1"\n');
  runRetract(d, { apply: true, global: false });
  const text = readFileSync(toml, 'utf8');
  assert.ok(!text.includes('mcp_servers.graft'), 'orphan gone via uninstall path');
  assert.ok(text.includes('[mcp_servers.other]'), 'foreign preserved');
});
