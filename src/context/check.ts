/**
 * `check` — is the committed `.context/` graph still in sync with the code?
 *
 * Pure I/O + hashing: no LLM, no network, milliseconds. It re-hashes the source
 * files the manifest recorded and compares. Meant to run in CI: exit 0 when the
 * graph is fresh, 1 when it has drifted (so a PR that changed code but not the
 * graph fails until `graft build --deep` is re-run and committed).
 *
 * Drift categories:
 *   content     a recorded source file's bytes changed
 *   removed     a recorded source file no longer exists
 *   coverage    a code file exists that no node was built from (new/uningested)
 *   index       a node's frontmatter disagrees with the manifest (hand-edited)
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { contentHash } from "../util/id.js";
import { relPosix } from "../util/paths.js";
import { readSourceFile } from "../util/source.js";
import { CODE_EXTENSIONS, listContextFiles } from "./build.js";
import { contextDirFor, readManifest, readNodes } from "./node-file.js";

export interface CheckResult {
  ok: boolean;
  /** True when there is no graph at all (init has never run). */
  missing: boolean;
  contentDrift: Array<{ path: string; from: string; to: string }>;
  removed: string[];
  coverage: string[];
  indexDrift: string[];
}

export interface CheckOptions {
  contextDir?: string;
  extensions?: string[];
}

export function checkContext(dir: string, opts: CheckOptions = {}): CheckResult {
  const root = resolve(dir);
  const outDir = contextDirFor(root, opts.contextDir);
  const exts = opts.extensions ?? CODE_EXTENSIONS;

  const result: CheckResult = {
    ok: false,
    missing: false,
    contentDrift: [],
    removed: [],
    coverage: [],
    indexDrift: [],
  };

  const manifest = readManifest(outDir);
  if (!manifest) {
    result.missing = true;
    return result;
  }

  // Current code files on disk (same persisted directory/submodule choices
  // `init` used, including the `--only-dir` whitelist from the fingerprint),
  // so this freshness check never disagrees with buildContext about what
  // "current" means.
  const current = new Map<string, string>(); // rel → hash
  // `listContextFiles` applies the same fingerprint fallback for `--only-dir`
  // and `--ignore-file` as the build, so a no-flag check diffs the same set.
  for (const file of listContextFiles(root, outDir, exts)) {
    try {
      const source = readSourceFile(file);
      if (source === null) continue; // unsupported encoding (e.g. UTF-16BE) → treat as removed below
      current.set(relPosix(root, file), contentHash(source));
    } catch {
      // Unreadable now → treat as removed below (it won't be in `current`).
    }
  }

  // Compare the manifest's recorded files against what's on disk.
  const recorded = new Set<string>();
  for (const ref of manifest.files) {
    recorded.add(ref.path);
    const now = current.get(ref.path);
    if (now === undefined) {
      result.removed.push(ref.path);
    } else if (now !== ref.hash) {
      result.contentDrift.push({ path: ref.path, from: short(ref.hash), to: short(now) });
    }
  }
  for (const path of current.keys()) {
    if (!recorded.has(path)) result.coverage.push(path);
  }

  // Node frontmatter must agree with the manifest roster (catches hand edits).
  const manifestNodes = new Map(manifest.nodes.map((n) => [n.slug, n]));
  const onDisk = readNodes(outDir);
  const seen = new Set<string>();
  for (const node of onDisk) {
    seen.add(node.slug);
    const m = manifestNodes.get(node.slug);
    if (!m) {
      result.indexDrift.push(`${node.slug}: node file not in manifest`);
    } else if (m.sourcesDigest !== node.sourcesDigest) {
      result.indexDrift.push(`${node.slug}: frontmatter digest ≠ manifest`);
    }
  }
  for (const slug of manifestNodes.keys()) {
    if (!seen.has(slug)) result.indexDrift.push(`${slug}: in manifest but node file missing`);
  }

  result.ok =
    result.contentDrift.length === 0 &&
    result.removed.length === 0 &&
    result.coverage.length === 0 &&
    result.indexDrift.length === 0;
  return result;
}

/** A cheap, query-time staleness signal (unlike {@link checkContext}, which
 * re-hashes every file for CI). */
export interface FreshnessResult {
  /** Recorded source files that are no longer on disk. */
  missing: number;
  /** Total source files the manifest recorded. */
  total: number;
}

/**
 * How many recorded source files have vanished from disk — an existence-only
 * check (stat, never a read or a hash), safe to call on a hot path like session
 * start. This catches the common "index built on a different tree" case: a
 * branch switch, a `git checkout` to an older commit, an unpulled move — states
 * where graft would otherwise confidently point at files that aren't there and
 * send the agent chasing them. Returns null when there's no graph at all.
 */
export function indexFreshness(dir: string, opts: CheckOptions = {}): FreshnessResult | null {
  const root = resolve(dir);
  const outDir = contextDirFor(root, opts.contextDir);
  const manifest = readManifest(outDir);
  if (!manifest) return null;
  let missing = 0;
  for (const ref of manifest.files) {
    if (!existsSync(resolve(root, ref.path))) missing++;
  }
  return { missing, total: manifest.files.length };
}

/** One-line staleness banner for orientation/query output, or null when the
 * index is fresh (or absent). Terse on purpose — it rides atop the orientation
 * the agent reads first, so it must earn its tokens. */
export function staleBanner(f: FreshnessResult | null): string | null {
  if (!f || f.missing === 0) return null;
  return (
    `⚠ graft's index may be ahead of your working tree: ${f.missing} of ${f.total} indexed ` +
    `files are not on disk (branch switch or uncommitted move?). If graft names a path that ` +
    `isn't there, don't chase it — \`graft grep\` the symbol to find where it lives now; run \`graft build\` to refresh.`
  );
}

/** Render a check result as a human-readable report. */
export function formatCheckReport(r: CheckResult): string {
  if (r.missing) {
    return "graft check: NO GRAPH\n\nNo graft/manifest.json found. Run `graft build --deep` first.";
  }
  if (r.ok) return "graft check: OK — the graph is in sync with the code.";

  const lines: string[] = ["graft check: STALE", ""];
  if (r.contentDrift.length) {
    lines.push(`changed (${r.contentDrift.length}):`);
    for (const c of r.contentDrift) lines.push(`  ~ ${c.path}  (${c.from} → ${c.to})`);
  }
  if (r.removed.length) {
    lines.push(`removed (${r.removed.length}):`);
    for (const p of r.removed) lines.push(`  - ${p}`);
  }
  if (r.coverage.length) {
    lines.push(`not in graph (${r.coverage.length}):`);
    for (const p of r.coverage) lines.push(`  + ${p}`);
  }
  if (r.indexDrift.length) {
    lines.push(`index mismatch (${r.indexDrift.length}):`);
    for (const s of r.indexDrift) lines.push(`  ! ${s}`);
  }
  lines.push("", "Run `graft build --deep` to regenerate, then commit graft/.");
  return lines.join("\n");
}

function short(hash: string): string {
  return hash.slice(0, 8);
}
