/**
 * The file set a graph build parses, and its stat metadata.
 *
 * Split out of `build.ts` so the freshness probe (`fingerprint.ts`) can enumerate
 * exactly the same files without importing the builder (which would be an import
 * cycle: build → fingerprint → build). `build.ts` re-exports
 * {@link listSourceFiles} so its existing importers are unaffected.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { walkDir } from "../ingest/fs.js";
import { relPosix } from "../util/paths.js";
import { readFollowNestedRepos, readFollowSubmodules, readIncludeDirs } from "../util/state.js";
import { languageOf, depthExtensions } from "./extract.js";
import { genericLangOf, genericExtensions } from "./generic.js";
import { containerLangOf, containerExtensions } from "./container.js";
import { ansibleClaims, ansibleExtensions } from "./ansible.js";

/** Every extension graft has a parser for (depth + breadth + container + ansible), sorted
 * and de-duped — the authoritative answer to "what does `-e` actually support". */
export function supportedExtensions(): string[] {
  return [...new Set([...depthExtensions(), ...genericExtensions(), ...containerExtensions(), ...ansibleExtensions()])].sort();
}

/** Normalize a user-supplied extension: ensure a leading dot, lower-case. */
function normExt(e: string): string {
  const t = e.trim().toLowerCase();
  return t.startsWith(".") ? t : `.${t}`;
}

/**
 * The subset of user-supplied `-e` extensions that no parser claims (depth or breadth).
 * `graft build -e ".vue"` used to accept these silently and index nothing; the CLI warns
 * on whatever this returns so an unsupported extension is never a quiet no-op.
 */
export function unsupportedExtensions(exts: string[]): string[] {
  const supported = new Set(supportedExtensions());
  return exts.filter((e) => !supported.has(normExt(e)));
}

/**
 * The source files a graph build parses: supported languages, minus the
 * output dir. When no pre-enumerated `repoFiles` is passed, the walk reads
 * `root`'s persisted file-walk choices directly from state, so every caller
 * that enumerates through here (the fingerprint probe and hooks/refresh path,
 * none of which ever see a CLI flag) behaves identically to the build that
 * saved those choices.
 */
/** Keep only files whose repo-relative path is at or under one of `onlyDirs`.
 * No-op when `onlyDirs` is empty/absent. The whitelist is carried in the graph
 * itself (the fingerprint records it at build time), never in the source repo,
 * so a build and the query-path freshness probe read the identical set. */
export function filterByOnlyDirs(
  files: string[],
  root: string,
  onlyDirs?: ReadonlySet<string>,
): string[] {
  if (!onlyDirs || onlyDirs.size === 0) return files;
  return files.filter((abs) => {
    const rel = relPosix(root, abs);
    return [...onlyDirs].some((d) => rel === d || rel.startsWith(`${d}/`));
  });
}

export function listSourceFiles(
  root: string,
  outDir: string,
  repoFiles: string[] = walkDir(root, readIncludeDirs(resolve(root)), {
    followSubmodules: readFollowSubmodules(resolve(root)),
    followNestedRepos: readFollowNestedRepos(resolve(root)),
  }),
  onlyDirs?: ReadonlySet<string>,
): string[] {
  // A file is a source file if a depth-tier grammar (languageOf), a breadth-tier
  // grammar (genericLangOf), a container (containerLangOf) or the Ansible tier
  // (ansibleClaims) claims its extension. All four must agree here or `build` and
  // `check` would enumerate different sets. Ansible claims `.yml`/`.yaml` on the
  // extension alone and decides for real from the content — a non-Ansible YAML
  // file is walked, parsed, and then yields zero nodes.
  return filterByOnlyDirs(
    repoFiles.filter(
      (f) =>
        !f.startsWith(outDir) &&
        (languageOf(f) !== null || genericLangOf(f) !== null || containerLangOf(f) !== null || ansibleClaims(f)),
    ),
    root,
    onlyDirs,
  );
}

export interface SourceStat {
  /** Absolute path. */
  abs: string;
  /** Repo-relative, posix (`relPosix`) — exactly the form `buildGraph` uses for
   * node ids and `checkGraph` diffs against, so cache keys and ids can never
   * disagree. Posix on every platform: see `../util/paths.ts`. */
  rel: string;
  size: number;
  mtimeMs: number;
}

/**
 * {@link listSourceFiles} plus each file's `(size, mtimeMs)` — the currency of
 * both the freshness probe and the extraction cache. Files that vanish between
 * the walk and the stat are dropped (same fail-soft posture as `walkDir`).
 */
export function listSourceStats(
  root: string,
  outDir: string,
  repoFiles?: string[],
  onlyDirs?: ReadonlySet<string>,
): SourceStat[] {
  const out: SourceStat[] = [];
  for (const abs of listSourceFiles(root, outDir, repoFiles, onlyDirs)) {
    let s: { size: number; mtimeMs: number };
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    out.push({ abs, rel: relPosix(root, abs), size: s.size, mtimeMs: s.mtimeMs });
  }
  return out;
}
