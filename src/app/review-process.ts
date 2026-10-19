/**
 * Running a review somewhere it cannot stop the App answering.
 *
 * A review is synchronous from end to end, and not in one place we could fix: the
 * pull request is fetched with `spawnSync` (`./checkout.ts`), the whole repository
 * is parsed in one `files.forEach` loop of native tree-sitter calls
 * (`graph/build.ts`), the graph is written with a blocking `JSON.stringify`, and
 * the viewer page is exported synchronously too. In-process that holds the event
 * loop for the entire review.
 *
 * That is not a theory. On the deployed App, probing `GET /p/<id>` from outside
 * every ten seconds while one review ran: three consecutive timeouts (no response
 * at all, not even with `--max-time 45`), then 404 in 0.9s the moment the queue
 * emptied. Meanwhile the box's load average was 0.96 on eight vCPUs — one thread
 * pegged, seven cores idle — and the App's own logs put a single review at 92s to
 * 274s ("3 changed → 0 affected in 180134ms"). So a *single* in-flight review took
 * the whole HTTP surface down for minutes: the container's 5s `HEALTHCHECK` failed,
 * Docker marked the container unhealthy, and pages the App had already produced
 * were unreachable. On a busy repository that is most of the working day.
 *
 * Neither bounding the queue nor lowering `GRAFT_CONCURRENCY` touches this —
 * concurrency was already 2 and one job is enough. Cooperative yielding inside the
 * parse loop does not either: a `git fetch` of a large repository is one
 * uninterruptible `spawnSync` that can legitimately take a minute, and it is not
 * even using a core while it blocks. The work has to leave the process.
 *
 * A child process rather than a `worker_threads` worker, deliberately:
 *
 *  - **The native grammars keep loading the way they already do.** `graph/native.ts`
 *    requires up to nine tree-sitter addons and constructs a `Parser` the first time
 *    a build needs them, and `graph/generic.ts` loads more through `createRequire`.
 *    In a worker all of that is re-instantiated per thread, which puts the
 *    N-API-in-worker behaviour of nine third-party native modules between the App
 *    and every review. A fork runs
 *    byte-identical code to what production runs today.
 *  - **A review can be killed.** A wedged parse or a 10-minute clone is a process
 *    to SIGKILL, not a thread with no safe way to stop it.
 *  - **A crash stops being an outage.** An OOM kill or a grammar segfault on a
 *    stranger's source now costs one review and is reported as a failure, instead
 *    of taking the HTTP server with it. This process clones code written by
 *    people who opened a pull request; that isolation is worth having on its own.
 *  - **The heap goes away.** A repository's graph is freed by the child exiting
 *    rather than left for the server process to fragment around.
 *
 * The parent keeps exactly the two things a review cannot mint for itself, and
 * hands each across the IPC channel rather than argv or the environment (`ps` and
 * `/proc/<pid>/environ` are readable; an installation token belongs in neither):
 * the token, so the App's private key never crosses the boundary, and page
 * publishing, because the store and the secret it signs URLs with live with the
 * server.
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jobKey, type ReviewJob } from "./events.js";
import type { reviewPullRequest, ReviewDeps, ReviewResult } from "./review.js";

/**
 * How long one review may take before the process running it is killed.
 *
 * Generously above the worst honest review observed in production (274s) and above
 * what `checkout.ts`'s own 120s-per-git-call budget can add up to, because the cost
 * of being wrong here is a review that never happens. It is a ceiling on a *lost*
 * queue slot, not on responsiveness — the server no longer cares how long a review
 * runs, only that the slot comes back.
 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Parent → child, once, immediately after the fork. */
export interface StartMessage {
  t: "start";
  job: ReviewJob;
  /** Minted by the parent; the child never sees the App's private key. */
  token: string;
  api?: string;
}

/** Parent → child: the URL a `publish` request ended up at, or null. */
export interface PublishedMessage {
  t: "published";
  seq: number;
  url: string | null;
}

export type ToChild = StartMessage | PublishedMessage;

/** Child → parent: a line for the App's log, so a review is still traceable. */
export interface LogMessage {
  t: "log";
  msg: string;
}

/** Child → parent: store this page and tell me its URL. */
export interface PublishMessage {
  t: "publish";
  seq: number;
  html: string;
}

export interface DoneMessage {
  t: "done";
  result: ReviewResult;
}

export interface FailedMessage {
  t: "failed";
  message: string;
}

export type FromChild = LogMessage | PublishMessage | DoneMessage | FailedMessage;

export interface ChildReviewerOptions {
  /** The module the child runs. Only tests pass this. */
  entry?: string;
  timeoutMs?: number;
}

/**
 * The module a review runs in.
 *
 * `dist/app/review-worker.js` in an installed or containerised App. Run from a
 * checkout there is no `dist`, so fall back to the TypeScript source next door:
 * `fork` inherits `process.execArgv`, so a parent started through tsx hands the
 * child the same loader and a `.ts` entry runs. Resolved once, at import.
 *
 * Exported so a test can assert the path a deployed App will fork actually exists —
 * getting this wrong is the one failure here that no unit test of the protocol
 * would catch and every review would hit.
 */
export function reviewWorkerEntry(): string {
  const js = fileURLToPath(new URL("./review-worker.js", import.meta.url));
  if (existsSync(js)) return js;
  const ts = js.replace(/\.js$/, ".ts");
  return existsSync(ts) ? ts : js;
}

/**
 * Live review processes.
 *
 * `main.ts` force-exits 25 seconds after SIGTERM if a review has not finished
 * draining. That used to kill the review along with the process; now the review is
 * a separate process that would outlive us, still holding a clone made with an
 * installation token. So the last thing this process does is take them with it.
 *
 * A container stop is unaffected either way: Docker signals PID 1, not the process
 * group, so a review keeps going through the grace period and the drain in `main.ts`
 * means what it says. Ctrl-C in a terminal signals the whole group, so the children
 * die with the default disposition and their reviews are reported as killed — which
 * is what an interrupted review was before this too.
 */
const live = new Set<ChildProcess>();
let hooked = false;

function track(child: ChildProcess): void {
  live.add(child);
  if (hooked) return;
  hooked = true;
  process.on("exit", () => {
    for (const c of live) c.kill("SIGKILL");
  });
}

/** A dead channel is not worth an exception: the exit handler already covers it. */
function post(child: ChildProcess, msg: ToChild): void {
  if (!child.connected) return;
  try {
    child.send(msg);
  } catch {
    /* channel closed under us — `exit` will settle the review */
  }
}

/**
 * A reviewer with `reviewPullRequest`'s signature that runs it in a child process.
 *
 * Same shape on purpose: `server.ts` swaps one for the other in a single line, and
 * every existing test that injects its own reviewer through `AppSeams.review` keeps
 * running in-process, which is what a test wants.
 */
export function childReviewer(opts: ChildReviewerOptions = {}): typeof reviewPullRequest {
  const entry = opts.entry ?? reviewWorkerEntry();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (job, deps) => runInChild(job, deps, entry, timeoutMs);
}

async function runInChild(
  job: ReviewJob,
  deps: ReviewDeps,
  entry: string,
  timeoutMs: number,
): Promise<ReviewResult> {
  const log = deps.log ?? ((): void => {});
  // Minted here rather than in the child: this is a network round trip, never a
  // blocking one, and the cache that owns installation tokens — including the
  // forget-a-rejected-token behaviour — belongs to the one process that sees every
  // delivery.
  const token = await deps.token(job.installationId);

  // The job key as argv makes `ps` in a container say which pull request each
  // review is; the token stays out of it.
  const child = fork(entry, [jobKey(job)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  track(child);

  try {
    return await new Promise<ReviewResult>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => reject(new Error(`review exceeded ${timeoutMs}ms and was killed`)));
      }, timeoutMs);
      timer.unref();

      child.on("message", (raw) => {
        const msg = raw as FromChild;
        if (msg.t === "log") {
          log(msg.msg);
          return;
        }
        if (msg.t === "publish") {
          // Publishing happens here because the store and its signing secret do.
          // A page that cannot be stored costs the link, never the review — the
          // same contract `review.ts` already has with a null `publish`.
          const stored = deps.publish ? deps.publish(job, msg.html) : Promise.resolve(null);
          void stored
            .catch(() => null)
            .then((url) => post(child, { t: "published", seq: msg.seq, url }));
          return;
        }
        if (msg.t === "done") {
          settle(() => resolve(msg.result));
          return;
        }
        settle(() => reject(new Error(msg.message)));
      });

      child.on("error", (err) => settle(() => reject(err)));

      // The case that used to be an App-wide outage: a child that dies without
      // reporting. An OOM kill, a segfault in a grammar on hostile source. Now it
      // is one failed review, named, with the signal that did it.
      child.on("exit", (code, signal) =>
        settle(() =>
          reject(
            new Error(
              `review process exited ${signal ? `on ${signal}` : `with code ${code}`} before reporting a result`,
            ),
          ),
        ),
      );

      post(child, { t: "start", job, token, api: deps.api });
    });
  } finally {
    live.delete(child);
    // Whatever happened — done, failed, timed out, or a delivery superseded by the
    // queue — nothing forked here is allowed to outlive the review. `review.ts`
    // deletes the checkout before it reports, so this leaves nothing behind.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

/** The App's default reviewer. */
export const reviewInChildProcess = childReviewer();
