/**
 * User-configurable file filters applied by every repo walk (`walkDir` in
 * `./fs.ts`): a size cap, `.graftignore`-style glob excludes, and an opt-in
 * skip for minified/bundled JavaScript.
 *
 * Everything here is read from the environment and from ignore files AT WALK
 * TIME, never from CLI flags. That is deliberate: the fingerprint probe, the
 * pre-query auto-refresh, the MCP server and the Claude Code sync hook all
 * enumerate through `walkDir` without ever seeing a flag, so a filter that
 * lived only on the command line would make a build and the next refresh
 * disagree about the file set — an endless "drift" loop.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Default size cap: files above this are generated/vendored in practice, not
 * hand-written code. Override with `GRAFT_MAX_FILE_BYTES`. */
export const DEFAULT_MAX_FILE_BYTES = 1_000_000;

/** `GRAFT_SKIP_MINIFIED=1` only inspects JavaScript files at least this big. */
export const MINIFIED_MIN_BYTES = 100_000;

/** ...and treats one as minified when its longest line exceeds this many
 * characters. Hand-written code stays far below it; bundlers and minifiers
 * emit whole files as one or two lines. */
export const MINIFIED_MIN_LINE_CHARS = 20_000;

/** Extensions `GRAFT_SKIP_MINIFIED` applies to. */
export const MINIFIED_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs"]);

/** Repo-root ignore file, versioned with the code. */
export const GRAFTIGNORE_FILE = ".graftignore";

type Env = NodeJS.ProcessEnv;

/** Same truthy parsing as the other `GRAFT_*` switches. */
function envTruthy(env: Env, name: string): boolean {
  const v = env[name];
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

let warnedMaxBytes: string | undefined;

/**
 * The effective per-file size cap: `GRAFT_MAX_FILE_BYTES` when it is a positive
 * integer, {@link DEFAULT_MAX_FILE_BYTES} otherwise. An invalid value warns once
 * per process (on stderr — stdout may be an MCP transport) and falls back to the
 * default rather than failing a build or a query.
 */
export function maxFileBytes(env: Env = process.env): number {
  const raw = env.GRAFT_MAX_FILE_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_FILE_BYTES;
  const value = raw.trim();
  const n = Number(value);
  if (/^\d+$/.test(value) && Number.isSafeInteger(n) && n > 0) return n;
  if (warnedMaxBytes !== value) {
    warnedMaxBytes = value;
    console.warn(
      `graft: ignoring GRAFT_MAX_FILE_BYTES=${JSON.stringify(raw)} (expected a positive integer); using ${DEFAULT_MAX_FILE_BYTES}`,
    );
  }
  return DEFAULT_MAX_FILE_BYTES;
}

/** Whether `GRAFT_SKIP_MINIFIED` is on. */
export function skipMinifiedEnabled(env: Env = process.env): boolean {
  return envTruthy(env, "GRAFT_SKIP_MINIFIED");
}

/** Length of the longest line in `text`, in UTF-16 code units. */
export function longestLine(text: string): number {
  let longest = 0;
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    if (end - start > longest) longest = end - start;
    if (nl === -1) return longest;
    start = nl + 1;
  }
}

function extensionOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/** Memo keyed by path and invalidated by (size, mtime): the MCP server and the
 * pre-query probe walk the same tree over and over, and reading every large
 * bundle on each query would cost more than the probe itself. */
const minifiedMemo = new Map<string, { size: number; mtimeMs: number; minified: boolean }>();

/**
 * Whether `abs` is a minified/bundled JavaScript file: a `.js`/`.mjs`/`.cjs`
 * of at least {@link MINIFIED_MIN_BYTES} whose longest line is longer than
 * {@link MINIFIED_MIN_LINE_CHARS}. Callers pass the stat they already took.
 * An unreadable file is reported as not minified — the walk's other guards
 * decide what happens to it.
 */
export function isMinifiedJs(abs: string, stat: { size: number; mtimeMs: number }): boolean {
  if (stat.size < MINIFIED_MIN_BYTES || !MINIFIED_EXTENSIONS.has(extensionOf(abs))) return false;
  const memo = minifiedMemo.get(abs);
  if (memo && memo.size === stat.size && memo.mtimeMs === stat.mtimeMs) return memo.minified;
  let minified = false;
  try {
    minified = longestLine(readFileSync(abs, "utf8")) > MINIFIED_MIN_LINE_CHARS;
  } catch {
    minified = false;
  }
  minifiedMemo.set(abs, { size: stat.size, mtimeMs: stat.mtimeMs, minified });
  return minified;
}

// ---------------------------------------------------------------------------
// .graftignore
// ---------------------------------------------------------------------------

// Pattern matching is done WITHOUT regular expressions. A glob translated to a
// regex (one "[^/]*" per star, an optional ".*/" group per globstar) backtracks
// polynomially, and `.graftignore` content is arbitrary user input evaluated
// against every path on every query's freshness probe: a pattern such as
// `**/**/**/a*a*a*b` against a long path would stall the walk. Instead a
// pattern is split into path segments and matched with the classic greedy
// wildcard algorithm at two levels: characters within a segment (`*`), and
// segments within a path (`**`). With a single backtrack point per level that
// is O(pattern x input) at each level, whatever the pattern.

/** One unit of a segment pattern: a literal character, `?`, a `[...]` class or `*`. */
type CharToken =
  | { kind: "lit"; ch: string }
  | { kind: "any" }
  | { kind: "class"; negated: boolean; items: Array<[string, string]> }
  | { kind: "star" };

/** One unit of a path pattern: a segment pattern, or `**` (any number of segments). */
type SegToken = { kind: "seg"; chars: CharToken[] } | { kind: "globstar" };

interface IgnoreRule {
  segments: SegToken[];
  negate: boolean;
  dirOnly: boolean;
}

/** Tokenize one path segment of a glob. Consecutive `*` collapse into one. */
function tokenizeSegment(glob: string): CharToken[] {
  const out: CharToken[] = [];
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (out.length === 0 || out[out.length - 1].kind !== "star") out.push({ kind: "star" });
    } else if (ch === "?") {
      out.push({ kind: "any" });
    } else if (ch === "\\" && i + 1 < glob.length) {
      i += 1;
      out.push({ kind: "lit", ch: glob[i] });
    } else if (ch === "[") {
      const parsed = parseClass(glob, i);
      if (parsed) {
        out.push(parsed.token);
        i = parsed.end;
      } else {
        out.push({ kind: "lit", ch: "[" });
      }
    } else {
      out.push({ kind: "lit", ch });
    }
    i += 1;
  }
  return out;
}

/** Parse a `[...]` class starting at `glob[start] === "["`; `null` when unterminated. */
function parseClass(glob: string, start: number): { token: CharToken; end: number } | null {
  let i = start + 1;
  let negated = false;
  if (glob[i] === "!" || glob[i] === "^") {
    negated = true;
    i += 1;
  }
  const items: Array<[string, string]> = [];
  let first = true;
  while (i < glob.length) {
    let ch = glob[i];
    if (ch === "]" && !first) return { token: { kind: "class", negated, items }, end: i };
    first = false;
    if (ch === "\\" && i + 1 < glob.length) {
      i += 1;
      ch = glob[i];
    }
    if (glob[i + 1] === "-" && i + 2 < glob.length && glob[i + 2] !== "]") {
      let hi = glob[i + 2];
      let skip = 2;
      if (hi === "\\" && i + 3 < glob.length) {
        hi = glob[i + 3];
        skip = 3;
      }
      items.push([ch, hi]);
      i += skip + 1;
      continue;
    }
    items.push([ch, ch]);
    i += 1;
  }
  return null;
}

function charMatches(token: CharToken, ch: string): boolean {
  switch (token.kind) {
    case "lit":
      return token.ch === ch;
    case "any":
      return true;
    case "class": {
      const hit = token.items.some(([lo, hi]) => ch >= lo && ch <= hi);
      return hit !== token.negated;
    }
    case "star":
      return false;
  }
}

/** Greedy wildcard match of one segment — one backtrack point, no recursion. */
function segmentMatches(tokens: CharToken[], text: string): boolean {
  let t = 0;
  let s = 0;
  let starT = -1;
  let starS = 0;
  while (s < text.length) {
    if (t < tokens.length && tokens[t].kind !== "star" && charMatches(tokens[t], text[s])) {
      t += 1;
      s += 1;
    } else if (t < tokens.length && tokens[t].kind === "star") {
      starT = t;
      starS = s;
      t += 1;
    } else if (starT !== -1) {
      t = starT + 1;
      starS += 1;
      s = starS;
    } else {
      return false;
    }
  }
  while (t < tokens.length && tokens[t].kind === "star") t += 1;
  return t === tokens.length;
}

/** The same greedy algorithm one level up: segment patterns over path segments,
 * with `**` as the star. */
function pathMatches(tokens: SegToken[], segments: string[], length = segments.length): boolean {
  let t = 0;
  let s = 0;
  let starT = -1;
  let starS = 0;
  while (s < length) {
    const tok = tokens[t];
    if (tok !== undefined && tok.kind === "seg" && segmentMatches(tok.chars, segments[s])) {
      t += 1;
      s += 1;
    } else if (tok !== undefined && tok.kind === "globstar") {
      starT = t;
      starS = s;
      t += 1;
    } else if (starT !== -1) {
      t = starT + 1;
      starS += 1;
      s = starS;
    } else {
      return false;
    }
  }
  while (t < tokens.length && tokens[t].kind === "globstar") t += 1;
  return t === tokens.length;
}

/** Compile the glob part of one pattern into segment tokens. */
function compileSegments(glob: string, anchored: boolean): SegToken[] {
  const parts = glob.split("/");
  const out: SegToken[] = [];
  // An unanchored pattern matches at any depth: an implicit leading `**`.
  if (!anchored) out.push({ kind: "globstar" });
  parts.forEach((part, i) => {
    if (part === "**") {
      if (i === parts.length - 1 && i > 0) {
        // Trailing `/**` matches everything INSIDE, not the directory itself:
        // at least one more segment.
        out.push({ kind: "seg", chars: [{ kind: "star" }] });
      }
      if (out.length === 0 || out[out.length - 1].kind !== "globstar") out.push({ kind: "globstar" });
      return;
    }
    // Any other `**` (inside a segment) is an ordinary `*`, as in Git; the
    // tokenizer collapses it.
    out.push({ kind: "seg", chars: tokenizeSegment(part) });
  });
  return out;
}

/** Strip trailing whitespace unless the last one is escaped (`\ `). A manual
 * loop rather than `/\s+$/`, which is quadratic on a long run of spaces. */
function trimTrailing(p: string): string {
  let end = p.length;
  while (end > 0 && /\s/.test(p[end - 1])) {
    if (end >= 2 && p[end - 2] === "\\") break;
    end -= 1;
  }
  return p.slice(0, end);
}

/** Compile one line of an ignore file; `null` for blanks and comments. */
function compileRule(line: string): IgnoreRule | null {
  let p = trimTrailing(line.endsWith("\r") ? line.slice(0, -1) : line);
  if (p === "" || p.startsWith("#")) return null;
  let negate = false;
  if (p.startsWith("!")) {
    negate = true;
    p = p.slice(1);
  } else if (p.startsWith("\\!") || p.startsWith("\\#")) {
    p = p.slice(1);
  }
  let dirOnly = false;
  while (p.endsWith("/")) {
    dirOnly = true;
    p = p.slice(0, -1);
  }
  if (p === "") return null;
  // A slash anywhere but the end anchors the pattern to the base directory;
  // without one it matches at any depth.
  const anchored = p.includes("/");
  while (p.startsWith("/")) p = p.slice(1);
  if (p === "") return null;
  return { segments: compileSegments(p, anchored), negate, dirOnly };
}

/** Parse ignore-file text into rules, in file order. */
export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of text.split("\n")) {
    const rule = compileRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * A compiled set of ignore rules, matched against posix paths relative to
 * {@link IgnoreMatcher.base}. Semantics follow `.gitignore`: last matching rule
 * wins, `!` re-includes, a trailing `/` matches directories only, and — as in
 * Git — a file cannot be re-included when one of its parent directories is
 * excluded.
 */
export class IgnoreMatcher {
  private readonly dirMemo = new Map<string, boolean>();

  constructor(
    readonly base: string,
    private readonly rules: IgnoreRule[],
  ) {}

  get empty(): boolean {
    return this.rules.length === 0;
  }

  /** Whether the first `length` of `segments` (a path) is excluded by the rules alone. */
  private matches(segments: string[], length: number, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (pathMatches(rule.segments, segments, length)) ignored = !rule.negate;
    }
    return ignored;
  }

  /** Directory verdicts are shared by every file beneath them, so memoize them
   * per walk; keyed by the directory's base-relative path. */
  private dirIgnored(key: string, segments: string[], length: number): boolean {
    let hit = this.dirMemo.get(key);
    if (hit === undefined) {
      hit = this.matches(segments, length, true);
      this.dirMemo.set(key, hit);
    }
    return hit;
  }

  /** Whether the posix, base-relative `rel` is excluded. */
  ignoresRel(rel: string, isDir = false): boolean {
    if (this.rules.length === 0 || rel === "") return false;
    const segments = rel.split("/");
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix === "" ? segments[i] : `${prefix}/${segments[i]}`;
      if (this.dirIgnored(prefix, segments, i + 1)) return true;
    }
    return this.matches(segments, segments.length, isDir);
  }

  /** Whether the absolute path `abs` is excluded. Paths outside `base` never are. */
  ignores(abs: string, isDir = false): boolean {
    if (this.rules.length === 0) return false;
    const rel = relative(this.base, abs);
    if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
      return false;
    }
    return this.ignoresRel(rel.replace(/\\/g, "/"), isDir);
  }
}

/** The repository's top-level directory and Git common dir, found by walking up
 * from `dir` for a `.git` entry. Read from disk instead of spawning
 * `git rev-parse`: this runs on every query's freshness probe. In a linked
 * worktree `.git` is a file pointing at `<common>/worktrees/<name>`, whose
 * `commondir` file names the shared directory. */
export function findGitDirs(dir: string): { top: string; commonDir: string } | null {
  let cur = resolve(dir);
  for (;;) {
    const dotGit = join(cur, ".git");
    let gitDir: string | null = null;
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) {
        gitDir = dotGit;
      } else if (st.isFile()) {
        const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
        if (m) gitDir = resolve(cur, m[1]);
      }
    } catch {
      /* no .git here */
    }
    if (gitDir) {
      let commonDir = gitDir;
      try {
        const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
        if (common) commonDir = resolve(gitDir, common);
      } catch {
        /* not a linked worktree */
      }
      return { top: cur, commonDir };
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** The user-wide ignore file: `~/.graft/ignore`, next to graft's other
 * per-user state. */
export function globalIgnorePath(home: string = homedir()): string {
  return join(home, ".graft", "ignore");
}

/** The ignore files that apply to a walk rooted at `root`, lowest precedence
 * first (later rules override earlier ones, as Git orders core.excludesFile,
 * info/exclude and .gitignore):
 *
 *   1. `~/.graft/ignore`                   — user-wide
 *   2. `$GIT_COMMON_DIR/info/graftignore`  — this clone, unversioned, shared by
 *                                            every worktree of it
 *   3. `<repo root>/.graftignore`          — versioned with the code
 *
 * Patterns in all three are relative to the repository root (the walk root
 * outside Git). */
export function ignoreFilesFor(root: string, home: string = homedir()): { base: string; files: string[] } {
  const git = findGitDirs(root);
  const base = git?.top ?? resolve(root);
  const files = [globalIgnorePath(home)];
  if (git) files.push(join(git.commonDir, "info", "graftignore"));
  files.push(join(base, GRAFTIGNORE_FILE));
  return { base, files };
}

/** Load every applicable ignore file for a walk rooted at `root`. Missing or
 * unreadable files contribute nothing. */
export function loadIgnoreMatcher(root: string, home: string = homedir()): IgnoreMatcher {
  const { base, files } = ignoreFilesFor(root, home);
  const rules: IgnoreRule[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      rules.push(...parseIgnore(readFileSync(file, "utf8")));
    } catch {
      /* unreadable ignore file — treat as absent */
    }
  }
  return new IgnoreMatcher(base, rules);
}

/**
 * The per-walk filter `walkDir` threads through every enumeration path. Built
 * once per walk so env and ignore files are read once, not per file.
 */
export interface FileFilter {
  /** Excluded by an ignore rule (checked before any stat). */
  ignored(abs: string, isDir?: boolean): boolean;
  /** Passes the size cap and, when enabled, the minified-bundle check. */
  admits(abs: string, stat: { size: number; mtimeMs: number }): boolean;
}

export function createFileFilter(root: string, env: Env = process.env): FileFilter {
  const matcher = loadIgnoreMatcher(root);
  const maxBytes = maxFileBytes(env);
  const skipMinified = skipMinifiedEnabled(env);
  return {
    ignored: (abs, isDir = false) => matcher.ignores(abs, isDir),
    admits: (abs, stat) => stat.size <= maxBytes && !(skipMinified && isMinifiedJs(abs, stat)),
  };
}
