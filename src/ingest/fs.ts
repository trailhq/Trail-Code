/**
 * Filesystem walking used by `init`/`check` to enumerate a repo's source files.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Directories that are dependency/build output, never source. */
export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  // The underscore spelling that Sphinx, CMake, Jekyll and the OCaml tools all
  // emit. Left out, a materialized build tree lands in the graph as ordinary
  // source: one repo here indexed 4,484 files of vendored WordPress against 121
  // hand-written ones, and queries slowed enough that the prompt hook's budget
  // could no longer fit them. `--include-dir _build` remains the way back in.
  "_build",
  "out",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  "venv",
]);

/** Files above this size are generated/vendored in practice, not hand-written code. */
export const MAX_FILE_BYTES = 1_000_000;

/**
 * Directory names `--include-dir` can never un-skip. `.git` is the
 * repository's own metadata, not source — indexing it would drown the graph
 * in objects and refs. Shared with the CLI validator so a forbidden name is
 * rejected up front instead of persisting a no-op.
 */
export const NEVER_INCLUDE_DIRS = new Set([".git"]);

/**
 * Whether a directory named `name` should be skipped when walking a repo tree:
 * any dot-prefixed directory (`.git`, `.github`, `.vscode`, `.kb`, ...) or one of
 * {@link SKIP_DIRS} not named in `includes`. The single source of truth for
 * "is this dir source" — `skippedPath` and `walkFilesystem` below and the
 * git-child discovery in `graph/scopes.ts` share it, so they can never
 * independently drift on what counts as skippable.
 *
 * `includes` is the explicit, per-repo `graft build --include-dir` override
 * (persisted via `util/state.ts`'s `readIncludeDirs`, threaded in by each
 * caller) — a name in it is removed from the effective skip set for THIS
 * repo's walks, including a named hidden directory such as `.kb`. Absent/empty
 * ≡ today's default behavior (every dot-directory stays skipped). Names in
 * {@link NEVER_INCLUDE_DIRS} (at least `.git`) stay skipped even when listed.
 * It lifts only graft's own skip list: in a Git repo, Git's ignore rules stay
 * authoritative (see {@link walkDir}).
 */
export function shouldSkipDir(name: string, includes?: ReadonlySet<string>): boolean {
  if (NEVER_INCLUDE_DIRS.has(name)) return true;
  if (includes?.has(name)) return false;
  if (name.startsWith(".")) return true;
  return SKIP_DIRS.has(name);
}

/**
 * Recursively list all files under a directory. Skips dot-directories
 * (unless named in `includes`, except {@link NEVER_INCLUDE_DIRS}),
 * dependency/build directories (node_modules, dist, …) not named in
 * `includes`, and files over 1 MB.
 * In a Git worktree, tracked files plus untracked, non-ignored files come from
 * `git ls-files`; this gives indexing exactly Git's nested `.gitignore`,
 * negation, and global-exclude semantics. Non-Git directories retain the plain
 * filesystem walk. `includes` lifts only the built-in skip list — it never
 * overrides Git's ignore rules (un-ignore or `git add -f` a directory to
 * index it, the same contract as tracked-but-ignored files).
 *
 * Two INDEPENDENT opt-ins cross the repository boundary, because Git models two
 * different relationships and only one of them is a dependency the parent pins:
 *
 *   - `followSubmodules` follows a GITLINK — an index entry with mode `160000`,
 *     a commit the superproject versions.
 *   - `followNestedRepos` follows a nested clone the parent's index knows
 *     nothing about. Manifest-driven multi-repo tools (west, repo, gclient,
 *     tsrc, mr, …) all check dependencies out this way, and so does anyone who
 *     clones an upstream into the tree to patch it locally.
 *
 * Both default to false, preserving the historical superproject boundary. Each
 * child keeps its own ignore rules; uninitialized submodules and gitignored
 * nested clones remain absent either way (`--exclude-standard` never emits
 * them, so there is nothing to follow).
 */
export interface WalkOptions {
  /** Include initialized Git submodules (gitlinks) recursively. Default false. */
  followSubmodules?: boolean;
  /** Include nested Git clones the parent index does not track. Default false. */
  followNestedRepos?: boolean;
}

/**
 * Directory `walkDir` actually enumerates.
 *
 * `path.resolve` does not follow a symlink, and git discovers the repo from the
 * child cwd. Unwrap a symlink-to-directory once so the walk runs inside the
 * target. Ordinary directories stay as `resolve(dir)` — not `realpath` — so a
 * macOS `/var/folders/…` scratch path is the path the caller handed us.
 *
 * A broken symlink throws instead of the `scandir ENOENT` `readdirSync` would
 * raise after git fails. Internal symlink policy is not decided here.
 */
export function canonicalWalkRoot(dir: string): string {
  const abs = resolve(dir);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch {
    return abs;
  }
  if (!st.isSymbolicLink()) return abs;

  let real: string;
  try {
    real = realpathSync(abs);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
    if (code === "ELOOP") throw new Error(`symbolic link loop: ${abs}`);
    throw new Error(`broken symbolic link: ${abs}`);
  }
  let realSt: ReturnType<typeof statSync>;
  try {
    realSt = statSync(real);
  } catch {
    throw new Error(`broken symbolic link: ${abs}`);
  }
  if (!realSt.isDirectory()) return abs;
  return real;
}

function escapedCanonical(canonical: string, abs: string): boolean {
  const rel = relative(canonical, abs);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Keep emitted paths on the requested root so relative paths stay stable. */
function remapWalkPaths(requested: string, canonical: string, files: string[]): string[] {
  if (requested === canonical) return files;
  const out: string[] = [];
  for (const abs of files) {
    if (escapedCanonical(canonical, abs)) continue;
    const rel = relative(canonical, abs);
    if (rel === "") continue;
    out.push(join(requested, rel));
  }
  return out;
}

/**
 * Recursively list source files under `dir`. A directory symlink as the *input
 * root* is unwrapped once ({@link canonicalWalkRoot}); emitted paths are remapped
 * onto the caller-facing root so `relPosix` stays `src/foo.ts` rather than a
 * `../` escape through the physical path (macOS `/tmp` → `/private/tmp`).
 * Symlinks *inside* the tree are not followed: git still `lstat`s each listed
 * path, and the filesystem walk still requires `Dirent.isFile` / `isDirectory`.
 */
export function walkDir(
  dir: string,
  includes?: ReadonlySet<string>,
  opts: WalkOptions = {},
): string[] {
  const requested = resolve(dir);
  const root = canonicalWalkRoot(requested);
  const files = gitVisibleFiles(root, includes, opts) ?? walkFilesystem(root, includes);
  return remapWalkPaths(requested, root, files);
}

/** Git's canonical working-tree file set, relative to `dir`. Tracked files are
 * deliberately included even when a later ignore rule matches them; `.gitignore`
 * only controls untracked files in Git, and graft follows the same contract. */
function gitVisibleFiles(
  dir: string,
  includes?: ReadonlySet<string>,
  opts: WalkOptions = {},
  traversal?: { topRoot: string; activeRoots: Set<string> },
): string[] | null {
  const root = resolve(dir);
  // The recursive path costs an extra `-t --stage` classification, so take it
  // only when at least one boundary-crossing opt-in is on. With both off the
  // walk is byte-for-byte the historical one.
  if (opts.followSubmodules !== true && opts.followNestedRepos !== true) {
    return gitVisibleFilesShallow(root, includes);
  }

  const state = traversal ?? { topRoot: root, activeRoots: new Set<string>() };
  const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
  if (state.activeRoots.has(rootKey)) return [];
  state.activeRoots.add(rootKey);

  // Following uses `-t --stage` so one process can distinguish gitlinks from
  // tracked and untracked files. `-z` keeps either form safe for unusual paths.
  const result = spawnSync(
    "git",
    ["ls-files", "-t", "--stage", "--cached", "--others", "--exclude-standard", "-z", "--"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error || typeof result.stdout !== "string") {
    state.activeRoots.delete(rootKey);
    return null;
  }

  // A path can have multiple stage records during a merge. Collapse those
  // records and remember if any of them identifies the path as a gitlink or as
  // a nested-clone boundary.
  const entries = new Map<string, { gitlink: boolean; nested: boolean }>();
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    if (record.length < 2 || record[1] !== " ") continue;

    const tag = record[0];
    const body = record.slice(2);
    let rel: string;
    let gitlink = false;
    let nested = false;
    if (tag === "?") {
      rel = body;
      // Git refuses to descend into a repository it does not own, so `--others`
      // collapses a nested clone to ONE trailing-slash directory entry while
      // every other untracked directory is expanded file by file. That slash is
      // the boundary marker — free, since this is the enumeration we already ran.
      if (rel.endsWith("/")) {
        nested = true;
        rel = rel.slice(0, -1);
      }
    } else {
      const tab = body.indexOf("\t");
      if (tab === -1) continue;
      gitlink = body.startsWith("160000 ");
      rel = body.slice(tab + 1);
    }
    if (!rel) continue;
    const prior = entries.get(rel);
    entries.set(rel, {
      gitlink: gitlink || prior?.gitlink === true,
      nested: nested || prior?.nested === true,
    });
  }

  const out = new Set<string>();
  for (const [rel, entry] of entries) {
    const abs = resolve(root, rel);
    // Filter against the original superproject path. Otherwise a submodule
    // mounted at vendor/ or build/ would bypass the parent's skip policy when
    // recursion resets its relative root.
    if (skippedPath(relative(state.topRoot, abs), includes)) continue;

    const followChild =
      (entry.gitlink && opts.followSubmodules === true) ||
      (entry.nested && opts.followNestedRepos === true);
    if (followChild) {
      // A deinitialized gitlink can resolve upward to the superproject when Git
      // runs inside it, and a nested-looking directory may have no repo at all.
      // Requiring the child's own .git prevents duplicate, mis-prefixed parent
      // files and recursive loops.
      if (!existsSync(join(abs, ".git"))) continue;
      let childFiles = gitVisibleFiles(abs, includes, opts, state);
      if (childFiles === null) {
        // Do not let one broken child recreate a "healthy but incomplete"
        // graph. Match the top-level fail-soft contract locally: fall back to
        // the filesystem for this child only, preserving the parent repo's Git
        // visibility and every built-in skip/size guard. Child Git ignore rules
        // are unavailable in this exceptional path, just as they are when the
        // top-level Git command fails and walkDir uses its filesystem fallback.
        // Let an unreadable filesystem fallback surface rather than claiming a
        // healthy graph that silently omitted the child again.
        childFiles = walkFilesystem(abs, includes);
      }
      for (const file of childFiles) out.add(file);
      continue;
    }

    try {
      const stat = lstatSync(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    } catch {
      // A tracked file deleted from the working tree is still printed by
      // `--cached`; absence means it is not part of the current source set.
      continue;
    }
    out.add(abs);
  }

  state.activeRoots.delete(rootKey);
  return [...out].sort();
}

/** The historical, non-recursive Git path. Kept separate so the default does
 * exactly the same command, filtering, ordering, and duplicate handling as it
 * did before submodule support existed. */
function gitVisibleFilesShallow(root: string, includes?: ReadonlySet<string>): string[] | null {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error || typeof result.stdout !== "string") return null;

  const out: string[] = [];
  for (const rel of result.stdout.split("\0")) {
    if (!rel || skippedPath(rel, includes)) continue;
    const abs = resolve(root, rel);
    try {
      const stat = lstatSync(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    } catch {
      // A tracked file deleted from the working tree is still printed by
      // `--cached`; absence means it is not part of the current source set.
      continue;
    }
    out.push(abs);
  }
  return out;
}

/** A path (git-relative, either separator) is skipped when any of its
 * segments is a skippable directory name — the final segment doubles as the
 * dot-FILE check (`.eslintrc.js` and friends are not source either). */
function skippedPath(path: string, includes?: ReadonlySet<string>): boolean {
  return path.replace(/\\/g, "/").split("/").some((segment) => shouldSkipDir(segment, includes));
}

function walkFilesystem(dir: string, includes?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, includes)) continue;
      out.push(...walkFilesystem(full, includes));
    } else if (entry.isFile()) {
      if (entry.name.startsWith(".")) continue; // dot-files are not source either
      try {
        if (statSync(full).size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}
