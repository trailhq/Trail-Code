/**
 * `ensureFreshGraph` — the pre-query gate that keeps retrieval honest.
 *
 * Freshness used to be someone else's job: the Claude Code `Stop` hook spawned a
 * background `graft build` *after* the turn ended, so every query an agent made
 * between its first edit and the end of the turn answered from a graph that no
 * longer matched the file it had just changed. Worse, an edit made outside the
 * agent (your editor, a branch switch, a stash) set no `dirty` flag at all, so
 * nothing ever triggered a resync.
 *
 * So freshness moves into the query path: every retrieval call probes the working
 * tree (`fingerprint.ts`, ~3ms) and, when something moved, rebuilds the structural
 * graph before answering. Properties worth keeping:
 *
 * - **$0 and offline.** Tier-1 only — never a summarizer, never `--deep`. Same
 *   money guard `claude/sync-run.ts` carries: auto-anything must not spend money.
 * - **Never fatal.** A failed refresh degrades to answering from the graph on
 *   disk. A query that works today must not start failing because a rebuild did.
 * - **Never a stampede.** It takes the same `graft/.cache/.sync.lock` the
 *   background sync uses, so concurrent MCP calls and the Stop hook can't pile up
 *   rebuilds on top of each other.
 * - **Writes only what a query reads** (`graphOnly`): the graph, the `ask` sidecar,
 *   the freshness record. Not the markdown cards, not `INDEX.md`, not `.gitignore`.
 *   Those belong to an explicit `graft build` — which the `Stop` hook already runs
 *   at the end of a turn — so retrieval stays cheap and a read stays a read. It
 *   also leaves `stats.json` alone, so that same `Stop` hook still sees `dirty` and
 *   still rebuilds the passive surface.
 *
 * One case is not drift but absence: inside a git worktree there is no graph at all,
 * because `graft/` is gitignored and so was never checked out. The gate covers that
 * too — it copies the parent checkout's graph in (`./seed.ts`) and then treats the
 * difference between the two checkouts as ordinary drift, which is exactly what it is.
 *
 * The other absence is a repo on trail that this machine never built: trail was
 * installed without `trail init` here, or the clone is new. Its learnings arrive,
 * its queries find no code, and the agent goes back to grep for the rest of the
 * session. So the first query there starts a full build in the background and
 * waits a while for it (`buildMissingMap`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contextDirFor } from "../context/node-file.js";
import { isTrailMapDir } from "../context/map-dir.js";
import { homeFolderRefusal } from "../init-guard.js";
import { acquireLockIn, lockHeldIn, releaseLockIn } from "../util/state.js";
import { CACHE_DIR } from "../context/node-file.js";
import { buildGraph } from "./build.js";
import { driftCount, isClean, probeDrift, readFingerprint, type Drift } from "./fingerprint.js";
import { invalidateGraphCaches } from "./load.js";
import type { RefreshRunArgs } from "./refresh-run.js";
import { seedGraph, type SeedResult } from "./seed.js";
import { wiringPath } from "./write.js";
import { cmd, tag } from "../brand.js";

/** How long to wait for another process's in-flight rebuild before giving up and
 * answering from the current graph. Long enough to ride out a small repo's build,
 * short enough that a tool call never feels hung. */
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 50;

/** How long a query waits for a repo's first build before answering without code.
 * A big repo (8k files) builds in about 75s, and the agent's shell gives a command
 * two minutes; a reply with code in it on the first try is worth the wait, once. */
const FIRST_BUILD_WAIT_MS = 90_000;
const FIRST_BUILD_POLL_MS = 250;
/** The first build's own time limit, well past the end-of-turn rebuild's two minutes. */
const FIRST_BUILD_TIMEOUT_MS = 10 * 60_000;

export interface RefreshResult {
  /** True when the graph on disk was rebuilt by this call. */
  refreshed: boolean;
  /** What the probe found, when it ran and found something. */
  drift?: Drift;
  /** One-line explanation for the agent/user, when there's something worth saying. */
  note?: string;
}

export interface RefreshOptions {
  contextDir?: string;
  /** Skip everything (the `--no-refresh` flag). */
  disabled?: boolean;
  /** How long to wait for a first build of a repo on trail; 0 starts it and answers
   * at once. Default `GRAFT_FIRST_BUILD_WAIT_MS`, else FIRST_BUILD_WAIT_MS. */
  firstBuildWaitMs?: number;
}

const CLEAN: RefreshResult = { refreshed: false };

/** Env kill switch, for CI or anyone who wants queries to never write. */
function envDisabled(): boolean {
  const v = process.env.GRAFT_NO_REFRESH;
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The wait for a first build: the option, else `GRAFT_FIRST_BUILD_WAIT_MS` (the hooks
 * set 0, since their own budget is seconds), else the default. */
function firstBuildWait(opts: RefreshOptions): number {
  if (opts.firstBuildWaitMs !== undefined) return opts.firstBuildWaitMs;
  const v = process.env.GRAFT_FIRST_BUILD_WAIT_MS;
  const ms = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(ms) && ms >= 0 ? ms : FIRST_BUILD_WAIT_MS;
}

/**
 * Start a full `build` of `dir` in a detached child that outlives this query. The
 * caller holds the lock; the child (`claude/sync-run.ts`) releases it when the
 * build ends, however it ends. Plain `build`: structural, $0, offline.
 */
function startFirstBuild(dir: string): boolean {
  const run = process.env.GRAFT_TEST_SYNC_RUN ?? fileURLToPath(new URL("../claude/sync-run.js", import.meta.url));
  if (!existsSync(run)) return false;
  const child = spawn(process.execPath, [run, dir, String(FIRST_BUILD_TIMEOUT_MS)], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => { /* the lock ages out, and the next query starts it again */ });
  child.unref();
  return true;
}

/**
 * No graph here and none to copy in. A repo on trail gets one built: its team
 * committed `.trail/` and this person installed trail, so a build is what they
 * asked for, and answering "no matching nodes" sends the agent back to grep for
 * good. Anywhere else (a graft repo, a `--dir` map, the home folder) nothing is
 * built behind the user's back, as before.
 *
 * The first query to get here starts the build and waits up to `firstBuildWait`;
 * queries arriving meanwhile wait on the same lock. Returns a note when the map
 * is now there and the query should go on, or what to answer with when it isn't.
 */
async function buildMissingMap(dir: string, outDir: string, opts: RefreshOptions, busy?: boolean): Promise<string | RefreshResult> {
  const own = !opts.contextDir && !process.env.GRAFT_DIR && isTrailMapDir(dir, outDir) && homeFolderRefusal(dir) === null;
  if (!own) {
    return busy
      ? { refreshed: false, note: "another process is still copying the graph into this worktree — retry the query in a moment" }
      : CLEAN;
  }
  const lockCache = join(outDir, CACHE_DIR);
  const started = Date.now();
  // The lock free and still no map: nobody is building it, so this query starts it.
  // Taken here, released by the child.
  if (!lockHeldIn(lockCache) && acquireLockIn(lockCache) && !startFirstBuild(dir)) releaseLockIn(lockCache);
  const deadline = started + firstBuildWait(opts);
  while (lockHeldIn(lockCache) && Date.now() < deadline) await sleep(FIRST_BUILD_POLL_MS);
  if (existsSync(wiringPath(outDir))) {
    invalidateGraphCaches(outDir);
    return `built this repo's code map for the first time (${Math.round((Date.now() - started) / 1000)}s)`;
  }
  if (lockHeldIn(lockCache)) {
    return {
      refreshed: false,
      note: "no code map here yet: building one in the background (about a minute on a big repo). Until it's done, answers carry learnings but no code — run the same command again in a minute instead of rewording it",
    };
  }
  return { refreshed: false, note: `couldn't build this repo's code map — run \`${cmd("graft build")}\` to see why` };
}

/**
 * Release the lock if this process is asked to die while holding it. Returns the
 * un-hook.
 *
 * Not hypothetical: the Claude Code prompt hook runs `graft ask` with a timeout, and
 * `execFileSync` enforces it with SIGTERM. Node's default disposition for SIGTERM is
 * to exit without unwinding, so the `finally` below never runs and the lock outlives
 * the process — after which the background sync is blocked and every query waits and
 * then answers stale until the lock ages out. Ctrl-C on a CLI query is the same story
 * with SIGINT.
 *
 * Adding a listener replaces that default disposition, so re-raise it explicitly
 * afterwards: remove ourselves, then `process.kill(process.pid, sig)`, so the exit
 * status still says "terminated by signal" for whoever is waiting on us.
 */
export function releaseOnSignal(cache: string): () => void {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  const onSignal = (sig: NodeJS.Signals) => {
    // A rebuild child would otherwise go on writing without the lock.
    rebuilding?.kill(sig);
    releaseLockIn(cache);
    for (const s of signals) process.removeListener(s, onSignal);
    process.kill(process.pid, sig);
  };
  for (const s of signals) process.once(s, onSignal);
  return () => {
    for (const s of signals) process.removeListener(s, onSignal);
  };
}

/** The rebuild child in flight, for the signal handler above to end with us. */
let rebuilding: ChildProcess | null = null;

/**
 * The query-time rebuild, in a short-lived child (`./refresh-run.ts`) when its
 * compiled script ships next to this module, so the memory a big repo's rebuild
 * takes goes back to the OS when it ends instead of staying with a long-lived MCP
 * server. Run from source (the tests), there's no compiled script: it builds in
 * process, as before. `GRAFT_TEST_REFRESH_RUN` points the child at a stub.
 */
async function rebuild(args: RefreshRunArgs): Promise<void> {
  const run = process.env.GRAFT_TEST_REFRESH_RUN ?? fileURLToPath(new URL("./refresh-run.js", import.meta.url));
  if (!existsSync(run)) {
    await buildGraph(args.dir, { contextDir: args.contextDir, graphOnly: true, onlyDirs: args.onlyDirs });
    return;
  }
  await new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, [run, JSON.stringify(args)], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    rebuilding = child;
    let err = "";
    child.stderr?.setEncoding("utf8").on("data", (c: string) => { err += c; });
    child.on("error", (e) => { rebuilding = null; fail(e); });
    child.on("close", (code, signal) => {
      rebuilding = null;
      if (code === 0) done();
      else fail(new Error(err.trim().split("\n").pop() || `rebuild ended with ${signal ?? `exit ${code}`}`));
    });
  });
}

/** Wait out someone else's rebuild, then take the lock. False when we couldn't. */
async function waitForLock(cache: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (acquireLockIn(cache)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(LOCK_POLL_MS);
  }
}

/**
 * Copy a parent checkout's graph in, holding the same lock a rebuild would.
 *
 * Two MCP tool calls in a fresh worktree arrive here at the same moment, and an 8 MB
 * copy is long enough for both to start one. The loser waits, then finds the graph
 * already there and reports nothing — which is why the caller re-checks the file
 * rather than trusting this return value.
 */
async function seedUnderLock(
  dir: string,
  outDir: string,
  contextDir?: string,
): Promise<SeedResult & { busy?: boolean }> {
  const lockCache = join(outDir, CACHE_DIR);
  // `busy` matters: with no graph on disk there is nothing to fall back to, so a
  // caller that stayed silent here would emit the bare "no matching nodes" this whole
  // mechanism exists to remove. Say what happened instead.
  if (!(await waitForLock(lockCache))) return { seeded: false, busy: true };
  const unhook = releaseOnSignal(lockCache);
  try {
    return seedGraph(dir, { contextDir });
  } finally {
    unhook();
    releaseLockIn(lockCache);
  }
}

/**
 * Rebuild `root`'s structural graph if the working tree has moved since the last
 * build. Cheap and side-effect-free when nothing changed, which is the usual case.
 *
 * `root` is the repository root (the same value the query itself is given), not
 * the context dir.
 */
export async function ensureFreshGraph(root: string, opts: RefreshOptions = {}): Promise<RefreshResult> {
  if (opts.disabled || envDisabled()) return CLEAN;
  try {
    const dir = resolve(root);
    const outDir = contextDirFor(dir, opts.contextDir);
    let seededFrom: string | undefined;
    let builtNote: string | undefined;
    if (!existsSync(wiringPath(outDir))) {
      // One case has a graph to work with even though this checkout has none: a git
      // worktree, whose parent checkout's `graft/` git could not check out. Copy it
      // in and carry on — the drift below is then exactly the diff between the two
      // checkouts, and repairing it is what makes the copied graph honest here.
      const seed = await seedUnderLock(dir, outDir, opts.contextDir);
      seededFrom = seed.from;
      // Still nothing (not a worktree, parent never built, or a concurrent seed or
      // first build we lost the race for): a repo on trail gets its map built; any
      // other repo gets the caller's own "no graph — run graft build" message.
      if (!existsSync(wiringPath(outDir))) {
        const built = await buildMissingMap(dir, outDir, opts, seed.busy);
        if (typeof built !== "string") return built;
        builtNote = built;
      }
    }
    const seedNote = seededFrom ? `copied the graph from the main checkout (${seededFrom})` : builtNote;

    // null = no fingerprint at all: a graph built before this mechanism existed,
    // or by a different extractor build. Rebuild once — that lays the fingerprint
    // down, so it costs exactly one build, not one per query.
    const drift = probeDrift(dir, outDir);
    if (drift && isClean(drift)) return seedNote ? { refreshed: false, note: seedNote } : CLEAN;

    // On the default layout this is `<root>/graft/.cache/.sync.lock`, the very file
    // the Claude Code hooks lock — so this refresh and the background sync can
    // never rebuild at the same time.
    const lockCache = join(outDir, CACHE_DIR);
    if (!(await waitForLock(lockCache))) {
      const busy = "a graph rebuild is already in flight — answering from the current graph";
      return {
        refreshed: false,
        drift: drift ?? undefined,
        note: seedNote ? `${seedNote}; ${busy}` : busy,
      };
    }
    const unhook = releaseOnSignal(lockCache);
    try {
      // We may have queued behind another process's rebuild for up to LOCK_WAIT_MS,
      // and that rebuild very likely fixed the same drift we saw. Re-probe rather
      // than rebuild on the strength of a stale observation: without this, four
      // parallel MCP tool calls on one edited file produce four full rebuilds, three
      // of them pure waste, and the last tool call pays for all of it. A null drift
      // means "no fingerprint" and still has to build.
      const now = drift ? probeDrift(dir, outDir) : null;
      if (now && isClean(now)) {
        invalidateGraphCaches(outDir);
        return seedNote ? { refreshed: false, note: seedNote } : CLEAN;
      }
      // Tier-1 only: no summarizer, so no LLM call and no network, ever. And
      // `graphOnly`: write the graph, the ask sidecar and the fingerprint, nothing
      // else. The markdown projections under `graft/` stay the `Stop` hook's job —
      // a query has no business rewriting the repo's `.gitignore` or churning every
      // card's mtime, and skipping them is most of what keeps this cheap.
      // A `--only-dir` build recorded its whitelist in the fingerprint; re-apply it
      // here so an auto-rebuild keeps the same limited file set instead of silently
      // widening to the whole tree.
      const onlyDirs = readFingerprint(outDir)?.onlyDirs;
      await rebuild({ dir, contextDir: opts.contextDir, onlyDirs });
      invalidateGraphCaches(outDir);
      return { refreshed: true, drift: drift ?? undefined, note: seedNote };
    } finally {
      unhook();
      releaseLockIn(lockCache);
    }
  } catch (err) {
    // Answering from a slightly stale graph beats failing the query.
    return { refreshed: false, note: `graph refresh skipped: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Workspace variant: refresh each child repo's own graph (a workspace parent holds
 * an index, never nodes). Children are independent, but they're refreshed in
 * sequence — a fan-out of concurrent tree-sitter builds would spike CPU on the
 * very path that's supposed to feel free.
 */
export async function ensureFreshChildren(
  root: string,
  children: string[],
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  if (opts.disabled || envDisabled()) return CLEAN;
  const refreshedIn: string[] = [];
  let files = 0;
  for (const child of children) {
    // Deliberately NOT `opts`: `contextDirFor` returns an override verbatim and
    // ignores the root it's handed, so forwarding the parent's `--dir` would point
    // every child at the *parent's* context dir — which holds a workspace index and
    // no wiring.json, so every child would silently be skipped. (And if it did hold
    // one, each child would build into that single shared dir in turn, the last
    // clobbering the rest.) A child's graph always lives in its own `<child>/graft`,
    // which is exactly how `loadWorkspaceGraphs` reads them back.
    const r = await ensureFreshGraph(resolve(root, child), { disabled: opts.disabled });
    if (!r.refreshed) continue;
    refreshedIn.push(child);
    files += r.drift ? driftCount(r.drift) : 0;
  }
  if (!refreshedIn.length) return CLEAN;
  return {
    refreshed: true,
    note: `refreshed ${refreshedIn.join(", ")} (${files || "?"} file${files === 1 ? "" : "s"} changed) before answering`,
  };
}

/** The one-line note a CLI/MCP surface prints when a refresh actually happened.
 * Null when there's nothing to say (the overwhelmingly common case). */
export function refreshNote(r: RefreshResult): string | null {
  if (!r.refreshed) return r.note ? `${tag()} ${r.note}` : null;
  const n = r.drift ? driftCount(r.drift) : 0;
  const built = `refreshed the graph (${n || "?"} file${n === 1 ? "" : "s"} changed) before answering`;
  // Both facts, when a worktree was seeded *and* the copy needed repairing: the
  // count is the interesting half (it's the branch diff), the provenance explains
  // where a graph came from in a directory the user knows they never built.
  return r.note ? `${tag()} ${built} — ${r.note}` : `${tag()} ${built}`;
}
