/**
 * Tier-2 "wiring cards" — the passive-channel surface of the wiring graph.
 *
 * The wiring graph itself lives as machine-only JSON in `graft/.graph/wiring.json`
 * (nodes + edges), which an agent never greps or reads. This module projects its
 * NODES up into markdown: one small card per source file, mirroring the source
 * tree under `graft/` (e.g. `graft/src/ai/providers.md`). Each card lists the
 * file's symbols with their `L<start>-L<end>` spans and a one-line description, so
 * a `grep <symbol>` / `find <name>` / `cat` lands on the card and the agent reads
 * ~150 tokens instead of the whole source file. Edges stay in the JSON — you can't
 * grep a traversal — and are reached through `graft ask`.
 *
 * Cards are a pure projection: no LLM work here. The one-liner is the node's LLM
 * `summary` when present (after `graft build --deep`), else its deterministic
 * `signature`, so cards are useful even in a $0 structure-only build.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { relPosix } from "../util/paths.js";
import { matter } from "../util/front-matter.js";
import type { GraphV1, NodeV1 } from "./types.js";
import { CACHE_DIR, readNodes } from "../context/node-file.js";
import { GRAPH_DIR } from "./write.js";
import { inBrand } from "../brand.js";

const INDEX_FILE = "INDEX.md";
/** Where a root-level file card goes when `graft/<stem>.md` is already a concept
 * node (same stem as a slug — Laravel `server.php` vs a "Server" concept). */
const ROOT_CARD_DIR = "_root";

export interface CardFileInfo {
  /** Card path relative to the context dir, e.g. "src/ai/providers.md". */
  card: string;
  /** Source path the card mirrors, e.g. "src/ai/providers.ts". */
  path: string;
  symbols: number;
}

export interface CardStats {
  written: number;
  pruned: number;
  files: CardFileInfo[];
}

/** True when `path` is an existing concept node (frontmatter carries `slug`). */
function isConceptNodeFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const fm = matter(readFileSync(path, "utf8")).data as Record<string, unknown>;
    return fm.slug != null && String(fm.slug).length > 0;
  } catch {
    return false;
  }
}

/** The card path for a source path: mirror the tree, swap the extension for .md.
 * Root-level sources share `graft/` with concept nodes. If that filename is
 * already a concept, park the file card under `_root/` instead of clobbering it. */
function cardPathFor(outDir: string, sourcePath: string): string {
  const md = sourcePath.replace(/\.[^./]+$/, "") + ".md";
  const primary = join(outDir, md);
  if (sourcePath.includes("/")) return primary;
  if (isConceptNodeFile(primary)) return join(outDir, ROOT_CARD_DIR, md);
  return primary;
}

/** Starting line of an "L43-L55" span, for stable ordering (0 if unparseable). */
function spanStart(span: string): number {
  const m = /^L(\d+)/.exec(span);
  return m ? Number(m[1]) : 0;
}

/** First line of a node's meaning: LLM summary if ready, else its signature. */
function oneLiner(node: NodeV1): string {
  const s = node.summary?.trim();
  if (s) return s.split("\n")[0].trim();
  return node.signature?.trim() ?? "";
}

/** path → concept-node slugs that cite it as a source (for the up-links). */
function conceptsByPath(outDir: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const node of readNodes(outDir)) {
    for (const src of node.sources) {
      const list = map.get(src.path) ?? [];
      list.push(node.slug);
      map.set(src.path, list);
    }
  }
  return map;
}

/** Render one file's card. `fileNode` may be absent for parse-only fragments. */
function renderCard(
  sourcePath: string,
  fileNode: NodeV1 | undefined,
  symbols: NodeV1[],
  conceptSlugs: string[],
): string {
  const uplinks = conceptSlugs
    .sort()
    .map((s) => `[[${s}]]`)
    .join(" ");
  const head = uplinks ? `# ${sourcePath} · ${uplinks}` : `# ${sourcePath}`;
  const lines: string[] = [head, ""];

  const fileSummary = fileNode ? oneLiner(fileNode) : "";
  if (fileSummary) lines.push(fileSummary, "");

  const sorted = [...symbols].sort(
    (a, b) => spanStart(a.span) - spanStart(b.span) || a.name.localeCompare(b.name),
  );
  for (const n of sorted) {
    const desc = oneLiner(n);
    const tail = desc ? ` — ${desc}` : "";
    lines.push(`- ${n.name} · ${n.kind} · ${n.span}${tail}`);
  }
  if (sorted.length === 0) lines.push("_No extracted symbols in this file._");
  return lines.join("\n") + "\n";
}

/** Every existing card file (`.md` inside subdirs of outDir; not concept nodes). */
function listExistingCards(outDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (dir === outDir && (e.name === CACHE_DIR || e.name === GRAPH_DIR)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(join(dir, e.name));
      }
    }
  };
  for (const e of readdirSync(outDir, { withFileTypes: true })) {
    // Concept nodes and INDEX.md are top-level files — skip. Cards live in
    // subdirs (`src/…`, and `_root/` when a root card would collide with a concept).
    if (e.isDirectory() && e.name !== CACHE_DIR && e.name !== GRAPH_DIR) {
      walk(join(outDir, e.name));
    }
  }
  return out;
}

/** Remove now-empty directories under outDir (bottom-up), skipping .cache/.graph. */
function pruneEmptyDirs(outDir: string): void {
  const visit = (dir: string): boolean => {
    // returns true if dir is empty after visiting children
    let empty = true;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (dir === outDir && (e.name === CACHE_DIR || e.name === GRAPH_DIR)) {
        empty = false;
        continue;
      }
      const child = join(dir, e.name);
      if (e.isDirectory()) {
        if (visit(child)) rmSync(child, { recursive: true, force: true });
        else empty = false;
      } else {
        empty = false;
      }
    }
    return empty;
  };
  if (existsSync(outDir)) visit(outDir);
}

/**
 * Write one wiring card per source file into `outDir`, mirroring the source tree,
 * and prune cards whose source no longer exists. Returns what changed.
 */
export function writeCards(graph: GraphV1, outDir: string): CardStats {
  const byPath = new Map<string, NodeV1[]>();
  for (const n of graph.nodes) {
    const list = byPath.get(n.path) ?? [];
    list.push(n);
    byPath.set(n.path, list);
  }

  const concepts = conceptsByPath(outDir);
  const written = new Set<string>();
  const files: CardFileInfo[] = [];

  for (const [sourcePath, group] of byPath) {
    const fileNode = group.find((n) => n.kind === "file");
    const symbols = group.filter((n) => n.kind !== "file");
    const cardPath = cardPathFor(outDir, sourcePath);
    mkdirSync(dirname(cardPath), { recursive: true });
    writeFileSync(cardPath, renderCard(sourcePath, fileNode, symbols, concepts.get(sourcePath) ?? []));
    written.add(cardPath);
    files.push({ card: relPosix(outDir, cardPath), path: sourcePath, symbols: symbols.length });
  }

  let pruned = 0;
  for (const existing of listExistingCards(outDir)) {
    if (!written.has(existing)) {
      rmSync(existing);
      pruned++;
    }
  }
  pruneEmptyDirs(outDir);

  files.sort((a, b) => a.card.localeCompare(b.card));
  return { written: written.size, pruned, files };
}

/**
 * Write `graft/INDEX.md` — the roster an agent `cat`s to orient. Lists the concept
 * nodes on disk and the per-file cards. Deterministic order; no timestamps.
 */
export function writeIndex(outDir: string, files: CardFileInfo[]): void {
  // Spelled by the name that built it: a trail-only machine has no `graft` to run.
  const lines: string[] = [
    "# graft — repo map",
    "",
    "Small markdown nodes summarising this repo. `grep` any term, symbol, or",
    'filename here, or run `graft ask "<task>"`. Each node carries prose plus exact',
    "`file:line`; open a source file only to edit the named span.",
    "",
    // Whoever reads this file has already decided to look at graft, so this is the
    // one place a pointer to the richer surface is welcome rather than noise. Stated
    // as what exists, not as an instruction — see `mcp/instructions.ts` for why.
    "The same graph is queryable as MCP tools (`graft_find_code`, `graft_find_all`,",
    "`graft_trace_calls`, `graft_file_api`, `graft_repo_map`) where a host exposes them, and",
    "as the `graft` CLI everywhere else. Edges — who calls what — live only in the",
    "graph, not in these files: `graft callers <symbol>` is the only way to read them.",
    "",
  ].map((l) => inBrand(l));

  const concepts = readNodes(outDir).sort((a, b) => a.slug.localeCompare(b.slug));
  if (concepts.length) {
    lines.push("## Concepts", "");
    for (const c of concepts) {
      const srcs = c.sources.map((s) => s.path).join(", ");
      const tail = srcs ? ` · ${srcs}` : "";
      lines.push(`- [${c.slug}](${c.slug}.md) — ${c.name || c.slug}${tail}`);
    }
    lines.push("");
  }

  if (files.length) {
    const withSymbols = files.filter((f) => f.symbols > 0).length;
    lines.push("## Files", "");
    lines.push(
      `${files.length} per-file wiring cards mirror the source tree under \`graft/\` ` +
        `(${withSymbols} carry extracted symbols). They are deliberately not enumerated here —`,
      "`grep` a symbol or `find`/`ls` a filename under `graft/` to land on the card for that file.",
      "",
    );
  }

  writeFileSync(join(outDir, INDEX_FILE), lines.join("\n"));
}

/** One symbol a concept node covers: its name, kind, and `path:span` pointer. */
export interface CoverRef {
  symbol: string;
  kind: string;
  /** `src/ai/providers.ts:L28-L35` — same vocabulary `graft ask` returns. */
  at: string;
}

/**
 * Backfill each concept node's frontmatter with a `covers:` list — the symbols
 * (and their exact `file:line`) it spans, read from the wiring graph. This is the
 * explicit OKF↔Wiring link: it doubles as grep bait (a `grep <symbol>` lands on
 * the prose node, not just its card) and lets an agent read the span straight
 * from the node without ever opening `wiring.json`.
 *
 * A surgical frontmatter patch: the generated body and every other key are
 * preserved verbatim; only `covers` is added/replaced. Concept nodes are the
 * top-level `.md` files that carry a `slug` (cards live in subdirs, or at the
 * top level without a slug when they mirror a root source; INDEX.md is skipped).
 * On a $0 structure-only build there are no concept nodes, so this is a no-op.
 * Returns the number of nodes enriched.
 */
export function writeCovers(graph: GraphV1, outDir: string): number {
  if (!existsSync(outDir)) return 0;

  const symbolsByPath = new Map<string, NodeV1[]>();
  for (const n of graph.nodes) {
    if (n.kind === "file") continue;
    const list = symbolsByPath.get(n.path) ?? [];
    list.push(n);
    symbolsByPath.set(n.path, list);
  }
  for (const list of symbolsByPath.values()) {
    list.sort((a, b) => spanStart(a.span) - spanStart(b.span) || a.name.localeCompare(b.name));
  }

  let enriched = 0;
  for (const entry of readdirSync(outDir)) {
    if (!entry.endsWith(".md") || entry === INDEX_FILE) continue;
    const full = join(outDir, entry);
    const parsed = matter(readFileSync(full, "utf8"));
    // Root-level file cards have no concept slug; stamping `covers: []` onto
    // them made readNodes treat them as concept nodes (#261).
    if (parsed.data.slug == null || String(parsed.data.slug).length === 0) continue;
    const sources = Array.isArray(parsed.data.sources)
      ? (parsed.data.sources as Array<{ path?: string }>)
      : [];

    const covers: CoverRef[] = [];
    for (const path of [...new Set(sources.map((s) => s.path ?? ""))].sort()) {
      for (const n of symbolsByPath.get(path) ?? []) {
        covers.push({ symbol: n.name, kind: n.kind, at: `${n.path}:${n.span}` });
      }
    }

    // Re-stringify with covers appended last, so re-runs produce a stable diff.
    const { covers: _prev, ...rest } = parsed.data as Record<string, unknown>;
    writeFileSync(full, matter.stringify(parsed.content, { ...rest, covers }));
    enriched++;
  }
  return enriched;
}
