/**
 * Learnings from a repo's pull requests, for `trail init` to offer on day one
 * beside the ones from past sessions: what the team decided, ruled out or got
 * burned by, as the PRs' own conversations show it.
 *
 * trail reads the last merged PRs and the PRs closed without merging with the
 * person's own `gh`, in one GraphQL call: each PR's description, its
 * comments, review summaries and inline review threads (marked when the
 * author acted on one). Revert commits and the repo's contributor and
 * decision docs come with them. PRs with no description and no discussion are
 * left out: they hold nothing to learn. Only when `gh` is installed and signed
 * in and the repo has a GitHub remote; otherwise it skips quietly.
 *
 * Bots and the PR author's own thread replies are dropped, and anything that
 * looks like a secret is scrubbed before it all goes to the person's own
 * Claude Code, headless, on their machine. Claude answers to the shared bar
 * (src/learn/bar.ts): plain headlines, the why, and the code underneath for
 * the agent. trail keeps a learning only when the quotes it cites really are
 * in what was sent. The learnings are about the repo, so they're the team's,
 * in `.trail/learnings/`.
 */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { countBucket, durationBucket } from "../telemetry/contract.js";
import { track } from "../telemetry/track.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { existsSync, readdirSync } from "node:fs";
import { BAR, LEARNING_SCHEMA, learningBody, verifyLearnings } from "../learn/bar.js";
import { callClaude, claudeBin, COLD_START_MODEL, norm, scrub, type ClaudeFailure, type QuoteSource } from "./cold-start.js";
import { readPlain } from "../init/plain-file.js";
import { noteAuthor } from "./git-facts.js";
import { ensureRepoHome } from "./home.js";
import { listNotes, shortDate, writeNote, type Note } from "./notes.js";
import { alreadySaid, codeAnchors, knownText } from "./team-check.js";

/** One merged or closed PR with what was said on it, oldest comment first. */
export interface ReviewedPR {
  number: number;
  title: string;
  /** ISO time it was merged, or closed without merging. */
  at: string;
  kind: "merged" | "closed";
  /** The PR's description, cleaned and scrubbed. */
  description?: string;
  /**
   * What people other than bots said: comments, review summaries, and inline
   * thread comments (each with its file, the lines it was left on, and
   * whether the author acted on it), cleaned and scrubbed.
   */
  comments: { path?: string; text: string; code?: string; actedOn?: boolean; where?: "comment" | "review" | "thread" }[];
}

export interface ReviewFinding {
  /** The plain headline. */
  title: string;
  /** Markdown under the learning's kind: the why, then `In the code:`; secrets scrubbed. */
  body: string;
  /** PRs the cited words were found on, newest first. */
  prs: number[];
  /** YYYY-MM-DD the newest of them was merged. */
  last: string;
  quotes: string[];
  /** Files the cited inline comments were on. */
  paths?: string[];
  /** The code it is about, once {@link anchoredReviews} has checked it exists. */
  touches?: string[];
}

export interface ReviewResult {
  /** Merged PRs looked at. */
  prs: number;
  /** How many of them have a reviewer's comment. */
  reviewed: number;
  /** How many of those, newest first, Claude read. */
  read: number;
  findings: ReviewFinding[];
  model: string;
  durationMs: number;
  costUsd?: number;
  /** Why nothing came back, when nothing did. `no_gh`: no `gh`, not signed in, or GitHub didn't answer. */
  reason?: "no_gh" | "no_reviews" | "no_claude" | "failed" | "none_found";
  /** Why Claude Code gave no answer, for `no_claude` and `failed`. */
  why?: ClaudeFailure;
  said?: string;
}

/** The last 50 merged PRs: enough to see a pattern, one call. */
const MERGED_PRS = 40;
const CLOSED_PRS = 25;
/** About 30k tokens: enough for 40 discussed PRs, and the cost stays low. */
const REVIEW_DIGEST_CHARS = 120_000;
const COMMENT_CHARS = 800;
const DESCRIPTION_CHARS = 1_200;
/** A description shorter than this, with nothing said on the PR, holds nothing to learn. */
const SAYS_SOMETHING = 80;
const DOC_CHARS = 6_000;
/** The code a comment was left on, at most this many lines of its diff hunk. */
const CODE_LINES = 8;
const CODE_CHARS = 500;
/** The footer a review learning is saved with (and the one before 0.24); finding it in `.trail/learnings/` means the repo's reviews were read. */
const FLAGGED = /_(?:From PRs? #\d+(?:, #\d+)*|From review on #\d+(?:, #\d+)*|Flagged in review on \d+ PRs) here/;

/* -------------------------------------------------------------------------- */
/* Reading the reviews                                                        */
/* -------------------------------------------------------------------------- */

const PR_FIELDS = `number title body mergedAt closedAt authorAssociation
        author { login __typename }
        comments(first: 30) { nodes { body authorAssociation author { login __typename } } }
        reviews(first: 20) { nodes { body authorAssociation author { login __typename } } }
        reviewThreads(first: 30) { nodes { isResolved isOutdated path comments(first: 5) { nodes { body path diffHunk authorAssociation author { login __typename } } } } }`;

/**
 * Whose words are read: the repo's owner, members and collaborators. On a
 * public repo anyone can open a PR or comment, and what's read can become a
 * learning every teammate's agent follows.
 */
const TEAM = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const onTeam = (n: { authorAssociation?: string } | null | undefined) => TEAM.has(n?.authorAssociation ?? "");

const QUERY = `query($owner: String!, $name: String!, $merged: Int!, $closed: Int!) {
  repository(owner: $owner, name: $name) {
    merged: pullRequests(states: MERGED, first: $merged, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } }
    closed: pullRequests(states: CLOSED, first: $closed, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } }
  }
}`;

/** Whether the repo has a GitHub remote and `gh` is installed and signed in. Nothing leaves the machine. */
export function ghReady(repo: string, gh = "gh"): boolean {
  const remotes = spawnSync("git", ["-C", repo, "remote", "-v"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (remotes.status !== 0 || !/github/i.test(remotes.stdout)) return false;
  // The token never reaches trail: it's printed to nowhere, and only the exit code is read.
  const auth = spawnSync(gh, ["auth", "token"], { cwd: repo, stdio: "ignore", timeout: 10_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, windowsHide: true });
  return auth.status === 0;
}

/** The repo's last merged and closed PRs with what was said on them, as GitHub's GraphQL answers; null when `gh` fails. */
function fetchMergedPRs(repo: string, gh: string, timeoutMs: number): Promise<unknown> {
  return new Promise((done) => {
    const args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-F", `merged=${MERGED_PRS}`, "-F", `closed=${CLOSED_PRS}`, "-f", `query=${QUERY}`];
    let child;
    try {
      child = spawn(gh, args, { cwd: repo, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      done(null);
      return;
    }
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return done(null);
      try {
        done(JSON.parse(out));
      } catch {
        done(null);
      }
    });
  });
}

interface Actor {
  login?: string;
  __typename?: string;
}
interface GqlComment {
  body?: string;
  path?: string;
  diffHunk?: string;
  authorAssociation?: string;
  author?: Actor | null;
}
interface GqlPR {
  number?: number;
  title?: string;
  body?: string;
  mergedAt?: string;
  closedAt?: string;
  author?: Actor | null;
  authorAssociation?: string;
  comments?: { nodes?: GqlComment[] };
  reviews?: { nodes?: GqlComment[] };
  reviewThreads?: { nodes?: { isResolved?: boolean; isOutdated?: boolean; path?: string; comments?: { nodes?: GqlComment[] } }[] };
}

const isBot = (a: Actor | null | undefined) => a?.__typename === "Bot" || /\[bot\]$/i.test(a?.login ?? "");

/** Drops HTML comments, again until none are left, so `<!<!---->--` can't leave one behind; an unclosed one runs to the end. */
function dropHtmlComments(s: string): string {
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/<!--[\s\S]*?-->/g, "");
  }
  return s.replace(/<!--[\s\S]*$/, "");
}

/** A comment as one line for Claude: no HTML comments, no quoted replies, no images, secrets scrubbed. */
export function reviewWords(raw: string): string | null {
  let t = dropHtmlComments(raw)
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  // Scrubbed before it's clipped, so a clip never leaves part of a key behind.
  t = scrub(t);
  return t.length > COMMENT_CHARS ? `${t.slice(0, COMMENT_CHARS)}…` : t;
}

/** The last lines of a comment's diff hunk: the code it was left on, scrubbed. */
export function commentedCode(hunk: string | undefined): string | undefined {
  const lines = (hunk ?? "").split("\n").filter((l) => !l.startsWith("@@"));
  if (!lines.length) return undefined;
  const code = scrub(lines.slice(-CODE_LINES).join("\n")).slice(-CODE_CHARS).trim();
  return code || undefined;
}

/** A PR description as text for Claude: no HTML comments or images, blank runs folded, secrets scrubbed. */
function descriptionWords(raw: string | undefined): string | undefined {
  let t = dropHtmlComments(raw ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  if (!t) return undefined;
  t = scrub(t);
  return t.length > DESCRIPTION_CHARS ? `${t.slice(0, DESCRIPTION_CHARS)}…` : t;
}

/**
 * The PRs in GitHub's answer worth reading, newest first, and how many merged
 * PRs it had: each with its description, the comments and review summaries
 * people left, and every inline thread comment (marked when the author acted
 * on it). Only the owner, members and collaborators are read, never bots,
 * nor the PR author's own replies in a thread; a PR a bot opened is skipped,
 * and one closed without merging is read without its description unless its
 * author is on the team. A PR with no description to speak of and nothing
 * said on it is left out.
 */
export function reviewedPRs(data: unknown): { merged: number; prs: ReviewedPR[] } {
  const repo = (data as { data?: { repository?: Record<string, { nodes?: (GqlPR | null)[] } | undefined> } } | null)?.data?.repository ?? {};
  // `pullRequests` is the answer before closed PRs were read: all merged.
  const merged = repo.merged?.nodes ?? repo.pullRequests?.nodes ?? [];
  const closed = repo.closed?.nodes ?? [];
  const prs: ReviewedPR[] = [];
  const read = (pr: GqlPR | null, kind: ReviewedPR["kind"]) => {
    const at = kind === "merged" ? pr?.mergedAt : pr?.closedAt;
    if (!pr || typeof pr.number !== "number" || !at || (kind === "closed" && pr.mergedAt) || isBot(pr.author)) return;
    const author = pr.author?.login;
    const comments: ReviewedPR["comments"] = [];
    for (const c of pr.comments?.nodes ?? []) {
      if (!c || isBot(c.author) || !onTeam(c)) continue;
      const text = reviewWords(c.body ?? "");
      if (text) comments.push({ text, where: "comment" });
    }
    for (const r of pr.reviews?.nodes ?? []) {
      if (!r || isBot(r.author) || !onTeam(r) || (author && r.author?.login === author)) continue;
      const text = reviewWords(r.body ?? "");
      if (text) comments.push({ text, where: "review" });
    }
    for (const thread of pr.reviewThreads?.nodes ?? []) {
      const actedOn = !!(thread?.isOutdated || thread?.isResolved);
      for (const c of thread?.comments?.nodes ?? []) {
        if (!c || isBot(c.author) || !onTeam(c) || (author && c.author?.login === author)) continue;
        const text = reviewWords(c.body ?? "");
        const path = c.path ?? thread?.path;
        if (!text || !path) continue;
        const code = commentedCode(c.diffHunk);
        comments.push({ path, text, actedOn, where: "thread", ...(code ? { code } : {}) });
      }
    }
    const description = kind === "merged" || onTeam(pr) ? descriptionWords(pr.body) : undefined;
    if (!comments.length && (description?.length ?? 0) < SAYS_SOMETHING) return;
    prs.push({ number: pr.number, title: scrub(pr.title ?? "").slice(0, 120), at, kind, ...(description ? { description } : {}), comments });
  };
  for (const pr of merged) read(pr, "merged");
  for (const pr of closed) read(pr, "closed");
  return { merged: merged.filter(Boolean).length, prs: prs.sort((a, b) => b.at.localeCompare(a.at)) };
}

/** A PR's source id, as its digest header names it and a learning cites it. */
export const prSource = (n: number) => `#${n}`;

/** One PR as Claude reads it, headed by the id learnings cite. */
function prBlock(pr: ReviewedPR): string {
  const lines = [`=== PR ${prSource(pr.number)} (${pr.kind === "merged" ? "merged" : "closed without merging"}, ${pr.at.slice(0, 10)}): ${pr.title}`];
  if (pr.description) lines.push(`[description] ${pr.description}`);
  for (const c of pr.comments) {
    if (c.where === "thread") {
      if (c.code) lines.push(`[code in ${c.path}]\n${c.code}`);
      lines.push(`[on ${c.path}${c.actedOn ? ", acted on" : ""}] ${c.text}`);
    } else lines.push(`[${c.where === "review" ? "review" : "comment"}] ${c.text}`);
  }
  return lines.join("\n");
}

/** The PRs as one text for Claude, newest first, cut at `maxChars`. */
export function reviewDigest(prs: ReviewedPR[], maxChars = REVIEW_DIGEST_CHARS): { text: string; read: ReviewedPR[] } {
  const parts: string[] = [];
  const read: ReviewedPR[] = [];
  let size = 0;
  for (const pr of prs) {
    const block = prBlock(pr);
    if (size + block.length > maxChars && parts.length) break;
    parts.push(block);
    read.push(pr);
    size += block.length + 2;
  }
  return { text: parts.join("\n\n"), read };
}

/** The repo's contributor and decision docs, each as a source: CONTRIBUTING, and docs/adr or docs/decisions. */
export function repoDocs(repo: string): { id: string; text: string }[] {
  const paths = ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"].filter((p) => existsSync(join(repo, p))).slice(0, 1);
  for (const dir of ["docs/adr", "docs/decisions", "doc/adr", "adr"]) {
    try {
      for (const f of readdirSync(join(repo, dir)).filter((x) => x.endsWith(".md")).sort().slice(-12)) paths.push(`${dir}/${f}`);
    } catch {
      // no such folder
    }
  }
  const out: { id: string; text: string }[] = [];
  for (const p of paths) {
    const text = readPlain(join(repo, p), 512 * 1024);
    if (text?.trim()) out.push({ id: `doc ${p}`, text: scrub(text.trim()).slice(0, DOC_CHARS) });
  }
  return out;
}

/** The repo's revert commits, newest first: what was tried and backed out. */
export function revertCommits(repo: string): string {
  const r = spawnSync("git", ["-C", repo, "log", "-n", "400", "--grep=^Revert", "--format=%h %ad %s%n%b%n---", "--date=short"], { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? scrub(r.stdout.trim()).slice(0, DOC_CHARS) : "";
}

/* -------------------------------------------------------------------------- */
/* Asking Claude, and keeping only what's really there                        */
/* -------------------------------------------------------------------------- */

/** The model's learnings as review findings: the headline as the title, the why and the code as the body. */
export function verifyReviews(raw: unknown[], prs: ReviewedPR[], docs: { id: string; text: string }[] = []): ReviewFinding[] {
  const sources: QuoteSource[] = [
    ...prs.map((pr) => ({ id: prSource(pr.number), at: pr.at, said: [pr.description ?? "", ...pr.comments.map((c) => c.text)].filter(Boolean).map(norm) })),
    // Docs and reverts have no date of their own; they sort last.
    ...docs.map((d) => ({ id: d.id, at: "0000-00-00", said: d.text.split(/\n+/).map(norm) })),
  ];
  const byId = new Map(prs.map((pr) => [prSource(pr.number), pr]));
  const out: ReviewFinding[] = [];
  for (const l of verifyLearnings(raw, sources)) {
    const on = l.sources.map((id) => byId.get(id)).filter((x): x is ReviewedPR => !!x);
    const said = l.quotes.map(norm);
    // The files the quoted inline comments sit on: what the learning is about, when it's about a place.
    const paths = [...new Set(on.flatMap((pr) => pr.comments).filter((c) => c.path && said.some((q) => norm(c.text).includes(q))).map((c) => c.path!))];
    out.push({
      title: l.headline,
      body: learningBody(l, "").trim(),
      prs: on.map((pr) => pr.number),
      last: on[0]?.at.slice(0, 10) ?? l.last,
      quotes: l.quotes,
      paths,
    });
  }
  return out;
}

/**
 * What the repo's PRs say the team decided, ruled out or got burned by,
 * checked against what was sent. Never throws: no `gh`, nothing worth
 * reading, no Claude Code, or a failed call come back as an empty list with
 * the reason. `since` (an ISO time) reads only PRs after it.
 */
export async function findReviewLearnings(
  repo: string,
  opts: { model?: string; timeoutMs?: number; gh?: string; limit?: number; capMs?: number; since?: string; onLearning?: (f: ReviewFinding) => void } = {},
): Promise<ReviewResult> {
  const model = opts.model ?? COLD_START_MODEL;
  const started = Date.now();
  // `capMs`: the whole read, gh and the model call, ends by then (an agent's tool call has a time limit).
  const left = () => (opts.capMs === undefined ? Infinity : opts.capMs - (Date.now() - started));
  const base = { prs: 0, reviewed: 0, read: 0, model, findings: [] as ReviewFinding[] };
  const data = await fetchMergedPRs(repo, opts.gh ?? "gh", Math.min(60_000, left()));
  if (!data) return { ...base, durationMs: Date.now() - started, reason: "no_gh" };
  const { merged, prs: all } = reviewedPRs(data);
  const prs = opts.since ? all.filter((pr) => pr.at > opts.since!) : all;
  base.prs = merged;
  base.reviewed = prs.length;
  if (!prs.length) return { ...base, durationMs: Date.now() - started, reason: "no_reviews" };
  const bin = claudeBin();
  if (!bin) return { ...base, durationMs: Date.now() - started, reason: "no_claude", why: "not_installed" };
  const { text, read } = reviewDigest(prs);
  const reverts = revertCommits(repo);
  const docs = [...repoDocs(repo), ...(reverts ? [{ id: "reverts", text: reverts }] : [])];
  base.read = read.length;
  const extra = docs.map((d) => `=== ${d.id}\n${d.text}`).join("\n\n");
  const asked = await callClaude<unknown>(
    bin,
    `This repository's recent pull requests, newest first: descriptions, discussion, review summaries, inline review threads (marked "acted on" when the author changed the code or resolved it), PRs closed without merging, then revert commits and the repo's contributor and decision docs. Find the learnings.\n\n${text}${extra ? `\n\n${extra}` : ""}`,
    model,
    Math.max(1, Math.min(opts.timeoutMs ?? 180_000, left())),
    {
      system: BAR,
      schema: LEARNING_SCHEMA,
      // Each finding checked the moment it's written, so init can show it then; the list below is still the answer.
      ...(opts.onLearning ? { onFinding: (raw: unknown) => verifyReviews([raw], read, docs).forEach(opts.onLearning!) } : {}),
    },
  );
  const durationMs = Date.now() - started;
  if (!asked.ok) return { ...base, durationMs, reason: asked.why === "not_installed" ? "no_claude" : "failed", why: asked.why, ...(asked.said ? { said: asked.said } : {}) };
  const findings = verifyReviews(asked.findings, read, docs).slice(0, opts.limit ?? 8);
  return { ...base, findings, durationMs, costUsd: asked.costUsd, reason: findings.length ? undefined : "none_found" };
}

/* -------------------------------------------------------------------------- */
/* At trail init                                                              */
/* -------------------------------------------------------------------------- */

/** Where a repo remembers that its PR reviews were read, on this machine. */
function readMark(repo: string): string {
  return join(ensureRepoHome(repo).place.dir, "pr-reviews.json");
}

export interface ReviewRead {
  started: number;
  result: Promise<ReviewResult>;
  done: boolean;
}

/**
 * Start reading the repo's PR reviews, for `trail init` to collect at its
 * end; null when it was read on this machine before, a teammate already
 * committed what it found, TRAIL_NO_FETCH is set, or there's no `gh` to read
 * them with.
 */
export function beginReviewRead(repo: string, env: NodeJS.ProcessEnv = process.env, gh = "gh", capMs?: number, onLearning?: (f: ReviewFinding) => void): ReviewRead | null {
  try {
    if (env.TRAIL_NO_FETCH === "1" || readJson<{ at?: number }>(readMark(repo))?.at) return null;
    // The same reviews give a teammate the same findings: once is enough for the repo.
    if (listNotes(repo, { branches: false }).some((n) => n.scope === "repo" && FLAGGED.test(n.body))) return null;
    if (!ghReady(repo, gh)) {
      track("cold_start", { source: "reviews", outcome: "no_gh" }, { repo });
      return null;
    }
    const read: ReviewRead = { started: Date.now(), done: false, result: findReviewLearnings(repo, { gh, ...(capMs === undefined ? {} : { capMs }), ...(onLearning ? { onLearning } : {}) }) };
    void read.result.then(() => (read.done = true));
    return read;
  } catch {
    return null;
  }
}

/**
 * Words a finding about these files would say: each file's name without its
 * extension, its folder, and a function after `#`. A finding that says none of
 * them is generic advice, whatever it's anchored to.
 */
export function codeWords(touches: string[]): string[] {
  const words = new Set<string>();
  for (const t of touches) {
    const [file, symbol] = t.split("#");
    const parts = file!.split("/");
    const name = parts[parts.length - 1]!.replace(/\.[^.]+$/, "");
    if (name.length > 2 && !/^(index|main|mod|init|utils?|types?|__init__)$/i.test(name)) words.add(name.toLowerCase());
    const dir = parts[parts.length - 2];
    if (dir && dir.length > 2 && !/^(src|lib|internal|pkg|app|test|tests)$/i.test(dir)) words.add(dir.toLowerCase());
    if (symbol) for (const w of symbol.split(".")) if (w.length > 2) words.add(w.toLowerCase());
  }
  return [...words];
}

/**
 * The anchors on the files the review was on, or on a file the finding names
 * by name: a function elsewhere that only shares a word with it (`conflicts`
 * in some frontend service) would bring the learning to the wrong file.
 */
function onItsFiles(touches: string[], f: ReviewFinding): string[] {
  const reviewed = new Set(f.paths ?? []);
  const said = `${f.title}\n${f.body}`;
  return touches.filter((t) => {
    const file = t.split("#")[0]!;
    return reviewed.has(file) || said.includes(file.slice(file.lastIndexOf("/") + 1));
  });
}

/** How many commits touched each file in the last 60 days: what the team is working on now. */
function recentEdits(repo: string): Map<string, number> {
  const counts = new Map<string, number>();
  const r = spawnSync("git", ["-C", repo, "log", "--since=60.days", "--name-only", "--format="], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) return counts;
  for (const f of r.stdout.split("\n")) if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  return counts;
}

/**
 * The findings fit to offer the team, in order: not already said in
 * CLAUDE.md, AGENTS.md or a learning, with `touches` set to the code each is
 * about when it names code that exists now (a file it names, a file its
 * quoted comments were on, or a function the graph knows). One about a place
 * must name that place in its words; one about how the team works needs no
 * file. The ones on files the team edits most now come first. Same repo, same answer:
 * init's picker and {@link finishReviewRead} both call it.
 */
export function anchoredReviews(repo: string, findings: ReviewFinding[]): ReviewFinding[] {
  const known = knownText(repo);
  const out: { f: ReviewFinding; heat: number }[] = [];
  const edits = findings.length ? recentEdits(repo) : new Map<string, number>();
  for (const f of findings) {
    if (alreadySaid(known, f.title, f.body)) continue;
    const touches = onItsFiles(codeAnchors(repo, `${f.title}\n${f.body}`, f.paths), f);
    // About a place, it must name that place; about how the team works, it needs no file.
    const said = `${f.title}\n${f.body}`.toLowerCase();
    if (touches.length && !codeWords(touches).some((w) => said.includes(w))) continue;
    out.push({ f: { ...f, touches }, heat: Math.max(0, ...touches.map((t) => edits.get(t.split("#")[0]!) ?? 0)) });
  }
  return out.sort((a, b) => b.heat - a.heat).map((x) => x.f);
}

/** Each finding as a standing learning in `.trail/learnings/`. The body says which PRs it came from. */
export function saveReviewFindings(repo: string, findings: ReviewFinding[], author = noteAuthor(repo), date = new Date().toISOString().slice(0, 10)): Note[] {
  return findings.map((f) =>
    writeNote(
      repo,
      {
        title: f.title,
        author,
        date,
        body: f.prs.length ? `${f.body.trim()}\n\n_From PR${f.prs.length > 1 ? "s" : ""} ${f.prs.map((n) => `#${n}`).join(", ")} here, ${shortDate(f.last)}._` : `${f.body.trim()}\n\n_From this repo's docs._`,
        touches: f.touches ?? codeAnchors(repo, f.body, f.paths),
        standing: true,
        src: "init-review",
      },
      "repo",
    ),
  );
}

/**
 * Wait for the read, save the findings the person keeps, and remember the
 * repo's reviews were read. Every finding is kept unless `keep` picks; `keep`
 * resolving null means they cancelled, so nothing is saved and the next init
 * asks again.
 */
export async function finishReviewRead(
  repo: string,
  read: ReviewRead,
  keep?: (findings: ReviewFinding[]) => Promise<ReviewFinding[] | null>,
): Promise<{ result: ReviewResult; saved: Note[]; kept: ReviewFinding[]; cancelled: boolean }> {
  const result = await read.result;
  const findings = anchoredReviews(repo, result.findings);
  const chosen = findings.length && keep ? await keep(findings) : findings;
  const kept = chosen ?? [];
  const saved = kept.length ? saveReviewFindings(repo, kept) : [];
  const outcome = chosen === null ? "cancelled" : findings.length ? "found" : result.findings.length ? "none_anchored" : (result.reason ?? "none_found");
  if (outcome === "found" || outcome === "none_found" || outcome === "none_anchored") writeJsonAtomic(readMark(repo), { at: Date.now(), model: result.model, saved: saved.length, ms: result.durationMs, ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }) }, true);
  track(
    "cold_start",
    {
      source: "reviews",
      outcome,
      reviews_bucket: countBucket(result.reviewed),
      offered_bucket: countBucket(findings.length),
      filtered_bucket: countBucket(result.findings.length - findings.length),
      picked_bucket: countBucket(saved.length),
      duration_bucket: durationBucket(result.durationMs),
      model: result.model,
    },
    { repo },
  );
  return { result, saved, kept, cancelled: chosen === null };
}
