/**
 * What a PR touched, read from git: changed files plus the *line ranges* inside
 * them, which is what turns a diff into graph seeds (an enclosing-symbol lookup
 * per changed line, see `blast.ts`).
 *
 * Git is shelled out to rather than parsed from a library because the CI job
 * this feeds already has git — and `--unified=0` gives exactly the post-image
 * line ranges we need, with no context lines to subtract back out.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

/** A contiguous run of changed lines, in POST-image (new file) line numbers. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * One line git reported inside a hunk.
 *
 * `n` is the POST-image number, so it is the number a reviewer sees in the file
 * on disk — a deleted line has none.
 */
export interface DiffLine {
  n: number | null;
  sign: "+" | "-";
  text: string;
}

/** A hunk's range and the lines in it. `ranges` on the file mirrors these. */
export interface Hunk extends LineRange {
  lines: DiffLine[];
  /** Lines dropped by the per-hunk cap — a generated file is not worth holding. */
  dropped: number;
}

export interface ChangedFile {
  /** Repo-relative posix path, post-image (the new name for a rename). */
  path: string;
  status: ChangeStatus;
  /** Pre-image path, renames only. */
  oldPath?: string;
  /** Post-image changed line ranges. Empty for a pure delete or a mode-only change. */
  ranges: LineRange[];
  /** The same hunks, carrying their text: what a panel shows so a reader sees the
   * change rather than a line number they have to go look up. One per range. */
  hunks: Hunk[];
}

export interface DiffResult {
  /** Human label for what was compared, e.g. "origin/main...HEAD". */
  basis: string;
  files: ChangedFile[];
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Text kept per hunk, and per file. A regenerated lockfile is one hunk of 40,000
 * lines: the ranges still matter (they seed the graph), the text does not, and it
 * would otherwise ride along in `--format json` and in every exported page. */
const MAX_HUNK_LINES = 24;
const MAX_FILE_LINES = 200;

/** Run git in `root`, or return null when git fails (not a repo, unknown ref). */
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

/** True when `ref` names something git can resolve — checked before diffing so
 * an unknown `--base` fails with a caller-facing message, not a git stack. */
export function refExists(root: string, ref: string): boolean {
  return git(resolve(root), ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;
}

/**
 * The diff arguments for a base ref, and the label to show for it.
 *
 * `<base>...HEAD` (three dots) diffs against the MERGE BASE, not the tip of the
 * base branch — the difference matters on every PR whose base branch moved after
 * it was cut: two-dot would attribute other people's merges to this PR and
 * inflate the blast radius with files the author never touched.
 */
function rangeArgs(base: string): { args: string[]; basis: string } {
  return { args: [`${base}...HEAD`], basis: `${base}...HEAD` };
}

/**
 * Changed files + post-image line ranges.
 *
 * With no `base` this reports the working tree against HEAD (the local
 * "what am I about to push" case), falling back to the last commit when the
 * tree is clean — so the command answers something useful when run by hand,
 * and CI passes `--base` for the real PR range.
 */
export function changedFiles(root: string, base?: string): DiffResult | null {
  const dir = resolve(root);
  if (base !== undefined) {
    const { args, basis } = rangeArgs(base);
    const files = diffFiles(dir, args);
    return files === null ? null : { basis, files };
  }

  const working = diffFiles(dir, ["HEAD"]);
  if (working === null) return null;
  if (working.length > 0) return { basis: "working tree vs HEAD", files: working };

  const last = diffFiles(dir, ["HEAD~1...HEAD"]);
  if (last === null) return { basis: "working tree vs HEAD", files: [] };
  return { basis: "HEAD~1...HEAD", files: last };
}

/** Both git passes for one range: name-status (statuses, renames) then hunks. */
function diffFiles(dir: string, range: string[]): ChangedFile[] | null {
  const status = git(dir, ["diff", "--name-status", "--find-renames", "-z", ...range, "--"]);
  if (status === null) return null;
  const files = parseNameStatus(status);
  if (files.length === 0) return files;

  const patch = git(dir, [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    // applyHunks expects a/ and b/, regardless of the user's diff.* preferences.
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--find-renames",
    ...range,
    "--",
  ]);
  if (patch !== null) applyHunks(files, patch);
  return files;
}

/**
 * `--name-status -z` output: NUL-separated fields, where a rename spends THREE
 * fields (`R096`, old, new) and everything else spends two. Splitting on NUL and
 * walking with a cursor is the only way to read it — a line-oriented parse
 * silently pairs a rename's old path with the next file's status.
 */
function parseNameStatus(out: string): ChangedFile[] {
  const fields = out.split("\0").filter((f) => f !== "");
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++];
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = fields[i++];
      const path = fields[i++];
      if (path === undefined) break;
      files.push({ path, status: "renamed", oldPath, ranges: [], hunks: [] });
      continue;
    }
    const path = fields[i++];
    if (path === undefined) break;
    if (code.startsWith("A")) files.push({ path, status: "added", ranges: [], hunks: [] });
    else if (code.startsWith("D")) files.push({ path, status: "deleted", ranges: [], hunks: [] });
    else files.push({ path, status: "modified", ranges: [], hunks: [] });
  }
  return files;
}

/** Attach each hunk's post-image range — and its text — to its file. */
function applyHunks(files: ChangedFile[], patch: string): void {
  const byPath = new Map(files.map((f) => [f.path, f]));
  let current: ChangedFile | undefined;
  let hunk: Hunk | undefined;
  /** Post-image number for the next `+` line of the open hunk. */
  let next = 0;
  let kept = 0;

  for (const line of patch.split("\n")) {
    // Every file starts with this, and a content line cannot: a deleted one begins
    // with `-`. Closing the open hunk here is what stops the NEXT file's `--- a/x`
    // header being absorbed as a deleted line of the previous hunk.
    if (line.startsWith("diff --git ")) {
      current = undefined;
      hunk = undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4);
      current = raw === "/dev/null" ? undefined : byPath.get(stripPrefix(raw));
      hunk = undefined;
      kept = 0;
      continue;
    }
    if (line.startsWith("@@")) {
      hunk = undefined;
      if (!current) continue;
      const m = HUNK_RE.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      // `+N,0` is a pure deletion: nothing survives in the post-image, and git
      // reports the line BEFORE the gap. Recording that single line is what keeps
      // "the body of foo() lost 10 lines" attributable to foo() at all.
      const count = m[2] === undefined ? 1 : Number(m[2]);
      const range = count === 0 ? { start, end: start } : { start, end: start + count - 1 };
      hunk = { ...range, lines: [], dropped: 0 };
      current.ranges.push(range);
      current.hunks.push(hunk);
      next = start;
      continue;
    }
    if (!hunk) continue;
    // With `--unified=0` every line inside a hunk is an edit, so there is no
    // context to skip. `+++`/`---` headers are already consumed above; a bare
    // `--- a/x` for the next file arrives before its `+++`, and the `!hunk`
    // guard on a fresh file keeps it out.
    if (line.startsWith("+")) {
      pushLine(hunk, { n: next, sign: "+", text: line.slice(1) }, kept++ < MAX_FILE_LINES);
      next += 1;
    } else if (line.startsWith("-")) {
      pushLine(hunk, { n: null, sign: "-", text: line.slice(1) }, kept++ < MAX_FILE_LINES);
    }
  }
}

function pushLine(hunk: Hunk, line: DiffLine, withinFile: boolean): void {
  if (!withinFile || hunk.lines.length >= MAX_HUNK_LINES) {
    hunk.dropped += 1;
    return;
  }
  hunk.lines.push(line);
}

/** `b/src/x.ts` → `src/x.ts`, minus any trailing tab-separated timestamp. */
function stripPrefix(raw: string): string {
  const untabbed = raw.split("\t")[0];
  return untabbed.startsWith("b/") ? untabbed.slice(2) : untabbed;
}
