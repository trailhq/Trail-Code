/**
 * Resolve {@link RawEdge} intents into concrete {@link EdgeV1} edges by matching
 * names/specifiers against the whole-repo node index.
 *
 * Confidence is a two-tier provenance model:
 *   - `extracted`: the target is certain — a match within the same file, an
 *     import specifier, or a structural containment.
 *   - `inferred`: a bare function target was resolved by a unique name match
 *     across files, which name-shadowing could in principle fool.
 * Ambiguous cross-file matches (a name defined in several files) are dropped
 * rather than guessed. Member calls are stricter: they require a receiver type
 * and owner-qualified method match because a unique bare method name says
 * nothing about the receiver.
 */
import { posix } from "node:path";
import { toPosixPath } from "../util/paths.js";
import type { EdgeV1, Kind, NodeV1, Relation } from "./types.js";
import { languageOf, type RawEdge } from "./extract.js";
import { genericLangOf } from "./generic.js";

const IMPORT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];
/** C/C++ source + header extensions, for resolving `#include` targets. */
const C_EXT = /\.(c|h|cc|cpp|cxx|hpp|hh|hxx|inl|ipp|c\+\+|h\+\+)$/i;
/** Python source + stub extensions, for the constructor-call fallback below. */
const PY_EXT = /\.pyi?$/i;
/** What a bare Python call falls back to when no function of that name exists:
 * construction. Only `class` — Python enums, dataclasses and NamedTuples are all
 * classes, so no other kind is reachable this way. */
const PY_CTOR_KINDS: Kind[] = ["class"];
/** Swift is Python's case with more nominal kinds: `Animal(legs: 4)` is an ordinary
 * call node with no `new` to mark construction, and struct/enum initializers are as
 * routine as class ones (a struct gets a memberwise init for free). Same fallback
 * shape — types are tried only once functions (and methods, see extract.ts's
 * implicit-self widening) have found nothing. */
const SWIFT_EXT = /\.swift$/i;
const SWIFT_CTOR_KINDS: Kind[] = ["class", "struct", "enum"];

/**
 * Languages whose symbols can genuinely reach each other. A call edge may not
 * cross a family boundary.
 *
 * This exists because name resolution is repo-wide and used to be language-blind.
 * A Go file calling the builtin `make(...)` has nothing in the repo to resolve
 * against, so the unique-global fallback below matched a TypeScript helper named
 * `make` in a frontend test file — and then every `make(map[...])` in the backend
 * became an edge into that file. One symbol collected 1040 in-edges across 476
 * files, and any pull request touching that test dragged the entire Go backend
 * into its blast radius. Uniqueness is what made it fire: the rarer the collision,
 * the more confident the old code was that it had found the right target.
 *
 * Only real interop is grouped here. TS/TSX/JS import each other freely; Kotlin,
 * Scala and Clojure compile against Java on one classpath; C and C++ share
 * headers. Everything else stands alone.
 */
const FAMILIES: ReadonlyArray<readonly string[]> = [
  ["typescript", "tsx"],
  ["java", "kotlin", "scala", "clojure"],
  ["c", "cpp"],
];
const FAMILY_OF = new Map<string, string>();
for (const group of FAMILIES) for (const lang of group) FAMILY_OF.set(lang, group[0]);

/**
 * The language family a path belongs to, or null when no tier claims the file.
 * A language of its own is its own family, so the common case needs no entry above.
 */
function familyOf(path: string): string | null {
  const lang = languageOf(path) ?? genericLangOf(path)?.name ?? null;
  if (!lang) return null;
  return FAMILY_OF.get(lang) ?? lang;
}

/**
 * Could a reference in `file` reach a definition in `candidatePath`?
 *
 * An unknown family never filters: absence of data is not evidence of a mismatch,
 * and refusing edges for every extension graft cannot name would lose real ones.
 */
function reachable(file: string, candidatePath: string): boolean {
  const from = familyOf(file);
  if (from === null) return true;
  const to = familyOf(candidatePath);
  return to === null || from === to;
}

/** A Go module discovered in the repo: its `module` path from `go.mod` and the repo
 * directory that `go.mod` lives in (posix, `.` for the repo root). A monorepo may hold
 * several — e.g. `backend/go.mod`, `tools/go.mod`. */
export interface GoModule {
  module: string;
  dir: string;
}

export interface ResolveOptions {
  /** The Go modules found in the repo. Enables mapping Go import package paths
   * (`example.com/app/pkg/util`) to the in-repo directory they name, relative to the
   * owning module's `go.mod` location. Empty/absent → Go imports stay external strings. */
  goModules?: GoModule[];
}

export function resolveEdges(
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  opts: ResolveOptions = {},
): EdgeV1[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const globalName = new Map<string, NodeV1[]>();
  const perFileName = new Map<string, Map<string, NodeV1[]>>();
  // Owner-qualified method index: "Owner.method" → candidate method nodes, for
  // typed member-call resolution (recvType + name → a specific class's method).
  const ownerMethod = new Map<string, NodeV1[]>();
  // Go package resolution: dir (posix) → its `.go` file node ids, for import mapping.
  const goFilesByDir = new Map<string, string[]>();
  // Java package resolution: a file's package-path suffix (`com/acme/Foo.java`) → its
  // file node ids. A Java import names a type by its fully-qualified name, which by
  // language convention mirrors the directory path under whatever source root the
  // project uses (`src/main/java/`, `src/`, …) — so the suffix is the portable key.
  const javaFilesBySuffix = new Map<string, string[]>();
  // C/C++ header resolution: a file's path-suffix (`net/socket.h`, `socket.h`) → its
  // file node ids, so an `#include` reached through an `-I` dir (not relative to the
  // including file) still resolves to the in-repo header when the suffix is unique.
  const cFilesBySuffix = new Map<string, string[]>();
  // Rust crate roots: the directory holding a `lib.rs` or `main.rs`. A `use crate::a::b`
  // resolves to `<crate root>/a/b.rs` (or `.../a/b/mod.rs`), relative to the crate the
  // importing file belongs to — so a workspace with several crates stays unambiguous.
  const rustCrateRoots: string[] = [];
  // PHP class resolution: a file's path-suffix (`Models/User.php`, `User.php`) → its file
  // node ids. A `use App\Models\User` names a PSR-4 class whose file mirrors the namespace
  // tail under some (unknown) source root, so the suffix is the portable key.
  const phpFilesBySuffix = new Map<string, string[]>();
  const hasGoModules = !!opts.goModules?.length;
  for (const n of nodes) {
    if (n.kind === "file") {
      if (hasGoModules && n.path.endsWith(".go")) {
        const dir = posix.dirname(toPosixPath(n.path));
        push(goFilesByDir, dir, n.id);
      }
      if (n.path.endsWith(".java")) {
        // Index every directory-boundary suffix, since the source root is unknown:
        // `src/main/java/com/acme/Foo.java` is reachable as `com/acme/Foo.java`,
        // `acme/Foo.java`, and so on. The import's own FQN picks the right depth.
        const parts = toPosixPath(n.path).split("/");
        for (let i = 0; i < parts.length; i++) push(javaFilesBySuffix, parts.slice(i).join("/"), n.id);
      }
      if (C_EXT.test(n.path)) {
        const parts = toPosixPath(n.path).split("/");
        for (let i = 0; i < parts.length; i++) push(cFilesBySuffix, parts.slice(i).join("/"), n.id);
      }
      if (n.path.endsWith(".php")) {
        const parts = toPosixPath(n.path).split("/");
        for (let i = 0; i < parts.length; i++) push(phpFilesBySuffix, parts.slice(i).join("/"), n.id);
      }
      {
        const p = toPosixPath(n.path);
        if (p === "lib.rs" || p === "main.rs") rustCrateRoots.push("");
        else if (p.endsWith("/lib.rs") || p.endsWith("/main.rs")) rustCrateRoots.push(posix.dirname(p));
      }
      continue;
    }
    push(globalName, n.name, n);
    let fileMap = perFileName.get(n.path);
    if (!fileMap) perFileName.set(n.path, (fileMap = new Map()));
    push(fileMap, n.name, n);
    if (n.kind === "method") {
      const owner = n.owner ?? ownerFromMethodId(n.id);
      if (owner) push(ownerMethod, `${owner}.${n.name}`, n);
    }
  }

  // classParents: class/interface name → its declared base-class names, from raw
  // `extends` edges (source id's own name → the base name). Used to walk up an
  // inheritance chain when a receiver's own type has no matching method.
  const classParents = new Map<string, string[]>();
  for (const e of rawEdges) {
    if (e.relation !== "extends" || !e.name) continue;
    // The declaring class's own bare name — read from its node (keyed by n.name, set
    // once at mint time) rather than re-derived by slicing e.source, which breaks once
    // ids can carry a dedup ordinal (A3's `Cache~2`).
    const ownName = byId.get(e.source)?.name;
    if (!ownName) continue;
    push(classParents, ownName, e.name);
  }

  // classTraits: class name → trait names from raw `implements` edges in PHP files.
  // PHP models `use SomeTrait;` as implements; trait methods live on the trait owner,
  // not the using class, so resolveTypedMember walks these after the class lookup fails.
  const classTraits = new Map<string, string[]>();
  for (const e of rawEdges) {
    if (e.relation !== "implements" || !e.name || !e.file.endsWith(".php")) continue;
    const ownName = byId.get(e.source)?.name;
    if (!ownName) continue;
    push(classTraits, ownName, e.name);
  }

  const out: EdgeV1[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, relation: Relation, confidence: EdgeV1["confidence"]) => {
    const key = `${source}\0${relation}\0${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, target, relation, confidence });
  };

  for (const e of rawEdges) {
    if (e.relation === "contains" && e.targetId) {
      add(e.source, e.targetId, "contains", "extracted");
    } else if (e.relation === "imports" && e.specifier) {
      const target =
        hasGoModules && e.file.endsWith(".go")
          ? resolveGoImport(e.specifier, opts.goModules!, goFilesByDir)
          : e.file.endsWith(".java")
            ? resolveJavaImport(e.specifier, javaFilesBySuffix)
            : C_EXT.test(e.file)
              ? resolveCInclude(e.specifier, e.file, byId, cFilesBySuffix)
              : e.file.endsWith(".rs")
                ? resolveRustUse(e.specifier, e.file, byId, rustCrateRoots)
                : e.file.endsWith(".php")
                  ? resolvePhpUse(e.specifier, phpFilesBySuffix)
                  : resolveImport(e.specifier, e.file, byId);
      add(e.source, target, "imports", "extracted");
    } else if (e.relation === "extends" || e.relation === "implements") {
      // `implements` also resolves to a `trait` — PHP models trait composition
      // (`use SomeTrait;`) as an implements edge, and a trait is a valid target.
      const kinds: Kind[] = e.relation === "implements" ? ["interface", "trait"] : ["class", "interface"];
      const hit = resolveName(e.name!, e.file, kinds, perFileName, globalName);
      // an unresolved base is usually an external/imported type — keep the name.
      add(e.source, hit?.id ?? e.name!, e.relation, hit?.confidence ?? "inferred");
    } else if (e.relation === "references" && e.name) {
      if (e.specifier) {
        // A named import gives both halves needed for sound resolution: the module
        // it came from and the exported name. Resolve inside that file only, so a
        // same-named symbol elsewhere in the repo cannot become a false edge.
        const targetFile = e.file.endsWith(".php")
          ? resolvePhpUse(e.specifier, phpFilesBySuffix)
          : resolveImport(e.specifier, e.file, byId);
        if (!byId.has(targetFile)) continue; // external or unresolved module
        const candidates = perFileName.get(targetFile)?.get(e.name) ?? [];
        if (candidates.length === 1) add(e.source, candidates[0].id, "references", "extracted");
      } else if (e.file.endsWith(".php") && byId.get(e.source)?.origin === "ast") {
        // PHP attribute without a `use` import (same-file or globally unique class).
        const refKinds: Kind[] = ["class", "interface", "trait", "enum"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        if (hit && hit.id !== e.source) add(e.source, hit.id, "references", hit.confidence);
      } else if (e.file.endsWith(".java") && byId.get(e.source)?.origin === "ast") {
        // Java annotation without a specifier (same-file or globally unique
        // `@interface`). Annotation types are `interface` kind — a class of the
        // same name is not a match, so `@Entity` cannot collapse onto an in-repo
        // `class Entity` (#103). Kind alone still cannot tell `@interface Service`
        // from `interface Service`, so only accept a candidate whose header
        // contains the literal `@interface` (`includes`, not `startsWith`: a
        // meta-annotated type is `@Documented @Retention(...) public @interface
        // JsonAdapter`). Unresolved targets keep the bare name, matching
        // heritage, rather than dropping the way PHP attributes do.
        const refKinds: Kind[] = ["interface"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        const anno = hit ? byId.get(hit.id) : undefined;
        if (hit && hit.id !== e.source && anno?.signature?.includes("@interface"))
          add(e.source, hit.id, "references", hit.confidence);
        else add(e.source, e.name, "references", "inferred");
      } else if (byId.get(e.source)?.origin === "generic") {
        // Breadth tier: a bare-name structural reference (extends / implements /
        // object-creation / module alias) the grammar marked but cannot type. Resolve
        // to a type-like definition, drop-rather-than-guess, never a self-loop. Gated on
        // generic origin so depth-tier references (which always carry a specifier) are
        // provably untouched.
        const refKinds: Kind[] = ["class", "interface", "struct", "enum", "type", "module"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        if (hit && hit.id !== e.source) add(e.source, hit.id, "references", hit.confidence);
      }
    } else if (e.relation === "calls") {
      if (e.viaMember) {
        if (!e.recvType) continue;
        const hit = resolveTypedMember(e.recvType, e.name!, e.file, ownerMethod, classParents, classTraits, e.argCount);
        if (hit === "ambiguous") continue; // drop — never guess past an ambiguous owner
        if (hit) {
          add(e.source, hit.id, "calls", hit.confidence);
          continue;
        }
        // No owner-qualified match means the call is unresolved. A unique bare
        // method name is not evidence that this receiver has that method — a
        // name-fallback here was measured to HALVE call-edge precision (73%→37%
        // vs a compiler-grade oracle) for a 3x count inflation, i.e. noise. See #35.
        //
        // One carve-out, which is NOT that fallback: a Swift `implicitSelf` edge
        // carries two readings of one bare call — member (tried above, in
        // Swift's own inner-scope-first order) and free function. Zero members
        // on the whole owner chain means the call was a free-function call after
        // all, so it falls through to bare-name resolution; an ambiguous member
        // set has already dropped it above, and a resolved member never reaches
        // here — a name defined as both member and free function yields the
        // member edge alone, exactly as Swift dispatches it.
        if (!e.implicitSelf) continue;
      }
      // Every language's bare-name call is a free function, except R (Phase 4):
      // an untyped `obj$method()` there sets e.kinds to also allow a "method"
      // match — see extract.ts's calleeName R branch for why (R6 methods are
      // never kind "function", so without this every such call would be
      // unconditionally unresolvable rather than just occasionally ambiguous).
      // Three cases, because "a bare call" means something different per tier:
      //
      //  - generic (breadth tier): tags.scm captures ALL calls as bare names, since it
      //    cannot type a receiver. In method-heavy languages those target methods, so
      //    widen to methods — ONLY here, leaving depth-tier precision untouched (an
      //    ambiguous function-vs-method name still drops).
      //  - Java (depth tier): an implicit-`this` call is spelled as a member call in
      //    extract.ts, so the only bare call reaching here is `new Foo()`, whose target
      //    is a TYPE. Against the function index every constructor edge would drop.
      //  - everything else: functions, exactly as before.
      //
      // R (depth tier, Phase 4) sets `e.kinds` itself for an untyped `obj$method()`
      // (see above), and that explicit choice wins over the per-tier default.
      const srcOrigin = byId.get(e.source)?.origin;
      const callKinds: Kind[] =
        e.kinds ??
        (srcOrigin === "generic"
          ? ["function", "method"]
          : e.file.endsWith(".java")
            ? ["class", "struct", "enum", "interface"]
            : ["function"]);
      // A call through a named import (TypeScript, extract.ts) names its module.
      // An external or unresolved module means the callee is not in this repo:
      // drop the edge rather than let the unique-name fallback bind it to an
      // unrelated same-named local function (a test mock, a helper named
      // `expect`) and report it as a production dependency (#330). An in-repo
      // module that defines the name resolves to that definition alone; one
      // that does not (a barrel re-export) keeps the name-based fallback.
      if (e.specifier) {
        const targetFile = resolveImport(e.specifier, e.file, byId);
        if (!byId.has(targetFile)) continue;
        const inModule = (perFileName.get(targetFile)?.get(e.name!) ?? []).filter((n) =>
          callKinds.includes(n.kind),
        );
        if (inModule.length === 1) {
          add(e.source, inModule[0].id, "calls", "extracted");
          continue;
        }
        if (inModule.length > 1) continue;
      }
      let hit = resolveName(e.name!, e.file, callKinds, perFileName, globalName);
      // Python is the Java case without the `new` to mark it: `Widget()` is an
      // ordinary call node, so a constructor edge dies against the function-only
      // index. Java can widen to types outright; Python has free functions, so
      // widening would trade real function edges for type ones. Hence a fallback,
      // not a swap — types are tried only once functions have found nothing, and
      // resolveName's same-file-then-unique-global rule still drops the ambiguous.
      if (!hit && PY_EXT.test(e.file)) {
        hit = resolveName(e.name!, e.file, PY_CTOR_KINDS, perFileName, globalName);
      }
      if (!hit && SWIFT_EXT.test(e.file)) {
        hit = resolveName(e.name!, e.file, SWIFT_CTOR_KINDS, perFileName, globalName);
      }
      if (hit) add(e.source, hit.id, "calls", hit.confidence); // drop unresolved calls (too noisy)
    }
  }
  return out;
}

function push<T>(map: Map<string, T[]>, key: string, val: T): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

/** Derive a method's owner from its dotted id when extract did not stamp `owner`
 * (PHP trait/interface methods today). `app.php#Loggable.log` → `Loggable`. */
function ownerFromMethodId(id: string): string | undefined {
  const post = id.includes("#") ? id.split("#")[1] : id;
  const segs = post.split(".");
  return segs.length >= 2 ? segs[segs.length - 2] : undefined;
}

/**
 * Resolve a bare symbol name: same-file match first (certain → `extracted`),
 * else a unique cross-file match (→ `inferred`), else null (ambiguous/unknown).
 */
function resolveName(
  name: string,
  file: string,
  kinds: Kind[],
  perFileName: Map<string, Map<string, NodeV1[]>>,
  globalName: Map<string, NodeV1[]>,
): { id: string; confidence: EdgeV1["confidence"] } | null {
  const local = (perFileName.get(file)?.get(name) ?? []).filter((n) => kinds.includes(n.kind));
  // Same-file requires a UNIQUE match, exactly as the cross-file branch below does.
  // Returning `local[0]` meant a file holding two same-named types (`Alpha.Builder` and
  // `Beta.Builder`, `Alpha.Inner` and `Beta.Inner`) silently resolved to whichever came
  // first in document order — and labelled it `extracted`, i.e. certain. That is the
  // guess this module's header says it does not make.
  if (local.length === 1) return { id: local[0].id, confidence: "extracted" };
  // Cross-file: also require a language that could actually reach this one.
  // Without it a unique name match ANYWHERE in the repo wins, which is how a Go
  // builtin ended up resolving into a TypeScript test — see FAMILIES above.
  const global = (globalName.get(name) ?? []).filter(
    (n) => kinds.includes(n.kind) && reachable(file, n.path),
  );
  if (global.length === 1) return { id: global[0].id, confidence: "inferred" };
  return null;
}

/**
 * Resolve a typed member call (`recvType.name`) against the owner-qualified method
 * index, walking the receiver's extends chain when its own type has no match.
 *
 * Returns:
 *   - `{ id, confidence }` — resolved: a single candidate at some owner level (or the
 *     same-file one among several).
 *   - `"ambiguous"` — several candidates at some owner level and none is same-file;
 *     per the inviolable philosophy we drop and stop rather than guess, and we do
 *     NOT continue up the chain past this level.
 *   - `null` — the whole chain (recvType + ancestors, breadth-first, depth ≤ 3,
 *     cycle-guarded) had zero candidates at every level.
 */
/**
 * Narrow an overload set to the candidates a call of `argCount` arguments could
 * reach. Only Java emits `argCount`/`arity`, so for every other language this is
 * the identity function and resolution is byte-for-byte what it was.
 *
 * Deliberately conservative in both directions:
 *   - A variadic candidate (`String... xs`) accepts anything from `arity - 1`
 *     upward, so it is never filtered out by count.
 *   - A candidate with no recorded arity (a graph built before this field) is
 *     kept, since absence of data is not evidence of a mismatch.
 *   - If narrowing leaves nothing, the ORIGINAL set is returned. An empty result
 *     would silently drop a real edge; handing the full set back lets the existing
 *     same-file / "ambiguous" logic make the call exactly as before.
 */
function narrowByArity(candidates: NodeV1[], argCount?: number): NodeV1[] {
  if (argCount === undefined || candidates.length < 2) return candidates;
  const fits = candidates.filter((c) => {
    if (c.arity === undefined) return true;
    return c.variadic ? argCount >= c.arity - 1 : c.arity === argCount;
  });
  return fits.length > 0 ? fits : candidates;
}

function resolveTypedMember(
  recvType: string,
  name: string,
  file: string,
  ownerMethod: Map<string, NodeV1[]>,
  classParents: Map<string, string[]>,
  classTraits: Map<string, string[]>,
  argCount?: number,
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  const MAX_DEPTH = 3;
  const visited = new Set<string>([recvType]);
  let frontier = [recvType];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
    for (const type of frontier) {
      const all = ownerMethod.get(`${type}.${name}`)?.filter((c) => reachable(file, c.path));
      if (all && all.length > 0) {
        const candidates = narrowByArity(all, argCount);
        if (candidates.length === 1) {
          const c = candidates[0];
          return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
        }
        // Swift: several candidates surviving arity narrowing are a genuine
        // overload set distinguished only by parameter TYPES (`save(Int)` vs
        // `save(String)`), which this pass cannot read — the same-file tiebreak
        // below would pick whichever overload appears first in the file and
        // stamp it `extracted`, a confidently wrong edge. Drop instead.
        if (SWIFT_EXT.test(file)) return "ambiguous";
        const sameFile = candidates.find((c) => c.path === file);
        if (sameFile) return { id: sameFile.id, confidence: "extracted" };
        return "ambiguous"; // several, none same-file — drop and stop
      }
      const traitHit = resolveTraitMember(type, name, file, ownerMethod, classTraits, argCount);
      if (traitHit === "ambiguous") return "ambiguous";
      if (traitHit) return traitHit;
    }
    const next: string[] = [];
    for (const type of frontier) {
      for (const parent of classParents.get(type) ?? []) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return null; // chain exhausted, no candidate anywhere
}

/** Resolve a member call against methods declared on PHP traits used by `type`. */
function resolveTraitMember(
  type: string,
  name: string,
  file: string,
  ownerMethod: Map<string, NodeV1[]>,
  classTraits: Map<string, string[]>,
  argCount?: number,
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  const traits = classTraits.get(type);
  if (!traits?.length) return null;
  const matches: NodeV1[] = [];
  for (const trait of traits) {
    const all = ownerMethod.get(`${trait}.${name}`)?.filter((c) => reachable(file, c.path));
    if (!all?.length) continue;
    matches.push(...narrowByArity(all, argCount));
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    const c = matches[0];
    return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
  }
  return "ambiguous";
}

/**
 * Resolve a module specifier to a file node id when it points inside the repo;
 * otherwise return the raw specifier (external package or unresolved path).
 */
function resolveImport(spec: string, file: string, byId: Map<string, NodeV1>): string {
  if (!spec.startsWith(".")) return spec;
  // Belt-and-braces: `node.path` is posix by construction (`../util/paths.ts`),
  // but this also accepts a hand-written or hand-edited graph.
  const dir = posix.dirname(toPosixPath(file));
  const base = posix.normalize(posix.join(dir, spec));
  const noExt = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, "");
  const candidates = [
    base,
    ...IMPORT_EXTS.map((e) => noExt + e),
    ...IMPORT_EXTS.map((e) => `${noExt}/index${e}`),
  ];
  for (const c of candidates) if (byId.has(c)) return c;
  return spec;
}

/**
 * Resolve a Java import's fully-qualified type name to an in-repo file node;
 * otherwise return the raw specifier (JDK or third-party type).
 *
 * Java names a *type*, not a path, and states no source root — `com.acme.Foo` may
 * live under `src/main/java/`, `src/`, or a module dir. Matching on the path SUFFIX
 * (`com/acme/Foo.java`) is therefore root-agnostic and needs no build-file parsing,
 * which is what keeps this deterministic and dependency-free.
 *
 * `import static com.acme.Foo.bar` names a member, so when the full name misses, the
 * last segment is dropped and the enclosing type retried. A wildcard (`com.acme.*`)
 * names a package rather than one file and is deliberately left unresolved: picking a
 * representative would invent an edge the source does not state.
 *
 * A suffix shared by two files (the same FQN under two source roots, e.g. a
 * duplicated test tree) is ambiguous, so it stays unresolved rather than guessing.
 */
function resolveJavaImport(spec: string, filesBySuffix: Map<string, string[]>): string {
  const hit = (fqn: string): string | null => {
    const suffix = `${fqn.split(".").join("/")}.java`;
    const files = filesBySuffix.get(suffix);
    return files && files.length === 1 ? files[0] : null;
  };
  const direct = hit(spec);
  if (direct) return direct;
  // `import static a.b.C.member` → retry as `a.b.C`.
  const dot = spec.lastIndexOf(".");
  if (dot > 0) {
    const enclosing = hit(spec.slice(0, dot));
    if (enclosing) return enclosing;
  }
  return spec;
}

/**
 * Resolve a C/C++ `#include "path"` to an in-repo file node: relative to the including
 * file first (the common case, and certain), else a UNIQUE path-suffix match — which
 * covers a header reached through an `-I` include directory rather than a relative path.
 * Anything ambiguous or not found stays the raw path (a system or out-of-repo header),
 * never a guessed edge.
 */
function resolveCInclude(
  spec: string,
  file: string,
  byId: Map<string, NodeV1>,
  bySuffix: Map<string, string[]>,
): string {
  const dir = posix.dirname(toPosixPath(file));
  const relJoin = posix.normalize(posix.join(dir, spec));
  if (byId.has(relJoin)) return relJoin; // relative to the including file — certain
  const hits = bySuffix.get(spec.replace(/^\.?\//, ""));
  if (hits && hits.length === 1) return hits[0]; // unique suffix — an -I-reached header
  return spec; // system/out-of-repo/ambiguous — keep the string, do not guess
}

/**
 * Resolve a PHP `use` fully-qualified name (`App\Models\User`) to the in-repo class file.
 * PSR-4 maps the namespace to a directory under some (unknown) source root and the class
 * to a `<Class>.php` file, so we match the longest namespace-tail suffix that names exactly
 * one file: `App/Models/User.php`, then `Models/User.php`, then `User.php`. The longest
 * unique match wins; an ambiguous tail or a vendor/out-of-repo class stays the raw name.
 */
function resolvePhpUse(fqn: string, bySuffix: Map<string, string[]>): string {
  const parts = fqn.split("\\").filter(Boolean);
  if (parts.length === 0) return fqn;
  for (let i = 0; i < parts.length; i++) {
    const suffix = `${parts.slice(i).join("/")}.php`;
    const hits = bySuffix.get(suffix);
    if (hits && hits.length === 1) return hits[0];
    if (hits && hits.length > 1) break; // ambiguous at the most specific level — do not guess
  }
  return fqn;
}

/**
 * Resolve a Rust `crate`-relative module path (`crate/a/b`, from `use crate::a::b::Item`)
 * to the in-repo module file — `<crate root>/a/b.rs` or `<crate root>/a/b/mod.rs`, where
 * the crate root is the `lib.rs`/`main.rs` directory the importing file lives under. The
 * per-file crate root keeps a multi-crate workspace unambiguous. Not found or ambiguous
 * (two roots, both `a/b.rs` and `a/b/mod.rs`) stays a `crate::…` string — never a guess.
 */
function resolveRustUse(spec: string, file: string, byId: Map<string, NodeV1>, crateRoots: string[]): string {
  const full = spec.replace(/^crate\/?/, ""); // "crate/a/b/Item" → "a/b/Item"; "crate" → ""
  const fpath = toPosixPath(file);
  // the crate this file belongs to: the longest root that contains it (workspace-safe)
  const owning = crateRoots
    .filter((r) => r === "" ? true : fpath === r || fpath.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length);
  // No owning crate root (e.g. an integration test under `tests/`, whose `crate::` is the
  // TEST binary's own root, not a lib) → do NOT search every crate in a workspace: that
  // resolves `crate::util` to some unrelated crate's util.rs. Keep it a string instead.
  if (owning.length === 0) return full === "" ? "crate" : `crate::${full.replace(/\//g, "::")}`;
  const roots = [owning[0]];
  const segs = full === "" ? [] : full.split("/");
  const hitsFor = (rels: string[]): Set<string> => {
    const hits = new Set<string>();
    for (const r of roots) for (const rel of rels) {
      const cand = r === "" ? rel : `${r}/${rel}`;
      if (byId.has(cand)) hits.add(cand);
    }
    return hits;
  };
  // Try the longest module prefix first, shrinking toward — but NOT past — the first
  // segment. `crate::a::b::C` resolves as module `a/b` (C is the item); `crate::net` as
  // module `net`. The first prefix naming exactly one in-repo file wins; two matches at a
  // level are ambiguous → drop rather than guess.
  for (let k = segs.length; k >= 1; k--) {
    const modPath = segs.slice(0, k).join("/");
    const hits = hitsFor([`${modPath}.rs`, `${modPath}/mod.rs`]);
    if (hits.size === 1) return [...hits][0];
    if (hits.size > 1) break;
  }
  // The crate root (`lib.rs`/`main.rs`) is a target ONLY for `use crate::Item` or
  // `use crate::{…}` — a deeper path whose module chain didn't resolve is genuinely
  // unknown (a re-export, an inline `mod`, or out-of-tree), so keep it as a string.
  if (segs.length <= 1) {
    const hits = hitsFor(["lib.rs", "main.rs"]);
    if (hits.size === 1) return [...hits][0];
  }
  return full === "" ? "crate" : `crate::${full.replace(/\//g, "::")}`;
}

/**
 * Resolve a Go import package path to an in-repo file node when it points inside one of
 * the repo's modules; otherwise return the raw specifier (stdlib or third-party package).
 *
 * Go imports name a *package* (a directory), not a file. The package path is relative to
 * the owning module's path, so the in-repo directory is `<module go.mod dir>/<subpath>`.
 * This handles a `go.mod` anywhere in the tree — repo root or a subdirectory (monorepo).
 * When several modules' paths prefix the spec, the longest (most specific) wins. A package
 * dir may hold several `.go` files; we pick a deterministic representative (lowest id).
 */
function resolveGoImport(spec: string, modules: GoModule[], filesByDir: Map<string, string[]>): string {
  let best: { mod: GoModule; subpath: string } | null = null;
  for (const mod of modules) {
    let subpath: string | null = null;
    if (spec === mod.module) subpath = "";
    else if (spec.startsWith(mod.module + "/")) subpath = spec.slice(mod.module.length + 1);
    if (subpath === null) continue;
    if (!best || mod.module.length > best.mod.module.length) best = { mod, subpath };
  }
  if (!best) return spec; // stdlib / third-party — keep the package path

  const dir = posix.normalize(posix.join(best.mod.dir, best.subpath));
  const files = filesByDir.get(dir);
  if (!files || files.length === 0) return spec;
  return [...files].sort()[0];
}
