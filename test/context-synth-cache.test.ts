/**
 * What a `--synth-batch-chars` toggle does to the synthesis cache
 * (`src/context/build.ts`).
 *
 * The budget re-cuts every batch, so each budget has a plan of its own — and the
 * cache used to hold only the LAST build's plan: the prune dropped every key the
 * current plan did not produce, so toggling the flag discarded the plan it toggled
 * away from, and the next toggle re-paid the whole graph in metered calls. These
 * tests pin the per-budget cache: toggling keeps both plans, and only the most
 * recent budgets' plans are retained, so the cache still cannot grow a plan per
 * budget ever tried.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BATCH_CHAR_BUDGET } from "../src/context/batches.js";
import { buildContext, RETAINED_SYNTH_BUDGETS } from "../src/context/build.js";
import { tmpRepo, PassthroughSummarizer } from "./helpers.js";
import type { FileSummary, Synthesizer } from "../src/index.js";

const FILES = 120;
const SUMMARY_CHARS = 2_000;

function makeRepo(tag: string): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < FILES; i++) {
    writeFileSync(join(dir, "src", `m${String(i).padStart(3, "0")}.ts`), `export const v${i} = ${i};\n// ${"x".repeat(SUMMARY_CHARS)}\n`);
  }
  return dir;
}

/** One node per file, so every batch synthesizes into a real, non-empty result. */
function countingSynthesizer() {
  let calls = 0;
  const synthesizer: Synthesizer = {
    async synthesize(files: FileSummary[]) {
      calls++;
      return files.map((f) => ({ name: f.path, type: "file", summary: "s", sources: [f.path], links: [] }));
    },
  };
  return { synthesizer, calls: () => calls, reset: () => (calls = 0) };
}

test("toggling the batch budget does not discard the budget it toggled away from", async () => {
  const dir = makeRepo("synth-toggle");
  const spy = countingSynthesizer();
  const opts = (over: Record<string, unknown> = {}) => ({
    model: "fake",
    summarizer: new PassthroughSummarizer(),
    synthesizer: spy.synthesizer,
    ...over,
  });
  const orig = console.error;
  console.error = () => {};
  try {
    const coarse = await buildContext(dir, opts());
    assert.ok(coarse.batches >= 6, `need several batches for this to say anything, got ${coarse.batches}`);
    assert.equal(spy.calls(), coarse.batches, "a cold plan pays for every batch once");

    const fine = await buildContext(dir, opts({ synthBatchChars: BATCH_CHAR_BUDGET / 2 }));
    assert.ok(fine.batches > coarse.batches, `a smaller budget must cut more batches, got ${fine.batches} vs ${coarse.batches}`);
    assert.equal(spy.calls(), coarse.batches + fine.batches, "the other budget's plan is a different cut: it pays for itself once");

    spy.reset();
    const coarseAgain = await buildContext(dir, opts());
    assert.equal(coarseAgain.batches, coarse.batches);
    assert.equal(spy.calls(), 0, `toggling back re-pays the whole graph — the coarse plan was discarded (${spy.calls()} calls)`);

    await buildContext(dir, opts({ synthBatchChars: BATCH_CHAR_BUDGET / 2 }));
    assert.equal(spy.calls(), 0, "toggling again must not re-pay the fine plan either");
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cache retains only the most recent budgets' plans, not one per budget ever used", async () => {
  const dir = makeRepo("synth-toggle-cap");
  const spy = countingSynthesizer();
  const orig = console.error;
  console.error = () => {};
  try {
    const budgets = [
      BATCH_CHAR_BUDGET,
      BATCH_CHAR_BUDGET / 2,
      BATCH_CHAR_BUDGET / 4,
      BATCH_CHAR_BUDGET / 8,
    ];
    for (const budget of budgets) {
      await buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: spy.synthesizer, synthBatchChars: budget });
    }
    const synth = JSON.parse(readFileSync(join(dir, "graft", ".cache", "summaries.json"), "utf8")).synth as Record<string, unknown>;
    const retained = Object.keys(synth);
    assert.ok(
      retained.length <= RETAINED_SYNTH_BUDGETS,
      `the cache grew to ${retained.length} plans; the retained-budget cap is ${RETAINED_SYNTH_BUDGETS}`,
    );
    assert.ok(retained.includes(`budget-${budgets[3]}`), "the build's own budget's plan must be retained");
    assert.ok(!retained.includes(`budget-${budgets[0]}`), "the oldest budget's plan must be the one dropped");
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});
