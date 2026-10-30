/**
 * Which past Claude Code sessions are a repo's: the input to `trail init`'s
 * look-back.
 *
 * Claude Code keeps each session in `~/.claude/projects/<folder>/<id>.jsonl`,
 * the folder named after where the session started. A repo's sessions are:
 * - its own: started in the checkout or a folder under it;
 * - its worktrees': started in any worktree git still lists;
 * - other clones': started in another checkout whose remote is the same repo
 *   (the key `repoPlace` gives every checkout of one remote);
 * - sessions started in a folder above any of those (`~/work`, the home
 *   folder) that then worked in the repo: kept when 30% or more of their tool
 *   calls touched it, and only the stretch from the ask that led there to the
 *   last call in it.
 *
 * A file's own `cwd` decides, never the folder's name alone: Claude Code has
 * named folders more than one way, and a sibling (`api-old`) shares a prefix.
 * Counts are session-days: a months-long session typed into on 30 days is 30,
 * two restarts on one morning are two sessions on one day.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { checkoutRoot, remoteKey, repoPlace } from "../notes/home.js";
import { claudeProjectDir } from "../notes/session-cost.js";
import { openPlain } from "./plain-file.js";
import { dayOf, firstCwd, scanTranscript, sessionOf, type PastSession, type SessionSource } from "./transcript.js";

export { ownWords, readSession, type PastPrompt, type PastSession, type SessionSource } from "./transcript.js";

/** Share of an above-the-repo session's tool calls that must be in the repo for it to count. */
export const ANCESTOR_SHARE = 0.3;
/** A transcript last written longer ago than this is not read (design 4.1). */
export const TOO_OLD_DAYS = 400;

/** Why discovery left a transcript out (design 4.1, `LookBack.skipped`). */
export type SkipWhy = "headless" | "ancestor-under-30" | "unreadable" | "too-old" | "scratch";

/**
 * A scratch folder (/tmp, the OS temp folder, /var/folders, a `/scratchpad/` segment), as 1a's skills gate
 * reads one, unless the checkout itself is in one: then its own sessions are its own.
 */
function scratch(cwd: string, top: string): boolean {
  // Windows paths ignore case (c:\ and C:\ are one folder) and resolve() gives them '\'.
  const fold = (x: string) => (process.platform === "win32" ? x.toLowerCase() : x);
  const pad = (path: string) => `${fold(resolve(path))}${sep}`.includes(`${sep}scratchpad${sep}`);
  const isScratch = (path: string) => {
    const p = fold(resolve(path));
    if (pad(path)) return true;
    const roots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map((r) => fold(resolve(r)));
    return roots.some((r) => p === r || p.startsWith(r + sep));
  };
  if (pad(cwd) && !pad(top)) return true;
  return isScratch(cwd) && !isScratch(top);
}

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : "";
}

/**
 * The checkout `repo` belongs to and every worktree of it git still lists:
 * sessions run in any of them, or in a folder under one, are this repo's.
 * Worktrees git has forgotten were usually under the main checkout
 * (`.claude/worktrees/…`), so their sessions are still found under it.
 */
export function repoRoots(repo: string): string[] {
  const roots = new Set<string>([resolve(repo)]);
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common && basename(common) === ".git") roots.add(dirname(common));
  for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) roots.add(resolve(line.slice("worktree ".length)));
  }
  return [...roots];
}

/**
 * {@link repoRoots}, plus every other checkout on this machine whose remote is
 * the same repo: a fresh clone at `~/trail-demo/me` of github.com/acme/api
 * finds the sessions and Claude memory of `~/src/api`. Claude Code keeps each
 * project's folder under ~/.claude/projects; each folder's first transcript
 * says where it ran, and that folder's git config names its remote (#662).
 */
export function sameRepoRoots(repo: string, home: string = homedir()): string[] {
  const roots = new Set(repoRoots(repo));
  const mine = remoteKey(repo)?.key;
  if (!mine) return [...roots];
  const projects = join(home, ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return [...roots];
  }
  const seen = new Set<string>();
  for (const d of dirs) {
    let first: string | undefined;
    try {
      first = readdirSync(join(projects, d)).find((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const cwd = first ? firstCwd(join(projects, d, first)) : null;
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    const found = existsSync(cwd) ? remoteKey(cwd) : null;
    if (found?.key === mine) roots.add(found.checkout);
  }
  return [...roots];
}

/** Whether `path` is one of `roots` or inside one. */
export function within(path: string, roots: string[]): boolean {
  // On Windows a transcript's cwd says C:\a\b while git's worktree list says C:/a/b, and case doesn't matter.
  const norm = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p);
  const p = norm(path);
  return roots.some((root) => {
    const r = norm(root);
    return p === r || p.startsWith(r + sep) || p.startsWith(r + "/");
  });
}

/** Whether `dir` is a folder strictly above `path`. */
function above(dir: string, path: string): boolean {
  return !!dir && dir !== path && within(path, [dir]);
}

/**
 * Transcript files for sessions run inside `roots`, by folder name and then
 * each file's own `cwd`. Kept for callers that only know roots;
 * `discoverSessions` is what init uses.
 */
export function sessionFiles(roots: string[], home: string = homedir()): string[] {
  const prefixes = roots.map((r) => basename(claudeProjectDir(r, home)));
  return transcriptFiles(home).filter(({ folder, path }) => {
    if (!prefixes.some((p) => folder === p || folder.startsWith(p + "-"))) return false;
    const cwd = firstCwd(path);
    return !!cwd && within(cwd, roots);
  }).map((f) => f.path);
}

/**
 * Every top-level transcript under `~/.claude/projects`, with its size and mtime (0 when it can't be read). A
 * project folder or a transcript that is a link is left out (b5 review): it can bring in a file from anywhere,
 * another person's sessions among them, and init takes them as the person's words. So is anything not a plain file.
 */
function transcriptFiles(home: string): { folder: string; path: string; size: number; mtimeMs: number; readable: boolean }[] {
  const projects = join(home, ".claude", "projects");
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    return [];
  }
  const out: { folder: string; path: string; size: number; mtimeMs: number; readable: boolean }[] = [];
  for (const folder of folders.sort()) {
    let names: string[];
    try {
      if (!lstatSync(join(projects, folder)).isDirectory()) continue;
      names = readdirSync(join(projects, folder)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const path = join(projects, folder, name);
      let size = 0;
      let mtimeMs = 0;
      let readable = false;
      try {
        const st = lstatSync(path);
        if (!st.isFile()) continue;
        size = st.size;
        mtimeMs = st.mtimeMs;
        closeSync(openPlain(path));
        readable = true;
      } catch {
        /* listed, but not readable */
      }
      out.push({ folder, path, size, mtimeMs, readable });
    }
  }
  return out;
}

/**
 * A test for "is this path in a checkout of the repo": inside a known root,
 * or in a checkout whose remote key is the repo's (a clone or worktree found
 * only through the path). Answers are cached per folder.
 */
function repoTest(roots: string[], key: string | null, env: NodeJS.ProcessEnv): { has: (path: string) => boolean; roots: string[] } {
  const known = [...roots];
  const seen = new Map<string, boolean>();
  const has = (path: string): boolean => {
    if (!path || !isAbsolute(path)) return false;
    if (within(path, known)) return true;
    if (!key) return false;
    const top = checkoutRoot(path);
    if (!top) return false;
    let same = seen.get(top);
    if (same === undefined) {
      same = repoPlace(top, env).key === key;
      seen.set(top, same);
      if (same) known.push(top);
    }
    return same;
  };
  return { has, roots: known };
}

const PATH_FIELDS = ["file_path", "path", "notebook_path"];

/** Absolute paths a shell command names: quoted ones (spaces kept), bare ones, and `cd` targets resolved against `cwd`. */
export function commandPaths(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)) out.push((m[1] ?? m[2])!);
  for (const t of command.replace(/"[^"\n]*"|'[^'\n]*'/g, " ").split(/[\s;&|()<>=`]+/)) if (t) out.push(t);
  for (const m of command.matchAll(/\bcd\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|)]+))/g)) {
    const target = (m[1] ?? m[2] ?? m[3])!;
    if (cwd && !isAbsolute(target) && !target.startsWith("~") && !target.startsWith("$")) out.push(resolve(cwd, target));
  }
  return out.filter((p) => isAbsolute(p));
}

/** Whether one tool call worked in the repo: its cwd, a path field, or a path its command names. */
function callTouches(has: (path: string) => boolean): (cwd: string, name: string, input: unknown) => boolean {
  return (cwd, _name, input) => {
    if (has(cwd)) return true;
    if (!input || typeof input !== "object") return false;
    const fields = input as Record<string, unknown>;
    for (const f of PATH_FIELDS) {
      const v = fields[f];
      if (typeof v === "string" && v && has(isAbsolute(v) ? v : cwd ? resolve(cwd, v) : v)) return true;
    }
    const command = fields.command;
    return typeof command === "string" && commandPaths(command, cwd).some(has);
  };
}

/** What discovery found, for init to read and to say. */
export interface Discovery {
  /** Sessions with something the person typed, newest first. */
  sessions: PastSession[];
  bySource: Record<SessionSource, number>;
  /** Sessions started in a folder above the repo that left out for spending under 30% of their tool calls in it. */
  skippedAncestor: number;
  /** One per session per day it was typed into. */
  sessionDays: number;
  /** Different days, across all sessions. */
  days: number;
  /** YYYY-MM-DD of the first and last of them. */
  from?: string;
  to?: string;
  /** Transcripts left out, and why (design 4.1). */
  skipped?: Array<{ path: string; why: SkipWhy }>;
}


/**
 * Every past session that is the repo's (see the top of this file), each with its transcript path and the byte
 * range its repo work is in (`stretch`), and what was left out and why: files last written over 400 days before
 * `now`, sessions in a scratch folder, headless runs, ancestor sessions under the share, files that can't be
 * read. Reads only; never throws.
 */
export function discoverSessions(repo: string, home: string = homedir(), now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Discovery {
  const found: Discovery = { sessions: [], bySource: { own: 0, worktree: 0, clone: 0, ancestor: 0 }, skippedAncestor: 0, sessionDays: 0, days: 0, skipped: [] };
  const skip = (path: string, why: SkipWhy) => found.skipped!.push({ path, why });
  try {
    const top = checkoutRoot(repo) ?? resolve(repo);
    // b7 review: the repo keys under the Trail home the caller has (a test's or the lab's), never process.env's.
    const place = repoPlace(repo, env);
    const key = place.git && !place.key.startsWith("local/") ? place.key : null;
    const worktrees = repoRoots(repo).filter((r) => r !== top);
    const repoHas = repoTest([top, ...worktrees], key, env);
    const sourceOf = (cwd: string): SessionSource | null => {
      if (!cwd) return null;
      if (within(cwd, [top])) return "own";
      if (within(cwd, worktrees)) return "worktree";
      return key && repoHas.has(cwd) ? "clone" : null;
    };
    const ownFolders = [top, ...worktrees].map((r) => basename(claudeProjectDir(r, home)));
    const oldest = now.getTime() - TOO_OLD_DAYS * 86_400_000;
    const files: Array<ReturnType<typeof transcriptFiles>[number] & { cwd: string }> = [];
    for (const f of transcriptFiles(home)) {
      if (!f.readable) {
        // Only a file in one of the repo's own folders is worth saying: anything else may not be this repo's.
        if (ownFolders.some((p) => f.folder === p || f.folder.startsWith(p + "-"))) skip(f.path, "unreadable");
        continue;
      }
      files.push({ ...f, cwd: firstCwd(f.path) ?? "" });
    }

    const seen = new Set<string>();
    const keep = (s: PastSession | null, source: SessionSource, stretch: { from: number; to: number }) => {
      if (!s || seen.has(s.id)) return;
      seen.add(s.id);
      found.sessions.push({ ...s, source, stretch });
      found.bySource[source]++;
    };
    /** Too old or in a scratch folder: said once, never read. */
    const leftOut = (f: (typeof files)[number]): boolean => {
      if (f.mtimeMs && f.mtimeMs < oldest) {
        skip(f.path, "too-old");
        return true;
      }
      if (scratch(f.cwd, top)) {
        skip(f.path, "scratch");
        return true;
      }
      return false;
    };
    const later: typeof files = [];
    for (const f of files) {
      const source = sourceOf(f.cwd);
      if (source) {
        if (leftOut(f)) continue;
        const scan = scanTranscript(f.path, undefined, env);
        if (scan.headless) skip(f.path, "headless");
        else keep(sessionOf(f.path, scan), source, { from: 0, to: f.size });
      } else if (f.cwd) later.push(f);
    }
    // Started above the repo (or above a clone of it): only the in-repo stretch, and only past the share.
    const touches = callTouches(repoHas.has);
    for (const f of later) {
      if (!repoHas.roots.some((r) => above(f.cwd, r))) continue;
      if (leftOut(f)) continue;
      const scan = scanTranscript(f.path, touches, env);
      if (scan.headless) {
        skip(f.path, "headless");
        continue;
      }
      const inRepo = scan.calls.filter((c) => c.inRepo);
      if (!scan.prompts.length) continue;
      if (!scan.calls.length || inRepo.length / scan.calls.length < ANCESTOR_SHARE) {
        found.skippedAncestor++;
        skip(f.path, "ancestor-under-30");
        continue;
      }
      const first = inRepo[0]!;
      const last = inRepo[inRepo.length - 1]!;
      const ask = [...scan.prompts].reverse().find((p) => p.i < first.i);
      const from = ask ? ask.i : first.i;
      // The stretch: from the ask that led into the repo to the line after its last call there (its result and
      // the reply that follows belong to it), or the end of the file.
      const next = [...scan.prompts, ...scan.calls].filter((x) => x.i > last.i && x.o > last.o).reduce((m, x) => Math.min(m, x.o), f.size);
      keep(sessionOf(f.path, scan, scan.prompts.filter((p) => p.i >= from && p.i <= last.i)), "ancestor", { from: ask ? ask.o : first.o, to: next });
    }

    found.sessions.sort((a, b) => b.at.localeCompare(a.at));
    const all = new Set<string>();
    for (const s of found.sessions) {
      const days = new Set(s.prompts.map((p) => dayOf(p.at ?? s.at)).filter(Boolean));
      if (!days.size && dayOf(s.at)) days.add(dayOf(s.at));
      found.sessionDays += days.size;
      for (const d of days) all.add(d);
    }
    const sorted = [...all].sort();
    found.days = sorted.length;
    if (sorted.length) {
      found.from = sorted[0];
      found.to = sorted[sorted.length - 1];
    }
  } catch {
    /* discovery never stops init */
  }
  return found;
}

/** Every past session of the repo with something the person wrote, newest first. */
export function pastSessions(repo: string, home?: string): PastSession[] {
  return discoverSessions(repo, home).sessions;
}
