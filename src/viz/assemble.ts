/**
 * Assembles the viz-facing JSON for the context graph: reads every `.md` node
 * file in a context dir (frontmatter = node + edges) and produces a single
 * `{meta, nodes, edges}` document the viewer can render directly.
 *
 * Design rules (see docs/superpowers/specs/2026-07-15-graft-viz-design.md):
 *  - relations are normalized into the closed verb vocabulary — vague LLM
 *    softeners map to the concrete verb they usually mean
 *  - edges whose target slug doesn't exist are dropped (LLM output can dangle)
 *  - a node file with unparseable frontmatter is skipped, never fatal
 *  - both drop counts are reported in `meta` so the UI can say so
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { matter, type FrontMatterFile } from "../util/front-matter.js";
import type { NodeLink, SourceRef } from "../context/node-file.js";

export interface VizNode {
  id: string;
  name: string;
  type: string;
  summary: string;
  sources: string[];
  /** Code to show under the node, in place of `sources`. Set by
   * `blast --export-viz`, where every node stands for real changed lines. */
  evidence?: Evidence[];
  /** Who has worked on this area, best first. Set by `blast --export-viz`. */
  owners?: NodeOwner[];
}

/**
 * One contributor on a node, as the exported page carries them.
 *
 * `last` is an ISO day rather than "9d ago" so the page stays truthful when it is
 * opened a fortnight after it was published — the viewer does the arithmetic at
 * read time. `handle` is absent whenever git carried no GitHub address for them,
 * and the viewer must then render the name unlinked.
 */
export interface NodeOwner {
  name: string;
  handle?: string;
  commits: number;
  /** `YYYY-MM-DD` of their most recent commit in this area. */
  last: string;
}

export interface VizEdge {
  source: string;
  target: string;
  relation: string;
  description?: string;
}

/**
 * One line of code shown under a node, with the sign git gave it (` ` for an
 * unchanged line quoted as context — the affected side has no diff to show).
 */
export interface EvidenceLine {
  /** Post-image line number; a deleted line has none. */
  n: number | null;
  sign: "+" | "-" | " ";
  text: string;
}

/**
 * A snippet a panel shows instead of a bare path.
 *
 * A reviewer reading "src/blast/blast-cli.ts · L172-L193" has to go and open the
 * file to learn anything; the same block with four lines of the actual change in
 * it answers the question where they are standing.
 */
export interface Evidence {
  /** `symbol · path:12-34` — grep-able, because a span alone is not. */
  label: string;
  /** Why these lines are here, e.g. `calls blastVizGraph` or `added`. */
  note?: string;
  lines: EvidenceLine[];
  /** Lines the cap dropped, so a folded hunk says so rather than lying. */
  more?: number;
}

export interface VizGraph {
  meta: {
    nodeCount: number;
    edgeCount: number;
    skippedFiles: number;
    droppedEdges: number;
    /** Why there is nothing to draw, when there is nothing to draw. A published
     * page cannot answer a question a reader asks of the console, so an empty
     * canvas has to say what it means — see `blastVizGraph`. */
    emptyNote?: string;
  };
  nodes: VizNode[];
  edges: VizEdge[];
}

/**
 * Legacy vague verbs → the concrete verb they usually mean. Keeps old
 * `.context/` folders readable without regeneration; the synthesizer itself
 * is constrained to the closed vocabulary going forward.
 */
export const NORMALIZE_RELATION: Record<string, string> = {
  influences: "configures",
  supports: "validates",
  defines: "validates",
  measures: "validates",
};

export function normalizeRelation(rel: string): string {
  return NORMALIZE_RELATION[rel] ?? rel;
}

const GEN_START = "<!-- context:generated:start -->";
const GEN_END = "<!-- context:generated:end -->";
const SUMMARY_MAX = 500;

/** Pull the prose summary out of a node body's generated block. */
function extractSummary(body: string): string {
  let text = body;
  const start = text.indexOf(GEN_START);
  const end = text.indexOf(GEN_END);
  if (start >= 0 && end > start) text = text.slice(start + GEN_START.length, end);
  // Keep only the Summary section if headings are present.
  const related = text.indexOf("## Related");
  if (related >= 0) text = text.slice(0, related);
  text = text.replace(/^##\s+Summary\s*$/m, "");
  text = text.trim();
  return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX).trimEnd() + "…" : text;
}

/** Read a context dir and assemble the render-ready graph document. */
export function assembleContextGraph(contextDir: string): VizGraph {
  const nodes: VizNode[] = [];
  const rawEdges: VizEdge[] = [];
  let skippedFiles = 0;

  if (existsSync(contextDir)) {
    for (const entry of readdirSync(contextDir).sort()) {
      if (!entry.endsWith(".md")) continue;
      let parsed: FrontMatterFile;
      try {
        parsed = matter(readFileSync(join(contextDir, entry), "utf8"));
      } catch {
        skippedFiles++;
        continue;
      }
      const fm = parsed.data as Record<string, unknown>;
      const id = String(fm.slug ?? entry.replace(/\.md$/, ""));
      const sources = Array.isArray(fm.sources) ? (fm.sources as SourceRef[]) : [];
      const links = Array.isArray(fm.links) ? (fm.links as NodeLink[]) : [];
      nodes.push({
        id,
        name: String(fm.name ?? id),
        type: String(fm.type ?? "concept"),
        summary: extractSummary(parsed.content),
        sources: sources.map((s) => s.path),
      });
      for (const link of links) {
        if (!link || typeof link.to !== "string") continue;
        rawEdges.push({
          source: id,
          target: link.to,
          relation: normalizeRelation(String(link.relation ?? "uses")),
          ...(link.description ? { description: link.description } : {}),
        });
      }
    }
  }

  const known = new Set(nodes.map((n) => n.id));
  const edges = rawEdges.filter((e) => known.has(e.source) && known.has(e.target));

  return {
    meta: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      skippedFiles,
      droppedEdges: rawEdges.length - edges.length,
    },
    nodes,
    edges,
  };
}
