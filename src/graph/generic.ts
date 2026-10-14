/**
 * Generic "breadth" extractor tier — one language-agnostic extractor over any
 * tree-sitter grammar + its `tags.scm` (the standard tree-sitter tags convention). This is how
 * graft covers the long tail of languages for ~one registry row each, instead of
 * a hand-written extractor per language (the depth tier in extract.ts).
 *
 * Grammars are WASM (`tree-sitter-wasm` bundle) loaded via `web-tree-sitter`, so
 * a new language needs no native node-gyp build. Loading is async (WASM init), so
 * callers MUST `await warmGenericGrammars([...])` once before the synchronous
 * `extractGeneric()` is used in a build/check loop. If a grammar isn't warmed,
 * `extractGeneric` degrades to a file node only (never throws).
 *
 * What it emits (signature-only): a file node + one node per `@definition.<kind>`
 * capture, and bare-name `calls` raw edges from `@reference.call` attributed to
 * the innermost enclosing definition. resolve.ts then resolves those calls by
 * name for free (same-file → extracted, unique-global → inferred). Member-call
 * receiver typing (recvType) is NOT produced here — that needs a per-language
 * binding pass; the opt-in LSP tier fills that gap for popular languages.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { contentHash } from "../util/id.js";
import type { Kind, NodeV1 } from "./types.js";
import type { ExtractResult, RawEdge } from "./extract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// queries/ ships beside the compiled JS (copied by the build); fall back to src.
const QUERY_DIRS = [join(HERE, "queries"), join(HERE, "..", "..", "src", "graph", "queries")];

/** A breadth-tier language: graft name, file extensions, and the wasm basename
 * in tree-sitter-wasm/<wasm>/tree-sitter-<wasm>.wasm. One row per language. */
export interface GenericLang {
  name: string;
  exts: string[];
  wasm: string;
}

/** The breadth registry. Add a row + a queries/<name>.scm to support a language.
 * Extensions here must NOT collide with the depth tier's EXTENSIONS (extract.ts). */
export const GENERIC_LANGS: readonly GenericLang[] = [
  { name: "rust", exts: [".rs"], wasm: "rust" },
  { name: "java", exts: [".java"], wasm: "java" },
  { name: "c", exts: [".c", ".h"], wasm: "c" },
  { name: "cpp", exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh"], wasm: "cpp" },
  { name: "ruby", exts: [".rb"], wasm: "ruby" },
  { name: "c_sharp", exts: [".cs"], wasm: "c_sharp" },
  // These ship a tags.scm (calls + symbols); ocaml/zig/html have none and use
  // the node-kind walker fallback (symbols only) — still one row, zero query.
  { name: "scala", exts: [".scala", ".sc"], wasm: "scala" },
  { name: "elixir", exts: [".ex", ".exs"], wasm: "elixir" },
  { name: "solidity", exts: [".sol"], wasm: "solidity" },
  { name: "ocaml", exts: [".ml", ".mli"], wasm: "ocaml" },
  { name: "zig", exts: [".zig"], wasm: "zig" },
  { name: "dart", exts: [".dart"], wasm: "dart" }, // surfaced by PR #38 (@muneebshere)
  { name: "clojure", exts: [".clj", ".cljs", ".cljc", ".bb"], wasm: "clojure" },
  { name: "nix", exts: [".nix"], wasm: "nix" },
  { name: "lua", exts: [".lua"], wasm: "lua" },
  // HTML's grammar has no definition-shaped nodes, so the walker yields a file
  // node only — enough for Django/etc. templates to be findable by name (#150).
  { name: "html", exts: [".html", ".htm"], wasm: "html" },
];

const byExt = new Map<string, GenericLang>();
for (const l of GENERIC_LANGS) for (const e of l.exts) byExt.set(e, l);

/** The generic language for a path, or null if no breadth grammar claims it. */
export function genericLangOf(path: string): GenericLang | null {
  const lower = path.toLowerCase();
  for (const [ext, l] of byExt) if (lower.endsWith(ext)) return l;
  return null;
}

/** Every file extension a breadth-tier (generic tree-sitter) grammar claims. */
export function genericExtensions(): string[] {
  return GENERIC_LANGS.flatMap((l) => l.exts);
}

// tags.scm @definition.<X>  →  graft Kind (types.ts). Unmapped → "function".
const KIND: Record<string, Kind> = {
  function: "function", method: "method", class: "class", interface: "interface",
  type: "type", struct: "struct", enum: "enum", module: "module",
  constant: "constant", variable: "variable", field: "variable",
  object: "class", property: "variable", // Scala object; Swift/Scala property
};

// Loaded grammars + compiled tags queries, keyed by graft lang name. Populated by
// warmGenericGrammars; read synchronously by extractGeneric.
export interface Loaded { language: unknown; query: unknown | null }
const loaded = new Map<string, Loaded>();
let tsMod: typeof import("web-tree-sitter") | null = null;
let initPromise: Promise<void> | null = null;

function requireWasm(wasm: string): Buffer | null {
  // Resolve the grammar wasm from the tree-sitter-wasm bundle (its package.json
  // `exports` maps the bare "<lang>/…" subpath to the actual "out/<lang>/…" file).
  try {
    const p = require.resolve(`tree-sitter-wasm/${wasm}/tree-sitter-${wasm}.wasm`);
    return readFileSync(p);
  } catch {
    return null;
  }
}

function loadQuery(name: string): string | null {
  for (const dir of QUERY_DIRS) {
    try {
      const raw = readFileSync(join(dir, `${name}.scm`), "utf8");
      // Sanitize editor-specific query predicates the tree-sitter Query compiler rejects.
      return raw.replace(
        /\(#(?:strip!|set!|set-adjacent!|select-adjacent!|make-range!|offset!|gsub!)[^()]*\)/g,
        "",
      );
    } catch {
      /* try next dir */
    }
  }
  return null;
}

/** Warm the WASM grammars for the given graft lang names. Idempotent; must be
 * awaited once before extractGeneric is used in a sync loop. Unknown/unavailable
 * grammars are silently skipped (their files then extract as file-only). */
export async function warmGenericGrammars(langNames: Iterable<string>): Promise<void> {
  const want = new Set(langNames);
  const need = [...want].filter((n) => !loaded.has(n) && GENERIC_LANGS.some((l) => l.name === n));
  if (need.length === 0) return;
  if (!tsMod) {
    tsMod = await import("web-tree-sitter");
    initPromise = initPromise ?? tsMod.Parser.init();
  }
  await initPromise;
  const { Language, Query } = tsMod;
  for (const name of need) {
    const row = GENERIC_LANGS.find((l) => l.name === name)!;
    const bytes = requireWasm(row.wasm);
    if (!bytes) continue;
    try {
      const language = await Language.load(bytes);
      const scm = loadQuery(name);
      let query: unknown | null = null;
      if (scm) {
        try { query = new Query(language, scm); } catch { query = null; }
      }
      loaded.set(name, { language, query });
    } catch {
      /* grammar failed to instantiate — skip; files extract as file-only */
    }
  }
}

/** True if a grammar has been warmed for this lang (else extractGeneric is file-only). */
export function isWarm(langName: string): boolean {
  return loaded.has(langName);
}

/** Test seam: swap in (or, with null, remove) a grammar entry, returning the
 * previous one so the caller can restore it. The parse-failure path in
 * extractGeneric needs a grammar that throws deterministically; the real crash
 * that motivated it (tree-sitter-wasm PHP on heredocs, #139) is heap-state
 * dependent, so tests inject a fake here instead of depending on it. */
export function swapGrammarForTest(name: string, entry: Loaded | null): Loaded | null {
  const prev = loaded.get(name) ?? null;
  if (entry) loaded.set(name, entry);
  else loaded.delete(name);
  return prev;
}

/** Load one grammar from the tree-sitter-wasms bundle, initialising
 * web-tree-sitter on first call. Null when the wasm is missing or won't
 * instantiate — never throws, so a caller degrades instead of failing the build.
 *
 * Shared with the container tier (container.ts), which needs a grammar to find
 * where an embedded language starts but none of the tags.scm machinery above.
 * Kept here so web-tree-sitter is initialised exactly once per process. */
export async function loadWasmLanguage(wasm: string): Promise<unknown | null> {
  if (!tsMod) {
    tsMod = await import("web-tree-sitter");
    initPromise = initPromise ?? tsMod.Parser.init();
  }
  await initPromise;
  const bytes = requireWasm(wasm);
  if (!bytes) return null;
  try {
    return await tsMod.Language.load(bytes);
  } catch {
    return null;
  }
}

const PARSE_CHUNK = 16384; // <32KB slices — same tree-sitter limit workaround as extract.ts

/** Parse with an already-loaded grammar. Returns the root node, or null if the
 * grammar was never warmed or the parse blew up. Companion to
 * `loadWasmLanguage` for callers outside this module. */
export function parseWasm(language: unknown, source: string): TsNode | null {
  if (!tsMod) return null;
  try {
    const parser = new tsMod.Parser();
    parser.setLanguage(language as never);
    const tree = parser.parse((i: number) => source.slice(i, i + PARSE_CHUNK));
    return (tree?.rootNode as TsNode) ?? null;
  } catch {
    return null;
  }
}

function fileNode(rel: string, source: string): NodeV1 {
  return {
    id: rel, name: rel.split("/").pop() ?? rel, kind: "file", path: rel,
    span: `L1-L${Math.max(1, source.split("\n").length)}`, signature: null,
    exported: true, origin: "generic", body_hash: contentHash(source),
    chars: Buffer.byteLength(source), summary_state: "pending", summary: null, crux: null,
  };
}

interface Def { id: string; startIndex: number; endIndex: number }

/** Extract a single generic-tier file. Synchronous; needs the grammar pre-warmed.
 * Uses the grammar's compiled tags.scm when present (symbols + call edges);
 * otherwise falls back to a node-kind tree walker (symbols only) so ANY warmed
 * grammar yields a graph even with no vendored query. */
export function extractGeneric(rel: string, source: string, langName: string): ExtractResult {
  const nodes: NodeV1[] = [fileNode(rel, source)];
  const rawEdges: RawEdge[] = [];
  const entry = loaded.get(langName);
  if (!entry || !tsMod) return { nodes, rawEdges };

  let tree;
  try {
    const parser = new tsMod.Parser();
    parser.setLanguage(entry.language as never);
    tree = parser.parse((i: number) => source.slice(i, i + PARSE_CHUNK));
  } catch (err) {
    // A grammar that throws (e.g. a WASM "memory access out of bounds" from an
    // external scanner) is not a per-file syntax problem: swallowing it here left
    // the file with only its file node and the build reporting success. Rethrow so
    // build.ts records it in `errors`, the CLI prints it, and the extract cache
    // remembers the failure instead of caching an empty result as clean.
    throw new Error(`${langName} grammar threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!tree) return { nodes, rawEdges };

  const minted = new Set<string>([rel]);
  const lines = source.split("\n");
  const defs: Def[] = [];
  // One definition per source span: a grammar's tags.scm can capture the same node
  // under two @definition kinds (Swift `func` is method AND function), and the
  // walker can revisit a nested match — both would emit near-duplicate nodes.
  const spanSeen = new Set<number>();
  // Mint one definition node from a whole-definition tree node. Shared by both
  // the tags.scm path and the walker fallback so id/span/signature/body_text are
  // built identically.
  const mkDef = (name: string, kind: Kind, whole: TsNode): void => {
    if (spanSeen.has(whole.startIndex)) return;
    spanSeen.add(whole.startIndex);
    const idBase = `${rel}#${name}`;
    let id = idBase, n = 2;
    while (minted.has(id)) id = `${idBase}~${n++}`;
    minted.add(id);
    const startRow = whole.startPosition.row, endRow = whole.endPosition.row;
    const sigLine = (lines[startRow] ?? "").trim().replace(/\s*\{?\s*$/, "");
    nodes.push({
      id, name, kind, path: rel,
      span: `L${startRow + 1}-L${endRow + 1}`,
      signature: sigLine || null, exported: true, origin: "generic",
      body_hash: contentHash(source.slice(whole.startIndex, whole.endIndex)),
      body_text: source.slice(whole.startIndex, whole.endIndex).replace(/\s+/g, " ").slice(0, 5000),
      summary_state: "pending", summary: null, crux: null,
    });
    defs.push({ id, startIndex: whole.startIndex, endIndex: whole.endIndex });
  };

  if (entry.query) {
    tagsExtract(entry.query, tree.rootNode as TsNode, rel, mkDef, defs, rawEdges, langName);
  } else {
    walkExtract(tree.rootNode as TsNode, mkDef); // no tags.scm → symbols only
  }
  // The preprocessor is invisible to tags.scm, but in C/C++ a local `#include "x.h"`
  // IS the dependency graph — capture it as a file→file import. Likewise a Rust
  // `use crate::…` is an in-crate module dependency.
  if (langName === "c" || langName === "cpp") extractIncludes(tree.rootNode as TsNode, rel, rawEdges);
  else if (langName === "rust") extractUses(tree.rootNode as TsNode, rel, rawEdges);
  else if (langName === "php") extractPhpUses(tree.rootNode as TsNode, rel, rawEdges);
  return { nodes, rawEdges };
}

/** PHP `use App\Models\User;` → a file→class-file `imports` raw edge, one per imported
 * name (a `{ … }` group expands to several). `use function`/`use const` are skipped —
 * those name a symbol, not a PSR-4 class file. resolve.ts settles the fully-qualified
 * name to the in-repo file by namespace suffix, and drops it when it can't. */
function extractPhpUses(root: TsNode, rel: string, rawEdges: RawEdge[]): void {
  const visit = (n: TsNode): void => {
    if (n.type === "namespace_use_declaration") {
      for (const fqn of phpUseNames(n.text)) rawEdges.push({ source: rel, relation: "imports", specifier: fqn, file: rel });
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
      const c = n.namedChild?.(i);
      if (c) visit(c);
    }
  };
  visit(root);
}

/** The fully-qualified class names a PHP `use` declaration imports. Handles a plain
 * `use A\B\C;`, a comma list `use A\B, C\D;`, a group `use A\B\{C, D};`, and `as` aliases;
 * returns [] for `use function`/`use const` (symbol imports, not class files). */
function phpUseNames(text: string): string[] {
  let s = text.replace(/^\s*use\s+/, "").replace(/;\s*$/, "").trim();
  if (/^(function|const)\b/.test(s)) return [];
  const brace = s.indexOf("{");
  if (brace >= 0) {
    const prefix = s.slice(0, brace).replace(/\\\s*$/, "");
    const inner = s.slice(brace + 1, s.lastIndexOf("}"));
    return inner.split(",").map((m) => m.trim().replace(/\s+as\s+\w+$/i, "").trim()).filter(Boolean)
      .map((m) => `${prefix}\\${m}`);
  }
  return s.split(",").map((c) => c.trim().replace(/\s+as\s+\w+$/i, "").trim()).filter(Boolean);
}

/** Rust `use crate::a::b::Item` → a file→module `imports` raw edge whose specifier is the
 * crate-relative module path (`a/b`). Only in-crate imports are captured; `std::`,
 * `super::`, `self::`, external crates, and globs are skipped — resolve.ts settles the
 * path against the file's crate root, and drops it when it can't. */
function extractUses(root: TsNode, rel: string, rawEdges: RawEdge[]): void {
  const visit = (n: TsNode): void => {
    if (n.type === "use_declaration") {
      const spec = rustUseModule(n.text);
      if (spec !== null) rawEdges.push({ source: rel, relation: "imports", specifier: spec ? `crate/${spec}` : "crate", file: rel });
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
      const c = n.namedChild?.(i);
      if (c) visit(c);
    }
  };
  visit(root);
}

/** The crate-relative path a Rust `use crate::…` names (`::`→`/`), or null when it is not
 * an in-crate import. The FULL path is returned — including any trailing item segment —
 * because a single `crate::lexical` can be either a module OR a crate-root item; the
 * resolver settles that by finding the longest prefix that is a real module file. A
 * `{ … }` group has no single item, so its prefix (before `{`) is the path. */
function rustUseModule(text: string): string | null {
  let s = text.replace(/^\s*use\s+/, "").replace(/;\s*$/, "").trim();
  const brace = s.indexOf("{");
  if (brace >= 0) s = s.slice(0, brace).replace(/::\s*$/, "");
  else s = s.replace(/\s+as\s+\w+$/, "");
  s = s.trim();
  if (s !== "crate" && !s.startsWith("crate::")) return null; // only in-crate absolute imports
  if (s.includes("*")) return null; // glob — no single module target
  return s.replace(/^crate::?/, "").replace(/\s+/g, "").replace(/::/g, "/"); // "" = crate root
}

/** C/C++ `#include "header.h"` → a file→file `imports` raw edge. Only LOCAL includes
 * (quoted) are captured; system includes (`<stdio.h>`) are skipped — high volume, and
 * there is no in-repo target to navigate to. resolve.ts settles the quoted path to an
 * in-repo header (relative to the including file, else a unique path-suffix match), and
 * keeps it as an external string when it cannot — never a guessed edge. */
function extractIncludes(root: TsNode, rel: string, rawEdges: RawEdge[]): void {
  const visit = (n: TsNode): void => {
    if (n.type === "preproc_include") {
      const raw = n.childForFieldName?.("path")?.text ?? "";
      if (raw.startsWith('"')) {
        const spec = raw.replace(/^"|"$/g, "").trim();
        if (spec) rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
      }
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
      const c = n.namedChild?.(i);
      if (c) visit(c);
    }
  };
  visit(root);
}

/** tags.scm path: @definition.<kind> → nodes, @reference.call/@reference.send →
 * bare-name call edges attributed to the innermost enclosing definition. */
function tagsExtract(
  query: unknown,
  root: TsNode,
  rel: string,
  mkDef: (name: string, kind: Kind, whole: TsNode) => void,
  defs: Def[],
  rawEdges: RawEdge[],
  langName: string,
): void {
  const q = query as { matches(n: unknown): Array<{ captures: Array<{ name: string; node: TsNode }> }> };
  const matches = q.matches(root);
  // Some grammars' tags.scm capture a definition's own NAME token as a
  // @reference.call too (Ruby tags `def foo`'s `foo` as both @name and a call),
  // producing bogus self-loops (foo→foo). Skip any call at a definition's name token.
  const defNameAt = new Set<number>();
  const calls: Array<{ name: string; at: number }> = [];
  const refs: Array<{ name: string; at: number }> = [];
  for (const m of matches) {
    const cap: Record<string, TsNode> = {};
    for (const c of m.captures) cap[c.name] = c.node;
    const defKey = Object.keys(cap).find((k) => k.startsWith("definition."));
    if (defKey && cap.name) {
      defNameAt.add(cap.name.startIndex);
      mkDef(cap.name.text, KIND[defKey.slice("definition.".length)] ?? "function", defScope(cap[defKey], langName));
    }
    if (("reference.call" in cap || "reference.send" in cap) && cap.name)
      calls.push({ name: cap.name.text, at: cap.name.startIndex });
    // Structural references the grammar already marks: a supertype (extends), an
    // implemented interface, an object creation (`new Foo`), a module alias. Grammars
    // label these @reference.class/.interface/.implementation/.module — heterogeneous
    // syntactically but all "names this symbol without calling it". They become
    // `references` edges the same precision-first resolver settles to a type-like def
    // (same-file certain, unique cross-file inferred, ambiguous dropped), so a data
    // class that's only ever extended or instantiated stops being an orphan.
    if (("reference.class" in cap || "reference.interface" in cap ||
         "reference.implementation" in cap || "reference.module" in cap) && cap.name)
      refs.push({ name: cap.name.text, at: cap.name.startIndex });
  }
  // innermost enclosing definition of a token at byte offset `at`
  const enclosing = (at: number) =>
    defs
      .filter((d) => d.startIndex <= at && at < d.endIndex)
      .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];
  for (const c of calls) {
    if (defNameAt.has(c.at)) continue;
    const enc = enclosing(c.at);
    rawEdges.push({ source: enc ? enc.id : rel, relation: "calls", file: rel, name: c.name });
  }
  for (const r of refs) {
    if (defNameAt.has(r.at)) continue;
    const enc = enclosing(r.at);
    if (!enc) continue; // a reference with no enclosing definition has no sound source
    rawEdges.push({ source: enc.id, relation: "references", file: rel, name: r.name });
  }
}

// Node-type → Kind for the walker fallback. A node is a definition when its type
// ends with a declaration-ish suffix AND names a construct — matched most-specific
// first (method before function). Covers the common tree-sitter grammar vocab
// without any per-language query.
const DEF_SUFFIX = /(declaration|definition|_item|_specifier|_decl|_def|_binding)$/;
function classifyKind(type: string): Kind | null {
  const t = type.toLowerCase();
  if (!DEF_SUFFIX.test(t) && !/^(class|struct|enum|interface|trait|module|namespace)/.test(t)) return null;
  if (/method|constructor/.test(t)) return "method";
  if (/func|function|def\b|subroutine|procedure/.test(t)) return "function";
  if (/class/.test(t)) return "class";
  if (/struct|record/.test(t)) return "struct";
  if (/interface|trait|protocol/.test(t)) return "interface";
  if (/enum/.test(t)) return "enum";
  if (/module|namespace|package|mod_/.test(t)) return "module";
  if (/const/.test(t)) return "constant";
  if (/typedef|type_alias|type_def|alias/.test(t)) return "type";
  if (/type/.test(t)) return "type";
  if (/(^|_)(val|var|let|field|property)/.test(t)) return "variable";
  return null;
}
/** The declared name of a node: its `name` field, else the first identifier-ish
 * descendant within a couple of levels. */
function nodeName(node: TsNode): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text) return byField.text;
  const stack: Array<{ n: TsNode; d: number }> = [{ n: node, d: 0 }];
  while (stack.length) {
    const { n, d } = stack.shift()!;
    if (d > 0 && /identifier|name/.test(n.type) && n.text && !n.text.includes("\n")) return n.text;
    if (d < 3) for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
      const c = n.namedChild?.(i);
      if (c) stack.push({ n: c, d: d + 1 });
    }
  }
  return null;
}
/** Walker fallback: DFS every named node, emit a def for each classified one
 * (symbols only — no call resolution without a query). */
function walkExtract(root: TsNode, mkDef: (name: string, kind: Kind, whole: TsNode) => void): void {
  const visit = (n: TsNode): void => {
    const kind = classifyKind(n.type);
    if (kind) {
      const name = nodeName(n);
      if (name) mkDef(name, kind, n);
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
      const c = n.namedChild?.(i);
      if (c) visit(c);
    }
  };
  visit(root);
}

/** Minimal structural view of a web-tree-sitter node — shared with container.ts. */
export interface TsNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  parent: TsNode | null;
  namedChildCount?: number;
  namedChild?(i: number): TsNode | null;
  childForFieldName?(field: string): TsNode | null;
}

// Some grammars' tags.scm put @definition.<X> on a narrow node (C tags the
// `function_declarator`, not the whole `function_definition` with its body), so
// the capture's span stops before the body and calls inside it can't be
// attributed to the function. Expand up to the outermost enclosing
// declaration/definition node so a def's span covers its body.
const DEF_CONTAINER = /(definition|declaration|specifier|_item)$/;
function nextNamedSibling(n: TsNode): TsNode | null {
  const tagged = n as TsNode & { nextNamedSibling?: TsNode | null };
  if ("nextNamedSibling" in tagged) return tagged.nextNamedSibling ?? null;
  const p = n.parent;
  if (!p?.namedChild) return null;
  const count = p.namedChildCount ?? 0;
  for (let i = 0; i < count - 1; i++) {
    const c = p.namedChild(i);
    if (c && c.startIndex === n.startIndex && c.endIndex === n.endIndex) return p.namedChild(i + 1);
  }
  return null;
}
function defScope(node: TsNode, langName?: string): TsNode {
  let n = node;
  while (n.parent && DEF_CONTAINER.test(n.parent.type)) n = n.parent;
  // Dart's grammar leaves `function_signature` / `method_signature` as a sibling
  // of `function_body` (no wrapping function_definition). Expand so a def's span
  // covers its body and calls inside it attribute to the function, not the file
  // or enclosing class. Gated on Dart so other breadth-tier languages are untouched.
  if (langName === "dart") {
    const body = nextNamedSibling(n);
    if (body?.type === "function_body") {
      return {
        type: n.type,
        text: n.text,
        startIndex: n.startIndex,
        endIndex: body.endIndex,
        startPosition: n.startPosition,
        endPosition: body.endPosition,
        parent: n.parent,
      };
    }
  }
  return n;
}
