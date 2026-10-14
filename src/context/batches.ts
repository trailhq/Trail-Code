/**
 * How the concept pass cuts its synthesis batches, and what each one is cached under.
 *
 * Every batch is one LLM call, and its result is cached under a key derived from the
 * files the call saw and the model the call runs under. So a boundary that moves is a
 * re-synthesis — a metered call the user pays for again — which makes the cut rule,
 * not the call itself, the thing that decides what a `--deep` build costs after an edit.
 *
 * The cut is a function of the file PATHS: a batch ends at the first file whose own
 * path hash matches a mask, never at a size. Cut by running size, one summary growing
 * by a sentence moves every later boundary, every later batch lands on a different set
 * of files, and so every later key changes and the next build re-synthesizes most of
 * the graph. Sizes are consulted in exactly two places, neither of which is a
 * boundary: the stride (how many files to expect per batch) and a batch that
 * overshoots the budget anyway, which is cut inside itself.
 *
 * One honest cost, stated here where the invariant lives: that locality holds at
 * the budget a plan was cut under, and only while the edited batch still fits it.
 * A `--synth-batch-chars` budget smaller than the batch an edit lands in
 * overflows it, and the overflow is cut greedily by size INSIDE the batch — which
 * moves the next batch's start too, so one edit moves two boundaries instead of
 * one and two batches re-synthesize. The default budget is where edit-locality
 * is pinned (the batching tests assert it there); a lowered budget trades it for
 * more, smaller, parallel calls.
 */
import { contentHash } from "../util/id.js";
import { MAX_INPUT_CHARS } from "../ai/synthesize.js";
import type { FileSummary } from "../ai/synthesize.js";

/** Char budget of summary text per synthesis call (keeps each call in-context).
 *  `graft build --synth-batch-chars` overrides it per build. */
export const BATCH_CHAR_BUDGET = 48_000;

/** Ceiling on that budget: the synthesizer truncates a call's input at
 *  {@link MAX_INPUT_CHARS}, so a batch planned past it would be recorded
 *  complete while the call silently dropped its tail. The margin covers the
 *  `## path` headers and join newlines the per-file +8 under-counts, so a batch
 *  at the ceiling is still delivered whole. */
export const MAX_BATCH_CHAR_BUDGET = MAX_INPUT_CHARS - 1_000;

/**
 * Smallest share of the stride a batch may be cut at: a mask hit sooner than this is
 * ignored, so a lucky pair of adjacent paths cannot turn a repo into one call per two
 * files. An eighth keeps a stray hit to one small batch in a long tail of them,
 * without moving a well-behaved boundary at all.
 */
const BATCH_MIN_SHARE = 1 / 8;

/** One synthesis call: the batch of summaries it sees, and the key it is cached under. */
export interface SynthesisBatch {
  files: FileSummary[];
  /** Stable key for this batch: its files and their content hashes. */
  key: string;
}

/**
 * The batches phase 2 calls, in the order the merge consumes them. `summaries` is
 * expected path-sorted, which is what makes the plan reproducible.
 *
 * `budget` is the char budget each call's summary text stays under — the same rule
 * the default flows through, so a caller that trades down the budget gets more,
 * smaller calls, not a different cut rule.
 *
 * `model` is the model id the synthesis calls run under. It is folded into every
 * cache key, but ONLY when synthesis rides a model of its own: left undefined —
 * the build model is in charge — the key is exactly the format caches were
 * written with before the option existed, and those were synthesized by the
 * build model too, so an upgrade must keep them valid rather than re-pay every
 * batch for a line that adds no information (see {@link batchKey}).
 *
 * Exported together with their cache keys because those keys are the phase's whole
 * cost model: a boundary that moves is a re-synthesis. How these keys survive an edit
 * is what the batching tests pin down.
 */
export function planSynthesis(
  summaries: FileSummary[],
  hashByPath: ReadonlyMap<string, string>,
  budget: number = BATCH_CHAR_BUDGET,
  model?: string,
): SynthesisBatch[] {
  return batchSummaries(summaries, budget).map((files) => ({ files, key: batchKey(files, hashByPath, model) }));
}

/**
 * Cut the per-file summaries into batches, each under `budget` unless it is a single
 * file too big for one.
 *
 * A batch ENDS at the first file whose own path hash matches a mask, past a small
 * floor (see {@link BATCH_MIN_SHARE}) — so the end of a batch is decided by the files
 * inside it and by nothing else, and an edit to one file cannot move a boundary it is
 * not part of.
 */
export function batchSummaries(files: FileSummary[], budget: number = BATCH_CHAR_BUDGET): FileSummary[][] {
  if (files.length === 0) return [];
  const stride = filesPerBatch(files, budget);
  const minFiles = Math.max(1, Math.round(stride * BATCH_MIN_SHARE));
  const batches: FileSummary[][] = [];
  let cur: FileSummary[] = [];
  let size = 0;
  for (const f of files) {
    cur.push(f);
    size += summaryChars(f);
    if (cur.length >= minFiles && isBoundary(f.path, stride)) {
      batches.push(...withinBudget(cur, size, budget));
      cur = [];
      size = 0;
    }
  }
  if (cur.length > 0) batches.push(...withinBudget(cur, size, budget));
  return batches;
}

/** Chars a file costs its batch: its label, its summary, and the blank line the
 *  synthesizer's prompt puts between entries. */
function summaryChars(f: FileSummary): number {
  return f.path.length + f.summary.length + 8;
}

/**
 * Files to aim for per batch: as many as fit in roughly one budget's worth of summary
 * text, rounded DOWN to a power of two.
 *
 * The mean is the one statistic that can size a batch across repos whose summaries
 * differ in length by an order of magnitude. The power of two is what makes it safe
 * to derive from a number that moves: editing one summary of n shifts the mean by
 * ~1/n, and the ladder is wide enough that a shift that small cannot re-stride —
 * while re-striding is the one change that does move every boundary, so it should
 * take a real change in the repo to happen.
 */
function filesPerBatch(files: FileSummary[], budget: number): number {
  const total = files.reduce((n, f) => n + summaryChars(f), 0);
  const mean = Math.max(1, Math.round(total / files.length));
  return 2 ** Math.floor(Math.log2(Math.max(1, Math.floor(budget / mean))));
}

/** Does a batch end here? One path in `stride` does, by its own hash. */
function isBoundary(path: string, stride: number): boolean {
  if (stride <= 1) return true;
  return parseInt(contentHash(path).slice(-8), 16) % stride === 0;
}

/** A batch that outgrew the budget on its own is cut by size, greedily. Overshooting
 *  takes a longer gap between two mask hits than the stride asks for, so it is the
 *  tail rather than the rule — and it is cut inside that one batch, which is why a
 *  split is a local edit and not a re-plan. A single file over the budget is left
 *  whole: the synthesizer truncates its input either way, and half a file is not a
 *  batch. */
function withinBudget(batch: FileSummary[], size: number, budget: number): FileSummary[][] {
  return size <= budget || batch.length < 2 ? [batch] : batchBySize(batch, budget);
}

/** Greedily pack file summaries into batches under a char budget (≥1 file each). */
function batchBySize(files: FileSummary[], budget: number): FileSummary[][] {
  const batches: FileSummary[][] = [];
  let cur: FileSummary[] = [];
  let size = 0;
  for (const f of files) {
    const len = summaryChars(f);
    if (cur.length > 0 && size + len > budget) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += len;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/**
 * Stable key for a batch: its files and their content hashes — plus the model the
 * synthesis call runs under, but only when one was named.
 *
 * The model line is a compatibility guard, not just bookkeeping. Caches written
 * before the synthesis model existed key these batches WITHOUT it, and when no
 * separate model is configured the build model is in charge either way, so the
 * old keys must keep hitting — folding the model in unconditionally would
 * re-synthesize every existing graph on upgrade for no new information. A key
 * with the line can never collide with one without it, so a build that names a
 * synthesis model (a different result) still never serves the old model's nodes.
 */
function batchKey(batch: FileSummary[], hashByPath: ReadonlyMap<string, string>, model: string | undefined): string {
  const lines = batch.map((f) => `${f.path}:${hashByPath.get(f.path) ?? ""}`).sort();
  return contentHash([...(model === undefined ? [] : [`model\t${model}`]), ...lines].join("\n"));
}
