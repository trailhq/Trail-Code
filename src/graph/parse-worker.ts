/**
 * Worker-thread parse unit for `buildGraph`'s extraction phase.
 *
 * The Tier-1 parse loop is CPU-bound tree-sitter work, so it moves to a small
 * pool of worker threads; this module is the worker half (`parse-pool.ts` is
 * the parent half). Each worker receives one strided partition of the cache-miss
 * files, warms the WASM grammars its partition needs once, then parses files
 * strictly sequentially — results stream back one message per file so the
 * parent can fill per-index slots and report monotonic progress.
 *
 * Determinism contract: the parent merges results by file order, never by
 * completion order, so node/edge/entry output is byte-identical to the old
 * single-threaded loop (the invariant `test/graph-incremental.test.ts` pins).
 */
import { parentPort } from "node:worker_threads";
import { readSourceFile } from "../util/source.js";
import { contentHash } from "../util/id.js";
import { extractFile, type Language, type RawEdge } from "./extract.js";
import { extractGeneric, warmGenericGrammars, type GenericLang } from "./generic.js";
import { extractContainer, warmContainerGrammars, type ContainerLang } from "./container.js";
import type { NodeV1 } from "./types.js";

export interface ParseJob {
  /** Index into the build's file list — the parent merges by this, never by arrival. */
  index: number;
  /** Repo-relative path, as the extractors and entries key it. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  tier: "file" | "container" | "generic";
  /** Depth tier: the `Language` id (a plain string). */
  lang?: Language;
  /** Container tier: the registry row (plain data — clones over postMessage). */
  container?: ContainerLang;
  /** Breadth tier: the `GenericLang` registry row. */
  generic?: GenericLang;
}

export interface ParseOutcome {
  status: "ok" | "parse-error" | "unreadable" | "encoding-skip";
  /** sha256 of the file's bytes, for the extract-cache entry. Empty on unreadable. */
  hash: string;
  nodes: NodeV1[];
  rawEdges: RawEdge[];
  /** Fully formatted error line, ready for `errors[]`. Parse/read failures only. */
  error?: string;
}

/** Languages this worker has already warmed (per-worker memo; grammars are not
 * shared across threads, each worker pays its own load once). */
const warmedGeneric = new Set<string>();
const warmedContainers = new Set<string>();

async function ensureWarmed(jobs: ParseJob[]): Promise<void> {
  const generics = new Set<string>();
  const containers = new Set<string>();
  for (const j of jobs) {
    if (j.tier === "generic" && j.generic && !warmedGeneric.has(j.generic.name)) generics.add(j.generic.name);
    if (j.tier === "container" && j.container && !warmedContainers.has(j.container.name)) containers.add(j.container.name);
  }
  const warming: Promise<void>[] = [];
  if (generics.size > 0) warming.push(warmGenericGrammars(generics).then(() => { for (const g of generics) warmedGeneric.add(g); }));
  if (containers.size > 0) warming.push(warmContainerGrammars(containers).then(() => { for (const c of containers) warmedContainers.add(c); }));
  await Promise.all(warming);
}

function parseOne(job: ParseJob): ParseOutcome {
  let source: string | null;
  try {
    source = readSourceFile(job.abs);
  } catch (err) {
    return {
      status: "unreadable",
      hash: "",
      nodes: [],
      rawEdges: [],
      error: `${job.rel}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (source === null) {
    return { status: "encoding-skip", hash: "", nodes: [], rawEdges: [] };
  }
  const hash = contentHash(source);
  try {
    const { nodes, rawEdges } =
      job.tier === "file" && job.lang !== undefined
        ? extractFile(job.rel, source, job.lang)
        : job.tier === "container" && job.container !== undefined
          ? extractContainer(job.rel, source, job.container)
          : extractGeneric(job.rel, source, job.generic!.name);
    return { status: "ok", hash, nodes, rawEdges };
  } catch (err) {
    return {
      status: "parse-error",
      hash,
      nodes: [],
      rawEdges: [],
      error: `${job.rel}: parse failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const port = parentPort;
if (!port) {
  throw new Error("parse-worker.ts started outside a worker thread");
}
port.on("message", async (msg: { type: string; jobs?: ParseJob[] }) => {
  if (msg.type !== "parse" || !msg.jobs) return;
  await ensureWarmed(msg.jobs);
  for (const job of msg.jobs) {
    port.postMessage({ type: "result", index: job.index, rel: job.rel, outcome: parseOne(job) });
  }
  port.postMessage({ type: "done" });
});
