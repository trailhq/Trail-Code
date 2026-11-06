/**
 * Who to tag on a pull request: the people whose fingerprints are on the areas
 * this diff changes or can affect.
 *
 * The blast report already answers "what does this reach"; the author's next
 * question is "who do I ask about it", and git has the answer without a single
 * API call. One `git log` per area over that area's OWN files, scored by recency,
 * ranked, capped.
 *
 * Two rules keep the output honest, and both exist because a wrong name here is
 * worse than no name:
 *
 *  - A handle is only ever printed when git actually carries one (the GitHub
 *    noreply address, which anything merged through the web UI has). With no
 *    handle the display name is printed unlinked — a guessed `@mention` pings a
 *    stranger, and there is no cheap way to verify a guess.
 *  - An owner has to hold {@link MIN_SHARE} of an area's weight to be named. That
 *    drops a drive-by typo fix next to a real owner, and keeps it when the
 *    drive-by is all the history there is.
 *
 * Everything here is best-effort: no git, no repository, a detached tarball
 * checkout or a shallow clone leaves the report exactly as it was and the comment
 * simply says nothing about people.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { BlastReport } from "./blast.js";

/** One person's claim on one area. */
export interface Owner {
  /** Display name as git reports it, with `.mailmap` already applied. */
  name: string;
  /** GitHub handle, when the commit email carries one. Never guessed. */
  handle?: string;
  /** Commits of theirs that touched this area's files. */
  commits: number;
  /** Recency-weighted weight of those commits — the ranking key. */
  score: number;
  /** Their most recent commit here, ms since the epoch. */
  last: number;
}

/** One person's claim across the whole report: what the tag line prints. */
export interface Reviewer extends Owner {
  /** Area labels they own, heaviest first. */
  areas: string[];
}

export interface OwnerOptions {
  /** Logins, names or emails to drop — the PR author, so they are not told to
   * tag themselves. Matched case-insensitively against all three. */
  exclude?: string[];
  /** Clock, so a test can plant history at a fixed distance from "now". */
  now?: number;
}

/**
 * Recency half-life. A commit from four months ago counts half as much as one
 * from today, so the person who rewrote a module last month outranks the person
 * who created it two years ago and moved on — which is the reviewer an author
 * actually wants.
 */
const HALF_LIFE_MS = 120 * 24 * 60 * 60 * 1000;

/**
 * History window and commit cap, per area.
 *
 * Both are bounds on the walk, not on the answer: at 36 months a commit is worth
 * 0.002 of a fresh one, so nothing outside the window could survive the share
 * floor anyway, and the pair keeps one `git log` off a large repo's full history.
 */
const SINCE = "36.months";
const MAX_COMMITS = 400;

/** Files passed to one `git log`. A very wide area is sampled rather than blowing
 * the argument list; the sample is the area's own sorted file list, so it is
 * stable between runs rather than whichever files git happened to yield. */
const MAX_PATHSPEC = 80;

/** Share of an area's total weight an owner must hold to be named. */
const MIN_SHARE = 0.15;

/** Names listed per area, and in the tag line. */
export const MAX_PER_AREA = 2;
export const MAX_REVIEWERS = 3;

/**
 * Weight of an area a diff only *reaches*, against one it edits.
 *
 * Not zero, because the person whose code your change can break is exactly the
 * reviewer the diff alone would never surface — that is what the blast radius is
 * for. Not one either: the author of the code you edited knows it better.
 */
const AFFECTED_WEIGHT = 0.6;

/**
 * A GitHub handle out of a commit email, or null.
 *
 * Both noreply forms are accepted: the modern `12345+name@` and the legacy bare
 * `name@`. The character class is GitHub's own username rule (alphanumerics and
 * interior hyphens, 39 max) so an address that merely ends in the right domain
 * cannot smuggle something unmentionable into a comment body.
 */
export function githubHandle(email: string): string | null {
  const m = /^(?:\d+\+)?([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})@users\.noreply\.github\.com$/i.exec(email.trim());
  return m ? m[1] : null;
}

/** Bots write commits and are never reviewers. */
function isBot(name: string, email: string): boolean {
  return /\[bot\]/i.test(name) || /\[bot\]@/i.test(email) || /^(github-actions|dependabot|renovate)(\[bot\])?$/i.test(name.trim());
}

/** Run git in `root`, or null when git fails — not a repo, no git, no history. */
function git(root: string, args: string[]): string | null {
  const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
  return res.stdout;
}

/**
 * The people behind `files`, best first.
 *
 * `--no-merges` because a merge commit's author is whoever pressed the button,
 * not whoever wrote the code. `%aN`/`%aE` rather than `%an`/`%ae` so git applies
 * the repository's `.mailmap` for us — which is the supported way to give a
 * contributor whose work address has no handle a noreply one, at no new config
 * cost to graft.
 */
export function ownersFor(root: string, files: string[], opts: OwnerOptions = {}): Owner[] {
  const paths = [...files].sort().slice(0, MAX_PATHSPEC);
  if (paths.length === 0) return [];

  const now = opts.now ?? Date.now();
  const out = git(resolve(root), [
    "log",
    "--no-merges",
    `--since=${SINCE}`,
    "-n",
    String(MAX_COMMITS),
    "--format=\x01%H\x02%aI\x02%aN\x02%aE",
    "--name-only",
    "--",
    ...paths,
  ]);
  if (out === null) return [];

  const wanted = new Set(paths);
  const people = new Map<string, Owner & { seen: Set<string> }>();
  let commit: { hash: string; at: number; weight: number; name: string; email: string } | null = null;

  for (const line of out.split("\n")) {
    if (line.startsWith("\x01")) {
      const [hash, iso, name, email] = line.slice(1).split("\x02");
      const at = Date.parse(iso ?? "");
      commit = Number.isFinite(at)
        ? { hash, at, weight: Math.pow(0.5, (now - at) / HALF_LIFE_MS), name: name ?? "", email: email ?? "" }
        : null;
      continue;
    }
    // A pathspec'd `git log --name-only` already lists only matching files, but
    // the set is re-checked here so a future flag change cannot silently start
    // crediting whoever touched an unrelated file in the same commit.
    if (commit === null || !wanted.has(line)) continue;
    if (isBot(commit.name, commit.email)) continue;

    const handle = githubHandle(commit.email) ?? undefined;
    const key = (handle ?? commit.email).toLowerCase();
    const prev = people.get(key);
    if (!prev) {
      people.set(key, {
        name: commit.name, handle, commits: 1, score: commit.weight, last: commit.at,
        seen: new Set([commit.hash]),
      });
      continue;
    }
    // One commit touching six files in the area is one commit, not six.
    if (prev.seen.has(commit.hash)) continue;
    prev.seen.add(commit.hash);
    prev.commits += 1;
    prev.score += commit.weight;
    prev.last = Math.max(prev.last, commit.at);
  }

  const excluded = new Set((opts.exclude ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const isExcluded = (o: Owner, email: string) =>
    excluded.has(email.toLowerCase()) ||
    excluded.has(o.name.toLowerCase()) ||
    (o.handle !== undefined && excluded.has(o.handle.toLowerCase()));

  const kept = [...people].filter(([email, o]) => !isExcluded(o, email)).map(([, o]) => o);
  // The floor is a SHARE of what is left after the author is dropped, not of the
  // whole area. On a repo where one person wrote everything, their own PR would
  // otherwise leave every remaining contributor under the floor and report nobody.
  const total = kept.reduce((n, o) => n + o.score, 0);
  return kept
    .filter((o) => total === 0 || o.score / total >= MIN_SHARE)
    .sort((a, b) => b.score - a.score || b.commits - a.commits || a.name.localeCompare(b.name))
    .slice(0, MAX_PER_AREA)
    .map(({ name, handle, commits, score, last }) => ({ name, handle, commits, score, last }));
}

/**
 * Everyone who authored a commit in `base...HEAD` — the people whose work this
 * pull request IS.
 *
 * This is the exclusion that actually fires in CI. The obvious source for "who
 * opened this" is `pull_request.user.email` from the webhook, but GitHub almost
 * never populates it, so excluding on the login alone leaves anyone whose commits
 * carry a work address being suggested as a reviewer of their own PR. The commits
 * in the range carry exactly the name and email git will match on later.
 *
 * Co-authors count too: a pair-programmed commit has two people on it and neither
 * of them is a reviewer of it.
 */
export function diffAuthors(root: string, base: string): string[] {
  const out = git(resolve(root), ["log", "--format=%aN%n%aE%n%(trailers:key=Co-authored-by,valueonly)", `${base}...HEAD`]);
  if (out === null) return [];
  const names = new Set<string>();
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    // A co-author trailer is `Name <email>`; both halves are worth excluding.
    const m = /^(.*?)\s*<([^>]+)>$/.exec(line);
    if (m) {
      if (m[1]) names.add(m[1]);
      names.add(m[2]);
      continue;
    }
    names.add(line);
  }
  return [...names];
}

/**
 * Whoever git would sign a commit as, here and now.
 *
 * The local counterpart of {@link diffAuthors}. `graft blast` with no `--base`
 * compares the working tree against HEAD, so there is no commit range to read
 * authors from — and without this, the one person guaranteed to have written the
 * change being examined is also the top name in its own "who to tag" list.
 */
export function localIdentity(root: string): string[] {
  const dir = resolve(root);
  const out = [git(dir, ["config", "user.name"]), git(dir, ["config", "user.email"])];
  return out.map((v) => v?.trim() ?? "").filter((v) => v !== "");
}

/**
 * Fill in `owners` on every area and module, and rank the report's `reviewers`.
 *
 * Called AFTER `--name`, because a reviewer's reason cites area labels and the
 * naming pass is what gives an area its final label.
 */
export function attachOwners(root: string, report: BlastReport, opts: OwnerOptions = {}): void {
  const ranked = new Map<string, Reviewer & { weighted: number }>();

  const visit = (label: string, files: string[], weight: number): Owner[] => {
    const owners = ownersFor(root, files, opts);
    for (const o of owners) {
      const key = (o.handle ?? o.name).toLowerCase();
      const prev = ranked.get(key);
      if (!prev) {
        ranked.set(key, { ...o, areas: [label], weighted: o.score * weight });
        continue;
      }
      prev.areas.push(label);
      prev.commits += o.commits;
      prev.score += o.score;
      prev.weighted += o.score * weight;
      prev.last = Math.max(prev.last, o.last);
      // A handle found on any one area is the handle: a contributor who has some
      // commits from the web UI and some from a laptop should still be taggable.
      if (prev.handle === undefined && o.handle !== undefined) prev.handle = o.handle;
    }
    return owners;
  };

  for (const area of report.areas) area.owners = visit(area.label, area.files, 1);
  for (const mod of report.modules) mod.owners = visit(mod.label, mod.files, AFFECTED_WEIGHT);

  report.reviewers = [...ranked.values()]
    .sort((a, b) => b.weighted - a.weighted || b.commits - a.commits || a.name.localeCompare(b.name))
    .slice(0, MAX_REVIEWERS)
    .map(({ weighted: _weighted, ...r }) => r);
}

/** `9d ago`, `3mo ago` — how a comment says when someone was last in here. */
export function sinceLabel(last: number, now: number = Date.now()): string {
  const days = Math.max(0, Math.round((now - last) / (24 * 60 * 60 * 1000)));
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 31) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 24 ? `${months}mo ago` : `${Math.round(days / 365)}y ago`;
}

/** `@handle`, or the bare name when git carries no handle for them. */
export function mention(o: Owner): string {
  return o.handle !== undefined ? `@${o.handle}` : o.name;
}

/** ISO day, for an exported page that has to stay truthful when opened later. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
