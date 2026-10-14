/**
 * Tier-1 extraction: source file → {@link NodeV1}[] + raw edges, via tree-sitter.
 *
 * Deterministic and dependency-only (no LLM, no network). Emits one node per
 * definition (file, class, function, method, interface, type, enum, and TS
 * arrow-function consts) plus unresolved edge intents. Edge *targets* are
 * resolved against the whole-repo node index later, in build.ts.
 */
import Parser from "tree-sitter";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { contentHash } from "../util/id.js";
import { collectBindings, goReceiverVarOf, resolveRecvType, type FileBindings } from "./bindings.js";
import type { Kind, NodeV1, Relation } from "./types.js";

export type Language = "typescript" | "tsx" | "python" | "go" | "java" | "kotlin" | "swift" | "php" | "r";

const require = createRequire(import.meta.url);

/** Where each depth-tier grammar comes from. `pick` is for the modules that
 * export more than one. */
const GRAMMAR_MODULES: Record<Language, { pkg: string; pick?: (m: Record<string, unknown>) => unknown }> = {
  typescript: { pkg: "tree-sitter-typescript", pick: (m) => m.typescript },
  tsx: { pkg: "tree-sitter-typescript", pick: (m) => m.tsx },
  python: { pkg: "tree-sitter-python" },
  go: { pkg: "tree-sitter-go" },
  java: { pkg: "tree-sitter-java" },
  kotlin: { pkg: "tree-sitter-kotlin" },
  swift: { pkg: "tree-sitter-swift" },
  php: { pkg: "tree-sitter-php", pick: (m) => m.php },
  r: { pkg: "tree-sitter-r" },
};

/**
 * These are native (node-gyp) modules, and a native module can fail to load for
 * reasons that have nothing to do with the repository being indexed: no prebuild
 * for the platform and no compiler to build one (#323), an install that skipped
 * build scripts, a binding that names its artifact wrong under another runtime.
 * Imported at the top of this module — as they were — any single one of those
 * took the whole CLI down at load time, before argv was read: `--version`,
 * `--help`, and `ask` on a repo containing no Kotlin, all dying with a
 * `node-gyp-build` stack trace that never says "graft".
 *
 * So load them the way the two WASM tiers already load theirs: a grammar that
 * will not load costs its own language, not the tool. The rest follows from
 * {@link entryFor} no longer claiming that language's extensions — those files
 * take the paths a language graft has no grammar for takes today (the breadth
 * tier where a generic row claims the extension, otherwise unindexed), and no
 * other language is affected.
 */
const GRAMMARS = {} as Record<Language, unknown>;
const UNAVAILABLE = new Map<Language, string>(); // language → why its grammar did not load
for (const lang of Object.keys(GRAMMAR_MODULES) as Language[]) {
  const { pkg, pick } = GRAMMAR_MODULES[lang];
  try {
    const mod = require(pkg) as Record<string, unknown>;
    const grammar = pick ? pick(mod) : mod;
    // A module that loads but exports no grammar would otherwise fail later,
    // inside `parser.setLanguage` — the same fault, one file at a time.
    if (!grammar) throw new Error(`${pkg} exports no grammar`);
    GRAMMARS[lang] = grammar;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    UNAVAILABLE.set(lang, why.split("\n")[0]); // node-gyp-build's message is a paragraph
  }
}

const warnedUnavailable = new Set<Language>();
/**
 * Said once per language, the first time a file that language would have claimed
 * comes past: silent in a repo that has none of those files — so one broken
 * grammar no longer makes `graft --version` noisy on a TypeScript repo — and
 * unmissable in a repo full of them, because indexing short must never be quiet.
 */
function warnUnavailable(lang: Language): void {
  if (warnedUnavailable.has(lang)) return;
  warnedUnavailable.add(lang);
  const exts = EXTENSIONS.filter((e) => e.grammar === lang).map((e) => e.ext).join("/");
  console.warn(
    `graft: ${exts} files are not parsed with their own grammar — ${GRAMMAR_MODULES[lang].pkg} failed to load ` +
      `(${UNAVAILABLE.get(lang)}). Reinstalling graft rebuilds it; every other language indexes as usual.`,
  );
}

/**
 * Extension → the tree-sitter grammar that parses it, and the label a human expects
 * to see for it.
 *
 * The two are not the same, and conflating them under-reported coverage: `.mjs` is
 * parsed by the typescript grammar, so a JS repo's build banner read `[typescript]`
 * and a `.jsx` one read `[tsx]`. Both are true about the *parser* and misleading
 * about the repo — people went looking for why their JavaScript hadn't been indexed
 * when it had, and could not tell a language that was merely unlabelled from one
 * that really was skipped (see issue #36).
 *
 * One table, both readings derived from it, so adding an extension cannot fix
 * extraction and forget the label. Ordered longest-suffix-first: `.tsx` has to be
 * tested before `.ts` would match it.
 */
const EXTENSIONS: ReadonlyArray<{ ext: string; grammar: Language; label: string }> = [
  { ext: ".tsx", grammar: "tsx", label: "tsx" },
  { ext: ".jsx", grammar: "tsx", label: "jsx" },
  { ext: ".mts", grammar: "typescript", label: "typescript" },
  { ext: ".cts", grammar: "typescript", label: "typescript" },
  { ext: ".ts", grammar: "typescript", label: "typescript" },
  { ext: ".mjs", grammar: "typescript", label: "javascript" },
  { ext: ".cjs", grammar: "typescript", label: "javascript" },
  { ext: ".js", grammar: "typescript", label: "javascript" },
  { ext: ".pyi", grammar: "python", label: "python" },
  { ext: ".py", grammar: "python", label: "python" },
  { ext: ".go", grammar: "go", label: "go" },
  { ext: ".java", grammar: "java", label: "java" },
  { ext: ".kt", grammar: "kotlin", label: "kotlin" },
  { ext: ".kts", grammar: "kotlin", label: "kotlin" },
  { ext: ".swift", grammar: "swift", label: "swift" },
  { ext: ".php", grammar: "php", label: "php" },
  // `entryFor` lower-cases the path before matching, so this one entry covers
  // both `.R` (the conventional case in real R codebases) and `.r`.
  { ext: ".r", grammar: "r", label: "r" },
];

function entryFor(path: string): (typeof EXTENSIONS)[number] | undefined {
  const p = path.toLowerCase();
  const hit = EXTENSIONS.find((e) => p.endsWith(e.ext));
  if (hit && UNAVAILABLE.has(hit.grammar)) {
    warnUnavailable(hit.grammar);
    return undefined; // no grammar to parse it with, so this tier does not claim it
  }
  return hit;
}

/** Every file extension a depth-tier (hand-written) extractor claims — minus any
 * whose grammar did not load, so `-e` validation and `supportedExtensions()`
 * answer for the install in front of the user rather than for the table. */
export function depthExtensions(): string[] {
  return EXTENSIONS.filter((e) => !UNAVAILABLE.has(e.grammar)).map((e) => e.ext);
}

/** Map a file path to a supported language, or null if unsupported. */
export function languageOf(path: string): Language | null {
  return entryFor(path)?.grammar ?? null;
}

/**
 * What to *call* the language of this file, for a banner or a repo map — or null when
 * the file isn't indexed at all, which is the distinction {@link languageOf} shares
 * and the one that matters to a reader checking coverage.
 */
export function languageLabelOf(path: string): string | null {
  return entryFor(path)?.label ?? null;
}

/**
 * An edge whose target isn't resolved yet. build.ts turns these into EdgeV1 by
 * matching `name`/`specifier` against the repo-wide node index.
 */
export interface RawEdge {
  source: string; // resolved node id
  relation: Relation;
  file: string; // the file this edge originates in (scopes name resolution)
  targetId?: string; // already-resolved target (contains)
  specifier?: string; // module path to resolve (imports / imported-symbol references)
  name?: string; // symbol name to resolve (extends/implements/calls)
  viaMember?: boolean; // calls: was it `obj.foo()` (→ prefer method targets)?
  /** calls with viaMember: the receiver's resolved type name (from bindings /
   * self / this / Go receiver), when a confident local clue exists. */
  recvType?: string;
  /** calls without viaMember: which kinds the bare-name match may resolve to.
   * Every other language's bare-name call is always a free function, so this
   * is absent for them (resolve.ts defaults to `["function"]`). R (Phase 4) is
   * the one exception: `obj$method()` with an untyped receiver (not
   * self/private/super, which already resolve precisely via viaMember+recvType)
   * still has a real shot at a correct match if the method name happens to be
   * uniquely defined across the repo — R6 methods are kind "method", not
   * "function", so without this override every such call would be
   * unconditionally unresolvable rather than just occasionally ambiguous. */
  kinds?: Kind[];
  /** calls: the number of arguments at the CALL SITE. Only emitted for languages
   * with overloading (Java, Swift), where a same-named sibling on the same class is
   * otherwise indistinguishable — and picking wrong turns a delegating overload
   * into a self-loop. */
  argCount?: number;
  /** Swift only: a bare lowercase call inside a type body, which the language
   * resolves member-first (inner scope wins). The edge carries the member
   * reading (viaMember + recvType = the enclosing type); this flag lets
   * resolve.ts fall back to the free-function reading when the owner chain has
   * no such member — and ONLY then, so a name defined as both a member and a
   * free function yields the member edge alone, exactly as Swift dispatches it. */
  implicitSelf?: boolean;
}

export interface ExtractResult {
  nodes: NodeV1[];
  rawEdges: RawEdge[];
}

/** Max chars of normalized body stored per symbol for search. Large enough that
 * essentially every real definition is stored whole — only a rare giant function
 * is clipped — while bounding how much the committed graph can grow. */
const MAX_BODY_CHARS = 5000;

/** Cap for a file node's module-level residual (imports, constants, module
 * docstring — everything not inside a symbol). Higher than the per-symbol cap
 * because a data-heavy module (constant tables, big config dicts) is legitimate
 * residual, and it's the recall play — but still bounded. */
const MAX_FILE_BODY_CHARS = 16000;

/** The searchable body of a definition: its source text, whitespace-collapsed
 * so every identifier becomes a token, capped at `max`. Search-only — the agent
 * still reads verbatim source via `ask --source`, which slices the file from
 * disk, so nothing here reaches the agent's context. */
function searchBody(text: string, max = MAX_BODY_CHARS): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length > max ? norm.slice(0, max) : norm;
}

/** A file's module-level residual: the lines NOT covered by any symbol span.
 * Symbol bodies are already indexed on their own nodes, so this captures only
 * what they miss — top-of-file imports, module constants, module docstrings —
 * making a file findable by a term that lives outside every function/class.
 * `symbols` are the file's emitted nodes (with `Lx-Ly` spans); `source` is the
 * whole file. Far leaner than storing full-file bodies (no symbol duplication). */
function fileResidual(source: string, symbols: NodeV1[]): string {
  const lines = source.split("\n");
  const covered = new Uint8Array(lines.length + 2);
  for (const s of symbols) {
    const m = s.span.match(/^L(\d+)-L(\d+)$/);
    if (!m) continue;
    for (let r = Number(m[1]); r <= Number(m[2]) && r < covered.length; r++) covered[r] = 1;
  }
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) if (!covered[i + 1]) kept.push(lines[i]);
  return searchBody(kept.join(" "), MAX_FILE_BODY_CHARS);
}

const TS_KINDS: Record<string, Kind> = {
  class_declaration: "class",
  abstract_class_declaration: "class",
  function_declaration: "function",
  generator_function_declaration: "function",
  method_definition: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
};

const PY_KINDS: Record<string, Kind> = {
  class_definition: "class",
  function_definition: "function", // → "method" inside a class (resolved in the walk)
};

// Go: `type_spec` is intentionally absent — its kind (struct/interface/type) depends on
// the named type's shape, so it's resolved dynamically in describe().
const GO_KINDS: Record<string, Kind> = {
  function_declaration: "function",
  method_declaration: "method",
};

// R: `function_definition` carries no name field at all (unlike every other
// supported language) — its identifier always comes from context (an
// assignment's other side), resolved dynamically in describeR(). Empty, like
// Go's own table — never consulted, kept only to satisfy KINDS_BY_LANG's type.
const R_KINDS: Record<string, Kind> = {};
// Java: a record is a nominal data carrier, so it takes "struct" — the same role
// Go's struct plays — rather than "class", which would make a service and a DTO
// indistinguishable in a repo where DTOs are most of the type surface.
const JAVA_KINDS: Record<string, Kind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "struct",
  annotation_type_declaration: "interface",
  annotation_type_element_declaration: "method",
  method_declaration: "method",
  constructor_declaration: "method",
};

/** Java type declarations: they set `enclosingClass` for the methods nested in them,
 * which "class"-only logic would miss for a record's or interface's members. */
const JAVA_TYPE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["class", "interface", "enum", "struct"]);

const KOTLIN_KINDS: Record<string, Kind> = {
  class_declaration: "class", // → "interface" / "enum" / "interface" (annotation) in describeKotlin
  object_declaration: "class", // a singleton object is class-like (companion objects included)
  function_declaration: "function", // → "method" inside a type (resolved in the walk)
  secondary_constructor: "method", // the class's own secondary constructor
  type_alias: "type",
  property_declaration: "variable", // top-level `val`/`var` only (fields resolved in the walk)
};

/** Kotlin type declarations: they set `enclosingClass` for the members nested in them.
 * "class" also covers object_declaration (it maps to "class"); interface/enum are the
 * same class_declaration node rekinded in describeKotlin, so all three land in the set. */
const KOTLIN_TYPE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["class", "interface", "enum"]);

const SWIFT_KINDS: Record<string, Kind> = {
  class_declaration: "class", // → "struct" / "enum" in describeSwift (one node type covers all five keywords)
  protocol_declaration: "interface",
  function_declaration: "function", // → "method" inside a type (resolved in the walk)
  protocol_function_declaration: "method", // a protocol requirement is always a member
  init_declaration: "method", // the type's own initializer (named after it, like a Java constructor)
  typealias_declaration: "type",
  property_declaration: "variable", // top-level `let`/`var` only (fields resolved in the walk)
};

/** Swift type declarations: they set `enclosingClass` for the members nested in them.
 * class/struct/enum are the same class_declaration node rekinded in describeSwift
 * (an actor takes "class"); protocols are "interface". "module" is an extension
 * body — a member-contributing scope named after the extended type, deliberately
 * NOT a type kind in the graph so it can never make the real declaration's name
 * ambiguous (see describeSwift's extension branch) — but its members still
 * promote to methods owned by that type, which is why it belongs in this set. */
const SWIFT_TYPE_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "class",
  "struct",
  "enum",
  "interface",
  "module",
]);

// PHP: definition node types are all distinct (no py-style function→method
// promotion needed — a class body uses `method_declaration`, not
// `function_definition`). `trait_declaration` maps to the PHP-only `trait` kind.
const PHP_KINDS: Record<string, Kind> = {
  function_definition: "function",
  method_declaration: "method",
  class_declaration: "class",
  interface_declaration: "interface",
  trait_declaration: "trait",
  enum_declaration: "enum",
};

const KINDS_BY_LANG: Record<Language, Record<string, Kind>> = {
  typescript: TS_KINDS,
  tsx: TS_KINDS,
  python: PY_KINDS,
  go: GO_KINDS,
  r: R_KINDS,
  java: JAVA_KINDS,
  kotlin: KOTLIN_KINDS,
  swift: SWIFT_KINDS,
  php: PHP_KINDS,
};

/**
 * The node type(s) that constitute a call site, per language.
 *
 * Java is the reason this is a set rather than a string: `method_invocation` and
 * `object_creation_expression` (`new Foo()`) are separate node types, and a Java
 * codebase's constructor calls are a large share of its real edges. PHP is
 * likewise multi-shape: a call is a function / member / nullsafe-member / scoped
 * call, never a single `call_expression`.
 */
const CALL_TYPES: Record<Language, ReadonlySet<string>> = {
  typescript: new Set(["call_expression"]),
  tsx: new Set(["call_expression"]),
  python: new Set(["call"]),
  go: new Set(["call_expression"]),
  java: new Set(["method_invocation", "object_creation_expression"]),
  kotlin: new Set(["call_expression"]),
  swift: new Set(["call_expression"]),
  php: new Set([
    "function_call_expression",
    "member_call_expression",
    "nullsafe_member_call_expression",
    "scoped_call_expression",
  ]),
  r: new Set(["call"]),
};

const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function",
  "function_expression",
  "generator_function",
]);

const EMPTY_SET: ReadonlySet<string> = new Set();

const parser = new Parser();

export interface WalkCtx {
  rel: string;
  source: string;
  lang: Language;
  kinds: Record<string, Kind>;
  scope: string[]; // enclosing definition names, for id scoping
  enclosingKind: Kind | null; // kind of the nearest enclosing definition
  parentId: string; // nearest enclosing definition id, or the file id
  bindings: FileBindings; // variable/field -> type, for receiver-type lookups
  enclosingClass: string | null; // nearest enclosing class (py/ts `self`/`this`)
  goReceiverVar: string | null; // Go receiver var, e.g. `w` in `func (w *Worker)`
  importedSymbols: ReadonlyMap<string, { name: string; specifier: string }>;
  // R6 (Phase 2): which list we're inside while walking an `R6Class(...)` call's
  // arguments — set only for the direct span of a `public =`/`private =`/
  // `active =` `list(...)`'s own entries (see walk()'s special-cased `argument`
  // interception), null everywhere else including inside a method's own body.
  rR6Access: "public" | "private" | "active" | null;
  // R (Phase 2): S3 generics registered in THIS file via a local `UseMethod()`
  // call, precomputed once per file (see collectRGenerics). A `name.Class`
  // assignment only becomes an S3 method if `name` is in this set or the
  // curated base-R generics list — see describeR's doc comment for the
  // ambiguity this guards against (`read.csv` is not S3 dispatch).
  rGenerics: ReadonlySet<string>;
  // R6 (Phase 3): the immediate parent class's name (from `inherit =`) for the
  // R6 class we're currently inside, so a `super$method()` call in any of its
  // methods' bodies can resolve directly to the PARENT's method instead of
  // (wrongly) the current class's own same-named override. Unlike rR6Access,
  // this is NOT reset when descending into a method — it needs to stay live
  // for the method's whole body, only changing when a genuinely different
  // class is entered. Null outside any class, or for a class with no parent.
  rSuperClass: string | null;
}

/** A definition we're about to emit, normalized across the shapes we handle. */
interface DefDescriptor {
  name: string; // the bare symbol name (used for the node's `name` and call resolution)
  idName?: string; // id-scope segment when it differs from `name` (Go: `Receiver.method`)
  kind: Kind;
  headerEnd: number; // char index where the signature ends (body starts)
  hashNode: Parser.SyntaxNode; // node whose text forms body_hash / span
  // A method whose owner can't be read off ctx.enclosingClass because the
  // definition doesn't lexically nest inside its class (R's S3/S4 methods sit
  // at file/top scope, dispatched by name/argument rather than nesting — same
  // idea as Go's receiver-qualified methods). R6 methods DO nest (inside the
  // class-defining call's own public=/private=/active= lists) and rely on the
  // ordinary ctx.enclosingClass fallback instead, so they leave this unset.
  owner?: string;
  arity?: number; // declared parameter count — overload disambiguation (Java)
  variadic?: boolean; // last parameter is a vararg, so `arity` is a minimum
}

/** tree-sitter's string `parse()` fails with "Invalid argument" on any input
 * ≥ 32 KB, which silently drops large files — often the most important ones (a
 * 2000-line command module, a core tab implementation). The callback form has
 * no such limit as long as each returned chunk is under 32 KB, so we always feed
 * the source in <32 KB slices. Code-unit indexing matches `String.slice`. */
const PARSE_CHUNK = 16384;
function parseSource(source: string): Parser.SyntaxNode {
  return parser.parse((index: number) => source.slice(index, index + PARSE_CHUNK)).rootNode;
}

export function extractFile(rel: string, source: string, lang: Language): ExtractResult {
  parser.setLanguage(GRAMMARS[lang] as never);
  const root = parseSource(source);
  const bindings = collectBindings(root, lang);
  const importedSymbols = collectImportedSymbols(root, lang);
  const rGenerics = lang === "r" ? collectRGenerics(root) : EMPTY_SET;

  const nodes: NodeV1[] = [
    {
      id: rel,
      name: basename(rel),
      kind: "file",
      path: rel,
      span: `L1-L${root.endPosition.row + 1}`,
      signature: null,
      exported: true,
      origin: "ast",
      body_hash: contentHash(source),
      chars: source.length,
      summary_state: "pending",
      summary: null,
      crux: null,
    },
  ];
  const rawEdges: RawEdge[] = [];

  const ctx: WalkCtx = {
    rel,
    source,
    lang,
    kinds: KINDS_BY_LANG[lang],
    scope: [],
    enclosingKind: null,
    parentId: rel,
    bindings,
    enclosingClass: null,
    goReceiverVar: null,
    importedSymbols,
    rR6Access: null,
    rGenerics,
    rSuperClass: null,
  };
  // Every id minted this file, seeded with the file node's own id (`rel`) so a
  // top-level definition can never collide with it. Threaded as its own
  // parameter rather than living on WalkCtx — WalkCtx is spread into every
  // childCtx, so a by-ref Set there would read as ordinary inherited context
  // when it's actually accidental shared mutable state across the whole walk.
  const minted = new Set<string>([rel]);
  walkNamedChildren(root.namedChildren, ctx, nodes, rawEdges, minted);
  // nodes[0] is the file node; the rest are its symbols. Index the module-level
  // residual on the file node so a term outside every symbol still surfaces it.
  nodes[0].body_text = fileResidual(source, nodes.slice(1));
  return { nodes, rawEdges };
}

/** Mint-time uniqueness: a document-order duplicate (same name reopened, or two
 * sibling defs that happen to collide) gets `~2`, `~3`, ... instead of silently
 * shadowing the first. The while-loop (not a single `~2` guess) is what makes
 * this collision-proof: a source name that itself ends in ~N would collide
 * with a single-guess suffix, so this keeps incrementing until it finds a
 * truly free id rather than trusting one candidate suffix is unused. */
export function mintId(base: string, minted: Set<string>): string {
  let id = base;
  let k = 2;
  while (minted.has(id)) id = `${base}~${k++}`;
  minted.add(id);
  return id;
}

/**
 * tree-sitter-php 0.23.x cannot parse a `const` inside an enum body (#145). An
 * array initializer collapses the whole `enum_declaration` into ERROR; the
 * method is recovered as a sibling `function_definition`. 0.24.2 parses this
 * natively but is ABI 15 and cannot load on Graft's tree-sitter 0.21.1.
 *
 * Bound: only an ERROR that already contains `enum_case` + `name` is treated as
 * a collapsed enum. Only `const_declaration` / `function_definition` /
 * `method_declaration` / ERROR siblings are absorbed, stopping at a `}` ERROR.
 * Unknown ERROR nodes are still walked, never mapped to a type. Clean
 * class/enum trees are `class_declaration` / `enum_declaration` and skip this.
 */
function phpCollapsedEnumName(node: Parser.SyntaxNode): string | null {
  if (node.type !== "ERROR") return null;
  if (!node.namedChildren.some((c) => c.type === "enum_case")) return null;
  return node.namedChildren.find((c) => c.type === "name")?.text ?? null;
}

function phpCollapsedEnumHold(node: Parser.SyntaxNode): boolean {
  return (
    node.type === "const_declaration" ||
    node.type === "function_definition" ||
    node.type === "method_declaration" ||
    node.type === "ERROR"
  );
}

function phpCollapsedEnumClose(node: Parser.SyntaxNode): boolean {
  return node.type === "ERROR" && node.text.trim() === "}";
}

function walkNamedChildren(
  children: Parser.SyntaxNode[],
  ctx: WalkCtx,
  out: NodeV1[],
  edges: RawEdge[],
  minted: Set<string>,
): void {
  if (ctx.lang !== "php") {
    for (const child of children) walk(child, ctx, out, edges, minted);
    return;
  }
  for (let i = 0; i < children.length; ) {
    const n = children[i]!;
    const enumName = phpCollapsedEnumName(n);
    if (enumName) {
      const group: Parser.SyntaxNode[] = [n];
      let j = i + 1;
      while (j < children.length && phpCollapsedEnumHold(children[j]!)) {
        const next = children[j]!;
        group.push(next);
        j++;
        if (phpCollapsedEnumClose(next)) break;
      }
      emitPhpCollapsedEnum(enumName, n, group, ctx, out, edges, minted);
      i = j;
      continue;
    }
    walk(n, ctx, out, edges, minted);
    i++;
  }
}

function emitPhpCollapsedEnum(
  name: string,
  errorNode: Parser.SyntaxNode,
  group: Parser.SyntaxNode[],
  ctx: WalkCtx,
  out: NodeV1[],
  edges: RawEdge[],
  minted: Set<string>,
): void {
  const last = group[group.length - 1]!;
  const id = mintId(`${ctx.rel}#${[...ctx.scope, name].join(".")}`, minted);
  const body = ctx.source.slice(errorNode.startIndex, last.endIndex);
  out.push({
    id,
    name,
    kind: "enum",
    path: ctx.rel,
    span: `L${errorNode.startPosition.row + 1}-L${last.endPosition.row + 1}`,
    signature: `enum ${name}`,
    exported: true,
    origin: "ast",
    body_hash: contentHash(body),
    body_text: searchBody(body),
    summary_state: "pending",
    summary: null,
    crux: null,
  });
  edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
  const childCtx: WalkCtx = {
    ...ctx,
    scope: [...ctx.scope, name],
    enclosingKind: "enum",
    parentId: id,
  };
  for (const g of group) {
    if (phpCollapsedEnumClose(g)) continue;
    if (phpCollapsedEnumName(g)) {
      walkNamedChildren(g.namedChildren, childCtx, out, edges, minted);
      continue;
    }
    walk(g, childCtx, out, edges, minted);
  }
}

function walk(node: Parser.SyntaxNode, ctx: WalkCtx, out: NodeV1[], edges: RawEdge[], minted: Set<string>): void {
  const desc = describe(node, ctx);
  if (desc) {
    // `idName` scopes the id (e.g. a Go method under its receiver: `#DB.Count`) while
    // `name` stays the bare symbol name so member-call resolution matches it.
    const idPart = desc.idName ?? desc.name;
    const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
    const id = mintId(base, minted);
    const isGoMethod = ctx.lang === "go" && node.type === "method_declaration";
    // The bare name of this node's OWN immediate enclosing class/receiver — for a
    // Go method that's its receiver type (methods aren't nested, so ctx.enclosingClass
    // wouldn't see it); for an R S3/S4 method it's the qualifier/class describeR
    // already resolved (desc.owner — these don't lexically nest inside their class
    // either); for every other method it's simply what the nearest ancestor class
    // already set as ctx.enclosingClass. Only method nodes carry it — resolve.ts's
    // ownerMethod index is the sole consumer (see NodeV1.owner's doc comment).
    const owner: string | undefined =
      desc.kind === "method"
        ? (isGoMethod ? (goReceiverType(node) ?? undefined) : (desc.owner ?? ctx.enclosingClass ?? undefined))
        : undefined;
    out.push({
      id,
      name: desc.name,
      kind: desc.kind,
      path: ctx.rel,
      span: `L${desc.hashNode.startPosition.row + 1}-L${desc.hashNode.endPosition.row + 1}`,
      signature: clean(ctx.source.slice(desc.hashNode.startIndex, desc.headerEnd)),
      exported:
        ctx.lang === "python"
          ? !desc.name.startsWith("_")
          : ctx.lang === "go"
            ? goExported(desc.name)
            : ctx.lang === "r"
              ? rExported(desc.name, ctx, node)
              : ctx.lang === "java"
                ? javaExported(node)
                : ctx.lang === "kotlin"
                  ? kotlinExported(node)
                  : ctx.lang === "swift"
                    ? swiftExported(node)
                    : ctx.lang === "php"
                      ? phpExported(node)
                      : tsExported(node),
      origin: "ast",
      body_hash: contentHash(desc.hashNode.text),
      body_text: searchBody(desc.hashNode.text),
      summary_state: "pending",
      summary: null,
      crux: null,
      ...(owner !== undefined ? { owner } : {}),
      ...(desc.arity !== undefined ? { arity: desc.arity } : {}),
      ...(desc.variadic ? { variadic: true } : {}),
    });
    // structural containment
    edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
    // class heritage — in Java an interface may also `extends`, and a record/enum
    // may `implements`, so every type declaration is a heritage site, not just a class.
    const javaTypeDecl = ctx.lang === "java" && JAVA_TYPE_KINDS.has(desc.kind);
    const kotlinTypeDecl = ctx.lang === "kotlin" && KOTLIN_TYPE_KINDS.has(desc.kind);
    const swiftTypeDecl = ctx.lang === "swift" && SWIFT_TYPE_KINDS.has(desc.kind);
    if (desc.kind === "class" || javaTypeDecl || kotlinTypeDecl || swiftTypeDecl)
      edges.push(...heritageEdges(node, id, ctx));
    if (ctx.lang === "php") edges.push(...phpAttributeReferenceEdges(node, id, ctx));
    if (ctx.lang === "java") edges.push(...javaAnnotationReferenceEdges(node, id, ctx));

    const enclosingClass =
      desc.kind === "class" || javaTypeDecl || kotlinTypeDecl || swiftTypeDecl
        ? desc.name
        : isGoMethod
          ? goReceiverType(node)
          : (desc.owner ?? ctx.enclosingClass);
    const childCtx: WalkCtx = {
      ...ctx,
      scope: [...ctx.scope, idPart],
      enclosingKind: desc.kind,
      parentId: id,
      enclosingClass,
      goReceiverVar: isGoMethod ? goReceiverVarOf(node) : ctx.goReceiverVar,
      importedSymbols:
        desc.kind === "function" || desc.kind === "method"
          ? withoutShadowedImports(ctx.importedSymbols, node)
          : ctx.importedSymbols,
      // Reset on every new definition — this is a purely local marker for "we're
      // still inside THIS class-defining call's own public=/private=/active=
      // argument chain," not something that should leak into a nested definition
      // (a method's own body, or — vanishingly rare but possible — another class
      // defined inside one).
      rR6Access: null,
      // Unlike rR6Access, only reset when entering a genuinely new class (so it
      // stays live through a method's whole body, where super$ / super. calls
      // actually happen) — inherited unchanged for every other definition kind.
      // Swift reads it off the declaration's own `:` clause, so `super.ping()`
      // resolves against the PARENT type, not the overriding current one.
      rSuperClass:
        desc.kind === "class"
          ? ctx.lang === "r"
            ? rR6ParentClass(node)
            : ctx.lang === "swift"
              ? swiftSuperClassName(node)
              : null
          : ctx.rSuperClass,
    };
    walkNamedChildren(node.namedChildren, childCtx, out, edges, minted);
    return;
  }

  // R6 (Phase 2): `public =`/`private =`/`active =` inside an R6Class(...) call's
  // own arguments is a `list(...)` call whose named entries become methods —
  // this is R's version of a class body, but structurally it's several levels of
  // ordinary call/argument nodes rather than a dedicated grammar construct, so it
  // needs its own interception (mirrors how every other stateful/pattern-matched
  // R construct in this walk needs one). `ctx.enclosingKind === "class"` scopes
  // this to the class-defining call's own direct structure — once we're inside
  // an actual method's body, enclosingKind has moved on to "method" and an
  // unrelated nested `list(public = list(fn = function() {}))` elsewhere won't
  // be misread as another class body.
  if (
    ctx.lang === "r" &&
    ctx.enclosingKind === "class" &&
    ctx.rR6Access === null &&
    node.type === "argument"
  ) {
    const argName = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (
      argName?.type === "identifier" &&
      (argName.text === "public" || argName.text === "private" || argName.text === "active") &&
      value?.type === "call" &&
      rCalleeName(value) === "list"
    ) {
      const access = argName.text;
      for (const entry of rCallArgs(value)) {
        walk(entry, { ...ctx, rR6Access: access }, out, edges, minted);
      }
      return;
    }
  }

  // not a definition — capture calls/imports/references, then descend with the same context
  // R's `call` node is also its ONLY vehicle for library()/require()/source() —
  // there's no separate import-statement grammar construct to key off, so isImport
  // must be checked before the generic calls path or every import call would be
  // captured as a (harmlessly unresolvable, but wrong) `calls` edge instead.
  const callTypes = CALL_TYPES[ctx.lang];
  if (isImport(node, ctx.lang)) {
    const spec = importSpecifier(node, ctx.lang);
    if (spec) edges.push({ source: ctx.rel, relation: "imports", specifier: spec, file: ctx.rel });
    // Imported identifiers are declarations, not uses. The import-binding pass
    // above already recorded them, so do not descend and emit false references.
    return;
  } else if (callTypes.has(node.type)) {
    // R6Class(...) / a Phase-5 mixin list(...) is already consumed by its
    // enclosing binary_operator as the class definition (see describeR) — the
    // walk still reaches this SAME call node again, recursing generically to
    // find its public=/private=/active= arguments (there's no other path to
    // them), and it must not ALSO be treated as an ordinary call to a
    // function literally named "R6Class"/"list".
    const consumedCallee = ctx.lang === "r" && node.type === "call" ? rCalleeName(node) : null;
    const isConsumedRClassCall =
      consumedCallee === "R6Class" || (consumedCallee === "list" && rIsMixinContainer(node));
    const callee = isConsumedRClassCall ? null : calleeName(node, ctx.lang);
    if (callee) {
      const callEdge: RawEdge = {
        source: ctx.parentId,
        relation: "calls",
        name: callee.name,
        viaMember: callee.viaMember,
        file: ctx.rel,
        ...(callee.kinds ? { kinds: callee.kinds } : {}),
      };
      // Overloading languages: the call site's argument count, to pick the right
      // overload (see RawEdge.argCount).
      const argCount =
        ctx.lang === "java" ? javaArgCount(node) : ctx.lang === "swift" ? swiftArgCount(node) : undefined;
      if (argCount !== undefined) callEdge.argCount = argCount;
      // Swift: a bare lowercase call inside a type body may be an implicit-`self`
      // member call (`walk()` for `self.walk()`), syntactically indistinguishable
      // from a free-function call — and Swift's own lookup is member-FIRST (inner
      // scope wins). So the edge is emitted as the member reading, typed to the
      // enclosing class — resolved through the owner-qualified method index and
      // the class's in-repo ancestor chain (`clearLogs()` in a test subclass
      // finds the base class's method) — with `implicitSelf` letting resolve.ts
      // fall back to the free-function reading only when no member exists on the
      // chain. One edge, both readings, language-order precedence. This is
      // deliberately NOT a bare-name kind widening: dogfooding on
      // swift-composable-architecture, a global unique-name match bound
      // `contains(element)` inside `extension Set` — a stdlib call — to an
      // unrelated type's only in-repo `contains`. And not for an UpperCamelCase
      // callee: that is an initializer call (`Text("hi")`), which takes
      // resolve.ts's class/struct/enum fallback instead — extension nodes (kind
      // "module") can never false-match it.
      const swiftImplicitSelf =
        ctx.lang === "swift" &&
        !callee.viaMember &&
        !callee.kinds &&
        ctx.enclosingClass &&
        !/^[A-Z]/.test(callee.name);
      if (swiftImplicitSelf) {
        edges.push({
          ...callEdge,
          viaMember: true,
          recvType: ctx.enclosingClass!,
          implicitSelf: true,
        });
      } else {
        const recvType = resolveRecvType(callee.receiver, ctx);
        edges.push(recvType ? { ...callEdge, recvType } : callEdge);
      }
    }
  } else if (ctx.lang === "php" && node.type === "use_declaration") {
    // Trait composition inside a class body (`use HasFactory, Notifiable;`).
    // Modelled as `implements`: like an interface, a trait is a contract of
    // behaviour the class mixes in (Graft's Relation set has no `uses`).
    for (const t of node.namedChildren) {
      if (t.type === "name" || t.type === "qualified_name") {
        edges.push({ source: ctx.parentId, relation: "implements", name: t.text.replace(/^.*\\/, ""), file: ctx.rel });
      }
    }
    return;
  } else if (
    node.type === "identifier" &&
    !isDirectCallee(node, callTypes) &&
    !isDeclarationName(node)
  ) {
    const imported = ctx.importedSymbols.get(node.text);
    if (imported) {
      edges.push({
        source: ctx.parentId,
        relation: "references",
        name: imported.name,
        specifier: imported.specifier,
        file: ctx.rel,
      });
    }
  }

  // Java anonymous class (`new Type() { … }`): tree-sitter-java has no
  // `anonymous_class` node (unlike PHP) — the body is an optional `class_body`
  // on `object_creation_expression`. Mint `{anonymous}` (mirroring PHP #144 /
  // `{closure}`) so nested methods take that owner instead of the enclosing
  // type's, which otherwise pollutes `ownerMethod` and steals real call edges
  // (#161). The constructor call edge above still fires for `new Type()`.
  if (ctx.lang === "java" && node.type === "object_creation_expression") {
    const body = node.namedChildren.find((c) => c.type === "class_body");
    if (body) {
      const idPart = "{anonymous}";
      const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
      const id = mintId(base, minted);
      out.push({
        id,
        name: "{anonymous}",
        kind: "class",
        path: ctx.rel,
        span: `L${node.startPosition.row + 1}-L${node.endPosition.row + 1}`,
        signature: clean(ctx.source.slice(node.startIndex, body.startIndex)),
        exported: false,
        origin: "ast",
        body_hash: contentHash(node.text),
        body_text: searchBody(node.text),
        summary_state: "pending",
        summary: null,
        crux: null,
      });
      edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
      // Single supertype from `new Type()`: emit `implements` so an interface
      // target resolves (adapters are the common case; a class target drops
      // under resolve's implements kind filter — drop-not-guess).
      const superName = javaConstructedTypeName(node.childForFieldName("type"));
      if (superName) {
        edges.push({ source: id, relation: "implements", name: superName, file: ctx.rel });
      }
      const anonCtx: WalkCtx = {
        ...ctx,
        scope: [...ctx.scope, idPart],
        enclosingKind: "class",
        parentId: id,
        enclosingClass: "{anonymous}",
      };
      for (const child of node.namedChildren) {
        walk(child, child.type === "class_body" ? anonCtx : ctx, out, edges, minted);
      }
      return;
    }
  }

  for (const child of node.namedChildren) walk(child, ctx, out, edges, minted);
}

/**
 * Named imports whose local binding can be recognized later as a symbol use.
 * Namespace/default imports are intentionally excluded: they do not tell us
 * the exported symbol name, so wiring them would require guessing.
 */
function collectImportedSymbols(
  root: Parser.SyntaxNode,
  lang: Language,
): Map<string, { name: string; specifier: string }> {
  if (lang === "typescript" || lang === "tsx") {
    const out = new Map<string, { name: string; specifier: string }>();
    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === "import_statement") {
        const specifier = importSpecifier(node, lang);
        if (!specifier) return;
        collectTsImportBindings(node, specifier, out);
        return;
      }
      for (const child of node.namedChildren) visit(child);
    };
    visit(root);
    return out;
  }
  if (lang === "php") return collectPhpImportedSymbols(root);
  return new Map();
}

/** PHP `use` bindings: local alias → { exported name, FQN specifier }. */
function collectPhpImportedSymbols(root: Parser.SyntaxNode): Map<string, { name: string; specifier: string }> {
  const out = new Map<string, { name: string; specifier: string }>();
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "namespace_use_declaration") {
      collectPhpUseDeclaration(node, out);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}

function collectPhpUseDeclaration(
  decl: Parser.SyntaxNode,
  out: Map<string, { name: string; specifier: string }>,
): void {
  const prefix = decl.namedChildren.find((c) => c.type === "namespace_name")?.text.replace(/\\$/, "") ?? "";
  const clauses: Parser.SyntaxNode[] = [];
  for (const child of decl.namedChildren) {
    if (child.type === "namespace_use_clause") clauses.push(child);
    if (child.type === "namespace_use_group") {
      for (const c of child.namedChildren) {
        if (c.type === "namespace_use_clause") clauses.push(c);
      }
    }
  }
  for (const clause of clauses) {
    const binding = phpUseClauseBinding(clause, prefix);
    if (binding) out.set(binding.local, { name: binding.name, specifier: binding.specifier });
  }
}

function phpUseClauseBinding(
  clause: Parser.SyntaxNode,
  prefix: string,
): { local: string; name: string; specifier: string } | null {
  const names = clause.namedChildren.filter((c) => c.type === "name");
  const qualified = clause.namedChildren.find((c) => c.type === "qualified_name");
  let fqn: string;
  let importedName: string;
  if (qualified) {
    fqn = qualified.text.replace(/^\\/, "");
    importedName = fqn.replace(/^.*\\/, "");
  } else if (names[0]) {
    importedName = names[0].text;
    fqn = prefix ? `${prefix}\\${importedName}` : importedName;
  } else {
    return null;
  }
  const alias =
    qualified && names.length >= 1
      ? names[names.length - 1].text
      : names.length >= 2
        ? names[1].text
        : undefined;
  const local = alias ?? importedName;
  return { local, name: importedName, specifier: fqn };
}

/** PHP 8 attributes on a definition → `references` edges to the attribute class. */
function phpAttributeReferenceEdges(node: Parser.SyntaxNode, sourceId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "attribute_list") continue;
    for (const group of child.namedChildren) {
      if (group.type !== "attribute_group") continue;
      for (const attr of group.namedChildren) {
        if (attr.type !== "attribute") continue;
        const ref = phpAttributeClassRef(attr, ctx);
        if (ref) {
          edges.push({
            source: sourceId,
            relation: "references",
            name: ref.name,
            ...(ref.specifier ? { specifier: ref.specifier } : {}),
            file: ctx.rel,
          });
        }
      }
    }
  }
  return edges;
}

function phpAttributeClassRef(
  attr: Parser.SyntaxNode,
  ctx: WalkCtx,
): { name: string; specifier?: string } | null {
  const nameNode =
    attr.childForFieldName("name") ??
    attr.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
  if (!nameNode) return null;
  if (nameNode.type === "qualified_name") {
    const fqn = nameNode.text.replace(/^\\/, "");
    return { name: fqn.replace(/^.*\\/, ""), specifier: fqn };
  }
  const bare = nameNode.text;
  const imported = ctx.importedSymbols.get(bare);
  if (imported) return { name: imported.name, specifier: imported.specifier };
  return { name: bare };
}

/** Java annotations on a definition → `references` edges to the annotation type. */
function javaAnnotationReferenceEdges(node: Parser.SyntaxNode, sourceId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return edges;
  for (const child of mods.namedChildren) {
    if (child.type !== "marker_annotation" && child.type !== "annotation") continue;
    const name = javaAnnotationTypeName(child);
    if (name) {
      edges.push({
        source: sourceId,
        relation: "references",
        name,
        file: ctx.rel,
      });
    }
  }
  return edges;
}

/** The type named by `@Foo` / `@a.b.Foo(...)`. Arguments are ignored (issue #89).
 * A scoped name is kept whole, matching heritage: a bare last segment would
 * false-match an unrelated in-repo type (#103). */
function javaAnnotationTypeName(anno: Parser.SyntaxNode): string | null {
  const nameNode = anno.childForFieldName("name");
  if (!nameNode) return null;
  if (nameNode.type === "identifier" || nameNode.type === "scoped_identifier") return nameNode.text;
  return null;
}

function collectTsImportBindings(
  node: Parser.SyntaxNode,
  specifier: string,
  out: Map<string, { name: string; specifier: string }>,
): void {
  if (node.type === "import_specifier") {
    const name = node.childForFieldName("name")?.text;
    const local = node.childForFieldName("alias")?.text ?? name;
    if (name && local) out.set(local, { name, specifier });
    return;
  }
  for (const child of node.namedChildren) collectTsImportBindings(child, specifier, out);
}

/**
 * Do these two wrappers stand for the same syntax node? `===` does not answer that:
 * node-tree-sitter materializes `SyntaxNode` objects on demand and caches them
 * weakly, so reaching one node twice can return two different JS objects. Comparing
 * wrappers makes a purely syntactic question depend on collector timing — two cold
 * builds of unchanged source then disagree on `references` edges (#116).
 *
 * `id` is the stable identity, unique within one tree, so the tree is compared too.
 * A `Tree` is one object per parse (unlike its nodes), so `===` is right for it.
 */
function sameSyntaxNode(
  a: Parser.SyntaxNode | null | undefined,
  b: Parser.SyntaxNode | null | undefined,
): boolean {
  return !!a && !!b && a.tree === b.tree && a.id === b.id;
}

/**
 * A parameter or local declaration wins over an import inside that function.
 * Drop that imported binding for the whole function rather than create a false
 * dependency. Nested functions are separate scopes and filter themselves.
 */
function withoutShadowedImports(
  imports: ReadonlyMap<string, { name: string; specifier: string }>,
  definition: Parser.SyntaxNode,
): ReadonlyMap<string, { name: string; specifier: string }> {
  if (imports.size === 0) return imports;
  const shadowed = new Set<string>();
  const definitionValue = definition.childForFieldName("value");
  const visit = (node: Parser.SyntaxNode): void => {
    if (!sameSyntaxNode(node, definition) && !sameSyntaxNode(node, definitionValue) && isFunctionBoundary(node)) {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") shadowed.add(name.text);
      return;
    }
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") shadowed.add(name.text);
    } else if (node.type === "required_parameter" || node.type === "optional_parameter") {
      const pattern = node.childForFieldName("pattern");
      if (pattern?.type === "identifier") shadowed.add(pattern.text);
    } else if (node.type === "identifier" && node.parent?.type === "formal_parameters") {
      shadowed.add(node.text);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(definition);
  if (![...shadowed].some((name) => imports.has(name))) return imports;
  return new Map([...imports].filter(([local]) => !shadowed.has(local)));
}

function isFunctionBoundary(node: Parser.SyntaxNode): boolean {
  return (
    node.type === "function_declaration" ||
    node.type === "generator_function_declaration" ||
    node.type === "method_definition" ||
    node.type === "arrow_function" ||
    node.type === "function_expression" ||
    node.type === "function"
  );
}

/** A direct invocation already emits a stronger `calls` edge. Java names the callee
 * in a `name` field (there is no `function` field on `method_invocation`), so both
 * spellings count. */
function isDirectCallee(node: Parser.SyntaxNode, callTypes: ReadonlySet<string>): boolean {
  const parent = node.parent;
  if (!parent || !callTypes.has(parent.type)) return false;
  return (
    sameSyntaxNode(parent.childForFieldName("function"), node) ||
    sameSyntaxNode(parent.childForFieldName("name"), node)
  );
}

/** Definition/declaration identifiers name a new binding; they do not use one. */
function isDeclarationName(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  return sameSyntaxNode(parent?.childForFieldName("name"), node);
}

/** Recognize the definition shapes: mapped node types, Go's type/method forms, and
 * TS arrow-consts. */
function describe(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (ctx.lang === "go") return describeGo(node, ctx);
  if (ctx.lang === "r") return describeR(node, ctx);
  if (ctx.lang === "java") return describeJava(node, ctx);
  if (ctx.lang === "kotlin") return describeKotlin(node, ctx);
  if (ctx.lang === "swift") return describeSwift(node, ctx);

  // PHP closures: `$h = function () {…}` / `fn() => …`, and bare callbacks
  // (`$routes->get('/x', function () {…})`). Captured as function nodes so a
  // closure-only file (a routing table, a DI container) keeps its structure
  // and the calls inside attribute to the closure, not the file.
  if (ctx.lang === "php" && (node.type === "anonymous_function" || node.type === "arrow_function")) {
    const body = node.childForFieldName("body");
    return {
      name: phpClosureName(node),
      kind: "function",
      headerEnd: body ? body.startIndex : node.endIndex,
      hashNode: node,
    };
  }

  // PHP anonymous classes (`new class implements I {…}`): minted as a class
  // node named `{anonymous}` (mirroring `{closure}`, deduplicated per file by
  // mintId). Without this the type vanished — no node, no heritage edge — and
  // its methods mis-attributed to the enclosing function (issue #144). The
  // class kind makes the walk emit heritageEdges (base_clause /
  // class_interface_clause are direct children) and own the nested methods.
  if (ctx.lang === "php" && node.type === "anonymous_class") {
    const body = node.childForFieldName("body");
    return {
      name: "{anonymous}",
      kind: "class",
      headerEnd: body ? body.startIndex : node.endIndex,
      hashNode: node,
    };
  }

  const mapped = ctx.kinds[node.type];
  if (mapped) {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    let kind = mapped;
    if (ctx.lang === "python" && mapped === "function" && ctx.enclosingKind === "class") {
      kind = "method";
    }
    // tree-sitter-php 0.23.x recovers a collapsed enum method as function_definition
    // at program scope; walkNamedChildren reparents it under the enum, and this
    // promotion is what keeps the kind `method` rather than a leaked `function`.
    if (ctx.lang === "php" && mapped === "function" && ctx.enclosingKind === "enum") {
      kind = "method";
    }
    const body = node.childForFieldName("body");
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  // TS: `const foo = (…) => …` / `const foo = function () {}`
  if ((ctx.lang === "typescript" || ctx.lang === "tsx") && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && FUNCTION_VALUE_TYPES.has(value.type)) {
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const vbody = value.childForFieldName("body");
      return {
        name,
        kind: "function",
        headerEnd: vbody ? vbody.startIndex : node.endIndex,
        hashNode: node,
      };
    }
  }
  return null;
}

/** Go definition shapes: top-level funcs, receiver methods, and named types
 * (struct / interface / type alias). Methods carry no nesting — they're qualified
 * by their receiver type (`User.Save`) so calls can resolve and cards read clearly. */
function describeGo(node: Parser.SyntaxNode, _ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "function_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const body = node.childForFieldName("body");
    return { name, kind: "function", headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  if (node.type === "method_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const recv = goReceiverType(node);
    const body = node.childForFieldName("body");
    // Bare `name` (so `recv.Method()` calls resolve); receiver-qualified `idName`
    // (so the id is `file.go#Receiver.Method` and stays unique per receiver).
    return {
      name,
      idName: recv ? `${recv}.${name}` : name,
      kind: "method",
      headerEnd: body ? body.startIndex : node.endIndex,
      hashNode: node,
    };
  }

  // `type Name <shape>` — one type_spec per name (grouped `type ( … )` yields several).
  if (node.type === "type_spec") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const type = node.childForFieldName("type");
    const kind: Kind =
      type?.type === "struct_type" ? "struct" : type?.type === "interface_type" ? "interface" : "type";
    // Header ends where the body opens (`{`) for struct/interface, else the whole node
    // (a one-line alias like `type ID int`).
    const headerEnd = type && (kind === "struct" || kind === "interface") ? type.startIndex : node.endIndex;
    return { name, kind, headerEnd, hashNode: node };
  }

  return null;
}

/**
 * R definition shapes. `function_definition` carries no name field at all, so
 * unlike every other supported language the name always comes from an
 * enclosing assignment, detected here. The plain-function assignment check
 * (op-filtering `binary_operator`, the right-assign body-swap) is duplicated
 * in bindings.ts's own `rDefName` rather than imported — same reasoning as
 * this file's Go receiver helpers: bindings.ts can't take a value import back
 * on extract.ts. bindings.ts doesn't need the S3/S4/R6 half of this at all
 * (no handleR binding collector exists — see bindings.ts's own doc comment).
 *
 * Phase 1 (flat extraction — every named function is a plain `function` node)
 * plus Phase 2 (S3/S4/R6 class awareness, R's class systems being library
 * *convention* rather than grammar syntax, unlike every other language graft
 * supports):
 *   - left-assign (`<-`/`<<-`/`=`) / right-assign (`->`/`->>`) function
 *     assignment — Phase 1's shape, see the two `binary_operator`/
 *     `function_definition` branches below. Right-assign's AST shape does NOT
 *     mirror left-assign's the way it looks like it should (confirmed
 *     empirically, not assumed — R's `->` has low enough precedence that it's
 *     absorbed into the function's own `body` field as a `binary_operator`
 *     instead of the function sitting inside an outer wrapper); only an
 *     explicitly parenthesized `(function() {}) -> foo` produces the
 *     "expected" outer-wrapping shape, which isn't specially handled (falls
 *     through as an anonymous function).
 *   - `name.Class <- function() {}` — an S3 method, IF `name` is a known
 *     generic (registered locally via `UseMethod()` in this file, or one of a
 *     curated set of common base-R generics — see `rS3Split`'s doc comment
 *     for the false-positive risk this guards against).
 *   - `Foo <- R6::R6Class("Foo", public = list(...), private = list(...))` —
 *     an R6 class; its `public =`/`private =`/`active =` list entries become
 *     methods, handled by walk()'s own `argument`-node interception (this
 *     function only recognizes the class itself; the "a call defines a
 *     symbol" list-walking lives in walk() since it needs to mint several
 *     nodes, not describe a single one).
 *   - `Foo <- list(public = list(...), private = list(...))` (Phase 5) — a
 *     plain-list "mixin"/"extension" bundle, NOT wrapped in `R6::R6Class(...)`
 *     at all: a real, deliberate convention found dogfooding against a real
 *     R6-heavy corpus (25 files, 11 of them entirely invisible to the graph
 *     without this) for sharing method bundles across classes via splicing
 *     (`public = c(Foo$public, list(...))`) rather than `inherit =`. Only
 *     recognized when the list actually has a `public =`/`private =` entry
 *     (see `rIsMixinContainer`) — an ordinary data/config list never matches.
 *     Reuses kind "class" (nothing better-fitting exists, and everything
 *     downstream — the method-list walking, visibility — only cares that
 *     ctx.enclosingKind is "class", not how the container was spelled); no
 *     heritage edge, since splicing isn't `inherit =`-based inheritance.
 *   - `setClass("Foo", ...)` / `setMethod("generic", "Foo", function() {})`
 *     — S4 class/method calls, recognized as bare top-level `call` nodes
 *     (setClass/setMethod have side effects registering with the S4 system;
 *     they're essentially never assigned to a variable). `setGeneric()` is
 *     NOT specially extracted — it doesn't naturally map to a class or method
 *     kind, and the plan flags it as a case not worth the design risk.
 */
function describeR(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "binary_operator") {
    const op = node.childForFieldName("operator")?.text;
    if (!op || !R_ASSIGN_OPS.has(op)) return null;
    const lhs = node.childForFieldName("lhs");
    const rhs = node.childForFieldName("rhs");
    if (lhs?.type !== "identifier") return null;
    if (rhs?.type === "function_definition") {
      return rFunctionDescriptor(lhs.text, rhs, rhs.childForFieldName("body"), ctx);
    }
    if (rhs?.type === "call" && rCalleeName(rhs) === "R6Class") {
      // The class node itself; its public=/private=/active= method lists are
      // handled by walk()'s own `argument`-node interception, not here.
      return { name: lhs.text, kind: "class", headerEnd: rhs.endIndex, hashNode: rhs };
    }
    if (rhs?.type === "call" && rCalleeName(rhs) === "list" && rIsMixinContainer(rhs)) {
      // Phase 5: a plain-list mixin/extension bundle — same treatment as R6Class.
      return { name: lhs.text, kind: "class", headerEnd: rhs.endIndex, hashNode: rhs };
    }
    return null;
  }

  if (node.type === "function_definition") {
    // Right-assign (`function() {} -> foo`): see this function's own doc
    // comment for why this doesn't mirror the binary_operator branch above.
    const body = node.childForFieldName("body");
    if (body?.type !== "binary_operator") return null;
    const op = body.childForFieldName("operator")?.text;
    if (!op || !R_RIGHT_ASSIGN_OPS.has(op)) return null;
    const rhs = body.childForFieldName("rhs");
    if (rhs?.type !== "identifier") return null;
    return rFunctionDescriptor(rhs.text, node, body.childForFieldName("lhs"), ctx);
  }

  if (node.type === "call") {
    return describeRTopLevelCall(node);
  }

  // R6 (Phase 2): reached via walk()'s own `argument`-node interception for a
  // `public =`/`private =`/`active =` list entry — see the special case there
  // for why this can't just be a flat kind-table/node-type check like every
  // other definition shape.
  if (node.type === "argument" && ctx.rR6Access !== null) {
    const argName = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (argName?.type !== "identifier" || value?.type !== "function_definition") return null;
    const body = value.childForFieldName("body");
    return {
      name: argName.text,
      kind: "method",
      headerEnd: body ? body.startIndex : value.endIndex,
      hashNode: value,
      // owner deliberately unset — R6 methods DO lexically nest inside the
      // class-defining call, so ctx.enclosingClass already has it.
    };
  }

  return null;
}

const R_ASSIGN_OPS = new Set(["<-", "<<-", "="]);
const R_RIGHT_ASSIGN_OPS = new Set(["->", "->>"]);

/** A plain function assignment (left- or right-assign), OR — if `name` matches
 * a known S3 generic's `generic.Class` pattern — an S3 method instead. `body`
 * is the function's REAL content node (already resolved by the caller for
 * either assignment direction), used only for `headerEnd`; `hashNode` is
 * always the `function_definition` itself. */
function rFunctionDescriptor(
  name: string,
  hashNode: Parser.SyntaxNode,
  body: Parser.SyntaxNode | null | undefined,
  ctx: WalkCtx,
): DefDescriptor {
  const headerEnd = body ? body.startIndex : hashNode.endIndex;
  const s3 = rS3Split(name, ctx.rGenerics);
  if (s3) {
    return {
      name: s3.generic,
      idName: `${s3.className}.${s3.generic}`,
      kind: "method",
      headerEnd,
      hashNode,
      owner: s3.className,
    };
  }
  return { name, kind: "function", headerEnd, hashNode };
}

/**
 * S3 dispatch detection: does `name` split as `generic.Class` for some KNOWN
 * generic? Tries the longest possible generic prefix first (so a dotted
 * generic itself, like `as.character`, is found before a shorter false match)
 * and only ever matches a generic that's either registered locally via
 * `UseMethod()` in this file (see `collectRGenerics`) or in the small curated
 * `R_BASE_GENERICS` set below.
 *
 * This is the genuinely ambiguous part of R support the plan calls out:
 * `read.csv`, `data.frame`, and `as.character` used as an ordinary helper
 * name are NOT S3 dispatch, and nothing in the grammar distinguishes them
 * from `print.MyClass`. Erring toward the curated set staying small — a
 * missed S3 method (false negative, falls back to an ordinary `function`
 * node) is a much smaller problem than a false positive misfiling an
 * unrelated dotted-name function as some other class's method.
 */
function rS3Split(name: string, generics: ReadonlySet<string>): { generic: string; className: string } | null {
  const parts = name.split(".");
  if (parts.length < 2) return null;
  for (let i = parts.length - 1; i >= 1; i--) {
    const generic = parts.slice(0, i).join(".");
    if (generics.has(generic) || R_BASE_GENERICS.has(generic)) {
      return { generic, className: parts.slice(i).join(".") };
    }
  }
  return null;
}

/** Common base-R S3 generics worth assuming even without local evidence —
 * print.Foo/format.Foo etc. are the single most common real-world S3
 * pattern, and a local `UseMethod()` call will never exist for them (they
 * ship in base/methods/stats, not the user's own repo). Deliberately small
 * and unsurprising rather than exhaustive — see `rS3Split`'s doc comment. */
const R_BASE_GENERICS = new Set([
  "print",
  "format",
  "summary",
  "plot",
  "str",
  "toString",
  "as.character",
  "as.list",
  "as.data.frame",
  "as.vector",
  "as.numeric",
  "as.matrix",
  "length",
  "dim",
  "names",
  "rev",
  "sort",
  "unique",
  "predict",
  "coef",
  "residuals",
  "fitted",
  "update",
  "merge",
  "all.equal",
  "anova",
  "confint",
  "vcov",
  "logLik",
]);

/** Every S3 generic THIS file registers via a local `UseMethod()` call, so
 * `rS3Split` can recognize `generic.Class` methods for a repo's own generics,
 * not just the base-R ones. Runs once per file, ahead of the main walk (same
 * pre-pass shape as `collectImportedSymbols`). Cross-file generics — a
 * generic defined in one file, dispatched on in another — aren't found this
 * way; that would need a whole-repo pass extractFile has no visibility into,
 * the same limitation Go/C++'s per-file bindings already accept. */
function collectRGenerics(root: Parser.SyntaxNode): Set<string> {
  const generics = new Set<string>();
  const visit = (node: Parser.SyntaxNode): void => {
    let fnDef: Parser.SyntaxNode | null = null;
    let ownName: string | null = null;
    if (node.type === "binary_operator") {
      const op = node.childForFieldName("operator")?.text;
      const lhs = node.childForFieldName("lhs");
      const rhs = node.childForFieldName("rhs");
      if (op && R_ASSIGN_OPS.has(op) && lhs?.type === "identifier" && rhs?.type === "function_definition") {
        fnDef = rhs;
        ownName = lhs.text;
      }
    } else if (node.type === "function_definition") {
      const body = node.childForFieldName("body");
      if (body?.type === "binary_operator") {
        const op = body.childForFieldName("operator")?.text;
        const rhs = body.childForFieldName("rhs");
        if (op && R_RIGHT_ASSIGN_OPS.has(op) && rhs?.type === "identifier") {
          fnDef = node;
          ownName = rhs.text;
        }
      }
    }
    if (fnDef && ownName) {
      const arg = findUseMethodArg(fnDef.childForFieldName("body"));
      if (arg !== undefined) generics.add(arg || ownName); // "" means UseMethod() with no args
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return generics;
}

/** Searches a function body for a `UseMethod(...)` call and returns its
 * string-literal generic-name argument, `""` if called with no arguments
 * (defaults to the enclosing function's own name), or `undefined` if no
 * `UseMethod` call is found at all. */
function findUseMethodArg(node: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "call" && rCalleeName(node) === "UseMethod") {
    const first = rCallArgs(node)[0]?.childForFieldName("value");
    return first?.type === "string" ? (rStringContent(first) ?? "") : "";
  }
  for (const child of node.namedChildren) {
    const found = findUseMethodArg(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** S4: `setClass("Foo", ...)` → a class; `setMethod("generic", "Foo",
 * function() {})` → a method owned by "Foo". Both are ordinary top-level
 * `call` nodes — S4's registration functions have side effects and are
 * essentially never assigned to a variable, unlike R6Class. */
function describeRTopLevelCall(node: Parser.SyntaxNode): DefDescriptor | null {
  const callee = rCalleeName(node);
  if (callee === "setClass") {
    const first = rCallArgs(node)[0]?.childForFieldName("value");
    const name = first?.type === "string" ? rStringContent(first) : null;
    if (!name) return null;
    return { name, kind: "class", headerEnd: node.endIndex, hashNode: node };
  }
  if (callee === "setMethod") {
    const args = rCallArgs(node);
    const generic = args[0] ? rStringContent(args[0].childForFieldName("value") ?? null) : null;
    const className = args[1] ? rStringContent(args[1].childForFieldName("value") ?? null) : null;
    const defArg = args.find((a) => a.childForFieldName("name")?.text === "definition") ?? args[2];
    const fnDef = defArg?.childForFieldName("value");
    if (!generic || !className || fnDef?.type !== "function_definition") return null;
    const body = fnDef.childForFieldName("body");
    return {
      name: generic,
      idName: `${className}.${generic}`,
      kind: "method",
      headerEnd: body ? body.startIndex : fnDef.endIndex,
      hashNode: fnDef,
      owner: className,
    };
  }
  return null;
}

/** A call's callee name, whether bare (`R6Class(...)`) or namespace-qualified
 * (`R6::R6Class(...)`). Null if the callee isn't a simple name (e.g. itself a
 * call, or a `$`-based access). */
function rCalleeName(node: Parser.SyntaxNode): string | null {
  const fn = node.childForFieldName("function");
  if (fn?.type === "identifier") return fn.text;
  if (fn?.type === "namespace_operator") {
    const rhs = fn.childForFieldName("rhs");
    return rhs?.type === "identifier" ? rhs.text : null;
  }
  return null;
}

/** A call's positional/named `argument` children (skipping the `,`/`(`/`)`
 * punctuation tokens that share the `arguments` node's child list). */
function rCallArgs(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return node.childForFieldName("arguments")?.namedChildren.filter((c) => c.type === "argument") ?? [];
}

/** An R `string` node's unquoted text, or null if `node` isn't a string. */
function rStringContent(node: Parser.SyntaxNode | null): string | null {
  if (node?.type !== "string") return null;
  const content = node.namedChildren.find((c) => c.type === "string_content");
  return content?.text ?? null;
}

/** The value of a call's named argument (`setClass("Foo", contains = "Base")`
 * → the `contains` argument), or null if absent. */
function rNamedArg(node: Parser.SyntaxNode, argName: string): Parser.SyntaxNode | null {
  const arg = rCallArgs(node).find((a) => a.childForFieldName("name")?.text === argName);
  return arg?.childForFieldName("value") ?? null;
}

/** An R6 class-defining node's `inherit =` parent class name (a bare
 * identifier — the parent's own generator variable, not a string), for
 * `super$` call resolution (Phase 3). `node` is whatever describeR matched: a
 * binary_operator for R6 (`Foo <- R6::R6Class(...)`) or, for any other kind of
 * class (S4's setClass, which has no `super`), the call itself — always null
 * there since `rCalleeName(call) !== "R6Class"`. */
function rR6ParentClass(node: Parser.SyntaxNode): string | null {
  const call = node.type === "binary_operator" ? node.childForFieldName("rhs") : node;
  if (call?.type !== "call" || rCalleeName(call) !== "R6Class") return null;
  const value = rNamedArg(call, "inherit");
  return value?.type === "identifier" ? value.text : null;
}

/** Does this `list(...)` call look like a Phase-5 mixin/extension bundle —
 * i.e. does it have a `public =` or `private =` entry whose own value is
 * itself a `list(...)` call? This is the one check standing between "class-
 * like container" and an ordinary data/config list (`list(a = 1, b = 2)`,
 * or even one that happens to have a field named "public" holding something
 * else) — real code never coincidentally shapes plain data this way, so it's
 * a safe, precise signal without needing a naming-convention heuristic. */
function rIsMixinContainer(node: Parser.SyntaxNode): boolean {
  return rCallArgs(node).some((a) => {
    const name = a.childForFieldName("name")?.text;
    if (name !== "public" && name !== "private") return false;
    const value = a.childForFieldName("value");
    return value?.type === "call" && rCalleeName(value) === "list";
  });
}

/** A base-class name list from either a bare string (`contains = "Base"`) or
 * a `c(...)` call of strings (`contains = c("Base1", "Base2")`) — S4's
 * multiple-inheritance form. */
function rStringOrCVector(value: Parser.SyntaxNode | null): string[] {
  if (!value) return [];
  const single = rStringContent(value);
  if (single) return [single];
  if (value.type === "call" && rCalleeName(value) === "c") {
    return rCallArgs(value)
      .map((a) => rStringContent(a.childForFieldName("value")))
      .filter((s): s is string => !!s);
  }
  return [];
}

/** R6 visibility follows the `public =`/`private =`/`active =` section a
 * method was declared in (see walk()'s `argument`-node interception) —
 * `ctx.rR6Access` is only set for that direct span, so a plain function or an
 * S3/S4 method (neither of which has a real visibility concept) checks for a
 * roxygen `@export` tag next (Phase 3), falling back to the leading-dot naming
 * convention only when there's no roxygen evidence to go on at all. `node` is
 * the exact node describeR matched — see `rRoxygenExported`'s doc comment for
 * why that's always the right one to check for a preceding comment block. */
function rExported(name: string, ctx: WalkCtx, node: Parser.SyntaxNode): boolean {
  if (ctx.rR6Access !== null) return ctx.rR6Access !== "private";
  const roxygen = rRoxygenExported(node);
  if (roxygen !== null) return roxygen;
  return !name.startsWith(".");
}

/**
 * Roxygen `@export` detection (Phase 3): does `node` — a top-level definition
 * statement (a `binary_operator` assignment, a right-assigned
 * `function_definition`, or an S4 `setClass`/`setMethod` call) — have a
 * roxygen doc block immediately preceding it, and if so, is it tagged
 * `@export`?
 *
 * `comment` is a grammar EXTRA in this grammar (floats loosely between
 * sibling nodes rather than attaching to "the next statement" via a field),
 * so this walks backward through `previousNamedSibling` collecting a
 * contiguous run of `comment` nodes — the run ends at the first non-comment
 * sibling, or at the first comment that isn't itself a roxygen (`#'`) line,
 * either of which is roxygen's own "this block documents the next statement"
 * boundary.
 *
 * Returns:
 *  - `true` — a roxygen block was found and it contains `@export`.
 *  - `false` — a roxygen block was found but it does NOT contain `@export`.
 *    This is deliberately a confident "not exported," not "unknown": roxygen
 *    generates a package's NAMESPACE from exactly its `@export`-tagged items,
 *    so a documented-but-untagged function is an explicit "internal, for
 *    maintainers only" signal, not an absence of evidence.
 *  - `null` — no roxygen block at all, so the caller should fall back to the
 *    leading-dot naming convention instead of guessing.
 */
function rRoxygenExported(node: Parser.SyntaxNode): boolean | null {
  let sib = node.previousNamedSibling;
  let sawRoxygen = false;
  let exported = false;
  while (sib?.type === "comment") {
    const text = sib.text.trim();
    if (!text.startsWith("#'")) break; // an ordinary # comment ends the roxygen block
    sawRoxygen = true;
    if (/^#'\s*@export\b/.test(text)) exported = true;
    sib = sib.previousNamedSibling;
  }
  return sawRoxygen ? exported : null;
}

/** Java definition shapes. Uniform in a way Go's are not: every declaration carries
 * a `name` field and (for types and most members) a `body`, so one mapped lookup
 * covers classes, interfaces, enums, records, methods, and constructors. Methods are
 * lexically nested in their type, so — unlike Go — they need no receiver qualification. */
function describeJava(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  const mapped = ctx.kinds[node.type];
  if (!mapped) return null;
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  const body = node.childForFieldName("body");
  const desc: DefDescriptor = {
    name,
    kind: mapped,
    headerEnd: body ? body.startIndex : node.endIndex,
    hashNode: node,
  };
  // Only callables carry arity. A record declaration also has a `parameters` node,
  // but its components are not an overload set and must never be filtered against.
  if (node.type === "method_declaration" || node.type === "constructor_declaration") {
    const params = node.childForFieldName("parameters");
    if (params) {
      const declared = params.namedChildren.filter(
        (c) => c.type === "formal_parameter" || c.type === "spread_parameter",
      );
      desc.arity = declared.length;
      if (declared.some((c) => c.type === "spread_parameter")) desc.variadic = true;
    }
  }
  return desc;
}

/** Kotlin definition shapes. Unlike Java's, tree-sitter-kotlin exposes no `name`
 * or `body` fields: a definition's name is an unnamed `simple_identifier` (functions)
 * or `type_identifier` (types) child, and its body is a `class_body` / `function_body`
 * / `statements` child. `class_declaration` also folds classes, interfaces, and enum
 * classes into one node type — the kind is read off the declaration's own keywords. */
function describeKotlin(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  // The first direct `type_identifier` is the declared name (type parameters, primary
  // constructor parameters and delegation specifiers are all nested beneath it).
  const typeName = (): string | null =>
    node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  // The first direct `simple_identifier` is the function name (receiver type, params
  // and type parameters are all nested beneath other child nodes).
  const funcName = (): string | null =>
    node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
  // `class X : A, B()` heritage lives in `delegation_specifier` children; a nested
  // type parameter's identifier is one of the same node type, so only direct children
  // count as the declared name.
  const headEnd = (type: string): number => {
    const body = node.namedChildren.find((c) => c.type === type);
    return body ? body.startIndex : node.endIndex;
  };

  if (node.type === "class_declaration") {
    const name = typeName();
    if (!name) return null;
    let kind: Kind = "class";
    if (node.namedChildren.some((c) => c.type === "enum_class_body")) kind = "enum";
    else if (node.children.some((c) => c.type === "interface")) kind = "interface";
    else {
      const mods = node.namedChildren.find((c) => c.type === "modifiers");
      // `annotation class` → the interface role Java's annotation_type_declaration plays.
      if (mods?.namedChildren.some((c) => c.type === "class_modifier" && c.text === "annotation"))
        kind = "interface";
    }
    const body = node.namedChildren.find(
      (c) => c.type === "class_body" || c.type === "enum_class_body",
    );
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  if (node.type === "object_declaration") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "class", headerEnd: headEnd("class_body"), hashNode: node };
  }

  if (node.type === "function_declaration") {
    const name = funcName();
    if (!name) return null;
    const kind: Kind = KOTLIN_TYPE_KINDS.has(ctx.enclosingKind ?? "file") ? "method" : "function";
    return { name, kind, headerEnd: headEnd("function_body"), hashNode: node };
  }

  if (node.type === "secondary_constructor") {
    // Constructors carry no name of their own — they are the class's own, so scope the
    // node under the enclosing class the same way Java's constructor_declaration does.
    if (!ctx.enclosingClass) return null;
    return {
      name: ctx.enclosingClass,
      kind: "method",
      headerEnd: headEnd("statements"),
      hashNode: node,
    };
  }

  if (node.type === "type_alias") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "type", headerEnd: node.endIndex, hashNode: node };
  }

  if (node.type === "property_declaration") {
    // Top-level `val`/`var` only — a class property is a field, not a definition node
    // (no depth tier emits fields), so it must not become one.
    if (ctx.enclosingKind !== null) return null;
    const decl = node.namedChildren.find((c) => c.type === "variable_declaration");
    const name = decl?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    if (!name) return null;
    return { name, kind: "variable", headerEnd: node.endIndex, hashNode: node };
  }

  return null;
}

/** Swift definition shapes. Like Kotlin's, tree-sitter-swift exposes no `name` or
 * `body` fields: a definition's name is a direct `type_identifier` (types) or
 * `simple_identifier` (functions) child, and its body is a `class_body` /
 * `enum_class_body` / `protocol_body` / `function_body` child. One
 * `class_declaration` node type covers `class`, `struct`, `enum`, `actor` AND
 * `extension` — the declaration's own keyword token tells them apart. */
function describeSwift(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  // The first direct `type_identifier` is the declared name (generic parameters and
  // inheritance specifiers are all nested beneath other child nodes).
  const typeName = (): string | null =>
    node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  // The first direct `simple_identifier` is the function name (parameters and
  // generic parameters are all nested beneath other child nodes).
  const funcName = (): string | null =>
    node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
  const headEnd = (...types: string[]): number => {
    const body = node.namedChildren.find((c) => types.includes(c.type));
    return body ? body.startIndex : node.endIndex;
  };

  if (node.type === "class_declaration") {
    const kw = node.children.find(
      (c) =>
        c.type === "class" ||
        c.type === "struct" ||
        c.type === "enum" ||
        c.type === "actor" ||
        c.type === "extension",
    )?.type;
    let name: string | null;
    if (kw === "extension") {
      // `extension Point { … }` has no name of its own — the extended type's IS its
      // identity, so the node takes that name: members mint as `Point.method`,
      // `enclosingClass` becomes `Point`, and a member call on a Point receiver
      // resolves to them exactly as if they were declared on the type. A qualified
      // target (`extension Swift.Array`) reduces to its last component, matching
      // how the extended type is itself named in the graph.
      //
      // Its KIND is "module", not "class": the type usually already has a real
      // declaration, and a second same-named "class" node would make the name
      // AMBIGUOUS to resolveName — every `Point(...)` initializer call and every
      // `: Point` heritage target would then drop instead of resolving (resolve
      // never guesses between same-named candidates). "module" keeps the node out
      // of type-name resolution entirely while SWIFT_TYPE_KINDS still makes it
      // own its members; typed member calls are untouched either way, since they
      // go through the owner-qualified method index, not the type's own node.
      const ut = node.namedChildren.find((c) => c.type === "user_type");
      const ids = ut?.namedChildren.filter((c) => c.type === "type_identifier") ?? [];
      name = ids.length ? ids[ids.length - 1]!.text : null;
    } else {
      name = typeName();
    }
    if (!name) return null;
    // An actor is class-like (reference semantics, methods) and there is no
    // dedicated actor kind, so it takes "class".
    const kind: Kind =
      kw === "extension" ? "module" : kw === "struct" ? "struct" : kw === "enum" ? "enum" : "class";
    return { name, kind, headerEnd: headEnd("class_body", "enum_class_body"), hashNode: node };
  }

  if (node.type === "protocol_declaration") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "interface", headerEnd: headEnd("protocol_body"), hashNode: node };
  }

  // A protocol requirement (`protocol_function_declaration`) has no body and is
  // always a member; an ordinary `function_declaration` is a method exactly when
  // it is nested in a type (or an extension of one).
  if (node.type === "function_declaration" || node.type === "protocol_function_declaration") {
    const name = funcName();
    if (!name) return null;
    const kind: Kind =
      node.type === "protocol_function_declaration" ||
      SWIFT_TYPE_KINDS.has(ctx.enclosingKind ?? "file")
        ? "method"
        : "function";
    return {
      name,
      kind,
      headerEnd: headEnd("function_body"),
      hashNode: node,
      ...swiftArity(node),
    };
  }

  if (node.type === "init_declaration") {
    // Initializers carry no name of their own — they are the type's own, so scope
    // the node under the enclosing type the same way Java's constructor_declaration
    // does. (A protocol's `init` requirement lands here too, owned by the protocol.)
    if (!ctx.enclosingClass) return null;
    return {
      name: ctx.enclosingClass,
      kind: "method",
      headerEnd: headEnd("function_body"),
      hashNode: node,
      ...swiftArity(node),
    };
  }

  if (node.type === "typealias_declaration") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "type", headerEnd: node.endIndex, hashNode: node };
  }

  if (node.type === "property_declaration") {
    // Top-level `let`/`var` only — a stored/computed property inside a type is a
    // field, not a definition node (no depth tier emits fields), so it must not
    // become one. `deinit` and `subscript` are likewise skipped: neither is ever
    // the target of a resolvable call edge, and neither carries a usable name.
    if (ctx.enclosingKind !== null) return null;
    const name = node.namedChildren
      .find((c) => c.type === "pattern")
      ?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    if (!name) return null;
    return { name, kind: "variable", headerEnd: node.endIndex, hashNode: node };
  }

  return null;
}

/** Java visibility: `public` (or `protected`) on the declaration's own modifier list.
 * A package-private or private member is not part of the API surface. Read off the
 * `modifiers` child's tokens, ignoring annotations, which live in the same node. */
function javaExported(node: Parser.SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return false;
  return mods.children.some((c) => c.type === "public" || c.type === "protected");
}

/** Kotlin visibility: exported by default (`public` is implicit); only an explicit
 * `internal` / `private` / `protected` visibility modifier hides a definition. */
function kotlinExported(node: Parser.SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return true;
  const vis = mods.namedChildren.find((c) => c.type === "visibility_modifier");
  return !vis || vis.text === "public";
}

/** Declared parameter count for a Swift callable, for overload disambiguation
 * (the same role Java's `arity`/`argCount` pair plays). `parameter` nodes are
 * direct children of the declaration; a default value's `=` sits as a SIBLING
 * token after its parameter, and a variadic `...` sits inside its parameter.
 * `arity` is the REQUIRED minimum (parameters minus defaults) and `variadic`
 * marks any default or variadic parameter, so `narrowByArity`'s at-least
 * semantics keeps every overload a call of that shape could reach. */
function swiftArity(node: Parser.SyntaxNode): { arity: number; variadic?: boolean } {
  const params = node.children.filter((c) => c.type === "parameter");
  const defaults = node.children.filter((c) => c.type === "=").length;
  const hasVariadic = params.some((p) => p.children.some((c) => c.type === "..."));
  const arity = Math.max(0, params.length - defaults);
  return hasVariadic || defaults > 0 ? { arity, variadic: true } : { arity };
}

/** Argument count at a Swift call site: the `value_argument`s plus one for a
 * trailing closure (`run(x) { … }` calls a two-parameter function). */
function swiftArgCount(node: Parser.SyntaxNode): number | undefined {
  const suffix = node.namedChildren.find((c) => c.type === "call_suffix");
  if (!suffix) return undefined;
  const args =
    suffix.namedChildren
      .find((c) => c.type === "value_arguments")
      ?.namedChildren.filter((c) => c.type === "value_argument").length ?? 0;
  const trailing = suffix.namedChildren.some((c) => c.type === "lambda_literal") ? 1 : 0;
  return args + trailing;
}

/** Swift visibility: the default (`internal`) is module-wide, and a repo is
 * typically one module — so `public` / `open` / `package` / `internal` all count
 * as API surface, and only an explicit `private` / `fileprivate` hides a
 * definition. A setter-only restriction (`private(set)`) leaves the getter
 * visible, so it does not hide the symbol either. */
function swiftExported(node: Parser.SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  const vis = mods?.namedChildren.find((c) => c.type === "visibility_modifier");
  return !vis || (vis.text !== "private" && vis.text !== "fileprivate");
}

/** The superclass a Swift class declaration names: its FIRST inheritance
 * specifier — Swift's grammar requires the superclass to precede any protocol
 * in the `:` list, so when a superclass exists it is always this entry. A
 * class conforming only to protocols yields that protocol's name instead, but
 * `super` is illegal in such a class, so no call site ever consults it. Null
 * for a bare `class Foo` (and for an extension, whose declaration carries no
 * heritage for the original type — `super` inside one stays unresolved). */
function swiftSuperClassName(node: Parser.SyntaxNode): string | null {
  const spec = node.namedChildren.find((c) => c.type === "inheritance_specifier");
  const ids = spec?.namedChildren
    .find((c) => c.type === "user_type")
    ?.namedChildren.filter((c) => c.type === "type_identifier");
  return ids?.length ? ids[ids.length - 1]!.text : null;
}

/** The receiver's base type name for a Go method, unwrapping a pointer receiver
 * (`func (u *User) …` → `User`). Null if it can't be read. */
function goReceiverType(node: Parser.SyntaxNode): string | null {
  const recv = node.childForFieldName("receiver"); // parameter_list
  const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
  let type = param?.childForFieldName("type");
  if (type?.type === "pointer_type") type = type.namedChildren.at(-1) ?? null;
  return type?.type === "type_identifier" ? type.text : null;
}

/** Go visibility: a symbol is exported iff its own name starts with an uppercase
 * letter. For a receiver-qualified method name, the own name is the part after the dot. */
function goExported(name: string): boolean {
  const own = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const first = own[0] ?? "";
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

/** PHP visibility: a class member is "exported" unless it is `private`/`protected`.
 * Top-level functions/classes carry no visibility modifier and are always visible. */
function phpExported(node: Parser.SyntaxNode): boolean {
  const vis = node.namedChildren.find((c) => c.type === "visibility_modifier");
  return vis ? vis.text === "public" : true;
}

/** Name for a PHP closure / arrow-fn: the variable it's assigned to
 * (`$handler = fn(...)` -> `handler`, mirroring how TS names arrow-consts),
 * else the anonymous `{closure}` (deduplicated per file by mintId).
 *
 * The "is this the assignment's right-hand side" check compares tree-sitter node
 * `.id` (a stable per-tree node identity) rather than `===` on the wrapper
 * objects: the binding does not guarantee that two traversals to the same
 * underlying node hand back the same JS wrapper, so `right === node` can be false
 * even when they are the same node — producing a stray `{closure}` name that
 * makes `graft check` report the graph STALE against its own stored output. */
function phpClosureName(node: Parser.SyntaxNode): string {
  const parent = node.parent;
  if (parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id) {
    const left = parent.childForFieldName("left");
    if (left?.type === "variable_name") return left.text.replace(/^\$/, "");
  }
  return "{closure}";
}

function heritageEdges(node: Parser.SyntaxNode, classId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  if (ctx.lang === "java") {
    // `superclass` holds `extends X`; `super_interfaces` holds `implements A, B`
    // (and, on an interface declaration, `extends A, B` — which tree-sitter-java
    // still spells `extends_interfaces`).
    const typeParams = javaTypeParameterNames(node);
    for (const child of node.namedChildren) {
      const relation: Relation | null =
        child.type === "superclass"
          ? "extends"
          : child.type === "super_interfaces" || child.type === "extends_interfaces"
            ? "implements"
            : null;
      if (!relation) continue;
      for (const entry of javaSupertypeEntries(child)) {
        const name = javaSupertypeName(entry);
        // Belt-and-braces. A type VARIABLE is never a supertype, and erasing the
        // arguments already removes every case measured on gson and spring-petclinic
        // (identical output with this filter removed) — Java cannot extend or implement
        // a type variable, so a surviving `T` would have to come from a shape neither
        // repo contains. Kept because a wrong supertype is not a cosmetic edge: it
        // feeds `classParents` and from there call resolution.
        if (!name || typeParams.has(name)) continue;
        edges.push({ source: classId, relation, name, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "kotlin") {
    // The `:` clause is a list of `delegation_specifier`s — a superclass construction
    // (`class A : B()`), an interface, or `by` delegation. The first `type_identifier`
    // under each names the type; everything else (type args, delegation target) is not
    // the heritage target, so only the head type counts.
    for (const child of node.namedChildren) {
      if (child.type !== "delegation_specifier") continue;
      const t = child.namedChildren.find((c) => c.type === "user_type")?.namedChildren.find(
        (c) => c.type === "type_identifier",
      );
      if (t) edges.push({ source: classId, relation: "extends", name: t.text, file: ctx.rel });
    }
    return edges;
  }
  if (ctx.lang === "swift") {
    // `class A: B, C` — each `inheritance_specifier` (a direct child of the
    // declaration; protocols and extensions carry them too) wraps a `user_type`
    // whose LAST direct `type_identifier` is the bare supertype name: a
    // module-qualified `Foundation.NSObject` reduces to `NSObject`, and generic
    // arguments live in nested nodes so they never leak in. Swift cannot say
    // syntactically whether a specifier is the superclass or a protocol
    // conformance (that needs the target's kind), so every edge is `extends` —
    // the same collapse Kotlin's delegation specifiers make.
    for (const child of node.namedChildren) {
      if (child.type !== "inheritance_specifier") continue;
      const ids = child.namedChildren
        .find((c) => c.type === "user_type")
        ?.namedChildren.filter((c) => c.type === "type_identifier");
      const t = ids?.length ? ids[ids.length - 1] : undefined;
      if (t) edges.push({ source: classId, relation: "extends", name: t.text, file: ctx.rel });
    }
    return edges;
  }
  if (ctx.lang === "python") {
    const supers = node.childForFieldName("superclasses"); // argument_list
    for (const c of supers?.namedChildren ?? []) {
      if (c.type === "identifier") {
        edges.push({ source: classId, relation: "extends", name: c.text, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "r") {
    // `node` is whatever describeR matched: a binary_operator for R6
    // (`Foo <- R6::R6Class(...)`) or the call itself for S4 (`setClass(...)`
    // is a bare top-level statement, essentially never assigned).
    const call = node.type === "binary_operator" ? node.childForFieldName("rhs") : node;
    if (call?.type !== "call") return edges;
    const callee = rCalleeName(call);
    if (callee === "R6Class") {
      // `inherit = ParentClass` — a bare identifier (the parent's own
      // generator variable), not a string; R6 supports single inheritance only.
      const value = rNamedArg(call, "inherit");
      if (value?.type === "identifier") {
        edges.push({ source: classId, relation: "extends", name: value.text, file: ctx.rel });
      }
    } else if (callee === "setClass") {
      // `contains = "Base"` or `contains = c("Base1", "Base2")` — S4 supports
      // multiple inheritance.
      for (const name of rStringOrCVector(rNamedArg(call, "contains"))) {
        edges.push({ source: classId, relation: "extends", name, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "php") {
    // `class C extends B implements I, J` → base_clause (extends) +
    // class_interface_clause (implements); names may be namespace-qualified.
    for (const clause of node.namedChildren) {
      const relation: Relation | null =
        clause.type === "base_clause" ? "extends" : clause.type === "class_interface_clause" ? "implements" : null;
      if (!relation) continue;
      for (const t of clause.namedChildren) {
        if (t.type === "name" || t.type === "qualified_name") {
          edges.push({ source: classId, relation, name: t.text.replace(/^.*\\/, ""), file: ctx.rel });
        }
      }
    }
    return edges;
  }
  const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
  for (const clause of heritage?.namedChildren ?? []) {
    const relation: Relation | null =
      clause.type === "implements_clause"
        ? "implements"
        : clause.type === "extends_clause"
          ? "extends"
          : null;
    if (!relation) continue;
    for (const t of clause.namedChildren) {
      if (t.type === "identifier" || t.type === "type_identifier") {
        edges.push({ source: classId, relation, name: t.text, file: ctx.rel });
      }
    }
  }
  return edges;
}

/**
 * The supertypes a heritage clause names, one node each — NOT every `type_identifier`
 * beneath it.
 *
 * `superclass` wraps a single type; `super_interfaces`/`extends_interfaces` wrap a
 * `type_list` of them. Descending blindly instead walked into `type_arguments`, so
 * `implements Comparable<Item>` reported `Item` as a supertype too.
 */
function javaSupertypeEntries(clause: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const list = clause.namedChildren.find((c) => c.type === "type_list");
  return list ? [...list.namedChildren] : [...clause.namedChildren];
}

/**
 * What a supertype entry is CALLED, or null when this pass cannot say.
 *
 * Type arguments are erased, because they are not part of the supertype's identity:
 *
 *     Base           |  Base<Item>          -> Base
 *
 * A qualified name is kept WHOLE rather than reduced to its final segment:
 *
 *     Outer.Inner    |  Outer.Inner<K>      -> Outer.Inner
 *
 * Heritage keeps an unresolved base as the edge target by design ("usually an
 * external/imported type — keep the name"), so the full string is both truthful and
 * unable to false-match a node id, where a bare `Inner` could collide with an
 * unrelated in-repo type. That differs from construction (#103), which drops a
 * qualified name instead — construction has no keep-the-name contract to fall back on.
 */
function javaSupertypeName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "generic_type") return javaSupertypeName(node.namedChildren[0]);
  if (node.type === "scoped_type_identifier") return node.text;
  return node.type === "type_identifier" ? node.text : null;
}

/** The names a declaration binds as its own type parameters (`class C<T, U>` → T, U),
 * so they can never be mistaken for supertypes. */
function javaTypeParameterNames(decl: Parser.SyntaxNode): ReadonlySet<string> {
  const params = decl.childForFieldName("type_parameters");
  if (!params) return new Set();
  const out = new Set<string>();
  const visit = (n: Parser.SyntaxNode): void => {
    if (n.type === "type_identifier") out.add(n.text);
    for (const c of n.namedChildren) visit(c);
  };
  visit(params);
  return out;
}

function calleeName(
  node: Parser.SyntaxNode,
  lang: Language,
): { name: string; viaMember: boolean; receiver?: string; kinds?: Kind[] } | null {
  // Java first: `method_invocation` has NO `function` field (it splits the callee
  // into `object` + `name`), so the shared lookup below would return null for every
  // Java call site and the language would extract nodes with no call edges at all.
  if (lang === "java") {
    if (node.type === "object_creation_expression") {
      // `new Foo()` — the constructed type is the call target, named as the graph
      // names it.
      const name = javaConstructedTypeName(node.childForFieldName("type"));
      return name ? { name, viaMember: false } : null;
    }
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const obj = node.childForFieldName("object");
    // No `object` means an implicit-`this` call (`decorate(name)`), which in Java is a
    // method call, not a free function — Java has none. Reporting it as a plain call
    // would send it to the function-only resolver and drop it, losing the most common
    // intra-class edge there is. Spelling it as a `this` member call routes it through
    // owner-qualified resolution, which also walks the superclass chain and stays
    // conservative: an unmatched name (e.g. a static import) resolves to nothing.
    if (!obj) return { name: nameNode.text, viaMember: true, receiver: "this" };
    return { name: nameNode.text, viaMember: true, receiver: javaReceiver(obj) };
  }

if (lang === "kotlin") {
    // `call_expression` = callee expression + `call_suffix`. A bare `foo()` names a
    // plain call; `obj.foo()` is a `navigation_expression` whose trailing
    // `navigation_suffix` holds the method name and whose object is the receiver.
    const target = node.namedChildren[0];
    if (target?.type === "simple_identifier") return { name: target.text, viaMember: false };
    if (target?.type === "navigation_expression") {
      const suffix = target.namedChildren.find((c) => c.type === "navigation_suffix");
      const name = suffix?.namedChildren.find((c) => c.type === "simple_identifier");
      const receiver = target.namedChildren[0];
      if (!name) return null;
      if (receiver?.type === "simple_identifier")
        return { name: name.text, viaMember: true, receiver: receiver.text };
      if (receiver?.type === "this_expression" || receiver?.type === "super_expression")
        return { name: name.text, viaMember: true, receiver: receiver.type === "this_expression" ? "this" : "super" };
    }
    return null;
  }

  if (lang === "swift") {
    // Same shape as Kotlin's: `call_expression` = callee expression + `call_suffix`.
    // A bare `foo()` names a plain call (this also covers `Animal()` initializer
    // calls, which have no distinguishing syntax); `obj.foo()` is a
    // `navigation_expression` whose trailing `navigation_suffix` holds the member
    // name and whose head is the receiver.
    const target = node.namedChildren[0];
    if (target?.type === "simple_identifier") return { name: target.text, viaMember: false };
    if (target?.type === "navigation_expression") {
      const suffix = target.namedChildren.find((c) => c.type === "navigation_suffix");
      const name = suffix?.namedChildren.find((c) => c.type === "simple_identifier");
      const receiver = target.namedChildren[0];
      if (!name) return null;
      if (receiver?.type === "simple_identifier")
        return { name: name.text, viaMember: true, receiver: receiver.text };
      if (receiver?.type === "self_expression" || receiver?.type === "super_expression")
        return {
          name: name.text,
          viaMember: true,
          receiver: receiver.type === "self_expression" ? "self" : "super",
        };
      if (receiver?.type === "navigation_expression") {
        // `self.repo.save()` — one hop off self is a field access and binds like
        // TS's `this.x`. Deeper chains and call-result receivers carry no
        // confident local clue, so those fall through with no receiver.
        const head = receiver.namedChildren[0];
        const field = receiver.namedChildren
          .find((c) => c.type === "navigation_suffix")
          ?.namedChildren.find((c) => c.type === "simple_identifier");
        if (head?.type === "self_expression" && field)
          return { name: name.text, viaMember: true, receiver: `self.${field.text}` };
      }
      // Still a member call even with an unknowable receiver (a chained call, a
      // literal, a subscript): recvType stays unset and resolve drops it rather
      // than guessing — same contract as Java's and TS's unknown receivers.
      return { name: name.text, viaMember: true };
    }
    return null;
  }

  if (lang === "php") return phpCallee(node);

  const fn = node.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return { name: fn.text, viaMember: false };
  if (lang === "python" && fn.type === "attribute") {
    const a = fn.childForFieldName("attribute") ?? fn.namedChildren.at(-1);
    return a ? { name: a.text, viaMember: true, receiver: pyReceiver(fn) } : null;
  }
  if (lang === "go" && fn.type === "selector_expression") {
    // `pkg.Fn()` / `recv.Method()` — the called name is the trailing field.
    const p = fn.childForFieldName("field") ?? fn.namedChildren.at(-1);
    const operand = fn.childForFieldName("operand");
    const receiver = operand?.type === "identifier" ? operand.text : undefined;
    return p ? { name: p.text, viaMember: true, receiver } : null;
  }
  if ((lang === "typescript" || lang === "tsx") && fn.type === "member_expression") {
    const p = fn.childForFieldName("property") ?? fn.namedChildren.at(-1);
    return p ? { name: p.text, viaMember: true, receiver: tsReceiver(fn) } : null;
  }
  if (lang === "r" && (fn.type === "extract_operator" || fn.type === "namespace_operator")) {
    const rhs = fn.childForFieldName("rhs");
    if (rhs?.type !== "identifier") return null;
    if (fn.type === "extract_operator") {
      const lhs = fn.childForFieldName("lhs");
      if (lhs?.type === "identifier" && (lhs.text === "self" || lhs.text === "private")) {
        // R6 (Phase 2): `self$method()` / `private$method()` — resolves directly to
        // the enclosing class via ctx.enclosingClass, same mechanism (and same
        // magic receiver string) as Python/TS's self/cls/this — see
        // resolveRecvType, which already special-cases "self" generically.
        return { name: rhs.text, viaMember: true, receiver: "self" };
      }
      if (lhs?.type === "identifier" && lhs.text === "super") {
        // R6 (Phase 3): `super$method()` — R6's inheritance-dispatch keyword,
        // resolves directly to the PARENT class via ctx.rSuperClass (NOT
        // ctx.enclosingClass — that would wrongly find the current class's own
        // same-named override instead of climbing to the parent).
        return { name: rhs.text, viaMember: true, receiver: "super" };
      }
      // Any other `obj$method()` (Phase 4): still a PLAIN name match, not a
      // typed member call — there's no general field-type-binding table for
      // R6 composition (`private$other_obj$method()`), and a real codebase's
      // dominant field-assignment shape (constructor-parameter pass-through,
      // `do.call(class_var$new, ...)` dynamic dispatch) turned out to defeat
      // the simple "field <- SomeClass$new()" pattern every other language's
      // binding table relies on anyway — see plan_r_language_support.md's
      // Phase 2 "known gaps" and the follow-up investigation against a real
      // R6-heavy corpus. What DOES help: bare-name resolution must be allowed
      // to match a "method" node here, not just "function" — R6 methods are
      // always kind "method", so without `kinds` below, EVERY untyped `$`
      // call would be unconditionally unresolvable rather than just
      // occasionally ambiguous (resolve.ts already drops a genuinely
      // ambiguous bare-name match rather than guessing, so this only adds
      // resolutions for uniquely-named methods, never a wrong-class guess).
      return { name: rhs.text, viaMember: false, kinds: ["function", "method"] };
    }
    // `pkg::fun()` (qualified call) — always a real function/exported symbol,
    // never an R6 method (those are only ever reached via `$` on an instance),
    // so no need to widen the match kinds here.
    return { name: rhs.text, viaMember: false };
  }
  return null;
}

/** The number of arguments at a Java call site (`method_invocation` or
 * `object_creation_expression`), read off the `arguments` list. Undefined when the
 * list is absent, which keeps resolution at its previous name-only behavior rather
 * than filtering on a count we never established. */
function javaArgCount(node: Parser.SyntaxNode): number | undefined {
  const args = node.childForFieldName("arguments");
  return args ? args.namedChildren.length : undefined;
}

/**
 * The name a `new` CONSTRUCTS, as the graph names it — or null when this pass cannot
 * say, in which case the construction resolves to nothing.
 *
 * Erasing type arguments is the only transformation here, because it is the only one
 * that provably does not change which type is being named:
 *
 *     Box            -> Box
 *     Box<String>    -> Box     (the node is `Box`; the arguments are not part of it)
 *     Box<>          -> Box
 *
 * A QUALIFIED name is deliberately dropped rather than reduced to its final segment:
 *
 *     java.io.File   -> null    (not the repo's own `File`)
 *     Beta.Builder   -> null    (not `Alpha.Builder` in the same file)
 *
 * Collapsing those was the first attempt at this fix, and it traded lost edges for
 * WRONG ones — `new java.io.File(…)` resolved to an unrelated in-repo `File`, and a
 * nested `Beta.Builder` bound to a sibling `Alpha.Builder` at `extracted` confidence,
 * because the same-file tiebreak takes the first candidate. Dropping keeps this pass
 * on the resolver's own rule: resolve precisely, or not at all.
 *
 * Deliberately NOT shared with bindings.ts's `javaTypeName`. That one answers "what
 * type does this variable HOLD", where reducing `java.util.List` to `List` is a local
 * heuristic with different stakes; this one answers "what type is being constructed",
 * and the two questions do not have the same safe answer. Supporting qualified
 * construction properly needs an import-aware type index, not a longer helper.
 */
function javaConstructedTypeName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "generic_type") return javaConstructedTypeName(node.namedChildren[0]);
  return node.type === "type_identifier" ? node.text : null;
}

/** A Java call's receiver text: a bare identifier (`repo.save()`), `this`, or
 * `this.x` for a field access (`this.repo.save()`). A chained call or a qualified
 * static reference yields none — there is no confident local clue to bind. */
function javaReceiver(obj: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!obj) return undefined;
  if (obj.type === "identifier") return obj.text;
  if (obj.type === "this") return "this";
  if (obj.type === "field_access") {
    const inner = obj.childForFieldName("object");
    const field = obj.childForFieldName("field");
    if (inner?.type === "this" && field) return `this.${field.text}`;
  }
  return undefined;
}

/** py `attribute` node's receiver text: bare identifier, or `self.x` for a
 * chained `self.x.y()`. Anything else (e.g. a chained call `f().g()`) → none. */
function pyReceiver(fn: Parser.SyntaxNode): string | undefined {
  const obj = fn.childForFieldName("object");
  if (obj?.type === "identifier") return obj.text;
  if (obj?.type === "attribute") {
    const innerObj = obj.childForFieldName("object");
    const innerAttr = obj.childForFieldName("attribute");
    if (innerObj?.type === "identifier" && innerObj.text === "self" && innerAttr) return `self.${innerAttr.text}`;
  }
  return undefined;
}

/**
 * PHP call shapes: `foo()` (function_call_expression), `$obj->m()` /
 * `$obj?->m()` (member/nullsafe_member_call_expression), and `Cls::m()`
 * (scoped_call_expression). The called name is the trailing `name`; the
 * receiver, when locally knowable (`$this`, `self`/`static`/`parent`), feeds
 * receiver-typed resolution the same way Python's `self` and Go's receiver do.
 */
function phpCallee(node: Parser.SyntaxNode): { name: string; viaMember: boolean; receiver?: string } | null {
  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function");
    const name = fn ? phpName(fn) : null;
    return name ? { name, viaMember: false } : null;
  }
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  if (node.type === "scoped_call_expression") {
    return { name: nameNode.text, viaMember: true, receiver: phpScopeReceiver(node.childForFieldName("scope")) };
  }
  // member_call_expression / nullsafe_member_call_expression
  return { name: nameNode.text, viaMember: true, receiver: phpObjReceiver(node.childForFieldName("object")) };
}

/** A PHP callee identifier: bare `name`, or the trailing segment of a
 * `qualified_name` (`\App\helpers\slug` → `slug`). Dynamic calls (`$fn()`) → null. */
function phpName(node: Parser.SyntaxNode): string | null {
  if (node.type === "name") return node.text;
  if (node.type === "qualified_name") return node.text.replace(/^.*\\/, "") || null;
  return null;
}

/** `$obj->m()` receiver: `$this` normalizes to `this` (→ enclosing class); any
 * other variable is returned verbatim for a bindings lookup. */
function phpObjReceiver(obj: Parser.SyntaxNode | null): string | undefined {
  if (obj?.type !== "variable_name") return undefined;
  return obj.text === "$this" ? "this" : obj.text;
}

/** `Cls::m()` receiver: `self`/`static`/`parent` normalize to `self` (→ enclosing
 * class); an explicit class name is the trailing segment of its qualified path. */
function phpScopeReceiver(scope: Parser.SyntaxNode | null): string | undefined {
  if (!scope) return undefined;
  const text = scope.text;
  if (scope.type === "relative_scope" || text === "self" || text === "static" || text === "parent") return "self";
  if (scope.type === "name") return text;
  if (scope.type === "qualified_name") return text.replace(/^.*\\/, "");
  return undefined;
}

/** ts `member_expression` node's receiver text: `this`, `this.x`, or a bare identifier. */
function tsReceiver(fn: Parser.SyntaxNode): string | undefined {
  const obj = fn.childForFieldName("object");
  if (obj?.type === "this") return "this";
  if (obj?.type === "identifier") return obj.text;
  if (obj?.type === "member_expression") {
    const innerObj = obj.childForFieldName("object");
    const innerProp = obj.childForFieldName("property");
    if (innerObj?.type === "this" && innerProp) return `this.${innerProp.text}`;
  }
  return undefined;
}

/** R has no import statement at the grammar level — `library(x)`, `require(x)`,
 * and `source("f.R")` are ordinary `call` nodes, indistinguishable from any other
 * call except by their callee name. This is call-SITE pattern matching, a first
 * for this function's normal node-type switch — every other language's import
 * shape is a dedicated grammar construct. */
const R_IMPORT_CALLS = new Set(["library", "require", "source"]);

function isImport(node: Parser.SyntaxNode, lang: Language): boolean {
  // Go: match the per-import leaf, so single (`import "fmt"`) and grouped
  // (`import ( … )`) forms each yield one edge as the walk recurses into the list.
  if (lang === "go") return node.type === "import_spec";
  if (lang === "r") {
    if (node.type !== "call") return false;
    const fn = node.childForFieldName("function");
    return fn?.type === "identifier" && R_IMPORT_CALLS.has(fn.text);
  }
  if (lang === "java") return node.type === "import_declaration";
if (lang === "kotlin") return node.type === "import_header";
  if (lang === "swift") return node.type === "import_declaration";
  // PHP: one edge per imported symbol — the clause leaf inside a (possibly
  // grouped) `use A\B, C\D;` / `use A\{B, C};` declaration.
  if (lang === "php") return node.type === "namespace_use_clause";
  return node.type === "import_statement" || node.type === "import_from_statement";
}

function importSpecifier(node: Parser.SyntaxNode, lang: Language): string | null {
  if (lang === "php") {
    // namespace_use_clause → its `qualified_name`/`name`, e.g. `App\Models\Animal`.
    const q = node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "name");
    return q ? q.text.replace(/^\\/, "") : null;
  }
  if (lang === "python") {
    const m =
      node.childForFieldName("module_name") ??
      node.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
    return m?.text ?? null;
  }
  if (lang === "go") {
    // import_spec's `path` is an interpreted_string_literal, e.g. `"mymod/pkg/util"`.
    const path = node.childForFieldName("path") ?? node.namedChildren.at(-1);
    return path ? path.text.replace(/^["`]|["`]$/g, "") : null;
  }
  if (lang === "r") {
    // library(pkg) / library("pkg") / require(pkg) / source("f.R") — the target is
    // always the first (and normally only) positional argument, bare symbol or string.
    const value = rCallArgs(node)[0]?.childForFieldName("value") ?? null;
    if (value?.type === "identifier") return value.text;
    return rStringContent(value);
  }
  if (lang === "java") {
    // `import a.b.C;` / `import static a.b.C.d;` / `import a.b.*;` — the fully
    // qualified name is the scoped_identifier; a wildcard `*` is a separate token
    // and is dropped, leaving the package as the import target.
    const id = node.namedChildren.find(
      (c) => c.type === "scoped_identifier" || c.type === "identifier",
    );
    return id?.text ?? null;
  }
  if (lang === "kotlin") {
    // `import com.example.Foo` — the dotted path is the `identifier` child. A
    // wildcard (`import a.b.*`) and an `as` alias are separate children, so the
    // identifier text is already the module path (wildcards dropped, like Java).
    return node.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
  }
  if (lang === "swift") {
    // `import UIKit` / `import struct Foundation.Date` — the dotted path is the
    // `identifier` child (an import-kind keyword like `struct` is a separate
    // token). Swift imports name MODULES, not files, so the specifier resolves
    // to a repo file only when a same-named module target exists; external
    // frameworks stay as unresolved (but truthful) import intents.
    return node.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
  }
  const str = node.namedChildren.find((c) => c.type === "string");
  if (!str) return null;
  const frag = str.namedChildren.find((c) => c.type === "string_fragment");
  return frag?.text ?? str.text.replace(/^['"]|['"]$/g, "");
}

/** Signature = the definition header, whitespace-collapsed, trailing punctuation stripped. */
function clean(raw: string): string | null {
  const sig = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(=>|[{:=])\s*$/, "")
    .trim();
  return sig || null;
}

/** TS: a definition is exported if any ancestor is an `export` statement. */
function tsExported(node: Parser.SyntaxNode): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === "export_statement") return true;
    p = p.parent;
  }
  return false;
}
