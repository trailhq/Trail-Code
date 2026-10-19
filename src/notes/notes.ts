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
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { matter, type FrontMatterFile } from "../util/front-matter.js";
import { readBranchCache } from "./branches.js";
import { changedFiles, ownPath } from "./git-facts.js";
import { checkoutRoot, childCheckouts, ensureRepoHome, notePlaces, repoPlace, shownPath } from "./home.js";
import { ensureRepoTrail, LEARNINGS_DIR, learningsDir } from "./repo-trail.js";

export interface NoteCost {
  minutes?: number;
  tokens?: number;
}

export interface Note {
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
  /** `repo`: in the repo's `.trail/learnings/`, for everyone. `personal`: in ~/.trail, this machine only. */
  scope?: "repo" | "personal";
  /** A rule or preference for every session here, not knowledge about one
   * task: what the user kept having to tell Claude. The session-start hook
   * lists these up front, since no single task would bring them up. */
  standing?: boolean;
  /** Found on a teammate's pushed branch (`origin/kumar/jitter`) rather than in
   * this checkout. `path` is then `<ref>:.trail/learnings/<name>`, readable
   * with `git show`, and the whole body travels with the note. */
  ref?: string;
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
  if (n.touches.length) fm.push("touches:", ...n.touches.map((t) => `  - ${scalar(t)}`));
  fm.push("---", "");
  return `${fm.join("\n")}\n${n.body.trim()}\n`;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A note file, or null when it isn't one (no title in its frontmatter). */
export function parseNote(text: string, path: string): Note | null {
  let parsed: FrontMatterFile;
  try {
    parsed = matter(text);
  } catch {
    return null;
  }
  const d = parsed.data as Record<string, unknown>;
  if (typeof d.title !== "string" || !d.title.trim()) return null;
  const date = d.date instanceof Date ? d.date.toISOString().slice(0, 10) : String(d.date ?? "");
  const cost = (d.cost ?? {}) as Record<string, unknown>;
  const minutes = num(cost.minutes);
  const tokens = num(cost.tokens);
  return {
    path,
    title: d.title.trim(),
    author: typeof d.author === "string" ? d.author : "",
    date,
    branch: typeof d.branch === "string" ? d.branch : undefined,
    cost: minutes !== undefined || tokens !== undefined ? { minutes, tokens } : undefined,
    touches: Array.isArray(d.touches) ? d.touches.map(String) : [],
    body: parsed.content.trim(),
    ...(d.standing === true ? { standing: true } : {}),
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
function readNotesIn(notesDir: string, checkout: string, here: string, scope: LearningScope): Note[] {
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
  return n.path.slice(Math.max(n.path.lastIndexOf("/"), n.path.lastIndexOf(":")) + 1);
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

/** The learnings on teammates' pushed branches, from the branch cache. */
function branchNotes(checkout: string, here: string): Note[] {
  const cache = readBranchCache(checkout);
  if (!cache) return [];
  const out: Note[] = [];
  for (const b of cache.branches) {
    for (const l of b.learnings) {
      const n = parseNote(l.text, `${b.ref}:${LEARNINGS_DIR}/${l.name}`);
      if (n) out.push({ ...n, scope: "repo", ref: b.ref, touches: n.touches.map((t) => rebaseTouch(t, checkout, here)) });
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
}

/**
 * Write a new learning for the repo `dir` is in, and return it: into the
 * repo's `.trail/learnings/` (made if needed), or with `scope: "personal"`,
 * or outside git, into ~/.trail. Never overwrites: a second one with the same
 * name on the same day gets `-2`, `-3`.
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
  const note: Omit<Note, "path"> = {
    title: input.title.trim(),
    author: input.author,
    date: input.date,
    branch: input.branch,
    cost: input.cost,
    touches: input.touches ?? [],
    body: input.body,
    scope: inRepo ? "repo" : "personal",
    ...(input.standing ? { standing: true } : {}),
  };
  writeFileSync(join(notes, name), renderNote(note));
  return { ...note, path: join(notes, name) };
}

/**
 * The standing learnings for `dir`: the team's in the checkout and the
 * person's own, never ones on a teammate's unmerged branch, which nobody has
 * reviewed yet.
 */
export function standingLearnings(dir: string): Note[] {
  return listNotes(dir, { branches: false }).filter((n) => n.standing && !n.ref);
}

/** Where a learning is, as the agent and the person read it: `.trail/learnings/x.md`, `~/.trail/…`, or `origin/b:.trail/…`. */
export function notePlace(n: Note): string {
  if (n.ref) return n.path;
  // Windows paths come with backslashes; the place is shown with `/` either way.
  const path = n.path.replace(/\\/g, "/");
  const at = path.lastIndexOf(`/${LEARNINGS_DIR}/`);
  return at === -1 ? shownPath(n.path) : path.slice(at + 1);
}

export interface NoteTarget {
  /** A folder in the repo the note goes to. */
  dir: string;
  /** What the session touched there, relative to the top of that checkout. */
  touches: string[];
}

/** Most files one note lists per repo. */
const TOUCH_LIMIT = 10;

/**
 * Which repos a session's note belongs in, and what it touched in each.
 *
 * The repo the note was saved from gets the files it has uncommitted or
 * committed since `since`. Every other repo the session edited (`edited`:
 * absolute paths, from the agent's transcript) gets the note too, with its
 * own files, so a session that changed a backend and the library it calls
 * leaves a note in both. Saved from a folder that holds several repos, the
 * note goes to each repo the session changed, or stays with the folder when
 * it changed none. Two worktrees of one repo are one repo.
 */
export function noteTargets(dir: string, edited: string[] = [], since?: number): NoteTarget[] {
  const here = repoPlace(dir);
  const byKey = new Map<string, { dir: string; files: string[] }>();
  const add = (checkout: string, files: string[]) => {
    const key = repoPlace(checkout).key;
    const entry = byKey.get(key) ?? { dir: checkout, files: [] };
    for (const f of files) if (f && !ownPath(f) && !entry.files.includes(f)) entry.files.push(f);
    byKey.set(key, entry);
  };
  if (here.git) add(here.checkout, changedFiles(here.checkout, since));
  else if (edited.length === 0) for (const c of childCheckouts(here.checkout)) add(c, changedFiles(c, since));
  // The agent's own files (memory, plans, scratch under ~/.claude) aren't what a note is about.
  const agentFiles = join(homedir(), ".claude") + sep;
  for (const f of edited) {
    if (f.startsWith(agentFiles)) continue;
    const top = checkoutRoot(dirname(f));
    if (top) add(top, [relative(top, f).split(sep).join("/")]);
    else if (!here.git && !relative(here.checkout, f).startsWith("..")) add(here.checkout, [relative(here.checkout, f).split(sep).join("/")]);
  }
  const out = [...byKey.entries()]
    .filter(([key, e]) => e.files.length > 0 || key === here.key)
    .map(([, e]) => ({ dir: e.dir, touches: e.files.slice(0, TOUCH_LIMIT) }));
  // The repo it was saved from first; a folder of repos only when nothing else was touched.
  out.sort((a, b) => Number(repoPlace(b.dir).key === here.key) - Number(repoPlace(a.dir).key === here.key));
  const touched = out.filter((t) => t.touches.length > 0);
  if (!here.git && touched.length > 0) return touched;
  return out.length ? out : [{ dir: here.checkout, touches: [] }];
}

/** A path-shaped word in a note: `client.go`, `src/a/b.ts:12-30`, `x.go#Fn`. */
const MENTION = /(?:^|[\s(`'"\[])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?=$|[\s:#)`'",.;\]])/gm;

/**
 * Files of the checkout at `dir` that a note's text names by path. A session
 * that only read code edits nothing, so without these its note would touch no
 * file, and nothing that looks a note up by file (`trail check`, the ranked
 * search) would ever find it.
 */
export function mentionedFiles(dir: string, body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION)) {
    const f = m[1]!.replace(/^\.\//, "");
    if (out.includes(f) || ownPath(f) || f.startsWith("..")) continue;
    if (existsSync(join(dir, f))) out.push(f);
    if (out.length >= TOUCH_LIMIT) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* finding the notes that matter for a query                                  */
/* -------------------------------------------------------------------------- */

const STOP = new Set(
  "the and for with from that this what when where which into does how why are was were not but you your our out its it's can should would could about after before over under use using used fix find make".split(
    " ",
  ),
);

function terms(s: string): string[] {
  return [...new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 3 && !STOP.has(t)))];
}

/** The file part of a `file#Symbol` touch. */
function touchFile(t: string): string {
  return t.split("#")[0]!;
}

export interface NoteHit {
  note: Note;
  score: number;
  /** Files the note touches that this query's results also point into. */
  shared: string[];
}

/**
 * The notes worth showing next to a query's results: ones whose title or body
 * share the query's words, or that touch a file the results point into. At
 * most `limit`, best first. A note has to clear a bar — two of the query's
 * words, or one in its title, or a shared file — so an unrelated note never
 * rides along just because it exists.
 */
export function findNotes(notes: Note[], query: string, files: string[] = [], limit = 2): NoteHit[] {
  const q = terms(query);
  const hitFiles = new Set(files);
  const out: NoteHit[] = [];
  for (const note of notes) {
    const title = new Set(terms(note.title));
    const text = new Set(terms(`${note.body} ${note.touches.join(" ")}`));
    let score = 0;
    let matched = 0;
    for (const t of q) {
      if (title.has(t)) {
        score += 3;
        matched++;
      } else if (text.has(t)) {
        score += 1;
        matched++;
      }
    }
    const shared = [...new Set(note.touches.map(touchFile))].filter((f) => hitFiles.has(f));
    score += shared.length * 4;
    const clears = shared.length > 0 || matched >= 2 || [...title].some((t) => q.includes(t));
    if (clears && score >= 3) out.push({ note, score, shared });
  }
  return out.sort((a, b) => b.score - a.score || b.note.date.localeCompare(a.note.date)).slice(0, limit);
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

/** `~9.6k tokens`, `~600 tokens`. */
export function tokensLabel(n: number): string {
  if (n >= 1000) return `~${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k tokens`;
  return `~${n} tokens`;
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

function clip(s: string, n = 88): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
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

/** `Anirudh's learning`, `a learning`, `Kumar's learning on kumar/jitter`. */
export function whoseLearning(n: Note): string {
  const who = n.author ? `${n.author}'s learning` : "a learning";
  return n.ref ? `${who} on ${n.ref.replace(/^origin\//, "")}` : who;
}

/**
 * The block `ask` prints above its results: whose learning each is, when,
 * what it was about and what it cost, then the first line of each section and
 * where to read the rest. A learning on a teammate's unmerged branch says so,
 * with the `git show` that prints it, since there's no file here to open. An agent
 * relays the cost when it says what the turn saved, which is how the saving
 * becomes countable.
 */
export function formatNoteHits(hits: NoteHit[]): string[] {
  const lines: string[] = [];
  for (const { note } of hits) {
    const who = `${note.author ? `${note.author}'s learning` : "a learning"}${note.teammate ? ", a teammate's" : ""}`;
    lines.push(`from ${who} · ${shortDate(note.date)} · ${note.title}`);
    const cost = costLabel(note.cost);
    for (const s of SECTIONS) {
      const lead = sectionLead(note.body, s.heading);
      if (lead) lines.push(`  ${s.label.padEnd(11)} ${clip(lead)}`);
    }
    if (note.ref) {
      // On a teammate's branch, not reviewed yet: where to read the rest, and that it's unmerged.
      lines.push(`  on ${note.ref.replace(/^origin\//, "")}, pushed and not merged yet · git show ${shellQuote(note.path)}${cost ? ` · ${cost}` : ""}`);
      lines.push("");
      continue;
    }
    lines.push(`  ${notePlace(note)}${cost ? ` · ${cost}` : ""}`);
    lines.push("");
  }
  return lines;
}

/** The line an agent closes its reply with after saving a learning just for the user. */
export const PERSONAL_SAVED_LINE = "📝 Saved just for you · stays on this machine, out of the repo";

/** `Anay`, `Anay and Rushil`, `Anay, Rushil and 3 others`. */
export function namesLabel(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** `48k`, `3.8k`, `600`. */
function tokensShort(n: number): string {
  return tokensLabel(n).replace(/^~/, "").replace(" tokens", "");
}

/** What starting from a teammate's learning is worth when its tokens are too few to say: time to a PR. */
export const PR_SPEEDUP = "3x faster";

/**
 * Below this many tokens, what a learning saves is too small a number to
 * impress, so trail credits it as a faster PR instead.
 */
export const TOKEN_CREDIT_FLOOR = 80_000;

/** Whether a token count is big enough to be the credit. */
export function tokensWorthSaying(tokens: number | undefined): boolean {
  return (tokens ?? 0) >= TOKEN_CREDIT_FLOOR;
}

/**
 * The lines that close a reply after a team learning is saved, one for each
 * way the turn can end, since only the agent knows whether it committed the
 * learning by then. Uncommitted, it makes the case for committing: who else
 * works on the same files, and the head start their agents would get, which
 * is what the learning took to work out, or a faster PR when that's small.
 */
export function commitLines(
  note: Pick<Note, "cost">,
  teammates: string[],
  where: "files" | "repo" = "files",
): { committed: string; uncommitted: string } {
  const tokens = note.cost?.tokens;
  const short = tokensWorthSaying(tokens) ? tokensShort(tokens!) : null;
  // "an 80k-token", "an 11k-token": said aloud, they start with a vowel.
  const start = short ? `${/^8|^1[18]k$/.test(short) ? "an" : "a"} ${short}-token head start` : null;
  const place = where === "files" ? "this part of the codebase" : "this repo";
  if (!teammates.length) {
    return start
      ? {
          committed: `📝 Committed · your teammates' agents now get ${start}`,
          uncommitted: `🌱 Commit what you learned and give your teammates' agents ${start}`,
        }
      : {
          committed: `📝 Committed · your teammates' agents now get to a PR ${PR_SPEEDUP}`,
          uncommitted: `🌱 Commit what you learned and your teammates' agents get to a PR ${PR_SPEEDUP}`,
        };
  }
  const who = namesLabel(teammates);
  const work = teammates.length === 1 ? "works" : "work";
  return start
    ? {
        committed: `📝 Committed · ${who} ${work} in ${place}, and their agents now get ${start}`,
        uncommitted: `🌱 ${who} ${work} in ${place}. Commit what you learned and give their agents ${start}`,
      }
    : {
        committed: `📝 Committed · ${who} ${work} in ${place}, and their agents now get to a PR ${PR_SPEEDUP}`,
        uncommitted: `🌱 ${who} ${work} in ${place}. Commit what you learned and their agents get to a PR ${PR_SPEEDUP}`,
      };
}

/**
 * The line asking for trail's shared setup to be committed, once: `.trail/`
 * and the SessionStart entry in `.claude/settings.json` are what let a
 * teammate's Claude read the learnings before they install anything.
 */
export function setupCommitLine(teammates: string[]): string {
  const ask = "Commit .trail/ and .claude/settings.json once";
  if (!teammates.length) return `🌱 ${ask}, and your teammates' Claude starts from your learnings, even before they install trail`;
  const work = teammates.length === 1 ? "works" : "work";
  return `🌱 ${namesLabel(teammates)} ${work} in this repo. ${ask}, and their Claude starts from your learnings, even before they install trail`;
}

/**
 * What starting from these learnings is worth, for the agent's closing line:
 * the tokens they saved, less what reading them costs, when that's worth
 * saying, otherwise a faster PR.
 */
export function learningCredit(hits: NoteHit[]): string {
  const saved = hits.reduce((sum, h) => sum + savedByNote(h.note), 0);
  if (!tokensWorthSaying(saved)) return `${PR_SPEEDUP} to a PR`;
  const minutes = hits.reduce((sum, h) => sum + (h.note.cost?.minutes ?? 0), 0);
  return `saved ${tokensLabel(saved)}${minutes > 0 ? ` and ~${minutes} min` : ""}`;
}

/**
 * The line that credits reused learnings, for `ask` and the agent's closing
 * line: what they took to work out, less what reading them here costs, when
 * that's worth saying, otherwise a faster PR. Null when none were shown.
 */
export function learningSavingsLine(hits: NoteHit[]): string | null {
  if (!hits.length) return null;
  const saved = hits.reduce((sum, h) => sum + savedByNote(h.note), 0);
  if (!tokensWorthSaying(saved)) return `[trail] starting from ${hits.length === 1 ? "this learning" : "these learnings"} gets you to a PR ${PR_SPEEDUP}.`;
  const read = hits.reduce((sum, h) => sum + readingTokens(h.note), 0);
  const minutes = hits.reduce((sum, h) => sum + (h.note.cost?.minutes ?? 0), 0);
  const time = minutes > 0 ? ` and ~${minutes} min` : "";
  return `[trail] learnings saved ≈ ${saved.toLocaleString("en-US")} tokens${time} (estimate): what they took to work out, less the ~${read.toLocaleString("en-US")} tokens to read them here.`;
}
