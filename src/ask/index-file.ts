/**
 * Build-time sidecar for `graft ask` — `<outDir>/.cache/ask-index.json`.
 *
 * `ask`'s lexical pass tokenizes every symbol node's name/path/body on every
 * query; at 32k nodes that re-tokenization is ~45% of query time (profiled).
 * `graft build` writes this sidecar once, with the token→count bags per node
 * plus the corpus-wide document frequencies, so a query just reads counts
 * instead of re-splitting every node's text. It's a derived cache, not
 * checked-in graph data, so it lives under the gitignored `.cache/` dir
 * (see `CACHE_DIR` in `context/node-file.ts`) rather than `.graph/`.
 *
 * `tokenize`/`counts` live here (not duplicated in `ask.ts`) so build-time and
 * query-time text-splitting are provably the same function — the sidecar can
 * only be a correct cache of `ask.ts`'s own math if both sides call the same
 * code. `ask.ts` imports both back from here.
 *
 * Concept (markdown) docs are NOT part of this sidecar — there are only dozens
 * of them, they're still tokenized live at query time, and their doc-frequency
 * contribution is folded into the stored `df` at query time (see `ask.ts`),
 * which is why `df` here counts symbol/file nodes only.
 */
import { constants as bufferConstants } from "node:buffer";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GraphV1 } from "../graph/types.js";
import { forEachFileLine, forEachLine, openAtomic, type LineWalker } from "../util/json-stream.js";
import { CACHE_DIR } from "../context/node-file.js";

/** Words too common/short to carry query intent — dropped before scoring. */
const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "is", "are", "how", "does", "do", "what",
  "where", "which", "that", "this", "it", "for", "on", "and", "or", "with",
  "i", "we", "get", "set", "use", "used", "using", "when", "why", "can",
]);

/** Split prose + identifiers into lowercased subword tokens (camelCase, snake, kebab).
 * The single source of truth for tokenization — shared by build-time indexing
 * (this file) and query-time fallback (`ask.ts`) so the sidecar is a provably
 * exact cache of the live path. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Term-frequency count map. */
export function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** One node's token bags, JSON-friendly (`Map` → sorted `[token, count][]`). */
export interface AskIndexDoc {
  id: string;
  name: [string, number][];
  path: [string, number][];
  body: [string, number][];
}

/** The build-time sidecar. `df`/`docCount` cover symbol+file nodes only (no
 * concepts — see module docstring); `avgBodyLen` is the BM25 corpus average. */
export interface AskIndex {
  version: 1;
  avgBodyLen: number;
  df: [string, number][];
  docCount: number;
  docs: AskIndexDoc[];
}

export const ASK_INDEX_FILE = "ask-index.json";

/** Absolute path to the ask sidecar for a context dir: `<dir>/.cache/ask-index.json`.
 * `.cache/` is the established uncommitted-cache location — this sidecar is a
 * derived, regenerate-anytime cache, not checked-in graph data. */
export function askIndexPath(outDir: string): string {
  return join(outDir, CACHE_DIR, ASK_INDEX_FILE);
}

function pairs(m: Map<string, number>): [string, number][] {
  return [...m.entries()];
}

/** Sum of a token→count bag's counts (a document's field length). */
function bagLen(p: [string, number][]): number {
  let s = 0;
  for (const [, c] of p) s += c;
  return s;
}

/**
 * Tokenize every node in `graph` (exactly as `ask.ts`'s lexical pass does) and
 * write the resulting bags + document frequencies to
 * `<outDir>/.cache/ask-index.json`. Returns the path written. Deterministic:
 * nodes are indexed in id order, so an unchanged graph produces a
 * byte-identical sidecar.
 */
export function writeAskIndex(outDir: string, graph: GraphV1): string {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const docs: AskIndexDoc[] = [];
  const df = new Map<string, number>();

  for (const n of nodes) {
    const name = counts(tokenize(n.name));
    const path = counts(tokenize(n.path));
    const body = counts(
      tokenize(`${n.signature ?? ""} ${n.summary ?? ""} ${n.body_text ?? ""}`),
    );
    docs.push({ id: n.id, name: pairs(name), path: pairs(path), body: pairs(body) });

    const bag = new Set<string>([...name.keys(), ...path.keys(), ...body.keys()]);
    for (const t of bag) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const avgBodyLen = docs.length
    ? docs.reduce((a, d) => a + bagLen(d.body), 0) / docs.length
    : 0;

  const outPath = askIndexPath(outDir);
  // Streamed one doc per line: still valid JSON for JSON.parse readers, but the
  // newline at each doc boundary lets readAskIndexFromBuffer walk a file over
  // V8's string cap without ever holding it as one string. On a 65k-file repo
  // the one-shot string measured ~590 MB, over the ~512 MB cap. Key
  // order matches AskIndex (version, avgBodyLen, df, docCount, docs).
  const w = openAtomic(outPath);
  try {
    // The header is one line, and the whole `df` array lives on it — the streaming
    // reader walks a line at a time, so this single line must itself fit under
    // buffer.constants.MAX_STRING_LENGTH (~512 MB). df is the corpus vocabulary
    // (one entry per distinct token, not per node), so even at 65k files it is a
    // few MB — far off the ceiling. Only the per-line docs below scale with nodes.
    w.write(`{"version":1,"avgBodyLen":${JSON.stringify(avgBodyLen)},"df":${JSON.stringify(pairs(df))},"docCount":${nodes.length},"docs":[`);
    docs.forEach((doc, i) => w.write("\n" + JSON.stringify(doc) + (i < docs.length - 1 ? "," : "")));
    w.write("\n]}\n");
    w.commit();
  } catch (e) {
    w.abort();
    throw e;
  }
  return outPath;
}

export interface ReadAskIndexOptions { maxStringLength?: number }

/** Validate the shape of a parsed sidecar. Returns null on an unrecognized shape,
 * an unknown `version`, or a `docCount` that doesn't match the number of docs
 * actually stored (a corrupted/truncated sidecar would otherwise silently skew
 * IDF). Runs on the result of both the JSON.parse and the streamed read path. */
function validateAskIndex(raw: unknown): AskIndex | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    r.version !== 1 ||
    typeof r.docCount !== "number" ||
    typeof r.avgBodyLen !== "number" ||
    !Array.isArray(r.df) ||
    !Array.isArray(r.docs) ||
    r.docCount !== r.docs.length
  ) {
    return null;
  }
  return raw as AskIndex;
}

/** Read the ask sidecar. Returns null on a missing file, unparseable JSON, or a
 * shape {@link validateAskIndex} rejects — any of which means the caller should
 * fall back to live tokenization, never crash or trust bad data. A file over
 * V8's string cap is walked line by line ({@link readAskIndexFromBuffer});
 * `opts.maxStringLength` lets a test force that path. */
export function readAskIndex(outDir: string, opts: ReadAskIndexOptions = {}): AskIndex | null {
  const path = askIndexPath(outDir);
  let size: number;
  try { size = statSync(path).size; } catch { return null; }
  const cap = opts.maxStringLength ?? bufferConstants.MAX_STRING_LENGTH;
  if (size > cap) {
    // Chunked: past 2 GiB the file is too large for one Buffer, let alone a string.
    try { return readAskIndexFromLines((fn) => forEachFileLine(path, fn)); } catch { return null; }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return validateAskIndex(raw);
}

/** Parse the line-per-doc shape `writeAskIndex` produces without ever holding
 * the whole file as one string. Null when the buffer is not in that shape or
 * fails {@link validateAskIndex}. */
export function readAskIndexFromBuffer(buf: Buffer): AskIndex | null {
  return readAskIndexFromLines((fn) => forEachLine(buf, fn));
}

function readAskIndexFromLines(eachLine: LineWalker): AskIndex | null {
  const DOCS_OPEN = ',"docs":[';
  const END = "]}";
  let head: Record<string, unknown> | null = null;
  const docs: AskIndexDoc[] = [];
  let closed = false;
  let bad = false;
  eachLine((line, i) => {
    if (bad || closed) { if (line !== "") bad = true; return; }
    try {
      if (i === 0) {
        if (!line.startsWith("{") || !line.endsWith(DOCS_OPEN)) { bad = true; return; }
        head = JSON.parse(line.slice(0, -DOCS_OPEN.length) + "}") as Record<string, unknown>;
        return;
      }
      if (line === END) { closed = true; return; }
      const body = line.endsWith(",") ? line.slice(0, -1) : line;
      docs.push(JSON.parse(body) as AskIndexDoc);
    } catch {
      bad = true;
    }
  });
  if (bad || !closed || head === null) return null;
  return validateAskIndex({ ...(head as Record<string, unknown>), docs });
}
