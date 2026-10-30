/**
 * Learnings: one short note per coding session that took real digging.
 *
 * A learning is what a session worked out that the code itself doesn't say:
 * what was decided, what was tried and ruled out, and what to watch out for,
 * plus what it cost to figure out. The next session on the same code reads it
 * before exploring, so nobody pays for it twice.
 *
 * Most learnings are about the code, so they go in the repo's `.trail/learnings/`
 * and are committed with the change (repo-trail.ts): every teammate's agent
 * starts from them, and teammates' pushed branches bring theirs before they
 * merge (branches.ts). A personal one, about one person's setup or habits,
 * stays on their machine in `~/.trail/repos/<repo>/notes/` (home.ts).
 *
 * One file per session and never edited after it's written. A summary only,
 * never a transcript: the agent writes the body, and nothing here reads
 * source files or prompts into it.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { matter, textList, warnSkipped, type FrontMatterFile } from "../util/front-matter.js";
import { readBranchCache } from "./branches.js";
import { tokensLabel, tokensWorthSaying } from "./credit.js";
import type { NoteHit } from "./find-notes.js";
import { flatLine } from "./flatten.js";
import { isAlwaysFollow } from "./units.js";
import { ensureRepoHome, notePlaces, shownPath } from "./home.js";
import { LEARNING_KEYS, learningFileName, liveLearnings, newLearningId, readLearningFields, type LearningFields } from "./learning-fields.js";
import { ensureRepoTrail, LEARNINGS_DIR, learningsDir } from "./repo-trail.js";
import { TOUCH_CHARS, TOUCH_LIMIT } from "./targets.js";

// Where a learning goes, which to show for a query and how one is credited live in their own files.
export { findNotes, type NoteHit } from "./find-notes.js";
export { mentionedFiles, noteTargets, type NoteTarget } from "./targets.js";
export { commitLines, namesLabel, PR_SPEEDUP, setupCommitLine, TOKEN_CREDIT_FLOOR, tokensLabel, tokensWorthSaying } from "./credit.js";

export interface NoteCost {
  minutes?: number;
  tokens?: number;
}

/** A learning. Its id, kind, scope, status and the rest are in `LearningFields`. */
export interface Note extends LearningFields {
  /** Where the note is: an absolute path on this machine. */
  path: string;
  title: string;
  author: string;
  /** YYYY-MM-DD. */
  date: string;
  branch?: string;
  cost?: NoteCost;
  /** `file` or `file#Symbol`, relative to the top of the checkout (or to the folder `listNotes` was asked about). */
  touches: string[];
  body: string;
  /** Written by someone other than whoever is asking. */
  teammate?: boolean;
  /** A rule or preference for every session here, not knowledge about one
   * task: what the user kept having to tell Claude. The session-start hook
   * lists these up front, since no single task would bring them up. */
  standing?: boolean;
  /** The file name of an earlier learning this one takes over from. The old
   * file stays, as the record of what that session knew, but `listNotes`
   * reads this one instead. */
  replaces?: string;
  /** Found on a teammate's pushed branch (`origin/kumar/jitter`) rather than in
   * this checkout. `path` is then `<ref>:.trail/learnings/<name>`, readable
   * with `git show`, and the whole body travels with the note. */
  ref?: string;
  /** The `touches` whose code is gone, so the learning may be stale. Set by
   * `markStale` (stale.ts) on the learnings about to be shown. */
  stale?: string[];
}

/** Which kind of learning to write: for the repo (the default) or for this person only. */
export type LearningScope = "repo" | "personal";

/** The three sections a note is written under. Notes may have others; these are the ones `ask` quotes. */
export const SECTIONS = [
  { key: "decided", heading: "Decided", label: "decided" },
  { key: "ruledOut", heading: "Tried and ruled out", label: "ruled out" },
  { key: "watchOut", heading: "Watch out", label: "watch out" },
] as const;

/* -------------------------------------------------------------------------- */
/* reading and writing one note                                               */
/* -------------------------------------------------------------------------- */

/** A YAML scalar that round-trips: plain when it can be, double-quoted otherwise. */
function scalar(s: string): string {
  return /^[A-Za-z0-9][^:#\n"'{}[\],&*!|>%@`]*$/.test(s) && s.trim() === s ? s : JSON.stringify(s);
}

export function renderNote(n: Omit<Note, "path">): string {
  const fm = ["---", `title: ${scalar(n.title)}`, `author: ${scalar(n.author)}`, `date: ${n.date}`];
  if (n.branch) fm.push(`branch: ${scalar(n.branch)}`);
  const cost: string[] = [];
  if (n.cost?.minutes !== undefined) cost.push(`minutes: ${n.cost.minutes}`);
  if (n.cost?.tokens !== undefined) cost.push(`tokens: ${n.cost.tokens}`);
  if (cost.length) fm.push(`cost: { ${cost.join(", ")} }`);
  if (n.standing) fm.push("standing: true");
  // Evidence is free text, always quoted so YAML never reads "12" back as a number.
  for (const k of LEARNING_KEYS) if (n[k]) fm.push(`${k}: ${k === "evidence" ? JSON.stringify(n[k]) : scalar(n[k]!)}`);
  if (n.touches.length) fm.push("touches:", ...n.touches.map((t) => `  - ${scalar(t)}`));
  fm.push("---", "");
  return `${fm.join("\n")}\n${n.body.trim()}\n`;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Front matter keys that hold one value: a list or a map under one refuses the file. */
const NOTE_SCALARS = ["title", "author", "date", "branch"];

/**
 * A note file, or null when it isn't one (no title in its frontmatter), or
 * when its front matter is refused (anchors, aliases, a list for a title) or
 * isn't valid YAML, which says so once on stderr.
 */
export function parseNote(text: string, path: string): Note | null {
  let parsed: FrontMatterFile;
  try {
    parsed = matter(text, { scalars: NOTE_SCALARS });
  } catch {
    // The parser's own message quotes the file; the warning names it instead.
    warnSkipped("the learning", path, "its front matter isn't valid YAML");
    return null;
  }
  if (parsed.refused) {
    warnSkipped("the learning", path, parsed.refused);
    return null;
  }
  const d = parsed.data as Record<string, unknown>;
  // Title, author and date reach what agents read: one line each (flatten.ts).
  const title = typeof d.title === "string" ? flatLine(d.title) : "";
  if (!title) return null;
  const date = d.date instanceof Date ? d.date.toISOString().slice(0, 10) : flatLine(d.date, 40);
  const cost = (d.cost ?? {}) as Record<string, unknown>;
  const minutes = num(cost.minutes);
  const tokens = num(cost.tokens);
  return {
    path,
    title,
    author: typeof d.author === "string" ? flatLine(d.author, 80) : "",
    date,
    branch: typeof d.branch === "string" ? d.branch : undefined,
    cost: minutes !== undefined || tokens !== undefined ? { minutes, tokens } : undefined,
    touches: textList(d.touches, TOUCH_LIMIT, TOUCH_CHARS),
    body: parsed.content.trim(),
    ...(d.standing === true ? { standing: true } : {}),
    ...readLearningFields(d, learningFileName(path)),
  };
}

/** A touch saved relative to `checkout`, as a path relative to `here`. */
function rebaseTouch(t: string, checkout: string, here: string): string {
  if (checkout === here) return t;
  const [file, ...sym] = t.split("#");
  const rel = relative(here, join(checkout, file!)).split(sep).join("/");
  return [rel, ...sym].join("#");
}

/** Every `.md` in `notesDir` that parses as a note, with touches rebased onto `here`. */
export function readNotesIn(notesDir: string, checkout: string, here: string, scope: LearningScope): Note[] {
  let files: string[];
  try {
    files = readdirSync(notesDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Note[] = [];
  for (const f of files) {
    try {
      const n = parseNote(readFileSync(join(notesDir, f), "utf8"), join(notesDir, f));
      if (n) out.push({ ...n, scope, touches: n.touches.map((t) => rebaseTouch(t, checkout, here)) });
    } catch {
      /* unreadable: skip */
    }
  }
  return out;
}

/** The file name a note is known by, wherever it sits: one learning on a branch and in the tree is one learning. */
export function noteName(n: Note): string {
  return learningFileName(n.path);
}

/**
 * Every learning that bears on the folder `dir`, newest first: the repo's
 * committed ones in `.trail/learnings/`, this person's own in ~/.trail, and
 * the ones on teammates' pushed branches that haven't merged yet (from the
 * branch cache, so nothing here runs git). For a folder that holds several
 * repos, its own and each repo's. Touches come back relative to `dir`, so
 * they line up with a query run there. `children: false` leaves a folder's
 * repos out. One file name is one learning: the working tree's copy wins,
 * then this machine's, then a branch's. Unreadable files are skipped.
 */
export function listNotes(dir: string, opts: { children?: boolean; branches?: boolean } = {}): Note[] {
  const here = resolve(dir);
  const out: Note[] = [];
  const seen = new Set<string>();
  const add = (notes: Note[]) => {
    for (const n of notes) {
      const name = noteName(n);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(n);
    }
  };
  const places = notePlaces(here);
  for (const place of opts.children === false ? places.slice(0, 1) : places) {
    if (place.git) add(readNotesIn(learningsDir(place.checkout), place.checkout, here, "repo"));
    add(readNotesIn(join(place.dir, "notes"), place.checkout, here, "personal"));
    if (place.git && opts.branches !== false) add(branchNotes(place.checkout, here));
  }
  return out.sort((a, b) => (a.date === b.date ? b.path.localeCompare(a.path) : b.date.localeCompare(a.date)));
}

/** The learnings on teammates' pushed branches, from the branch cache. One that won't read is skipped, never the rest. */
function branchNotes(checkout: string, here: string): Note[] {
  const cache = readBranchCache(checkout);
  if (!cache) return [];
  const out: Note[] = [];
  for (const b of cache.branches) {
    for (const l of b.learnings) {
      const where = `${b.ref}:${LEARNINGS_DIR}/${l.name}`;
      try {
        const n = parseNote(l.text, where);
        if (n) out.push({ ...n, scope: "repo", ref: b.ref, touches: n.touches.map((t) => rebaseTouch(t, checkout, here)) });
      } catch (e) {
        warnSkipped("the learning", where, e instanceof Error ? e.message : String(e));
      }
    }
  }
  return out;
}

/** The first line of a section's text, or null when the note has no such section. */
export function sectionLead(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (at === -1) return null;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l.startsWith("## ")) break;
    if (l) return l.replace(/^[-*]\s+/, "");
  }
  return null;
}

/** `Bbox coordinates are off on rotated PDFs` → `bbox-coordinates-are-off-on-rotated`. */
export function slug(s: string, words = 6): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, words)
    .join("-");
}

export interface WriteNoteInput {
  title: string;
  body: string;
  author: string;
  date: string;
  branch?: string;
  cost?: NoteCost;
  touches?: string[];
  standing?: boolean;
  /** The fields a new learning may be given; its id, status and scope come from where it is written. */
  kind?: LearningFields["kind"];
  replaces?: string;
  src?: LearningFields["src"];
  evidence?: string;
  /** Personal only: defaults to this repo. */
  applies?: string;
}

/**
 * Write a new learning for the repo `dir` is in, and return it: into the
 * repo's `.trail/learnings/` (made if needed), or with `scope: "personal"`,
 * or outside git, into ~/.trail. Never overwrites: a second one with the same
 * name on the same day gets `-2`, `-3`. Its id is 8 hex digits from the file
 * name it gets (`newLearningId`), written into the file.
 */
export function writeNote(dir: string, input: WriteNoteInput, scope: LearningScope = "repo"): Note {
  const { place } = ensureRepoHome(dir);
  const inRepo = scope === "repo" && place.git;
  let notes: string;
  if (inRepo) {
    ensureRepoTrail(place.checkout);
    notes = learningsDir(place.checkout);
  } else {
    notes = join(place.dir, "notes");
  }
  const base = [input.date, slug(input.title) || "note", slug(input.author, 1)].filter(Boolean).join("-");
  let name = `${base}.md`;
  for (let i = 2; existsSync(join(notes, name)); i++) name = `${base}-${i}.md`;
  // One line each, as every reader would show them (flatten.ts): what's written reads back the same.
  const note: Omit<Note, "path"> = {
    title: flatLine(input.title),
    author: flatLine(input.author, 80),
    date: input.date,
    branch: input.branch,
    cost: input.cost,
    touches: input.touches ?? [],
    body: input.body,
    ...(input.standing ? { standing: true } : {}),
    ...readLearningFields({ ...input, id: newLearningId(name), scope: inRepo ? "repo" : "personal", applies: inRepo ? undefined : (input.applies ?? place.key), status: "active" }, name),
  };
  writeFileSync(join(notes, name), renderNote(note));
  return { ...note, path: join(notes, name) };
}

/**
 * The standing learnings for `dir`: the team's in the checkout and the
 * person's own, never ones on a teammate's unmerged branch, which nobody has
 * reviewed yet, and only live ones (nothing retired or replaced).
 */
export function standingLearnings(dir: string): Note[] {
  return liveLearnings(listNotes(dir, { branches: false })).filter((n) => n.standing && !n.ref);
}

/** Where a learning is, as the agent and the person read it: `.trail/learnings/x.md`, `~/.trail/…`, or `origin/b:.trail/…`. */
export function notePlace(n: Note): string {
  if (n.ref) return n.path;
  // Windows paths come with backslashes; the place is shown with `/` either way.
  const path = n.path.replace(/\\/g, "/");
  const at = path.lastIndexOf(`/${LEARNINGS_DIR}/`);
  return at === -1 ? shownPath(n.path) : path.slice(at + 1);
}

/* -------------------------------------------------------------------------- */
/* how a note reads inside a query's output                                   */
/* -------------------------------------------------------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-07` → `Oct 7`; anything else as it came. */
export function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/** `took 12 min and ~9.6k tokens to work out`, or null when the note has no cost. */
export function costLabel(cost?: NoteCost): string | null {
  if (!cost) return null;
  const parts: string[] = [];
  if (cost.minutes !== undefined) parts.push(`${cost.minutes} min`);
  if (cost.tokens !== undefined) parts.push(tokensLabel(cost.tokens));
  return parts.length ? `took ${parts.join(" and ")} to work out` : null;
}

/** `'a b'`, with any single quote inside closed, escaped and reopened: safe to paste into a shell. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** What reading a note costs an agent, in tokens: its text at ~4 characters a token. */
export function readingTokens(n: Note): number {
  return Math.ceil(renderNote(n).length / 4);
}

/**
 * What reusing a learning saves: what it took to work out, less what reading
 * it costs. 0 when it carries no token cost, or reading it costs as much.
 */
export function savedByNote(n: Note): number {
  const took = n.cost?.tokens ?? 0;
  return Math.max(0, took - readingTokens(n));
}

/** `Maya's learning`, `a learning`, `Kumar's learning on kumar/jitter`. */
export function whoseLearning(n: Note): string {
  const author = flatLine(n.author, 80);
  const who = author ? `${author}'s learning` : "a learning";
  return n.ref ? `${who} on ${flatLine(n.ref.replace(/^origin\//, ""), 80)}` : who;
}

/**
 * The block `ask` prints above its results: whose learning each is, when,
 * what it was about and what it cost, then the first line of each section and
 * where to read the rest. A learning on a teammate's unmerged branch says so,
 * with the `git show` that prints it, since there's no file here to open. An agent
 * relays the cost when it says what the turn saved, which is how the saving
 * becomes countable. Every field is flattened to one line: a learning's text
 * comes from whoever wrote it, and a line of its own could pass for trail's.
 */
export function formatNoteHits(hits: NoteHit[]): string[] {
  const lines: string[] = [];
  for (const { note } of hits) {
    const author = flatLine(note.author, 80);
    const who = `${author ? `${author}'s learning` : "a learning"}${note.teammate ? ", a teammate's" : ""}`;
    lines.push(`from ${who}${isAlwaysFollow(note) ? " · always follow" : ""} · ${flatLine(shortDate(note.date), 40)} · ${flatLine(note.title)}`);
    if (note.stale?.length) lines.push(`  may be stale  ${staleLine(note)}`);
    const cost = costLabel(note.cost);
    for (const s of SECTIONS) {
      const lead = sectionLead(note.body, s.heading);
      if (lead) lines.push(`  ${s.label.padEnd(11)} ${flatLine(lead, 88)}`);
    }
    if (note.ref) {
      // On a teammate's branch, not reviewed yet: where to read the rest, and that it's unmerged.
      const ref = flatLine(note.ref.replace(/^origin\//, ""), 80);
      lines.push(`  on ${ref}, pushed and not merged yet · git show ${shellQuote(flatLine(note.path, 300))}${cost ? ` · ${cost}` : ""}`);
      lines.push("");
      continue;
    }
    lines.push(`  ${flatLine(notePlace(note), 300)}${cost ? ` · ${cost}` : ""}`);
    lines.push("");
  }
  return lines;
}

/**
 * What to say about a learning `markStale` (stale.ts) flagged: which code it
 * names is gone, and to check it before following it. The names come from the
 * learning's own file, so each is flattened and at most two are named.
 */
export function staleLine(note: Note): string {
  // A gone file's own gone symbol names it already: `a.ts#f`, not `a.ts, a.ts#f`.
  const gone = (note.stale ?? []).filter((t, _, all) => !all.some((o) => o.startsWith(`${t}#`)));
  const named = gone.slice(0, 2).map((t) => flatLine(t, 120)).join(", ") + (gone.length > 2 ? ` and ${gone.length - 2} more` : "");
  return `${named} ${gone.length === 1 ? "is" : "are"} gone from the code. Check it against the code before you follow it; if it no longer holds, save what's true now with trail note --replaces ${note.id}`;
}

/** The line an agent closes its reply with after saving a learning just for the user. */
export const PERSONAL_SAVED_LINE = "📝 Saved just for you · stays on this machine, out of the repo";

/**
 * What starting from these learnings is worth, for the agent's closing line:
 * the tokens they saved, less what reading them costs, when their own
 * measured cost makes that worth saying. Null otherwise: a learning with no
 * measured cost (one kept from `trail init` seconds ago) has earned no claim.
 */
export function learningCredit(hits: NoteHit[]): string | null {
  const saved = hits.reduce((sum, h) => sum + savedByNote(h.note), 0);
  if (!tokensWorthSaying(saved)) return null;
  const minutes = hits.reduce((sum, h) => sum + (h.note.cost?.minutes ?? 0), 0);
  return `saved ${tokensLabel(saved)}${minutes > 0 ? ` and ~${minutes} min` : ""}`;
}

/**
 * The line that credits reused learnings, for `ask` and the agent's closing
 * line: what they took to work out, less what reading them here costs, when
 * their own measured cost makes that worth saying. Null when none were shown
 * or none has earned a claim.
 */
export function learningSavingsLine(hits: NoteHit[]): string | null {
  if (!hits.length) return null;
  const saved = hits.reduce((sum, h) => sum + savedByNote(h.note), 0);
  if (!tokensWorthSaying(saved)) return null;
  const read = hits.reduce((sum, h) => sum + readingTokens(h.note), 0);
  const minutes = hits.reduce((sum, h) => sum + (h.note.cost?.minutes ?? 0), 0);
  const time = minutes > 0 ? ` and ~${minutes} min` : "";
  return `[trail] learnings saved ≈ ${saved.toLocaleString("en-US")} tokens${time} (estimate): what they took to work out, less the ~${read.toLocaleString("en-US")} tokens to read them here.`;
}
