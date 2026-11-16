/**
 * The cheap "has the working tree moved?" probe that gates the pre-query rebuild.
 *
 * Every graft retrieval call runs this, so it has to be ~free on the common
 * unchanged path: a walk + one `stat` per source file, no reads, no parsing.
 * Measured at ~3ms for 280 files. Only files whose `(size, mtimeMs)` disagree
 * with the last build's record get read and hashed, which is what keeps a `touch`
 * or a `git checkout` of identical bytes from triggering a pointless rebuild.
 *
 * Git supplies the visible file set (`tracked + untracked - ignored`) when
 * available, but drift is still measured against bytes in the working tree:
 * an uncommitted, staged, or committed edit to an indexed file looks the same.
 *
 * `<outDir>/.cache/fingerprint.json` is a projection of the extraction cache
 * (`extract-cache.ts`) minus the parse results, written by the same build. Keeping
 * it separate means the probe reads ~10KB instead of the multi-MB parse cache. The
 * two can only ever disagree by one sidecar going missing, and both directions
 * degrade safely: no fingerprint → "unknown, rebuild"; no parse cache → the
 * rebuild is just cold.
 */
import { readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { CACHE_DIR } from "../context/node-file.js";
import { contentHash } from "../util/id.js";
import { readSourceFile } from "../util/source.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { extractorStamp, pruneSidecars, type ExtractEntry } from "./extract-cache.js";
import { listSourceStats } from "./source-files.js";

export const FINGERPRINT_PREFIX = "fingerprint";
const FINGERPRINT_VERSION = 2;

/** The identity this graft's prints are filed under. Unlike the extract memo, a
 * missing extractor identity is *not* disqualifying here: freshness is a claim about
 * source bytes, and a build with no memo is merely cold, never wrong. So stamp what
 * we can and fall back to a shared bucket. */
function stamp(): string {
  return extractorStamp() ?? "nostamp";
}

/** `[size, mtimeMs, hash]` — positional to keep the file small. */
type Print = [number, number, string];

export interface Fingerprint {
  version: number;
  /** The extractor that produced the graph these prints describe — the same stamp
   * `extract.json` carries. Without it the two sidecars can disagree about whether
   * the graph is current: an extractor change correctly drops every memo entry,
   * yet the prints still match the tree byte-for-byte, so the probe would report
   * clean and queries would keep answering from nodes the old extractor built. */
  extractor: string;
  files: Record<string, Print>;
  /** Repo-relative directory prefixes this build was limited to (`--only-dir`).
   * Absent = full tree. Recorded here — not in the source repo's `.graft/config.json`
   * — so the query-path freshness probe (which never sees a CLI flag) enumerates the
   * identical whitelisted set and excluded files are never phantom "added" drift. */
  onlyDirs?: string[];
  /** Normalized source extension selection (`--extensions`); absent = all supported. */
  extensions?: string[];
  /** Absolute source root this build ran on. The refresh gate compares it against
   * the root a query resolved: a graph built for repo A must never be rebuilt from
   * repo B's file set (#438). */
  root?: string;
}

/** What moved since the last build. Empty in all three arrays = nothing to do. */
export interface Drift {
  /** Recorded files whose bytes differ now. */
  changed: string[];
  /** Source files with no record — new, or never indexed. */
  added: string[];
  /** Recorded files that are gone from disk. */
  removed: string[];
}

/** `<outDir>/.cache/fingerprint.<stamp>.json` — keyed by extractor identity for the
 * same reason the memo is (see {@link extractCachePath}): two grafts on one repo,
 * typically an `npx` MCP server and a locally installed hook binary, must not keep
 * invalidating each other's prints and forcing a cold rebuild on every call. */
export function fingerprintPath(outDir: string): string {
  return join(outDir, CACHE_DIR, `${FINGERPRINT_PREFIX}.${stamp()}.json`);
}

export function readFingerprint(outDir: string): Fingerprint | null {
  const f = readJson<Fingerprint>(fingerprintPath(outDir));
  if (!f || f.version !== FINGERPRINT_VERSION || typeof f.files !== "object" || !f.files) return null;
  if (f.extractor !== stamp()) return null; // different extractor — re-extract, don't trust these prints
  return f;
}

/** Project the extraction cache's entries into the probe sidecar. Best-effort:
 * the graph is already on disk when this runs, so a failed write costs the next
 * probe its fast path and nothing more. */
export function writeFingerprint(
  outDir: string,
  entries: Record<string, ExtractEntry>,
  onlyDirs?: string[],
  extensions?: string[],
  root?: string,
): boolean {
  const files: Record<string, Print> = {};
  for (const [rel, e] of Object.entries(entries)) files[rel] = [e.size, e.mtimeMs, e.hash];
  try {
    const record: Fingerprint = { version: FINGERPRINT_VERSION, extractor: stamp(), files };
    if (onlyDirs && onlyDirs.length > 0) record.onlyDirs = onlyDirs;
    if (extensions && extensions.length > 0) record.extensions = extensions;
    if (root) record.root = root;
    writeJsonAtomic(fingerprintPath(outDir), record, true);
    pruneSidecars(join(outDir, CACHE_DIR), FINGERPRINT_PREFIX);
    return true;
  } catch {
    return false;
  }
}

/**
 * The path as the filesystem answers it: symlinks resolved, so `/tmp/x` and
 * `/private/tmp/x` compare equal on macOS, where they are the same directory.
 *
 * `realpathSync` throws for a path that does not exist, and the guard has to
 * answer for a root the user may have mistyped, so fall back to `resolve` there
 * — a lexical normalization still catches trailing slashes and `.` segments,
 * which is the rest of what this comparison is for.
 */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Is the graph still homed at this root?
 *
 * Compared as real paths: macOS symlinks `/tmp` to `/private/tmp`, so a graph
 * built through one name and queried through the other is the same graph, and
 * treating it as a move would refuse to refresh it forever. Case-insensitive on
 * Windows, where the same directory legitimately answers to different casing.
 */
export function sameGraphRoot(recorded: string | undefined, resolved: string): boolean {
  if (!recorded) return true; // a graph that never recorded a root is not evidence of a move
  const a = realPath(recorded);
  const b = realPath(resolved);
  if (a === b) return true;
  return process.platform === "win32" && a.toLowerCase() === b.toLowerCase();
}

/**
 * The refresh gate's answer when the graph belongs to a different root (#438).
 *
 * Returns an actionable stderr note, or null when the roots match (or nothing was
 * recorded). The caller must NOT rebuild on a mismatch: an `ask` that lost its
 * repo-root positional anchors on the cwd concludes every file changed and
 * rebuilds the graph empty in a second — with the per-file cards surviving to
 * mask the damage. Refusing to touch the graph keeps it intact and tells the
 * user the one argument that makes the refresh honest.
 */
export function graphRootGuardNote(recorded: string | undefined, resolved: string): string | null {
  if (sameGraphRoot(recorded, resolved)) return null;
  return (
    `graph was built for ${recorded}, not ${resolve(resolved)} — ` +
    `answering from the existing graph; to refresh it, pass its root: ` +
    `graft ask <query> ${recorded}`
  );
}

/** Re-home a seeded worktree's copied fingerprint sidecars on the worktree root.
 * The seed copies the parent checkout's fingerprint verbatim (its prints are the
 * diff base the worktree refresh wants), so without this the copied `root` would
 * keep every worktree query looking like a foreign root. Best-effort: a failure
 * costs the next query its root guard, never a wrong answer. */
export function restampFingerprintRoot(outDir: string, root: string): void {
  const cacheDir = join(outDir, CACHE_DIR);
  let entries: string[];
  try {
    entries = readdirSync(cacheDir).filter((name) => name.startsWith(`${FINGERPRINT_PREFIX}.`));
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(cacheDir, name);
    try {
      const record = readJson<Fingerprint>(path);
      if (!record || typeof record !== "object" || record.root === root) continue;
      record.root = root;
      writeJsonAtomic(path, record, true);
    } catch {
      /* one sidecar failing to re-home must not fail the seed */
    }
  }
}

/** `GRAFT_REFRESH=hash` — never trust a stat, confirm every file by its bytes. */
export function alwaysHash(): boolean {
  return process.env.GRAFT_REFRESH === "hash";
}

/**
 * May a recorded `(size, mtimeMs, hash)` be trusted for the file `f` as it is on
 * disk now, without reading it?
 *
 * **The probe's rule only.** `buildGraph` deliberately does not use this: it reads
 * and hashes every file, every time. A stat may decide whether a query bothers
 * rebuilding; it may not decide what the rebuild itself looks at — otherwise
 * `graft check` (which always re-hashes) can report drift that the `graft build` it
 * recommends then refuses to repair. `GRAFT_REFRESH=hash` is the escape hatch for
 * the probe's blind spot: a same-length edit inside one mtime tick.
 *
 * An empty `hash` means the last build never got the bytes — always re-read.
 * A *parse* failure keeps its real hash, so it stays on the fast path: re-reading
 * bytes that failed to parse yesterday just fails to parse again.
 */
export function statUnchanged(
  rec: { size: number; mtimeMs: number; hash: string },
  f: { size: number; mtimeMs: number },
): boolean {
  if (alwaysHash()) return false;
  if (!rec.hash) return false;
  return rec.size === f.size && rec.mtimeMs === f.mtimeMs;
}

export function isClean(d: Drift): boolean {
  return d.changed.length === 0 && d.added.length === 0 && d.removed.length === 0;
}

export function driftCount(d: Drift): number {
  return d.changed.length + d.added.length + d.removed.length;
}

/**
 * Diff the working tree against the last build's fingerprint. Returns null when
 * there is no fingerprint to compare against (never built, or built by a version
 * that didn't write one) — callers should treat that as "unknown", not "clean".
 *
 * `GRAFT_REFRESH=hash` skips the stat fast path and hashes every file, for the
 * rare tooling that rewrites content while preserving size and mtime.
 */
export function probeDrift(root: string, outDir: string): Drift | null {
  const fp = readFingerprint(outDir);
  if (!fp) return null;

  const drift: Drift = { changed: [], added: [], removed: [] };
  const seen = new Set<string>();

  const onlyDirs = fp.onlyDirs && fp.onlyDirs.length > 0 ? new Set(fp.onlyDirs) : undefined;
  for (const f of listSourceStats(root, outDir, undefined, onlyDirs, fp.extensions)) {
    seen.add(f.rel);
    const print = fp.files[f.rel];
    if (!print) {
      drift.added.push(f.rel);
      continue;
    }
    const [size, mtimeMs, hash] = print;
    if (statUnchanged({ size, mtimeMs, hash }, f)) continue;
    // Suspect: confirm by bytes, so a touch (or a checkout that restores the
    // same content) doesn't cost a rebuild. An entry with an empty hash lands
    // here every time by design — that's a file the last build couldn't read, and
    // the only way to learn it's readable again is to try.
    let now: string;
    try {
      const source = readSourceFile(f.abs);
      if (source === null) {
        // A previously indexed file becoming undecodable is real drift: rebuild
        // once to remove its stale nodes. Empty-hash entries were already skipped
        // by the last build, so they remain clean and avoid rebuild churn.
        if (hash) drift.changed.push(f.rel);
        continue;
      }
      now = contentHash(source);
    } catch {
      continue; // unreadable right now — leave it to the next probe
    }
    if (now !== hash) drift.changed.push(f.rel);
  }

  for (const rel of Object.keys(fp.files)) {
    if (!seen.has(rel)) drift.removed.push(rel);
  }

  drift.changed.sort();
  drift.added.sort();
  drift.removed.sort();
  return drift;
}
