/**
 * Structural invariants for a built {@link GraphV1} — the Tier-0 quality gate that
 * needs no external oracle. Every one of these must hold for ANY graph the builder
 * emits, in either extraction tier, in any language, or the graph is malformed:
 *
 *   - node ids are unique; names are non-empty; kinds are in the allowed set
 *   - spans are `Lx-Ly` with x <= y
 *   - edge relations and confidences are in the allowed sets
 *   - every edge source is a real node
 *   - every edge target is a real node, EXCEPT the relations that deliberately keep
 *     an unresolved external string (an import specifier, a bare heritage name for
 *     an out-of-repo supertype, a Java annotation type with no in-repo
 *     `@interface`, or a PHP 8 attribute class that exists only via `use` /
 *     vendor) — those are a feature of "drop rather than guess",
 *     not a dangling edge.
 *
 * Self-loop `calls` are NOT a violation: direct recursion is a real edge a function
 * has on itself. They are returned separately so a caller (or a recursion-free test
 * fixture) can assert on them explicitly.
 *
 * Pure and dependency-free so it can run in a test, in `graft check`, or over a
 * `wiring.json` read straight off disk. `scripts/graph-quality.mjs` keeps its own
 * standalone copy on purpose, so the CLI report still works when `dist/` is stale.
 */
import type { GraphV1 } from "./types.js";

const KINDS = new Set<string>([
  "file", "class", "function", "method", "interface",
  "type", "enum", "struct", "module", "constant", "variable",
]);
const RELATIONS = new Set<string>([
  "contains", "calls", "imports", "references", "implements", "extends",
]);
const CONFIDENCE = new Set<string>([
  "lsp_resolved", "lsp_dispatch", "extracted", "inferred",
]);
// Relations whose target may be a deliberately-unresolved external string rather
// than an in-repo node id: an import's module specifier, a heritage clause naming
// a supertype defined outside the repo (or a generic type parameter), a Java
// annotation whose type is not declared in-repo, or a PHP 8 attribute whose
// class is only imported from vendor (#144). The set is language-agnostic.
const TARGET_MAY_BE_EXTERNAL = new Set<string>(["imports", "extends", "implements", "references"]);

export interface InvariantResult {
  /** One human-readable line per violation; empty when the graph is well-formed. */
  problems: string[];
  /** Direct-recursion `calls` edges (source === target). Informational, not a violation. */
  selfLoopCalls: number;
}

/** Check a graph's structural invariants. `problems` is empty for a valid graph. */
export function checkGraphInvariants(graph: GraphV1): InvariantResult {
  const problems: string[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  const seen = new Set<string>();

  for (const n of graph.nodes) {
    if (seen.has(n.id)) problems.push(`duplicate node id: ${n.id}`);
    seen.add(n.id);
    if (!n.name || !String(n.name).trim()) problems.push(`empty name: ${n.id}`);
    if (!KINDS.has(n.kind)) problems.push(`bad kind '${n.kind}': ${n.id}`);
    const m = /^L(\d+)-L(\d+)$/.exec(n.span ?? "");
    if (!m) problems.push(`bad span '${n.span}': ${n.id}`);
    else if (Number(m[1]) > Number(m[2])) problems.push(`inverted span ${n.span}: ${n.id}`);
  }

  let selfLoopCalls = 0;
  for (const e of graph.edges) {
    if (!RELATIONS.has(e.relation)) problems.push(`bad relation '${e.relation}': ${e.source}`);
    if (!CONFIDENCE.has(e.confidence)) problems.push(`bad confidence '${e.confidence}': ${e.source} → ${e.target}`);
    if (!ids.has(e.source)) problems.push(`dangling source: ${e.source}`);
    if (!ids.has(e.target) && !TARGET_MAY_BE_EXTERNAL.has(e.relation))
      problems.push(`dangling ${e.relation} target: ${e.source} → ${e.target}`);
    if (e.relation === "calls" && e.source === e.target) selfLoopCalls++;
  }

  return { problems, selfLoopCalls };
}
