/**
 * Serialize a {@link GraphV1} to `<contextDir>/.graph/wiring.json`.
 *
 * The wiring graph lives in a hidden `.graph/` subdir because it is machine-only:
 * the agent never greps or reads it — it reaches the wiring data through the
 * per-file markdown cards (grep) and the `ask` tool (edge traversal). Output is
 * sorted (nodes by id, edges by source/relation/target) and carries no
 * timestamps, so rebuilding an unchanged repo produces a byte-identical file and
 * git diffs stay minimal.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EdgeV1, GraphV1, NodeV1 } from "./types.js";

/** Hidden subdir under the context dir that holds machine-only graph artifacts. */
export const GRAPH_DIR = ".graph";
export const GRAPH_FILE = "wiring.json";

/** Absolute path to the wiring graph for a context dir: `<dir>/.graph/wiring.json`. */
export function wiringPath(outDir: string): string {
  return join(outDir, GRAPH_DIR, GRAPH_FILE);
}

/**
 * Read an existing wiring graph for use as the Tier-2 cache. Returns null when the
 * file is absent or unparseable (a fresh build, or a corrupt file we'll replace).
 */
export function readGraph(path: string): GraphV1 | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as GraphV1;
  } catch {
    return null;
  }
}

/**
 * JSON text with every non-ASCII character as a `\uXXXX` escape; JSON.parse reads
 * back the same values. One non-ASCII character anywhere makes V8 hold a whole file,
 * read back, as a two-byte string: on assign, ~100 MB more for each process that
 * reads its 94 MB graph (every query, hook and build), and ~300 MB for the build's
 * extract cache.
 */
export function asciiJson(json: string): string {
  return json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function writeGraph(graph: GraphV1, outDir: string): string {
  const sorted: GraphV1 = {
    ...graph,
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(stripBodyText),
    edges: [...graph.edges].sort(edgeOrder),
  };
  const path = wiringPath(outDir);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write (temp + rename): the crux pass now checkpoints wiring.json
  // periodically (#128), and a --deep run is exactly what gets killed mid-flush
  // (SIGTERM/CI timeout/laptop sleep). A partial writeFileSync would leave a
  // truncated, unparseable graph; rename swaps it in atomically on the same fs.
  //
  // pid in the temp name, and removed when the write fails — the same discipline
  // `writeJsonAtomic` (util/state.ts) documents: a fixed name lets a concurrent
  // build (a manual `graft build` racing the refresh child) write the same scratch
  // file and hand the loser a corrupt graph, and a failed rename would otherwise
  // leave a full-size orphan behind that nothing ever cleans up.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, asciiJson(JSON.stringify(sorted, null, 2)) + "\n");
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing more we can do */
    }
    throw e;
  }
  return path;
}

/**
 * Drop `body_text` from the SERIALIZED copy of a node — it is ~65% of
 * wiring.json's bytes on a large graph, and every byte of it is already
 * duplicated in the `ask` sidecar (`.cache/ask-index.json`), tokenized, which
 * is the only place anything reads it from. Callers must pass this the
 * in-memory graph BEFORE this stripped copy is produced (see `build.ts`:
 * `writeAskIndex` runs on the original `graph` object, never on a re-read of
 * this slimmed file) — this function never mutates the input node.
 */
function stripBodyText(node: NodeV1): NodeV1 {
  if (node.body_text === undefined) return node;
  const { body_text: _body_text, ...rest } = node;
  return rest as NodeV1;
}

function edgeOrder(a: EdgeV1, b: EdgeV1): number {
  return (
    a.source.localeCompare(b.source) ||
    a.relation.localeCompare(b.relation) ||
    a.target.localeCompare(b.target)
  );
}
