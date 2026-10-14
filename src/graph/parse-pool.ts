/**
 * A pool of forked parser children for large cold builds. Opt-in only:
 * `buildGraph` never forks unless the `graft build` command asked for it
 * (`--workers`, or `GRAFT_PARSE_WORKERS`), so the pre-query refresh, the MCP
 * server and the App's review worker parse in-thread whatever the edit size.
 *
 * Failure modes degrade, never hang and never reject: a dead child's job is
 * retried once, then parked. A parked job's fate is decided only once the pool
 * settles, by whether the pool ever completed a job in a child at all:
 *   - if some job succeeded, a file that killed two children is a poisoned file,
 *     and its parked job becomes an `error` result — never retried in the parent,
 *     where the same crash would take down the whole build;
 *   - if no job ever succeeded, the crashes are environmental (fork, loader,
 *     permissions), so the parked jobs are parsed in-thread with the rest.
 * A pool that cannot keep children alive hands the remaining queue back to the
 * parent, which has warmed grammars; a queued job that already killed a child
 * follows the parked jobs' rule. A child that dies before it ever signals
 * `ready` is a warm-up failure, not a parse failure — in a broken environment
 * (fork, loader, permissions) each such wave costs a full warm-up timeout with
 * nothing to show — so it is charged two respawn credits instead of one, and the
 * pool falls back to in-thread after half as many warm-up waves. A child whose
 * WASM runtime was poisoned marks its result `retire`; the pool stops it and
 * replaces it free of charge for the first `workers * 4` retirements, then for
 * one respawn credit each. A child that exits because the pool told it to stop
 * costs nothing.
 */
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import { fileURLToPath } from "node:url";
import { extractOne, type ExtractOneResult } from "./extract-one.js";
import { contentHash } from "../util/id.js";
import { readSourceFile } from "../util/source.js";
import type { SourceStat } from "./source-files.js";
import type { FromChild, ToChild } from "./parse-worker.js";

/** Under this many files, forking, warming grammars (~300 ms per child) and IPC
 * cost more than they save. */
export const PARSE_POOL_MIN_FILES = 200;
const FILES_PER_CHILD = 200;
/** Working set of one child with nine native grammars, WASM and a parse in flight. */
const BYTES_PER_CHILD = 300 * 1024 * 1024;
const MAX_ATTEMPTS = 2;

export interface PoolOptions {
  workers: number;
  entry?: string;
  onResult?: (index: number, file: string) => void;
  /** Called once if the parent ends up parsing files itself (the pool could not
   * keep children alive, or every crash looked environmental). */
  onFallback?: () => void;
  jobTimeoutMs?: number;
  warmTimeoutMs?: number;
}

/** `dist/graph/parse-worker.js`, or the `.ts` next to it when run from a checkout
 * under tsx (fork inherits `--import tsx` through execArgv). */
export function parseWorkerEntry(): string {
  const js = fileURLToPath(new URL("./parse-worker.js", import.meta.url));
  if (existsSync(js)) return js;
  const ts = js.replace(/\.js$/, ".ts");
  return existsSync(ts) ? ts : js;
}

/** Children to fork for `files` files. 0 means in-thread, and 0 is the answer
 * unless `GRAFT_PARSE_WORKERS` says otherwise: `N` forces N, `auto` picks
 * `min(cores - 1, freemem / 300 MB, files / 200)`, anything else is in-thread. */
export function poolSize(
  files: number,
  env: NodeJS.ProcessEnv = process.env,
  cores = availableParallelism(),
  freeBytes = freemem(),
): number {
  const v = (env.GRAFT_PARSE_WORKERS ?? "").trim();
  if (v === "") return 0;
  if (v !== "auto") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 && String(n) === v ? n : 0;
  }
  if (files < PARSE_POOL_MIN_FILES) return 0;
  const byCores = cores - 1;
  const byMemory = Math.floor(freeBytes / BYTES_PER_CHILD);
  const byWork = Math.ceil(files / FILES_PER_CHILD);
  const n = Math.min(byCores, byMemory, byWork);
  return n >= 2 ? n : 0;
}

/** `exit` is how the job's last child died, in words ("exited (code 9)",
 * "timed out after 120 s"); set on every death. */
interface Job { index: number; attempts: number; exit?: string }

export function runParsePool(
  files: SourceStat[],
  cachedHashOf: (rel: string) => string | null,
  langs: { generic: Iterable<string>; container: Iterable<string> },
  opts: PoolOptions,
): Promise<ExtractOneResult[]> {
  const entry = opts.entry ?? parseWorkerEntry();
  const jobTimeoutMs = opts.jobTimeoutMs ?? 120_000;
  const warmTimeoutMs = opts.warmTimeoutMs ?? 60_000;
  const results: ExtractOneResult[] = new Array(files.length);
  const queue: Job[] = files.map((_, index) => ({ index, attempts: 0 }));
  const init: ToChild = { type: "init", generic: [...langs.generic], container: [...langs.container] };
  let outstanding = files.length;
  let succeeded = 0;
  let inFlight = 0;
  let respawns = 0;
  const maxRespawns = opts.workers * 2;
  // Retirements (a poisoned WASM runtime) are replaced free up to this many; past
  // it each costs a respawn credit, so a grammar that aborts on a common construct
  // ends in the in-thread fallback instead of a fork per file.
  const freeRetirements = Math.max(1, opts.workers) * 4;
  let retirements = 0;
  const children = new Set<ChildProcess>();
  // Jobs that killed MAX_ATTEMPTS children: held here until the pool settles, when
  // `succeeded` decides error (poisoned file) vs in-thread parse (environmental).
  const parked: Job[] = [];
  let settled = false;
  let fellBack = false;

  return new Promise<ExtractOneResult[]>((resolvePool) => {
    const killAll = (): void => {
      for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
      children.clear();
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      killAll();
      resolvePool(results);
    };
    /** The parent parses a file itself; the caller hears about it once. */
    const parseHere = (job: Job): void => {
      if (!fellBack) { fellBack = true; opts.onFallback?.(); }
      const f = files[job.index];
      results[job.index] = extractOne(f, cachedHashOf(f.rel));
    };
    /** The `error` result for a job that killed a child and is not parsed here.
     * Its entry keeps the file's real hash (read the way `extractOne` reads it;
     * "" if unreadable), so the fingerprint keeps it on the stat fast path and the
     * pre-query refresh does not re-parse it in-process. */
    const crashed = (job: Job, why: string): ExtractOneResult => {
      const f = files[job.index];
      let hash = "";
      try {
        const source = readSourceFile(f.abs);
        if (source !== null) hash = contentHash(source);
      } catch { /* unreadable: "" */ }
      const message = `${f.rel}: parse failed — parser process ${job.exit ?? "exited (unknown)"} ${why}`;
      return { kind: "error", message, entry: { size: f.size, mtimeMs: f.mtimeMs, hash, nodes: [], rawEdges: [], error: message } };
    };
    /** Drain the parked jobs. `inThread` (i.e. `succeeded === 0`) means the crashes
     * were environmental, so parse them like the rest of the queue; otherwise they
     * are the brief's twice-crashed `error` result. */
    const settleParked = (inThread: boolean): void => {
      if (settled) return;
      for (const job of parked.splice(0)) {
        if (inThread) parseHere(job);
        else results[job.index] = crashed(job, "on this file twice");
        opts.onResult?.(job.index, files[job.index].rel);
        outstanding--;
      }
      if (outstanding === 0) finish();
    };
    /** The pool cannot keep children alive: parse what is left here, in order,
     * then settle the parked jobs. A queued job that already killed a child is
     * held to the parked jobs' rule: once any job has completed in a child the
     * crash is the file's, and parsing it here could take down the build. */
    const fallbackInThread = (): void => {
      if (settled) return;
      killAll();
      for (const job of queue.splice(0)) {
        if (job.exit !== undefined && succeeded > 0) {
          results[job.index] = crashed(job, "on this file; not retried in-process after the pool gave up, where the same crash would end the build");
        } else {
          parseHere(job);
        }
        opts.onResult?.(job.index, files[job.index].rel);
        outstanding--;
      }
      settleParked(succeeded === 0);
      if (outstanding === 0) finish();
    };
    /** No queued work and no child holds a job: the pool has drained. Settle any
     * parked jobs (poisoned files if the pool ever worked, environmental if not),
     * or finish if there is nothing left. */
    const drainIfIdle = (): void => {
      if (queue.length !== 0 || inFlight !== 0) return;
      if (parked.length > 0) settleParked(succeeded === 0);
      else if (outstanding === 0) finish();
    };
    /** A child is gone and work remains: replace it within reason, charging
     * `credits` against the budget. Past that the pool is not working on this
     * machine, and once no child is left the parent finishes the job itself. */
    const replace = (credits: number): void => {
      respawns += credits;
      if (respawns <= maxRespawns) spawn();
      else if (children.size === 0) fallbackInThread();
    };
    const post = (child: ChildProcess, msg: ToChild): boolean => {
      if (!child.connected) return false;
      try { child.send(msg); return true; } catch { return false; }
    };

    const spawn = (): void => {
      if (settled) return;
      // `windowsHide` is a real, effective fork option (forwarded to spawn) but
      // @types/node 26 lists it on CommonOptions, which ForkOptions does not
      // extend — hence the intersection rather than dropping the flag or `any`.
      const forkOpts: ForkOptions & { windowsHide?: boolean } = {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "advanced",
        windowsHide: true,
      };
      let child: ChildProcess;
      try {
        child = fork(entry, [], forkOpts);
      } catch {
        // fork() can throw synchronously (an invalid path, some spawn errnos):
        // a child that died before `ready`, holding no job.
        if (queue.length === 0) drainIfIdle();
        else replace(2);
        return;
      }
      children.add(child);
      let current: Job | null = null;
      let ready = false;
      // `onGone` is wired to both `exit` and `error` and is also called directly
      // when the initial `post(init)` fails; the second firing for the same child
      // must be a no-op, or a slot would be freed twice.
      let gone = false;
      // An exit the pool asked for: after `stop` with nothing left to give it, or
      // after a `retire` (its WASM runtime is poisoned). It held no job and is not
      // a failure.
      let stopping = false;
      let retiring = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | null = setTimeout(() => child.kill(), warmTimeoutMs);
      timer.unref();
      const clearTimer = (): void => { if (timer) { clearTimeout(timer); timer = null; } };

      const next = (): void => {
        const job = queue.shift();
        if (!job) {
          current = null;
          stopping = true;
          post(child, { type: "stop" });
          drainIfIdle();
          return;
        }
        job.attempts++;
        current = job;
        inFlight++;
        timer = setTimeout(() => { timedOut = true; child.kill(); }, jobTimeoutMs);
        timer.unref();
        if (!post(child, { type: "job", seq: job.index, f: files[job.index], cachedHash: cachedHashOf(files[job.index].rel) })) {
          // Dead channel: the exit handler re-queues `current` and decrements inFlight.
          clearTimer();
        }
      };

      child.on("message", (m: FromChild) => {
        // A message read after this child's exit or error must not hand a dead
        // child a job; a repeated `ready` must not hand a busy one a second.
        if (settled || gone) return;
        if (m.type === "ready") {
          if (ready) return;
          ready = true;
          clearTimer();
          next();
          return;
        }
        if (m.type !== "done" || current === null || m.seq !== current.index) return;
        clearTimer();
        succeeded++;
        results[m.seq] = m.result;
        opts.onResult?.(m.seq, files[m.seq].rel);
        current = null;
        inFlight--;
        if (m.retire) {
          // Its WASM runtime is poisoned: stop it (it waits for this rather than
          // exiting by itself, so its `exit` can never overtake this `done`), and
          // replace it in onGone.
          retiring = true;
          post(child, { type: "stop" });
        }
        if (--outstanding === 0) finish();
        else if (!retiring) next();
      });

      const onGone = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (gone) return;
        gone = true;
        clearTimer();
        children.delete(child);
        // After an `error` the process may still be running; it no longer counts.
        try { child.kill(); } catch { /* already gone */ }
        if (settled) return;
        if (current !== null) {
          const job = current;
          current = null;
          inFlight--;
          job.exit = timedOut ? `timed out after ${jobTimeoutMs / 1000} s` : `exited (${signal ?? `code ${code}`})`;
          if (job.attempts < MAX_ATTEMPTS) {
            queue.unshift(job);
          } else {
            // Twice-crashed: park it. Whether it is an error or parsed in-thread is
            // decided at settle time by `succeeded`, not here.
            parked.push(job);
          }
        } else if (retiring || stopping) {
          if (retiring) retirements++;
          if (queue.length === 0) drainIfIdle();
          // A retired child did its job: replace it outright, up to `freeRetirements`.
          else if (retiring) {
            if (retirements > freeRetirements) replace(1);
            else spawn();
          }
          // Another child's crash re-queued work after this one was told to stop:
          // that crash already paid for a replacement, so step in, free of charge,
          // only if no child is left to take the work.
          else if (children.size === 0) replace(0);
          return;
        }
        if (queue.length === 0) { drainIfIdle(); return; }
        // Work remains. A death before this child ever signalled `ready` is a
        // warm-up failure, so it costs a second respawn credit: a pathological
        // environment burns its budget in half as many warm-up waves before
        // falling back to in-thread.
        replace(ready ? 1 : 2);
      };
      child.once("exit", onGone);
      // `on`, not `once`: a second `error` (a failed kill or send) must still find
      // a listener, or it is thrown in the parent.
      child.on("error", () => onGone(null, null));
      if (!post(child, init)) onGone(null, null);
    };

    for (let i = 0; i < Math.max(1, opts.workers) && !settled; i++) spawn();
  });
}
