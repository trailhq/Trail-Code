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
import type { ExtractResult, Language, RawEdge } from "./extract.js";
import { webTreeSitter } from "./wasm-runtime.js";

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
  /** Bundle dirs whose `tags.scm` to use, concatenated, when there is no vendored
   * queries/<name>.scm. Only the depth-tier stand-ins below set it. */
  bundledTags?: string[];
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
  // These ship a tags.scm (calls + symbols); ocaml/zig have none and use the
  // node-kind walker fallback (symbols only) — still one row, zero query.
  { name: "scala", exts: [".scala", ".sc"], wasm: "scala" },
  { name: "elixir", exts: [".ex", ".exs"], wasm: "elixir" },
  { name: "solidity", exts: [".sol"], wasm: "solidity" },
  { name: "ocaml", exts: [".ml", ".mli"], wasm: "ocaml" },
  { name: "zig", exts: [".zig"], wasm: "zig" },
  { name: "dart", exts: [".dart"], wasm: "dart" }, // surfaced by PR #38 (@muneebshere)
  { name: "clojure", exts: [".clj", ".cljs", ".cljc", ".bb"], wasm: "clojure" },
  { name: "nix", exts: [".nix"], wasm: "nix" },
  { name: "lua", exts: [".lua"], wasm: "lua" },
  { name: "gleam", exts: [".gleam"], wasm: "gleam" },
];

/**
 * Stand-ins for the depth tier, used only for a language whose own grammar did not
 * load (depth-parser.ts), as after a broken install. They claim no extension, so
 * `genericLangOf` never returns them; the build picks one by asking
 * {@link fallbackLangOf}. Output is the
 * breadth tier's: symbols and bare-name calls, no receiver types or bindings.
 * Kotlin, Swift and PHP use their vendored queries/<name>.scm; the rest use the
 * bundle's own tags.scm (typescript's builds on javascript's, as upstream does).
 */
const FALLBACK_LANGS: Record<Exclude<Language, "java">, GenericLang> = {
  typescript: { name: "typescript", exts: [], wasm: "typescript", bundledTags: ["javascript", "typescript"] },
  tsx: { name: "tsx", exts: [], wasm: "tsx", bundledTags: ["javascript", "tsx"] },
  python: { name: "python", exts: [], wasm: "python", bundledTags: ["python"] },
  go: { name: "go", exts: [], wasm: "go", bundledTags: ["go"] },
  r: { name: "r", exts: [], wasm: "r", bundledTags: ["r"] },
  kotlin: { name: "kotlin", exts: [], wasm: "kotlin" },
  swift: { name: "swift", exts: [], wasm: "swift" },
  php: { name: "php", exts: [], wasm: "php" },
};

/** The breadth-tier grammar that stands in for a depth-tier language whose native
 * grammar can't load. Java already has a breadth row, so it is its own stand-in. */
export function fallbackLangOf(lang: Language): GenericLang {
  return lang === "java" ? GENERIC_LANGS.find((l) => l.name === "java")! : FALLBACK_LANGS[lang];
}

function rowNamed(name: string): GenericLang | undefined {
  return GENERIC_LANGS.find((l) => l.name === name) ?? Object.values(FALLBACK_LANGS).find((l) => l.name === name);
}

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

// Sanitize editor-specific query predicates the tree-sitter Query compiler rejects.
function sanitizeQuery(raw: string): string {
  return raw.replace(/\(#(?:strip!|set!|set-adjacent!|select-adjacent!|make-range!|offset!|gsub!)[^()]*\)/g, "");
}

function loadQuery(row: GenericLang): string | null {
  for (const dir of QUERY_DIRS) {
    try {
      return sanitizeQuery(readFileSync(join(dir, `${row.name}.scm`), "utf8"));
    } catch {
      /* try next dir */
    }
  }
  if (!row.bundledTags) return null;
  const parts: string[] = [];
  for (const dir of row.bundledTags) {
    try {
      parts.push(readFileSync(require.resolve(`tree-sitter-wasm/${dir}/tags.scm`), "utf8"));
    } catch {
      /* no tags.scm for this one */
    }
  }
  return parts.length > 0 ? sanitizeQuery(parts.join("\n")) : null;
}

/** Warm the WASM grammars for the given graft lang names. Idempotent; must be
 * awaited once before extractGeneric is used in a sync loop. Unknown/unavailable
 * grammars are silently skipped (their files then extract as file-only). */
export async function warmGenericGrammars(langNames: Iterable<string>): Promise<void> {
  const want = new Set(langNames);
  const need = [...want].filter((n) => !loaded.has(n) && rowNamed(n) !== undefined);
  if (need.length === 0) return;
  tsMod = await webTreeSitter();
  const { Language, Query } = tsMod;
  for (const name of need) {
    const row = rowNamed(name)!;
    const bytes = requireWasm(row.wasm);
    if (!bytes) continue;
    try {
      const language = await Language.load(bytes);
      const scm = loadQuery(row);
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
 * The runtime itself is shared with every WASM tier (wasm-runtime.ts). */
export async function loadWasmLanguage(wasm: string): Promise<unknown | null> {
  tsMod = await webTreeSitter();
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

/** The innermost definition whose span covers the token at byte offset `at` —
 * the caller a reference found there belongs to. Shared by the tags.scm path and
 * the per-language passes below so both attribute edges the same way. */
function enclosingDef(defs: Def[], at: number): Def | undefined {
  return defs
    .filter((d) => d.startIndex <= at && at < d.endIndex)
    .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];
}

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
  else if (langName === "gleam") extractGleamModules(tree.rootNode as TsNode, rel, defs, rawEdges);
  else if (langName === "elixir") extractElixir(tree.rootNode as TsNode, rel, nodes, defs, rawEdges);
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

/**
 * Gleam's module system IS its dependency graph, and it is unusually exact: an
 * `import app/thing` names one module file, every reference to another module
 * goes through a qualifier that import binds (`thing.helper()`), and there is no
 * ambient global scope for a name to arrive from. This pass reads that table and
 * uses it for two things.
 *
 * First, a file→file `imports` raw edge per import, which resolve.ts settles
 * against the repo's `.gleam` files (`app/thing` → `…/src/app/thing.gleam`).
 *
 * Second, precision on calls. tags.scm sees `list.map(…)` as the bare label
 * `map`, and because EVERY stdlib call in Gleam is spelled that way, resolving
 * those by name alone is a false-edge machine — `map`, `filter`, `try`, `new`
 * and `to_string` all collide with in-repo functions. So qualified calls are
 * emitted here instead, stamped with the module the qualifier names: resolve.ts
 * then looks the label up in that one file, or drops the call when the module is
 * out of repo (the stdlib, a hex dependency). Unqualified imports
 * (`import app/thing.{helper}`, then a bare `helper()`) give the same two halves,
 * so the bare edge tags.scm already emitted is upgraded in place.
 *
 * A function is as often piped into or handed over as it is called outright
 * (`xs |> thing.helper`, `list.map(xs, thing.helper)`), and neither is a
 * `function_call` node, so both are read here too: a pipe's right side is a
 * call, a name passed as a value is a `references` edge.
 */
function extractGleamModules(root: TsNode, rel: string, defs: Def[], rawEdges: RawEdge[]): void {
  // `list` in `list.map(…)` → the module path it was bound to. The qualifier is
  // the `as` alias when there is one, else the module path's last segment.
  const byQualifier = new Map<string, string>();
  // `helper` from `import app/thing.{helper}` (or its `as` alias) → that module.
  const byName = new Map<string, string>();
  for (let i = 0; i < (root.namedChildCount ?? 0); i++) {
    const imp = root.namedChild?.(i);
    if (imp?.type !== "import") continue;
    const mod = imp.childForFieldName?.("module")?.text;
    if (!mod) continue;
    rawEdges.push({ source: rel, relation: "imports", specifier: mod, file: rel });
    byQualifier.set(imp.childForFieldName?.("alias")?.text || mod.slice(mod.lastIndexOf("/") + 1), mod);
    const unqualified = imp.childForFieldName?.("imports");
    for (let j = 0; j < (unqualified?.namedChildCount ?? 0); j++) {
      const u = unqualified?.namedChild?.(j);
      if (u?.type !== "unqualified_import") continue;
      // `{ other as o }` binds `o`; `{ type Handler }` binds a type, harmless here.
      const local = u.childForFieldName?.("alias")?.text ?? u.childForFieldName?.("name")?.text;
      if (local) byName.set(local, mod);
    }
  }
  // This file's own functions, and the module path that names this file, so a
  // name that can only be local resolves in this file alone.
  const ownFns = new Set<string>();
  for (let i = 0; i < (root.namedChildCount ?? 0); i++) {
    const fn = root.namedChild?.(i);
    const name = fn?.type === "function" ? fn.childForFieldName?.("name")?.text : undefined;
    if (name) ownFns.add(name);
  }
  const ownModule = rel.replace(/\.gleam$/, "");
  const ownNames = new Set(defs.map((d) => d.id.slice(rel.length + 1).replace(/~\d+$/, "")));

  // A bare name in Gleam is this file's own definition, an unqualified import, or
  // a local — there is nowhere else for it to come from. So every bare edge
  // tags.scm emitted is pinned to the one module it can mean, and one that means
  // neither (a parameter being called, a prelude `Ok` or `Int`) is dropped rather
  // than left to match a same-named definition somewhere else in the repo.
  for (let i = rawEdges.length - 1; i >= 0; i--) {
    const e = rawEdges[i];
    if ((e.relation !== "calls" && e.relation !== "references") || e.specifier || !e.name) continue;
    const mod = byName.get(e.name) ?? (ownNames.has(e.name) ? ownModule : undefined);
    if (mod) e.specifier = mod;
    else rawEdges.splice(i, 1);
  }

  // Every name a function binds — parameters, `let`, `use` and `case` patterns,
  // at any depth. There is no scope analysis here, so a name bound ANYWHERE in
  // the function is treated as a local throughout it. Coarser than real scoping,
  // and only ever in the direction of dropping an edge.
  const boundIn = (fn: TsNode): Set<string> => {
    const bound = new Set<string>();
    const names = (n: TsNode | null | undefined): void => {
      // `thing.Busy(x)` and `x: thing.State` spell a module, not a binding.
      if (!n || n.type === "remote_constructor_name" || n.type === "remote_type_identifier") return;
      if (n.type === "identifier") bound.add(n.text);
      // `Busy(since:)` is shorthand for `Busy(since: since)` — the label binds.
      if (n.type === "record_pattern_argument" && n.namedChildCount === 1 && n.namedChild?.(0)?.type === "label")
        bound.add(n.namedChild(0)!.text);
      for (let i = 0; i < (n.namedChildCount ?? 0); i++) names(n.namedChild?.(i));
    };
    const walk = (n: TsNode): void => {
      if (n.type === "function_parameters" || n.type === "use_assignments" || n.type === "case_clause_patterns") names(n);
      else if (n.type === "let" || n.type === "let_assert") names(n.childForFieldName?.("pattern"));
      for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
        const c = n.namedChild?.(i);
        if (c) walk(c);
      }
    };
    walk(fn);
    return bound;
  };
  const same = (a: TsNode | null | undefined, b: TsNode): boolean =>
    !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
  // `xs |> thing.helper` — the right of a pipe is applied, with or without `()`.
  const piped = (n: TsNode, parent: TsNode | null): boolean =>
    parent?.type === "binary_expression" &&
    parent.childForFieldName?.("operator")?.type === "|>" &&
    same(parent.childForFieldName?.("right"), n);
  // Where a bare name is a value being handed on rather than a binding or a call.
  const passed = (n: TsNode, parent: TsNode | null): boolean =>
    parent?.type === "argument" || parent?.type === "list" || parent?.type === "tuple" ||
    ((parent?.type === "let" || parent?.type === "let_assert") && same(parent.childForFieldName?.("value"), n));

  const NONE = new Set<string>();
  // The ways a Gleam file names something in another module. All carry the
  // qualifier, so all get scoped to one file rather than guessed by name.
  const emit = (
    qualifier: TsNode | null,
    name: TsNode | null,
    relation: "calls" | "references",
    locals: Set<string> = NONE,
  ): void => {
    // Only a bare identifier can be a module qualifier. `field_access` is also how
    // the grammar spells record access, so `cfg.handler.run()` is a field chain,
    // and a qualifier no import bound is a record field holding a function.
    // Neither names a module, and neither gets a guessed edge.
    const mod =
      qualifier?.type === "identifier" && name && !locals.has(qualifier.text) ? byQualifier.get(qualifier.text) : undefined;
    if (!mod || !name) return;
    const enc = enclosingDef(defs, name.startIndex);
    if (relation === "references" && !enc) return; // no sound source to hang it on
    rawEdges.push({ source: enc ? enc.id : rel, relation, file: rel, name: name.text, specifier: mod });
  };
  const visit = (n: TsNode, parent: TsNode | null, bound: Set<string>): void => {
    if (n.type === "function") bound = boundIn(n);
    if (n.type === "function_call") {
      // `list.map(…)` — a remote function call.
      const fn = n.childForFieldName?.("function");
      if (fn?.type === "field_access")
        emit(fn.childForFieldName?.("record") ?? null, fn.childForFieldName?.("field") ?? null, "calls");
    } else if (n.type === "field_access") {
      // `thing.helper` with no call around it: applied when it sits on the right
      // of a pipe, otherwise named as a value — a callback (`list.map(xs,
      // thing.helper)`) or a constant (`thing.limit`). Either way the module's
      // symbol is in use, and without the edge it reads as dead code.
      //
      // A local may share the module's name (`fn show(user: User)` under `import
      // app/user`), and Gleam then reads `user.x` as the record's field first and
      // the module's `x` only if there is no such field. Applied, that is nearly
      // always the module (`user.to_string(user)`), so calls keep their edge; read
      // as a value it is nearly always the field (`user.name`), so that is dropped.
      if (!(parent?.type === "function_call" && same(parent.childForFieldName?.("function"), n))) {
        const record = n.childForFieldName?.("record") ?? null;
        const field = n.childForFieldName?.("field") ?? null;
        if (piped(n, parent)) emit(record, field, "calls");
        else emit(record, field, "references", bound);
      }
    } else if (n.type === "identifier" && !bound.has(n.text)) {
      // The same two shapes for a bare name, which is only ever this file's own
      // function or an unqualified import — anything a local could be is dropped.
      const enc = enclosingDef(defs, n.startIndex);
      const mod = byName.get(n.text) ?? (ownFns.has(n.text) ? ownModule : undefined);
      if (!mod || !enc || enc.id === `${rel}#${n.text}`) {
        // not a function this file can name, or the function naming itself
      } else if (piped(n, parent)) {
        rawEdges.push({ source: enc.id, relation: "calls", file: rel, name: n.text, specifier: mod });
      } else if (passed(n, parent)) {
        rawEdges.push({ source: enc.id, relation: "references", file: rel, name: n.text, specifier: mod });
      }
    } else if (n.type === "remote_constructor_name") {
      // `thing.Busy(since: 1)`, a record update, or a `case` pattern — all apply
      // or take apart the same callable, the way the local forms do in tags.scm.
      emit(n.childForFieldName?.("module") ?? null, n.childForFieldName?.("name") ?? null, "calls");
    } else if (n.type === "remote_type_identifier") {
      // `thing.State` in an annotation — names the type without calling it.
      emit(n.childForFieldName?.("module") ?? null, n.childForFieldName?.("name") ?? null, "references");
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
      const c = n.namedChild?.(i);
      if (c) visit(c, n, bound);
    }
  };
  visit(root, null, NONE);
}

/** Elixir: module-scoped alias resolution for remote calls.
 *
 * The tags query captures `Cart.total(x)` as the bare name `total` (the `dot`'s right
 * identifier) and throws the receiver away, so resolve.ts has to drop it as ambiguous the
 * moment a second `total` exists anywhere in the repo — which in Elixir is always. This pass
 * re-walks the tree with a `defmodule` scope stack and each scope's `alias` table and
 * emits the remote call receiver-typed (`recvType` = the aliased module's full name), so
 * `resolveTypedMember` settles it through the ownerMethod index. It also stamps each `def*`
 * with its module (`owner`) and arity — what populates that index for Elixir — and each
 * module with its full name (`fqn`; a nested module's `name` is the bare last segment).
 *
 * Handled: `alias A.B.C`, `as:`, `alias A.{B, C}`, `alias __MODULE__.{..}`, `defmodule`
 * under an aliased prefix, nested-`defmodule` auto-aliases, `__MODULE__.fun()`, `&Mod.fun/N`
 * captures, and the extra argument a `|>` supplies. Not handled (needs the compiler):
 * `import`, macro-generated functions (resolve.ts lands those on the module node),
 * `apply/3`, module attributes as receivers. An alias declared inside a function body is
 * treated as module-scoped (leaks forward): over-approximates rather than under-resolves. */
function extractElixir(root: TsNode, rel: string, nodes: NodeV1[], defs: Def[], rawEdges: RawEdge[]): void {
  const DEF_HEADS = new Set([
    "def", "defp", "defmacro", "defmacrop", "defguard", "defguardp", "defdelegate", "defn", "defnp",
  ]);
  const defByStart = new Map(defs.map((d) => [d.startIndex, d]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const enclosing = (at: number): Def | undefined =>
    defs
      .filter((d) => d.startIndex <= at && at < d.endIndex)
      .sort((a, b) => a.endIndex - a.startIndex - (b.endIndex - b.startIndex))[0];
  const kids = (n: TsNode): TsNode[] => {
    const out: TsNode[] = [];
    const count = n.namedChildCount ?? 0;
    for (let i = 0; i < count; i++) {
      const c = n.namedChild?.(i);
      if (c) out.push(c);
    }
    return out;
  };
  const field = (n: TsNode | null | undefined, k: string): TsNode | null =>
    n?.childForFieldName?.(k) ?? null;

  type Scope = { fqn: string | null; aliases: Map<string, string> };
  const scopes: Scope[] = [{ fqn: null, aliases: new Map() }];
  const cur = (): Scope => scopes[scopes.length - 1];
  const lookup = (first: string): string | null => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const v = scopes[i].aliases.get(first);
      if (v) return v;
    }
    return null;
  };
  // "Cart.Sub" → "Shop.Checkout.Cart.Sub" when `Cart` is aliased; else as written.
  const expand = (text: string): string => {
    const segs = text.split(".");
    const hit = lookup(segs[0]);
    return hit ? [hit, ...segs.slice(1)].join(".") : text;
  };
  const argsOf = (call: TsNode): TsNode | null => kids(call).find((c) => c.type === "arguments") ?? null;
  const headOf = (call: TsNode): string | null => {
    const t = field(call, "target");
    return t?.type === "identifier" ? t.text : null;
  };
  const opOf = (n: TsNode | null): string | null => field(n, "operator")?.text ?? null;
  // The module a `dot`'s left side names, fully qualified; null when it isn't a module
  // (a variable receiver, a map access, an erlang atom).
  const receiverOf = (left: TsNode): string | null => {
    if (left.type === "alias") return expand(left.text);
    if (left.type === "identifier" && left.text === "__MODULE__") return cur().fqn;
    if (left.type === "dot") {
      const l = field(left, "left"), r = field(left, "right");
      const fqn = cur().fqn;
      const isSelf = l?.type === "identifier" && l.text === "__MODULE__";
      if (fqn && isSelf && r?.type === "alias") return `${fqn}.${r.text}`;
    }
    return null;
  };
  const recordAlias = (args: TsNode): void => {
    let asName: string | null = null;
    const kw = kids(args).find((c) => c.type === "keywords");
    if (kw) {
      for (const pair of kids(kw)) {
        const [k, v] = kids(pair);
        if (k?.text.trim() === "as:" && v?.type === "alias") asName = v.text;
      }
    }
    const first = kids(args)[0];
    if (!first) return;
    if (first.type === "alias") {
      const segs = first.text.split(".");
      cur().aliases.set(asName ?? segs[segs.length - 1], expand(first.text));
      return;
    }
    if (first.type === "dot") {
      // alias A.B.{C, D}  /  alias __MODULE__.{C, D}
      const l = field(first, "left"), r = field(first, "right");
      const base =
        l?.type === "alias" ? expand(l.text)
        : l?.type === "identifier" && l.text === "__MODULE__" ? cur().fqn
        : null;
      if (!base || r?.type !== "tuple") return;
      for (const a of kids(r)) {
        if (a.type !== "alias") continue;
        const segs = a.text.split(".");
        cur().aliases.set(segs[segs.length - 1], `${base}.${a.text}`);
      }
    }
  };
  // Parameter count of a `def` head; null when a default (`\\`) makes the arity a range.
  const arityOf = (args: TsNode | null): number | null => {
    let sig: TsNode | null = args ? (kids(args)[0] ?? null) : null;
    if (!sig) return null;
    if (sig.type === "binary_operator" && opOf(sig) === "when") sig = field(sig, "left");
    if (sig?.type === "identifier") return 0;
    if (sig?.type !== "call") return null;
    const ps = argsOf(sig);
    if (!ps) return 0;
    const params = kids(ps);
    for (const p of params) if (p.type === "binary_operator" && opOf(p) === "\\\\") return null;
    return params.length;
  };
  const visit = (n: TsNode): void => {
    if (n.type === "call") {
      const head = headOf(n);
      const args = argsOf(n);
      const firstArg = args ? (kids(args)[0] ?? null) : null;
      if (head === "defmodule" && firstArg?.type === "alias") {
        // `alias Shop.Payments` … `defmodule Payments.Gateway` defines Shop.Payments.Gateway:
        // defmodule expands aliases in scope exactly like a remote call does.
        const name = expand(firstArg.text);
        const parent = cur().fqn;
        // `defmodule Foo.Bar` inside `A` defines `A.Foo.Bar` and aliases `Foo` → `A.Foo`.
        if (parent) cur().aliases.set(name.split(".")[0], `${parent}.${name.split(".")[0]}`);
        const fqn = parent ? `${parent}.${name}` : name;
        const md = defByStart.get(n.startIndex);
        const mnode = md ? nodeById.get(md.id) : undefined;
        if (mnode) mnode.fqn = fqn;
        scopes.push({ fqn, aliases: new Map() });
        for (const c of kids(n)) visit(c);
        scopes.pop();
        return;
      }
      if (head === "alias" && args) {
        recordAlias(args);
        return;
      }
      if (head && DEF_HEADS.has(head)) {
        const d = defByStart.get(n.startIndex);
        const node = d ? nodeById.get(d.id) : undefined;
        const fqn = cur().fqn;
        if (node && fqn) {
          node.owner = fqn;
          const ar = arityOf(args);
          if (ar !== null) node.arity = ar;
        }
      }
      const t = field(n, "target");
      if (t?.type === "dot") {
        const l = field(t, "left"), r = field(t, "right");
        const recv = l && r?.type === "identifier" ? receiverOf(l) : null;
        if (recv && r) {
          let argCount = args ? kids(args).length : 0;
          const p = n.parent;
          const op = p?.type === "binary_operator" ? opOf(p) : null;
          const rhs = op ? field(p, "right") : null;
          // `&Mod.fun/2`: no call args, the arity is the `/ N` operand.
          if (args && argCount === 0 && op === "/" && rhs?.type === "integer") argCount = Number(rhs.text);
          // `x |> Mod.fun(a)` supplies one more argument than written.
          if (op === "|>" && rhs?.startIndex === n.startIndex) argCount += 1;
          const enc = enclosing(r.startIndex);
          rawEdges.push({
            source: enc ? enc.id : rel, relation: "calls", file: rel, name: r.text,
            viaMember: true, recvType: recv, argCount,
          });
        }
      }
    }
    for (const c of kids(n)) visit(c);
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
    if (("reference.call" in cap || "reference.send" in cap) && cap.name) {
      // Elixir remote call (`Mod.fun`): the bare `fun` is ambiguous repo-wide by
      // construction; extractElixir re-emits it receiver-typed instead.
      if (!(langName === "elixir" && cap.name.parent?.type === "dot"))
        calls.push({ name: cap.name.text, at: cap.name.startIndex });
    }
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
  for (const c of calls) {
    if (defNameAt.has(c.at)) continue;
    const enc = enclosingDef(defs, c.at);
    rawEdges.push({ source: enc ? enc.id : rel, relation: "calls", file: rel, name: c.name });
  }
  for (const r of refs) {
    if (defNameAt.has(r.at)) continue;
    const enc = enclosingDef(defs, r.at);
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
