/**
 * Puts past sessions' notes next to a query's results, for every surface that
 * answers through `Graft.ask` (the CLI's `ask` and the MCP `find_code`).
 */
import type { AskResult } from "../ask/ask.js";
import { findRepoPlace, keepsNotes } from "./home.js";
import { findNotes, listNotes } from "./notes.js";

/** The file part of a hit's `file:Lx-Ly` pointer. */
function pointerFile(pointer: string): string {
  return pointer.replace(/:L\d+(-L?\d+)?$/, "");
}

/** Attach the notes that bear on `r`, in place. A repo that keeps no notes on this machine is left alone. */
export function attachNotes(r: AskResult, repo: string): AskResult {
  findRepoPlace(repo); // a repo whose remote changed finds its notes again
  if (!keepsNotes(repo)) return r;
  r.notesChecked = true;
  const hits = findNotes(listNotes(repo), r.query, r.hits.map((h) => pointerFile(h.pointer)));
  if (hits.length) r.notes = hits;
  return r;
}
