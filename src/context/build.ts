/**
 * `init` — build the `.context/` graph from a code repository.
 *
 * Pipeline (no database, no embeddings):
 *   1. Walk the repo for source files.
 *   2. Summarize each file to prose (one LLM call per file, cached by content hash).
 *   3. Synthesize a CURATED node set from the labeled summaries (the synthesizer
 *      decides granularity: subsystems, notable files, and concepts). This is
 *      one LLM call per batch of summaries; batches are cached by content.
 *   4. Resolve node names → slugs and links → edges; attribute each node to its
 *      source files so staleness stays exact.
 *   5. Write one markdown file per node (preserving human notes) + a manifest.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { walkDir } from "../ingest/fs.js";
import { filterByOnlyDirs } from "../graph/source-files.js";
import { readFingerprint } from "../graph/fingerprint.js";
import { contentHash } from "../util/id.js";
import { relPosix } from "../util/paths.js";
import { readSourceFile } from "../util/source.js";
import { readFollowNestedRepos, readFollowSubmodules, readIncludeDirs } from "../util/state.js";
import type { Summarizer } from "../ai/summarize.js";
import { LlmFailureGate } from "../ai/failure.js";
import type { FileSummary, SynthNode, Synthesizer } from "../ai/synthesize.js";
import {
  CACHE_DIR,
  MANIFEST_VERSION,
  contextDirFor,
  deleteNode,
  digestSources,
  existingNodeSlugs,
  slugify,
  writeManifest,
  writeNode,
  type ContextNode,
  type Manifest,
  type NodeLink,
  type SourceRef,
} from "./node-file.js";

/** Extensions treated as source code. */
export const CODE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".scala",
  ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cc",
  ".cs", ".swift", ".gleam", ".sql", ".sh", ".proto",
];

/** Char budget of summary text per synthesis call (keeps each call in-context). */
const BATCH_CHAR_BUDGET = 48_000;

export interface BuildProgress {
  phase: "summarize" | "synthesize" | "write";
  index: number;
  total: number;
  file: string;
}

export interface BuildOptions {
  /** Override the output dir (default: `<root>/.context`). */
  contextDir?: string;
  /** Extensions to treat as code. Default: {@link CODE_EXTENSIONS}. */
  extensions?: string[];
  /** Repo-relative directory prefixes to limit the concept pass (`--only-dir`).
   * Same prefix semantics as the wiring walk. When omitted, falls back to the
   * whitelist recorded in the graph fingerprint (mirrors `checkGraph`). */
  onlyDirs?: string[];
  /** Human label for the model, recorded in the manifest (e.g. "openrouter:openai/gpt-4o-mini"). */
  model: string;
  summarizer: Summarizer;
  synthesizer: Synthesizer;
  /** Files summarized in parallel during phase 1. Default 8. Raised via `graft build -j`. */
  concurrency?: number;
  onProgress?: (info: BuildProgress) => void;
}

export interface BuildResult {
  contextDir: string;
  files: number;
  summarized: number;
  cached: number;
  batches: number;
  nodes: number;
  links: number;
  errors: string[];
  /** Files whose summary call failed, and files never attempted once the pass gave
   * up — reported as data so the CLI can exit non-zero without reading messages (#127). */
  failedFiles: number;
  skippedFiles: number;
  /** Why the summarize phase stopped early, when it did. */
  fatal?: string;
}

/** CLI/API `--only-dir` wins; otherwise the whitelist recorded in the graph
 * fingerprint — the same source `checkGraph` / `probeDrift` use, so a later
 * `--deep` without the flag still skips files the wiring pass excluded. */
function resolveOnlyDirs(outDir: string, explicit?: readonly string[]): Set<string> | undefined {
  const list = explicit && explicit.length > 0 ? explicit : (readFingerprint(outDir)?.onlyDirs ?? []);
  return list.length > 0 ? new Set(list) : undefined;
}

/**
 * Files the concept pass summarizes (and `checkContext` re-hashes): the same
 * walk as before (`--include-dir` / submodule flags from state, minus the
 * output dir), then {@link filterByOnlyDirs}. Shared so build and check cannot
 * disagree about what "current" means under a whitelist.
 */
export function listContextFiles(
  root: string,
  outDir: string,
  exts: readonly string[],
  explicitOnlyDirs?: readonly string[],
): string[] {
  const walked = walkDir(root, readIncludeDirs(root), {
    followSubmodules: readFollowSubmodules(root),
    followNestedRepos: readFollowNestedRepos(root),
  })
    .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
    .filter((f) => !f.startsWith(outDir));
  return filterByOnlyDirs(walked, root, resolveOnlyDirs(outDir, explicitOnlyDirs));
}

/** The gitignored LLM-call cache: per-file summaries + per-batch synthesis. */
interface BuildCache {
  summaries: Record<string, { hash: string; summary: string }>;
  synth: Record<string, SynthNode[]>;
}

interface FileWork {
  rel: string;
  hash: string;
  summary?: string;
}

/** A node under construction, before its digest/links are finalized. */
interface NodeDraft {
  name: string;
  slug: string;
  type: string;
  summary: string;
  sources: Map<string, string>; // path → hash
  links: Map<string, NodeLink>; // "to|relation" → link
}

export async function buildContext(dir: string, opts: BuildOptions): Promise<BuildResult> {
  const root = resolve(dir);
  const outDir = contextDirFor(root, opts.contextDir);
  const exts = opts.extensions ?? CODE_EXTENSIONS;
  // Read the same persisted walk choices as the Tier-1 wiring graph, so the
  // Tier-2 concept pipeline sees exactly the same directories and submodules.
  // `--only-dir` is applied with the same prefix match as wiring (CLI/API, else
  // the fingerprint) so out-of-scope files are never summarized or synthesized.
  const files = listContextFiles(root, outDir, exts, opts.onlyDirs);

  const cache = loadCache(outDir);
  // Flush the summary cache to disk during phase 1 so a build interrupted
  // partway (session/rate limit, crash, Ctrl-C) resumes without re-summarizing
  // the files it already did. Throttled to keep disk churn negligible; on the
  // next run every already-summarized file is a content-hash cache hit ($0).
  let lastFlush = Date.now();
  const flushEveryMs = summaryCheckpointMs();
  const maybeFlush = (): void => {
    const now = Date.now();
    if (now - lastFlush < flushEveryMs) return;
    lastFlush = now;
    saveCache(outDir, cache);
  };
  const result: BuildResult = {
    contextDir: outDir,
    files: 0,
    summarized: 0,
    cached: 0,
    batches: 0,
    nodes: 0,
    links: 0,
    errors: [],
    failedFiles: 0,
    skippedFiles: 0,
  };

  // Phase 1: summarize each file, concurrent, content-hash cached.
  //
  // The gate is shared with the crux pass (`graph/enrich.ts`): once the provider has
  // clearly stopped serving — a spent quota, a rejected key — the remaining files are
  // not attempted. This pass is where #127's 1,617 doomed calls were spent, one per
  // file, before the build exited 0.
  const gate = new LlmFailureGate();
  const work = await mapWithConcurrency(files, Math.max(1, opts.concurrency ?? 8), async (file, i): Promise<FileWork | undefined> => {
    const rel = relPosix(root, file);
    opts.onProgress?.({ phase: "summarize", index: i, total: files.length, file: rel });
    let code: string;
    try {
      const decoded = readSourceFile(file);
      if (decoded === null) return undefined; // unsupported encoding (e.g. UTF-16BE) — skip, not an error
      code = decoded;
    } catch (err) {
      result.errors.push(`${rel}: ${errMsg(err)}`);
      return undefined;
    }
    const hash = contentHash(code);
    const hit = cache.summaries[rel];
    if (hit && hit.hash === hash) {
      result.cached++;
      return { rel, hash, summary: hit.summary };
    }
    // A cache hit is still served after the gate closes (it costs nothing) — only
    // the call is skipped.
    if (gate.stopped) {
      gate.skip();
      return { rel, hash };
    }
    try {
      const summary = await opts.summarizer.summarize(code, { path: rel });
      cache.summaries[rel] = { hash, summary };
      result.summarized++;
      maybeFlush();
      gate.succeeded();
      return { rel, hash, summary };
    } catch (err) {
      const message = errMsg(err);
      result.errors.push(`${rel}: ${message}`);
      gate.record(message);
      return { rel, hash }; // covered (counts against staleness) but not summarized
    }
  });
  result.failedFiles = gate.failed;
  result.skippedFiles = gate.skipped;
  result.fatal = gate.fatal;

  // Phase 1 done: persist every summary before the (also LLM-backed) synthesis
  // phase, so an interruption there never discards phase-1 work.
  saveCache(outDir, cache);

  const processed = work.filter((w): w is FileWork => w !== undefined);
  result.files = processed.length;
  const hashByPath = new Map(processed.map((w) => [w.rel, w.hash]));

  // Phase 2: synthesize curated nodes from the summaries, batched + cached.
  const summarized: FileSummary[] = processed
    .filter((w): w is FileWork & { summary: string } => Boolean(w.summary))
    .map((w) => ({ path: w.rel, summary: w.summary }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const batches = batchBySize(summarized, BATCH_CHAR_BUDGET);
  result.batches = batches.length;

  const synthNodes: SynthNode[] = [];
  for (let b = 0; b < batches.length; b++) {
    opts.onProgress?.({ phase: "synthesize", index: b, total: batches.length, file: `batch ${b + 1}` });
    const key = batchKey(batches[b], hashByPath);
    let nodes = cache.synth[key];
    // An empty array is a miss, not a hit: caching [] made a silent empty
    // synthesis permanent, the same trap #177 closed for the meaning pass (#129).
    const cached = Array.isArray(nodes) && nodes.length > 0;
    if (!cached) {
      nodes = await opts.synthesizer.synthesize(batches[b]);
      if (nodes.length > 0) cache.synth[key] = nodes;
      else delete cache.synth[key];
    }
    const links = nodes.reduce((n, node) => n + node.links.length, 0);
    console.error(
      `  synthesis batch ${b + 1}/${batches.length}: ${nodes.length} nodes, ${links} links${cached ? " (cached)" : ""}`,
    );
    synthNodes.push(...nodes);
  }
  // Drop cache entries for batches we no longer produce, so it can't grow forever.
  // Skip empty arrays so a failed batch is retried on the next --deep, not frozen.
  cache.synth = Object.fromEntries(
    batches.flatMap((batch) => {
      const k = batchKey(batch, hashByPath);
      const v = cache.synth[k];
      return v && v.length > 0 ? [[k, v] as [string, SynthNode[]]] : [];
    }),
  );
  saveCache(outDir, cache);

  // Phase 3: merge synth nodes by slug, building a name→slug resolution table.
  const drafts = new Map<string, NodeDraft>();
  const nameToSlug = new Map<string, string>();
  for (const n of synthNodes) {
    const slug = slugify(n.name);
    let draft = drafts.get(slug);
    if (!draft) {
      draft = { name: n.name, slug, type: n.type || "concept", summary: n.summary ?? "", sources: new Map(), links: new Map() };
      drafts.set(slug, draft);
    }
    if ((n.summary?.length ?? 0) > draft.summary.length) draft.summary = n.summary;
    if (n.type && draft.type === "concept") draft.type = n.type;
    for (const src of n.sources) {
      const hash = hashByPath.get(src);
      if (hash) draft.sources.set(src, hash);
    }
    registerName(nameToSlug, n.name, slug);
  }

  // Phase 4: resolve links to slugs (both endpoints must be defined nodes).
  for (const n of synthNodes) {
    const from = drafts.get(slugify(n.name));
    if (!from) continue;
    for (const link of n.links) {
      const to = resolveSlug(nameToSlug, link.to);
      if (!to || to === from.slug) continue;
      const key = `${to}|${link.relation}`;
      if (!from.links.has(key)) from.links.set(key, { to, relation: link.relation, description: link.description });
    }
  }

  // Concept nodes the model didn't attribute to files inherit the provenance of
  // the nodes they link to, so they still go stale when their subject changes.
  for (const draft of drafts.values()) {
    if (draft.sources.size > 0) continue;
    for (const link of draft.links.values()) {
      const target = drafts.get(link.to);
      if (target) for (const [p, h] of target.sources) draft.sources.set(p, h);
    }
  }

  // Phase 5: finalize, reconcile with disk, write.
  const nodes: ContextNode[] = [...drafts.values()].map((d) => {
    const sources: SourceRef[] = [...d.sources.entries()]
      .map(([path, hash]) => ({ path, hash }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      name: d.name,
      slug: d.slug,
      type: d.type || "concept",
      summary: d.summary,
      sources,
      sourcesDigest: digestSources(sources),
      links: [...d.links.values()].sort((a, b) => a.to.localeCompare(b.to)),
      human: "",
    };
  });
  nodes.sort((a, b) => a.slug.localeCompare(b.slug));

  const liveSlugs = new Set(nodes.map((n) => n.slug));
  for (const slug of existingNodeSlugs(outDir)) {
    if (!liveSlugs.has(slug)) deleteNode(outDir, slug);
  }
  for (let i = 0; i < nodes.length; i++) {
    opts.onProgress?.({ phase: "write", index: i, total: nodes.length, file: nodes[i].slug });
    writeNode(outDir, nodes[i]);
  }
  result.nodes = nodes.length;
  result.links = nodes.reduce((n, node) => n + node.links.length, 0);
  // Failure mode 2 (#129): a model can emit real tool_calls whose quality
  // collapsed (many batches, zero links) with nothing per-batch in the log.
  if (result.links === 0 && result.batches > 1) {
    console.error(
      `⚠ synthesis produced 0 links across ${result.batches} batches — the model may be degrading; see per-batch counts above`,
    );
  }

  // Manifest: authoritative file→hash map (every processed file) + node roster.
  const fileRefs: SourceRef[] = processed
    .map((w) => ({ path: w.rel, hash: w.hash }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    model: opts.model,
    repoDigest: digestSources(fileRefs),
    files: fileRefs,
    nodes: nodes.map((n) => ({
      slug: n.slug,
      name: n.name,
      type: n.type,
      sources: n.sources.map((s) => s.path),
      sourcesDigest: n.sourcesDigest,
    })),
  };
  writeManifest(outDir, manifest);

  return result;
}

/** Greedily pack file summaries into batches under a char budget (≥1 file each). */
function batchBySize(files: FileSummary[], budget: number): FileSummary[][] {
  const batches: FileSummary[][] = [];
  let cur: FileSummary[] = [];
  let size = 0;
  for (const f of files) {
    const len = f.path.length + f.summary.length + 8;
    if (cur.length > 0 && size + len > budget) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += len;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** Stable key for a batch: its files and their content hashes. */
function batchKey(batch: FileSummary[], hashByPath: Map<string, string>): string {
  return contentHash(
    batch
      .map((f) => `${f.path}:${hashByPath.get(f.path) ?? ""}`)
      .sort()
      .join("\n"),
  );
}

function registerName(table: Map<string, string>, name: string, slug: string): void {
  const key = name.trim().toLowerCase();
  if (key && !table.has(key)) table.set(key, slug);
}

function resolveSlug(table: Map<string, string>, name: string): string | undefined {
  return table.get(name.trim().toLowerCase());
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cachePath(outDir: string): string {
  return join(outDir, CACHE_DIR, "summaries.json");
}

function loadCache(outDir: string): BuildCache {
  const path = cachePath(outDir);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BuildCache>;
      return { summaries: parsed.summaries ?? {}, synth: parsed.synth ?? {} };
    } catch {
      /* fall through to empty */
    }
  }
  return { summaries: {}, synth: {} };
}

function saveCache(outDir: string, cache: BuildCache): void {
  const path = cachePath(outDir);
  mkdirSync(join(outDir, CACHE_DIR), { recursive: true });
  // Atomic: a kill mid-write can't leave a truncated (unparseable) cache that
  // would throw away every prior summary on the next load.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, path);
}

/** Min interval between phase-1 cache flushes. Env seam for tests. */
function summaryCheckpointMs(): number {
  const raw = Number(process.env.GRAFT_SUMMARY_CHECKPOINT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
