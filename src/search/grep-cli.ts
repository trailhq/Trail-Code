/**
 * CLI wiring + human formatter for `graft grep`.
 *
 * Kept out of cli.ts (argument wiring only) and out of grep.ts (pure core,
 * unit-testable against hand-built fixture graphs without touching a real
 * repo root) — same split as traverse.ts/traverse-cli.ts. `formatGrepResult`
 * is exported so `graft_find_all` in `src/mcp/tools.ts` renders the identical
 * report, rather than re-implementing it.
 */
import { resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { withSavings } from "../context/savings.js";
import { loadGraphCached } from "../graph/load.js";
import { skippedQueryNote } from "../graph/skipped.js";
import { grepGraph, type GrepGroup, type GrepResult } from "./grep.js";

export interface GrepCliOptions {
  ignoreCase?: boolean;
  fixed?: boolean;
  in?: string;
  json?: boolean;
  /** the top-level `--dir` override, so this command respects it like every other. */
  globalDir?: string;
}

function groupHeader(g: GrepGroup): string {
  if (g.symbol) return `${g.symbol.name} · ${g.symbol.kind} · ${g.symbol.path}:${g.symbol.span} · ${g.inDegree} in-edges`;
  return `${g.path} (module level) · ${g.inDegree} in-edges`;
}

function formatGroup(g: GrepGroup): string {
  const lines = [groupHeader(g)];
  for (const h of g.hits) lines.push(`  L${h.line}: ${h.text}`);
  return lines.join("\n");
}

/** `"<pattern>" — N hits in M symbols across K files (searched T indexed files)` */
export function formatGrepHeader(result: GrepResult): string {
  const filesHit = new Set(result.groups.map((g) => g.path)).size;
  return `"${result.pattern}" — ${result.totalHits} hits in ${result.groups.length} symbols across ${filesHit} files (searched ${result.filesSearched} indexed files)`;
}

/** Loud truncation note — dropped counts are never silent. */
function truncationNote(result: GrepResult): string | null {
  const { files, hits } = result.truncated;
  if (files === 0 && hits === 0) return null;
  const parts: string[] = [];
  if (hits > 0) parts.push(`${hits} more hit${hits === 1 ? "" : "s"} beyond the cap`);
  if (files > 0) parts.push(`${files} indexed file${files === 1 ? "" : "s"} unreadable`);
  return `(truncated: ${parts.join(", ")} — narrow with --in or refine the pattern)`;
}

/** Full human report: header, blank line, then one block per group (header +
 * indented hit lines), each block separated by a blank line. */
export function formatGrepResult(result: GrepResult): string {
  // The truncation note rides directly under the header, not at the bottom:
  // "never silent" has to survive a `head -N` too (same reason the savings
  // line is a header — see withSavings).
  const note = truncationNote(result);
  const head = note ? `${formatGrepHeader(result)}\n${note}` : formatGrepHeader(result);
  const blocks = [head, "", ...result.groups.map((g) => formatGroup(g) + "\n")];
  const out = blocks.join("\n").replace(/\n+$/, "\n");
  return withSavings(out, result.saved);
}

/** Loud, actionable zero-hit note (never a bare empty result) — printed to
 * stderr; the caller still exits 0, since "no hits in the indexed graph" is
 * not an error, just a reason to fall back to a real grep.
 *
 * Truncation is never silent, even on the zero-hit path: if some indexed
 * files couldn't be read (`truncated.files > 0`), that's called out too —
 * otherwise a zero-hit result on a stale graph or wrong root reads as "no
 * matches" when really some files were never searched at all. */
export function zeroHitNote(result: GrepResult): string {
  const base = `no hits for "${result.pattern}" in ${result.filesSearched} indexed files. The pattern may be too specific — retry graft grep with a bare symbol name or short substring (drop the receiver, full signature, and regex anchors). All indexed code was searched; use raw grep -rn only for genuinely unindexed files (docs, configs, brand-new files)`;
  const extras: string[] = [];
  const { files } = result.truncated;
  if (files > 0) extras.push(`${files} indexed file${files === 1 ? "" : "s"} could not be read (stale graph? run graft build)`);
  const sizeNote = skippedQueryNote(result.skipped ?? []);
  if (sizeNote) extras.push(sizeNote);
  if (extras.length === 0) return base;
  return `${base} — note: ${extras.join("; ")}`;
}

/**
 * Resolve the graph at `dir` (respecting `--dir`), run `grepGraph`, and print
 * either the human report or `--json`. Exits the process (code 1) when
 * there's no graph at all or the pattern fails to compile as a regex — both
 * are caller-facing mistakes, not recoverable states. Zero hits is NOT an
 * error: it prints a loud note to stderr and exits 0.
 */
export function runGrepCommand(pattern: string, dir: string, opts: GrepCliOptions): void {
  const root = resolve(dir);
  const contextDir = contextDirFor(root, opts.globalDir);
  const graph = loadGraphCached(contextDir);
  if (!graph) {
    console.error("✗ no graph — run graft build first");
    process.exit(1);
  }

  let result: GrepResult;
  try {
    result = grepGraph(graph, root, pattern, { ignoreCase: opts.ignoreCase, fixed: opts.fixed, in: opts.in });
  } catch (err) {
    // `new RegExp` throws SyntaxError; anything else (an unindexed `--in` prefix)
    // is a different mistake and must not be reported as a bad pattern.
    const message = err instanceof Error ? err.message : String(err);
    console.error(err instanceof SyntaxError ? `✗ invalid pattern "${pattern}": ${message}` : `✗ ${message}`);
    process.exit(1);
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.totalHits === 0) {
    console.error(zeroHitNote(result));
    return;
  }

  process.stdout.write(formatGrepResult(result));
}
