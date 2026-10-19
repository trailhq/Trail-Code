/**
 * Teammates' pushed branches: which files each one changes, and the learnings
 * it carries that the default branch doesn't have yet.
 *
 * This is how two people find out they're on the same thing before review,
 * with no server: once work is pushed, `git fetch` brings it to every clone.
 * Learnings committed on a branch reach everyone the same way, hours or days
 * before the branch merges.
 *
 * Reading branches takes git, and hooks and `ask` must not wait on it, so a
 * detached `_trail-branches` child fetches and writes what it found to a
 * cache, at most every REFRESH_MS. Everything that reads it reads the cache.
 *
 * A branch whose work is already on the default branch is left out: a
 * squash-merged branch still on the remote looks unmerged to git's history,
 * and so does one whose pull request was closed.
 */
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brand } from "../brand.js";
import { graftCliPath } from "../claude/paths.js";
import { cacheDir, readJson, writeJsonAtomic } from "../util/state.js";
import { LEARNINGS_DIR } from "./repo-trail.js";

/** How old the cache may get before the next command refreshes it in the
 * background: about what editors that fetch on their own wait between fetches. */
export const REFRESH_MS = 3 * 60 * 1000;
/** At the start of a session, a cache older than this is refreshed. */
export const SESSION_REFRESH_MS = 60 * 1000;
/** A refresh that started this long ago without finishing is presumed dead. */
const STALE_RUN_MS = 2 * 60 * 1000;
/** Branches older than this are finished or abandoned work, not overlap. */
export const BRANCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Most branches read per refresh, newest first. */
const MAX_BRANCHES = 30;
/** Most changed files kept per branch. */
const MAX_FILES = 200;
/** A learning file name as `trail note` writes it: no folders, no shell characters. */
export const SAFE_LEARNING_NAME = /^[A-Za-z0-9._-]+\.md$/;
/** Most learnings read per branch, and the most bytes per learning. */
const MAX_LEARNINGS = 20;
const MAX_LEARNING_BYTES = 64 * 1024;

export interface PushedBranch {
  /** `origin/kumar/jitter-client`. */
  ref: string;
  /** First name of whoever made the branch's newest commit. */
  author: string;
  /** When that commit was made, epoch ms. */
  at: number;
  /** Files the branch changes since it left the default branch. */
  files: string[];
  /** Learning files the branch adds or changes, with their text. */
  learnings: Array<{ name: string; text: string }>;
}

/** Branch name → the commit its merged or closed pull request ended on. */
export type ClosedHeads = Record<string, string>;

export interface BranchCache {
  /** When the refresh finished, epoch ms. */
  fetchedAt: number;
  /** The clone's remote refs as they were then (refsStamp), so a push or fetch since is noticed. */
  stamp?: string;
  /** The default branch the others are compared with, e.g. `origin/main`; null when there's no remote. */
  base: string | null;
  branches: PushedBranch[];
  /** Branches whose pull request was merged or closed, from GitHub, kept for refreshes that don't ask it. */
  closed?: ClosedHeads;
  /** When a refresh is running, since when. */
  runningSince?: number;
}

function cachePath(repo: string): string {
  return join(cacheDir(repo), "trail-branches.json");
}

export function readBranchCache(repo: string): BranchCache | null {
  return readJson<BranchCache>(cachePath(repo));
}

function git(repo: string, args: string[], timeout = 15_000): string | null {
  try {
    // Never a credential prompt: this runs detached, where nobody could answer it.
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    return null;
  }
}

/** First word of a name, capitalised, the way a learning's author is written. Letters only, at most 40. */
function firstName(name: string): string {
  const first = (name.trim().split(/\s+/)[0] ?? "").replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 40);
  return first ? first[0]!.toUpperCase() + first.slice(1) : "";
}

/**
 * A branch name as it may appear in what the agent reads: the characters git
 * branch names are usually made of, at most 80. Branch names and authors come
 * from whoever pushed, so nothing else of theirs reaches an instruction.
 */
export function safeRef(ref: string): string {
  return ref.replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 80);
}

/** The remote branch everything is compared with: what origin/HEAD points at, else a usual name. */
function defaultRef(repo: string): string | null {
  const head = git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])?.trim();
  if (head) return head;
  for (const name of ["origin/main", "origin/master", "origin/trunk", "origin/dev"]) {
    if (git(repo, ["rev-parse", "--verify", "--quiet", name]) !== null) return name;
  }
  return null;
}

/**
 * Whether merging `ref` into `base` would change nothing: everything it does
 * is on `base` already, as after a squash merge. Needs git 2.38 for
 * `merge-tree --write-tree`; older git, or a merge that conflicts, says no.
 */
export function onBase(repo: string, base: string, ref: string): boolean {
  const merged = git(repo, ["merge-tree", "--write-tree", base, ref])?.split("\n")[0]?.trim();
  const baseTree = git(repo, ["rev-parse", `${base}^{tree}`])?.trim();
  return !!merged && merged === baseTree;
}

/**
 * Branches whose GitHub pull request was merged or closed, with the commit it
 * ended on, from `gh`. Null when origin isn't on GitHub, or gh is missing,
 * signed out or slow: then only `onBase` decides.
 */
function closedPrHeads(repo: string): ClosedHeads | null {
  const origin = git(repo, ["remote", "get-url", "origin"])?.trim() ?? "";
  if (!/github\.com[:/]/.test(origin)) return null;
  let out: string;
  try {
    out = execFileSync("gh", ["pr", "list", "--state", "all", "--limit", "200", "--json", "headRefName,headRefOid,state"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    return null;
  }
  try {
    const prs = JSON.parse(out) as Array<{ headRefName?: string; headRefOid?: string; state?: string }>;
    const open = new Set(prs.filter((p) => p.state === "OPEN").map((p) => p.headRefName));
    const closed: ClosedHeads = {};
    // Newest first, so a branch's latest pull request decides.
    for (const p of prs) {
      if (!p.headRefName || !p.headRefOid || open.has(p.headRefName) || p.headRefName in closed) continue;
      if (p.state === "MERGED" || p.state === "CLOSED") closed[p.headRefName] = p.headRefOid;
    }
    return closed;
  } catch {
    return null;
  }
}

/**
 * Fetch, then read every recently pushed branch: the files it changes and the
 * learnings it adds. Writes the cache and returns it. `fetch: false` reads
 * the refs already on this machine, for tests and for a repo that's offline.
 * `prs: true` also asks GitHub which pull requests closed, which only the
 * detached refresh does; everything else keeps what it last learned.
 * `closed` supplies that answer instead (tests).
 */
export function refreshBranches(
  repo: string,
  opts: { fetch?: boolean; now?: number; fetchTimeoutMs?: number; prs?: boolean; closed?: ClosedHeads } = {},
): BranchCache {
  const now = opts.now ?? Date.now();
  // TRAIL_NO_FETCH: tests, and anyone who'd rather fetch themselves.
  const online = opts.fetch !== false && !process.env.TRAIL_NO_FETCH;
  if (online) git(repo, ["fetch", "--quiet", "--prune", "origin"], opts.fetchTimeoutMs ?? 30_000);
  const closed = opts.closed ?? (online && opts.prs ? closedPrHeads(repo) : null) ?? readBranchCache(repo)?.closed ?? {};
  const base = defaultRef(repo);
  const branches: PushedBranch[] = [];
  if (base) {
    const listed = git(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:unix)%09%(authorname)%09%(objectname)", "refs/remotes/origin"]) ?? "";
    for (const line of listed.split("\n")) {
      if (branches.length >= MAX_BRANCHES) break;
      const [ref, unix, author, tip] = line.split("\t");
      if (!ref || ref === base || ref === "origin/HEAD" || ref === "origin") continue;
      // A name made only of what branch names are usually made of, or the branch is skipped:
      // it reaches what the agent reads, and a cleaned-up copy would name a different branch.
      if (safeRef(ref) !== ref) continue;
      const at = Number(unix) * 1000;
      if (!Number.isFinite(at) || now - at > BRANCH_WINDOW_MS) continue;
      // Its pull request closed on this very commit: merged or given up, either way not open work.
      if (tip && closed[ref.replace(/^origin\//, "")] === tip) continue;
      const changed = (git(repo, ["diff", "--name-only", `${base}...${ref}`]) ?? "").split("\n").map((f) => f.trim()).filter(Boolean);
      if (changed.length === 0 || onBase(repo, base, ref)) continue;
      const learnings: PushedBranch["learnings"] = [];
      // Only names trail itself would write: the name reaches a command the agent may run.
      const named = changed.filter((f) => f.startsWith(`${LEARNINGS_DIR}/`) && SAFE_LEARNING_NAME.test(f.slice(LEARNINGS_DIR.length + 1)));
      for (const path of named.slice(0, MAX_LEARNINGS)) {
        const text = git(repo, ["show", `${ref}:${path}`]);
        if (text && text.length <= MAX_LEARNING_BYTES) learnings.push({ name: path.slice(LEARNINGS_DIR.length + 1), text });
      }
      branches.push({ ref, author: firstName(author ?? ""), at, files: changed.slice(0, MAX_FILES), learnings });
    }
  }
  const cache: BranchCache = { fetchedAt: Date.now(), stamp: refsStamp(repo), base, branches, closed };
  writeJsonAtomic(cachePath(repo), cache, true);
  return cache;
}

/** The checkout's shared git dir: `.git`, or for a linked worktree the main one's. Read, never spawned. */
function commonGitDir(repo: string): string | null {
  const dot = join(repo, ".git");
  try {
    if (statSync(dot).isDirectory()) return dot;
    const line = readFileSync(dot, "utf8").split("\n").find((l) => l.startsWith("gitdir:"));
    const gitDir = line?.slice("gitdir:".length).trim();
    if (!gitDir) return null;
    try {
      return join(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
    } catch {
      return gitDir;
    }
  } catch {
    return null;
  }
}

/**
 * When this clone's idea of the remote last changed: the newest mtime under
 * `refs/remotes/`, `packed-refs` and `FETCH_HEAD`. A push updates the
 * remote-tracking ref it pushed, and a fetch rewrites FETCH_HEAD, so either
 * shows here without running git.
 */
export function refsStamp(repo: string): string {
  const dir = commonGitDir(repo);
  if (!dir) return "";
  let newest = 0;
  const walk = (p: string, depth: number) => {
    try {
      const st = statSync(p);
      newest = Math.max(newest, st.mtimeMs);
      if (st.isDirectory() && depth < 6) for (const e of readdirSync(p)) walk(join(p, e), depth + 1);
    } catch {
      /* gone, or never there */
    }
  };
  walk(join(dir, "refs", "remotes"), 0);
  for (const f of ["packed-refs", "FETCH_HEAD"]) walk(join(dir, f), 6);
  return String(Math.round(newest));
}

/** Whether the cache is older than `maxAgeMs`, or the clone's remote refs moved since it was written. */
export function branchesStale(repo: string, now = Date.now(), maxAgeMs = REFRESH_MS): boolean {
  const cache = readBranchCache(repo);
  return !cache || now - cache.fetchedAt >= maxAgeMs || cache.stamp !== refsStamp(repo);
}

/**
 * Refresh in a detached child when the cache is older than `maxAgeMs`, or
 * the clone's remote refs moved since (a push, a fetch), and no refresh is
 * already running. Never waits, never throws. A checkout with no origin gets
 * an empty cache.
 */
export function maybeRefreshBranches(repo: string, now = Date.now(), maxAgeMs = REFRESH_MS): boolean {
  try {
    const cache = readBranchCache(repo);
    if (!branchesStale(repo, now, maxAgeMs)) return false;
    if (cache?.runningSince && now - cache.runningSince < STALE_RUN_MS) return false;
    writeJsonAtomic(cachePath(repo), { ...(cache ?? { fetchedAt: 0, base: null, branches: [] }), runningSince: now }, true);
    const child = spawn(process.execPath, [graftCliPath(), "_trail-branches", repo], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface Overlap {
  ref: string;
  author: string;
  at: number;
  /** The files both changes touch. */
  shared: string[];
}

/**
 * Teammates' pushed branches that change any of `files`: work going on in the
 * same place, from someone other than `me`, newest first.
 */
export function overlapsWith(repo: string, files: string[], me: string, cache: BranchCache | null = readBranchCache(repo)): Overlap[] {
  if (!cache || files.length === 0) return [];
  const mine = new Set(files.filter((f) => !f.startsWith(".trail/")));
  const out: Overlap[] = [];
  for (const b of cache.branches) {
    if (!b.author || b.author === me) continue;
    const shared = b.files.filter((f) => mine.has(f));
    if (shared.length) out.push({ ref: b.ref, author: b.author, at: b.at, shared });
  }
  return out.sort((a, b) => b.at - a.at);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `today 14:20`, `Oct 7`: when a branch was pushed, short. */
export function pushedWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return `today ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** What starts every overlap line a person sees: `🔀 trail`. */
export function overlapMark(): string {
  return `🔀 ${brand()}`;
}

/** `🔀 trail · Kumar's branch kumar/jitter also changes client.go (pushed today 14:20)`. */
export function formatOverlap(o: Overlap, now = Date.now()): string {
  const branch = o.ref.replace(/^origin\//, "");
  const files = o.shared.length <= 2 ? o.shared.join(" and ") : `${o.shared.slice(0, 2).join(", ")} and ${o.shared.length - 2} more`;
  return `${overlapMark()} · ${o.author}'s branch ${branch} also changes ${files} (pushed ${pushedWhen(o.at, now)})`;
}
