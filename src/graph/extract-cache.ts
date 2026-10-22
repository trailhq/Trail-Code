/**
 * Per-file memo for Tier-1 extraction — `<outDir>/.cache/extract.json`.
 *
 * `extractFile` is pure and file-local (`rel`, `source`, `lang` → `{nodes,
 * rawEdges}`), which is the whole trick: an unchanged file's parse result can be
 * replayed from disk instead of re-running tree-sitter. That turns
 * {@link buildGraph} from "always re-parse the repo" (~4.6ms/file) into "re-parse
 * only what moved", which is what makes a rebuild cheap enough to run *before*
 * every query (see `graph/refresh.ts`).
 *
 * Everything downstream of extraction (edge resolution, enrichment, the graph
 * write, the ask sidecar, cards) still runs over the whole merged node set, so no
 * other invariant changes — an incremental build must produce a byte-identical
 * `wiring.json` to a cold one.
 *
 * Crucially the cached nodes keep `body_text`: `writeGraph` strips it before
 * serializing, so `wiring.json` can never be the reuse source — the ask sidecar
 * needs a body for every node, including the ones we didn't re-parse.
 *
 * Lives under `.cache/` (gitignored, regenerate-anytime) next to `ask-index.json`
 * and `summaries.json`. Two things invalidate the whole file: a bump of
 * {@link CACHE_VERSION} for a change of on-disk shape, and a change to the
 * extraction code itself, caught by content-hashing it — see
 * {@link extractorStamp}. Neither asks anyone to remember to bump anything.
 */
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { CACHE_DIR } from "../context/node-file.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
import type { RawEdge } from "./extract.js";
import type { NodeV1 } from "./types.js";

/** Bump when the on-disk shape below changes. */
const CACHE_VERSION = 1;
export const EXTRACT_CACHE_PREFIX = "extract";

export interface ExtractEntry {
  size: number;
  mtimeMs: number;
  /** sha256 of the file's bytes — the same value as its `kind:"file"` node's `body_hash`. */
  hash: string;
  nodes: NodeV1[];
  rawEdges: RawEdge[];
  /** Set when this file couldn't be read or parsed. The entry exists anyway so the
   * freshness probe doesn't flag the file as new on every query; replaying it
   * re-reports the same error and contributes no nodes, exactly as a cold build
   * would. */
  error?: string;
  /** The optional parser for this file's language was unavailable. Unlike `error`,
   * this entry is re-parsed if that parser becomes available on a later run. */
  skipped?: true;
}

export interface ExtractCache {
  version: number;
  /** Identity of the extractor that produced these entries. */
  extractor: string;
  /** repo-relative source path → its last parse. */
  files: Record<string, ExtractEntry>;
}

/**
 * Where this graft's memo lives: `<outDir>/.cache/extract.<stamp>.json`.
 *
 * The stamp is in the *filename*, not just inside the file, so two grafts working
 * on one repo keep separate memos instead of evicting each other. That is the
 * default install, not an exotic case: `graft init` wires the MCP server as
 * `npx -y @nanonets/graft` (which resolves the latest published version) while the
 * Claude Code hooks run the locally installed one. The moment those two versions
 * differ, a single shared file means the prompt hook and every MCP retrieval take
 * turns rejecting each other's entries and cold-re-parsing the whole repo — the memo
 * would never help anyone.
 *
 * Null stamp → null path → no memo at all. See {@link extractorStamp}.
 */
export function extractCachePath(outDir: string): string | null {
  const stamp = extractorStamp();
  return stamp === null ? null : join(outDir, CACHE_DIR, `${EXTRACT_CACHE_PREFIX}.${stamp}.json`);
}

/** Keep `.cache/` from growing a file per version forever: after writing, drop all
 * but the newest `keep` files sharing a prefix. Best-effort and never fatal — this
 * is a cache directory, and a failure here costs disk, not correctness. */
export function pruneSidecars(cacheDir: string, prefix: string, keep = 2): void {
  try {
    const mine = readdirSync(cacheDir)
      .filter((f) => f.startsWith(`${prefix}.`) && f.endsWith(".json"))
      .map((f) => {
        const full = join(cacheDir, f);
        return { full, mtimeMs: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of mine.slice(keep)) rmSync(f.full, { force: true });
  } catch {
    /* nothing here is load-bearing */
  }
}

/** Computed once per process — this can't change under a running process without
 * the module graph itself being swapped, and a long-lived MCP server holding the
 * identity of the code it actually loaded is the correct answer anyway.
 * `undefined` = not computed yet; `null` = computed, and there is no identity. */
let memoizedStamp: string | null | undefined;

/**
 * Identity of the code that produces the cached parses. Both sidecars key on it,
 * so *anything* that can change extraction output has to change this string.
 *
 * Content-hashed over every sibling module in this directory, plus the package
 * version. Two earlier instincts are deliberately rejected:
 *
 * - **Not a timestamp.** This was `mtime:size` of `extract.js` alone, which is
 *   wrong in both directions. Too loose: the parse of `db.count()` depends on
 *   `bindings.ts` deciding that `db` is a `UserRepo` (that answer is stored *in*
 *   the cached entry, as an edge's `recvType`), and fixing a binding bug leaves
 *   `extract.js`'s emitted bytes untouched — so any build that skips rewriting
 *   unchanged output keeps the old stamp and silently replays pre-fix edges. Too
 *   tight: a rebuild that rewrites identical content moves the mtime and throws
 *   away the whole memo for nothing.
 * - **Not a hand-kept list of modules.** A list is correct exactly until someone
 *   moves parse logic into a module nobody added to it, and the failure is silent.
 *
 * Hashing the directory over-invalidates a little — editing any `graph/` module
 * costs one cold rebuild — which is no more often than a version bump already
 * costs, and always in the safe direction. The package version is folded in so a
 * tree-sitter grammar upgrade (which changes parse output without changing any of
 * graft's own files) invalidates too.
 *
 * Measured at ~0.5ms for 21 files / 556KB, paid once per process.
 *
 * **Null when no identity can be established at all**, and that is deliberately not
 * a string. It used to return `"unknown"` on failure — but `"unknown"` was then
 * *written into the sidecars as a real identity*, and every later run compared equal
 * to it, so any environment where stamping fails (a `pkg`/`bun-compile` single-file
 * build, an asar-style read, a directory that can't be listed) permanently lost the
 * ability to notice an extractor change. A sentinel that doubles as a valid value
 * silently disables the whole mechanism. Null forces callers to decide instead, and
 * {@link extractCachePath} decides not to have a memo.
 */
export function extractorStamp(): string | null {
  if (memoizedStamp === undefined) memoizedStamp = computeStamp();
  return memoizedStamp;
}

function computeStamp(): string | null {
  try {
    const self = fileURLToPath(import.meta.url);
    // `.js` when running from `dist/`, `.ts` under tsx — take the extension from
    // our own filename rather than guessing which layout we're in.
    const dir = dirname(self);
    const hashed = stampDir(dir, extname(self), packageVersion(dir) ?? "");
    if (hashed) return hashed;
    // Couldn't read the modules (bundled into one file, say). The version alone is
    // a weaker identity — it can't see a local edit — but it still turns over on
    // every upgrade, which is the case that ships broken parses to users.
    const v = packageVersion(dir);
    return v ? `v${v}` : null;
  } catch {
    return null;
  }
}

/**
 * Hash every `ext` file in `dir`, plus `version`. Null when the directory holds no
 * such file. Separated from {@link extractorStamp} so a test can prove the property
 * that matters: a change to *any* module in the directory moves the stamp, not just
 * the one the old implementation happened to watch.
 */
export function stampDir(dir: string, ext: string, version = ""): string | null {
  const files = readdirSync(dir).filter((f) => f.endsWith(ext)).sort();
  if (!files.length) return null;
  const h = createHash("sha256");
  h.update(version);
  for (const f of files) {
    h.update(f); // a rename is a change, even at identical content
    h.update(readFileSync(join(dir, f)));
  }
  return h.digest("hex").slice(0, 16);
}

/** graft's own version, or null when it can't be read. */
function packageVersion(graphDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(graphDir, "..", "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export function emptyExtractCache(): ExtractCache {
  return { version: CACHE_VERSION, extractor: extractorStamp() ?? "", files: {} };
}

/** The cache for `outDir`, or an empty one when it's absent, unparseable, written by
 * a different cache version, or when this graft has no identity to key on (then
 * every build is cold, which is slow but never wrong). The stamp is in the filename,
 * so the `extractor` field is a second check rather than the only one. */
export function readExtractCache(outDir: string): ExtractCache {
  const path = extractCachePath(outDir);
  const stamp = extractorStamp();
  if (path === null || stamp === null) return emptyExtractCache();
  const c = readJson<ExtractCache>(path);
  if (!c || c.version !== CACHE_VERSION || c.extractor !== stamp || typeof c.files !== "object") {
    return emptyExtractCache();
  }
  return { version: c.version, extractor: c.extractor, files: c.files ?? {} };
}

/** Best-effort write — a full graph is already on disk by the time this runs, so an
 * unwritable cache dir must never fail the build (it only costs the next build its
 * reuse). Returns false when nothing was written, including the deliberate case of
 * having no extractor identity: a parse we can't attribute must never be replayed. */
export function writeExtractCache(outDir: string, cache: ExtractCache): boolean {
  const path = extractCachePath(outDir);
  if (path === null) return false;
  try {
    writeJsonAtomic(path, cache, true);
    pruneSidecars(join(outDir, CACHE_DIR), EXTRACT_CACHE_PREFIX);
    return true;
  } catch {
    return false;
  }
}
