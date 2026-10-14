/**
 * Where the concept pass cuts its synthesis batches, and what that costs
 * (`src/context/batches.ts`).
 *
 * Every batch is cached under a key derived from the files it holds, so a boundary
 * that moves is a re-synthesis — a metered LLM call the user pays for again. Cut by
 * running size (which is what this replaces) one summary growing by a few hundred
 * characters moved every later boundary, so the next build after any edit
 * re-synthesized most of the graph. These tests pin the property that replaced it:
 * the plan is a function of the file PATHS, so only the batches around a change can
 * move.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../src/context/build.js";
import { BATCH_CHAR_BUDGET, planSynthesis, type SynthesisBatch } from "../src/context/batches.js";
import { contentHash } from "../src/util/id.js";
import { tmpRepo, PassthroughSummarizer } from "./helpers.js";
import type { FileSummary, Synthesizer } from "../src/index.js";

const FILES = 200;
/** Summary length per file. ~2k is what a real per-file summary runs to, and it
 *  puts the stride at 16 files, so a 200-file repo is a dozen-odd batches. */
const SUMMARY_CHARS = 2000;
/** How much one edited file's summary changes by. Deliberately MORE than one file's
 *  summary: under a size-driven cut, a change smaller than that cannot move a
 *  boundary at all, and a test that cannot tell the two rules apart is not a guard
 *  against the regression. */
const EDIT_CHARS = SUMMARY_CHARS + 2500;

function fileBody(i: number, chars = SUMMARY_CHARS): string {
  return `export const v${i} = ${i};\n// ${"x".repeat(chars)}\n`;
}

/** A repo of numbered files, so the path-sorted order is the numeric order. */
function makeRepo(tag: string, count = FILES): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, "src", `mod-${String(i).padStart(3, "0")}.ts`), fileBody(i));
  }
  return dir;
}

/** The plan for a repo as it stands: cache key → the paths in that batch. */
function planOf(dir: string, budget: number = BATCH_CHAR_BUDGET): Map<string, string[]> {
  const summaries: FileSummary[] = [];
  const hashByPath = new Map<string, string>();
  for (const name of readdirSync(join(dir, "src")).sort((a, b) => a.localeCompare(b))) {
    const rel = `src/${name}`;
    const code = readFileSync(join(dir, rel), "utf8");
    summaries.push({ path: rel, summary: code });
    hashByPath.set(rel, contentHash(code));
  }
  return new Map(planSynthesis(summaries, hashByPath, budget).map((b: SynthesisBatch) => [b.key, b.files.map((f) => f.path)]));
}

/**
 * The invariant: re-planning is LOCAL. A batch's files only change if a boundary
 * appeared or disappeared next to the change, so the batches whose keys move are
 * the one the change lands in and the two either side of it — and nothing further
 * out. A size-driven cut breaks this for every batch after the change; a rule that
 * re-strides on a changed mean breaks it for all of them.
 *
 * `touched` may or may not exist in `before` (a removal, an insertion), so the
 * batches it can disturb are found by bracketing its place in the path order.
 */
function assertLocalReplan(before: Map<string, string[]>, after: Map<string, string[]>, touched: string): void {
  const order = [...before.keys()];
  const lastBefore = [...order].reverse().find((k) => before.get(k)![before.get(k)!.length - 1] < touched);
  const at = lastBefore === undefined ? 0 : order.indexOf(lastBefore);
  const near = order.slice(Math.max(0, at - 1), at + 2);
  const neighbourhood = new Set(near.flatMap((k) => before.get(k)!));

  const invalidated = order.filter((k) => !after.has(k));
  const fresh = [...after.keys()].filter((k) => !before.has(k));
  for (const k of invalidated) {
    assert.ok(near.includes(k), `${invalidated.length} batches were invalidated, outside the ones holding ${touched}`);
  }
  for (const k of fresh) {
    for (const path of after.get(k)!) {
      assert.ok(
        neighbourhood.has(path) || path === touched,
        `${path} landed in a new batch well away from ${touched}`,
      );
    }
  }
  assert.ok(
    invalidated.length + fresh.length <= 3,
    `one change at ${touched} moved ${invalidated.length + fresh.length} of ${order.length} batches; ` +
      `a size-driven cut moves the rest`,
  );
}

const chars = (batch: SynthesisBatch): number =>
  batch.files.reduce((n, f) => n + f.path.length + f.summary.length + 8, 0);

test("a one-file edit re-plans only the batch that holds it", () => {
  const dir = makeRepo("batch-edit");
  try {
    const before = planOf(dir);
    assert.ok(before.size >= 8, `need several batches for this to say anything, got ${before.size}`);

    // One rewritten file, whose summary is a good deal longer than it was.
    const touched = "src/mod-100.ts";
    writeFileSync(join(dir, touched), fileBody(100, EDIT_CHARS));

    const after = planOf(dir);
    assertLocalReplan(before, after, touched);
    assert.equal(
      [...before.keys()].filter((k) => !after.has(k)).length,
      1,
      "a summary that changed must not disturb the batch after it, or the next one either",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adding a file re-plans only the batches around it", () => {
  const dir = makeRepo("batch-add");
  try {
    const before = planOf(dir);
    // Sorts between mod-100 and mod-101, so a size-driven cut would push every
    // boundary after it along — which is the cost this removes.
    const added = "src/mod-100z.ts";
    writeFileSync(join(dir, added), fileBody(0));

    assertLocalReplan(before, planOf(dir), added);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removing a file re-plans only the batches around it", () => {
  const dir = makeRepo("batch-remove");
  try {
    const before = planOf(dir);
    const gone = "src/mod-042.ts";
    rmSync(join(dir, gone));

    assertLocalReplan(before, planOf(dir), gone);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every batch stays under the char budget unless it is one oversized file", () => {
  const dir = makeRepo("batch-budget");
  try {
    const summaries: FileSummary[] = [];
    const hashByPath = new Map<string, string>();
    for (const name of readdirSync(join(dir, "src")).sort((a, b) => a.localeCompare(b))) {
      const rel = `src/${name}`;
      summaries.push({ path: rel, summary: readFileSync(join(dir, rel), "utf8") });
      hashByPath.set(rel, "h");
    }
    for (const batch of planSynthesis(summaries, hashByPath)) {
      assert.ok(
        batch.files.length === 1 || chars(batch) <= BATCH_CHAR_BUDGET,
        `a ${batch.files.length}-file batch of ${chars(batch)} chars is over the ${BATCH_CHAR_BUDGET} budget`,
      );
    }
    // One file bigger than the whole budget is its own batch rather than a
    // truncated neighbour's problem.
    const huge: FileSummary[] = [...summaries, { path: "src/huge.ts", summary: "x".repeat(BATCH_CHAR_BUDGET * 2) }];
    const plan = planSynthesis(huge, new Map([["src/huge.ts", "h"]]));
    const hugeBatch = plan.find((b) => b.files.some((f) => f.path === "src/huge.ts"));
    assert.ok(hugeBatch, "the oversized file must still be synthesized");
    assert.ok(
      hugeBatch.files.every((f) => f.path === "src/huge.ts" || chars(hugeBatch) <= BATCH_CHAR_BUDGET),
      "an oversized file must not drag neighbours over the budget",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a smaller budget cuts the same rule into more, smaller batches", () => {
  const dir = makeRepo("batch-budget-opt");
  try {
    const half = BATCH_CHAR_BUDGET / 2;
    const coarse = planOf(dir);
    const fine = planOf(dir, half);
    assert.ok(
      fine.size > coarse.size,
      `halving the budget must yield more batches, got ${fine.size} vs ${coarse.size}`,
    );
    for (const paths of fine.values()) {
      const batchChars = paths.reduce((n, p) => n + p.length + readFileSync(join(dir, p), "utf8").length + 8, 0);
      assert.ok(
        paths.length === 1 || batchChars <= half,
        `a ${paths.length}-file batch of ${batchChars} chars is over the halved budget`,
      );
    }
    // Not asserted here: the edit-locality the tests above pin. It holds at any
    // budget only while the edited batch stays under it — at half the budget the
    // same edit overflows its batch, and the greedy overflow cut moves the next
    // batch's start too. That cost is stated where the invariant lives, in the
    // `batches.ts` module docs; the default budget is where locality is pinned.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the budget option reaches the build: a smaller budget plans more synthesis calls", async () => {
  const dir = makeRepo("batch-budget-build");
  let calls = 0;
  const synthesizer: Synthesizer = {
    async synthesize(files) {
      calls++;
      return files.map((f) => ({ name: f.path, type: "file", summary: "s", sources: [f.path], links: [] }));
    },
  };
  const orig = console.error;
  console.error = () => {};
  try {
    const coarse = await buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer });
    assert.ok(coarse.batches >= 8, `need several batches for this to say anything, got ${coarse.batches}`);

    calls = 0;
    const fine = await buildContext(dir, {
      model: "fake",
      summarizer: new PassthroughSummarizer(),
      synthesizer,
      synthBatchChars: BATCH_CHAR_BUDGET / 2,
    });
    assert.ok(
      fine.batches > coarse.batches,
      `halving the budget must plan more calls, got ${fine.batches} vs ${coarse.batches}`,
    );
    // The two plans cut the same files differently, so at least one batch is a
    // file set no 48k call ever saw: the coarse cache cannot serve the fine plan.
    assert.ok(calls >= 1, `a smaller budget spent ${calls} synthesis calls`);
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a batch's key changes when the synthesis model does", () => {
  const dir = makeRepo("batch-synth-model");
  try {
    const summaries: FileSummary[] = [];
    const hashByPath = new Map<string, string>();
    for (const name of readdirSync(join(dir, "src")).sort((a, b) => a.localeCompare(b))) {
      const rel = `src/${name}`;
      const code = readFileSync(join(dir, rel), "utf8");
      summaries.push({ path: rel, summary: code });
      hashByPath.set(rel, contentHash(code));
    }
    const underA = planSynthesis(summaries, hashByPath, BATCH_CHAR_BUDGET, "model-a").map((b) => b.key);
    const underB = planSynthesis(summaries, hashByPath, BATCH_CHAR_BUDGET, "model-b").map((b) => b.key);
    assert.ok(underA.length > 0, "need batches for this to say anything");
    assert.equal(new Set(underA).size, underA.length, "keys within one plan stay unique per batch");
    for (const [i, key] of underA.entries()) {
      assert.notEqual(key, underB[i], "the same files under a different model must not share a cache key");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switching the synthesis model re-synthesizes; re-running on it does not", async () => {
  const dir = makeRepo("batch-synth-model-e2e");
  let calls = 0;
  const synthesizer: Synthesizer = {
    async synthesize(files) {
      calls++;
      return files.map((f) => ({ name: f.path, type: "file", summary: "s", sources: [f.path], links: [] }));
    },
  };
  const optsWith = (synthModel: string) => ({ model: "fake", summarizer: new PassthroughSummarizer(), synthesizer, synthModel });
  const orig = console.error;
  console.error = () => {};
  try {
    const first = await buildContext(dir, optsWith("model-a"));
    assert.ok(first.batches >= 8, `need several batches for this to say anything, got ${first.batches}`);
    assert.equal(calls, first.batches);

    calls = 0;
    const warm = await buildContext(dir, optsWith("model-a"));
    assert.equal(calls, 0, "the same synthesis model is a cache hit");

    calls = 0;
    const switched = await buildContext(dir, optsWith("model-b"));
    assert.equal(
      calls,
      switched.batches,
      "a different synthesis model is a different result, so every batch is re-synthesized",
    );
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-build after a one-file edit re-synthesizes one batch, not the graph", async () => {
  const dir = makeRepo("batch-e2e");
  let calls = 0;
  const synthesizer: Synthesizer = {
    async synthesize(files) {
      calls++;
      return files.map((f) => ({ name: f.path, type: "file", summary: "s", sources: [f.path], links: [] }));
    },
  };
  const orig = console.error;
  console.error = () => {};
  try {
    const first = await buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer });
    assert.ok(first.batches >= 8, `need several batches for this to say anything, got ${first.batches}`);
    const cold = calls;
    assert.equal(cold, first.batches);

    calls = 0;
    const warm = await buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer });
    assert.equal(calls, 0, "an unchanged repo spends nothing");
    assert.equal(warm.batches, first.batches);

    calls = 0;
    writeFileSync(join(dir, "src", "mod-100.ts"), fileBody(100, EDIT_CHARS));
    const after = await buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer });
    assert.equal(after.batches, first.batches);
    assert.ok(
      calls >= 1 && calls <= 2,
      `one edited file of ${first.batches} batches cost ${calls} synthesis calls; it must cost its own batch`,
    );
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});
