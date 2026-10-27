import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { buildGraph } from '../src/graph/build.js';

async function rpc(messages: object[], dir: string, expected: number): Promise<any[]> {
  // A fresh HOME: the server's boot upkeep reads the machine's own wiring and
  // update cache, and its lines ride in `instructions`, so the real HOME would
  // make the length test depend on whatever this machine has installed.
  const home = mkdtempSync(join(tmpdir(), 'graft-mcpsrv-home-'));
  const { TRAIL_HOME: _t, GRAFT_HOME: _g, ...env } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp', dir], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, HOME: home } });
  const responses: any[] = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const deadline = Date.now() + 15000;
  while (responses.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  await once(child, 'exit').catch(() => {});
  return responses;
}

test('initialize → tools/list → tools/call round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpsrv-'));
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'graft_trace_calls', arguments: { symbol: 'x.ts', depth: 2 } } },
    ],
    dir,
    3,
  );
  assert.equal(rs.length, 3);
  const init = rs.find((r) => r.id === 1);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.ok(init.result.capabilities.tools);
  assert.equal(init.result.serverInfo.name, 'graft');
  // This dir has no graph and no parent checkout, so the server advertises
  // nothing: graft is registered at the user MCP scope now (hosts/claude-global.ts),
  // which starts it in every project the user opens, and six tool schemas charged
  // to a repo that never asked for graft is context spent for answers it cannot
  // give. See `advertised` in src/mcp/server.ts.
  const list = rs.find((r) => r.id === 2);
  assert.deepEqual(list.result.tools, []);
  // Not advertised is not the same as not callable — a client that calls anyway
  // still gets the soft error that names the fix.
  const call = rs.find((r) => r.id === 3);
  assert.equal(call.result.isError, true); // unbuilt repo → soft error content
  assert.match(call.result.content[0].text, /graft build/);
});

test('MCP server exits cleanly when its stdio host disconnects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcp-epipe-'));
  const home = mkdtempSync(join(tmpdir(), 'graft-mcp-epipe-home-'));
  const { TRAIL_HOME: _t, GRAFT_HOME: _g, ...env } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp', dir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, HOME: home },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  await once(child, 'spawn');

  // Buffer a real MCP reply request, then close the host's read end before the
  // server can write the response. This goes through startMcpServer itself.
  child.stdout.destroy();
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP child did not exit: ${stderr}`)), 15_000);
  });
  try {
    const [code, signal] = await Promise.race([once(child, 'exit'), timeout]) as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0, stderr);
    assert.equal(signal, null, stderr);
    assert.doesNotMatch(stderr, /EPIPE/);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

const ALL_TOOLS = [
  'graft_find_code',
  'graft_file_api',
  'graft_check_freshness',
  'graft_trace_calls',
  'graft_find_all',
  'graft_repo_map',
];

async function listTools(dir: string): Promise<string[]> {
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ],
    dir,
    2,
  );
  return rs.find((r) => r.id === 2).result.tools.map((t: any) => t.name);
}

test('a built repo advertises every tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpbuilt-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  await buildGraph(dir);

  assert.deepEqual(await listTools(dir), ALL_TOOLS);
});

test('a fresh worktree advertises every tool, on the strength of its parent', async () => {
  // The case the user-level registration exists for. `graft/` is gitignored, so
  // `git worktree add` never checks it out and this tree has no graph of its own —
  // it gets one from the parent on the first query (graph/seed.ts). Gating on this
  // tree alone would hide graft in exactly the worktree the user came to work in.
  const main = mkdtempSync(join(tmpdir(), 'graft-mcpwtmain-'));
  // Identity in the env, not the config: a CI runner has none, and blanking
  // GIT_CONFIG_GLOBAL removes any it had, so `git commit` would fail.
  const git = (...args: string[]): void =>
    execFileSync('git', args, {
      cwd: main,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'graft test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'graft test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
    });
  git('init', '-b', 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  writeFileSync(join(main, 'src', 'math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  writeFileSync(join(main, '.gitignore'), 'graft/\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  await buildGraph(main);

  const wt = join(mkdtempSync(join(tmpdir(), 'graft-mcpwt-')), 'feature');
  git('worktree', 'add', '--detach', wt, 'HEAD');
  assert.equal(existsSync(join(wt, 'graft')), false, 'the gitignored cache does not travel');

  assert.deepEqual(await listTools(wt), ALL_TOOLS);
});

test('initialize carries instructions — the layer that survives tool deferral', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpsrv-instr-'));
  const rs = await rpc(
    [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }],
    dir,
    1,
  );
  const { instructions, serverInfo } = rs[0].result;
  assert.equal(typeof instructions, 'string');
  // A host that defers graft's schemas shows the model six bare names and nothing
  // else, so this string has to carry both the pitch and the recovery instruction.
  assert.match(instructions, /ONE lookup/, 'tells the agent to batch the schema fetch');
  assert.match(instructions, /select:mcp__graft__graft_find_code,/, 'gives a copy-pasteable query');
  for (const t of ['graft_find_code', 'graft_find_all', 'graft_trace_calls', 'graft_file_api', 'graft_repo_map']) {
    assert.ok(instructions.includes(t), `names ${t}`);
  }
  // Observed sibling servers sit at 660–984 chars; nothing proves a longer one
  // survives un-truncated, so hold the line here rather than discover it later.
  assert.ok(instructions.length < 1000, `instructions must stay under 1000 chars, got ${instructions.length}`);
  assert.match(serverInfo.version, /^\d+\.\d+\.\d+$/, 'real version, not the old hardcoded 0');
});

test('unknown method returns -32601', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpsrv2-'));
  const rs = await rpc([{ jsonrpc: '2.0', id: 9, method: 'resources/list' }], dir, 1);
  assert.equal(rs[0].error.code, -32601);
});
