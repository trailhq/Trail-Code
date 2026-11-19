/**
 * Turning a report into code a reader can see.
 *
 * `blast` knows which lines changed (git's hunks) and which symbols reach them
 * (the walk), and both the hosted panel and the PR comment want to SHOW that
 * rather than cite a line number the reader has to go and look up. The shaping
 * lives here so the two surfaces quote the same lines: a comment that disagreed
 * with the page it links to would be worse than one that said less.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence, EvidenceLine } from "../viz/assemble.js";
import type { Impacted, Seed } from "./blast.js";
import type { ChangedFile, DiffLine } from "./diff.js";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Symbols given their own snippet per node. Past this the panel is a file listing
 * rather than a summary — the rest are still counted in the headline. */
export const MAX_EVIDENCE = 4;
/** Lines shown per snippet before it folds. A handful is a hunk you can read at a
 * glance; a 30-line refactor is a diff view's job, not a panel's. */
const MAX_LINES = 6;

/** `L12-L34` → the numbers, so a label is something a reader can type. */
export function spanRange(span: string): { start: number; end: number } | null {
  const m = /^L(\d+)(?:-L(\d+))?$/.exec(span);
  if (!m) return null;
  const start = Number(m[1]);
  return { start, end: m[2] === undefined ? start : Number(m[2]) };
}

function labelFor(name: string, path: string, span: string): string {
  const r = spanRange(span);
  return r ? `${name} · ${path}:${r.start}-${r.end}` : `${name} · ${path}`;
}

/** Keep the first {@link MAX_LINES}, and say how many were left. */
function fold(lines: EvidenceLine[]): { lines: EvidenceLine[]; more?: number } {
  if (lines.length <= MAX_LINES) return { lines };
  return { lines: lines.slice(0, MAX_LINES), more: lines.length - MAX_LINES };
}

const asEvidenceLines = (lines: DiffLine[]): EvidenceLine[] =>
  lines.map((l) => ({ n: l.n, sign: l.sign, text: l.text }));

/**
 * The hunks of `file` that fall inside `span`.
 *
 * A file's diff is split by symbol rather than shown whole, because two unrelated
 * edits in one file are two answers — a panel that merges them makes the reader do
 * the separating.
 */
function hunksIn(
  file: ChangedFile,
  span: { start: number; end: number } | null,
): { lines: EvidenceLine[]; dropped: number } {
  const out: EvidenceLine[] = [];
  let dropped = 0;
  for (const h of file.hunks) {
    if (span && (h.end < span.start || h.start > span.end)) continue;
    out.push(...asEvidenceLines(h.lines));
    dropped += h.dropped;
  }
  return { lines: out, dropped };
}

/** Evidence for one changed symbol: what this PR did to it. */
export function seedEvidence(seed: Seed, file: ChangedFile | undefined): Evidence | null {
  if (!file) return null;
  const span = seed.wholeFile ? null : spanRange(seed.span);
  const { lines, dropped } = hunksIn(file, span);
  if (lines.length === 0 && dropped === 0) return null;
  const folded = fold(lines);
  const more = (folded.more ?? 0) + dropped;
  return {
    label: seed.wholeFile ? seed.path : labelFor(seed.name, seed.path, seed.span),
    note: file.status === "added" ? "new file" : seed.wholeFile ? "outside any symbol" : undefined,
    lines: folded.lines,
    more: more > 0 ? more : undefined,
  };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The first line inside a span that mentions one of `needles`, with its number.
 *
 * This is the whole trick behind "why is this symbol here": the edge says A calls
 * B, and this finds the line where it does it. Shared so `blast`'s panel, its
 * comment and `graft callers` all quote the same line for the same edge.
 */
export function referenceLine(
  path: string,
  span: string,
  needles: RegExp[],
  read: (path: string) => string[] | null,
): { n: number; text: string } | null {
  const range = spanRange(span);
  const lines = read(path);
  if (!range || !lines) return null;
  for (const [i, text] of lines.slice(range.start - 1, range.end).entries()) {
    if (needles.some((re) => re.test(text))) return { n: range.start + i, text };
  }
  return null;
}

/**
 * Every line of `span` in `path` that matches a needle, in file order. Where
 * {@link referenceLine} answers "is there evidence", this answers "how much": a
 * caller that references the symbol on three lines has three call sites, and
 * reporting one of them undercounts (#363).
 */
export function referenceLines(
  path: string,
  span: string,
  needles: RegExp[],
  read: (path: string) => string[] | null,
): { n: number; text: string }[] {
  const range = spanRange(span);
  const lines = read(path);
  if (!range || !lines) return [];
  const out: { n: number; text: string }[] = [];
  for (const [i, text] of lines.slice(range.start - 1, range.end).entries()) {
    if (needles.some((re) => re.test(text))) out.push({ n: range.start + i, text });
  }
  return out;
}

/** A symbol name, matched as a whole word — `export` must not hit `exportViz`. */
export const wordRe = (name: string): RegExp => new RegExp(`\\b${escapeRe(name)}\\b`);

/**
 * Evidence for one dependent symbol: the line that reaches the diff.
 *
 * Nothing changed here, so there is no hunk to show — the useful line is the one
 * naming a changed symbol or module, which answers "why am I in this blast radius
 * at all". Found by reading the symbol's span off disk.
 *
 * When no line names the diff, this returns nothing rather than quoting the span's
 * first line: for a file-level dependent that first line is `/**`, and a panel that
 * shows it has spent a code block to say nothing.
 */
export function impactedEvidence(
  sym: Impacted,
  reach: ReachTerms,
  read: (path: string) => string[] | null,
): Evidence | null {
  // A changed symbol's own name is the strongest signal; a file-level dependent
  // usually reaches the diff through its import line, which names a MODULE
  // instead, so both are tried in that order.
  const byName = referenceLine(sym.path, sym.span, reach.names.map(wordRe), read);
  if (byName) {
    const hit = reach.names.find((n) => wordRe(n).test(byName.text));
    return {
      label: labelFor(sym.name, sym.path, sym.span),
      note: `${sym.relation} ${hit}`,
      lines: [{ n: byName.n, sign: " ", text: byName.text }],
    };
  }

  const byModule = referenceLine(sym.path, sym.span, reach.modules, read);
  if (byModule) {
    return {
      label: labelFor(sym.name, sym.path, sym.span),
      note: sym.relation,
      lines: [{ n: byModule.n, sign: " ", text: byModule.text }],
    };
  }

  // No line names the diff — an indirect reach (a dynamic import, a re-export),
  // or a symbol whose whole file is the span. Quoting its first line means
  // quoting `/**`, so the block is dropped instead: the path stays in `sources`
  // and the panel simply says less.
  return null;
}

/** What a line has to mention to be the line that reaches the diff. */
export interface ReachTerms {
  /** Changed symbol names, longest first. */
  names: string[];
  /** `from "./data.js"` for each changed file, matched on the module specifier so
   * a common stem like `data` cannot match a variable of the same name. */
  modules: RegExp[];
}

export function reachTerms(seeds: Seed[], changed: ChangedFile[]): ReachTerms {
  const names = [...new Set(seeds.filter((s) => !s.wholeFile).map((s) => s.name))].sort((a, b) => b.length - a.length);
  const stems = [...new Set(changed.map((f) => f.path.replace(/\.[^./]+$/, "").split("/").pop() ?? ""))].filter(Boolean);
  return {
    names,
    modules: stems.map((stem) => new RegExp(`["'\`][^"'\`]*\\b${escapeRe(stem)}(\\.[a-z]+)?["'\`]`)),
  };
}

/** Read each file once, and never fail: a snippet is a nicety, and a symbol whose
 * file moved under us must not take the whole page down. */
export function fileReader(root: string | undefined): (path: string) => string[] | null {
  const cache = new Map<string, string[] | null>();
  return (path: string) => {
    if (root === undefined) return null;
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    let lines: string[] | null = null;
    try {
      lines = readFileSync(join(root, path), "utf8").split("\n");
    } catch {
      // Deleted, renamed under us, or unreadable: no snippet, no failure.
      lines = null;
    }
    cache.set(path, lines);
    return lines;
  };
}
