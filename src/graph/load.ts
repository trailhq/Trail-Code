/**
 * File-metadata-keyed in-process cache over the two readers `ask()` calls on every
 * query: the wiring graph (`readGraph`) and the ask sidecar (`readAskIndex`).
 * `graft ask` re-parses these from disk on every invocation; in a long-lived
 * process — the MCP server, or `graft ask` invoked repeatedly in one process —
 * that means re-parsing the same ~tens-of-MB JSON on every tool call.
 *
 * Keyed by `(path, dev, ino, ctimeMs, mtimeMs, size)` from `statSync`.
 * Device/inode detect an atomic replacement even when its mtime and size are
 * preserved; ctime, mtime and size detect observable in-place changes. A
 * missing file returns null and drops any prior entry, so a file created after
 * a miss is picked up on the next call (no negative caching).
 *
 * Stat metadata is not a content hash: an in-place rewrite whose entire
 * observed signature remains unchanged can still look like a warm entry.
 * Same-process rebuild callers therefore continue to invalidate explicitly
 * rather than depending on filesystem timestamp resolution.
 *
 * Dependency-free by design: this module imports only `node:fs`, `./write.js`,
 * and `../ask/index-file.js`, so it can be imported from both `ask.ts` and
 * `mcp/tools.ts` without creating an import cycle.
 */
import { statSync } from "node:fs";
import { readGraph, wiringPath } from "./write.js";
import { readAskIndex, askIndexPath, type AskIndex } from "../ask/index-file.js";
import type { GraphV1 } from "./types.js";

interface FileStamp {
  dev: number;
  ino: number;
  ctimeMs: number;
  mtimeMs: number;
  size: number;
}

interface CacheEntry<T> extends FileStamp {
  value: T | null;
}

const graphCache = new Map<string, CacheEntry<GraphV1>>();
const askIndexCache = new Map<string, CacheEntry<AskIndex>>();

/** Real parses performed (cache misses), not cache hits — exported for tests
 * so the invalidation contract can be pinned down without spying on `fs`. */
export const __parseCount = { graph: 0, askIndex: 0 };

/** Test-only: zero the counters (module state persists across a test file). */
export function __resetParseCounts(): void {
  __parseCount.graph = 0;
  __parseCount.askIndex = 0;
}

function statOf(path: string): FileStamp | null {
  try {
    const s = statSync(path);
    return { dev: s.dev, ino: s.ino, ctimeMs: s.ctimeMs, mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function loadCached<T>(
  cache: Map<string, CacheEntry<T>>,
  path: string,
  parse: () => T | null,
  onParse: () => void,
): T | null {
  const st = statOf(path);
  if (!st) {
    // Missing file: don't negatively cache, and drop any stale entry so a
    // subsequently-created file at the same path is re-parsed, not served
    // from a cache keyed to the old file identity/metadata.
    cache.delete(path);
    return null;
  }
  const cached = cache.get(path);
  if (
    cached &&
    cached.dev === st.dev &&
    cached.ino === st.ino &&
    cached.ctimeMs === st.ctimeMs &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size
  ) {
    return cached.value;
  }
  onParse();
  const value = parse();
  cache.set(path, { ...st, value });
  return value;
}

/** Cached `readGraph(wiringPath(outDir))` — same null-on-missing/unparseable
 * semantics, re-reads only when the wiring file's identity/metadata changed.
 * Returns a shared cached reference; callers must not mutate the returned graph. */
export function loadGraphCached(outDir: string): GraphV1 | null {
  const path = wiringPath(outDir);
  return loadCached(graphCache, path, () => readGraph(path), () => {
    __parseCount.graph++;
  });
}

/** Cached `readAskIndex(outDir)` — same semantics, keyed on the sidecar file.
 * Returns a shared cached reference; callers must not mutate the returned index. */
export function loadAskIndexCached(outDir: string): AskIndex | null {
  const path = askIndexPath(outDir);
  return loadCached(askIndexCache, path, () => readAskIndex(outDir), () => {
    __parseCount.askIndex++;
  });
}

/**
 * Drop the cached graph + sidecar for `outDir`, forcing the next load to re-read.
 *
 * The file identity/metadata key detects external atomic replacements, but
 * cannot guarantee detection of an in-place rewrite with an unchanged stat
 * signature. The pre-query auto-refresh (`refresh.ts`) rebuilds and immediately
 * queries the graph, so callers that rebuild must still invalidate explicitly.
 */
export function invalidateGraphCaches(outDir: string): void {
  graphCache.delete(wiringPath(outDir));
  askIndexCache.delete(askIndexPath(outDir));
}
