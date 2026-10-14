/**
 * `seedGraph` — give a linked git worktree the graph its parent checkout already has.
 *
 * `graft/` is a local cache, so it is gitignored, so `git worktree add` never checks
 * it out: a worktree starts with `src/` and `.claude/` and no graph at all. Every
 * MCP tool then answers "no graph found — run graft build first" for the whole
 * session, and the passive surface (`INDEX.md`, the cards) is missing too. The agent
 * that was supposed to be cheapest in a fresh worktree is instead blind in one.
 *
 * What travels is the graph and the sidecars a query reads — never the markdown; see
 * `seedable` for why the cards are the parent's branch and not this one's.
 *
 * The parent checkout has not gone anywhere, though — a worktree's `.git` is a *file*
 * naming it, and the harness that creates these worktrees already reaches back the
 * same way (Claude Code symlinks `node_modules` to the parent's). So: copy the
 * parent's `graft/` in, then let the ordinary refresh gate repair the difference.
 *
 * Copy, not symlink. `node_modules` is the same for every branch; a graph is a set of
 * `file:line` spans for one specific tree, so a shared one would have the worktree
 * rewriting the parent's graph with its own branch's line numbers. What makes the
 * copy worth doing rather than just rebuilding cold:
 *
 * - **The Tier-2 meaning layer survives.** Summaries and cruxes cost real money;
 *   `buildGraph` folds a prior `wiring.json` in by `body_hash`, so an unchanged
 *   function keeps the summary someone already paid for. A cold build throws them all
 *   away and the worktree silently drops to structural-only answers.
 * - **The repair is small.** `probeDrift` confirms a suspect file by content hash, so
 *   a fresh checkout's brand-new mtimes cost one hashing pass and nothing more; the
 *   drift that survives is exactly the diff between the two checkouts' commits.
 * - **$0 and offline**, like everything else on the query path.
 *
 * Never writes to the parent, never throws, and no-ops unless there is genuinely a
 * built parent checkout on disk — so a fresh clone, CI, or a cloud session whose repo
 * was *cloned* rather than worktree'd behaves exactly as it did before: "run graft
 * build first".
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ASK_INDEX_FILE } from "../ask/index-file.js";
import { CACHE_DIR, contextDirFor } from "../context/node-file.js";
import { EXTRACT_CACHE_PREFIX } from "./extract-cache.js";
import { FINGERPRINT_PREFIX } from "./fingerprint.js";
import { GRAPH_DIR } from "../context/location.js";
import { wiringPath } from "./write.js";

/** The one line a linked worktree's `.git` file carries. */
const GITDIR_KEY = "gitdir:";

/** Env kill switch, mirroring `GRAFT_NO_REFRESH` in ./refresh.ts. */
export function seedDisabled(): boolean {
  const v = process.env.GRAFT_NO_SEED;
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/**
 * The main checkout of the repo `root` is a linked worktree of, or null when `root`
 * isn't one (which is the common case, and not an error).
 *
 * Filesystem-only on purpose: no `git` subprocess on a path that runs before every
 * query. The shapes it has to tell apart:
 *
 * - `<root>/.git` is a **directory** → this *is* the main checkout. Nothing to seed.
 * - `gitdir: <main>/.git/worktrees/<name>` → a linked worktree. `commondir` inside
 *   that dir points back at the shared `.git` (`../..`), whose parent is the main
 *   checkout.
 * - `gitdir: <super>/.git/modules/<name>` → a **submodule**. Identical file shape,
 *   completely different thing: a submodule is its own repo and its parent's `graft/`
 *   describes different code entirely. The `worktrees` path segment is what rejects it.
 * - A bare repo or `--separate-git-dir` layout, where the resolved common dir isn't
 *   named `.git` and there may be no working tree at all → null.
 */
export function mainWorktreeRoot(root: string): string | null {
  try {
    const dot = join(root, ".git");
    if (statSync(dot).isDirectory()) return null;
    // Read the pointer without a regex. `/^gitdir:[ \t]*(.+?)[ \t]*$/m` is the
    // polynomial-ReDoS shape CodeQL flagged on `ensureSearchable` (`js/polynomial-redos`,
    // fixed in 44a191e): `.` also matches space and tab, so the lazy group and the
    // trailing `[ \t]*` overlap and a line of blanks costs O(n²). Same conclusion as
    // that fix — the ambiguity buys nothing, and split/startsWith/trim is linear and
    // plainer. `trim` also absorbs the `\r` of a CRLF checkout.
    const line = readFileSync(dot, "utf8").split("\n").find((l) => l.startsWith(GITDIR_KEY));
    if (line === undefined) return null;
    const target = line.slice(GITDIR_KEY.length).trim();
    if (!target) return null;
    const gitdir = isAbsolute(target) ? target : resolve(root, target);
    if (basename(dirname(gitdir)) !== "worktrees") return null;
    const rel = readFileSync(join(gitdir, "commondir"), "utf8").trim();
    if (!rel) return null;
    const common = isAbsolute(rel) ? rel : resolve(gitdir, rel);
    if (basename(common) !== ".git" || !statSync(common).isDirectory()) return null;
    const main = dirname(common);
    if (resolve(main) === resolve(root)) return null;
    return main;
  } catch {
    // No `.git` at all, an unreadable one, a `commondir` that doesn't exist: all of
    // them mean "can't seed from here", which is the same answer as "not a worktree".
    return null;
  }
}

export interface SeedResult {
  seeded: boolean;
  /** The main checkout the graph came from, when one was used. */
  from?: string;
}

const NOT_SEEDED: SeedResult = { seeded: false };

/**
 * An allowlist, not a skip list: is this repo-relative path (posix) one of the few
 * files a seed may bring across?
 *
 * The gate that calls this promises "writes only what a query reads — the graph, the
 * `ask` sidecar, the freshness record" (see the header of ./refresh.ts). A copy that
 * wrote anything else would turn a read into a write of the repo, so the copy honours
 * the same list. The extraction memo is on it because the refresh immediately after
 * rewrites that file anyway, and replaying it is what keeps the repair cheap.
 *
 * **Deliberately absent: the cards and `INDEX.md`.** They would land as this
 * checkout's documentation while describing the *parent's* branch, and nothing on the
 * query path rewrites them (`writeCards`/`writeIndex` sit behind `!graphOnly`), so they
 * would stay wrong indefinitely. An explicit `graft build` regenerates them from this
 * checkout's own graph — and prunes the ones that no longer apply — which is both
 * correct and nearly free once the graph is here.
 *
 * Also absent, because it belongs to the checkout that produced it: `.cache/session/`
 * (another session's transcripts), `.sync.lock` (another process's lock), and
 * `stats.json` (this checkout earns its own savings and dirty flag).
 */
function seedable(rel: string): boolean {
  // The dirs themselves, or cpSync would never look inside them.
  if (rel === "" || rel === GRAPH_DIR || rel === CACHE_DIR) return true;
  if (!rel.startsWith(`${CACHE_DIR}/`)) return false; // incl. the graph: `installGraph` places it
  const name = rel.slice(CACHE_DIR.length + 1);
  return (
    name === ASK_INDEX_FILE ||
    name.startsWith(`${EXTRACT_CACHE_PREFIX}.`) ||
    name.startsWith(`${FINGERPRINT_PREFIX}.`)
  );
}

/**
 * Copy `srcDir` into `outDir`, keeping only what {@link seedable} allows.
 *
 * Walked by hand rather than through `cpSync`'s `filter`, which did not hold on
 * Windows: the graph arrived — it is placed directly, by {@link installGraph} — while
 * every allowlisted sidecar next to it was dropped. A seeded worktree therefore had no
 * fingerprint, `probeDrift` read that as "never built", and the query right behind the
 * seed rebuilt the whole repo instead of the diff against the parent: precisely the
 * cost seeding exists to avoid, and silent, because a full rebuild still answers
 * correctly. It only surfaced as a `(? files changed)` note on the CI leg.
 *
 * Composing `rel` from the segments this walk joined itself is what fixes it — the
 * allowlist no longer depends on the form `cpSync` chooses to hand its callback, and
 * `rel` is posix by construction rather than by conversion. Also narrower than the old
 * copy in one way worth keeping: only real files and directories travel, never a
 * symlink, and nothing in the allowlist is one.
 */
function copyTree(srcDir: string, outDir: string): void {
  const walk = (rel: string): void => {
    const from = rel ? join(srcDir, rel) : srcDir;
    mkdirSync(rel ? join(outDir, rel) : outDir, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (!seedable(childRel)) continue;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) copyFileSync(join(from, entry.name), join(outDir, childRel));
    }
  };
  walk("");
}

/**
 * Put `wiring.json` in place last, via a temp file and a rename.
 *
 * Its presence is the flag every caller reads to mean "this repo has a graph"
 * (`refresh.ts`, `workspace.ts`, every MCP tool). So it must appear only once the
 * rest of the copy has landed and must never appear half-written: a seed killed
 * midway then leaves no graph, and the next call simply seeds again.
 */
function installGraph(srcGraph: string, destGraph: string): void {
  mkdirSync(dirname(destGraph), { recursive: true });
  const tmp = `${destGraph}.seed.${process.pid}`;
  try {
    copyFileSync(srcGraph, tmp);
    renameSync(tmp, destGraph);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
    throw err;
  }
}

/**
 * Copy the parent checkout's graph into `root`'s own `graft/`, if all of this holds:
 * `root` is a linked worktree, it has no graph yet, the parent has one, and no `--dir`
 * override is in play (a custom output dir can't be mapped to a sibling checkout —
 * the same conservatism `ensureGitignored` applies).
 *
 * Best-effort by contract: the caller's fallback is the behaviour that existed before
 * this function did, so every failure returns `{ seeded: false }` rather than raising.
 */
export function seedGraph(root: string, opts: { contextDir?: string } = {}): SeedResult {
  if (opts.contextDir || seedDisabled()) return NOT_SEEDED;
  try {
    const dir = resolve(root);
    const outDir = contextDirFor(dir);
    if (existsSync(wiringPath(outDir))) return NOT_SEEDED; // already has its own
    const main = mainWorktreeRoot(dir);
    if (!main) return NOT_SEEDED;
    const srcDir = contextDirFor(main);
    const srcGraph = wiringPath(srcDir);
    if (!existsSync(srcGraph)) return NOT_SEEDED; // parent never built either
    copyTree(srcDir, outDir);
    installGraph(srcGraph, wiringPath(outDir));
    return { seeded: true, from: main };
  } catch {
    return NOT_SEEDED;
  }
}
