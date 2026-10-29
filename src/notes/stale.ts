/**
 * Whether a learning may be stale: code it says it is about is gone.
 *
 * The rule, which Trail Cloud's check follows too (change both together):
 * only a learning's `touches:` is judged, entry by entry.
 *   - `path` is gone when the checkout has no file there. (The code map is
 *     built from the checkout; a doc or config a learning touches is only on
 *     disk, and reading the map for a file costs a hook ~0.4s on a big repo.)
 *   - `path#Symbol` is gone when its path is, or when no symbol in the code map
 *     has Symbol's name (its last part, after any `.`). A symbol that moved to
 *     another file is still there.
 * One gone entry marks the learning "may be stale". No code map, no symbol is
 * judged. A learning on a teammate's unmerged branch isn't judged at all: the
 * code it's about may only be on that branch.
 *
 * Names in a learning's text are left out on purpose. Checked against the code
 * map on 2026-10-29, they flagged 10 of 38 learnings in two repos, and all but
 * one of those names were still in the code: properties, local variables and
 * Node built-ins, which the code map doesn't list as symbols. `touches:` holds
 * only what existed when the learning was saved, so a miss there is real.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../graph/load.js";
import type { GraphV1 } from "../graph/types.js";
import type { Note } from "./notes.js";

const symbolNames = new WeakMap<GraphV1, Set<string>>();

/** Every symbol name in `dir`'s code map, or null when there's no map. */
function codeMapNames(dir: string): Set<string> | null {
  const graph = loadGraphCached(contextDirFor(dir));
  if (!graph) return null;
  let names = symbolNames.get(graph);
  if (!names) {
    names = new Set(graph.nodes.filter((n) => n.kind !== "file").map((n) => n.name));
    symbolNames.set(graph, names);
  }
  return names;
}

/** A `file#Symbol` touch's symbol name: `Cache.get~2` → `get`. */
function symbolName(sym: string): string {
  return sym.split(".").pop()!.replace(/~\d+$/, "");
}

/**
 * The `touches:` entries of `note` whose code is gone, as written. `names`
 * is read only when a symbol needs looking up.
 */
export function goneTouches(note: Note, dir: string, names: () => Set<string> | null = () => codeMapNames(dir)): string[] {
  if (note.ref) return [];
  const gone: string[] = [];
  for (const t of note.touches) {
    const [file, sym] = t.split("#");
    if (!file) continue;
    let isGone = !existsSync(join(dir, file));
    if (!isGone && sym) {
      const known = names();
      isGone = !!known && !known.has(symbolName(sym));
    }
    if (isGone) gone.push(t);
  }
  return gone;
}

/**
 * Sets `stale` on each of `notes` that may be stale, in place, and returns
 * them. Call it on the learnings about to be shown, not on every one: the code
 * map is read at most once, and only when a shown learning names a symbol.
 */
export function markStale<T extends Note>(notes: T[], dir: string): T[] {
  let read = false;
  let names: Set<string> | null = null;
  const lazy = () => {
    if (!read) {
      read = true;
      try {
        names = codeMapNames(dir);
      } catch {
        names = null;
      }
    }
    return names;
  };
  for (const n of notes) {
    const gone = goneTouches(n, dir, lazy);
    if (gone.length) n.stale = gone;
    else delete n.stale;
  }
  return notes;
}
