/**
 * Where a repo's personal learnings and takeaways live: on this machine, under
 * `~/.trail/repos/<key>/`. (Learnings about the code itself go in the repo's
 * committed `.trail/`, see repo-trail.ts.) Nothing here shows up in
 * `git status` or in anyone's pull request, and nothing leaves the machine
 * unless its owner shares it.
 *
 * The key names the repo, not the folder it happens to be checked out in, so
 * every checkout of one repo reads and writes the same notes:
 *
 * - a linked worktree reads its main checkout's git config, so it gets the
 *   same key;
 * - a checkout with a remote is keyed by it (`github.com/nanonets/assign`),
 *   so a second clone somewhere else finds the same notes;
 * - a submodule, or any repo nested in another, is its own repo with its own
 *   key: the walk up stops at the nearest `.git`;
 * - a subfolder of a monorepo is part of its repo;
 * - a repo with no remote, and a folder outside git, are keyed by path.
 *
 * A folder outside git that holds repos (a workspace) has its own key for
 * notes written there, and reads its child repos' notes too.
 *
 * A key can change under a repo: a remote renamed, or added for the first
 * time. The first write under a new key looks for a folder already holding
 * notes for a repo with the same first commit, and points the new key at it
 * in `repos/index.json`, so the notes carry over instead of starting empty.
 *
 * Finding the key spawns no git, because hooks and the statusline call it on
 * every turn: it reads `.git` and the repo's config file directly. Only that
 * first write runs git, once, for the first commit.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { readBranchCache } from "./branches.js";
import { hasRepoTrail, learningFiles } from "./repo-trail.js";

/** `~/.trail`, or `$TRAIL_HOME`. */
export function trailHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.TRAIL_HOME ? resolve(env.TRAIL_HOME) : join(home, ".trail");
}

/** A path as people read it: `~/.trail/…` under the home folder, absolute otherwise. */
export function shownPath(p: string): string {
  if (!isAbsolute(p)) return p;
  const home = homedir();
  const rel = relative(home, p);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `~/${rel.split(sep).join("/")}` : p.split(sep).join("/");
}

/* -------------------------------------------------------------------------- */
/* reading git without git                                                    */
/* -------------------------------------------------------------------------- */

/** The nearest folder at or above `start` holding a `.git` (folder or file), or null outside git. */
export function checkoutRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

interface GitDirs {
  /** This checkout's own git dir. */
  gitDir: string;
  /** The one its config lives in: the main `.git` for a linked worktree, the same dir otherwise. */
  commonDir: string;
}

const GITDIR_KEY = "gitdir:";

/**
 * A checkout's git dirs, from its `.git`. A folder: a main checkout. A file
 * pointing at `<main>/.git/worktrees/<name>`: a linked worktree, whose
 * `commondir` leads back to the main `.git`. A file pointing anywhere else
 * (`<super>/.git/modules/<name>`): a submodule, which is a repo of its own.
 */
function gitDirs(checkout: string): GitDirs | null {
  const dot = join(checkout, ".git");
  try {
    if (statSync(dot).isDirectory()) return { gitDir: dot, commonDir: dot };
    // split/startsWith, not a regex: see mainWorktreeRoot in graph/seed.ts.
    const line = readFileSync(dot, "utf8").split("\n").find((l) => l.startsWith(GITDIR_KEY));
    const target = line?.slice(GITDIR_KEY.length).trim();
    if (!target) return null;
    const gitDir = isAbsolute(target) ? target : resolve(checkout, target);
    let commonDir = gitDir;
    try {
      const rel = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      if (rel) commonDir = isAbsolute(rel) ? rel : resolve(gitDir, rel);
    } catch {
      /* no commondir: a submodule, its own git dir */
    }
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

/** The main checkout behind a linked worktree; the checkout itself otherwise. */
function mainCheckout(checkout: string, dirs: GitDirs | null): string {
  if (!dirs || dirs.gitDir === dirs.commonDir) return checkout;
  if (basename(dirname(dirs.gitDir)) !== "worktrees" || basename(dirs.commonDir) !== ".git") return checkout;
  return dirname(dirs.commonDir);
}

/** origin's url from a git config file's text, else the first remote's, else null. */
export function remoteUrl(config: string): string | null {
  let section = "";
  let first: string | null = null;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    if (!section.startsWith('[remote "')) continue;
    const eq = line.indexOf("=");
    if (eq === -1 || line.slice(0, eq).trim().toLowerCase() !== "url") continue;
    const url = line.slice(eq + 1).trim();
    if (!url) continue;
    if (section === '[remote "origin"]') return url;
    first ??= url;
  }
  return first;
}

/** One path segment of a key: lowercase, safe as a folder name, never `.` or `..`. */
function segment(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^\.+$/.test(out) ? "" : out;
}

/**
 * `git@github.com:NanoNets/Graft.git`, `https://user:tok@github.com/NanoNets/Graft`
 * and `ssh://git@github.com:22/NanoNets/Graft.git` all → `github.com/nanonets/graft`.
 * Null for a remote that is a path on this machine: those are keyed by path.
 */
export function keyFromRemote(url: string): string | null {
  const s = url.trim();
  let host: string;
  let path: string;
  const scheme = s.indexOf("://");
  if (scheme !== -1) {
    if (s.slice(0, scheme).toLowerCase() === "file") return null;
    const rest = s.slice(scheme + 3);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    host = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else {
    const colon = s.indexOf(":");
    // No colon, or a Windows drive letter: a local path.
    if (colon <= 1 || s.slice(0, colon).includes("/")) return null;
    host = s.slice(0, colon);
    path = s.slice(colon + 1);
  }
  host = segment(host.slice(host.lastIndexOf("@") + 1).replace(/:\d*$/, ""));
  const parts = path
    .replace(/\.git\/?$/i, "")
    .split("/")
    .map(segment)
    .filter(Boolean);
  if (!host || parts.length === 0) return null;
  return [host, ...parts].join("/");
}

/** `local/Users-priya-src-extract`: the key for a repo with no remote, or a folder outside git. */
function pathKey(dir: string): string {
  return `local/${segment(resolve(dir)) || "root"}`;
}

/* -------------------------------------------------------------------------- */
/* the place                                                                  */
/* -------------------------------------------------------------------------- */

export interface RepoPlace {
  /** The top of the checkout the folder is in (a worktree's own top), or the folder itself outside git. */
  checkout: string;
  /** Inside a git checkout. */
  git: boolean;
  /** `github.com/nanonets/assign`, or `local/…`. */
  key: string;
  /** `<trail home>/repos/<key>`: where this repo's notes and takeaways are. */
  dir: string;
}

interface Index {
  /** A key that changed, to the one whose folder has the notes. */
  aliases: Record<string, string>;
  /** A repo's first commit, to the key whose folder has its notes. */
  roots: Record<string, string>;
}

function indexPath(home: string): string {
  return join(home, "repos", "index.json");
}

function readIndex(home: string): Index {
  const raw = readJson<Partial<Index>>(indexPath(home));
  return { aliases: raw?.aliases ?? {}, roots: raw?.roots ?? {} };
}

function keyDir(home: string, key: string): string {
  return join(home, "repos", ...key.split("/"));
}

/** Where the notes for the folder `start` live. Reads only; spawns nothing. */
export function repoPlace(start: string, env: NodeJS.ProcessEnv = process.env): RepoPlace {
  const home = trailHome(env);
  const top = checkoutRoot(start);
  const dirs = top ? gitDirs(top) : null;
  let url: string | null = null;
  if (dirs) {
    try {
      url = remoteUrl(readFileSync(join(dirs.commonDir, "config"), "utf8"));
    } catch {
      /* no config: keyed by path */
    }
  }
  const checkout = top ?? resolve(start);
  const fresh = (url && keyFromRemote(url)) || pathKey(top ? mainCheckout(top, dirs) : checkout);
  const key = existsSync(keyDir(home, fresh)) ? fresh : (readIndex(home).aliases[fresh] ?? fresh);
  return { checkout, git: top !== null, key, dir: keyDir(home, key) };
}

/** A repo's first commits (more than one after merging unrelated histories), sorted; [] without git or commits. */
function rootCommits(checkout: string): string[] {
  try {
    const out = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.split("\n").map((l) => l.trim()).filter(Boolean).sort();
  } catch {
    return [];
  }
}

/**
 * When `place`'s key has no folder yet but a repo with the same first commit
 * does (its remote was renamed, or added after its first notes), point the
 * key at that folder and return the place there. Runs git once, and only on a
 * machine that already keeps notes for some repo; otherwise `place` as it was.
 */
function followMovedRepo(home: string, place: RepoPlace, index: Index, roots: string[]): RepoPlace {
  if (existsSync(place.dir)) return place;
  const known = roots.map((r) => index.roots[r]).find((k): k is string => !!k && k !== place.key && existsSync(keyDir(home, k)));
  if (!known) return place;
  index.aliases[place.key] = known;
  return { ...place, key: known, dir: keyDir(home, known) };
}

/**
 * Where the notes for `start` are, following a repo whose key changed since
 * they were written. For reads that can afford one git call (`ask`, not the
 * statusline); a machine with no notes anywhere never spawns it.
 */
export function findRepoPlace(start: string, env: NodeJS.ProcessEnv = process.env): RepoPlace {
  const place = repoPlace(start, env);
  if (existsSync(place.dir) || !place.git) return place;
  const home = trailHome(env);
  const index = readIndex(home);
  if (Object.keys(index.roots).length === 0) return place;
  const moved = followMovedRepo(home, place, index, rootCommits(place.checkout));
  if (moved !== place) writeJsonAtomic(indexPath(home), index);
  return moved;
}

export const HOME_README = `# ~/.trail

What Trail keeps on this machine. Learnings about the code are in each
repo's own .trail/learnings/, committed with the code; this folder holds
the rest, and none of it leaves this machine unless you share it.

- repos/<repo>/notes/    personal learnings: about your setup or habits,
                         not the code
- repos/<repo>/skills/   corrections you taught your agent, per skill
- repos/known.json       the repos Trail has run in, which is the list a
                         workspace's repo picker shows
- cloud.json             your Trail workspace, once you've connected one

<repo> is the repo's remote (github.com/owner/name), so every clone and
worktree of one repo shares its notes. Repos without a remote are under
local/, by path.
`;

/**
 * Make the folder for `start`'s repo, and return where it is. A repo seen for
 * the first time under this key, whose first commit already has a folder (a
 * renamed remote, a remote added later), is pointed at that folder.
 */
export function ensureRepoHome(start: string, env: NodeJS.ProcessEnv = process.env): { place: RepoPlace; created: boolean } {
  const home = trailHome(env);
  const index = readIndex(home);
  const before = JSON.stringify(index);
  const fresh = repoPlace(start, env);
  const roots = fresh.git ? rootCommits(fresh.checkout) : [];
  const place = followMovedRepo(home, fresh, index, roots);
  for (const r of roots) index.roots[r] ??= place.key;
  const created = !existsSync(place.dir);
  mkdirSync(join(place.dir, "notes"), { recursive: true });
  const readme = join(home, "README.md");
  if (!existsSync(readme)) writeFileSync(readme, HOME_README);
  if (JSON.stringify(index) !== before) writeJsonAtomic(indexPath(home), index);
  rememberRepo(start, env);
  return { place, created };
}

/**
 * This machine's uploader id: random, made once, kept in `~/.trail/id`. Trail
 * keys each person's uploaded notes by it, so one person's upload replaces
 * their own notes and never a teammate's. It names no one.
 */
export function uploaderId(env: NodeJS.ProcessEnv = process.env): string {
  const file = join(trailHome(env), "id");
  try {
    const id = readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {
    /* first time */
  }
  const id = randomUUID();
  mkdirSync(trailHome(env), { recursive: true });
  writeFileSync(file, `${id}\n`);
  return id;
}

/* -------------------------------------------------------------------------- */
/* a folder, and the repos under it                                           */
/* -------------------------------------------------------------------------- */

/** Most repos a workspace folder reads notes from. */
const MAX_CHILDREN = 64;

/** The git checkouts directly inside a folder that isn't one: a workspace's repos. */
export function childCheckouts(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return names
    .map((n) => join(dir, n))
    .filter((d) => existsSync(join(d, ".git")))
    .slice(0, MAX_CHILDREN);
}

/**
 * Every place whose notes bear on the folder `dir`: its repo's, or, for a
 * folder outside git, its own and each child repo's. One per key, so two
 * worktrees of one repo side by side don't list its notes twice.
 */
export function notePlaces(dir: string, env: NodeJS.ProcessEnv = process.env): RepoPlace[] {
  const here = repoPlace(dir, env);
  const places = [here, ...(here.git ? [] : childCheckouts(here.checkout).map((c) => repoPlace(c, env)))];
  const seen = new Set<string>();
  return places.filter((p) => !seen.has(p.key) && seen.add(p.key));
}

/** This repo keeps learnings: it has a committed `.trail/`, or `trail init` or a first learning made its folder in ~/.trail. */
export function keepsNotes(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return notePlaces(dir, env).some((p) => existsSync(p.dir) || (p.git && hasRepoTrail(p.checkout)));
}

/**
 * How many learnings bear on `dir`, counted without reading them: the repo's
 * `.trail/learnings/`, this machine's own, and the ones on teammates' pushed
 * branches, one per file name. Spawns nothing: the statusline calls it.
 */
export function noteCount(dir: string, env: NodeJS.ProcessEnv = process.env): number {
  const names = new Set<string>();
  for (const p of notePlaces(dir, env)) {
    if (p.git) for (const f of learningFiles(p.checkout)) names.add(f);
    try {
      for (const f of readdirSync(join(p.dir, "notes"))) if (f.endsWith(".md")) names.add(f);
    } catch {
      /* none */
    }
    if (p.git) for (const b of readBranchCache(p.checkout)?.branches ?? []) for (const l of b.learnings) names.add(l.name);
  }
  return names.size;
}

/* -------------------------------------------------------------------------- */
/* the repos Trail has run in                                                 */
/* -------------------------------------------------------------------------- */

export interface KnownRepo {
  /** `github.com/hashicorp/go-retryablehttp`: the key notes are kept under. */
  key: string;
  /** `hashicorp/go-retryablehttp`: how people name it. */
  name: string;
  /** The checkout it was last seen in, on this machine. */
  path: string;
  /** When, epoch ms. */
  seenAt: number;
}

function knownPath(home: string): string {
  return join(home, "repos", "known.json");
}

/** `github.com/hashicorp/go-retryablehttp` → `hashicorp/go-retryablehttp`; a local key → its folder's name. */
export function repoName(key: string, checkout?: string): string {
  if (key.startsWith("local/")) return basename(checkout ?? key);
  const parts = key.split("/");
  return parts.length > 2 ? parts.slice(1).join("/") : key;
}

/**
 * Every repo Trail has run in on this machine, most recent first. This is the
 * list a workspace's repo picker shows: Trail never searches the disk for repos.
 */
export function knownRepos(env: NodeJS.ProcessEnv = process.env): KnownRepo[] {
  const raw = readJson<Record<string, Omit<KnownRepo, "key">>>(knownPath(trailHome(env))) ?? {};
  return Object.entries(raw)
    .map(([key, r]) => ({ key, name: r.name, path: r.path, seenAt: r.seenAt }))
    .sort((a, b) => b.seenAt - a.seenAt);
}

/** How long a sighting stays fresh before `rememberRepo` writes again. */
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Note that Trail ran in the repo at `dir`. Cheap enough for every command:
 * it writes only for a repo that's new, moved, or not seen for a day.
 */
export function rememberRepo(dir: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
  try {
    const place = repoPlace(dir, env);
    if (!place.git) return;
    const file = knownPath(trailHome(env));
    const all = readJson<Record<string, Omit<KnownRepo, "key">>>(file) ?? {};
    const prior = all[place.key];
    if (prior && prior.path === place.checkout && now - prior.seenAt < SEEN_TTL_MS) return;
    all[place.key] = { name: repoName(place.key, place.checkout), path: place.checkout, seenAt: now };
    writeJsonAtomic(file, all);
  } catch {
    /* a missed sighting only shortens the picker's list */
  }
}
