/**
 * `graft ask "<task>"` — the ACTIVE channel.
 *
 * One tool that routes a plain-words query to the right graph and returns a lean,
 * ranked context pack (prose + exact `file:line` + related), never raw JSON and
 * never whole files:
 *
 *   - Structural intent ("what calls X", "callers of X", "what does X import")
 *     → walk the wiring graph's edges and return the neighbour symbols with spans.
 *   - Everything else → lexical rank over concept nodes (prose) and wiring symbols
 *     (name + signature + summary), returning the best few with pointers.
 *
 * v1 is deterministic and $0 (term-overlap scoring, no LLM, no embeddings). The
 * output is markdown so it drops straight into an agent's context.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import { contextDirFor } from "../context/node-file.js";
import { withSavings, savingsFor, savingsTurnNudge, type Savings } from "../context/savings.js";
import { loadGraphCached, loadAskIndexCached } from "../graph/load.js";
import {
  assertPrefixIndexed,
  pathUnderPrefix,
  scopeLabel,
  scopeOf,
  scopesHereClause,
  scopesOfGraph,
} from "../graph/scopes.js";
import { normalizePathPrefix } from "../util/paths.js";
import { resolveSymbol } from "../graph/traverse.js";
import type { EdgeV1, GraphV1, NodeV1, Relation } from "../graph/types.js";
import {
  combineComparableScopes,
  rankScopesAndFuse,
  type ScopeRankCandidate,
} from "./fuse.js";
import {
  rankFilesBounded,
  type FileRankCandidate,
  type RankedFile,
} from "./file-rank.js";
import { fileFirstRoundRobin, roundRobinQueues } from "./file-selection.js";
import {
  personalizedPageRank,
  personalizedPageRankPrepared,
  preparePageRankPartitions,
} from "./graphrank.js";
import { readSourceFile } from "../util/source.js";
import { counts, tokenize, type AskIndex, type AskIndexDoc } from "./index-file.js";
import { rulesForPointers, formatRules, type AppliedRule } from "../brain/attach.js";
import { readLink, readRulesCache } from "../brain/link.js";

export interface AskHit {
  kind: "concept" | "symbol" | "caller" | "callee";
  title: string;
  /** A `file` or `file:Lx-Ly` pointer the agent can open directly. */
  pointer: string;
  snippet: string;
  relation?: Relation;
  related?: string[];
  score: number;
  /** The actual source at `pointer`, sliced from disk when `source` is on.
   * This is what makes `ask` substitutive — the agent reads the span here
   * instead of opening the file, so no source read happens on top of the query. */
  code?: string;
  /** Multi-scope repos only: the ranking scope (path prefix, "" = root) this
   * hit was ranked within — answers "which sub-project is this from?". Drives
   * the `[scope/] ` label in formatAsk. Absent on single-scope repos. */
  scope?: string;
}

/** Internal file-aware ranking group. The first hit is the one document that
 * participates in a higher-level ranker; the remaining hits are projected only
 * after every ranked group has emitted its leader. */
export interface AskRankingGroup {
  key: string;
  hits: AskHit[];
  /** Exact baseline-scored members of this group, in baseline order. Populated
   * only in opt-in metadata so a workspace top lock never reuses a pooled
   * leader score for a secondary span. */
  baselineHits?: AskHit[];
  coverage: number;
  coverageStrong: number;
}

/** Internal metadata used by workspace federation to fuse file documents
 * before projecting symbol spans. It is opt-in and never appears in normal
 * CLI/API results. */
export interface AskRankingMetadata {
  groups: AskRankingGroup[];
  baseline: Array<{ group: string; hit: AskHit }>;
  baselineCoverage?: number;
  baselineCoverageStrong?: number;
}

/** Max source lines to inline per hit — a definition longer than this is
 * truncated with a marker, so one giant function can't blow up the pack. */
const MAX_SPAN_LINES = 80;

export interface AskResult {
  query: string;
  mode: "structural" | "lexical" | "empty";
  /** For structural mode: the symbol whose neighbours we walked. */
  subject?: string;
  /** Authoritative result order. Lexical results preserve each hit's raw
   * relevance score, but select distinct-file leaders before sibling spans, so
   * callers must not re-sort this list by `score`. */
  hits: AskHit[];
  note?: string;
  /** Token-saving estimate, set only in `--source` (retriever) mode: the whole
   * size of the distinct files these hits point into, i.e. the baseline cost of
   * reading them instead of this pack. Computed from file sizes stored at build. */
  saved?: { files: number; baselineChars: number };
  /** Lexical mode only: share (0..1) of the query's distinct terms the TOP hit
   * matched. A relevance signal for callers that inject packs unprompted (the
   * Claude prompt hook): a low share means the query's words barely overlap the
   * best result, i.e. the pack is probably noise for this prompt. Absent in
   * structural mode — a resolved "who calls X" is itself the relevance signal. */
  coverage?: number;
  /** Like {@link coverage}, but the top hit's idf-weighted matched share over
   * its NAME + PATH fields ONLY (body excluded) — a match-STRENGTH signal:
   * "did the query hit a high-value field, or only incidental body tokens?".
   * A body-only collision (a variable that happens to share a query word) has
   * `coverageStrong === 0` while `coverage` can still look respectable. Used by
   * workspace federation to gate a weak child out of the cross-repo ranking.
   * Absent in structural mode; same lexical-only contract as `coverage`. */
  coverageStrong?: number;
  /** Multi-scope lexical results only: which scopes federated into the fused
   * ranking, plus scopes that matched too weakly to federate (with their best
   * doc id). Drives formatAsk's `matched in:` / `also matched:` footer.
   * Absent on single-scope repos — zero output change there. */
  scopes?: { federated: string[]; alsoMatched: { scope: string; bestId: string }[] };
  /** @internal Opt-in latent file groups plus the exact pre-file-ranking list. */
  ranking?: AskRankingMetadata;
  /** Rules from the attached Trail brain that govern the symbols in `hits`.
   * Absent when the repo has no brain linked, or when none of its rules touch
   * this answer. Populated in `--source` mode only, alongside `saved`: a pack
   * the agent does not read the code from has nothing for a rule to sit beside. */
  rules?: AppliedRule[];
}

/** First real prose line of a node body (skips headings, markers, blanks). */
function firstProse(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("<!--") || line.startsWith("-")) continue;
    return line;
  }
  return "";
}

interface Corpus {
  concepts: Array<{ slug: string; name: string; sources: string[]; related: string[]; snippet: string; text: string }>;
  graph: GraphV1 | null;
  /** Build-time token/df sidecar (`.cache/ask-index.json`), or null when absent,
   * unparseable, an unknown version, or stale (checked against `graph.nodes.length`
   * by the caller — see `lexical()`). Null means: fall back to live tokenization. */
  askIndex: AskIndex | null;
}

function loadCorpus(outDir: string): Corpus {
  const concepts: Corpus["concepts"] = [];
  if (existsSync(outDir)) {
    for (const entry of readdirSync(outDir)) {
      if (!entry.endsWith(".md") || entry === "INDEX.md") continue;
      const parsed = matter(readFileSync(join(outDir, entry), "utf8"));
      const fm = parsed.data as Record<string, unknown>;
      const sources = Array.isArray(fm.sources)
        ? (fm.sources as Array<{ path: string }>).map((s) => s.path)
        : [];
      const related = Array.isArray(fm.links)
        ? (fm.links as Array<{ to: string }>).map((l) => l.to)
        : [];
      const snippet = firstProse(parsed.content);
      concepts.push({
        slug: String(fm.slug ?? entry.replace(/\.md$/, "")),
        name: String(fm.name ?? ""),
        sources,
        related,
        snippet,
        text: `${fm.name ?? ""} ${snippet} ${sources.join(" ")}`,
      });
    }
  }
  return { concepts, graph: loadGraphCached(outDir), askIndex: loadAskIndexCached(outDir) };
}

/** Score a document's token counts against the query counts (name field
 * pre-weighted by caller). Each shared term is weighted by its inverse document
 * frequency (`idf`), so a word that appears in many nodes — "overlay" across a
 * whole widget subsystem, or a repeated word in a pasted issue body — counts for
 * far less than a rare, discriminating identifier ("scrolling"). Without idf,
 * pure term-frequency lets an incidental common word dominate the ranking; this
 * is the lexical half of the keyword-collision fix (graph-rank is the other). */
/** Test files rarely answer "how does X work" / "where is Y" — they mirror the
 * real symbol's tokens, so a test can out-score the definition on a lexical tie
 * and land as the top hit (observed: an `ask` returning a `Test…` function first,
 * sending the agent to the wrong file). A multiplicative de-rank keeps tests in
 * the results (they still matter for "where are the tests") but below the real
 * definition. Covers Go (`_test.go`), JS/TS (`.test.` / `.spec.`), and test dirs. */
export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\/|(_test|\.test|\.spec)\.[a-z]+$|(^|\/)(test_[^/]+|conftest)\.py$/i.test(path || "");
}
const TEST_RANK_PENALTY = 0.35;

function score(
  query: Map<string, number>,
  doc: Map<string, number>,
  idf: Map<string, number>,
): number {
  let s = 0;
  for (const [t, qn] of query) {
    const dn = doc.get(t);
    if (dn) s += qn * dn * (idf.get(t) ?? 1);
  }
  return s;
}

/** Inverse document frequency over the scored corpus. `df` counts how many
 * documents (concept nodes + symbol nodes) contain each token; N is the corpus
 * size. `log(1 + N/(1+df))` is the smoothed standard form: monotonically
 * decreasing in df, always positive, ~0 extra weight for a token in every doc. */
function idfFromDf(df: Map<string, number>, n: number): Map<string, number> {
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / (1 + d)));
  return idf;
}

function computeIdf(docBags: Array<Set<string>>): Map<string, number> {
  const df = new Map<string, number>();
  for (const bag of docBags)
    for (const t of bag) df.set(t, (df.get(t) ?? 0) + 1);
  return idfFromDf(df, docBags.length);
}

/** Same idf as {@link computeIdf}, but the symbol half of `df` and the doc
 * count come from the build-time sidecar instead of tokenizing the corpus
 * live; only the concept bags (always tokenized live — there are only dozens)
 * are folded in here, the same way `computeIdf` would fold them into the full
 * docBags array. `df` is a commutative sum and `n` is the same total document
 * count either way, so this produces byte-identical idf values to `computeIdf`
 * run over concept-bags + live-tokenized-symbol-bags. */
function computeIdfFromIndex(index: AskIndex, conceptBags: Array<Set<string>>): Map<string, number> {
  const df = new Map(index.df);
  for (const bag of conceptBags)
    for (const t of bag) df.set(t, (df.get(t) ?? 0) + 1);
  return idfFromDf(df, index.docCount + conceptBags.length);
}

/** BM25 term score for a document field, used for the (potentially large) body
 * field. Unlike raw term-frequency, BM25 saturates repeated occurrences (`k1`)
 * and normalizes by document length (`b`, against the corpus-average length
 * `avgdl`), so a big definition — a sprawling test class — can't outrank a
 * tight, on-point function merely by containing more words. Standard params. */
function bm25(
  query: Map<string, number>,
  doc: Map<string, number>,
  idf: Map<string, number>,
  dl: number,
  avgdl: number,
): number {
  const k1 = 1.2;
  const b = 0.75;
  const norm = k1 * (1 - b + (b * dl) / (avgdl || 1));
  let s = 0;
  for (const t of query.keys()) {
    const tf = doc.get(t);
    if (tf) s += (idf.get(t) ?? 1) * ((tf * (k1 + 1)) / (tf + norm));
  }
  return s;
}

/** Exact query terms awarded by the existing lexical fields. Bounded ranking uses
 * presence only: raw name/path/BM25 magnitudes cannot enter the file residual. */
function matchedLexicalTerms(
  query: Map<string, number>,
  name: Map<string, number>,
  path: Map<string, number>,
  body: Map<string, number>,
): Set<string> {
  const terms = new Set<string>();
  for (const term of query.keys())
    if (name.has(term) || path.has(term) || body.has(term)) terms.add(term);
  return terms;
}

/** NAME-only query terms behind file-level strong coverage. This intentionally
 * mirrors {@link strongShare}'s plural folding while excluding file nodes at
 * the call site. */
function matchedStrongTerms(
  query: Map<string, number>,
  name: Map<string, number>,
): Set<string> {
  const terms = new Set<string>();
  for (const term of query.keys()) if (hasTerm(name, term)) terms.add(term);
  return terms;
}

// ── Structural intent ──────────────────────────────────────────────────────

const INCOMING = /\b(caller|callers|calls?\s+into|who\s+calls|what\s+calls|called\s+by|used\s+by|uses)\b/;
const OUTGOING = /\b(callee|callees|what\s+does\s+\w+\s+call|calls\s+what|imports?|depends\s+on)\b/;
const INCOMING_RELS: Relation[] = ["calls", "references", "implements", "extends"];
const OUTGOING_RELS: Relation[] = ["calls", "references", "imports", "implements", "extends"];

/** Split a prose query into word-like tokens, keeping dots so a qualified name
 * ("Cache.get") or package-qualified name ("pkg.Fn") survives as one token —
 * `resolveSymbol`'s own suffix/last-segment matching handles the rest. */
function subjectWords(query: string): string[] {
  return [...new Set(query.split(/[^A-Za-z0-9_.]+/).filter(Boolean))];
}

/** Resolve the query's structural subject via {@link resolveSymbol}, trying
 * each word longest-first — the intended subject of a structural query is
 * usually the most specific (longest) identifier-shaped word, never a short
 * verb like "calls" — until one resolves. `tried` is the word that was tried
 * last regardless of outcome, so a caller can name *something* in a fallthrough
 * note even when nothing resolved (e.g. `subjects.length === 0`). This is what
 * makes a qualified/dotted subject like `Cache.get` resolve, where the old
 * plain name-equality lookup (`findSubject`) never matched it.
 *
 * `inPrefix`, when given, filters each word's `resolveSymbol` matches down to
 * nodes under that path prefix BEFORE checking whether any survived — same
 * "narrow the subject resolution" semantics `callers`/`callees`/`impact --in`
 * already have (segment-aware here, via `pathUnderPrefix`). A word that
 * resolves globally but has nothing under the prefix does NOT count as a
 * match; the next (shorter) word is tried instead, same as an unresolved word
 * today — and if nothing survives for ANY word, `subjects.length === 0`
 * naturally falls through to the existing loud fallthrough note. */
function findSubjectNodes(query: string, graph: GraphV1, inPrefix?: string): { nodes: NodeV1[]; tried: string } {
  const words = subjectWords(query).sort((a, b) => b.length - a.length);
  for (const w of words) {
    let nodes = resolveSymbol(graph, w);
    if (inPrefix) nodes = nodes.filter((n) => pathUnderPrefix(n.path, inPrefix));
    if (nodes.length > 0) return { nodes, tried: w };
  }
  return { nodes: [], tried: words[0] ?? query };
}

/** `structural()`'s result: either a genuine structural `AskResult`, a signal
 * to fall through to `lexical()` with a loud note prepended (subject resolved
 * to zero nodes, or resolved but the walk found zero edges — never a bare
 * empty structural result), or `null` when the query has no structural intent
 * at all (not a "who calls"/"what does X import" shape), in which case the
 * caller falls through to `lexical()` silently, same as before this fix. */
type StructuralOutcome = { result: AskResult } | { fallthroughNote: string } | null;

function fallthroughNoteFor(subject: string): string {
  return (
    `structural index: no entries for '${subject}' — showing lexical matches; ` +
    `for precise edges try graft callers '${subject}', or graft grep '${subject}' for every reference (loosen the pattern if it returns nothing)`
  );
}

function structural(query: string, graph: GraphV1, limit: number, inPrefix?: string): StructuralOutcome {
  const wantsIn = INCOMING.test(query);
  const wantsOut = OUTGOING.test(query);
  if (!wantsIn && !wantsOut) return null;

  const { nodes: subjects, tried } = findSubjectNodes(query, graph, inPrefix);
  if (subjects.length === 0) return { fallthroughNote: fallthroughNoteFor(tried) };

  const ids = new Set(subjects.map((n) => n.id));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outgoing = wantsOut && !wantsIn; // "what does X call / import" — else default to callers
  const rels = new Set(outgoing ? OUTGOING_RELS : INCOMING_RELS);

  const hits: AskHit[] = [];
  const seen = new Set<string>();
  for (const e of graph.edges as EdgeV1[]) {
    if (!rels.has(e.relation)) continue;
    const anchor = outgoing ? e.source : e.target;
    const other = outgoing ? e.target : e.source;
    if (!ids.has(anchor) || seen.has(other + e.relation)) continue;
    seen.add(other + e.relation);
    const node = byId.get(other);
    hits.push({
      kind: outgoing ? "callee" : "caller",
      title: node ? node.name : other, // unresolved import target → raw module string
      pointer: node ? `${node.path}:${node.span}` : other,
      snippet: node?.summary?.split("\n")[0].trim() ?? node?.signature ?? "",
      relation: e.relation,
      score: 1,
    });
  }

  // Subject resolved but the graph has no indexed edges for it — same "loud,
  // never a bare empty" contract as `graft callers`/`callees` — fall through
  // to lexical rather than returning a structural result with zero hits.
  if (hits.length === 0) return { fallthroughNote: fallthroughNoteFor(subjects[0].name) };

  hits.sort((a, b) => a.pointer.localeCompare(b.pointer));
  return {
    result: {
      query,
      mode: "structural",
      subject: subjects[0].name,
      hits: hits.slice(0, limit),
      note: outgoing
        ? `outgoing edges from ${subjects[0].name}`
        : `callers / references of ${subjects[0].name}`,
    },
  };
}

// ── Lexical rank ─────────────────────────────────────────────────────────────

/** How much a node's graph-centrality (0..1) can lift its blended score. A
 * lexically-perfect node scores 1.0 on the lexical axis; a graph weight of 0.5
 * lets connectivity reorder near-ties and separate a connected hit from an
 * isolated same-word collision, without letting structure override a clear
 * lexical winner. */
const GRAPH_WEIGHT = 0.5;

/** A node the query never word-matched is pulled into the results only if the
 * walk gives it at least this share of the top node's mass — i.e. it is
 * genuinely central to the matched cluster, not incidentally reachable. This is
 * what surfaces the config/helper a task depends on but didn't name. */
const RESCUE_FLOOR = 0.15;

/** Term presence with plural folding — "packs" finds "pack" and vice versa, so
 * a natural-language plural doesn't read as a miss against identifier tokens. */
function hasTerm(f: Map<string, number>, t: string): boolean {
  return f.has(t) || f.has(`${t}s`) || (t.endsWith("s") && f.has(t.slice(0, -1)));
}

/** Idf-weighted share (0..1) of the query a document matches: each query term
 * counts by its rarity, so this separates task prompts from chatter in a way a
 * raw term count can't. A conversational prompt's words are either off-corpus
 * (rare → heavy, unmatched → sinks the ratio) or generic code words ("list",
 * "write": common → near-weightless even when they collide with a symbol name);
 * a task prompt matches exactly its rare, discriminating identifiers. Terms the
 * corpus has never seen take `dfltIdf` (the df=0 weight). */
/** The match-STRENGTH share behind `coverageStrong`: idf-weighted share of the
 * query matched in the node's NAME field ONLY. The PATH field is deliberately
 * excluded — a coincidental generic directory (`gateway/`) or file basename
 * (`gateway.ts`) in an unrelated repo would otherwise clear the strength gate
 * and float that repo to the top; an on-topic path-organized repo is still
 * rescued by the broad-coverage HIGH_FLOOR clause instead. For the same reason
 * a `kind:"file"` node contributes zero strength: its `name` is a basename (a
 * path component), not a symbol name, so a file whose basename happens to share
 * a query word is not a strong match. */
export function strongShare(
  q: Map<string, number>,
  node: NodeV1,
  doc: { name: Map<string, number> },
  idf: Map<string, number>,
  dfltIdf: number,
): number {
  if (node.kind === "file") return 0;
  return matchedIdfShare(q, [doc.name], idf, dfltIdf);
}

function matchedIdfShare(
  q: Map<string, number>,
  fields: Array<Map<string, number>>,
  idf: Map<string, number>,
  dfltIdf: number,
): number {
  let matched = 0;
  let total = 0;
  for (const t of q.keys()) {
    const w = idf.get(t) ?? dfltIdf;
    total += w;
    if (fields.some((f) => hasTerm(f, t))) matched += w;
  }
  return total > 0 ? matched / total : 0;
}

/** Normalized query-term IDF mass used by file-level union coverage. Presence
 * comes from the exact term-contribution maps, so plural folding cannot
 * manufacture evidence that the lexical scorer did not award. */
function normalizedQueryWeights(
  q: Map<string, number>,
  idf: Map<string, number>,
  dfltIdf: number,
): Map<string, number> {
  let total = 0;
  for (const t of q.keys()) total += idf.get(t) ?? dfltIdf;
  if (total <= 0) return new Map();

  return new Map(
    [...q.keys()].map((term) => [term, (idf.get(term) ?? dfltIdf) / total]),
  );
}

function lexical(
  query: string,
  corpus: Corpus,
  limit: number,
  graphRank: boolean,
  inPrefix?: string,
  fileFirst = true,
  fileComplement = false,
  fileTopLock = false,
  includeRankingMetadata = false,
): AskResult {
  // Binary query terms: a word repeated in a pasted issue body counts once, so a
  // ranty description can't linearly amplify an incidental word.
  const q = new Map([...counts(tokenize(query)).keys()].map((t) => [t, 1]));
  const graph = corpus.graph;

  // Test-file de-ranking is query-aware: a query that ASKS about tests wants test
  // files on top, so it gets no penalty; every other query wants the real
  // definition first. This stops a test that merely contains the query's literals
  // (e.g. `TestDownloadStall` matching "download stall") from outranking the
  // source it exercises — the "tests ranked above the actual code" trap.
  const wantsTests = /\b(tests?|specs?|coverage|assert(?:ion)?s?|fixtures?|mocks?)\b/i.test(query);
  const testFactor = (path: string): number => (!wantsTests && isTestPath(path) ? TEST_RANK_PENALTY : 1);

  // ── Pass 1: tokenize every scored field once, and collect per-document token
  // bags so IDF can down-weight words that occur across the whole corpus. `--in`
  // drops a concept unless at least one of its sources falls under the prefix —
  // filtering happens here, before any scoring, so a narrowed query never sees
  // an unrelated concept from outside the prefix. ──
  const conceptDocs = corpus.concepts
    .filter((c) => !inPrefix || c.sources.some((p) => pathUnderPrefix(p, inPrefix)))
    .map((c) => ({
      c,
      name: counts(tokenize(c.name)),
      body: counts(tokenize(c.text)),
    }));

  // A build-time sidecar (`.cache/ask-index.json`) is usable only when it covers
  // every node in the current graph: `docs.length === graph.nodes.length` is a
  // cheap staleness guard (an id-level check below catches a same-count but
  // mismatched set, e.g. a hand-edited or corrupt sidecar). Anything short of
  // that — missing, unparseable, unknown version, wrong count, mismatched ids —
  // falls back to live tokenization so results never depend on the sidecar
  // existing; see `readAskIndex`'s own null-on-anything-off contract.
  //
  // `--in` does NOT disable the sidecar here: `writeGraph` strips `body_text`
  // from every node it serializes (see `write.ts`) — the sidecar's per-doc
  // `docs[].body` bags are the ONLY place a symbol's body tokens survive on a
  // graph loaded from disk. Bypassing the sidecar under `--in` would silently
  // empty out `body` for every node (falling back to `n.body_text ?? ""`,
  // always `""` post-slim-serialization), losing every body-only match under
  // the filtered prefix. What DOES need bypassing under `--in` is the
  // sidecar's GLOBAL `df`/`docCount`/`avgBodyLen` — those cover the whole
  // corpus, not the filtered subset — so each read of those three fields below
  // is separately gated on `!inPrefix`, while the per-doc bags (used to build
  // `symbolDocs` right after this) are used unconditionally.
  let docById: Map<string, AskIndexDoc> | null = null;
  if (corpus.askIndex && graph && corpus.askIndex.docs.length === graph.nodes.length) {
    const map = new Map(corpus.askIndex.docs.map((d) => [d.id, d]));
    if (graph.nodes.every((n) => map.has(n.id))) docById = map;
  }
  const askIndex = docById ? corpus.askIndex : null;

  // Symbols AND file nodes are scored: a symbol's body_text is its definition;
  // a file's body_text is the module-level residual (imports/constants not in
  // any symbol). Including files closes the recall gap where a gold file's only
  // query-relevant text lives outside every function/class. `--in` filters the
  // node set here, at the very top, before any scoring — every downstream stat
  // (idf, avgdl, candidates, the per-scope partition below) then naturally
  // reflects only the filtered set with no other code needing to know about it.
  const graphNodes = inPrefix ? (graph?.nodes ?? []).filter((n) => pathUnderPrefix(n.path, inPrefix)) : (graph?.nodes ?? []);
  const symbolDocs = graphNodes.map((n) => {
    const d = docById?.get(n.id);
    if (d) return { n, name: new Map(d.name), path: new Map(d.path), body: new Map(d.body) };
    return {
      n,
      name: counts(tokenize(n.name)),
      path: counts(tokenize(n.path)),
      // The body (indexed at build) joins the signature + summary as the low-weight
      // body field, so a term that appears only in the code — not the name/signature
      // — still makes the node findable. IDF (from these same bags) keeps a word
      // common across many bodies from dominating. `body_text` is absent on every
      // node loaded from a wiring.json written after the slim-serialization change
      // (it's stripped there — see `write.ts`) as well as on file nodes and
      // pre-body_text graphs; `?? ""` degrades gracefully to signature+summary
      // only, it never crashes on the missing field.
      body: counts(tokenize(`${n.signature ?? ""} ${n.summary ?? ""} ${n.body_text ?? ""}`)),
    };
  });

  const conceptBags = conceptDocs.map((d) => new Set([...d.name.keys(), ...d.body.keys()]));
  // IDF must see the SAME inputs either way: with a sidecar, its `df` (stored
  // WITHOUT concepts) plus these live concept bags reproduces exactly what
  // `computeIdf` below would compute from concept+symbol bags tokenized live.
  // `askIndex.df` is a corpus-GLOBAL count, so `--in` can't use it — the
  // filtered doc set needs its own idf, computed from (already-filtered)
  // `symbolDocs`' own bags, regardless of where those bags came from.
  const idf = askIndex && !inPrefix
    ? computeIdfFromIndex(askIndex, conceptBags)
    : computeIdf([...conceptBags, ...symbolDocs.map((d) => new Set([...d.name.keys(), ...d.path.keys(), ...d.body.keys()]))]);

  // Per-hit idf-weighted coverage, kept out of the public AskHit shape; only
  // the top hit's value survives, as `coverage` on the result. The df=0 weight
  // mirrors idfFromDf's formula at df=0 for whichever corpus size idf was
  // computed from. Same `--in` reasoning as `idf` above: `askIndex.docCount`
  // is global.
  const nDocs = askIndex && !inPrefix
    ? askIndex.docCount + conceptBags.length
    : conceptBags.length + symbolDocs.length;
  const dfltIdf = Math.log(1 + nDocs);
  const matchedOf = new Map<AskHit, number>();
  // Parallel to matchedOf, but over NAME+PATH only (body dropped) — the
  // match-strength signal exported as `coverageStrong`.
  const matchedStrongOf = new Map<AskHit, number>();
  // Final listwise selection groups code hits by exact source path. Concepts
  // use singleton pseudo-groups so they remain ordinary ranked candidates
  // without masquerading as every file listed in their sources.
  const selectionGroupOf = new Map<AskHit, string>();

  // ── Concepts (prose nodes; not in the wiring graph) ──
  const conceptHits: AskHit[] = [];
  let maxConcept = 0;
  for (const { c, name, body } of conceptDocs) {
    const total = score(q, name, idf) * 3 + score(q, body, idf);
    if (total > 0) {
      maxConcept = Math.max(maxConcept, total);
      const hit: AskHit = {
        kind: "concept",
        title: c.name || c.slug,
        pointer: c.sources.join(", ") || c.slug,
        snippet: c.snippet,
        related: c.related,
        score: total,
      };
      matchedOf.set(hit, matchedIdfShare(q, [name, body], idf, dfltIdf));
      matchedStrongOf.set(hit, matchedIdfShare(q, [name], idf, dfltIdf)); // concepts have no path field
      // A concept is one singleton partition even if two source entries reuse
      // the same slug; include its stable encounter index to prevent accidental
      // grouping by frontmatter alone.
      selectionGroupOf.set(hit, `concept:${c.slug}:${conceptHits.length}`);
      conceptHits.push(hit);
    }
  }

  // ── Symbols (wiring graph): lexical score per node, keyed by id ──
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  const bodyLen = (m: Map<string, number>) => {
    let s = 0;
    for (const v of m.values()) s += v;
    return s;
  };
  const docsById = new Map(symbolDocs.map((d) => [d.n.id, d]));
  const symbolHits: AskHit[] = [];
  const baselineSymbolHits: AskHit[] = [];
  const baselineHitById = new Map<string, AskHit>();
  const fileQueueHitsByGroup = new Map<string, () => AskHit[]>();
  const baselineQueueHitsByGroup = new Map<string, () => AskHit[]>();
  const fileGroups: AskRankingGroup[] = [];
  const needsFileQueues = fileComplement && (fileTopLock || includeRankingMetadata);
  const makeSymbolHit = (id: string, hitScore: number, scope?: string): AskHit | null => {
    const n = byId.get(id);
    if (!n) return null;
    const hit: AskHit = {
      kind: "symbol",
      title: `${n.name} · ${n.kind}`,
      pointer: n.kind === "file" ? n.path : `${n.path}:${n.span}`,
      snippet: n.summary?.split("\n")[0].trim() ?? n.signature ?? "",
      score: hitScore,
      ...(scope === undefined ? {} : { scope }),
    };
    const d = docsById.get(id);
    matchedOf.set(
      hit,
      d ? matchedIdfShare(q, [d.name, d.path, d.body], idf, dfltIdf) : 0,
    );
    matchedStrongOf.set(hit, d ? strongShare(q, n, d, idf, dfltIdf) : 0);
    selectionGroupOf.set(hit, `file:${n.path}`);
    return hit;
  };
  const symbolTitle = (id: string): string => {
    const n = byId.get(id);
    return n ? `${n.name} · ${n.kind}` : id;
  };
  // The single-vs-multi-scope branch keys on `scopesOfGraph` ONLY: one scope
  // (or no graph) keeps the original local scoring path.
  const scopes = graph ? scopesOfGraph(graph) : null;
  let scopeMeta: AskResult["scopes"];
  // The BM25 length prior, corpus-global like `idf`/`dfltIdf` above. Hoisted out
  // of the single-scope branch so BOTH paths score against the same statistics
  // — that shared basis is half of what makes multi-scope scores comparable
  // (see fuse.ts's module header). Under `--in`, the sidecar's `avgBodyLen`
  // covers the whole corpus and must not be reused for the filtered set.
  const avgBodyLen = askIndex && !inPrefix
    ? askIndex.avgBodyLen
    : symbolDocs.length
      ? symbolDocs.reduce((a, d) => a + bodyLen(d.body), 0) / symbolDocs.length
      : 0;
  // Populated only for bounded file ranking. The baseline path pays no allocation
  // or matched-term tracking cost, and their scalar lexical path remains exact.
  const rawLexicalById = new Map<string, number>();
  const matchedTermsById = new Map<string, Set<string>>();
  const matchedStrongTermsById = new Map<string, Set<string>>();
  const fileQueryWeights = fileComplement
    ? normalizedQueryWeights(q, idf, dfltIdf)
    : new Map<string, number>();
  const spanStart = (span: string): number => {
    const match = span.match(/^L(\d+)-L\d+$/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  };
  if (scopes && scopes.length > 1) {
    // ── Multi-scope repo: partition by sub-project and walk each subgraph
    // separately — so the big scope can't drown the small one — but score every
    // scope against the repo-wide statistics, so the results stay comparable and
    // can be ordered by score. Same scoring functions and blend as the
    // single-scope path; the combination itself lives in fuse.ts. ──
    const byScope = new Map<string, typeof symbolDocs>();
    const scopeById = new Map<string, string>();
    for (const d of symbolDocs) {
      const s = scopeOf(d.n.path, scopes).prefix;
      scopeById.set(d.n.id, s);
      const list = byScope.get(s);
      if (list) list.push(d);
      else byScope.set(s, [d]);
    }
    // Lazily build every scope's PageRank topology in one node/edge pass. The
    // old nodeFilter path rebuilt the full repo adjacency once per matching
    // scope; on large multi-project repos that turned one query into hundreds
    // of full graph scans before the participation gate could run. Waiting for
    // the first walk keeps no-match and graphRank:false queries edge-scan free.
    let pageRankByScope: ReturnType<typeof preparePageRankPartitions> | undefined;
    let collapsedComponents: ScopeRankCandidate[] = [];
    let collapsedComponentById: Map<string, ScopeRankCandidate> | undefined;
    let collapsedFileByRepresentative: Map<string, RankedFile> | undefined;
    const fusion = rankScopesAndFuse(
      [...byScope.keys()].sort(),
      {
        lex: (s) => {
          const docs = byScope.get(s)!;
          // Repo-wide IDF and length prior — the SAME `idf`/`avgBodyLen` the
          // single-scope path uses. Scoring each scope against its own corpus
          // (as this did before #117) made a term worth a different amount in
          // every scope, so the resulting scores could not be compared and the
          // combined order had to fall back on rank. Only the PARTITION is
          // per-scope now; the statistics are global.
          const out = new Map<string, number>();
          for (const { n, name, path, body } of docs) {
            const factor = testFactor(n.path);
            const total =
              (score(q, name, idf) * 3 +
                score(q, path, idf) * 2 +
                bm25(q, body, idf, bodyLen(body), avgBodyLen)) *
              factor;
            if (total > 0) {
              out.set(n.id, total);
              if (fileComplement) {
                rawLexicalById.set(n.id, total);
                matchedTermsById.set(
                  n.id,
                  matchedLexicalTerms(q, name, path, body),
                );
                if (n.kind !== "file")
                  matchedStrongTermsById.set(n.id, matchedStrongTerms(q, name));
              }
            }
          }
          return out;
        },
        // Body-only suppression: does any doc in this scope carry a query term
        // in an identifier (name) or its path, rather than only in prose?
        hasIdentifierMatch: (s) =>
          (byScope.get(s) ?? []).some(({ name, path }) => {
            for (const t of q.keys()) if (hasTerm(name, t) || hasTerm(path, t)) return true;
            return false;
          }),
        walk: (s, seeds) => {
          if (!graphRank) return new Map<string, number>();
          pageRankByScope ??= preparePageRankPartitions(graph!, (id) => scopeById.get(id));
          const topology = pageRankByScope?.get(s);
          return topology
            ? personalizedPageRankPrepared(topology, seeds)
            : new Map<string, number>();
        },
        rankFactor: (_s, id) => testFactor(byId.get(id)?.path ?? ""),
        collapseCandidates: fileComplement
          ? (candidates) => {
              collapsedComponents = [...candidates];
              collapsedComponentById = new Map(
                candidates.map((candidate) => [candidate.id, candidate]),
              );
              const fileCandidates: FileRankCandidate[] = candidates.map((candidate) => {
                const n = byId.get(candidate.id);
                const rawLexical = rawLexicalById.get(candidate.id) ?? 0;
                return {
                  id: candidate.id,
                  file: n?.path ?? "",
                  kind: n?.kind === "file" ? "file" : "symbol",
                  rawLexical,
                  lexical: candidate.lexical,
                  graph: candidate.graph,
                  rankFactor: candidate.rankFactor,
                  baselineScore: candidate.score,
                  baselineTieKey: symbolTitle(candidate.id),
                  matchedTerms: matchedTermsById.get(candidate.id) ?? new Set<string>(),
                  matchedStrongTerms:
                    matchedStrongTermsById.get(candidate.id) ?? new Set<string>(),
                  eligible: Boolean(n && n.kind !== "file" && rawLexical > 0),
                  spanStart: n ? spanStart(n.span) : undefined,
                };
              });
              const rankedFiles = rankFilesBounded(
                fileCandidates,
                fileQueryWeights,
              );
              collapsedFileByRepresentative = new Map(
                rankedFiles.map((file) => [file.representative.id, file]),
              );
              return rankedFiles.map((file) => {
                const component = collapsedComponentById!.get(file.representative.id)!;
                return {
                  id: file.representative.id,
                  scope: component.scope,
                  score: file.score,
                };
              });
            }
          : undefined,
      },
      GRAPH_WEIGHT,
      RESCUE_FLOOR,
    );
    if (needsFileQueues) {
      const baselineFusion = combineComparableScopes(
        collapsedComponents.map(({ id, scope, score }) => ({ id, scope, score })),
      );
      const baselineScoreById = new Map(
        baselineFusion.ranked.map((ranked) => [ranked.id, ranked.score]),
      );
      const baselineDisplayOrder = (
        a: { id: string; score: number },
        b: { id: string; score: number },
      ): number =>
        b.score - a.score || symbolTitle(a.id).localeCompare(symbolTitle(b.id));
      let baselineTopRanked = baselineFusion.ranked[0];
      for (const ranked of baselineFusion.ranked.slice(1))
        if (baselineTopRanked && baselineDisplayOrder(ranked, baselineTopRanked) < 0)
          baselineTopRanked = ranked;
      const baselineHitsToBuild = includeRankingMetadata
        ? [...baselineFusion.ranked].sort(baselineDisplayOrder)
        : baselineTopRanked
          ? [baselineTopRanked]
          : [];
      for (const ranked of baselineHitsToBuild) {
        const hit = makeSymbolHit(ranked.id, ranked.score, ranked.scope);
        if (hit) {
          baselineSymbolHits.push(hit);
          baselineHitById.set(ranked.id, hit);
        }
      }
      for (const ranked of fusion.ranked) {
        const file = collapsedFileByRepresentative?.get(ranked.id);
        if (!file) continue;
        const materializeFileQueue = (): AskHit[] => file.queue.flatMap((member, index) => {
          const component = collapsedComponentById?.get(member.id);
          if (index > 0) {
            const baselineHit = baselineHitById.get(member.id);
            if (baselineHit) return [baselineHit];
          }
          const hit = makeSymbolHit(
            member.id,
            index === 0
              ? ranked.score
              : baselineScoreById.get(member.id) ?? member.baselineScore,
            component?.scope ?? ranked.scope,
          );
          return hit ? [hit] : [];
        });
        const materializeBaselineQueue = (): AskHit[] => file.queue.flatMap((member) => {
          const hit = makeSymbolHit(
            member.id,
            baselineScoreById.get(member.id) ?? member.baselineScore,
            collapsedComponentById?.get(member.id)?.scope ?? ranked.scope,
          );
          return hit ? [hit] : [];
        });
        const hits = includeRankingMetadata
          ? materializeFileQueue()
          : (() => {
              const leader = file.queue[0];
              if (!leader) return [];
              const hit = makeSymbolHit(
                leader.id,
                ranked.score,
                collapsedComponentById?.get(leader.id)?.scope ?? ranked.scope,
              );
              return hit ? [hit] : [];
            })();
        if (hits.length === 0) continue;
        const group: AskRankingGroup = {
          key: `file:${file.file}`,
          hits,
          coverage: file.unionCoverage,
          coverageStrong: file.unionStrongCoverage,
        };
        fileQueueHitsByGroup.set(group.key, materializeFileQueue);
        baselineQueueHitsByGroup.set(group.key, materializeBaselineQueue);
        fileGroups.push(group);
        symbolHits.push(hits[0]);
      }
    } else {
      for (const ranked of fusion.ranked) {
        const hit = makeSymbolHit(ranked.id, ranked.score, ranked.scope);
        if (hit) symbolHits.push(hit);
      }
    }
    // Label + footer only when federation actually happened (or a scope was
    // gated out and is worth mentioning) — a query matching one scope of a
    // multi-scope repo reads exactly like today.
    if (fusion.federated.length > 1 || fusion.alsoMatched.length > 0)
      scopeMeta = { federated: fusion.federated, alsoMatched: fusion.alsoMatched };
  } else {
  // Single-scope: the pre-scopes ranking path, byte-identical output when
  // `--in` is absent (Task 3's regression guarantee: `askIndex && !inPrefix`
  // reduces to plain `askIndex` when `inPrefix` is undefined). `avgBodyLen` is
  // now defined once above and shared with the multi-scope branch.
  const lex = new Map<string, number>(); // node id → lexical score (>0 only)
  let maxLex = 0;
  for (const { n, name, path, body } of symbolDocs) {
    // Name and path are short identifiers → plain idf-weighted overlap; the body
    // is length-normalized via BM25 so long definitions don't win on bulk.
    const factor = testFactor(n.path);
    const total =
      (score(q, name, idf) * 3 +
        score(q, path, idf) * 2 +
        bm25(q, body, idf, bodyLen(body), avgBodyLen)) *
      factor;
    if (total > 0) {
      lex.set(n.id, total);
      maxLex = Math.max(maxLex, total);
      if (fileComplement) {
        rawLexicalById.set(n.id, total);
        matchedTermsById.set(
          n.id,
          matchedLexicalTerms(q, name, path, body),
        );
        if (n.kind !== "file")
          matchedStrongTermsById.set(n.id, matchedStrongTerms(q, name));
      }
    }
  }

  // ── Graph-rank: let connectivity to the matched set reorder and rescue ──
  // `--in` restricts the walk itself, not just the seeds: without a nodeFilter
  // here, a RESCUE_FLOOR-qualifying neighbour OUTSIDE the prefix could still
  // surface, defeating the "filters before scoring" contract.
  const pr = graphRank && graph && lex.size > 0
    ? personalizedPageRank(graph, lex, inPrefix ? { nodeFilter: (id) => pathUnderPrefix(byId.get(id)?.path ?? "", inPrefix) } : {})
    : new Map<string, number>();

  // Candidate symbols = everything the query word-matched, plus nodes the walk
  // found strongly central even without a word match (RESCUE_FLOOR).
  const candidates = new Set<string>(lex.keys());
  for (const [id, p] of pr) if (p >= RESCUE_FLOOR) candidates.add(id);

  const singleCandidates: Array<{
    id: string;
    n: NodeV1;
    lexical: number;
    graph: number;
    rankFactor: number;
    baseline: number;
  }> = [];
  for (const id of candidates) {
    const n = byId.get(id);
    if (!n) continue;
    const lexical = maxLex > 0 ? (lex.get(id) ?? 0) / maxLex : 0;
    const graphScore = pr.get(id) ?? 0;
    const rankFactor = testFactor(n.path);
    // Apply the test penalty after normalization too. Applying it only to the
    // raw lexical score is not enough: if a test is still the strongest raw
    // match, dividing by maxLex restores it to 1.0 and erases the de-rank.
    const baseline = (lexical + GRAPH_WEIGHT * graphScore) * rankFactor;
    if (baseline <= 0) continue;
    singleCandidates.push({ id, n, lexical, graph: graphScore, rankFactor, baseline });
  }

  const candidateById = fileComplement
    ? new Map(singleCandidates.map((candidate) => [candidate.id, candidate]))
    : undefined;
  const rankedFiles = fileComplement
    ? rankFilesBounded(
        singleCandidates.map((candidate): FileRankCandidate => {
          const rawLexical = rawLexicalById.get(candidate.id) ?? 0;
          return {
            id: candidate.id,
            file: candidate.n.path,
            kind: candidate.n.kind === "file" ? "file" : "symbol",
            rawLexical,
            lexical: candidate.lexical,
            graph: candidate.graph,
            rankFactor: candidate.rankFactor,
            baselineScore: candidate.baseline,
            baselineTieKey: symbolTitle(candidate.id),
            matchedTerms: matchedTermsById.get(candidate.id) ?? new Set<string>(),
            matchedStrongTerms:
              matchedStrongTermsById.get(candidate.id) ?? new Set<string>(),
            eligible: candidate.n.kind !== "file" && rawLexical > 0,
            spanStart: spanStart(candidate.n.span),
          };
        }),
        fileQueryWeights,
      )
    : undefined;

  if (needsFileQueues && rankedFiles) {
    const baselineCandidateOrder = (
      a: (typeof singleCandidates)[number],
      b: (typeof singleCandidates)[number],
    ): number =>
      b.baseline - a.baseline ||
      `${a.n.name} · ${a.n.kind}`.localeCompare(`${b.n.name} · ${b.n.kind}`);
    let baselineTopCandidate = singleCandidates[0];
    for (const candidate of singleCandidates.slice(1))
      if (baselineTopCandidate && baselineCandidateOrder(candidate, baselineTopCandidate) < 0)
        baselineTopCandidate = candidate;
    const baselineCandidatesToBuild = includeRankingMetadata
      ? [...singleCandidates].sort(baselineCandidateOrder)
      : baselineTopCandidate
        ? [baselineTopCandidate]
        : [];
    for (const candidate of baselineCandidatesToBuild) {
      const hit = makeSymbolHit(candidate.id, candidate.baseline);
      if (hit) {
        baselineSymbolHits.push(hit);
        baselineHitById.set(candidate.id, hit);
      }
    }
    for (const file of rankedFiles) {
      const materializeFileQueue = (): AskHit[] => file.queue.flatMap((member, index) => {
        if (index > 0) {
          const baselineHit = baselineHitById.get(member.id);
          if (baselineHit) return [baselineHit];
        }
        const hit = makeSymbolHit(
          member.id,
          index === 0 ? file.score : member.baselineScore,
        );
        return hit ? [hit] : [];
      });
      const materializeBaselineQueue = (): AskHit[] => file.queue.flatMap((member) => {
        const hit = makeSymbolHit(member.id, member.baselineScore);
        return hit ? [hit] : [];
      });
      const hits = includeRankingMetadata
        ? materializeFileQueue()
        : (() => {
            const leader = file.queue[0];
            if (!leader) return [];
            const hit = makeSymbolHit(leader.id, file.score);
            return hit ? [hit] : [];
          })();
      if (hits.length === 0) continue;
      const group: AskRankingGroup = {
        key: `file:${file.file}`,
        hits,
        coverage: file.unionCoverage,
        coverageStrong: file.unionStrongCoverage,
      };
      fileQueueHitsByGroup.set(group.key, materializeFileQueue);
      baselineQueueHitsByGroup.set(group.key, materializeBaselineQueue);
      fileGroups.push(group);
      symbolHits.push(hits[0]);
    }
  } else if (rankedFiles) {
    for (const file of rankedFiles) {
      const candidate = candidateById?.get(file.representative.id);
      const hit = candidate ? makeSymbolHit(candidate.id, file.score) : null;
      if (hit) symbolHits.push(hit);
    }
  } else {
    for (const candidate of singleCandidates) {
      const hit = makeSymbolHit(candidate.id, candidate.baseline);
      if (hit) symbolHits.push(hit);
    }
  }
  }

  // Concepts and symbols live on comparable 0..~1.5 scales so they merge fairly:
  // concept scores are normalized to their own max; symbol scores use the
  // lexical-normalized + graph-weighted blend.
  for (const h of conceptHits) h.score = maxConcept > 0 ? h.score / maxConcept : 0;

  const scored = [...conceptHits, ...symbolHits];
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const baselineScored = needsFileQueues
    ? [...conceptHits, ...baselineSymbolHits].sort(
        (a, b) => b.score - a.score || a.title.localeCompare(b.title),
      )
    : scored;
  const conceptGroups: AskRankingGroup[] = conceptHits.map((hit, index) => ({
    key: selectionGroupOf.get(hit) ?? `concept:${index}`,
    hits: [hit],
    coverage: matchedOf.get(hit) ?? 0,
    coverageStrong: matchedStrongOf.get(hit) ?? 0,
  }));
  const unlockedGroups = [...conceptGroups, ...fileGroups].sort(
    (a, b) =>
      b.hits[0].score - a.hits[0].score ||
      a.hits[0].title.localeCompare(b.hits[0].title),
  );
  const sameHit = (a: AskHit, b: AskHit): boolean =>
    a.kind === b.kind && a.pointer === b.pointer && a.title === b.title;
  let projectedGroups = unlockedGroups;
  let lockedGroupKey: string | undefined;
  if (fileTopLock && fileFirst && baselineScored[0]) {
    const baselineTop = baselineScored[0];
    const key = selectionGroupOf.get(baselineTop) ?? "locked:top";
    lockedGroupKey = key;
    const existing = unlockedGroups.find((group) => group.key === key);
    const baselineQueue = includeRankingMetadata || limit > unlockedGroups.length
      ? baselineQueueHitsByGroup.get(key)?.() ?? baselineScored.filter(
          (hit) => (selectionGroupOf.get(hit) ?? "") === key,
        )
      : [];
    const locked: AskRankingGroup = existing
      ? {
          ...existing,
          hits: [
            baselineTop,
            ...baselineQueue.filter((hit) => !sameHit(hit, baselineTop)),
          ],
        }
      : {
          key,
          hits: baselineQueue.length ? baselineQueue : [baselineTop],
          coverage: matchedOf.get(baselineTop) ?? 0,
          coverageStrong: matchedStrongOf.get(baselineTop) ?? 0,
        };
    projectedGroups = [
      locked,
      ...unlockedGroups.filter((group) => group.key !== key),
    ];
  }

  // Ranking always sees the complete candidate universe, but a normal bounded
  // request usually needs only one leader per file. Materialize secondary span
  // queues only when the requested output can actually reach a second round.
  if (
    fileTopLock &&
    fileFirst &&
    !includeRankingMetadata &&
    limit > projectedGroups.length
  ) {
    projectedGroups = projectedGroups.map((group) => {
      if (group.key === lockedGroupKey) return group;
      const materialize = fileQueueHitsByGroup.get(group.key);
      return materialize ? { ...group, hits: materialize() } : group;
    });
  }

  // File-aware ranking feeds latent groups to the existing file-first frontier.
  // Leaders are listed first so every file/concept emits once before any
  // secondary span; each group's remaining queue retains baseline order.
  const selected = fileTopLock && fileFirst
    ? roundRobinQueues(projectedGroups.map((group) => group.hits), limit)
    : fileFirst
      ? fileFirstRoundRobin(
          scored.map((hit, index) => ({
            group: selectionGroupOf.get(hit) ?? `ungrouped:${index}`,
            value: hit,
          })),
          limit,
        )
      : scored;
  const top = selected[0] ?? scored[0];
  if (fileTopLock && top?.scope && scopeMeta) {
    scopeMeta = {
      federated: [...new Set([top.scope, ...scopeMeta.federated])],
      alsoMatched: scopeMeta.alsoMatched.filter((match) => match.scope !== top.scope),
    };
  }
  const ranking = includeRankingMetadata && needsFileQueues
    ? {
        groups: unlockedGroups.slice(0, limit).map((group) => ({
          ...group,
          hits: group.hits.slice(0, limit),
          baselineHits: baselineScored
            .filter((hit) => selectionGroupOf.get(hit) === group.key)
            .slice(0, limit),
        })),
        baseline: baselineScored.slice(0, limit).map((hit, index) => ({
          group: selectionGroupOf.get(hit) ?? `ungrouped:${index}`,
          hit,
        })),
        baselineCoverage: baselineScored[0]
          ? matchedOf.get(baselineScored[0]) ?? 0
          : undefined,
        baselineCoverageStrong: baselineScored[0]
          ? matchedStrongOf.get(baselineScored[0]) ?? 0
          : undefined,
      }
    : undefined;
  return {
    query,
    mode: scored.length ? "lexical" : "empty",
    hits: selected.slice(0, limit),
    scopes: scopeMeta,
    coverage: top && q.size > 0 ? matchedOf.get(top) ?? 0 : undefined,
    coverageStrong: top && q.size > 0 ? matchedStrongOf.get(top) ?? 0 : undefined,
    ...(ranking ? { ranking } : {}),
    // Zero hits on a genuinely multi-scope graph names the scopes that exist,
    // so a query that missed everywhere still tells the caller where to look.
    note: scored.length
      ? undefined
      : `no matching nodes — try different words, or \`graft build\` if graft/ is empty${scopesHereClause(scopes ?? [])}`,
  };
}

export interface AskOptions {
  contextDir?: string;
  limit?: number;
  /** Inline the source at each `path:Lx-Ly` hit, sliced from `dir`. Turns the
   * pack from a locator into a retriever so the agent needn't re-open the file. */
  source?: boolean;
  /** Re-rank lexical hits by graph connectivity (personalized PageRank over the
   * wiring edges), demoting same-word collisions and rescuing strongly-connected
   * neighbours the query didn't name. On by default; set false for pure lexical. */
  graphRank?: boolean;
  /** With `source`: inline each hit's WHOLE definition span (capped at
   * {@link MAX_SPAN_LINES}) instead of the default crux-first slice. The
   * default inlines the ≤8-line LLM-chosen crux when a node has one — the
   * decision point, ~10× cheaper than the full span — and the pack marks each
   * crux so the agent knows `--full` (or the file itself) has the rest. */
  full?: boolean;
  /** Narrow the doc/node set to this path prefix BEFORE scoring (segment-aware,
   * like `scopeOf` — "frontend" never matches "frontend-utils"). Per-scope
   * IDF/BM25/walk come free: the filtered set is usually one scope, so the
   * existing multi-scope machinery degrades to its single-scope passthrough
   * with no scope labels. A prefix matching nothing indexed throws. */
  in?: string;
  /** @internal Defer file-first projection to a downstream authoritative
   * ranking stage (currently workspace federation). Direct callers should
   * leave this unset. */
  fileFirst?: boolean;
  /** @internal Bounded file scoring control. */
  fileComplement?: boolean;
  /** @internal Exact baseline top-hit lock. Requires bounded file
   * scoring and composes it with the file-first frontier. */
  fileTopLock?: boolean;
  /** @internal Return latent file queues and the exact baseline list so a
   * workspace parent can fuse files before projecting spans. */
  includeRankingMetadata?: boolean;
}

/** Parse a `path:Lx-Ly` pointer into its parts, or null if it isn't one
 * (concept multi-path lists and raw import strings return null). */
function parseSpan(pointer: string): { path: string; from: number; to: number } | null {
  const m = pointer.match(/^(.*):L(\d+)-L(\d+)$/);
  if (!m) return null;
  return { path: m[1], from: Number(m[2]), to: Number(m[3]) };
}

/** Read the source lines [from, to] (1-indexed, inclusive) of `path` under `root`,
 * capped at {@link MAX_SPAN_LINES}. Returns null if the file can't be read. */
function sliceSpan(root: string, path: string, from: number, to: number): string | null {
  try {
    const source = readSourceFile(join(root, path));
    if (source === null) return null; // unsupported encoding (e.g. UTF-16BE)
    const lines = source.split("\n");
    const start = Math.max(1, from);
    const end = Math.min(lines.length, to);
    const slice = lines.slice(start - 1, end);
    if (slice.length > MAX_SPAN_LINES) {
      const head = slice.slice(0, MAX_SPAN_LINES);
      head.push(`… (+${slice.length - MAX_SPAN_LINES} more lines; open ${path}:L${start}-L${end})`);
      return head.join("\n");
    }
    return slice.join("\n");
  } catch {
    return null;
  }
}

/** Attach inlined source to every hit whose pointer is a real `path:span`.
 * Crux-first: when the graph carries an LLM-chosen crux for the hit's node and
 * `full` is off, inline that ≤8-line excerpt (with an escalation marker) rather
 * than the whole definition — most hits only need the decision point, and the
 * marker tells the agent exactly how to get the rest when this one doesn't. */
function inlineSource(root: string, hits: AskHit[], graph: GraphV1 | null, full: boolean): void {
  const cruxByPointer = new Map<string, string>();
  if (!full && graph) {
    for (const n of graph.nodes)
      if (n.crux?.code) cruxByPointer.set(`${n.path}:${n.span}`, n.crux.code);
  }
  for (const h of hits) {
    const s = parseSpan(h.pointer);
    if (!s) continue;
    const crux = cruxByPointer.get(h.pointer);
    if (crux) {
      h.code = `${crux}\n… (crux — full definition at ${h.pointer}; rerun with --full)`;
      continue;
    }
    const code = sliceSpan(root, s.path, s.from, s.to);
    if (code) h.code = code;
  }
}

/** Every repo-relative file path a set of hits points into (dedup). A symbol
 * pointer is `path:span`; a concept pointer is a comma-joined path list. */
function hitFiles(hits: AskHit[]): Set<string> {
  const files = new Set<string>();
  for (const h of hits) {
    const span = parseSpan(h.pointer);
    if (span) { files.add(span.path); continue; }
    for (const p of h.pointer.split(",").map((s) => s.trim()))
      if (p && !p.includes(" ")) files.add(p);
  }
  return files;
}

/** Baseline = whole size of the files these hits cover, read from the sizes the
 * build stored on each file node. Zero when the graph predates the `chars` field
 * (a pre-upgrade index) — the caller then just omits the estimate. */
function baselineFor(hits: AskHit[], graph: GraphV1 | null): AskResult["saved"] | undefined {
  if (!graph) return undefined;
  return savingsFor(graph, hitFiles(hits));
}

/** Answer a query from the graft/ graph at `dir`. Deterministic, $0. */
export function ask(dir: string, query: string, opts: AskOptions = {}): AskResult {
  const root = resolve(dir);
  const outDir = contextDirFor(root, opts.contextDir);
  const limit = opts.limit ?? 8;
  const corpus = loadCorpus(outDir);
  const graphRank = opts.graphRank ?? true;
  const fileFirst = opts.fileFirst ?? true;
  // The production path uses bounded file scoring plus an exact baseline top lock.
  // Internal/raw callers can still request the baseline by disabling
  // file-first selection. A top lock is projected only on a file-first list.
  const fileTopLock = opts.fileTopLock ?? fileFirst;
  const fileComplement = (opts.fileComplement ?? false) || fileTopLock;
  // Normalized ONCE, up front, and this value used everywhere below
  // (validation, filtering, structural). `ask --in frontend/` must work exactly
  // like `--in frontend` — `scopeLabel`/the footer's own `--in <scope>/`
  // suggestion always includes the slash, so rejecting it would make the tool's
  // own suggested next command fail — and `--in frontend\sub` must work too,
  // because that is what a Windows shell's tab-completion produces.
  const inPrefix = opts.in ? normalizePathPrefix(opts.in) : undefined;

  // `--in` validated up front, before any mode runs.
  if (inPrefix && corpus.graph) assertPrefixIndexed(corpus.graph, inPrefix);

  let result: AskResult;
  if (corpus.graph) {
    const outcome = structural(query, corpus.graph, limit, inPrefix);
    if (outcome && "result" in outcome) {
      result = outcome.result;
    } else {
      result = lexical(
        query,
        corpus,
        limit,
        graphRank,
        inPrefix,
        fileFirst,
        fileComplement,
        fileTopLock,
        opts.includeRankingMetadata ?? false,
      );
      // A structural-intent query that couldn't be answered structurally still
      // gets a prominent note on the lexical fallback result — never silent.
      if (outcome && "fallthroughNote" in outcome) {
        result.note = result.note ? `${outcome.fallthroughNote}\n${result.note}` : outcome.fallthroughNote;
      }
    }
  } else {
    result = lexical(
      query,
      corpus,
      limit,
      graphRank,
      inPrefix,
      fileFirst,
      fileComplement,
      fileTopLock,
      opts.includeRankingMetadata ?? false,
    );
  }
  if (opts.source) {
    inlineSource(root, result.hits, corpus.graph, opts.full ?? false);
    if (result.ranking) {
      const internalHits = [
        ...result.ranking.groups.flatMap((group) => group.hits),
        ...result.ranking.groups.flatMap((group) => group.baselineHits ?? []),
        ...result.ranking.baseline.map((entry) => entry.hit),
      ];
      inlineSource(
        root,
        [...new Set(internalHits)],
        corpus.graph,
        opts.full ?? false,
      );
    }
    // The pack is truly substitutive only in retriever mode (spans inlined), so
    // the "vs reading whole files" estimate is only honest here.
    result.saved = baselineFor(result.hits, corpus.graph);
    // What the team decided about the code this pack just inlined. Read from the
    // local cache only — `ask` is on the agent's hot path and must never wait on
    // the network; `graft trail pull` and `init` are what refresh it.
    const applied = attachBrainRules(root, result.hits, corpus.graph);
    if (applied.length) result.rules = applied;
  }
  return result;
}

/** Rules for this answer's symbols, or [] when the repo has no brain linked,
 * the cache is missing, or nothing overlaps. Never throws: a broken link must
 * degrade to the code-only answer graft gave before a brain existed. */
function attachBrainRules(root: string, hits: AskHit[], graph: GraphV1 | null): AppliedRule[] {
  try {
    if (!readLink(root)) return [];
    const cache = readRulesCache(root);
    if (!cache?.rules?.length) return [];
    return rulesForPointers(hits.map((h) => h.pointer), cache.rules, graph);
  } catch {
    return [];
  }
}

// ── Skeleton view ────────────────────────────────────────────────────────────

export interface SkeletonEntry {
  name: string;
  kind: string;
  span: string;
  signature: string | null;
  /** First line of the Tier-2 summary, when the node has one. */
  summary?: string;
}

export interface SkeletonResult {
  file: string;
  entries: SkeletonEntry[];
  note?: string;
  /** Tokens-saved baseline: this file read whole vs the signatures-only view. */
  saved?: Savings;
}

/** Signatures-only view of one file, straight from the wiring graph — the
 * cheapest way to understand a file's API surface (~10× less than reading it).
 * `file` is matched as an exact repo-relative path, then as a basename. */
export function skeleton(dir: string, file: string, opts: { contextDir?: string } = {}): SkeletonResult {
  const outDir = contextDirFor(resolve(dir), opts.contextDir);
  const graph = loadGraphCached(outDir);
  if (!graph) return { file, entries: [], note: "no wiring graph — run `graft build` first" };

  let defs = graph.nodes.filter((n) => n.kind !== "file" && n.path === file);
  if (!defs.length) {
    const matches = new Set(
      graph.nodes.filter((n) => n.path === file || n.path.endsWith(`/${file}`)).map((n) => n.path),
    );
    if (matches.size > 1)
      return { file, entries: [], note: `ambiguous — matches: ${[...matches].sort().join(", ")}` };
    const [path] = matches;
    if (path) defs = graph.nodes.filter((n) => n.kind !== "file" && n.path === path);
  }
  if (!defs.length) return { file, entries: [], note: "no definitions indexed for this file" };

  const startLine = (span: string) => Number(span.match(/^L(\d+)/)?.[1] ?? 0);
  defs.sort((a, b) => startLine(a.span) - startLine(b.span));
  return {
    file: defs[0].path,
    entries: defs.map((n) => ({
      name: n.name,
      kind: n.kind,
      span: n.span,
      signature: n.signature,
      summary: n.summary?.split("\n")[0].trim() || undefined,
    })),
    saved: savingsFor(graph, [defs[0].path]),
  };
}

/** Render a {@link SkeletonResult} as compact markdown. */
export function formatSkeleton(r: SkeletonResult): string {
  const head = `graft skeleton — ${r.file}`;
  if (!r.entries.length) return `${head}\n\n${r.note ?? "no definitions."}\n`;
  const lines = r.entries.map((e) => {
    const sig = e.signature ? `  ${e.signature}` : "";
    const sum = e.summary ? ` — ${e.summary}` : "";
    return `- ${e.span}  ${e.kind} ${e.name}${sig}${sum}`;
  });
  const body = `${head}\n${lines.join("\n")}`;
  return withSavings(body, r.saved) + "\n";
}

/** Rough tokens for a byte length (≈ 4 chars/token; good enough for an estimate). */
function toTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** Render an {@link AskResult} as a compact markdown context pack. */
export function formatAsk(r: AskResult): string {
  const head = `graft ask — "${r.query}"  (${r.mode})`;
  // The note prints as its own prominent line(s) right under the header —
  // above every hit — so a loud structural-fallthrough note (or the
  // no-structural-edges / no-lexical-match note) can never be missed by only
  // being embedded inline in the header parenthetical. Only a genuine
  // fallthrough/warning line (from `fallthroughNoteFor`, always prefixed
  // "structural index:") gets the ⚠ marker; the benign structural header note
  // ("callers / references of X" / "outgoing edges from X") prints plain —
  // it's informational, not a warning.
  const noteBlock = r.note
    ? r.note
        .split("\n")
        .map((l) => (l.startsWith("structural index:") ? `⚠ ${l}` : l))
        .join("\n")
    : "";
  if (r.hits.length === 0) {
    return `${head}\n\n${noteBlock || "no matches."}${escalationNudge(r)}\n`;
  }
  const lines = noteBlock ? [head, "", noteBlock, ""] : [head, ""];
  if (r.mode === "structural") {
    for (const h of r.hits) {
      const tail = h.snippet ? ` — ${h.snippet}` : "";
      lines.push(`- ${h.title}  ${h.pointer}  (${h.relation})${tail}`);
      if (h.code) lines.push("", "```", h.code, "```", "");
    }
  } else {
    r.hits.forEach((h, i) => {
      // Multi-scope results label each hit with its sub-project (root scope
      // "" stays unlabeled) so a reviewer can tell WHICH codebase answered.
      const label = r.scopes && h.scope ? `[${h.scope}/] ` : "";
      lines.push(`${i + 1}. ${label}${h.title}  [${h.kind}]`);
      lines.push(`   ${h.pointer}`);
      if (h.snippet) lines.push(`   ${h.snippet}`);
      if (h.related?.length) lines.push(`   related: ${h.related.join(", ")}`);
      if (h.code) lines.push("", "```", h.code, "```");
      lines.push("");
    });
    lines.push(...scopeFooterLines(r));
  }
  // Before `body` is joined, so the rules text is counted in the savings line
  // below rather than claimed as free.
  if (r.rules?.length) lines.push(...formatRules(r.rules));
  const body = lines.join("\n").trimEnd();
  const savings = askSavingsLine(r, body);
  return (savings ? `${savings}\n\n${body}` : body) + escalationNudge(r) + "\n";
}

/** When a lexical `ask` returns thin/no results, the productive next move is a
 * different TOOL, not a re-phrased ask — re-asking is the "over-ask" trap that
 * inflates cost. Surface the escalation in the output so the agent switches to
 * grep/skeleton/callers instead. Silent when the result is already rich (>3
 * hits) or in structural mode (a resolved who-calls IS the answer). */
function escalationNudge(r: AskResult): string {
  if ((r.mode !== "lexical" && r.mode !== "empty") || r.hits.length > 3) return "";
  const n = r.hits.length;
  return (
    `\n\n[graft] ${n === 0 ? "no hits" : `only ${n} hit${n === 1 ? "" : "s"}`} — don't re-ask with new wording; switch tool: ` +
    "`graft grep \"<literal>\"` for every occurrence · `graft skeleton <file>` for a file's full API · `graft callers <symbol>` for who-uses."
  );
}

/** The one-line token-saving estimate `ask` prepends in retriever mode, so the
 * agent gets the number for free in the tool output — no extra work on its end.
 * `packChars` is measured from the rendered body: exactly what the agent reads.
 * Header, not footer, for the reason documented on `withSavings`: a trailing
 * line dies to `head -N` and to host output truncation. */
function askSavingsLine(r: AskResult, body: string): string {
  if (!r.saved || r.saved.baselineChars <= 0) return "";
  const pack = toTokens(body.length);
  const base = toTokens(r.saved.baselineChars);
  if (base <= pack) return ""; // no saving to claim (tiny files); stay quiet
  const saved = base - pack;
  const pct = Math.round((saved / base) * 100);
  return (
    `[graft] tokens saved ≈ ${saved.toLocaleString()} (${pct}%) — this pack ≈ ` +
    `${pack.toLocaleString()} tok vs reading the ${r.saved.files} source file(s) whole ≈ ` +
    `${base.toLocaleString()} tok. Estimate (baseline = those files read in full).` +
    savingsTurnNudge(saved)
  );
}

/** Multi-scope footer: answers a reviewer's two questions — "which
 * sub-projects did this pack come from?" (`matched in:`, displayed-hit counts,
 * biggest first) and "did anything else match that I should know about?"
 * (`also matched:` for scopes gated out of fusion, with the flag to narrow).
 * Empty (zero output) whenever the result isn't a federated multi-scope one. */
function scopeFooterLines(r: AskResult): string[] {
  if (!r.scopes) return [];
  const perScope = new Map<string, number>();
  for (const h of r.hits)
    if (h.scope !== undefined) perScope.set(h.scope, (perScope.get(h.scope) ?? 0) + 1);
  const parts = [...perScope]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s, c]) => `${scopeLabel(s)} (${c})`);
  const out = parts.length ? [`matched in: ${parts.join(" · ")}`] : [];
  for (const m of r.scopes.alsoMatched)
    out.push(`also matched: ${scopeLabel(m.scope)} — narrow with --in ${scopeLabel(m.scope)}`);
  return out;
}
