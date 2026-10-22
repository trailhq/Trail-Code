/**
 * Which learnings to show next to a query's results.
 */
import { liveLearnings } from "./learning-fields.js";
import type { Note } from "./notes.js";

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
 * rides along just because it exists. Only live learnings: never one that was
 * retired, is held for a yes, or that a newer learning replaces.
 */
export function findNotes(notes: Note[], query: string, files: string[] = [], limit = 2): NoteHit[] {
  const q = terms(query);
  const hitFiles = new Set(files);
  const out: NoteHit[] = [];
  for (const note of liveLearnings(notes)) {
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
