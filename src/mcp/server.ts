/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import { TOOLS, callTool } from './tools.js';
import { mcpInstructions } from './instructions.js';
import { hasGraftIndex } from '../graph/root.js';
import { mainWorktreeRoot } from '../graph/seed.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion } from '../upkeep.js';
import { maybeFlushInBackground, track } from '../telemetry/index.js';
import { brand, inBrand } from '../brand.js';
import { canonicalToolName } from './tool-names.js';

/**
 * MCP tool name → the command enum the telemetry contract knows. A tool absent
 * here is simply not counted: `track` would drop an unlisted command anyway, and
 * mapping by hand keeps the wire vocabulary identical across the CLI and MCP so
 * `ask` means the same thing in both.
 */
const TOOL_COMMAND: Record<string, string> = {
  graft_find_code: 'ask',
  graft_find_all: 'grep',
  graft_trace_calls: 'callers',
  graft_file_api: 'skeleton',
  graft_repo_map: 'map',
  graft_check_freshness: 'check',
};

function send(msg: object): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: unknown, result: object): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Which tools this server admits to having.
 *
 * `hosts/claude-global.ts` registers graft at the *user* MCP scope, which starts this
 * server in every project the user opens — including ones that never asked for graft.
 * Six tool schemas is real context, charged on every turn of every session, and in a
 * repo with no graph every one of them can only answer "run graft build". So a repo
 * that never invited graft is told there is nothing to call.
 *
 * The parent-checkout clause is not an optimization, it is the case the global
 * registration exists for: a fresh `git worktree add` has no `graft/` of its own
 * (it's gitignored, so git never checks it out) and gets one from its parent on the
 * first query — see graph/seed.ts. Gating on this tree alone would hide graft in
 * precisely the worktree the user is trying to work in, which is the bug, inverted.
 *
 * A `--dir` override is an explicit "the graph is over there", so it always
 * advertises without a probe.
 */
function advertised(root: string, dirOverride?: string): typeof TOOLS {
  if (dirOverride !== undefined) return TOOLS;
  if (hasGraftIndex(root)) return TOOLS;
  const main = mainWorktreeRoot(root);
  return main && hasGraftIndex(main) ? TOOLS : [];
}

/**
 * `version` is threaded in from the CLI rather than read here: `readCurrentVersion`
 * resolves package.json relative to the calling module, and from `dist/mcp/` that
 * lookup misses. The caller already knows it.
 */
export function startMcpServer(root: string, dirOverride?: string, version = '0'): void {
  // The self-maintenance pass, run once at boot. This is the ONLY channel that
  // reaches hosts with no hook support (Cursor, and any plain MCP client): it
  // refreshes rule files an older `graft init` wrote, and kicks off the cached
  // registry check. Both are fail-soft, and the resulting lines ride along in
  // `instructions` below — stdout is protocol-only, so there is nowhere else to
  // put them. Never blocks: the registry fetch happens in a detached child.
  const upkeep = runUpkeep(root, runningVersion()).lines;
  for (const line of upkeep) console.error(line);
  // Same deal for the telemetry queue: flushed from a detached child at boot, so
  // a Cursor user who never touches the CLI still gets their events out.
  //
  // Deliberately NOT the first-run notice. This server's stderr goes to an editor
  // log nobody reads, so printing it here would mark the disclosure as shown
  // without anyone having seen it. It stays pending for the next CLI command,
  // and `graft init`'s picker is the channel that reached this user already.
  maybeFlushInBackground();

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, any> };
    try {
      msg = JSON.parse(text);
    } catch {
      replyError(null, -32700, 'parse error');
      return;
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined;
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: brand(), version },
          // The one channel that survives tool deferral — see ./instructions.ts.
          instructions: upkeep.length ? `${upkeep.join('\n')}\n\n${mcpInstructions()}` : mcpInstructions(),
        });
        return;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // notifications get no response
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list': {
        if (isNotification) return;
        // Under trail, the same tools as `trail_*`, described in trail's words.
        reply(id, { tools: advertised(root, dirOverride).map((t) => ({ name: inBrand(t.name), description: inBrand(t.description), inputSchema: t.inputSchema })) });
        return;
      }
      case 'tools/call': {
        if (isNotification) return;
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        // Async because a tool call may rebuild the graph first (see
        // graph/refresh.ts). `callTool` absorbs its own errors, so the only thing
        // that can reject here is a bug — surface it as a JSON-RPC error rather
        // than an unhandled rejection that kills the server.
        callTool(root, name, args, dirOverride).then(
          (r) => {
            // No `hit`: `isError` means the tool failed, which is not the same
            // question as "did the graph have an answer". Absent beats wrong.
            // hasOwn for the same reason as track()'s: a client is free to send
            // `{"name":"constructor"}`, and a plain lookup would hand `track` a
            // function rather than undefined.
            const canonical = canonicalToolName(name);
            const command = Object.hasOwn(TOOL_COMMAND, canonical) ? TOOL_COMMAND[canonical] : undefined;
            track('query', { command, surface: 'mcp' }, { repo: root, host: 'mcp' });
            reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
          },
          (err) => replyError(id, -32603, err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      default:
        if (!isNotification) replyError(id, -32601, `method not found: ${method}`);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
