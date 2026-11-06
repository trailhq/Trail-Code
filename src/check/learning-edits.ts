/**
 * Learnings a branch changed, read as they were where the branch left its
 * base. `trail check` reads those, so rewriting a teammate's learning ("reversed:
 * now 10") can't hide the conflict it records. And an edit to someone else's
 * learning is a finding of its own: theirs stays as written, and a new learning
 * says what changed. And only the learnings already on the base branch can
 * fail the check: one saved on this branch hasn't been reviewed yet.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { noteName, parseNote, type Note } from "../notes/notes.js";
import { LEARNINGS_DIR } from "../notes/repo-trail.js";
import type { CheckFinding } from "./types.js";

function show(repo: string, ref: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** A learning file as git names it: `.trail/learnings/<name>.md`, straight in the folder (the only ones read). */
const isLearningPath = (p: string) => p.startsWith(`${LEARNINGS_DIR}/`) && p.endsWith(".md") && !p.slice(LEARNINGS_DIR.length + 1).includes("/");

/** The learning files in `.trail/learnings/` at `from`, read from the top of the repo whatever folder `repo` is. */
function learningPathsAt(repo: string, from: string): string[] {
  try {
    const out = execFileSync("git", ["ls-tree", "--full-tree", "-r", "--name-only", from, "--", LEARNINGS_DIR], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return out.split("\n").filter(isLearningPath);
  } catch {
    return [];
  }
}

/** Most learnings the branch deleted or renamed away that are read back from the base, one `git show` each. */
const GONE_MAX = 100;

/**
 * Whether a learning is the repo's and committed at `from`, where the branch
 * left its base: the only kind `trail check` lets fail. A learning on a
 * teammate's unmerged branch, one just for you, or one added on this branch
 * can't, and when git can't say, none can.
 */
export function committedAtBase(repo: string, from: string): (n: Note) => boolean {
  const names = new Set(learningPathsAt(repo, from).map((p) => basename(p)));
  return (n) => !n.ref && n.scope === "repo" && names.has(noteName(n));
}

/**
 * The learnings that already existed at `from`, as they were there, that the
 * branch changed: the ones among `changed`, and any it deleted or renamed away
 * (git can list a rename by its new name only, so the base is asked what it had).
 */
export function learningsAtBase(repo: string, from: string, changed: string[]): Note[] {
  const paths = new Set(changed.filter((p) => p.startsWith(`${LEARNINGS_DIR}/`) && p.endsWith(".md")));
  const gone = learningPathsAt(repo, from).filter((p) => !paths.has(p) && !existsSync(join(repo, p)));
  for (const p of gone.slice(0, GONE_MAX)) paths.add(p);
  const out: Note[] = [];
  for (const path of paths) {
    const text = show(repo, from, path);
    const note = text === null ? null : parseNote(text, join(repo, path));
    if (note) out.push({ ...note, scope: "repo" });
  }
  return out;
}

/**
 * `notes` with each learning the branch changed swapped for its version at the
 * base, and each one it deleted or renamed away put back as it was there: what
 * the base branch says still holds until the change is merged.
 */
export function withBaseLearnings(notes: Note[], atBase: Note[]): Note[] {
  const byName = new Map(atBase.map((n) => [basename(n.path), n]));
  const swapped = notes.map((n) => {
    const base = !n.ref && n.scope !== "personal" ? byName.get(basename(n.path)) : undefined;
    return base ? { ...base, teammate: n.teammate } : n;
  });
  const inTree = new Set(notes.filter((n) => !n.ref && n.scope !== "personal").map((n) => noteName(n)));
  const gone = atBase.filter((n) => !inTree.has(noteName(n)));
  const goneNames = new Set(gone.map((n) => noteName(n)));
  return [...swapped.filter((n) => !goneNames.has(noteName(n))), ...gone];
}

/** One conflict per teammate's learning the branch edited or removed, naming the id a new learning replaces it by. */
export function teammateEdits(repo: string, atBase: Note[], me: string): CheckFinding[] {
  return atBase
    .filter((n) => n.author && n.author.toLowerCase() !== me.toLowerCase())
    .map((n) => {
      const file = `${LEARNINGS_DIR}/${basename(n.path)}`;
      const verb = existsSync(join(repo, file)) ? "edits" : "removes";
      return {
        file,
        verdict: "conflict" as const,
        summary: `${verb} ${n.author}'s learning · leave it as it was. To record what changed, ask the person first, and only on their yes save it as a new learning with trail note --replaces ${n.id}`,
        source: { kind: "note", title: n.title, author: n.author, date: n.date, path: n.path, quote: n.title },
      };
    });
}
