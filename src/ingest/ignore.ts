/**
 * Graft's ignore files: `.graftignore` (graft's own), `.cursorignore` (when this
 * repo was wired for Cursor), and any files a build names via `--ignore-file`.
 *
 * All three use gitignore's pattern dialect, applied to repo-relative paths with
 * one deliberate difference from Git: the rules are graft's, layered in a fixed
 * order, and the LAST matching rule across all of them wins — so a later file can
 * negate an earlier file's exclusion. That is what makes `--ignore-file` additive
 * instead of all-or-nothing.
 *
 * The rules are also stricter than Git's in exactly the way this feature needs
 * them: they exclude TRACKED files too. `git ls-files --cached --others
 * --exclude-standard` still emits a file that a `.gitignore` rule matches (Git's
 * ignore rules only gate untracked files), so there is no Git flag that keeps a
 * committed file out of the index — filtering the enumerated set afterwards is
 * the only way. That is why the matching lives here, in the walk, rather than in
 * a git argument.
 *
 * Faithful to gitignore where it counts: a directory exclusion can be bypassed
 * by a NEGATION rule only when the negation appears before the exclusion — the
 * classic `*.ts` / `!keep.ts`. A directory excluded by a rule that outlasts all
 * negations keeps its contents out, exactly as Git does.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { toPosixPath } from "../util/paths.js";
import { readStamp } from "../upkeep.js";

export const GRAFTIGNORE_NAME = ".graftignore";
export const CURSORIGNORE_NAME = ".cursorignore";
/** Written by an explicit `graft build` when the repo has no `.graftignore` yet:
 * comments only, so it changes nothing until a rule is added — its purpose is
 * to make the file's existence (and syntax) self-evident. Committed by the user
 * like any other tracked file, so the whole team shares the exclusions. */
export const GRAFTIGNORE_STARTER = `# graft's ignore file — keep files out of the graph even when they are
# tracked in Git. Syntax is .gitignore's: one pattern per line, # comments,
# a leading ! re-includes, a trailing / names a directory, a / in the pattern
# binds it to the repo root, and ** spans directories. A bare name matches
# at any depth. Later lines (and later --ignore-file files) win over earlier
# ones. Commit this file to share the exclusions with the team.
#
# Examples:
#   generated/          # an output directory that is tracked in the repo
#   *.generated.ts      # generated files anywhere
#   !src/keep.ts        # re-include one file a wider rule caught
`;
/** Same escape hatch as `--no-gitignore` (`GRAFT_NO_GITIGNORE`): skip reading —
 * and the CLI skips creating — graft's own ignore file. */
export const GRAFT_NO_GRAFTIGNORE = "GRAFT_NO_GRAFTIGNORE";

/** The host that must have been wired into the repo (`graft init` with cursor)
 * for its `.cursorignore` to be applied automatically. An explicit
 * `--ignore-file .cursorignore` works either way. */
const CURSOR_HOST_ID = "cursor";

/** One parsed line. `negated` is a `!` prefix; `anchored` a leading `/` (the
 * rule binds to the repo root). A trailing `/` is stripped — it only records
 * intent, since a bare name matches files and directories alike, and a
 * `dir/` pattern is just the segments of `dir`. */
export interface IgnoreRule {
  pattern: string;
  negated: boolean;
  anchored: boolean;
  /** 1-based line in the source file, for error messages. */
  line: number;
  /** The rule as typed, for error messages. */
  raw: string;
}

export interface IgnoreParseError {
  line: number;
  pattern: string;
  message: string;
}

export interface IgnoreSource {
  /** The rule set, in line order. */
  rules: IgnoreRule[];
  /** Unparsed lines, in the order they were read. */
  errors: IgnoreParseError[];
  /** What to call this source when a human asks (a file name, or a path). */
  name: string;
}

/** Last-match-wins over an ordered rule stream. */
export interface IgnoreMatcher {
  /** Is this repo-relative posix path excluded by the rule set? */
  isIgnored(relPath: string): boolean;
  /** The union of every rule's parse errors, in source order. */
  errors(): IgnoreParseError[];
}

export interface IgnoreSourceInput {
  /** Where the lines come from, for error reporting. */
  name: string;
  text: string;
}

/** The ordered sources a build reads: `.cursorignore` (when this repo was wired
 * for Cursor) first, then `.graftignore` (unless `GRAFT_NO_GRAFTIGNORE=1`), then
 * every explicitly named file in the order given. Missing files are skipped —
 * presence is the opt-in, the same contract as `.gitignore` itself. */
export function resolveIgnoreSources(root: string, explicitFiles: readonly string[] = []): IgnoreSourceInput[] {
  const out: IgnoreSourceInput[] = [];
  const seen = new Set<string>();
  const add = (abs: string, name: string): void => {
    const key = process.platform === "win32" ? abs.toLowerCase() : abs;
    if (seen.has(key)) return;
    seen.add(key);
    if (!existsSync(abs)) return;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      return; // unreadable — same fail-soft posture as the walk's other file reads
    }
    out.push({ name, text });
  };
  // The Cursor file only when Cursor is a wired host for THIS repo: the wiring
  // stamp (`graft/.cache/wiring-stamp.json`) is the local record of which hosts
  // `graft init` set up, so the same checkout gets the same file set no matter
  // which process (CLI, hook, MCP) triggers the build.
  if (readStamp(root)?.hosts?.includes(CURSOR_HOST_ID) === true) {
    add(join(root, CURSORIGNORE_NAME), CURSORIGNORE_NAME);
  }
  if (process.env[GRAFT_NO_GRAFTIGNORE] !== "1") {
    add(join(root, GRAFTIGNORE_NAME), GRAFTIGNORE_NAME);
  }
  for (const p of explicitFiles) {
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
    add(abs, toPosixPath(relative(root, abs)) || basename(abs));
  }
  return out;
}

/** Parse a gitignore-dialect file into rules. Blank lines and `#` comments are
 * dropped; everything else must carry a pattern, or it is reported (with its
 * line number) in `errors` and skipped. */
export function parseIgnoreText(name: string, text: string): IgnoreSource {
  const rules: IgnoreRule[] = [];
  const errors: IgnoreParseError[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^[ \t]+/, "");
    if (line === "" || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    let anchored = false;
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1).replace(/\/+/g, "/");
    }
    line = line.replace(/\/+$/, "");
    // Git: a separator left anywhere in the pattern makes it relative to the
    // ignore file's own directory — here always the repo root. Only a bare
    // name (no slash) matches at any depth.
    if (line.includes("/")) anchored = true;
    if (line === "") {
      errors.push({ line: i + 1, pattern: lines[i], message: "empty pattern" });
      continue;
    }
    rules.push({ pattern: line, negated, anchored, line: i + 1, raw: lines[i] });
  }
  return { rules, errors, name };
}

/** One compiled path segment. */
interface SegMatcher {
  /** `**` as a whole segment: matches zero or more path segments — except
   * `minOne`, where it is the pattern's final segment behind a prefix
   * (`foo/**`): Git's "everything INSIDE foo" then requires at least one. */
  doubleStar?: boolean;
  minOne?: boolean;
  /** `*`, `?`, and `[...]` translated; a literal matches itself. */
  re?: RegExp;
}

/** Translate one pattern segment to its matcher, or null when the pattern is
 * not expressible (`**` inside a segment, or an unterminated `[`). A `**` that
 * is the pattern's FINAL segment behind a prefix is `foo/**` — Git's
 * "everything inside foo" — and is flagged `minOne` so it keeps the directory
 * itself out while allowing a negation to re-admit the contents. */
function compileSegment(seg: string, minOne = false): SegMatcher | null {
  if (seg === "**") return { doubleStar: true, minOne };
  let re = "";
  let i = 0;
  while (i < seg.length) {
    const c = seg[i];
    if (c === "*") {
      // `*` never crosses a separator. Consecutive `*` inside a segment are,
      // per Git, "considered regular asterisks" — collapse the run.
      re += "[^/]*";
      while (i < seg.length && seg[i] === "*") i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "\\") {
      const next = seg[i + 1];
      if (next === undefined || next === "/") return null;
      re += escapeRegex(next);
      i += 2;
      continue;
    }
    if (c === "[") {
      const parsed = parseClass(seg, i);
      if (parsed === null) return null;
      re += parsed.re;
      i = parsed.end;
      continue;
    }
    re += escapeRegex(c);
    i++;
  }
  try {
    return { re: new RegExp(`^${re}$`) };
  } catch {
    return null;
  }
}

/** Parse a `[...]` starting at `text[i]` (the `[` itself). Returns the regex
 * body and the index just past the closing `]`, or null when unterminated. */
function parseClass(text: string, i: number): { re: string; end: number } | null {
  let j = i + 1;
  let cls = "";
  let neg = false;
  if (text[j] === "!" || text[j] === "^") {
    neg = true;
    j++;
  }
  // A `]` as the FIRST class member is literal, gitignore's way.
  if (text[j] === "]") {
    cls += "\\]";
    j++;
  }
  let closed = false;
  for (; j < text.length; j++) {
    const cc = text[j];
    if (cc === "\\" && j + 1 < text.length && text[j + 1] !== "/") {
      cls += escapeRegex(text[j + 1]);
      j++;
    } else if (cc === "]") {
      closed = true;
      break;
    } else {
      cls += cc;
    }
  }
  if (!closed) return null;
  return { re: `[${neg ? "^" : ""}${cls}]`, end: j + 1 };
}

function escapeRegex(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/** Match `segments` (the compiled pattern) against `parts` (the path's
 * segments). `**` consumes a variable run, so this is a small backtracking
 * walk — the patterns are short, the paths are not. */
function matchSegments(segments: SegMatcher[], parts: string[]): boolean {
  // Patterns here are few and short; a plain recursion is enough, but the memo
  // keeps a long path under many `**` rules linear instead of exponential.
  const memo = new Map<string, boolean>();
  const at = (pi: number, si: number): boolean => {
    const key = `${pi}:${si}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let result = false;
    while (si < segments.length) {
      const seg = segments[si];
      if (seg.doubleStar) {
        // `minOne` (`foo/**`): at least one segment must remain for the
        // directory's contents — `foo` itself is not matched.
        for (let skip = seg.minOne ? 1 : 0; skip <= parts.length - pi; skip++) {
          if (at(pi + skip, si + 1)) {
            result = true;
            break;
          }
        }
        break;
      }
      if (pi >= parts.length) break;
      if (!seg.re!.test(parts[pi])) break;
      pi++;
      si++;
    }
    if (si === segments.length && pi === parts.length) result = true;
    memo.set(key, result);
    return result;
  };
  return at(0, 0);
}

interface CompiledRule {
  rule: IgnoreRule;
  /** The pattern split into compiled segments. Rules that fail to compile are
   * dropped with an error instead of kept half-compiled. */
  segments: SegMatcher[];
}

/** Compile a rule set into a matcher. Rules keep their source order; the LAST
 * matching rule decides — but with gitignore's one hard constraint: once a
 * directory is excluded by a rule that outlasts every negation, nothing deeper
 * can be re-included, so a negation re-admits a file only when it appears
 * before the exclusion (the standard `*.ts` / `!keep.ts`). */
export function createMatcher(sources: readonly IgnoreSource[]): IgnoreMatcher {
  const compiled: CompiledRule[] = [];
  const allErrors: IgnoreParseError[] = [];
  for (const s of sources) {
    allErrors.push(...s.errors);
    for (const rule of s.rules) {
      const segs = rule.pattern.split("/");
      // Only a `**` at the END, behind at least one segment, is Git's
      // `foo/**` (contents-of) shape; a leading or mid `**` spans any depth.
      const minOneLast = segs.length > 1 && segs[segs.length - 1] === "**";
      const segments = segs.map((seg, i) => compileSegment(seg, minOneLast && i === segs.length - 1));
      const broken = segments.find((m) => m === null);
      if (broken !== undefined) {
        allErrors.push({ line: rule.line, pattern: rule.raw, message: `invalid pattern in ${s.name}` });
        continue;
      }
      compiled.push({ rule, segments: segments as SegMatcher[] });
    }
  }

  /** Does this rule name the path `full` (its segments)? Honors `anchored` and
   * gitignore's "a bare name matches at any depth" rule for patterns with no
   * `/`. */
  const ruleMatches = (c: CompiledRule, full: string): boolean => {
    if (!c.rule.anchored && !c.rule.pattern.includes("/")) {
      // Bare name: match the base segment at any depth.
      return c.segments[0]!.re!.test(full.split("/").pop() ?? "");
    }
    if (c.rule.anchored) return matchSegments(c.segments, full.split("/"));
    // Unanchored multi-segment pattern: match the tail at any depth.
    const parts = full.split("/");
    const n = c.segments.length;
    for (let start = 0; start + n <= parts.length; start++) {
      if (matchSegments(c.segments, parts.slice(start))) return true;
    }
    return false;
  };

  /** The verdict for the DIRECTORY `dir` itself: last matching rule over the
   * directory path. A bare name matches a directory exactly as it matches a
   * file (gitignore makes no file/dir distinction in the pattern), and a
   * file-only pattern like `*.ts` simply does not match directory names — so
   * the same `ruleMatches` reads as the directory test. */
  const dirVerdict = (dir: string): boolean => {
    let verdict = false;
    for (const c of compiled) {
      if (ruleMatches(c, dir)) verdict = !c.rule.negated;
    }
    return verdict;
  };

  return {
    isIgnored(relPath: string): boolean {
      const parts = relPath.replace(/\\/g, "/").split("/");
      const dirs = parts.slice(0, -1); // everything above the file
      // A still-excluded ancestor directory blocks re-inclusion, whatever the
      // file's own rules say — gitignore's one non-negotiable.
      for (let depth = 0; depth < dirs.length; depth++) {
        if (dirVerdict(dirs.slice(0, depth + 1).join("/"))) return true;
      }
      let verdict = false;
      for (const c of compiled) {
        if (!ruleMatches(c, relPath)) continue;
        verdict = !c.rule.negated;
      }
      return verdict;
    },
    errors(): IgnoreParseError[] {
      return allErrors;
    },
  };
}

/** Convenience: read + parse every source and match in one call. */
export function matcherFor(root: string, explicitFiles: readonly string[] = []): IgnoreMatcher {
  return createMatcher(resolveIgnoreSources(root, explicitFiles).map((s) => parseIgnoreText(s.name, s.text)));
}
