/**
 * The depth tier's native grammars, loaded on first use and never fatally.
 *
 * Every depth-tier grammar is a native addon, and so is `tree-sitter` itself. Most
 * ship prebuilt binaries that load with no install step, but not all of them:
 * `tree-sitter-kotlin` ships none at all, and `tree-sitter` and
 * `tree-sitter-python` have no linux-arm64 build. Those work only if npm ran their
 * install script, which compiles one. npm 12 stopped running dependency install
 * scripts by default, so after a plain `npm install -g` the binary is not there.
 *
 * These used to be static imports at the top of extract.ts. One missing binary
 * then threw while the module graph loaded and took every command down with it,
 * the MCP server and the hooks included, even in a repo with no Kotlin in it.
 * Now each is required the first time a file of its language is parsed, and a
 * failure is remembered: that language's files go to its WASM stand-in in the
 * breadth tier instead (`fallbackLangOf` in generic.ts), and the build says which
 * languages and how to get the native parser back ({@link nativeFallbackNotice}).
 */
import { createRequire } from "node:module";
import type Parser from "tree-sitter";
import type { Language } from "./extract.js";

const nodeRequire = createRequire(import.meta.url);

const CORE = "tree-sitter";

/** The module each depth-tier grammar comes from, and the export that is the
 * grammar when the module ships more than one (typescript+tsx, php+php_only). */
const GRAMMAR_MODULES: Record<Language, { module: string; pick?: string }> = {
  typescript: { module: "tree-sitter-typescript", pick: "typescript" },
  tsx: { module: "tree-sitter-typescript", pick: "tsx" },
  python: { module: "tree-sitter-python" },
  go: { module: "tree-sitter-go" },
  r: { module: "tree-sitter-r" },
  java: { module: "tree-sitter-java" },
  kotlin: { module: "tree-sitter-kotlin" },
  swift: { module: "tree-sitter-swift" },
  php: { module: "tree-sitter-php", pick: "php" },
};

/** The name `npm --allow-scripts` needs, where it differs from the module name.
 * `tree-sitter-r` is an npm alias, and npm matches an allow entry against the real
 * package only: an alias as the key matches nothing. */
const NPM_NAME: Record<string, string> = {
  "tree-sitter-r": "@davisvaughan/tree-sitter-r",
};

type Loaded = { ok: true; value: unknown } | { ok: false; error: string };

let requireModule: (id: string) => unknown = (id) => nodeRequire(id);
const modules = new Map<string, Loaded>();
const ready = new Map<Language, boolean>();
/** undefined: not tried yet. null: tried, and the core binding is unusable. */
let parser: Parser | null | undefined;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function load(id: string): Loaded {
  let hit = modules.get(id);
  if (!hit) {
    try {
      hit = { ok: true, value: requireModule(id) };
    } catch (err) {
      hit = { ok: false, error: message(err) };
    }
    modules.set(id, hit);
  }
  return hit;
}

function coreParser(): Parser | null {
  if (parser === undefined) {
    const core = load(CORE);
    parser = null;
    if (core.ok) {
      try {
        parser = new (core.value as typeof Parser)();
      } catch (err) {
        modules.set(CORE, { ok: false, error: message(err) });
      }
    }
  }
  return parser;
}

function grammarOf(lang: Language): unknown {
  const { module, pick } = GRAMMAR_MODULES[lang];
  const m = load(module);
  if (!m.ok) return null;
  return pick ? ((m.value as Record<string, unknown>)[pick] ?? null) : m.value;
}

/**
 * True when `lang`'s native grammar loads and the parser accepts it. The first call
 * per language does the loading; the answer is cached for the life of the process.
 * Never throws.
 */
export function nativeReady(lang: Language): boolean {
  let ok = ready.get(lang);
  if (ok === undefined) {
    ok = false;
    // Load the grammar even when the core binding failed, so the notice can name
    // every package that is missing its binary, not only the first.
    const grammar = grammarOf(lang);
    const p = coreParser();
    if (p && grammar) {
      try {
        p.setLanguage(grammar as never);
        ok = true;
      } catch {
        /* an addon built for another tree-sitter ABI: unusable, though it loaded */
      }
    }
    ready.set(lang, ok);
  }
  return ok;
}

/** The shared native parser, set to `lang`. Throws when that grammar is not
 * available; callers ask {@link nativeReady} first and send the file elsewhere. */
export function nativeParser(lang: Language): Parser {
  if (!nativeReady(lang)) {
    const { module } = GRAMMAR_MODULES[lang];
    const why = [CORE, module].map((id) => modules.get(id)).find((m) => m && !m.ok);
    throw new Error(`the native ${lang} parser is not available${why && !why.ok ? `: ${why.error}` : ""}`);
  }
  const p = parser as Parser;
  p.setLanguage(grammarOf(lang) as never);
  return p;
}

/**
 * The npm packages whose missing binary keeps these languages off the native
 * parser: what `npm install --allow-scripts=…` has to name. Empty when every one
 * loaded, or when the ones that failed did load and were rejected by the parser
 * (an ABI mismatch, which no install flag fixes).
 */
export function missingNativePackages(langs: Iterable<Language>): string[] {
  const out = new Set<string>();
  for (const lang of langs) {
    if (nativeReady(lang)) continue;
    for (const id of [CORE, GRAMMAR_MODULES[lang].module]) {
      const m = modules.get(id);
      if (m && !m.ok) out.add(NPM_NAME[id] ?? id);
    }
  }
  return [...out].sort();
}

/** The languages a build parsed with a WASM stand-in instead of their native
 * grammar, and the packages to allow so the next install builds them. */
export interface NativeFallback {
  /** Display labels (`javascript`, not the `typescript` grammar that parses it). */
  languages: string[];
  packages: string[];
}

/**
 * The one line a build prints when some languages fell back, or null when none did.
 * One line on purpose: `graft init` passes on only the `⚠`/`✗` lines of the build
 * it runs, so a second line holding the fix would be dropped there.
 */
export function nativeFallbackNotice(fallback: NativeFallback | undefined, packageName: string): string | null {
  if (!fallback || fallback.languages.length === 0) return null;
  const langs = fallback.languages.join(", ");
  const what = fallback.languages.length === 1 ? "the native parser is" : "the native parsers are";
  const head = `⚠ ${langs}: basic parsing only, ${what} missing.`;
  if (fallback.packages.length === 0) return head;
  return `${head} To fix: npm install -g --allow-scripts=${fallback.packages.join(",")} ${packageName}`;
}

/** Test seam: replace how native modules are required (null restores the real
 * `require`), and forget everything loaded so far. A missing binary is simulated by
 * a function that throws for that module id, the way node-gyp-build does. */
export function setNativeRequireForTest(fn: ((id: string) => unknown) | null): void {
  requireModule = fn ?? ((id) => nodeRequire(id));
  modules.clear();
  ready.clear();
  parser = undefined;
}

/** The real `require` the seam above wraps, for a test's pass-through. */
export function realNativeRequire(id: string): unknown {
  return nodeRequire(id);
}
