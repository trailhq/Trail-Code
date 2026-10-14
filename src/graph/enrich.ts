/**
 * Tier-2 pass: attach the LLM meaning layer (`summary` + `crux`) to nodes.
 *
 * graph.json is its own cache — the committed file already holds every node's
 * summary/crux from a prior run. So this pass is diff-driven:
 *
 *   - cache hit  — a prior node with the same id, same `body_hash`, and
 *     `summary_state:"ready"` → carry its summary/crux over, no LLM call.
 *   - stale      — a prior ready summary whose body has since changed → keep the
 *     old text as a hint but mark it "stale". Recomputed only if an LLM is given.
 *   - pending    — new or never-summarized node → one LLM call when an LLM is
 *     given, otherwise left "pending".
 *
 * Passing no summarizer runs the cache/stale bookkeeping alone (no calls, no
 * cost) — which is what a plain `graph` build does, so it never wipes the
 * meaning layer a previous `--llm` run produced.
 *
 * The LLM returns line numbers into the slice it was shown; we consume them here,
 * once, to cut `crux.code` verbatim from the source. `crux.span` is a pointer
 * only and is never used to re-slice.
 */
import { formatCruxMiss, type CruxMissKind, type CruxSummarizer, type NodeCrux, type NodeRef } from "../ai/crux.js";
import { LlmFailureGate } from "../ai/failure.js";
import type { Crux, NodeV1 } from "./types.js";

/** Cap on the stored crux: an over-long pick is trimmed to its leading slice. */
const MAX_CRUX_LINES = 12;

/** Files summarized at once. Each is an independent LLM call; order is preserved. */
const DEFAULT_CONCURRENCY = 5;

export interface EnrichOptions {
  /** When present, (re)compute meaning for stale/pending nodes. Absent → cache only. */
  summarizer?: CruxSummarizer;
  /** Max files summarized in parallel (each is one LLM call). Default {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
  /** Progress is reported per file (one LLM call each), as files finish — not per node. */
  onProgress?: (info: { index: number; total: number; node: string }) => void;
  /**
   * Durability flush of the (partially) enriched graph, called from the per-file
   * completion handler at most once every {@link CHECKPOINT_MS}. Without it, crux
   * only reached wiring.json at build end, so an interrupted --deep run discarded
   * every crux it had already computed and paid for (#128). Single-threaded, so it
   * never interleaves with a node mutation.
   */
  checkpoint?: () => void;
}

/** How often the crux pass flushes partial progress to disk. Read at call time (not
 * module load) so a test seam `GRAFT_CRUX_CHECKPOINT_MS=0` (flush on every completed
 * file) takes effect. */
function checkpointMs(): number {
  return Number(process.env.GRAFT_CRUX_CHECKPOINT_MS ?? 15000);
}

export interface EnrichStats {
  cached: number; // carried over from a prior identical body
  computed: number; // freshly summarized by the LLM this run
  stale: number; // body changed, left with an outdated summary (no LLM this run)
  pending: number; // never summarized and not computed this run
  errors: string[];
  /** Files whose LLM call failed outright. The count `errors` used to only imply —
   * a caller has to be able to decide "this build is degraded" without parsing
   * message strings (#127). */
  failedFiles: number;
  /** Files never attempted, because {@link EnrichStats.fatal} stopped the pass. */
  skippedFiles: number;
  /** Set when the pass gave up early: quota/auth rejection, or a run of
   * provider failures. Content-quality misses (#235) count in `failedFiles` but
   * do not set this. The reason is what `graft build --deep` exits non-zero with. */
  fatal?: string;
}

/** Where the meaning pass gets a file's text. `Map<string, string>` satisfies it,
 * which is what tests pass; `buildGraph` passes a lazy, hash-checked reader so a
 * 65k-file build does not hold every source for a pass that touches a handful. */
export interface SourceLookup {
  has(path: string): boolean;
  get(path: string): string | undefined;
}

export async function enrichGraph(
  nodes: NodeV1[],
  prior: Map<string, NodeV1>,
  sources: SourceLookup,
  opts: EnrichOptions = {},
): Promise<EnrichStats> {
  const stats: EnrichStats = {
    cached: 0,
    computed: 0,
    stale: 0,
    pending: 0,
    errors: [],
    failedFiles: 0,
    skippedFiles: 0,
  };

  // Which nodes actually need an LLM call this run (after cache carry-over).
  const dirty: NodeV1[] = [];

  for (const node of nodes) {
    const was = prior.get(node.id);
    if (was?.summary_state === "ready" && was.body_hash === node.body_hash) {
      node.summary = was.summary;
      node.crux = was.crux;
      node.summary_state = "ready";
      stats.cached++;
      continue;
    }
    // needs computing; seed with the old summary as a stale hint when one exists.
    if (was && was.summary) {
      node.summary = was.summary;
      node.crux = was.crux;
      node.summary_state = "stale";
    }
    dirty.push(node);
  }

  if (!opts.summarizer) {
    for (const node of dirty) {
      if (node.summary_state === "stale") stats.stale++;
      else stats.pending++;
    }
    return stats;
  }

  // One LLM call per file: group the dirty nodes by the file they live in.
  const byFile = new Map<string, NodeV1[]>();
  for (const node of dirty) {
    if (!sources.has(node.path)) continue;
    const arr = byFile.get(node.path);
    if (arr) arr.push(node);
    else byFile.set(node.path, [node]);
  }

  // Each file is an independent LLM call, so run several in flight at once —
  // the slow part is the round-trip, not local work. Files never share state:
  // one file's nodes and source stand alone, so parallelism can't corrupt the
  // per-file line numbers the crux slicing depends on. `stats` mutation is safe
  // because JS is single-threaded — increments run between awaits, never during.
  const summarizer = opts.summarizer;
  const files = [...byFile.keys()];
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  let done = 0;
  const flushEvery = checkpointMs();
  let lastCheckpoint = Date.now();

  // Shared with the concept pass (`context/build.ts`), so both agree on when a
  // provider has stopped working. Counted across the whole pass, not per worker:
  // with `-j 5` the interleaving is what a user sees as "everything is failing now".
  const gate = new LlmFailureGate();

  await mapWithConcurrency(files, limit, async (path) => {
    const fileNodes = byFile.get(path)!;

    // Once the pass is fatal, the remaining files are not attempted: every call
    // would fail the same way, and on a metered gateway each one still costs a
    // request. They are counted so the caller can report what was left undone.
    // Checked before `sources.get`, which reads and hashes the file from disk.
    if (gate.stopped) {
      gate.skip();
      for (const node of fileNodes) {
        if (node.summary_state === "stale") stats.stale++;
        else stats.pending++;
      }
      // Still reported, so the caller's progress counter reaches `total` instead of
      // freezing at the file that broke — the abort is announced by the build's
      // summary, not by a stalled line.
      opts.onProgress?.({ index: done++, total: files.length, node: path });
      return;
    }

    const source = sources.get(path);
    if (source === undefined) {
      // The file changed or vanished between parse and summary: a crux sliced
      // against different bytes would point at the wrong lines. Leave the nodes
      // pending; the next build re-hashes and settles them. Unlike the fatal-abort
      // branch above, this is not a provider failure, so it does not call gate.skip().
      for (const node of fileNodes) {
        if (node.summary_state === "stale") stats.stale++;
        else stats.pending++;
      }
      opts.onProgress?.({ index: done++, total: files.length, node: path });
      return;
    }
    const lineCount = source.split("\n").length;

    const refs: NodeRef[] = fileNodes.map((n) => {
      const [startLine, endLine] = spanLines(n.span, lineCount);
      return { id: n.id, kind: n.kind, signature: n.signature, startLine, endLine };
    });

    const { results, error, quality } = await collectFileCrux(summarizer, path, source, refs);
    let fileError = error;
    if (fileError) {
      stats.errors.push(`${path}: ${fileError}`);
      gate.record(fileError, { quality });
    }

    let applied = 0;
    for (const node of fileNodes) {
      const r = results.size > 0 ? results.get(node.id) : undefined;
      // Empty / whitespace-only summaries are not success: caching them as
      // `ready` made the next `--deep` a permanent cache hit (#172).
      if (!r || !r.summary.trim()) {
        // whole-file call failed, the model skipped this symbol, or it returned
        // an empty summary: keep what it had and leave it retryable.
        if (node.summary_state === "stale") stats.stale++;
        else stats.pending++;
        continue;
      }
      node.summary = r.summary;
      node.crux = buildCrux(r, node, source, lineCount);
      node.summary_state = "ready";
      stats.computed++;
      applied++;
    }

    if (!fileError && refs.length > 0 && applied === 0) {
      // collectFileCrux already labels a total miss; this catches "got entries
      // but every summary was blank" so the CLI's #127 degraded-exit path fires.
      fileError = cruxMissMessage(summarizer, "empty-parsed");
      stats.errors.push(`${path}: ${fileError}`);
      gate.record(fileError, { quality: true });
    } else if (!fileError) {
      gate.succeeded();
    }

    // Report on completion so the counter climbs monotonically under concurrency.
    opts.onProgress?.({ index: done++, total: files.length, node: path });

    // Flush partial crux to disk periodically, so a killed --deep run keeps what it
    // has already computed (#128). Throttled by wall-clock; the caller's checkpoint
    // writes wiring.json atomically, and the next run folds it back in by body_hash.
    if (opts.checkpoint && Date.now() - lastCheckpoint >= flushEvery) {
      lastCheckpoint = Date.now();
      opts.checkpoint();
    }
  });

  stats.failedFiles = gate.failed;
  stats.skippedFiles = gate.skipped;
  stats.fatal = gate.fatal;
  return stats;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving result order. */
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

function cruxMissMessage(summarizer: CruxSummarizer, fallback: CruxMissKind): string {
  const miss = summarizer.lastMiss;
  return formatCruxMiss(miss?.kind ?? fallback, miss?.finishReason ?? null);
}

/**
 * Describe every requested definition in a file, re-asking for any the model
 * omits (it sometimes drops entries from a batch). Returns whatever it collected
 * plus the last error, if any — partial results are kept, not discarded.
 */
async function collectFileCrux(
  summarizer: CruxSummarizer,
  path: string,
  source: string,
  refs: NodeRef[],
): Promise<{ results: Map<string, NodeCrux>; error?: string; quality?: boolean }> {
  const results = new Map<string, NodeCrux>();
  let missing = refs;
  let error: string | undefined;
  for (let attempt = 0; attempt < 2 && missing.length > 0; attempt++) {
    try {
      const list = await summarizer.describeFile({ path, source, nodes: missing });
      for (const r of list) if (!results.has(r.id)) results.set(r.id, r);
      missing = refs.filter((r) => !results.has(r.id));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      break;
    }
  }
  // A total miss used to return `{ results: ∅ }` with no error — enrich left
  // every node `pending`, the CLI exited 0, and `graft check` told the user to
  // re-run `--deep` forever (#172). Surface it as a failure like a thrown error.
  // Content-quality, not quota: count the file, keep going (#235).
  if (!error && refs.length > 0 && results.size === 0) {
    return { results, error: cruxMissMessage(summarizer, "empty-toolCalls"), quality: true };
  }
  return { results, error };
}

/**
 * Cut the crux text verbatim from the file using the model's file-absolute line
 * range, clamped to the node's own span. Returns null when the model reported no
 * distinct crux (0/0) or gave an unusable range.
 */
function buildCrux(r: NodeCrux, node: NodeV1, source: string, lineCount: number): Crux | null {
  // 0/0 (or an invalid range) is the model saying "nothing to highlight here".
  if (r.crux_start < 1 || r.crux_end < r.crux_start) return null;
  const [nodeStart, nodeEnd] = spanLines(node.span, lineCount);
  const start = Math.max(nodeStart, Math.min(r.crux_start, nodeEnd));
  let end = Math.max(start, Math.min(r.crux_end, nodeEnd));

  // Keep the crux readable: if the model pointed at a big region, store its
  // leading slice (the anchor it chose) rather than the whole blob — still the
  // most important part, and the full definition is reachable via node.span.
  if (end - start + 1 > MAX_CRUX_LINES) end = start + MAX_CRUX_LINES - 1;

  const code = source.split("\n").slice(start - 1, end).join("\n");
  if (!code.trim()) return null;
  return { code, span: `L${start}-L${end}` };
}

/** Parse a `"L12-L30"` span into a clamped [start, end] line pair (1-based). */
function spanLines(span: string, fileLines: number): [number, number] {
  const m = /^L(\d+)-L(\d+)$/.exec(span);
  if (!m) return [1, fileLines];
  const start = Math.max(1, Math.min(Number(m[1]), fileLines));
  const end = Math.max(start, Math.min(Number(m[2]), fileLines));
  return [start, end];
}
