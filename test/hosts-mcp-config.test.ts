import { test } from 'node:test';
import assert from 'node:assert/strict';

// The MCP launch command is resolved from PATH at init time; pin it to the npx
// form so these expectations are the same on every machine.
process.env.GRAFT_MCP_NPX = '1';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcpConfigs, serverEntry, stripTomlSection } from '../src/hosts/mcp-config.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-mcpcfg-')); }

for (const name of ['graft', 'trail'] as const) {
  for (const quote of ['"', "'"]) {
    test(`${name} removal preserves multiline ${quote} data and the other brand`, () => {
      const other = name === 'graft' ? 'trail' : 'graft';
      const delimiter = quote.repeat(3);
      const foreign = `[mcp_servers.${other}.env]\r\nSCRIPT = ${delimiter}\r\n[mcp_servers.${name}]\r\n\r\n\r\n[mcp_servers.${name}.env]\r\n${delimiter}\r\nKEEP = "yes"\r\n`;
      const similar = `[mcp_servers.${name}2]\r\ncommand = "foreign"\r\n`;
      const owned = `[mcp_servers.${name}]\r\nNOTE = ${delimiter}\r\n[mcp_servers.foreign]\r\n${delimiter}\r\n`;
      const text = owned + foreign + `[mcp_servers.${name}.env]\r\nOWNED = "remove"\r\n` + similar;
      assert.deepEqual(stripTomlSection(text, name), { found: true, rest: foreign + similar });
      assert.deepEqual(stripTomlSection(foreign + similar, name), { found: false, rest: foreign + similar });
    });
  }
}

test('Trail registration migrates both real table families but preserves multiline lookalikes', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const path = join(home, '.codex', 'config.toml');
  const foreign = '[mcp_servers.other.env]\nSCRIPT = """\n[mcp_servers.graft]\n\n\n[mcp_servers.trail.env]\n"""\nKEEP = "yes"\n';
  writeFileSync(path, '[mcp_servers.graft]\ncommand = "old"\n' + foreign
    + '[mcp_servers.trail.env]\nOLD_TRAIL = "remove"\n[mcp_servers.graft.env]\nOLD_GRAFT = "remove"\n');
  const writes = registerMcpConfigs(repo, ['agents'], { home, name: 'trail' });
  assert.deepEqual(writes.map((w) => w.action), ['updated']);
  const result = readFileSync(path, 'utf8');
  assert.ok(result.startsWith(foreign), 'foreign multiline data is byte-identical');
  assert.doesNotMatch(result, /OLD_TRAIL|OLD_GRAFT|command = "old"/);
  assert.match(result, /^\[mcp_servers\.trail\]$/m);
  assert.deepEqual(registerMcpConfigs(repo, ['agents'], { home, name: 'trail' }).map((w) => w.action), ['unchanged']);
  assert.equal(readFileSync(path, 'utf8'), result);
});

test('cursor/gemini/kiro get repo-local JSON entries', () => {
  const repo = fresh(); const home = fresh();
  const w = registerMcpConfigs(repo, ['cursor', 'gemini', 'kiro'], { home });
  assert.deepEqual(w.map((x) => x.action), ['created', 'created', 'created']);
  const cursor = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cursor.mcpServers.graft, { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] });
  assert.ok(existsSync(join(repo, '.gemini', 'settings.json')));
  assert.ok(existsSync(join(repo, '.kiro', 'settings', 'mcp.json')));
});

test('existing config keys are preserved; re-run is unchanged', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  registerMcpConfigs(repo, ['cursor'], { home });
  const cfg = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cfg.mcpServers.other, 'foreign server preserved');
  assert.ok(cfg.mcpServers.graft);
  const again = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(again.map((x) => x.action), ['unchanged']);
});

test('unparseable JSON is never clobbered', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'mcp.json'), '{ not json');
  const w = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(w.map((x) => x.action), ['skipped-unparseable']);
  assert.equal(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'), '{ not json');
});

test('agents id: codex TOML + opencode JSON, gated on home dirs', () => {
  const repo = fresh(); const home = fresh();
  assert.deepEqual(registerMcpConfigs(repo, ['agents'], { home }), [], 'nothing without home dirs');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const w = registerMcpConfigs(repo, ['agents'], { home });
  assert.equal(w.length, 2);
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.graft\]$/m);
  assert.match(toml, /"@nanonets\/graft"/);
  const oc = JSON.parse(readFileSync(join(repo, 'opencode.json'), 'utf8'));
  assert.equal(oc.mcp.graft.type, 'local');
  const again = registerMcpConfigs(repo, ['agents'], { home });
  assert.deepEqual(again.map((x) => x.action).sort(), ['unchanged', 'unchanged']);
});

test('codex TOML append preserves existing content', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
  registerMcpConfigs(repo, ['agents'], { home });
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /model = "o3"/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.match(toml, /\[mcp_servers\.graft\]/);
});

test('grok gets a repo-local TOML MCP section', () => {
  const repo = fresh(); const home = fresh();
  const w = registerMcpConfigs(repo, ['grok'], { home });
  assert.deepEqual(w.map((x) => x.action), ['created']);
  const toml = readFileSync(join(repo, '.grok', 'config.toml'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.graft\]$/m);
  assert.match(toml, /"@nanonets\/graft"/);
  const again = registerMcpConfigs(repo, ['grok'], { home });
  assert.deepEqual(again.map((x) => x.action), ['unchanged']);
});

test('JSON with non-object mcpServers value is skipped', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  const badJson = '{"mcpServers": "not-an-object"}';
  writeFileSync(join(repo, '.cursor', 'mcp.json'), badJson);
  const w = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(w.map((x) => x.action), ['skipped-unparseable']);
  assert.equal(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'), badJson);
});

// The launch command: bare binary when graft is installed, npx otherwise. Never an
// absolute path — these files are committed and shared between machines.
test('serverEntry prefers the installed binary and falls back to npx', () => {
  const saved = process.env.GRAFT_MCP_NPX;
  delete process.env.GRAFT_MCP_NPX;
  try {
    assert.deepEqual(serverEntry({ onPath: true }), { command: 'graft', args: ['mcp'] });
    assert.deepEqual(serverEntry({ onPath: false }), { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] });
    for (const e of [serverEntry({ onPath: true }), serverEntry({ onPath: false })]) {
      assert.ok(!e.command.startsWith('/'), 'never an absolute path — configs get shared');
    }
  } finally {
    if (saved !== undefined) process.env.GRAFT_MCP_NPX = saved;
  }
});

test('GRAFT_MCP_NPX overrides an installed binary', () => {
  process.env.GRAFT_MCP_NPX = '1';
  assert.equal(serverEntry({ onPath: true }).command, 'npx', 'the escape hatch wins');
});

// ---------------------------------------------------------------------------
// Issue #546: dotted subtables belong to the parent table
// ---------------------------------------------------------------------------

test('stripTomlSection removes dotted subtables of [mcp_servers.graft]', () => {
  const text = [
    '[mcp_servers.graft]',
    'command = "graft"',
    '',
    '[mcp_servers.graft.env]',
    'DO_NOT_TRACK = "1"',
    '',
    '[mcp_servers.other]',
    'command = "x"',
    '',
  ].join('\n');
  const { rest, found } = stripTomlSection(text);
  assert.equal(found, true);
  assert.ok(!rest.includes('[mcp_servers.graft]'), 'parent table gone');
  assert.ok(!rest.includes('[mcp_servers.graft.env]'), 'env subtable gone');
  assert.ok(!rest.includes('DO_NOT_TRACK'), 'subtable content gone');
  assert.ok(rest.includes('[mcp_servers.other]'), 'foreign table preserved');
});

test('stripTomlSection removes deeper dotted subtables', () => {
  const text = [
    '[mcp_servers.graft]',
    'command = "graft"',
    '',
    '[mcp_servers.graft.env.extra]',
    'X = "1"',
    '',
  ].join('\n');
  const { rest } = stripTomlSection(text);
  assert.ok(!rest.includes('mcp_servers.graft'), 'deep subtable gone');
});

test('stripTomlSection keeps similarly-named foreign tables', () => {
  for (const header of ['[mcp_servers.graft2]', '[other.graft]', '[graft]']) {
    const text = [`[mcp_servers.graft]\ncommand = "graft"\n`, `${header}\ncommand = "y"\n`].join('\n');
    const { rest, found } = stripTomlSection(text);
    assert.equal(found, true);
    assert.ok(!rest.includes('[mcp_servers.graft]\n'), 'own table gone');
    assert.ok(rest.includes(header), `${header} preserved`);
  }
});

test('stripTomlSection leaves files without graft untouched', () => {
  const text = '[mcp_servers.other]\ncommand = "x"\n';
  const { rest, found } = stripTomlSection(text);
  assert.equal(found, false);
  assert.equal(rest, text, 'byte-identical');
});

test('stripTomlSection removes non-contiguous family tables', () => {
  const text = [
    '[mcp_servers.other]',
    'command = "x"',
    '',
    '[mcp_servers.graft]',
    'command = "graft"',
    '',
    '[mcp_servers.graft2]',
    'command = "y"',
    '',
    '[mcp_servers.graft.env]',
    'DO_NOT_TRACK = "1"',
    '',
    '[mcp_servers.graft.foo.bar]',
    'Z = "2"',
    '',
    '[other.graft]',
    'command = "z"',
    '',
  ].join('\n');
  const { rest, found } = stripTomlSection(text);
  assert.equal(found, true);
  assert.ok(!rest.includes('mcp_servers.graft]'), 'no graft residue');
  assert.ok(!rest.includes('mcp_servers.graft.'), 'no graft subtable residue');
  assert.ok(!rest.includes('DO_NOT_TRACK'), 'subtable content gone');
  assert.ok(rest.includes('[mcp_servers.other]'), 'other preserved');
  assert.ok(rest.includes('[mcp_servers.graft2]'), 'graft2 preserved');
  assert.ok(rest.includes('[other.graft]'), 'other.graft preserved');
});

test('stripTomlSection removes orphan-only subtable without parent', () => {
  const text = [
    '[mcp_servers.other]',
    'command = "x"',
    '',
    '[mcp_servers.graft.env]',
    'DO_NOT_TRACK = "1"',
    '',
  ].join('\n');
  const { rest, found } = stripTomlSection(text);
  assert.equal(found, true);
  assert.ok(!rest.includes('mcp_servers.graft'), 'orphan gone');
  assert.ok(rest.includes('[mcp_servers.other]'), 'foreign preserved');
});

for (const quote of ['"', "'"]) {
  const delimiter = quote.repeat(3);
  test(`stripTomlSection preserves foreign multiline ${quote} strings`, () => {
    const foreign = [
      '[mcp_servers.other.env]',
      `SCRIPT = ${delimiter}`,
      '[mcp_servers.graft]',
      '', '', '',
      '[mcp_servers.graft.env]',
      'this is string content',
      delimiter,
      'KEEP = "2"',
      '',
    ].join('\n');
    const { rest, found } = stripTomlSection('[mcp_servers.graft]\ncommand = "graft"\n' + foreign);
    assert.equal(found, true);
    assert.equal(rest, foreign, 'the foreign string and following key survive byte-for-byte');
    assert.deepEqual(stripTomlSection(foreign), { rest: foreign, found: false },
      'table-looking string content is not an owned table');
  });

  test(`stripTomlSection removes owned multiline ${quote} strings completely`, () => {
    const foreign = '[mcp_servers.other]\ncommand = "other"\n';
    const text = [
      '[mcp_servers.graft]',
      `NOTE = ${delimiter}`,
      '[mcp_servers.other]',
      'still owned string content',
      delimiter,
      'command = "graft"',
      foreign,
    ].join('\n');
    assert.deepEqual(stripTomlSection(text), { rest: foreign, found: true });
  });

  for (const closingLength of [4, 5]) {
    test(`stripTomlSection recognizes a table after ${closingLength} closing ${quote} quotes`, () => {
      const foreign = `[mcp_servers.other.env]\nNOTE = ${delimiter}content${quote.repeat(closingLength)}\n`;
      assert.deepEqual(stripTomlSection(foreign + '[mcp_servers.graft]\ncommand = "graft"\n'),
        { rest: foreign, found: true });
    });
  }
}

test('stripTomlSection ignores delimiters in comments and single-line strings', () => {
  const foreign = [
    '[mcp_servers.other.env]',
    '# """ and \'\'\' are comments',
    'A = "\'\'\'" # """',
    'B = \'"""\'',
    'C = "escaped \\\" quotation"',
    '',
  ].join('\n');
  assert.deepEqual(stripTomlSection(foreign + '[mcp_servers.graft.env]\nX = "1"\n'),
    { rest: foreign, found: true });
});

test('stripTomlSection respects escaped multiline basic-string quotes', () => {
  const foreign = [
    '[mcp_servers.other.env]',
    'SCRIPT = """',
    'an escaped delimiter: \\"""',
    '[mcp_servers.graft.env]',
    'still string content',
    '"""',
    'KEEP = "2"',
    '',
  ].join('\n');
  assert.deepEqual(stripTomlSection(foreign + '[mcp_servers.graft]\ncommand = "graft"\n'),
    { rest: foreign, found: true });
});

test('Codex registration preserves foreign multiline strings across re-registration', () => {
  const repo = fresh(); const home = fresh();
  const foreign = '[mcp_servers.other.env]\nSCRIPT = \'\'\'\n[mcp_servers.graft.env]\ntext\n\'\'\'\nKEEP = "2"\n';
  mkdirSync(join(home, '.codex'), { recursive: true });
  const path = join(home, '.codex', 'config.toml');
  writeFileSync(path, '[mcp_servers.graft]\ncommand = "old"\n' + foreign);
  assert.deepEqual(registerMcpConfigs(repo, ['agents'], { home }).map((w) => w.action), ['updated']);
  const registered = readFileSync(path, 'utf8');
  assert.ok(registered.startsWith(foreign), 'foreign configuration survives the writer');
  assert.deepEqual(registerMcpConfigs(repo, ['agents'], { home }).map((w) => w.action), ['unchanged']);
  assert.equal(readFileSync(path, 'utf8'), registered);
});
