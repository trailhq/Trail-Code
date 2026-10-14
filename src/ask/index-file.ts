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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphV1 } from "../graph/types.js";
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
 * exact cache of the live path.
 *
 * Unicode-aware (#432): splitting on `[^a-z0-9]+` treated every non-ASCII
 * character as a separator, so Cyrillic, Greek, Arabic, Hebrew, Hindi and CJK
 * text tokenized to nothing and non-Latin queries silently returned zero hits.
 * The separator is now "any run of non-letter/non-number" — combining marks
 * (`\p{M}`) stay inside words so Devanagari, Hebrew niqqud and similar scripts
 * survive whole, while `_` separates exactly as before. `toLowerCase()` is
 * already Unicode-aware, and deliberately locale-independent (a locale-aware
 * fold — e.g. Turkish dotless i — would corrupt the index for other users).
 *
 * CJK scripts add character bigrams on top of the word token: they have no
 * word separators, so a whole phrase arrives as one token and a shorter query
 * phrase would never match it. Bigram overlap makes "中文检索" find a card
 * that says "中文检索系统". */
const WORD_SEPARATOR = /[^\p{L}\p{N}\p{M}]+/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu;

const cjkBigrams = (word: string): string[] => {
  const bigrams: string[] = [];
  for (const match of word.matchAll(CJK_RUN)) {
    const run = match[0];
    for (let i = 0; i + 1 < run.length; i += 1) bigrams.push(run.slice(i, i + 2));
  }
  return bigrams;
};

export function tokenize(text: string): string[] {
  const withCamelBreaks = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2"); // camelCase → camel Case
  const words = withCamelBreaks
    .toLowerCase()
    .split(WORD_SEPARATOR)
    .filter((t) => t.length > 1 && !STOP.has(t));
  const tokens: string[] = [];
  for (const word of words) {
    tokens.push(word);
    for (const bigram of cjkBigrams(word)) {
      // A two-character word's only bigram is the word itself; the word token
      // already covers it, so skip instead of emitting a duplicate.
      if (bigram !== word) tokens.push(bigram);
    }
  }
  return tokens;
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
  /** Tokenizer shape generation: 2 = Unicode-aware tokens + CJK bigrams (#432).
   * Bumped from 1 so pre-#432 sidecars read as unknown and fall back to live
   * tokenization instead of serving ASCII-only bags forever. */
  version: 2;
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

  const index: AskIndex = {
    version: 2,
    avgBodyLen,
    df: pairs(df),
    docCount: nodes.length,
    docs,
  };

  const outPath = askIndexPath(outDir);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(index) + "\n");
  return outPath;
}

/** Read the ask sidecar. Returns null on a missing file, unparseable JSON, an
 * unrecognized shape, an unknown `version`, or a `docCount` that doesn't match
 * the number of docs actually stored (a corrupted/truncated sidecar would
 * otherwise silently skew IDF) — any of which means the caller should fall
 * back to live tokenization, never crash or trust bad data. */
export function readAskIndex(outDir: string): AskIndex | null {
  const path = askIndexPath(outDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (
      !raw ||
      typeof raw !== "object" ||
      raw.version !== 2 ||
      typeof raw.docCount !== "number" ||
      typeof raw.avgBodyLen !== "number" ||
      !Array.isArray(raw.df) ||
      !Array.isArray(raw.docs) ||
      raw.docCount !== raw.docs.length
    ) {
      return null;
    }
    return raw as AskIndex;
  } catch {
    return null;
  }
}
