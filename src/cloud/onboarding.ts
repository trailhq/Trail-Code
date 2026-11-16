/**
 * `trail init --connect <CODE>`: the onboarding on team.trailhq.com.
 *
 * A person signs up on the web, picks "Writing Code", and is shown two
 * commands: install trail, then `trail init --connect TRL-XXXX-XXXX`. The code
 * is one-time and short-lived; claiming it gives this machine a workspace
 * token, kept where `trail login` keeps one (`~/.trail/cloud.json`).
 *
 * While init runs, the page ticks off stages as this sends them: connected,
 * mapped, learned, done. Before `done`, one summary of the repo goes up, for
 * the "What Trail found" page:
 *
 *   - tokens: one real lookup on the fresh code map, and what it saved
 *   - learnings: titles, a short line of each and how many sessions said it
 *   - teammates: other people's recently pushed branches that change the
 *     files this person works on, from git
 *
 * Summaries only (the onboarding's "route B"): never code, diffs or session
 * text. Every call is bounded and never throws; offline, init carries on and
 * says nothing about it.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { formatAsk, ask } from "../ask/ask.js";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../graph/load.js";
import { buildRepoMap } from "../graph/map.js";
import { refreshBranches, safeRef } from "../notes/branches.js";
import { cleanSubject } from "../notes/edit-overlap.js";
import { changedFiles, ownPath } from "../notes/git-facts.js";
import { repoName, repoPlace } from "../notes/home.js";
import { listNotes, sectionLead, type Note } from "../notes/notes.js";
import { DEFAULT_TRAIL_URL, isError, trailUrl, type ApiError, type Cloud } from "./workspace.js";

type Fetch = typeof fetch;

/* -------------------------------------------------------------------------- */
/* the code                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The code as the page shows it, `TRL-7F2A-K9QD`, from however it was pasted:
 * any case, with or without the prefix and dashes. Null when it can't be one.
 */
export function normalizeCode(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[\s_]+/g, "-");
  const bare = s.replace(/^TRL-?/, "").replace(/-/g, "");
  if (!/^[A-Z0-9]{8}$/.test(bare)) return null;
  return `TRL-${bare.slice(0, 4)}-${bare.slice(4)}`;
}

/**
 * The repo as the workspace names it: `{name, remote_url}`, from which Trail
 * derives its key. No path on this machine, and never a credential from the
 * remote: the URL is rebuilt from the repo's key (`github.com/acme/retry` →
 * `https://github.com/acme/retry`), so a token in an https remote stays here.
 * A repo with no remote sends its name alone.
 */
export interface RepoRef {
  name: string;
  remote_url?: string;
}

export function repoRef(repo: string): RepoRef {
  const place = repoPlace(repo);
  if (place.key.startsWith("local/")) return { name: repoName(place.key, place.checkout) };
  // The name as the remote spells it (`go-retryablehttp`, `Graft`); the key is lower-cased.
  const origin = git(place.checkout, ["remote", "get-url", "origin"], 5000)?.trim() ?? "";
  const last = origin.replace(/\.git\/?$/i, "").split(/[/:]/).pop() ?? "";
  const name = /^[A-Za-z0-9._-]+$/.test(last) ? last : place.key.split("/").pop()!;
  return { name, remote_url: `https://${place.key}` };
}

/** What the page shows for the terminal: `Rushabh's MacBook Pro` on a Mac, else the host name. */
export function machineName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
      if (name) return name.slice(0, 80);
    } catch {
      /* the host name below */
    }
  }
  try {
    return hostname().replace(/\.(local|lan|home)$/i, "").slice(0, 80);
  } catch {
    return "";
  }
}

export type ConnectResult =
  | { cloud: Cloud }
  /** The code is wrong, used or expired: say so, and connect nothing. */
  | { error: string; reason: "invalid" }
  /** Trail didn't answer: set up locally and say how to connect later. */
  | { error: string; reason: "offline" };

interface ConnectBody {
  token?: string;
  workspace?: { id?: string; name?: string; slug?: string; url?: string; invite_url?: string };
  user?: { id?: string; name?: string; email?: string };
}

async function post<T>(
  url: string,
  body: unknown,
  opts: { token?: string; timeoutMs?: number; fetchImpl?: Fetch },
): Promise<{ status: number; body: T } | ApiError> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await f(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = (json as { error?: unknown } | null)?.error;
      return { error: typeof msg === "string" ? msg : `Trail answered ${res.status}`, status: res.status };
    }
    return { status: res.status, body: json as T };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { error: timedOut ? "Trail didn't answer in time" : "couldn't reach Trail" };
  }
}

/**
 * Claim the one-time code: `POST /api/public/cli/connect`. Gives back the
 * connection to save, with no repos picked: the full learnings sync stays off
 * for a machine connected this way, so only the summary below goes up.
 */
export async function claimConnectCode(
  base: string,
  code: string,
  req: { machine: string; repo: RepoRef },
  opts: { fetchImpl?: Fetch; now?: number } = {},
): Promise<ConnectResult> {
  const r = await post<ConnectBody>(`${base}/api/public/cli/connect`, { code, machine: req.machine, repo: req.repo }, { fetchImpl: opts.fetchImpl, timeoutMs: 15_000 });
  if (isError(r)) {
    if (r.status === undefined) return { error: r.error, reason: "offline" };
    if (r.status >= 500) return { error: `Trail answered ${r.status}`, reason: "offline" };
    if (r.status === 403) return { error: "the account that made this code is no longer in that workspace", reason: "invalid" };
    if (r.status === 429) return { error: "too many tries just now; wait a minute and run it again", reason: "invalid" };
    return { error: "that code was already used, has expired, or isn't right", reason: "invalid" };
  }
  const b = r.body;
  const ws = b?.workspace;
  if (!b?.token || !ws?.name) return { error: "Trail sent an answer with no workspace in it", reason: "offline" };
  const id = ws.id ?? ws.slug ?? ws.name;
  return {
    cloud: {
      url: base,
      token: b.token,
      user: { name: b.user?.name ?? "", email: b.user?.email ?? "" },
      workspace: {
        id,
        name: ws.name,
        // readCloud needs a slug to count the connection; the connect answer may not carry one.
        slug: ws.slug || id,
        url: ws.url || `${base}/`,
        invite_url: ws.invite_url || `${base}/`,
      },
      repos: [],
      linkedAt: opts.now ?? Date.now(),
      via: "connect",
    },
  };
}

/**
 * The command that connects later: `trail init --connect TRL-… --server <url>`,
 * naming the Trail it was run against unless that's Trail cloud, so it
 * reaches the same backend the code came from.
 */
export function connectAgain(command: string, code: string, base: string): string {
  return `${command} --connect ${code}${base.replace(/\/+$/, "") === DEFAULT_TRAIL_URL ? "" : ` --server ${base}`}`;
}

/**
 * What to say, once, when Trail didn't take the code because it couldn't be
 * reached: which Trail, what happened, and the exact command to connect later.
 * `· couldn't reach Trail at http://localhost:5173 · set this repo up anyway ·
 * to connect it later: trail init --connect TRL-7F2A-K9QD --server http://localhost:5173`
 */
export function offlineLine(error: string, base: string, code: string, command: string): string {
  const what = error.startsWith("Trail ") ? `Trail at ${base}${error.slice("Trail".length)}` : `couldn't reach Trail at ${base}`;
  return `· ${what} · set this repo up anyway · to connect it later: ${connectAgain(command, code, base)}`;
}

/* -------------------------------------------------------------------------- */
/* the stages and the summary                                                 */
/* -------------------------------------------------------------------------- */

export type Stage = "connected" | "mapped" | "learned" | "done";

export interface TokensSummary {
  /** What was asked, in words the page can show: `how Do works`. */
  question: string;
  /** The symbol asked about. */
  symbol: string;
  /** Tokens saved, the pack, and reading the files whole: the `tokens saved ≈` line's numbers. */
  saved: number;
  pack: number;
  baseline: number;
  pct: number;
  /** How many files the baseline reads whole. */
  files: number;
  /**
   * When the question was the last merged PR's title: that PR, at most
   * {@link PR_FILES_SENT} of the code files it changed, how many it changed
   * in all, and how many of them the answer pointed to.
   */
  pr?: LastPr & { changed: number; found: number };
}

/** A merged pull request, as git's history on the default branch tells it. */
export interface LastPr {
  number: number;
  title: string;
  /** The PR on GitHub, when the repo is there. */
  url?: string;
  /** The product code files it changed that are still in the repo. */
  files: string[];
}

export interface LearningSummary {
  title: string;
  /** One line of it, no code blocks, at most 200 characters. */
  body: string;
  /** Past sessions it was said in; 0 when it didn't come from sessions. */
  sessions: number;
}

export interface TeammateSummary {
  name: string;
  email: string;
  /** `kumar/retry`, without `origin/`. */
  branch: string;
  /** The files it changes that this person works on too (or, with no history of theirs, the repo's busiest). */
  files: string[];
  /** One line, from the branch's commit subjects. */
  change: string;
  /** When its newest commit was made, ISO. */
  pushed_at: string;
  /** Commits on the branch since it left the default branch. */
  commits?: number;
  /** When it changes a file one of this repo's learnings is about: which, and which learning. */
  conflict?: string;
}

export interface RepoSummary {
  repo: RepoRef;
  tokens: TokensSummary | null;
  /** Past sessions init read for learnings; absent when it read none this time. */
  sessions?: number;
  learnings: LearningSummary[];
  teammates: TeammateSummary[];
}

/**
 * Sends the stages and the summary for one `init --connect`, in order. The
 * first call that can't reach Trail turns the rest off, so a laptop offline
 * waits on one timeout at most. Never throws.
 */
export class OnboardingReporter {
  private offline = false;
  private chain: Promise<unknown> = Promise.resolve();
  readonly sent: Array<{ path: string; body: unknown; ok: boolean }> = [];

  constructor(
    private readonly cloud: Cloud,
    readonly repo: RepoRef,
    private readonly opts: { fetchImpl?: Fetch; timeoutMs?: number; machine?: string } = {},
  ) {}

  private send(path: string, body: unknown): Promise<boolean> {
    const next = this.chain.then(async () => {
      if (this.offline) return false;
      const r = await post(`${this.cloud.url}${path}`, body, { token: this.cloud.token, fetchImpl: this.opts.fetchImpl, timeoutMs: this.opts.timeoutMs ?? 5_000 });
      const ok = !isError(r);
      // No answer at all: offline, or Trail is down. An HTTP error is this call's alone.
      if (isError(r) && r.status === undefined) this.offline = true;
      this.sent.push({ path, body, ok });
      return ok;
    });
    this.chain = next.catch(() => false);
    return next.catch(() => false);
  }

  /** One stage, for the page to tick off. */
  stage(stage: Stage, data: Record<string, unknown> = {}): Promise<boolean> {
    return this.send("/api/cli/onboarding/events", { repo: this.repo, stage, machine: this.opts.machine, data });
  }

  summary(s: Omit<RepoSummary, "repo">): Promise<boolean> {
    return this.send("/api/cli/repos/summary", { repo: this.repo, ...s });
  }

  /** Wait for everything sent so far. */
  async flush(): Promise<void> {
    await this.chain;
  }
}

/* tokens ------------------------------------------------------------------- */

/** The numbers in `ask`'s `[trail] tokens saved ≈ N (P%) — this pack ≈ … tok vs reading the F source file(s) whole ≈ B tok` line. */
export function parseAskSavings(text: string): Omit<TokensSummary, "question" | "symbol"> | null {
  const m = text.match(/\[(?:graft|trail)\] tokens saved ≈ ([\d,]+) \((\d+)%\) — this pack ≈ ([\d,]+) tok vs reading the (\d+) source file\(s\) whole ≈ ([\d,]+) tok/);
  if (!m) return null;
  const n = (s: string) => Number(s.replace(/,/g, ""));
  return { saved: n(m[1]!), pct: n(m[2]!), pack: n(m[3]!), files: n(m[4]!), baseline: n(m[5]!) };
}

/** Folders that hold tests, fixtures, vendored or generated code, anywhere in a path. */
const NOT_PRODUCT_DIR = /(^|\/)(test|tests|__tests__|testdata|test-fixtures|fixtures|__fixtures__|__mocks__|vendor|third_party|node_modules|generated|__generated__|gen)\//i;
/** File names of tests and generated code: `client_test.go`, `a.test.ts`, `a.spec.js`, `test_client.py`, `api.pb.go`, `schema.generated.ts`. */
const NOT_PRODUCT_FILE = /(_test\.[^/]+|\.(test|spec)\.[^/]+|_spec\.[^/]+|(^|\/)test_[^/]+\.py|(^|\/)conftest\.py|\.(generated|gen)\.[^/]+|\.pb\.go|_pb2(_grpc)?\.py|\.d\.ts)$/i;

/** Whether a repo path is test, fixture, vendored or generated code, which a lookup shouldn't be measured on. */
export function notProductCode(path: string): boolean {
  const p = path.split("\\").join("/");
  return NOT_PRODUCT_DIR.test(p) || NOT_PRODUCT_FILE.test(p);
}

/** Docs and config: prose, data and settings files, and the folders that hold them. */
const DOC_OR_CONFIG_FILE = new RegExp(
  [
    "\\.(md|mdx|markdown|rst|adoc|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|xml|csv|svg|png|jpe?g|gif|ico)$",
    "(^|/)(readme|changelog|changes|history|license|licence|notice|authors|contributors|codeowners|security)$",
    "(^|/)(makefile|dockerfile|procfile|go\\.mod|go\\.sum)$",
    // Dotfiles: .gitignore, .eslintrc.js, .env.local.
    "(^|/)\\.[^/]+$",
  ].join("|"),
  "i",
);
const DOC_OR_CONFIG_DIR = /(^|\/)(docs?|\.github|\.circleci|\.vscode|\.idea)\//i;

/** Whether a repo path is docs or config rather than code. */
export function docOrConfig(path: string): boolean {
  const p = path.split("\\").join("/");
  return DOC_OR_CONFIG_DIR.test(p) || DOC_OR_CONFIG_FILE.test(p);
}

/**
 * A teammate's files with the one worth naming first: product code (by the
 * same rules as the tokens lookup), then other code (tests, fixtures,
 * vendored, generated), then docs and config. Every file stays; only the
 * order changes, and within each kind it's git's. The page says a teammate
 * "is changing" the first one, which shouldn't be CHANGELOG.md when they
 * also change client.go.
 */
export function headlineOrder(files: string[]): string[] {
  const rank = (f: string) => (docOrConfig(f) ? 2 : notProductCode(f) ? 1 : 0);
  return files.map((f, i) => ({ f, i, r: rank(f) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.f);
}

const COMMON_UTIL_NAMES = new Set(["cn", "utils", "index", "helpers", "main", "init", "config", "setup", "test"]);

/** Whether a symbol name is worth measuring a lookup on: at least 5 characters and not a common util name. */
export function meaningfulSymbol(name: string): boolean {
  return name.length >= 5 && !COMMON_UTIL_NAMES.has(name.toLowerCase());
}

/**
 * One real lookup on the code map, as an agent would make it: a question
 * about the repo's most central symbol (most incoming edges, with a name of
 * 5+ characters that isn't a common util name) outside tests,
 * fixtures, vendored and generated code, answered with
 * the code inlined, and what that saved against reading the files it covers
 * whole. The next most central is tried when a lookup saves nothing (tiny
 * files). Null without a graph.
 */
export function tokensOnOneLookup(repo: string, opts: { contextDir?: string; tries?: number } = {}): TokensSummary | null {
  const pr = tokensOnLastPr(repo, opts);
  if (pr) return pr;
  try {
    const graph = loadGraphCached(contextDirFor(repo, opts.contextDir));
    if (!graph) return null;
    // The most central symbols of the product code: tests, fixtures, vendored
    // and generated code only when there's nothing else.
    // A name worth asking about: a short or generic one (`cn`, `utils`, `main`)
    // says nothing about the repo, so the example would be meaningless.
    // Falls back to every symbol when no name passes, so a repo of short names still gets a figure.
    const spots = buildRepoMap(graph, { hotspots: 500 }).hotspots;
    const named = spots.filter((h) => meaningfulSymbol(h.name));
    const all = named.length ? named : spots;
    const product = all.filter((h) => !notProductCode(h.path));
    const hubs = (product.length ? product : all).slice(0, Math.max(1, opts.tries ?? 5));
    for (const hub of hubs) {
      const query = `how does ${hub.name} work`;
      const r = ask(repo, query, { source: true, limit: 5, contextDir: opts.contextDir });
      const got = parseAskSavings(formatAsk(r));
      if (got && got.saved > 0) return { question: `how ${hub.name} works`, symbol: hub.name, ...got };
    }
    return null;
  } catch {
    return null;
  }
}

/** The most of a PR's changed files sent to Trail; `changed` says how many there were. */
export const PR_FILES_SENT = 20;

/** `Merge pull request #12 from acme/retry-backoff` (a merge), with the title on the body's first line. */
const MERGED_PR = /^Merge pull request #(\d+) from (\S+)/;
/** `Retry with backoff (#12)` (a squash or rebase merge). */
const SQUASHED_PR = /^(.+?) \(#(\d+)\)$/;
/** Bots' PRs and release chores, which say nothing about the work. */
const NOT_WORK_PR = /^(bump |chore\(release\)|release[: ]|\[bot\]|merge (branch|remote-tracking))/i;

/**
 * The merged PRs on the default branch, newest first, read from git alone:
 * GitHub's merge commits and squash merges both name the PR. Only PRs that
 * changed product code still in the repo; at most `limit` of them.
 */
export function lastMergedPrs(repo: string, limit = 5): LastPr[] {
  const base = git(repo, ["rev-parse", "--abbrev-ref", "origin/HEAD"])?.trim() || "HEAD";
  const log = git(repo, ["log", "-n", "300", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", base]);
  if (!log) return [];
  const key = repoPlace(repo).key;
  const out: LastPr[] = [];
  for (const rec of log.split("\x1e")) {
    const [sha, subject = "", body = ""] = rec.trim().split("\x1f");
    if (!sha) continue;
    const merged = subject.match(MERGED_PR);
    const squashed = merged ? null : subject.match(SQUASHED_PR);
    if (!merged && !squashed) continue;
    const number = Number(merged ? merged[1] : squashed![2]);
    const title = cleanSubject(merged ? body.split("\n").find((l) => l.trim()) || merged[2]!.split("/").pop()!.replace(/[-_]/g, " ") : squashed![1]!);
    if (!title || NOT_WORK_PR.test(title)) continue;
    const changed = git(repo, ["diff", "--name-only", "--diff-filter=AMR", `${sha}^1`, sha]) ?? "";
    const files = changed
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f && !notProductCode(f) && !docOrConfig(f) && existsSync(join(repo, f)));
    if (!files.length) continue;
    const url = key.startsWith("github.com/") ? `https://${key}/pull/${number}` : undefined;
    out.push({ number, title, ...(url ? { url } : {}), files });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The lookup an agent starting the last merged PR would make: its title as
 * the question, answered with the code inlined, against reading the files
 * the answer covers whole (ask's own estimate). The next PR back is tried
 * when one saves nothing. Null with no PR in git's history or no graph.
 */
export function tokensOnLastPr(repo: string, opts: { contextDir?: string; tries?: number } = {}): TokensSummary | null {
  try {
    if (!loadGraphCached(contextDirFor(repo, opts.contextDir))) return null;
    for (const pr of lastMergedPrs(repo, Math.max(1, opts.tries ?? 3))) {
      const r = ask(repo, pr.title, { source: true, limit: 5, contextDir: opts.contextDir });
      const got = parseAskSavings(formatAsk(r));
      if (!got || got.saved <= 0) continue;
      const pointed = new Set(r.hits.map((h) => h.pointer.replace(/:L\d+(-L?\d+)?$/, "")));
      const found = pr.files.filter((f) => pointed.has(f)).length;
      return { question: pr.title, symbol: "", ...got, pr: { ...pr, files: pr.files.slice(0, PR_FILES_SENT), changed: pr.files.length, found } };
    }
    return null;
  } catch {
    return null;
  }
}

/* learnings ---------------------------------------------------------------- */

/** How many sessions a learning read from past sessions was said in, from the line init writes under it. */
export function sessionsIn(body: string): number {
  const m = body.match(/Told to Claude in (\d+) past sessions/);
  return m ? Number(m[1]) : 0;
}

/**
 * One line of a learning, for a card: the first point under `## Decided` (or
 * the first line of prose), no code blocks, headings or provenance line, at
 * most 200 characters.
 */
export function shortBody(body: string): string {
  const prose = body
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split(/\r?\n/)
    .filter((l) => !/^_(Told to Claude|Flagged in review) /.test(l.trim()));
  const text = prose.join("\n");
  const lead =
    sectionLead(text, "Decided") ??
    sectionLead(text, "Watch out") ??
    prose.map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ??
    "";
  const one = lead.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 199)}…` : one;
}

/**
 * The team's learnings in this repo, for the summary: what init just learned
 * when it learned something (with the sessions each was said in), else what
 * `.trail/learnings/` already has. Never a personal one: those stay on this
 * machine.
 */
export function learningsSummary(repo: string, learned: Array<{ note: Note; sessions?: number }> | null, max = 10): LearningSummary[] {
  try {
    const notes: Array<{ note: Note; sessions?: number }> = learned?.length
      ? learned.filter((l) => l.note.scope !== "personal")
      : listNotes(repo, { branches: false })
          .filter((n) => n.scope === "repo" && !n.ref)
          .map((note) => ({ note }));
    return notes.slice(0, max).map(({ note, sessions }) => ({
      title: note.title.slice(0, 200),
      body: shortBody(note.body),
      sessions: sessions ?? sessionsIn(note.body),
    }));
  } catch {
    return [];
  }
}

/* teammates ---------------------------------------------------------------- */

function git(repo: string, args: string[], timeout = 15_000): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

const BOT = /\[bot\]|^(dependabot|github-actions|renovate)\b/i;

/** Branches that are where work lands, not work in flight: nobody is "on" them. */
const INTEGRATION_BRANCH = /^(main|master|dev|develop|staging|production|release\/.+)$/;

/**
 * Whether a remote branch is open work by someone: not the remote's default
 * branch (`base`), not a shared integration branch, and not fully merged
 * already (its tip is an ancestor of `base`).
 */
export function openBranch(repo: string, base: string, ref: string): boolean {
  const name = ref.replace(/^origin\//, "");
  if (ref === base || name === base.replace(/^origin\//, "") || INTEGRATION_BRANCH.test(name)) return false;
  // `merge-base --is-ancestor` exits 0 when merged, 1 when not; git() returns null on a nonzero exit.
  return git(repo, ["merge-base", "--is-ancestor", ref, base]) === null;
}

/** Files `email` changed in the last `days` days on any branch, plus what's uncommitted here. */
export function myRecentFiles(repo: string, email: string, days = 30): string[] {
  const out = new Set<string>(changedFiles(repo, undefined, 200));
  if (email) {
    const pattern = `<${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`;
    const log = git(repo, ["log", "--all", "--no-merges", `--since=${days}.days`, `--author=${pattern}`, "--name-only", "--format="]);
    for (const f of (log ?? "").split("\n")) if (f.trim() && !ownPath(f.trim())) out.add(f.trim());
  }
  return [...out].slice(0, 500);
}

/** The repo's busiest files lately: the stand-in for "files you work on" when you have no history here. */
export function hottestFiles(repo: string, n = 30): string[] {
  const count = new Map<string, number>();
  const log = git(repo, ["log", "--no-merges", "--since=90.days", "-n", "2000", "--name-only", "--format="]) || git(repo, ["log", "--no-merges", "-n", "300", "--name-only", "--format="]);
  for (const raw of (log ?? "").split("\n")) {
    const f = raw.trim();
    if (f && !ownPath(f)) count.set(f, (count.get(f) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([f]) => f);
}

/** One line of what a branch does, from its commit subjects, newest first. */
function changeLine(repo: string, base: string, ref: string): string {
  const subjects = (git(repo, ["log", "--no-merges", "--format=%s", "-n", "5", `${base}..${ref}`]) ?? "")
    .split("\n")
    .map((s) => cleanSubject(s))
    .filter(Boolean);
  const line = [...new Set(subjects)].slice(0, 3).join("; ");
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/**
 * `git fetch` in the foreground, at the end of init, without ever stopping to
 * ask: no credential prompt, and no ssh passphrase prompt unless the person
 * set up their own ssh command (then theirs is used as is).
 */
function fetchQuietly(repo: string): void {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (!env.GIT_SSH_COMMAND && !git(repo, ["config", "core.sshCommand"])?.trim()) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    execFileSync("git", ["fetch", "--quiet", "--prune", "origin"], { cwd: repo, stdio: "ignore", timeout: 20_000, env, windowsHide: true });
  } catch {
    /* offline, or no origin: the refs already here */
  }
}

/**
 * The names a learning is about, to look for in a teammate's change: the
 * symbols its `touches` name (`client.go#Do`), and code-like words in its
 * title and lead line (`defaultRetryMax`, `retry_max`, `Do()`). Plain words
 * are left out: "retry" in a learning says nothing about a change.
 */
export function learningTerms(n: Note): string[] {
  const terms = new Set<string>();
  for (const t of n.touches) {
    const sym = t.split("#")[1];
    if (sym) terms.add(sym.split(".").pop()!);
  }
  const text = `${n.title} ${shortBody(n.body)}`;
  // camelCase, PascalCase with an inner capital, snake_case, or a call: `Do()`.
  for (const w of text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b(\(\))?/g) ?? []) {
    const word = w.replace(/\(\)$/, "");
    if (w.endsWith("()") || /[a-z][A-Z]/.test(word) || /[A-Za-z]_[A-Za-z]/.test(word)) terms.add(word);
  }
  return [...terms].filter((t) => t.length >= 2);
}

/**
 * When a teammate's branch changes a name one of the team's learnings is
 * about, in a file that learning touches: `Changes defaultRetryMax in
 * client.go, which your learning "Keep defaultRetryMax at 4" is about.` Read
 * from the branch's diff here; only this line goes up. Nothing when the
 * learning names nothing code-like, or the change doesn't touch it.
 */
export function conflictLine(repo: string, base: string, ref: string, files: string[], learnings: Note[]): string | undefined {
  const changed = new Set(files);
  for (const n of learnings) {
    if (n.scope === "personal") continue;
    const terms = learningTerms(n);
    if (terms.length === 0) continue;
    for (const file of n.touches.map((t) => t.split("#")[0]!).filter((f) => changed.has(f))) {
      const diff = git(repo, ["diff", "--unified=0", `${base}...${ref}`, "--", file]) ?? "";
      const lines = diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
      const hit = terms.find((t) => lines.some((l) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(l)));
      if (hit) {
        const line = `Changes ${hit} in ${file}, which your learning "${n.title.replace(/"/g, "'")}" is about.`;
        return line.length > 300 ? `${line.slice(0, 299)}…` : line;
      }
    }
  }
  return undefined;
}

/**
 * Teammates' work in the same place: remote branches whose newest commit is
 * from the last `days` days and from someone other than this person, that
 * change files this person changed lately (or the repo's busiest files, when
 * they have no history here). Newest first. Fetches first unless
 * `fetch: false` (or TRAIL_NO_FETCH). Names, emails, branch and file names and
 * commit subjects only: never a diff.
 */
export function teammatesFromGit(
  repo: string,
  opts: { days?: number; now?: number; fetch?: boolean; max?: number; learnings?: Note[] } = {},
): TeammateSummary[] {
  return teammatesChecked(repo, opts) ?? [];
}

/**
 * Like {@link teammatesFromGit}, but `undefined` when there was nothing to check
 * against: no origin remote, no default branch to compare with, or git failed.
 * An empty list means "checked, none"; a repo without a remote wasn't checked.
 */
export function teammatesChecked(
  repo: string,
  opts: { days?: number; now?: number; fetch?: boolean; max?: number; learnings?: Note[] } = {},
): TeammateSummary[] | undefined {
  try {
    const now = opts.now ?? Date.now();
    const days = opts.days ?? 14;
    const me = (git(repo, ["config", "user.email"]) ?? "").trim().toLowerCase();
    const myName = (git(repo, ["config", "user.name"]) ?? "").trim().toLowerCase();
    if (opts.fetch !== false && !process.env.TRAIL_NO_FETCH) fetchQuietly(repo);
    const cache = refreshBranches(repo, { fetch: false, now });
    if (!cache.base) return undefined;
    const mine = new Set(myRecentFiles(repo, me));
    const where = mine.size ? mine : new Set(hottestFiles(repo));
    const out: TeammateSummary[] = [];
    for (const b of cache.branches) {
      if (now - b.at > days * 24 * 60 * 60 * 1000) continue;
      if (!openBranch(repo, cache.base, b.ref)) continue;
      const [name = "", email = ""] = (git(repo, ["log", "-1", "--format=%aN%x09%aE", b.ref]) ?? "").trim().split("\t");
      if (!name || BOT.test(name)) continue;
      if ((me && email.toLowerCase() === me) || (myName && name.toLowerCase() === myName)) continue;
      const files = headlineOrder(b.files.filter((f) => !ownPath(f) && where.has(f)));
      if (files.length === 0) continue;
      const commits = Number((git(repo, ["rev-list", "--count", `${cache.base}..${b.ref}`]) ?? "").trim());
      const conflict = conflictLine(repo, cache.base, b.ref, files, opts.learnings ?? []);
      out.push({
        name: name.slice(0, 80),
        email: email.slice(0, 120),
        branch: safeRef(b.ref.replace(/^origin\//, "")),
        files: files.slice(0, 20),
        change: changeLine(repo, cache.base, b.ref),
        pushed_at: new Date(b.at).toISOString(),
        ...(Number.isFinite(commits) && commits > 0 ? { commits } : {}),
        ...(conflict ? { conflict } : {}),
      });
      if (out.length >= (opts.max ?? 10)) break;
    }
    return out.sort((a, b) => b.pushed_at.localeCompare(a.pushed_at));
  } catch {
    return undefined;
  }
}

/** The Trail a code is claimed against: `--server` for this run (useServer), or Trail cloud. */
export function connectBase(env: NodeJS.ProcessEnv = process.env): string {
  return trailUrl(env);
}
