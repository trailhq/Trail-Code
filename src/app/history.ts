/**
 * Reading a repository's history into a rule-bearing digest.
 *
 * What a code graph cannot tell you is why the code is the way it is. That
 * lives in two places: commit messages, and the discussion under pull requests.
 * This module reads both, plus the symbol ids from the graph so a rule mined
 * out of them can be anchored to the code it governs.
 *
 * It deliberately sends NO source code onward. The digest is messages, titles,
 * comments, symbol ids and hashes — nothing a reader could reconstruct a private
 * codebase from.
 */
import { spawnSync } from "node:child_process";
import type { GraphV1 } from "../graph/types.js";
import { ghHeaders, type Fetch } from "./identity.js";
import type { HistorySource } from "./sources.js";

/** One commit's rule-bearing content. */
export interface HistoryCommit {
  sha: string;
  subject: string;
  body: string;
  files: string[];
}

/** One pull request's discussion. */
export interface HistoryThread {
  number: number;
  title: string;
  body: string;
  mergeSha: string;
  comments: Array<{ body: string; path?: string }>;
}

/** One symbol, as the brain needs it to anchor a rule. */
export interface HistorySymbol {
  id: string;
  path: string;
  name: string;
  kind: string;
  signature: string;
  fingerprint: string;
}

/** The whole payload posted to the brain. */
export interface RepoDigest {
  provider: "github";
  owner: string;
  name: string;
  head_sha: string;
  default_branch: string;
  is_private: boolean;
  commits: Array<{ sha: string; subject: string; body: string; files: string[]; symbols: string[] }>;
  threads: Array<{
    number: number;
    title: string;
    body: string;
    merge_sha: string;
    comments: Array<{ body: string; path?: string }>;
  }>;
  symbols: HistorySymbol[];
  /** Everything in the repo that is already a rule, or nearly one: instruction
   * files, decision records, config, ownership, reverts, test names. One array
   * rather than a field per kind, so adding a source is adding an entry. */
  sources: HistorySource[];
  auto_approve: boolean;
  /** The agents `graft init` wired this repo for (claude, cursor, agents, …).
   * Trail shows only the context files those agents read. Absent or empty
   * means "not known", and Trail then shows every kind. */
  agents?: string[];
}

/** Field separators inside one `git log` record. Chosen for being bytes no
 * commit message contains, the same trick blast/owners.ts uses. */
const REC = "\x01";
const FIELD = "\x02";

/** Most commits read out of one repository. Above the brain's own per-ingest
 * cap, so the trim happens here where the ordering is known. */
const MAX_COMMITS = 1_000;

/** Run git in `root`, or null when git fails. */
function git(root: string, args: string[]): string | null {
  const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
  return res.stdout;
}

/**
 * Commit subjects, bodies and touched files, oldest first.
 *
 * `--no-merges`: a merge commit's message is "Merge pull request #N from …",
 * which establishes nothing — the decision is in the commits it brings in, and
 * in the thread. `--reverse` so a later reversal reads as a reversal downstream;
 * the extraction prompt relies on that ordering.
 */
export function readCommits(root: string, max = MAX_COMMITS): HistoryCommit[] {
  const fmt = `${REC}%H${FIELD}%s${FIELD}%b${FIELD}`;
  const out = git(root, [
    "log",
    "--no-merges",
    "--reverse",
    `-n`,
    String(max),
    `--format=${fmt}`,
    "--name-only",
  ]);
  if (!out) return [];

  const commits: HistoryCommit[] = [];
  for (const record of out.split(REC)) {
    if (!record.trim()) continue;
    const [sha = "", subject = "", body = "", rest = ""] = record.split(FIELD);
    const files = rest
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    // A commit with no subject is a broken record, not a commit worth mining.
    if (!sha.trim() || !subject.trim()) continue;
    commits.push({ sha: sha.trim(), subject: subject.trim(), body: body.trim(), files });
  }
  return commits;
}

/** How many pull requests to read, and how many comment pages per thread. */
const MAX_THREADS = 200;
const MAX_COMMENT_PAGES = 3;
/** How many threads' comments are fetched at once. Two requests per pull
 * request, so this is the real cost of a repository read. A pool of 24 (so at
 * most 48 requests in flight) stays well under GitHub's secondary limit on
 * concurrent requests, and a slow thread no longer holds up the seven that
 * happened to share its batch. */
export const THREAD_FETCH_CONCURRENCY = 24;

/**
 * What one push has already asked GitHub, shared between its reads.
 *
 * The early upload reads the newest pull requests and the full read reads them
 * again as part of the 200. Promises rather than results, so a full read that
 * starts while the early one is still in flight waits on the same request
 * instead of sending a second — and threads with no discussion are remembered
 * too, which a map of finished threads could not say.
 */
export interface ThreadReadCache {
  /** Pages of the closed-pull-request list, by page number. */
  pages: Map<number, Promise<PullListItem[] | null>>;
  /** One pull request's discussion, by number; null when it had none. */
  threads: Map<number, Promise<HistoryThread | null>>;
}

export function newThreadReadCache(): ThreadReadCache {
  return { pages: new Map(), threads: new Map() };
}

/** Run `fn` over `items` with at most `limit` in flight, results in input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

export interface PullListItem {
  number?: number;
  title?: string;
  body?: string | null;
  merge_commit_sha?: string | null;
}

interface CommentItem {
  body?: string | null;
  path?: string | null;
  user?: { type?: string } | null;
}

/**
 * Closed pull requests and their discussion, most-discussed first.
 *
 * Closed only: an open PR's discussion has not concluded, so mining a rule out
 * of it would record a proposal as a decision.
 *
 * Comment counts have to be discovered by fetching, not by reading the list.
 * GitHub's `GET /pulls` list response carries NO `comments` or
 * `review_comments` field — those exist only on the single-PR GET — so an
 * earlier version that pre-filtered on them read `undefined` for every pull
 * request, scored them all zero and skipped the lot. The failure was silent and
 * total: every repository came back with no discussion at all. So the comments
 * are fetched for the most recently updated closed pull requests, and the
 * ranking happens afterwards, on counts that are real.
 *
 * Bot comments are dropped. A CI bot posting a coverage table is the single
 * largest source of text in a busy repo's threads and it establishes nothing.
 */
export async function readThreads(
  owner: string,
  repo: string,
  token: string,
  fetchImpl: Fetch,
  api = "https://api.github.com",
  max = MAX_THREADS,
  // Threads already read (the early upload's newest ones), reused rather than
  // fetched a second time.
  known: ReadonlyMap<number, HistoryThread> = new Map(),
  // Everything this push has already asked GitHub, in flight or finished. See
  // ThreadReadCache; a fresh one when the caller has nothing to share.
  cache: ThreadReadCache = newThreadReadCache(),
): Promise<HistoryThread[]> {
  const headers = ghHeaders(token);

  const readPage = (page: number): Promise<PullListItem[] | null> => {
    const cached = cache.pages.get(page);
    if (cached) return cached;
    const pending = (async () => {
      const res = await fetchImpl(
        `${api}/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
        { headers },
      );
      if (!res.ok) return null;
      const batch = JSON.parse(await res.text()) as PullListItem[];
      return Array.isArray(batch) ? batch : null;
    })();
    // A failed page is forgotten, so the next read asks again rather than
    // inheriting one blip for the rest of the push.
    pending.catch(() => cache.pages.delete(page));
    cache.pages.set(page, pending);
    return pending;
  };

  const pulls: PullListItem[] = [];
  // 100 per page, up to the cap. Sorted by GitHub as most-recently-updated,
  // which is the right window: rules decided two years ago that still hold get
  // restated in newer threads, and ones that do not are usually superseded.
  for (let page = 1; pulls.length < max && page <= Math.ceil(max / 100); page++) {
    const batch = await readPage(page);
    if (!batch || batch.length === 0) break;
    pulls.push(...batch);
  }

  // Deduplicated: a pull request updated between two page reads moves up the
  // list and would otherwise be read, and sent, twice.
  const seenNumbers = new Set<number>();
  const candidates = pulls
    .filter((p): p is PullListItem & { number: number } => typeof p.number === "number")
    .filter((p) => !seenNumbers.has(p.number) && (seenNumbers.add(p.number), true))
    .slice(0, max);

  const readThread = (p: PullListItem & { number: number }): Promise<HistoryThread | null> => {
    const seen = known.get(p.number);
    if (seen) return Promise.resolve(seen);
    const cached = cache.threads.get(p.number);
    if (cached) return cached;
    const pending = (async () => {
      const [issueComments, reviewComments] = await Promise.all([
        readComments(`${api}/repos/${owner}/${repo}/issues/${p.number}/comments`, headers, fetchImpl),
        readComments(`${api}/repos/${owner}/${repo}/pulls/${p.number}/comments`, headers, fetchImpl),
      ]);
      const comments = [...issueComments, ...reviewComments];
      if (comments.length === 0) return null;
      return {
        number: p.number,
        title: (p.title ?? "").trim(),
        body: (p.body ?? "").trim(),
        mergeSha: (p.merge_commit_sha ?? "").trim(),
        comments,
      } satisfies HistoryThread;
    })();
    pending.catch(() => cache.threads.delete(p.number));
    cache.threads.set(p.number, pending);
    return pending;
  };

  // A pool rather than one at a time: two requests per pull request over 200
  // of them is 400 sequential round trips, which is minutes of a person
  // waiting on a progress screen.
  const fetched = await mapPool(candidates, THREAD_FETCH_CONCURRENCY, readThread);
  const threads: HistoryThread[] = fetched.filter((t): t is HistoryThread => t !== null);

  // Most-discussed first, because the digest renderer spends its budget in this
  // order and a twenty-comment thread contains an argument while a one-comment
  // thread contains a rubber stamp.
  threads.sort((a, b) => b.comments.length - a.comments.length);
  return threads;
}

/** One comment endpoint, paginated, bots removed. */
async function readComments(
  url: string,
  headers: Record<string, string>,
  fetchImpl: Fetch,
): Promise<Array<{ body: string; path?: string }>> {
  const out: Array<{ body: string; path?: string }> = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const res = await fetchImpl(`${url}?per_page=100&page=${page}`, { headers });
    if (!res.ok) break;
    let batch: CommentItem[];
    try {
      batch = JSON.parse(await res.text()) as CommentItem[];
    } catch {
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const c of batch) {
      const body = (c.body ?? "").trim();
      if (!body) continue;
      if (c.user?.type === "Bot") continue;
      out.push(c.path ? { body, path: c.path } : { body });
    }
    if (batch.length < 100) break;
  }
  return out;
}

/** Most symbols to send. The brain only needs enough to anchor rules against. */
const MAX_SYMBOLS = 4_000;

/**
 * Exported symbols from the graph, with the body hash that makes an anchored
 * rule self-invalidating.
 *
 * Exported only, and biggest first: an internal helper is not what a team's
 * rules are about, and the budget is better spent on the surface a rule is
 * likely to govern.
 */
export function readSymbols(graph: GraphV1 | null, max = MAX_SYMBOLS): HistorySymbol[] {
  if (!graph) return [];
  return graph.nodes
    .filter((n) => n.exported && n.kind !== "file")
    .sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0))
    .slice(0, max)
    .map((n) => ({
      id: n.id,
      path: n.path,
      name: n.name,
      kind: n.kind,
      signature: n.signature ?? "",
      fingerprint: n.body_hash,
    }));
}

/**
 * Assemble the digest.
 *
 * Each commit carries the symbol ids its files touched, so a rule mined from a
 * commit message can be anchored even when the message names no symbol — which
 * is most of the time.
 */
export function buildDigest(input: {
  owner: string;
  name: string;
  headSha: string;
  defaultBranch: string;
  isPrivate: boolean;
  commits: HistoryCommit[];
  threads: HistoryThread[];
  symbols: HistorySymbol[];
  sources: HistorySource[];
  autoApprove: boolean;
  agents?: string[];
}): RepoDigest {
  const byPath = new Map<string, string[]>();
  for (const s of input.symbols) {
    const bucket = byPath.get(s.path);
    if (bucket) bucket.push(s.id);
    else byPath.set(s.path, [s.id]);
  }

  return {
    provider: "github",
    owner: input.owner,
    name: input.name,
    head_sha: input.headSha,
    default_branch: input.defaultBranch,
    is_private: input.isPrivate,
    commits: input.commits.map((c) => ({
      sha: c.sha,
      subject: c.subject,
      body: c.body,
      files: c.files,
      // Capped per commit: a sweeping refactor touches hundreds of files, and
      // listing every symbol in all of them would drown the message it belongs to.
      symbols: c.files.flatMap((f) => byPath.get(f) ?? []).slice(0, 20),
    })),
    threads: input.threads.map((t) => ({
      number: t.number,
      title: t.title,
      body: t.body,
      merge_sha: t.mergeSha,
      comments: t.comments,
    })),
    symbols: input.symbols,
    sources: input.sources,
    auto_approve: input.autoApprove,
    ...(input.agents?.length ? { agents: input.agents } : {}),
  };
}

/**
 * Post the digest to a brain.
 *
 * Returns the job id so the caller can hand it back to whoever asked for the
 * build, which is what the onboarding screen polls.
 */
export async function postDigest(
  baseUrl: string,
  brainId: string,
  brainToken: string,
  digest: RepoDigest,
  fetchImpl: Fetch,
): Promise<{ jobId: string }> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/brains/${encodeURIComponent(brainId)}/repo`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${brainToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(digest),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`brain ingest failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text) as { job_id?: string };
  return { jobId: String(parsed.job_id ?? "") };
}
