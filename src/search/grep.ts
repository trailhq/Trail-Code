/**
 * `graft grep` core: regex search over the graph's indexed files, with hits
 * grouped by their innermost enclosing symbol and ranked by incoming-edge
 * count (coupling) — a grep that answers "which of these hits matters",
 * because plain `grep -rn` gives no way to tell a hit inside a
 * heavily-depended-on function from one inside dead code.
 *
 * Pure I/O + regex, no CLI/MCP concerns: `grep-cli.ts` formats this into
 * human text and wires the CLI command; `mcp/tools.ts` renders the same
 * shape for the `graft_find_all` tool.
 */
import { join } from "node:path";
import type { GraphV1, NodeV1 } from "../graph/types.js";
import { WALK_RELATIONS } from "../graph/relations.js";
import { assertPrefixIndexed, pathUnderPrefix } from "../graph/scopes.js";
import { normalizePathPrefix } from "../util/paths.js";
import { savingsFor, type Savings } from "../context/savings.js";
import { readSourceFile } from "../util/source.js";

export interface GrepHit {
  line: number;
  /** Trimmed line text, capped at 160 chars. */
  text: string;
}

export interface GrepSymbolRef {
  id: string;
  /** Qualified scope-joined name (e.g. `FastAPI.include_router`), not just
   * the bare symbol name — the id's segment after the file-path `#`. */
  name: string;
  kind: string;
  path: string;
  span: string;
}

export interface GrepGroup {
  /** null → file-level: the hit lies outside every indexed symbol's span
   * (module-level code — imports, top-level statements, module constants). */
  symbol: GrepSymbolRef | null;
  path: string;
  /** Incoming WALK_RELATIONS edges targeting the symbol — always 0 for
   * file-level groups (there's no single symbol id to count edges against). */
  inDegree: number;
  hits: GrepHit[];
}

export interface GrepResult {
  pattern: string;
  /** Indexed file nodes considered (after the `in` filter), whether or not
   * each was actually readable — matches the CLI's "searched N indexed
   * files" wording. */
  filesSearched: number;
  /** Hits actually collected (<= maxHits). */
  totalHits: number;
  /** Sorted: inDegree desc, then path asc. */
  groups: GrepGroup[];
  /** Dropped counts — never silent. `files`: indexed file nodes that
   * couldn't be read from disk. `hits`: matches found beyond `maxHits`,
   * counted but not collected. */
  truncated: { files: number; hits: number };
  /** Tokens-saved baseline: the files that had hits, read whole. Undefined
   * when there were no hits or the graph predates file sizing. */
  saved?: Savings;
  /** Files the last build refused to index for size. Copied from wiring meta
   * so a zero-hit note can name them instead of claiming all code was searched. */
  skipped?: Array<{ path: string; bytes: number; reason: "size" }>;
}

export interface GrepOptions {
  ignoreCase?: boolean;
  /** Treat `pattern` as a literal string (regex-escaped), not a regex. */
  fixed?: boolean;
  /** Narrow to file nodes at or under this repo-relative path prefix — the same
   * segment-aware rule `ask --in` and `callers --in` use. Either separator. */
  in?: string;
  /** Stop collecting hits after this many; the rest are tallied into
   * `truncated.hits`. Default 300. */
  maxHits?: number;
}

const DEFAULT_MAX_HITS = 300;
const MAX_HIT_TEXT = 160;
const SPAN_RE = /^L(\d+)-L(\d+)$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function spanBounds(span: string): { start: number; end: number } | null {
  const m = SPAN_RE.exec(span);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

interface SymbolSpan {
  node: NodeV1;
  start: number;
  end: number;
}

/** The file's symbol nodes, sorted ascending by span start — the order
 * `enclosingSymbol` scans in to find the innermost containing span. */
function symbolsOf(graph: GraphV1, path: string): SymbolSpan[] {
  const out: SymbolSpan[] = [];
  for (const n of graph.nodes) {
    if (n.kind === "file" || n.path !== path) continue;
    const b = spanBounds(n.span);
    if (b) out.push({ node: n, start: b.start, end: b.end });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Innermost symbol containing `line`: among spans that contain it, the one
 * with the greatest start line. Symbols are pre-sorted ascending by start,
 * so the last containing match seen wins, and the scan can stop as soon as
 * a span starts after `line` — nothing later in the sort can contain it. */
function enclosingSymbol(symbols: SymbolSpan[], line: number): NodeV1 | null {
  let found: NodeV1 | null = null;
  for (const s of symbols) {
    if (s.start > line) break;
    if (line <= s.end) found = s.node;
  }
  return found;
}

/** Incoming WALK_RELATIONS edge count per target id — one pass over
 * `graph.edges`, computed once per call and shared across every hit. */
function computeInDegree(graph: GraphV1): Map<string, number> {
  const deg = new Map<string, number>();
  for (const e of graph.edges) {
    if (!WALK_RELATIONS.has(e.relation)) continue;
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  return deg;
}

function toSymbolRef(n: NodeV1): GrepSymbolRef {
  const hash = n.id.indexOf("#");
  return { id: n.id, name: hash >= 0 ? n.id.slice(hash + 1) : n.name, kind: n.kind, path: n.path, span: n.span };
}

export function grepGraph(graph: GraphV1, repoRoot: string, pattern: string, opts: GrepOptions = {}): GrepResult {
  const maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
  const source = opts.fixed ? escapeRegExp(pattern) : pattern;
  const regex = new RegExp(source, opts.ignoreCase ? "i" : "");

  const inDegree = computeInDegree(graph);
  // Same segment-aware prefix rule as `ask --in` / `callers --in`, and the same
  // loud failure when it matches nothing — `--in` used to mean a bare substring
  // here and a path prefix there, so `--in src` also swept up `lib/mysrc/`.
  const inPrefix = opts.in ? normalizePathPrefix(opts.in) : undefined;
  if (inPrefix) assertPrefixIndexed(graph, inPrefix);
  const fileNodes = graph.nodes.filter(
    (n) => n.kind === "file" && (inPrefix === undefined || pathUnderPrefix(n.path, inPrefix)),
  );

  const groups = new Map<string, GrepGroup>();
  let collected = 0;
  let truncatedHits = 0;
  let truncatedFiles = 0;

  for (const file of fileNodes) {
    let text: string;
    try {
      const decoded = readSourceFile(join(repoRoot, file.path));
      if (decoded === null) {
        truncatedFiles++; // unsupported encoding (e.g. UTF-16BE) — same posture as unreadable
        continue;
      }
      text = decoded;
    } catch {
      truncatedFiles++;
      continue;
    }

    const symbols = symbolsOf(graph, file.path);
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!regex.test(raw)) continue;

      if (collected >= maxHits) {
        truncatedHits++;
        continue;
      }
      collected++;

      const lineNo = i + 1;
      const sym = enclosingSymbol(symbols, lineNo);
      const key = sym ? sym.id : `file:${file.path}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          symbol: sym ? toSymbolRef(sym) : null,
          path: file.path,
          inDegree: sym ? (inDegree.get(sym.id) ?? 0) : 0,
          hits: [],
        };
        groups.set(key, group);
      }
      const trimmed = raw.trim();
      group.hits.push({ line: lineNo, text: trimmed.length > MAX_HIT_TEXT ? trimmed.slice(0, MAX_HIT_TEXT) : trimmed });
    }
  }

  const sortedGroups = [...groups.values()].sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));

  return {
    pattern,
    filesSearched: fileNodes.length,
    totalHits: collected,
    groups: sortedGroups,
    truncated: { files: truncatedFiles, hits: truncatedHits },
    saved: savingsFor(graph, sortedGroups.map((g) => g.path)),
    skipped: graph.meta.skipped,
  };
}
