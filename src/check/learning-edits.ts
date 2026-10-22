/**
 * Learnings a branch changed, read as they were where the branch left its
 * base. `trail check` reads those, so rewriting a teammate's learning ("reversed:
 * now 10") can't hide the conflict it records. And an edit to someone else's
 * learning is a finding of its own: theirs stays as written, and a new learning
 * says what changed.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { parseNote, type Note } from "../notes/notes.js";
import { LEARNINGS_DIR } from "../notes/repo-trail.js";
import type { CheckFinding } from "./types.js";

function show(repo: string, ref: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The learnings among `changed` that already existed at `from`, as they were there. */
export function learningsAtBase(repo: string, from: string, changed: string[]): Note[] {
  const out: Note[] = [];
  for (const path of changed) {
    if (!path.startsWith(`${LEARNINGS_DIR}/`) || !path.endsWith(".md")) continue;
    const text = show(repo, from, path);
    const note = text === null ? null : parseNote(text, join(repo, path));
    if (note) out.push({ ...note, scope: "repo" });
  }
  return out;
}

/** `notes` with each learning the branch changed swapped for its version at the base. */
export function withBaseLearnings(notes: Note[], atBase: Note[]): Note[] {
  const byName = new Map(atBase.map((n) => [basename(n.path), n]));
  return notes.map((n) => {
    const base = !n.ref && n.scope !== "personal" ? byName.get(basename(n.path)) : undefined;
    return base ? { ...base, teammate: n.teammate } : n;
  });
}

/** One conflict per teammate's learning the branch edited or removed. */
export function teammateEdits(repo: string, atBase: Note[], me: string): CheckFinding[] {
  return atBase
    .filter((n) => n.author && n.author.toLowerCase() !== me.toLowerCase())
    .map((n) => {
      const file = `${LEARNINGS_DIR}/${basename(n.path)}`;
      const verb = existsSync(join(repo, file)) ? "edits" : "removes";
      return {
        file,
        verdict: "conflict" as const,
        summary: `${verb} ${n.author}'s learning · leave it as it was, and save what changed as a learning of your own with trail note`,
        source: { kind: "note", title: n.title, author: n.author, date: n.date, path: n.path, quote: n.title },
      };
    });
}
