/**
 * The MCP tools, as pure functions over the existing engine.
 * `callTool` never throws — hosts get soft errors as isError content.
 */
import { Graft } from '../engine.js';
import { formatAsk, skeleton, formatSkeleton } from '../ask/ask.js';
import { formatCheckReport } from '../context/check.js';
import { formatGraphCheckReport } from '../graph/check.js';
import { loadGraphCached } from '../graph/load.js';
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from '../graph/refresh.js';
import { contextDirFor } from '../context/node-file.js';
import { resolveSymbol, edgeWalk, type Direction, type EdgeHit } from '../graph/traverse.js';
import { callersSavings, headerOf, hitLine, looseNoteFor } from '../graph/traverse-cli.js';
import { withSavings, setInputRate } from '../context/savings.js';
import { sessionInputRate } from '../claude/session-metrics.js';
import { grepGraph } from '../search/grep.js';
import { formatGrepResult, zeroHitNote } from '../search/grep-cli.js';
import { buildRepoMap, formatRepoMap } from '../graph/map.js';
import {
  federateAsk,
  federateCallers,
  federateCheck,
  federateGrep,
  federateMap,
  readWorkspace,
} from '../graph/workspace.js';
import type { NodeV1 } from '../graph/types.js';
import { canonicalToolName } from './tool-names.js';
import { resolveToolRoot, rootNote } from './root.js';
import { cmd } from '../brand.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

const ROOT_ARGUMENT = {
  type: 'string',
  description: 'checkout path in the server’s Git repository (absolute or relative to the server root); defaults to the server root; cannot switch checkout with --dir',
};

const noGraph = (): string => `no graph found — run \`${cmd('graft build')}\` first`;

function unknownSymbolText(query: string): string {
  return `no symbol "${query}" in the graph — check spelling or run \`${cmd('graft build')}\``;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'graft_find_code',
    description:
      'Query the repo context graph in plain words. Returns ranked nodes with exact file:line spans and the relevant source inlined — usually the full answer, no file reads needed.',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_ARGUMENT,
        query: { type: 'string', description: 'what you want to understand, in plain words' },
        limit: { type: 'number', description: 'max results (default 5)' },
        full: {
          type: 'boolean',
          description: 'inline whole definition spans instead of the default ≤8-line crux excerpts',
        },
        in: {
          type: 'string',
          description: 'narrow to nodes under this path prefix, filtered before scoring (segment-aware, like scopeOf)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'graft_file_api',
    description:
      "Signatures-only view of one file — every definition's signature + line span, ~10× cheaper than reading the file ($0, no LLM).",
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_ARGUMENT,
        file: { type: 'string', description: 'repo-relative path (or unique basename) of the file' },
      },
      required: ['file'],
    },
  },
  {
    name: 'graft_check_freshness',
    description: 'Report whether the committed graph is in sync with the code (drift check).',
    inputSchema: { type: 'object', properties: { root: ROOT_ARGUMENT } },
  },
  {
    name: 'graft_trace_calls',
    description:
      'Structural edges for a symbol, over call/reference/import/implements/extends ($0, no LLM). Defaults to direct callers (who depends on it). Set direction:"out" for callees (what it calls); set depth>1 (or depth:"all" for the full closure) to walk transitively for the full blast radius — every source that breaks if it changes. Run before a multi-file refactor to find ALL affected files.',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_ARGUMENT,
        symbol: { type: 'string', description: 'bare name, qualified (Class.method), or package-qualified (pkg.Fn); a file path also works' },
        direction: {
          type: 'string',
          enum: ['in', 'out'],
          description: '"in" (default) = callers/dependents; "out" = callees/dependencies',
        },
        depth: { description: 'transitive walk depth for blast radius (default 1 = direct edges only); pass "all" for the full connected closure — every source that would be affected' },
        in: { type: 'string', description: 'narrow matches to nodes at or under this repo-relative path prefix, e.g. server/src' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'graft_find_all',
    description:
      'Regex search over the graph\'s indexed files, hits grouped by innermost enclosing symbol and ranked by incoming-edge count (coupling) — which hit matters, not just where it is.',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_ARGUMENT,
        pattern: { type: 'string', description: 'regex pattern (or literal string with fixed: true)' },
        in: { type: 'string', description: 'narrow to files at or under this repo-relative path prefix, e.g. server/src' },
        ignore_case: { type: 'boolean', description: 'case-insensitive match' },
        fixed: { type: 'boolean', description: 'treat pattern as a literal string, not a regex' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'graft_repo_map',
    description:
      'Token-budgeted repo orientation — directory clusters, per-directory hubs, and global hotspots computed purely from the wiring graph ($0, no LLM). Use this to get oriented in an unfamiliar repo before diving into files.',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_ARGUMENT,
        max_dirs: { type: 'number', description: 'max directory entries shown, rest counted into dropped (default 16)' },
      },
    },
  },
];

/** Render every resolved match's header + edge report (or the loud zero-edge
 * note), one block per match, joined with a blank line — the same grouping
 * `graft callers` uses for multi-match symbols. `showDepth` tags each hit with
 * its BFS depth (for transitive `depth>1` walks). */
function renderMatches(
  direction: Direction,
  showDepth: boolean,
  matches: NodeV1[],
  hitsFor: (n: NodeV1) => EdgeHit[],
): string {
  return matches
    .map((m) => {
      const hits = hitsFor(m);
      const lines = [headerOf(m)];
      if (hits.length === 0) lines.push(looseNoteFor(direction, m.name, matches.length));
      else for (const h of hits) lines.push(hitLine(direction, h, showDepth));
      return lines.join('\n');
    })
    .join('\n\n');
}

/** When the MCP server is rooted at a workspace parent, the ask/callers/grep/
 * map/check tools federate across the children — identical to the CLI. Returns
 * null for tools that don't federate (skeleton is per-file), so the caller
 * falls through to the normal single-graph path. */
async function callWorkspaceTool(
  root: string,
  dirOverride: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean } | null> {
  switch (name) {
    case 'graft_find_code': {
      const query = String(args.query ?? '');
      if (!query) return { text: 'graft_find_code requires a query', isError: true };
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const inArg = typeof args.in === 'string' && args.in ? args.in : undefined;
      const r = federateAsk(root, dirOverride, query, { limit, source: true, full: args.full === true, in: inArg });
      return { text: formatAsk(r), isError: false };
    }
    case 'graft_trace_calls': {
      const symbol = String(args.symbol ?? args.file ?? '');
      if (!symbol) return { text: 'graft_trace_calls requires a symbol', isError: true };
      const { text, found } = federateCallers(root, dirOverride, symbol, {
        direction: args.direction === 'out' ? 'out' : 'in',
        depth: typeof args.depth === 'number' && Number.isFinite(args.depth) ? args.depth : undefined,
        in: typeof args.in === 'string' && args.in ? args.in : undefined,
      });
      return { text, isError: !found };
    }
    case 'graft_find_all': {
      const pattern = String(args.pattern ?? '');
      if (!pattern) return { text: 'graft_find_all requires a pattern', isError: true };
      const { result, coverage } = federateGrep(root, dirOverride, pattern, {
        ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
        fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
      });
      const text = result.totalHits === 0 ? zeroHitNote(result) : formatGrepResult(result);
      return { text: coverage ? `${text}\n${coverage}` : text, isError: false };
    }
    case 'graft_repo_map': {
      const maxDirs = typeof args.max_dirs === 'number' && Number.isFinite(args.max_dirs) && args.max_dirs > 0 ? args.max_dirs : undefined;
      return { text: federateMap(root, dirOverride, { maxDirs }), isError: false };
    }
    case 'graft_check_freshness': {
      const { text } = await federateCheck(root, dirOverride);
      return { text, isError: false };
    }
    default:
      return null;
  }
}

/** Tools whose whole job is to REPORT drift. Rebuilding first would make
 * `graft_check_freshness` answer about a graph it just fixed, i.e. always "OK". */
const NO_REFRESH_TOOLS = new Set(['graft_check_freshness']);

/**
 * The pre-0.8.1 tool names, still accepted, live in the dependency-free
 * `tool-names.ts` (shared with the engine-free session hooks). The names were the
 * reason for renaming: when a host defers graft's schemas it shows the model the
 * *names alone* — no descriptions — so `graft_ask` had to compete with `Grep` on
 * 9 characters. The new names say what they do; the aliases keep old callers
 * (skills, saved prompts, notes) from 404-ing. Re-exported here so existing
 * importers of `canonicalToolName` from this module keep working.
 */
export { canonicalToolName };

export async function callTool(
  root: string,
  requestedName: string,
  args: Record<string, unknown>,
  dirOverride?: string,
): Promise<{ text: string; isError: boolean }> {
  let answeredRoot: string | undefined;
  try {
    root = resolveToolRoot(root, args.root, dirOverride);
    answeredRoot = root;
    const name = canonicalToolName(requestedName);
    const ws = readWorkspace(root, dirOverride);
    // Freshness first: an answer that cites file:line has to be about the code as
    // it is right now, including edits nobody has committed (or even saved through
    // this agent). ~3ms when nothing moved; a structural, $0 rebuild when it did.
    // Same reason as the CLI's `noteQuery`: price this session's tokens once,
    // here, so the formatters downstream can put a dollar figure in the nudge.
    let note: string | null = null;
    if (!NO_REFRESH_TOOLS.has(name)) {
      const r = ws
        ? await ensureFreshChildren(root, ws.children, { contextDir: dirOverride })
        : await ensureFreshGraph(root, { contextDir: dirOverride });
      note = refreshNote(r);
    }
    // Pricing is process-global. Set it after the refresh await, directly
    // before synchronous query formatting, so concurrent roots do not cross-talk.
    setInputRate(sessionInputRate(root));
    const fed = ws ? await callWorkspaceTool(root, dirOverride, name, args) : null;
    const res = fed ?? (await callSingleTool(root, name, args, dirOverride));
    const text = note ? `${note}\n${res.text}` : res.text;
    return { ...res, text: `${text}\n${rootNote(root)}` };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { text: answeredRoot ? `${text}\n${rootNote(answeredRoot)}` : text, isError: true };
  }
}

/** The single-graph path: every tool, answered from one repo's graph. */
async function callSingleTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
  dirOverride?: string,
): Promise<{ text: string; isError: boolean }> {
  switch (name) {
      case 'graft_find_code': {
        const query = String(args.query ?? '');
        if (!query) return { text: 'graft_find_code requires a query', isError: true };
        const limit = typeof args.limit === 'number' ? args.limit : 5;
        const engine = new Graft({ contextDir: dirOverride });
        const inArg = typeof args.in === 'string' && args.in ? args.in : undefined;
        const r = engine.ask(root, query, { limit, source: true, full: args.full === true, in: inArg });
        return { text: formatAsk(r), isError: false };
      }
      case 'graft_file_api': {
        const file = String(args.file ?? '');
        if (!file) return { text: 'graft_file_api requires a file', isError: true };
        const r = skeleton(root, file, { contextDir: dirOverride });
        return { text: formatSkeleton(r), isError: !r.entries.length && !!r.note };
      }
      case 'graft_check_freshness': {
        const engine = new Graft({ contextDir: dirOverride });
        const r = engine.check(root);
        const g = await engine.checkGraph(root);
        const parts = [formatCheckReport(r)];
        if (!g.missing) parts.push(formatGraphCheckReport(g));
        return { text: parts.join('\n\n'), isError: false };
      }
      case 'graft_trace_calls': {
        // One tool covers callers (direction:in, the default), callees
        // (direction:out), and blast radius (depth>1). edgeWalk handles the
        // file-seed aggregation that the old graft_blast_radius did: for a
        // file at depth>1 it walks the file node AND every symbol defined in
        // it, so dependents that call into a symbol (targeting the SYMBOL id,
        // never the FILE id) aren't silently dropped.
        const symbol = String(args.symbol ?? args.file ?? '');
        if (!symbol) return { text: 'graft_trace_calls requires a symbol', isError: true };
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: noGraph(), isError: true };
        const inOpt = typeof args.in === 'string' && args.in ? { in: args.in } : {};
        const matches = resolveSymbol(w, symbol, inOpt);
        if (matches.length === 0) return { text: unknownSymbolText(symbol), isError: true };
        const direction: Direction = args.direction === 'out' ? 'out' : 'in';
        // `depth: "all"` (or a huge number) walks the full transitive closure —
        // every connected source — terminating when no new node is reached.
        const depth =
          args.depth === 'all' || args.depth === 'full'
            ? Number.POSITIVE_INFINITY
            : typeof args.depth === 'number' && Number.isFinite(args.depth) && args.depth >= 1
              ? Math.floor(args.depth)
              : 1;
        const results = matches.map((m) => ({ symbol: m, hits: edgeWalk(w, m, direction, depth) }));
        const byId = new Map(results.map((r) => [r.symbol.id, r.hits]));
        const body = renderMatches(direction, depth > 1, matches, (m) => byId.get(m.id) ?? []);
        const text = withSavings(body, callersSavings(w, results));
        return { text, isError: false };
      }
      case 'graft_find_all': {
        const pattern = String(args.pattern ?? '');
        if (!pattern) return { text: 'graft_find_all requires a pattern', isError: true };
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: noGraph(), isError: true };
        const result = grepGraph(w, root, pattern, {
          ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
          fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
          in: typeof args.in === 'string' && args.in ? args.in : undefined,
        });
        if (result.totalHits === 0) return { text: zeroHitNote(result), isError: false };
        return { text: formatGrepResult(result), isError: false };
      }
      case 'graft_repo_map': {
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: noGraph(), isError: true };
        const maxDirs = typeof args.max_dirs === 'number' && Number.isFinite(args.max_dirs) && args.max_dirs > 0 ? args.max_dirs : undefined;
        const map = buildRepoMap(w, { maxDirs });
        return { text: formatRepoMap(map), isError: false };
      }
    default:
      return { text: `unknown tool: ${name}`, isError: true };
  }
}
