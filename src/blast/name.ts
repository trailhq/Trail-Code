/**
 * Naming the clusters a diff reaches — the rung of the ladder between a concept
 * node and the symbol backstop (see {@link LabelSource}).
 *
 * The point is scope. Getting labels from `build --deep` means summarising every
 * file in the repo — 356 calls and thirteen minutes on graft's own repo — to put
 * names on the six clusters a PR actually touches, and it still misses: only 40% of
 * this repo's files are claimed by a concept, so the rest fall back to a path. Here
 * the unit of work is the cluster, not the file: one request names all of them from
 * data the graph already holds (paths and symbol names — no file reads), and the
 * answer is cached by content hash so the next PR pays nothing for a cluster whose
 * files did not change.
 *
 * Two rules keep it honest:
 *   - a cluster spanning unrelated features must come back "mixed", and then keeps
 *     its symbol backstop rather than a flattering name;
 *   - a failure of any kind — no key, spent quota, refused call, malformed answer —
 *     leaves every label exactly as it was and never fails the caller.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CACHE_DIR } from "../context/node-file.js";
import type { ChatModel } from "../ai/llm/types.js";
import type { GraphV1 } from "../graph/types.js";
import type { BlastReport, ChangedArea, ImpactedModule } from "./blast.js";
import { shortLabel } from "./modules.js";

/** One cluster to name: its identity, its files and the symbols inside it. */
export interface Cluster {
  key: string;
  files: string[];
  symbols: string[];
}

/** Anything that can turn clusters into names. A model in production, a stub in tests. */
export interface Namer {
  /** Names by cluster key. A key the namer chose not to name is simply absent. */
  name(clusters: Cluster[]): Promise<Map<string, string>>;
}

export interface NameStats {
  /** Labels taken from the cache, and labels that cost a call. */
  cached: number;
  named: number;
  /** Clusters the namer declined ("mixed") or could not answer for. */
  declined: number;
  /** Set when naming was attempted and failed outright; the reason, for one line
   * in the report. Never thrown: a comment without names still beats no comment. */
  error?: string;
}

const SYSTEM_PROMPT = `You name parts of a codebase for a pull-request reviewer.

You are given clusters of files that a change can affect. For each cluster, answer with the FEATURE or SUBSYSTEM those files implement, as a developer on the team would refer to it in conversation.

Rules:
- 2 to 4 words, Title Case. No trailing "Module", "System", "Layer", "Manager" or "Handler" unless the team would genuinely say it.
- Name the RESPONSIBILITY, not the mechanics: "Query Freshness Gate", "Workspace Federation", "Asset Bundling". Never restate a path or a directory name, and never name it after the language or the file type.
- If the files in a cluster serve two or more unrelated responsibilities, answer exactly "mixed" for that cluster. A wrong name is worse than no name, because a reviewer will trust it.
- Answer for every cluster key you are given, and invent no other keys.`;

const NAMES_SCHEMA = {
  type: "object",
  properties: {
    names: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "the cluster key, copied verbatim" },
          name: { type: "string", description: '2-4 word Title Case name, or "mixed"' },
        },
        required: ["key", "name"],
        additionalProperties: false,
      },
    },
  },
  required: ["names"],
  additionalProperties: false,
} as const;

/** Symbols shown per cluster. Enough to characterise it; not a file listing. */
const SYMBOLS_PER_CLUSTER = 8;

/**
 * Clusters per request. A PR's diagram needs six, so one batch covers it — the cap
 * is for the cache-priming job, which deliberately walks a wide diff and can hand
 * over fifty clusters at once. Past a dozen the prompt stops being a list and the
 * model starts dropping keys.
 */
const CLUSTERS_PER_CALL = 12;

function clusterPrompt(clusters: Cluster[]): string {
  return clusters
    .map((c) => {
      const files = c.files.slice(0, 10).join(", ");
      const symbols = c.symbols.slice(0, SYMBOLS_PER_CLUSTER).join(", ");
      return `key: ${c.key}\n  files: ${files}\n  symbols: ${symbols || "(none extracted)"}`;
    })
    .join("\n\n");
}

/** The production namer: one forced-tool call for every cluster at once. */
export class ChatNamer implements Namer {
  constructor(private readonly model: ChatModel) {}

  async name(clusters: Cluster[]): Promise<Map<string, string>> {
    const res = await this.model.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: clusterPrompt(clusters) },
      ],
      tools: [{ name: "record_names", description: "Record one name per cluster.", parameters: NAMES_SCHEMA as unknown as Record<string, unknown> }],
      responseFormat: { kind: "tool", name: "record_names" },
      temperature: 0,
      maxTokens: 1024,
    });

    const out = new Map<string, string>();
    const call = res.toolCalls[0]?.args as { names?: { key?: string; name?: string }[] } | undefined;
    for (const row of call?.names ?? []) {
      if (!row?.key || !row?.name) continue;
      const clean = sanitize(row.name);
      // "mixed" is an answer, not a name: the cluster keeps its backstop.
      if (!clean || /^mixed$/i.test(clean)) continue;
      out.set(row.key, clean);
    }
    return out;
  }
}

/**
 * A model-written string on its way into a Mermaid label and a markdown table.
 *
 * Symbol names from a fork's diff reach the prompt, so the answer is untrusted
 * input: anything that could close a label, open a tag or start a table cell is
 * stripped here rather than at each render site.
 */
export function sanitize(raw: string): string {
  const flat = raw.replace(/[\r\n]+/g, " ").replace(/[<>"'`|(){}[\]#]/g, "").replace(/\s+/g, " ").trim();
  return shortLabel(flat);
}

/**
 * The cache key for a cluster: what it contains, not what it is called.
 *
 * Member paths pin the shape and each member's `body_hash` pins the content, so a
 * cluster is renamed only when the code in it actually changes. Without this the
 * same area gets a slightly different name on every PR and two comments stop being
 * comparable — the failure the cache exists to prevent.
 */
export function clusterHash(files: string[], hashes: Map<string, string>): string {
  const parts = [...files].sort().map((f) => `${f}:${hashes.get(f) ?? "?"}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

function cachePath(contextDir: string): string {
  return join(contextDir, CACHE_DIR, "areas.json");
}

export function loadNameCache(contextDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(cachePath(contextDir), "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    // A missing or corrupt cache is a cache miss, never an error: the names are
    // derivable again, and refusing to run because a cache file is bad is worse.
    return {};
  }
}

export function saveNameCache(contextDir: string, names: Record<string, string>): void {
  const path = cachePath(contextDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(names, null, 2)}\n`);
  } catch {
    // Best-effort: an unwritable cache costs a call next time, nothing more.
  }
}

/** File-node content hashes, which is what a cluster's identity is built from. */
function fileHashes(graph: GraphV1): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of graph.nodes) if (n.kind === "file") out.set(n.path, n.body_hash ?? "");
  return out;
}

type Labelled = ImpactedModule | ChangedArea;

function symbolsOf(c: Labelled): string[] {
  return "symbols" in c ? c.symbols.map((s) => s.name) : c.seedNames;
}

/**
 * Fill in labels for every cluster still sitting on its symbol backstop.
 *
 * Clusters already named by a concept node are left alone: a concept was written
 * from whole file bodies, which is strictly more than the paths and symbol names
 * this pass can see.
 */
export async function applyNames(
  graph: GraphV1,
  report: BlastReport,
  opts: { namer?: Namer; contextDir: string },
): Promise<NameStats> {
  const stats: NameStats = { cached: 0, named: 0, declined: 0 };
  // `testModules` are deliberately absent: the comment shows them as a file count in
  // one collapsed line and nowhere else, so naming them buys nothing and can push a
  // normal PR over CLUSTERS_PER_CALL into a second request.
  const targets: Labelled[] = [...report.modules, ...report.areas]
    .filter((c) => c.labelSource === "symbol");
  if (targets.length === 0) return stats;

  const hashes = fileHashes(graph);
  const cache = loadNameCache(opts.contextDir);
  const pending: { cluster: Cluster; targets: Labelled[] }[] = [];
  /** Clusters sharing a hash share a name — and one call, not several. */
  const byHash = new Map<string, Labelled[]>();
  for (const t of targets) {
    const hash = clusterHash(t.files, hashes);
    byHash.set(hash, [...(byHash.get(hash) ?? []), t]);
  }

  for (const [hash, group] of byHash) {
    const hit = cache[hash];
    if (hit) {
      for (const t of group) { t.label = hit; t.labelSource = "named"; }
      stats.cached++;
      continue;
    }
    pending.push({
      cluster: { key: hash, files: group[0].files, symbols: symbolsOf(group[0]) },
      targets: group,
    });
  }

  if (pending.length === 0 || !opts.namer) return stats;

  const named = new Map<string, string>();
  for (let i = 0; i < pending.length; i += CLUSTERS_PER_CALL) {
    const batch = pending.slice(i, i + CLUSTERS_PER_CALL);
    try {
      for (const [k, v] of await opts.namer.name(batch.map((p) => p.cluster))) named.set(k, v);
    } catch (err) {
      // Every label already holds its backstop, so there is nothing to undo — and a
      // later batch failing must not discard the names an earlier one returned.
      stats.error = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  for (const p of pending) {
    const name = named.get(p.cluster.key);
    if (!name) { stats.declined++; continue; }
    for (const t of p.targets) { t.label = name; t.labelSource = "named"; }
    cache[p.cluster.key] = name;
    stats.named++;
  }
  if (stats.named > 0) saveNameCache(opts.contextDir, cache);
  return stats;
}

/**
 * Name the clusters left on their symbol backstop, and say what it cost.
 *
 * Everything here is best-effort by construction: no key, a spent quota or a
 * refused call leaves the backstop labels in place, because neither a PR check
 * nor a review comment should fail over a cosmetic layer. The note comes back
 * rather than going to a stream, so `graft blast --name` can prefix it and the
 * App can log it against the pull request it belongs to.
 */
export async function nameReport(
  graph: GraphV1,
  report: BlastReport,
  contextDir: string,
): Promise<{ stats: NameStats; note: string | null }> {
  const { resolveConfig } = await import("../ai/providers.js");
  const cfg = resolveConfig({ contextDir });

  let namer: Namer | undefined;
  if (cfg.chatModel) {
    namer = new ChatNamer(cfg.chatModel);
  } else if (cfg.apiKey) {
    const { createChatModel } = await import("../ai/llm/factory.js");
    namer = new ChatNamer(createChatModel({
      provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model,
      baseUrl: cfg.baseUrl, headers: cfg.headers,
      reasoningEffort: cfg.reasoningEffort, extraBody: cfg.extraBody,
    }));
  }

  const stats = await applyNames(graph, report, { namer, contextDir });
  if (!namer) return { stats, note: "no API key (GRAFT_API_KEY), so areas keep their symbol names" };
  if (stats.error) return { stats, note: `naming failed (${stats.error}) — areas keep their symbol names` };
  if (stats.named + stats.cached + stats.declined > 0) {
    const bits = [`${stats.named} named`, `${stats.cached} cached`];
    if (stats.declined > 0) bits.push(`${stats.declined} left as symbols (mixed)`);
    return { stats, note: bits.join(", ") };
  }
  return { stats, note: null };
}
