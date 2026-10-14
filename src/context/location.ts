/**
 * Where a project's context dir lives, and how to tell a context dir from a
 * directory that merely shares its name.
 *
 * A leaf on purpose: `context/node-file.ts` (the CLI side), `util/state.ts`
 * (the hooks/sync side) and `graph/*` (the graph side) all have to agree on the
 * answer, so it cannot live in any one of them — a rule that lived in the
 * module one of them imported would make the others depend on that layer, and
 * the first place that wanted it would be the place that guessed.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The default context dir name. Visible (not dot-prefixed) on purpose: default
 * ripgrep skips hidden dirs, so the agent's grep/ls/find reflex must be able to
 * land on the graph.
 */
export const DEFAULT_CONTEXT_DIR = "graft";

/**
 * Where the graph goes when {@link DEFAULT_CONTEXT_DIR} is already taken by
 * something that is not a context dir.
 *
 * `graft` is a project name, not a reserved word — a checkout of a tool called
 * graft sitting in someone's repo root is a real collision, and adopting it
 * means writing `.cache/stats.json` and a lock file into an unrelated tree.
 * The alternative has to stay a directory name nobody picks for their own
 * project, and it has to stay VISIBLE (see {@link DEFAULT_CONTEXT_DIR}) or the
 * cards stop being greppable, which is most of what the graph is for. So: a
 * distinct, self-describing, still-hidden-from-nothing name.
 */
export const FALLBACK_CONTEXT_DIR = "graft-context";

/** Hidden subdir under the context dir that holds machine-only graph artifacts. */
export const GRAPH_DIR = ".graph";
/** The wiring graph's filename inside {@link GRAPH_DIR}. */
export const GRAPH_FILE = "wiring.json";
/** The children index a workspace PARENT carries, directly in its context dir. */
export const WORKSPACE_FILE = "workspace.json";
/** The node-graph manifest the context (pre-wiring) format wrote. */
export const MANIFEST_FILE = "manifest.json";
/** The git-ignored per-file cache every graft write path creates inside a context dir. */
export const CACHE_DIR = ".cache";

/** Absolute path of the wiring graph for a context dir: `<dir>/.graph/wiring.json`. */
export function wiringFile(contextDir: string): string {
  return join(contextDir, GRAPH_DIR, GRAPH_FILE);
}

/** Absolute path of the workspace index for a parent root: `<dir>/workspace.json`. */
export function workspaceFile(contextDir: string): string {
  return join(contextDir, WORKSPACE_FILE);
}

/**
 * Is there a real graph index in this context dir — a wiring graph, or the
 * children index a workspace parent carries?
 *
 * Narrow on purpose, and deliberately NOT the same question as
 * {@link isGraftContextDir}: this one asks "is there something here to query",
 * which is what decides the implicit root for a bare `graft ask` and what
 * `graft init` reports as "graph ready". Widening it to "graft has written
 * here" would make a wired-but-never-built repo claim a graph it does not have.
 */
export function hasGraphIndex(contextDir: string): boolean {
  return existsSync(wiringFile(contextDir)) || existsSync(workspaceFile(contextDir));
}

/**
 * Does this directory hold something graft generated, rather than being a
 * directory that merely shares a context dir's name?
 *
 * The set is {@link hasGraphIndex} plus two more artifacts graft writes, and
 * the cache is load-bearing rather than a fudge. The cache is what graft creates
 * FIRST — before any build has run, a wired repo's context dir holds `.cache/`
 * and nothing else — so a marker that ignored it would let the answer below
 * change the moment graft itself wrote there, sending the second read of a stats
 * file to a different directory than the first write. Resolution has to be
 * monotone: once this function says a directory is ours, every later call must
 * say so too, or state written a moment ago is lost.
 *
 * A repo whose `graft/` holds only unrelated files stays foreign, and its graph
 * goes to {@link FALLBACK_CONTEXT_DIR} instead of being written into a tree
 * graft does not own.
 */
export function isGraftContextDir(contextDir: string): boolean {
  return hasGraphIndex(contextDir)
    || existsSync(join(contextDir, CACHE_DIR))
    || existsSync(join(contextDir, MANIFEST_FILE));
}

/**
 * Is this path a directory with nothing in it?
 *
 * An empty preferred directory is not a collision: there is no content to take
 * over, so it is adopted rather than sidestepped. That also keeps the answer
 * stable against a half-created context dir, which is the same class of problem
 * as the cache marker above — a caller that resolved the name, created it, and
 * resolved again must get the same name back. Anything that cannot be read as a
 * directory (a file by that name, a permission error) counts as occupied.
 */
function isEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/**
 * Absolute path of the context dir for a repo root.
 *
 * An explicit `override` is taken at face value: naming a directory is a
 * decision, and second-guessing it would make `--dir` and `GRAFT_DIR` mean
 * different things from the default.
 *
 * Without one, the preferred name is used whenever it is free, empty, or already
 * ours. When it is occupied by a foreign directory, the graph goes to
 * {@link FALLBACK_CONTEXT_DIR} instead of being written into a tree graft does
 * not own. The answer is a pure function of what is on disk, so the CLI, the
 * hooks, the statusline and the sync all land in the same place without any of
 * them having to be told.
 */
export function contextDirFor(root: string, override?: string): string {
  if (override) return override;
  const preferred = join(root, DEFAULT_CONTEXT_DIR);
  if (!existsSync(preferred) || isEmptyDir(preferred) || isGraftContextDir(preferred)) return preferred;
  return join(root, FALLBACK_CONTEXT_DIR);
}
