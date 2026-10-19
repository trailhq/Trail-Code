/**
 * Getting a pull request's code onto disk without running any of it.
 *
 * On a fork PR every byte here was written by a stranger, and this service holds
 * an installation token for the base repository. So the rules are absolute:
 *
 *  - **Nothing is executed.** No `npm install`, no build, no hooks. The graph is
 *    produced by tree-sitter reading source text, which runs none of it.
 *  - **Git is told not to run things either.** A repository can carry hooks, and
 *    `core.hooksPath` is a per-repo config a clone would otherwise honour; both
 *    are disabled explicitly rather than assumed absent.
 *  - **The token never lands in the repo.** It is passed per-invocation through
 *    an http header config, not baked into a remote URL that `git remote -v`,
 *    the reflog and any submodule would carry.
 *  - **Bounded.** A hostile or merely enormous repository must not hold a worker
 *    forever: every git call has a timeout, and the fetch is shallow.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Enough history for a merge base against the pull request's base branch. */
const FETCH_DEPTH = 50;
/**
 * One extra reach back, used only on the `/head` fallback below.
 *
 * An open PR's base tip is a commit or two from the merge base, so 50 is plenty.
 * A pull request being re-reviewed weeks after it merged is the opposite case:
 * the base branch has moved on by however many commits the repo lands in that
 * time, and the commit the branch was actually merged on top of sits behind all
 * of them. Deepening once is cheaper than raising `FETCH_DEPTH` for every review.
 */
const DEEPEN_DEPTH = 500;
const GIT_TIMEOUT_MS = 120_000;

export interface CheckoutRequest {
  owner: string;
  repo: string;
  number: number;
  baseRef: string;
  token: string;
  api?: string;
  /** Where to say which of GitHub's two PR refs the review is actually using —
   * the App's own log callback, so the two cases are told apart in the container
   * logs rather than guessed at from the comment. */
  log?: (msg: string) => void;
}

export interface Checkout {
  /** Working tree at the pull request's merge commit, or at its head commit when
   * the merge ref is gone (see {@link ref}). */
  dir: string;
  /** What `blast --base` should diff against. */
  base: string;
  /** Which ref the tree came from. `merge` is the normal case; `head` means the
   * pull request is closed and GitHub has deleted its merge preview. */
  ref: "merge" | "head";
  /** Removes the tree. Always call it — the token's clone is not something to
   * leave in /tmp. */
  cleanup: () => void;
}

/** A git invocation with the dangerous parts of the environment removed. */
function git(dir: string, args: string[], token?: string): { ok: boolean; out: string; err: string } {
  const auth = token
    ? [
        "-c",
        // Basic auth with the token as the password, per GitHub's own guidance for
        // installation tokens. Passed as an argument to THIS call so it is never
        // written into .git/config.
        `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      ]
    : [];
  const res = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.version=2", ...auth, ...args],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // No credential prompts, no system config, no repo-supplied helpers.
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ASKPASS: "",
        HOME: dir,
      },
    },
  );
  return {
    ok: res.status === 0,
    out: res.stdout ?? "",
    err: `${res.stderr ?? ""}${res.error ? ` ${res.error.message}` : ""}`.trim(),
  };
}

/** First line of a git command's output, or null when it said nothing useful. */
function line(dir: string, args: string[]): string | null {
  const { ok, out } = git(dir, args);
  const first = out.split("\n")[0]?.trim() ?? "";
  return ok && first !== "" ? first : null;
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * Fetch the PR's code and its base, shallow, and land on it.
 *
 * `refs/pull/N/merge` is GitHub's own merge of the PR into its base — the same
 * thing the checks see, and the right thing to review: it is what will land, not
 * what the contributor's branch says in isolation. It is preferred whenever it
 * exists.
 *
 * But GitHub DELETES that ref the moment a pull request is closed or merged: it
 * is only a preview of a merge, and there is nothing left to preview afterwards.
 * Re-reviewing any merged PR therefore died at the fetch with `couldn't find
 * remote ref refs/pull/N/merge` — 16 in a row on one installation — which is why
 * `refs/pull/N/head` (the branch tip as the author pushed it, kept indefinitely
 * in the BASE repository, so it survives even the fork being deleted) is fetched
 * as a fallback. What changes with it is the diff basis, which
 * {@link headDiffBase} is entirely about.
 */
export function checkoutPullRequest(req: CheckoutRequest): Checkout {
  const host = (req.api ?? "https://github.com").replace(/\/$/, "");
  const dir = mkdtempSync(join(tmpdir(), `graft-app-${req.owner}-${req.repo}-`));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  const log = req.log ?? ((): void => {});
  const tag = `${req.owner}/${req.repo}#${req.number}`;
  const fail = (step: string, err: string): never => {
    cleanup();
    // A merge ref is absent while GitHub is still computing mergeability, and
    // present-but-stale right after a push — worth saying which step failed so
    // that case is distinguishable from a permissions problem.
    throw new Error(`checkout ${tag} failed at ${step}: ${redact(err, req.token)}`);
  };

  const setup: Array<[string, string[]]> = [
    ["init", ["init", "--quiet", "-b", "__graft_base"]],
    ["remote", ["remote", "add", "origin", `${host}/${req.owner}/${req.repo}.git`]],
  ];
  for (const [name, args] of setup) {
    const { ok, err } = git(dir, args);
    if (!ok) fail(name, err);
  }

  // Both refs in one fetch: the ref to review, the base to diff against.
  const merge = git(dir, fetchArgs(req, "merge"), req.token);
  const ref: Checkout["ref"] = merge.ok ? "merge" : "head";
  if (!merge.ok) {
    const head = git(dir, fetchArgs(req, "head"), req.token);
    // Neither ref: a base branch that has since been deleted, an installation
    // that lost access, a repository that is gone. Both errors go out, because a
    // bare "couldn't find refs/pull/N/merge" now means only "this PR is closed"
    // and says nothing about why the fallback did not save it either.
    if (!head.ok) {
      fail("fetch", `${merge.err} | falling back to refs/pull/${req.number}/head: ${head.err}`);
    }
  }

  const co = git(dir, ["checkout", "--quiet", "--detach", `refs/graft/${ref}`]);
  if (!co.ok) fail("checkout", co.err);

  if (ref === "merge") {
    log(`${tag}: reviewing refs/pull/${req.number}/merge against ${req.baseRef}`);
    return { dir, base: "refs/graft/base", ref, cleanup };
  }

  const against = headDiffBase(dir, req);
  if (against === null) {
    fail(
      "diff base",
      `refs/pull/${req.number}/merge is gone and refs/pull/${req.number}/head gives no diff against ` +
        `${req.baseRef}: within ${FETCH_DEPTH + DEEPEN_DEPTH} commits they share no history, or the branch ` +
        `is already in ${req.baseRef} with no merge commit to diff against (a fast-forward merge)`,
    );
  }
  // Not "the PR is closed": that is only the usual reason the merge ref is
  // missing, and stating it as fact would send an operator chasing the wrong
  // thing when the fetch failed for some other reason.
  log(`${tag}: no refs/pull/${req.number}/merge (GitHub deletes it when a pull request closes), reviewing refs/pull/${req.number}/head against ${against}`);
  return { dir, base: "refs/graft/base", ref, cleanup };
}

/** The one fetch each attempt makes: the PR ref to review plus the base branch. */
function fetchArgs(req: CheckoutRequest, pull: "merge" | "head", deepen = false): string[] {
  return [
    "fetch",
    "--quiet",
    deepen ? `--deepen=${DEEPEN_DEPTH}` : `--depth=${FETCH_DEPTH}`,
    "--no-recurse-submodules",
    "origin",
    `+refs/pull/${req.number}/${pull}:refs/graft/${pull}`,
    `+refs/heads/${req.baseRef}:refs/graft/base`,
  ];
}

/**
 * Point `refs/graft/base` at the commit the head ref should be diffed against,
 * and describe it for the log — or null when this history cannot answer.
 *
 * The two refs do NOT give the same diff, and the difference is not a detail:
 *
 *  - `/merge` is a commit whose parents are the base tip and the head, so
 *    `refs/graft/base...HEAD` resolves its merge base to the base tip and the
 *    diff is exactly the pull request.
 *  - `/head` is the author's branch tip. While the branch is *not* in the base
 *    branch's history — an open PR, a closed-unmerged one, and also a squash or
 *    rebase merge, which land new commits with new shas — the three-dot diff
 *    still resolves to the fork point and still reports exactly the author's
 *    changes (that is what three dots is for; see `rangeArgs` in blast/diff.ts).
 *  - After a MERGE COMMIT, though, the head commit is an ancestor of the base
 *    branch, so the merge base of the two IS the head commit and
 *    `refs/graft/base...HEAD` reports that nothing changed. An empty blast
 *    radius posted with total confidence is worse than the fetch error it
 *    replaced, so that case is detected and given the basis `/merge` would have
 *    had: the first parent of the merge commit that brought the branch in, which
 *    is the base branch as it stood at the merge.
 */
function headDiffBase(dir: string, req: CheckoutRequest): string | null {
  for (const deepen of [false, true]) {
    // The shallow window is measured from each tip, so a base branch that moved
    // on since the merge can leave the shared history out of it entirely: git
    // then has no merge base at all and `git diff a...b` fails outright. One
    // deepening is the difference between reviewing a months-old PR and not.
    if (deepen && !git(dir, fetchArgs(req, "head", true), req.token).ok) return null;
    const against = resolveHeadBase(dir, req);
    if (against !== null) return against;
  }
  return null;
}

function resolveHeadBase(dir: string, req: CheckoutRequest): string | null {
  const head = line(dir, ["rev-parse", "refs/graft/head"]);
  const shared = line(dir, ["merge-base", "refs/graft/base", "refs/graft/head"]);
  if (head === null || shared === null) return null;
  if (shared !== head) return `${req.baseRef} (merge base ${short(shared)})`;

  // The head commit is in the base branch: find the merge that put it there. The
  // EARLIEST merge on the ancestry path is the one — a later one is some other
  // branch's merge that happens to sit above it.
  const merge = line(dir, ["rev-list", "--reverse", "--ancestry-path", "--merges", "refs/graft/head..refs/graft/base"]);
  if (merge === null) return null;
  const parent = line(dir, ["rev-parse", `${merge}^1`]);
  if (parent === null) return null;
  // Only worth using if it is diffable: a shallow boundary can hold the merge
  // commit while leaving the fork point below it out of the repository.
  if (line(dir, ["merge-base", parent, "refs/graft/head"]) === null) return null;
  if (!git(dir, ["update-ref", "refs/graft/base", parent]).ok) return null;
  return `${req.baseRef} as it stood at the merge (${short(parent)})`;
}

/** Never let a token reach a log line, even inside git's own error text. */
export function redact(text: string, token: string): string {
  if (!token) return text;
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.split(token).join("[token]").split(encoded).join("[token]");
}
