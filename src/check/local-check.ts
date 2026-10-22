/**
 * `trail check` without a server: the deterministic half of Trail's check,
 * ported from the Go service (trail_check.go, trail_check_rules.go and
 * trail_text.go in assign's backend), so a diff can be held up against the
 * learnings in the repo's `.trail/` (teammates' pushed branches included),
 * the person's own, and the repo's skills, all on this machine. ("Notes"
 * below are learnings: the type kept its old name.)
 *
 * Knowledge is picked the way the server picked it: notes that touched a
 * changed file or its folder, then notes and skills that share the diff's
 * words. Then, in each change block (a run of removed and added lines), the
 * rules look for three things:
 *
 * - a value changed against a recorded number: a line changes `retries` from
 *   3 to 5 and a note on this code says "three retries" (conflict), or warned
 *   about or ruled out 5 (conflict), or decided on 5 (follows);
 * - an approach a note's "Tried and ruled out" section names, brought back by
 *   the added lines (conflict);
 * - a decision or takeaway whose words the added lines carry (follows).
 *
 * It errs towards silence: a conflict fails the CLI, so one is reported only
 * on evidence in the diff itself, quoted from the source.
 *
 * Approved brain rules exist only on the server, so this check has none.
 */
import { posix } from "node:path";
import type { CheckFinding, CheckResult } from "./types.js";
import type { Note } from "../notes/notes.js";
import type { Skill } from "../skills/skills.js";

const MAX_CANDIDATES = 25;
const MAX_SKILLS = 6;
/** Knowledge matched on words, not on files, must share at least this many terms with the diff. */
const MIN_TERM_HITS = 2;
const DIFF_TERMS = 24;
const SUMMARY_WORDS = 12;
const QUOTE_WORDS = 40;
const MAX_FINDINGS = 20;
const MAX_FILES = 500;
/** Notes read before ranking, as the server's search reads them. */
const NOTE_POOL = 100;

// Ranking weights: touching a changed file outweighs any wording, a shared
// folder is a weaker hint, recency only breaks near-ties.
const SCORE_FILE_EXACT = 1.0;
const SCORE_FILE_DIR = 0.4;
const SCORE_RECENCY = 0.2;
const RECENCY_DAYS = 30;

export interface LocalCheckInput {
  /** Unified diff text, as `git diff <base>...` gives it (the CLI already produces it, capped at 400 KB). */
  diff: string;
  /** Changed files, repo-relative. */
  files: string[];
  /** Every note that could bear on the repo; the check picks its candidates itself. */
  notes: Note[];
  /** Skills from `listSkills(repo)`. */
  skills: Skill[];
  /** Who is asking (first name). The server only records it: a note by the asker is still a candidate. */
  asker?: string;
  now?: Date;
}

/**
 * Check a diff against the notes and skills on this machine, with the rules
 * Trail's server falls back to when it has no model. Same shape as the
 * server's answer: `files` is the changed-file count, `notes` and `skills`
 * how many the check was given (the server reports how many it has indexed),
 * and the findings, conflicts first.
 */
export function checkLocally(input: LocalCheckInput): CheckResult {
  const now = input.now ?? new Date();
  const diffFiles = parseTrailDiff(input.diff);
  const files = trailCheckFiles(input.files, diffFiles).slice(0, MAX_FILES);
  const out: CheckResult = { files: files.length, notes: input.notes.length, skills: input.skills.length, findings: [] };
  if (files.length === 0) return out;

  const terms = trailDiffTerms(
    diffFiles.flatMap((f) => addedText(f)),
    DIFF_TERMS,
  );
  const { files: fileList, dirs: dirList } = filesAndDirs(files);
  const notes = notePool(input.notes, terms, fileList, dirList);
  const skills = input.skills.map((skill) => ({
    skill,
    textScore: localTextScore(termHits(`${skill.name}\n${candidateText({ kind: "skill", skill })}`, terms)),
  }));
  const candidates = selectTrailCheckCandidates(files, terms, notes, skills, now);
  if (candidates.length === 0) return out;
  out.findings = judgeTrailCheck(candidates, diffFiles);
  return out;
}

/* -------------------------------------------------------------------------- */
/* text                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Words that say nothing about what a change is about: English filler plus
 * the keywords and names every diff is full of.
 */
const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before
  being below between both but by can could did do does doing done down during each else
  few for from further get got had has have having he her here hers him his how i if in
  into is it its itself just let like make made me more most my no nor not now of off on
  once only or other our out over own same she should so some such than that the their
  them then there these they this those through to too under until up use used using very
  was we were what when where which while who whom why will with would you your yours
  new old add adds added fix fixes fixed change changes changed update updates updated
  way thing things work works working need needs want try tried still back see look
  func function return returns var const let type struct interface package import def
  class self this nil null none true false err error errors string int bool byte float
  ctx context fmt log if else for range switch case default break continue go defer
  public private static void async await export from require module`.split(/\s+/).filter(Boolean),
);

const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;

/** `NormalizeBox` → [Normalize, Box], `max_retries` → [max, retries], `HTTPServer` → [HTTP, Server]. */
export function splitIdentifier(word: string): string[] {
  const parts: string[] = [];
  for (const chunk of word.split("_")) {
    if (!chunk) continue;
    const runes = Array.from(chunk);
    let start = 0;
    for (let i = 1; i < runes.length; i++) {
      const prev = runes[i - 1]!;
      const cur = runes[i]!;
      const lowerToUpper = LOWER.test(prev) && UPPER.test(cur);
      // "HTTPServer" splits before the last capital of the run.
      const acronymEnd = UPPER.test(prev) && UPPER.test(cur) && i + 1 < runes.length && LOWER.test(runes[i + 1]!);
      if (lowerToUpper || acronymEnd) {
        parts.push(runes.slice(start, i).join(""));
        start = i;
      }
    }
    parts.push(runes.slice(start).join(""));
  }
  return parts;
}

/** Runs of letters, digits and underscores. */
function rawWords(text: string): string[] {
  return text.split(/[^\p{L}\p{Nd}_]+/u).filter(Boolean);
}

function keepTerm(t: string): boolean {
  return t.length >= 3 && t.length <= 40 && !STOPWORDS.has(t) && !/^\d+$/.test(t);
}

/**
 * The terms of a piece of text, lower-cased, deduplicated, in first-seen
 * order. Identifiers give their parts and, for camelCase, the whole word too.
 * At most `max` (0: no cap).
 */
export function trailTerms(text: string, max = 0): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const t = raw.toLowerCase();
    if (!/^[a-z0-9]+$/.test(t) || !keepTerm(t) || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const w of rawWords(text)) {
    const parts = splitIdentifier(w);
    if (parts.length > 1 && !w.includes("_")) add(w);
    for (const p of parts) add(p);
    if (max > 0 && out.length >= max) return out.slice(0, max);
  }
  return out;
}

/**
 * Folds the plural and simple verb endings that make two people's words for
 * the same thing differ (`retries`/`retry`). Much weaker than a stemmer on
 * purpose: it only has to stop overlap detection missing the obvious.
 */
export function normTerm(term: string): string {
  const t = term.toLowerCase();
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function normTermSet(text: string): Set<string> {
  return new Set(trailTerms(text).map(normTerm));
}

/** `./a.go` → `a.go`. */
function cleanRepoPath(p: string): string {
  const t = p.trim();
  return t.startsWith("./") ? t.slice(2) : t;
}

/** The file part of a touch: `internal/ocr/bbox.go#NormalizeBox` → `internal/ocr/bbox.go`. */
function touchFile(touch: string): string {
  const t = touch.trim();
  const hash = t.indexOf("#");
  return cleanRepoPath(hash >= 0 ? t.slice(0, hash) : t);
}

/** Go's path.Dir. */
function pathDir(p: string): string {
  const dir = p.slice(0, p.lastIndexOf("/") + 1);
  if (!dir) return ".";
  const n = posix.normalize(dir);
  return n.length > 1 ? n.replace(/\/+$/, "") || "/" : n;
}

/** A file's folder, or "" at the root: sharing the root says nothing about two files. */
function repoDir(file: string): string {
  const d = pathDir(file);
  return d === "." || d === "/" ? "" : d;
}

/** The cleaned, deduplicated files and their non-root folders, both sorted. */
function filesAndDirs(list: string[]): { files: string[]; dirs: string[] } {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const raw of list) {
    const f = touchFile(raw);
    if (!f) continue;
    files.add(f);
    const d = repoDir(f);
    if (d) dirs.add(d);
  }
  return { files: [...files].sort(), dirs: [...dirs].sort() };
}

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

function capWords(s: string, n: number): string {
  return words(s).slice(0, n).join(" ");
}

/** Case and whitespace folded, so a quote copied across a line break still matches its source. */
function normQuote(s: string): string {
  return words(s).join(" ").toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* the diff                                                                   */
/* -------------------------------------------------------------------------- */

export interface DiffLine {
  /** New-file line number; 0 for a removed line. */
  new: number;
  op: "+" | "-" | " ";
  text: string;
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
  hunks: Array<{ start: number; len: number }>;
}

/** Every line the diff adds to the file. */
export function addedText(f: DiffFile): string[] {
  return f.lines.filter((l) => l.op === "+").map((l) => l.text);
}

/** Whether a new-file line number lies inside one of the file's hunks. */
export function inHunk(f: DiffFile, line: number): boolean {
  return f.hunks.some((h) => line >= h.start && line < h.start + h.len);
}

function stripDiffPrefix(raw: string): string {
  let p = raw.trim();
  const tab = p.indexOf("\t"); // "+++ b/x.go\t2026-10-07 ..."
  if (tab >= 0) p = p.slice(0, tab);
  if (p === "/dev/null") return "";
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return cleanRepoPath(p);
}

function atoi(s: string): number | null {
  return /^[+-]?\d+$/.test(s) ? Number(s) : null;
}

/** `@@ -a,b +c,d @@` → the new start and the old and new line counts. */
function parseHunkHeader(line: string): { newStart: number; oldLen: number; newLen: number } | null {
  const fields = words(line);
  if (fields.length < 3 || fields[0] !== "@@") return null;
  if (!fields[1]!.startsWith("-") || !fields[2]!.startsWith("+")) return null;
  const span = (s: string): [number, number] | null => {
    const body = s.slice(1);
    const comma = body.indexOf(",");
    const start = atoi(comma >= 0 ? body.slice(0, comma) : body);
    const count = comma >= 0 ? atoi(body.slice(comma + 1)) : 1;
    return start === null || count === null ? null : [start, count];
  };
  const old = span(fields[1]!);
  const neu = span(fields[2]!);
  if (!old || !neu) return null;
  return { newStart: neu[0], oldLen: old[1], newLen: neu[1] };
}

/**
 * A unified diff (git's or plain) as files. Hunk bodies are read by their
 * declared line counts, so an added line that itself starts with `+++` is not
 * taken for a file header. A deleted file keeps its old path.
 */
export function parseTrailDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldPath = "";
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      if (line === "") line = " "; // some tools strip the blank context line's leading space
      const op = line[0];
      if (op === " ") {
        cur.lines.push({ new: newLine, op: " ", text: line.slice(1) });
        newLine++;
        oldLeft--;
        newLeft--;
        continue;
      }
      if (op === "+") {
        cur.lines.push({ new: newLine, op: "+", text: line.slice(1) });
        newLine++;
        newLeft--;
        continue;
      }
      if (op === "-") {
        cur.lines.push({ new: 0, op: "-", text: line.slice(1) });
        oldLeft--;
        continue;
      }
      if (op === "\\") continue; // "\ No newline at end of file"
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("diff --git ")) {
      oldPath = "";
      cur = null;
    } else if (line.startsWith("--- ")) {
      oldPath = stripDiffPrefix(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      const p = stripDiffPrefix(line.slice(4)) || oldPath;
      if (!p) {
        cur = null;
        continue;
      }
      cur = { path: p, lines: [], hunks: [] };
      files.push(cur);
    } else if (line.startsWith("@@")) {
      if (!cur) continue;
      const h = parseHunkHeader(line);
      if (!h) continue;
      cur.hunks.push({ start: h.newStart, len: h.newLen });
      oldLeft = h.oldLen;
      newLeft = h.newLen;
      newLine = h.newStart;
    }
  }
  return files;
}

/** The words and identifiers the diff adds: identifiers (camelCase, snake_case, with digits) first, then by how often they appear. */
export function trailDiffTerms(added: string[], max: number): string[] {
  const count = new Map<string, number>();
  const ident = new Set<string>();
  const first = new Map<string, number>();
  for (const line of added) {
    for (const w of rawWords(line)) {
      const isIdent = splitIdentifier(w).length > 1 || /[0-9]/.test(w);
      for (const t of trailTerms(w)) {
        if (!first.has(t)) first.set(t, first.size);
        count.set(t, (count.get(t) ?? 0) + 1);
        if (isIdent) ident.add(t);
      }
    }
  }
  const terms = [...count.keys()].sort((a, b) => {
    if (ident.has(a) !== ident.has(b)) return ident.has(a) ? -1 : 1;
    if (count.get(a) !== count.get(b)) return count.get(b)! - count.get(a)!;
    return first.get(a)! - first.get(b)!;
  });
  return max > 0 && terms.length > max ? terms.slice(0, max) : terms;
}

/** The changed files: what the caller listed, then every file the diff names, deduplicated in that order. */
export function trailCheckFiles(listed: string[], diffFiles: DiffFile[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...listed, ...diffFiles.map((f) => f.path)]) {
    const f = cleanRepoPath(raw);
    if (f && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* candidates                                                                 */
/* -------------------------------------------------------------------------- */

/** One piece of knowledge a diff is held against. */
export type Candidate = { kind: "note"; note: Note } | { kind: "skill"; skill: Skill };

/** What a candidate says, and what a quote must come from. */
function candidateText(c: Candidate): string {
  if (c.kind === "note") return `${c.note.title}\n${c.note.body}`;
  let text = `${c.skill.description}\n${c.skill.body}`;
  for (const t of c.skill.takeaways) if (t.foldedIn === undefined) text += `\n${t.text}`;
  return text;
}

function label(c: Candidate): string {
  return c.kind === "note" ? c.note.title : `skill ${c.skill.name}`;
}

/** How many of the terms the text carries, each counted once. */
function termHits(text: string, terms: string[]): number {
  const set = normTermSet(text);
  const seen = new Set<string>();
  for (const t of terms) {
    const k = normTerm(t);
    if (set.has(k)) seen.add(k);
  }
  return seen.size;
}

/**
 * Stands in for Postgres' ts_rank, which only the server has: more shared
 * terms rank higher, and it stays under 0.8 so wording never outranks a note
 * that touched a changed file.
 */
function localTextScore(hits: number): number {
  return hits / (hits + 8);
}

/** Whether any touch is one of `files` (exact) or lies in one of `dirs`. */
function touchMatch(touches: string[], files: string[], dirs: string[]): { exact: boolean; dir: boolean } {
  const fileSet = new Set(files);
  const dirSet = new Set(dirs);
  let exact = false;
  let dir = false;
  for (const t of touches) {
    const f = touchFile(t);
    if (fileSet.has(f)) exact = true;
    const d = repoDir(f);
    if (d && dirSet.has(d)) dir = true;
  }
  return { exact, dir };
}

/** A note's YYYY-MM-DD date as UTC midnight, or null when it has none. */
function noteDay(date: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date ? null : d;
}

function noteScore(note: Note, textScore: number, exact: boolean, dir: boolean, now: Date): number {
  let score = textScore;
  if (exact) score += SCORE_FILE_EXACT;
  else if (dir) score += SCORE_FILE_DIR;
  const day = noteDay(note.date);
  if (day) {
    const age = Math.max(0, (now.getTime() - day.getTime()) / 86_400_000);
    score += SCORE_RECENCY * Math.exp(-age / RECENCY_DAYS);
  }
  return score;
}

function noteSearchText(n: Note): string {
  return `${n.title}\n${n.body}\n${n.touches.join(" ")}`;
}

/**
 * What the server's note search would hand the selection: notes that share a
 * word with the diff or touch a changed file or folder, best text match
 * first, newest next, at most 100.
 */
function notePool(notes: Note[], terms: string[], files: string[], dirs: string[]): Array<{ note: Note; textScore: number }> {
  const pool: Array<{ note: Note; textScore: number }> = [];
  for (const note of notes) {
    const hits = termHits(noteSearchText(note), terms);
    const m = touchMatch(note.touches, files, dirs);
    if (hits > 0 || m.exact || m.dir) pool.push({ note, textScore: localTextScore(hits) });
  }
  pool.sort((a, b) => {
    if (a.textScore !== b.textScore) return b.textScore - a.textScore;
    const ad = noteDay(a.note.date)?.getTime() ?? -Infinity;
    const bd = noteDay(b.note.date)?.getTime() ?? -Infinity;
    if (ad !== bd) return bd - ad;
    return a.note.path < b.note.path ? -1 : a.note.path > b.note.path ? 1 : 0;
  });
  return pool.slice(0, NOTE_POOL);
}

/**
 * At most 25 pieces of knowledge for the changed files: skills that name a
 * changed path or share the diff's words (at most 6), then notes that touched
 * these files or their folders, or share the diff's words, best first. Notes
 * come first in the returned order. Exported for tests.
 */
export function selectTrailCheckCandidates(
  files: string[],
  diffTerms: string[],
  notes: Array<{ note: Note; textScore: number }>,
  skills: Array<{ skill: Skill; textScore: number }>,
  now: Date,
): Candidate[] {
  const { files: fileList, dirs: dirList } = filesAndDirs(files);

  const sp: Array<{ skill: Skill; mention: boolean; score: number }> = [];
  for (const { skill, textScore } of skills) {
    const text = candidateText({ kind: "skill", skill });
    const mention = fileList.some((f) => f !== "" && text.includes(f));
    if (!mention && (textScore <= 0 || termHits(`${skill.name}\n${text}`, diffTerms) < MIN_TERM_HITS)) continue;
    sp.push({ skill, mention, score: textScore });
  }
  sp.sort((a, b) => (a.mention !== b.mention ? (a.mention ? -1 : 1) : b.score - a.score));
  sp.splice(MAX_SKILLS);

  const np: Array<{ note: Note; score: number }> = [];
  for (const { note, textScore } of notes) {
    const { exact, dir } = touchMatch(note.touches, fileList, dirList);
    if (!exact && !dir && termHits(noteSearchText(note), diffTerms) < MIN_TERM_HITS) continue;
    np.push({ note, score: noteScore(note, textScore, exact, dir, now) });
  }
  np.sort((a, b) => b.score - a.score);
  np.splice(MAX_CANDIDATES - sp.length);

  return [
    ...np.map((p): Candidate => ({ kind: "note", note: p.note })),
    ...sp.map((p): Candidate => ({ kind: "skill", skill: p.skill })),
  ];
}

/** A finding's source, built only from the candidate. The quote is kept only if it really is in the candidate's text. */
function candidateSource(c: Candidate, quote: string): CheckFinding["source"] {
  const src: CheckFinding["source"] = { kind: c.kind };
  const q = quote.trim();
  if (q && normQuote(candidateText(c)).includes(normQuote(q))) src.quote = words(q).join(" ");
  if (c.kind === "note") {
    if (c.note.title) src.title = c.note.title;
    if (c.note.author) src.author = c.note.author;
    if (noteDay(c.note.date)) src.date = c.note.date;
    if (c.note.path) src.path = c.note.path;
  } else {
    if (c.skill.name) src.name = c.skill.name;
    if (c.skill.version) src.version = c.skill.version;
  }
  return src;
}

/* -------------------------------------------------------------------------- */
/* the rules                                                                  */
/* -------------------------------------------------------------------------- */

/** Which section of a note a sentence came from, or that it is a skill's takeaway. */
type StatementKind = "other" | "decided" | "watch" | "ruledOut" | "takeaway";

interface Statement {
  kind: StatementKind;
  text: string;
}

function noteSection(heading: string): StatementKind {
  const h = heading.toLowerCase();
  const has = (...xs: string[]) => xs.some((x) => h.includes(x));
  if (has("ruled out", "tried", "rejected", "dead end", "didn't work", "did not work")) return "ruledOut";
  if (has("watch out", "gotcha", "careful", "pitfall", "warning")) return "watch";
  if (has("decided", "decision")) return "decided";
  return "other";
}

const LIST_MARKER = /^(?:[-*+•>]+|\d+[.)])[\t\n\f\r ]+/;

/**
 * A line of prose as sentences, without bullet or numbering markers. Each is
 * a verbatim run of the line, so it can be quoted back as written. Exported
 * for tests.
 */
export function trailSentences(raw: string): string[] {
  let line = raw.trim();
  for (let m = LIST_MARKER.exec(line); m; m = LIST_MARKER.exec(line)) line = line.slice(m[0].length).trim();
  if (!line) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if ((c === "." || c === "!" || c === "?") && line[i + 1] === " " && i + 2 < line.length && /[A-Z0-9]/.test(line[i + 2]!)) {
      const s = line.slice(start, i + 1).trim();
      if (s) out.push(s);
      start = i + 2;
    }
  }
  const s = line.slice(start).trim();
  if (s) out.push(s);
  return out;
}

/** Marks a sentence of a skill's body as an instruction worth holding a diff against; the rest is explanation. */
const DIRECTIVE = /\b(never|always|don't|do not|must|avoid|only|instead)\b/i;

/** A candidate's knowledge, sentence by sentence. */
function statementsOf(c: Candidate): Statement[] {
  const out: Statement[] = [];
  if (c.kind === "note") {
    let kind: StatementKind = "other";
    for (const line of c.note.body.split("\n")) {
      const t = line.trim();
      if (t.startsWith("#")) {
        kind = noteSection(t.replace(/^[# ]+/, ""));
        continue;
      }
      for (const s of trailSentences(t)) out.push({ kind, text: s });
    }
    return out;
  }
  for (const t of c.skill.takeaways) {
    if (t.foldedIn !== undefined) continue;
    for (const line of t.text.split("\n")) for (const s of trailSentences(line)) out.push({ kind: "takeaway", text: s });
  }
  for (const line of c.skill.body.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    for (const s of trailSentences(line)) if (DIRECTIVE.test(s)) out.push({ kind: "takeaway", text: s });
  }
  return out;
}

/** Whose knowledge a candidate is, for a finding's summary. */
function owner(c: Candidate): string {
  if (c.kind === "skill") return `skill ${c.skill.name}`;
  const a = c.note.author.trim();
  return a ? `${a}'s learning` : "a team learning";
}

/**
 * Whether the candidate bears on a changed file: a note that touched the file
 * or its folder, a skill that names either, or either sharing two terms with
 * what the diff adds to it.
 */
function relevantTo(c: Candidate, f: DiffFile, addedTerms: string[]): boolean {
  const dir = repoDir(f.path);
  if (c.kind === "note") {
    const m = touchMatch(c.note.touches, [f.path], dir ? [dir] : []);
    if (m.exact || m.dir) return true;
  } else {
    const text = candidateText(c);
    if (text.includes(f.path) || (dir && text.includes(`${dir}/`))) return true;
  }
  return termHits(`${label(c)}\n${candidateText(c)}`, addedTerms) >= MIN_TERM_HITS;
}

/** One run of removed and added lines with no context line between them: the unit a value change is read from. */
interface ChangeBlock {
  removed: string[];
  added: DiffLine[];
}

function changeBlocks(f: DiffFile): ChangeBlock[] {
  const out: ChangeBlock[] = [];
  let open: ChangeBlock | null = null;
  for (const l of f.lines) {
    if (l.op === " ") {
      open = null;
      continue;
    }
    if (!open) {
      open = { removed: [], added: [] };
      out.push(open);
    }
    if (l.op === "-") open.removed.push(l.text);
    else open.added.push(l);
  }
  return out;
}

const NUMBER = /\d+(?:\.\d+)?/g;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
const WORD_NUMBERS = new Map<string, number>(
  Object.entries({
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
    once: 1, twice: 2, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
    seventh: 7, eighth: 8, ninth: 9, tenth: 10, single: 1, double: 2, triple: 3,
  }),
);
/** Name parts that say nothing about which value a line sets: a sentence sharing only "max" with `maxRetries` is not about retries. */
const GENERIC_NAME_PARTS = new Set(["max", "min", "num", "cnt", "count", "default", "val", "value", "tmp", "total", "limit", "new", "old"]);
/** Words that frame a "tried and ruled out" sentence rather than name the approach: the code that brings it back never has them. */
const FRAMING_WORDS = new Set([
  "tried", "ruled", "instead", "because", "around", "didn", "doesn", "isn", "wasn", "worked", "approach", "turned",
  "ended", "turns", "slow", "slower", "broke", "breaks",
]);

/** Every number a sentence states, in digits (`60s`, `4th`) or words (`three`, `fourth`). Exported for tests. */
export function trailNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.match(NUMBER) ?? []) out.add(Number(m));
  for (const w of rawWords(text.toLowerCase())) {
    const v = WORD_NUMBERS.get(w);
    if (v !== undefined) out.add(v);
  }
  return out;
}

/**
 * The value a decision records is the one its head states, before the
 * reason: "Keep defaultRetryMax = 4: ten retries can hold one call for an
 * hour" decided 4, not 10. A head with no number falls back to the sentence.
 */
function decidedNumbers(text: string): Set<number> {
  const head = trailNumbers(approachHead(text));
  return head.size ? head : trailNumbers(text);
}

/** The numbers a code line carries outside its identifiers (`retries2` gives no 2), in order. Exported for tests. */
export function trailLineNumbers(line: string): string[] {
  return line.replace(IDENTIFIER, " ").match(NUMBER) ?? [];
}

/** A line that changes a named value from one number to another: `-maxRetries := 3` / `+maxRetries := 5`. */
interface ValueChange {
  line: number;
  name: string;
  from: number;
  to: number;
  fromText: string;
  toText: string;
}

/** The first of `a` that `b` does not carry. */
function firstMissing(a: string[], b: string[]): string {
  const have = new Set(b);
  return a.find((x) => !have.has(x)) ?? "";
}

/** Pairs each added line with a removed line of the same block that shares an identifier and differs from it in a number. */
function valueChanges(b: ChangeBlock): ValueChange[] {
  const out: ValueChange[] = [];
  for (const a of b.added) {
    const aIds = new Set(a.text.match(IDENTIFIER) ?? []);
    const aNums = trailLineNumbers(a.text);
    for (const r of b.removed) {
      const name = (r.match(IDENTIFIER) ?? []).find((id) => aIds.has(id) && nameTerms(id).size > 0);
      if (!name) continue;
      const rNums = trailLineNumbers(r);
      const from = firstMissing(rNums, aNums);
      const to = firstMissing(aNums, rNums);
      if (!from || !to) continue;
      out.push({ line: a.new, name, from: Number(from), to: Number(to), fromText: from, toText: to });
      break;
    }
  }
  return out;
}

/** The normalised parts of an identifier that name a thing: `maxRetries` → {maxretry, retry}. */
function nameTerms(name: string): Set<string> {
  return new Set(
    trailTerms(name)
      .filter((t) => !GENERIC_NAME_PARTS.has(t))
      .map(normTerm),
  );
}

/** Whether a sentence is about the identifier. */
function mentionsName(sentence: string, name: string): boolean {
  const set = normTermSet(sentence);
  return [...nameTerms(name)].some((t) => set.has(t));
}

/** A sentence's terms without framing words, normalised. */
function distinctTerms(text: string): string[] {
  return [...new Set(trailTerms(text).filter((t) => !FRAMING_WORDS.has(t)).map(normTerm))];
}

/**
 * The part of a sentence that names the approach, before the reason it was
 * dropped: "A global mutex around the cache: p99 tripled" → "A global mutex
 * around the cache". The reason's words are not in the code that brings it back.
 */
function approachHead(sentence: string): string {
  let cut = sentence.length;
  // ASCII-only lowering keeps the indexes in step with the sentence.
  const lower = sentence.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  for (const sep of [":", ";", " — ", " – ", " - ", " because ", " but ", ", which ", " (", " since "]) {
    const i = lower.indexOf(sep);
    if (i > 0 && i < cut) cut = i;
  }
  return sentence.slice(0, cut);
}

/** The statement's terms the added lines carry, when enough do to say the code is about the same thing: two of a short statement, three of a longer one. */
function wordsMatch(statement: string[], added: Set<string>): { shared: string[]; ok: boolean } {
  const shared = statement.filter((t) => added.has(t));
  return { shared, ok: shared.length >= (statement.length <= 4 ? 2 : 3) };
}

/** The first added line carrying one of the terms, 0 for none. */
function firstLineWith(lines: DiffLine[], terms: string[]): number {
  for (const l of lines) {
    const set = normTermSet(l.text);
    if (terms.some((t) => set.has(t))) return l.new;
  }
  return 0;
}

/**
 * Holds the diff against the candidates with the rules above. One finding per
 * (file, candidate), a conflict winning over a follow; conflicts first, then
 * by file and line; at most 20. Exported for tests.
 */
export function judgeTrailCheck(candidates: Candidate[], diffFiles: DiffFile[]): CheckFinding[] {
  const best = new Map<string, CheckFinding>();
  const put = (file: string, ci: number, f: CheckFinding) => {
    const k = `${file}\0${ci}`;
    const cur = best.get(k);
    if (!cur || (cur.verdict !== "conflict" && f.verdict === "conflict")) best.set(k, f);
  };
  const statements = candidates.map(statementsOf);

  for (const f of diffFiles) {
    const addedTerms = trailDiffTerms(addedText(f), DIFF_TERMS);
    const blocks = changeBlocks(f);
    candidates.forEach((c, ci) => {
      const stmts = statements[ci]!;
      if (stmts.length === 0 || !relevantTo(c, f, addedTerms)) return;
      const finding = (verdict: CheckFinding["verdict"], summary: string, line: number, quote: string): CheckFinding => {
        const out: CheckFinding = {
          file: f.path,
          verdict,
          summary: capWords(summary, SUMMARY_WORDS),
          source: candidateSource(c, capWords(quote, QUOTE_WORDS)),
        };
        if (verdict === "conflict" && line > 0) out.line = line;
        return out;
      };
      for (const b of blocks) {
        // A value changed against a number the team recorded.
        for (const vc of valueChanges(b)) {
          for (const st of stmts) {
            if (st.kind === "other" || !mentionsName(st.text, vc.name)) continue;
            if (st.kind === "watch" || st.kind === "ruledOut") {
              if (trailNumbers(st.text).has(vc.to)) {
                const what = st.kind === "ruledOut" ? "ruled out" : "warned about";
                put(f.path, ci, finding("conflict", `sets ${vc.name} to ${vc.toText}, which ${owner(c)} ${what}`, vc.line, st.text));
              }
              continue;
            }
            const nums = decidedNumbers(st.text);
            if (nums.has(vc.from) && !nums.has(vc.to)) {
              put(f.path, ci, finding("conflict", `changes ${vc.name} from ${vc.fromText} to ${vc.toText}`, vc.line, st.text));
            } else if (nums.has(vc.to)) {
              put(f.path, ci, finding("follows", `sets ${vc.name} to ${vc.toText}, as ${owner(c)} says`, vc.line, st.text));
            }
          }
        }
        const added = normTermSet(b.added.map((l) => `${l.text}\n`).join(""));
        for (const st of stmts) {
          if (st.kind === "ruledOut") {
            // An approach the team ruled out, back in the added lines.
            const m = wordsMatch(distinctTerms(approachHead(st.text)), added);
            if (m.ok) {
              put(
                f.path,
                ci,
                finding("conflict", `brings back ${m.shared.slice(0, 3).join(" ")}, which ${owner(c)} ruled out`, firstLineWith(b.added, m.shared), st.text),
              );
            }
          } else if (st.kind === "decided" || st.kind === "takeaway") {
            if (wordsMatch(distinctTerms(st.text), added).ok) {
              put(f.path, ci, finding("follows", `follows ${owner(c)}: ${st.text.replace(/\.+$/, "")}`, 0, st.text));
            }
          }
        }
      }
    });
  }

  const out = [...best.values()];
  out.sort((a, b) => {
    if ((a.verdict === "conflict") !== (b.verdict === "conflict")) return a.verdict === "conflict" ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
  return out.slice(0, MAX_FINDINGS);
}
