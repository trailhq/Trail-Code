import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { buildGraph } from '../src/graph/build.js';

/**
 * How long to wait for the server's replies. Generous on purpose: the loop below
 * leaves the moment the replies are in — or the moment the child quits — so this
 * is only ever paid by a server that is up and genuinely silent.
 */
const RPC_TIMEOUT_MS = 60_000;

/**
 * Drive the MCP server over stdio and return its replies.
 *
 * Throws rather than returning short. Returning the partial array meant every
 * caller dereferenced into `undefined` — `Cannot read properties of undefined
 * (reading 'result')` — which named neither the timeout nor the request, and
 * read the same whether the server had been slow, had crashed on startup, or had
 * answered something unparseable. The child's stderr is kept for the same
 * reason: it is the only place a crash says why, and it was being piped and then
 * dropped.
 *
 * A crashed server used to be worse than badly reported, it hung the run: with
 * the child already gone, `await once(child, 'exit')` waits for an event that
 * has fired and will not fire again. The `close` promise below is created while
 * the child is still alive, so it settles whenever the child ends, whether that
 * is a crash of its own or the kill at the end.
 */
async function rpc(messages: object[], dir: string, expected: number): Promise<any[]> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const responses: any[] = [];
  let buf = '';
  let stderr = '';
  // `close`, not `exit`: it fires once the child's stdio is drained, so a server
  // that answers and then quits is not read as having quit without answering.
  let died: string | null = null;
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (d) => (stderr += d.toString()));
  child.on('close', (code, signal) => (died ??= `exit code ${code}, signal ${signal}`));
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const started = Date.now();
  const deadline = started + RPC_TIMEOUT_MS;
  while (responses.length < expected && died === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const waited = ((Date.now() - started) / 1000).toFixed(1);
  const quitFirst = died;
  child.kill();
  await closed.catch(() => {});
  if (responses.length < expected) {
    throw new Error(
      `mcp server answered ${responses.length} of ${expected} in ${waited}s — ` +
        (quitFirst ? `it quit first (${quitFirst})` : 'it was still running') +
        (stderr.trim() ? `\n--- its stderr ---\n${stderr.trim()}` : '\nIt wrote nothing to stderr.'),
    );
  }
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
