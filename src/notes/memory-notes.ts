/**
 * Learnings from the notes Claude Code keeps for this repo on this machine
 * (`~/.claude/projects/<folder>/memory/*.md`), for `trail init` to offer on
 * day one. Those notes are Claude's own memory of the repo: what it was told
 * about the project, where things are, how the person likes to work. They
 * never leave this machine, so a teammate's Claude starts without them.
 *
 * No model reads them: each note is already short and written for Claude.
 * trail keeps a project or reference note as a team learning only when it
 * names code that exists now and the repo doesn't already say it; the rest,
 * and the person's feedback notes, are offered as their own. Notes about the
 * person (`user`) are never offered. Anything that looks like a secret is
 * scrubbed, and a note that still looks like one is skipped.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { countBucket } from "../telemetry/contract.js";
import { track } from "../telemetry/track.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { sameRepoRoots, scrub } from "./cold-start.js";
import { noteAuthor } from "./git-facts.js";
import { ensureRepoHome } from "./home.js";
import { shortDate, writeNote, type Note } from "./notes.js";
import { claudeProjectDir } from "./session-cost.js";
import { alreadySaid, codeAnchors, knownText } from "./team-check.js";

export type MemoryType = "project" | "reference" | "feedback" | "user" | "other";

/** One of Claude Code's memory notes, as written. */
export interface MemoryNote {
  /** Absolute path of the note. */
  path: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** YYYY-MM-DD it was last changed. */
  updated: string;
}

/** A memory note as `trail init` offers it. */
export interface MemoryCandidate {
  title: string;
  /** Markdown under `## Decided` and maybe `## Watch out`, secrets scrubbed. */
  body: string;
  /** Tied to code that exists now and not already said: offered for the team, ticked. */
  forTeam: boolean;
  touches: string[];
  /** The note it came from, for the once-per-note mark; `claude.ai:<hash>` for a fact of a Claude.ai export. */
  path: string;
  updated: string;
  /** A fact of a memory export the person pasted from Claude.ai (claude-export.ts), not one of Claude Code's notes. */
  from?: "claude.ai";
}

const BODY_CHARS = 1500;

/* -------------------------------------------------------------------------- */
/* Reading the notes                                                          */
/* -------------------------------------------------------------------------- */

/** The memory folders of this repo's checkouts on this machine: its own, its worktrees', and other clones'. */
export function memoryDirs(repo: string, home: string = homedir()): string[] {
  return [...new Set(sameRepoRoots(repo, home).map((r) => join(claudeProjectDir(r, home), "memory")))];
}

/** The value of `key:` in a frontmatter block, top level or under `metadata:`, unquoted. */
function field(front: string, key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*(.*)$`, "m").exec(front);
  if (!m) return "";
  const v = m[1]!.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try {
      return v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

const TYPES: MemoryType[] = ["project", "reference", "feedback", "user"];

/** One memory note, or null when it isn't one (no frontmatter, empty, the MEMORY.md index). */
export function readMemoryNote(path: string): MemoryNote | null {
  if (basename(path) === "MEMORY.md") return null;
  let text: string;
  let updated: string;
  try {
    text = readFileSync(path, "utf8");
    updated = statSync(path).mtime.toISOString().slice(0, 10);
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const front = m[1]!;
  const body = m[2]!.trim();
  if (!body) return null;
  const raw = field(front, "type").toLowerCase() as MemoryType;
  const modified = /^\d{4}-\d{2}-\d{2}/.exec(field(front, "modified"))?.[0];
  return {
    path,
    name: field(front, "name") || basename(path, ".md"),
    description: field(front, "description"),
    type: TYPES.includes(raw) ? raw : "other",
    body,
    updated: modified ?? updated,
  };
}

/** Every memory note of the repo's checkouts on this machine, newest first. */
export function memoryNotes(repo: string, home: string = homedir()): MemoryNote[] {
  const out: MemoryNote[] = [];
  for (const dir of memoryDirs(repo, home)) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const note = readMemoryNote(join(dir, f));
      if (note) out.push(note);
    }
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

/* -------------------------------------------------------------------------- */
/* As learnings                                                               */
/* -------------------------------------------------------------------------- */

/** A title a person reads: the note's name when it's words, else its description's first clause. */
export function memoryTitle(note: Pick<MemoryNote, "name" | "description">): string {
  const words = /\s/.test(note.name.trim()) ? note.name.trim() : "";
  const first = note.description.split(/(?<=[a-z0-9)`])\.\s|;\s| — | -- /)[0]!.trim();
  let t = words || first || note.name.replace(/[-_]+/g, " ");
  t = t.replace(/\.$/, "");
  if (t.length > 90) t = `${t.slice(0, 89).replace(/\s+\S*$/, "")}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** `[[name]]` links to other memory notes read as plain words outside Claude's memory. */
function unlink(s: string): string {
  return s.replace(/\[\[([^\]]+)\]\]/g, "$1");
}

/** At most `max` characters, cut at a paragraph or line break when there is one. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n"));
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}\n…`;
}

/**
 * A memory note's body as a learning's: what it says, with its **Why:**,
 * under `## Decided`; its **How to apply:** under `## Watch out`. Its own
 * headings become bold lines so they don't break the learning's sections.
 */
export function memoryBody(note: Pick<MemoryNote, "body">): string {
  const text = unlink(note.body).replace(/^#{1,6}\s+(.+)$/gm, "**$1**");
  const split = /\*\*How to apply:?\*\*:?/i.exec(text);
  const decided = (split ? text.slice(0, split.index) : text).trim();
  const apply = split ? text.slice(split.index + split[0].length).trim() : "";
  let out = `## Decided\n${clip(decided, BODY_CHARS)}`;
  if (apply) out += `\n\n## Watch out\n${clip(apply, 600)}`;
  return scrub(out);
}

/**
 * A short fact with its reason, not a work log. Status write-ups, and long
 * notes with no **Why:**, stay in Claude's memory: as a learning they'd read
 * as a diary, and be wrong by next week.
 */
export function readsAsLearning(body: string): boolean {
  if (/\*\*Status\b|^Status:|Shipped on branch|SLA breach|\bnot merged yet\b/im.test(body)) return false;
  return body.split(/\s+/).filter(Boolean).length <= 150 || /\*\*Why:?\*\*/i.test(body);
}

/** Still looks like a credential after scrubbing, or names where one lives: not worth the risk of committing. */
export const SECRETISH = /\b(?:AWS_SECRET_ACCESS_KEY|PRIVATE KEY|client_secret|BEGIN OPENSSH)\b|\[redacted\]/;

/**
 * What `trail init` offers from Claude Code's memory of this repo, for the
 * team: project and reference notes that read as a learning, are tied to code
 * that exists now, and aren't already said. Notes offered before and
 * unchanged since are left out.
 */
export function memoryCandidates(repo: string, opts: { home?: string; offered?: Set<string> } = {}): MemoryCandidate[] {
  const known = knownText(repo);
  const team: MemoryCandidate[] = [];
  const titles = new Set<string>();
  for (const note of memoryNotes(repo, opts.home)) {
    // Only what the team can use: Claude already reads the rest of its memory
    // on this machine, so offering it again as a personal learning repeats it.
    if (note.type !== "project" && note.type !== "reference") continue;
    if (opts.offered?.has(offerKey(note))) continue;
    if (!readsAsLearning(note.body)) continue;
    const title = memoryTitle(note);
    const key = title.toLowerCase();
    if (titles.has(key)) continue;
    const body = memoryBody(note);
    if (SECRETISH.test(body)) continue;
    if (alreadySaid(known, title, body)) continue;
    titles.add(key);
    const touches = codeAnchors(repo, `${note.description}\n${note.body}`);
    if (!touches.length) continue;
    team.push({ title, body, forTeam: true, touches, path: note.path, updated: note.updated });
  }
  return team;
}

/** A note is offered again only once it changes; a Claude.ai fact's key is already its words. */
function offerKey(note: { path: string; updated: string; from?: "claude.ai" }): string {
  return note.from ? note.path : `${note.path}@${note.updated}`;
}

/** Where a repo remembers which memory notes init offered, on this machine. */
function offeredMark(repo: string): string {
  return join(ensureRepoHome(repo).place.dir, "memory-notes.json");
}

/** The memory notes init offered in this repo before, unchanged since. */
export function offeredBefore(repo: string): Set<string> {
  return new Set(readJson<{ offered?: string[] }>(offeredMark(repo))?.offered ?? []);
}

/** Each kept candidate as a learning: the team's in `.trail/learnings/`, the person's own in ~/.trail. */
export function saveMemoryCandidates(repo: string, kept: MemoryCandidate[], author = noteAuthor(repo), date = new Date().toISOString().slice(0, 10)): Note[] {
  return kept.map((c) =>
    writeNote(
      repo,
      {
        title: c.title,
        author,
        date,
        body: `${c.body.trim()}\n\n_${c.from ? "From your Claude.ai memory, as of" : "From Claude Code's memory of this repo, last updated"} ${shortDate(c.updated)}._`,
        touches: c.touches,
      },
      c.forTeam ? "repo" : "personal",
    ),
  );
}

/**
 * Save the candidates the person keeps and remember every one was offered.
 * Without `keep` (no terminal to ask on), the team ones are kept: the
 * person's own are already in their Claude's memory. A Claude.ai export's
 * facts are kept too, just for them: they passed the export, and Claude Code
 * never reads it. `keep` resolving null means they cancelled: nothing is
 * saved or marked, and the next init asks again.
 */
export async function finishMemoryRead(
  repo: string,
  candidates: MemoryCandidate[],
  keep?: (candidates: MemoryCandidate[]) => Promise<MemoryCandidate[] | null>,
  source: "memory" | "claude_ai" = "memory",
): Promise<{ saved: Note[]; kept: MemoryCandidate[]; cancelled: boolean }> {
  const chosen = candidates.length && keep ? await keep(candidates) : candidates.filter((c) => c.forTeam || c.from);
  const kept = chosen ?? [];
  const saved = kept.length ? saveMemoryCandidates(repo, kept) : [];
  if (chosen !== null && candidates.length) {
    const offered = offeredBefore(repo);
    for (const c of candidates) offered.add(offerKey(c));
    writeJsonAtomic(offeredMark(repo), { at: Date.now(), offered: [...offered] }, true);
  }
  const team = candidates.filter((c) => c.forTeam);
  track(
    "cold_start",
    {
      source,
      outcome: chosen === null ? "cancelled" : candidates.length ? "found" : "none_found",
      offered_bucket: countBucket(candidates.length),
      picked_bucket: countBucket(saved.length),
      team_offered_bucket: countBucket(team.length),
      team_picked_bucket: countBucket(kept.filter((c) => c.forTeam).length),
    },
    { repo },
  );
  return { saved, kept, cancelled: chosen === null };
}
