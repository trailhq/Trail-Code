/**
 * Files the walk found but refused to index (today: over the 1 MB cap).
 * Shared wording for `graft build`, `ask`, `grep`, and `skeleton` so a
 * silent drop cannot be rephrased as "the symbol does not exist" (#370).
 */
import type { GraphV1 } from "./types.js";

export type SizeSkip = { path: string; bytes: number; reason: "size" };

export function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  let shown = mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1);
  // The first byte over the cap must not render as "1.0 MB > 1 MB".
  if (bytes > 1_000_000 && shown === "1.0") shown = mb.toFixed(6).replace(/0+$/, "");
  return `${shown} MB`;
}

export function formatSizeSkipLine(s: SizeSkip): string {
  return `skipped ${s.path}: ${formatBytes(s.bytes)} > 1 MB cap`;
}

export function skippedFromGraph(graph: GraphV1 | null | undefined): SizeSkip[] {
  return graph?.meta.skipped ?? [];
}

export function matchSkippedFiles(skipped: SizeSkip[], file: string): SizeSkip[] {
  const want = file.replace(/\\/g, "/");
  const exact = skipped.find((s) => s.path.replace(/\\/g, "/") === want);
  if (exact) return [exact];
  return skipped.filter((s) => {
    const path = s.path.replace(/\\/g, "/");
    return path.endsWith(`/${want}`);
  });
}

export function skippedQueryNote(skipped: SizeSkip[]): string {
  if (skipped.length === 0) return "";
  const shown = skipped.slice(0, 5).map((s) => formatSizeSkipLine(s)).join("; ");
  const more = skipped.length > 5 ? ` (+${skipped.length - 5} more)` : "";
  const verb = skipped.length === 1 ? "was" : "were";
  return `${skipped.length} file${skipped.length === 1 ? "" : "s"} ${verb} skipped for size (${shown}${more})`;
}
