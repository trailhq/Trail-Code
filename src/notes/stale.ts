/**
 * Whether a learning may be stale: code it says it is about is gone.
 *
 * The rule, which Trail Cloud shows as sent at sync (`missing`, workspace-sync.ts):
 * only a learning's `touches:` is judged, entry by entry.
 *   - `path` is gone when the checkout has no file or folder there.
 *   - `path#Symbol` is gone when its path is, or when the file's text no
 *     longer has Symbol as a whole word (for `Type.method`, the last part).
 * One gone entry marks the learning "may be stale". A learning on a teammate's
 * unmerged branch isn't judged: the code it's about may only be on that branch.
 *
 * The file's text rather than the code map: loading the map costs a hook
 * about 0.4s on a big repo, a fresh clone has none, and Trail Cloud has no
 * code at all, so this is the check both can state the same way.
 *
 * Names in a learning's text are left out on purpose. Checked against the code
 * map on 2026-10-29, they flagged 10 of 38 learnings in two repos, and all but
 * one of those names were still in the code: properties, local variables and
 * Node built-ins. `touches:` holds only what existed when the learning was
 * saved, so a miss there is real.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Note } from "./notes.js";

/** A `file#Symbol` touch's symbol name: `Cache.get~2` → `get`. */
function symbolName(sym: string): string {
  return sym.split(".").pop()!.replace(/~\d+$/, "");
}

/** Whether `text` has `name` as a whole word, `$` and `_` counting as word characters. */
function hasWord(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(text);
}

/** The `touches:` entries of `note` whose code is gone from the checkout at `dir`, as written. */
export function goneTouches(note: Note, dir: string): string[] {
  if (note.ref) return [];
  const gone: string[] = [];
  for (const t of note.touches) {
    const [file, sym] = t.split("#");
    if (!file) continue;
    const path = join(dir, file);
    let isGone = !existsSync(path);
    if (!isGone && sym) {
      try {
        isGone = !hasWord(readFileSync(path, "utf8"), symbolName(sym));
      } catch {
        // A folder or an unreadable file: its symbol isn't judged.
      }
    }
    if (isGone) gone.push(t);
  }
  return gone;
}

/** Sets `stale` on each of `notes` that may be stale, in place, and returns them. */
export function markStale<T extends Note>(notes: T[], dir: string): T[] {
  for (const n of notes) {
    const gone = goneTouches(n, dir);
    if (gone.length) n.stale = gone;
    else delete n.stale;
  }
  return notes;
}
