/**
 * Opt-in LSP enrichment (`graft build --lsp`): add compiler-grade call edges the
 * AST resolver couldn't — chiefly member calls (`obj.foo()`) whose receiver type
 * graft can't infer, and every call in the generic breadth tier (which has no
 * receiver typing at all). For each function/method node we ask the language
 * server for its outgoing calls (call hierarchy) and map each callee's definition
 * back to a graft node, adding a `calls` edge stamped `lsp_resolved`. Precision is
 * the server's (compiler-grade), so this closes the edge-recall gap WITHOUT the
 * name-guessing that halved precision (see resolve.ts). Best-effort: no server /
 * a timeout / an error → the graph is returned unchanged.
 */
import { join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relPosix } from "../../util/paths.js";
import { languageLabelOf } from "../extract.js";
import { genericLangOf } from "../generic.js";
import type { GraphV1, NodeV1, EdgeV1 } from "../types.js";
import { LspClient } from "./client.js";
import { pickServers } from "./registry.js";

const CALLABLE = new Set<NodeV1["kind"]>(["function", "method"]);
const DEFN = new Set<NodeV1["kind"]>(["function", "method", "class", "struct", "interface", "type", "enum"]);

const langOf = (path: string): string | null => genericLangOf(path)?.name ?? languageLabelOf(path);

interface Span { node: NodeV1; from: number; to: number }
const parseSpan = (s: string): [number, number] | null => {
  const m = /^L(\d+)-L(\d+)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

export interface LspEnrichResult { added: number; queried: number; servers: string[] }

export async function enrichWithLsp(
  graph: GraphV1,
  root: string,
  opts: { onProgress?: (done: number, total: number) => void; maxNodes?: number } = {},
): Promise<LspEnrichResult> {
  const languagesPresent = new Set<string>();
  for (const n of graph.nodes) { const l = langOf(n.path); if (l) languagesPresent.add(l); }
  const servers = pickServers(languagesPresent);
  if (!servers.length) return { added: 0, queried: 0, servers: [] };

  // Canonicalize the root: servers (rust-analyzer/clangd) report callee URIs
  // against the REAL path, so under a symlinked checkout (macOS /tmp →
  // /private/tmp, common in CI) an un-resolved root would fail the in-repo test
  // for every callee and silently zero out enrichment.
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  root = realRoot;

  // Index nodes by file for both source selection and callee→node mapping.
  const spansByFile = new Map<string, Span[]>();
  for (const n of graph.nodes) {
    if (n.kind === "file" || !DEFN.has(n.kind)) continue;
    const sp = parseSpan(n.span); if (!sp) continue;
    const list = spansByFile.get(n.path) ?? [];
    list.push({ node: n, from: sp[0], to: sp[1] });
    spansByFile.set(n.path, list);
  }
  // The definition node covering a 1-indexed line in a file: innermost (smallest span).
  const nodeAt = (rel: string, line: number): NodeV1 | null => {
    const cands = (spansByFile.get(rel) ?? []).filter((s) => s.from <= line && line <= s.to);
    if (!cands.length) return null;
    return cands.sort((a, b) => (a.to - a.from) - (b.to - b.from))[0].node;
  };

  // Apply the node budget once across the repo, not once per server.
  const covered = new Set(servers.flatMap((s) => s.languages));
  let sources = graph.nodes.filter((n) => CALLABLE.has(n.kind) && covered.has(langOf(n.path) ?? ""));
  if (opts.maxNodes && sources.length > opts.maxNodes) sources = sources.slice(0, opts.maxNodes);

  const existing = new Set(graph.edges.map((e) => `${e.source}\0${e.relation}\0${e.target}`));
  const fileLines = new Map<string, string[]>();
  const linesOf = (rel: string): string[] => {
    if (!fileLines.has(rel)) {
      try { fileLines.set(rel, readFileSync(join(root, rel), "utf8").split("\n")); }
      catch { fileLines.set(rel, []); }
    }
    return fileLines.get(rel)!;
  };

  // The name-token position of a definition (0-indexed), scanning its first few
  // lines for the name — call hierarchy needs a position ON the symbol.
  const namePos = (src: NodeV1): { line: number; character: number } | null => {
    const sp = parseSpan(src.span); if (!sp) return null;
    const lines = linesOf(src.path);
    for (let ln = sp[0] - 1; ln < Math.min(sp[0] + 2, lines.length); ln++) {
      const c = (lines[ln] ?? "").indexOf(src.name);
      if (c >= 0) return { line: ln, character: c };
    }
    return null;
  };

  let added = 0, queried = 0;
  const attempted: string[] = [];
  for (const server of servers) {
    const serverLangs = new Set(server.languages);
    const serverSources = sources.filter((n) => serverLangs.has(langOf(n.path) ?? ""));
    if (!serverSources.length) continue;
    attempted.push(server.command);
    const client = new LspClient(server.command, server.args, root, server.languageId);
    try {
      if (!(await client.initialize())) continue;

      // Warm up only on a document this server handles. A failed server must
      // not prevent the other languages from being enriched.
      const warm = serverSources.find((s) => namePos(s));
      if (warm && !(await client.waitUntilReady(join(root, warm.path), namePos(warm)!))) continue;

      for (const src of serverSources) {
        const abs = join(root, src.path);
        client.didOpen(abs);
        const pos = namePos(src);
        if (!pos) continue;

        const items = await client.prepareCallHierarchy(abs, pos);
        if (!items.length) continue;
        queried++;
        opts.onProgress?.(queried, sources.length);
        const callees = await client.outgoingCalls(items[0]);
        for (const callee of callees) {
          let calleeAbs: string;
          try { calleeAbs = fileURLToPath(callee.uri); } catch { continue; }
          const rel = relPosix(root, calleeAbs);
          // Separator-safe containment: /a/foo must not match /a/foo-bar.
          if (rel.startsWith("..") || rel.startsWith("/")) continue;
          const target = nodeAt(rel, (callee.selectionRange?.start.line ?? callee.range.start.line) + 1);
          if (!target || target.id === src.id) continue;
          const key = `${src.id}\0calls\0${target.id}`;
          if (existing.has(key)) continue;
          existing.add(key);
          graph.edges.push({ source: src.id, target: target.id, relation: "calls", confidence: "lsp_resolved" } as EdgeV1);
          added++;
        }
      }
    } finally {
      await client.dispose();
    }
  }
  return { added, queried, servers: attempted };
}
