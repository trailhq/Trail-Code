/**
 * The budget guards at the build layer (`src/context/build.ts`,
 * `src/context/batches.ts`): the ceiling, and the floor.
 *
 * The synthesizer truncates one call's input at MAX_INPUT_CHARS, so a budget past
 * that limit plans batches whose tails are silently dropped — while the cache
 * records the batch complete, so no later build ever re-synthesizes what was
 * lost. The build therefore clamps the requested budget to what one call can
 * actually deliver whole.
 *
 * Below 1 — or not a number at all — a budget degenerates the other way: one
 * synthesis call per file, the exact per-file call storm the batch pass exists
 * to prevent. The CLI rejects those as a usage error (`cli-synth-batch-chars.test.ts`);
 * the programmatic API must refuse them the same way, before it walks a file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_INPUT_CHARS } from "../src/ai/synthesize.js";
import { BATCH_CHAR_BUDGET, MAX_BATCH_CHAR_BUDGET } from "../src/context/batches.js";
import { buildContext } from "../src/context/build.js";
import { tmpRepo, PassthroughSummarizer } from "./helpers.js";
import type { FileSummary, SynthNode, Synthesizer } from "../src/index.js";

const FILES = 200;
const SUMMARY_CHARS = 2_000; // ~400k chars of summaries across the repo

function makeRepo(tag: string): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < FILES; i++) {
    writeFileSync(join(dir, "src", `m${String(i).padStart(3, "0")}.ts`), `export const v${i} = ${i};\n// ${"x".repeat(SUMMARY_CHARS)}\n`);
  }
  return dir;
}

function recordingSynthesizer() {
  const batches: FileSummary[][] = [];
  const synthesizer: Synthesizer = {
    async synthesize(files: FileSummary[]): Promise<SynthNode[]> {
      batches.push(files);
      return files.map((f) => ({ name: f.path, type: "file", summary: "s", sources: [f.path], links: [] }));
    },
  };
  return { synthesizer, batches };
}

/** The input the synthesizer would render for a batch — what truncation bites. */
function renderedInput(files: FileSummary[]): string {
  return files.map((f) => `## ${f.path}\n\n${f.summary}`).join("\n\n");
}

test("a budget past the synthesizer's input limit is clamped, not truncated", async () => {
  const dir = makeRepo("synth-clamp");
  const spy = recordingSynthesizer();
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const r = await buildContext(dir, {
      model: "fake",
      summarizer: new PassthroughSummarizer(),
      synthesizer: spy.synthesizer,
      synthBatchChars: 200_000,
    });
    assert.ok(r.batches > 1, `a repo of ~400k summaries cannot fit one whole call, got ${r.batches} batches`);
    assert.ok(
      logged.some((l) => l.includes("clamped") && l.includes("200000")),
      `a clamped budget must say so, stderr said: ${logged.join(" | ").slice(0, 200)}`,
    );
    assert.ok(MAX_BATCH_CHAR_BUDGET < MAX_INPUT_CHARS, "the ceiling must sit under the synthesizer's own truncation point");
    for (const [i, files] of spy.batches.entries()) {
      // A single file bigger than everything is delivered truncated by design
      // (half a file is not a batch); any multi-file batch must arrive whole.
      if (files.length < 2) continue;
      assert.ok(
        renderedInput(files).length <= MAX_INPUT_CHARS,
        `batch ${i + 1} of ${files.length} files renders ${renderedInput(files).length} chars: the synthesizer would silently drop its tail`,
      );
    }
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default budget stays untouched by the clamp", async () => {
  const dir = makeRepo("synth-clamp-default");
  const spy = recordingSynthesizer();
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const r = await buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: spy.synthesizer });
    assert.ok(!logged.some((l) => l.includes("clamped")), "the default budget must not be clamped, or warned about");
    for (const files of spy.batches) {
      const chars = files.reduce((n, f) => n + f.path.length + f.summary.length + 8, 0);
      assert.ok(files.length === 1 || chars <= BATCH_CHAR_BUDGET, `a ${files.length}-file batch of ${chars} chars is over the default budget`);
    }
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a budget below 1, or not a number, is rejected before any work", async () => {
  const dir = makeRepo("synth-clamp-floor");
  const spy = recordingSynthesizer();
  try {
    for (const bad of [0, -5, NaN, Infinity]) {
      await assert.rejects(
        () => buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: spy.synthesizer, synthBatchChars: bad }),
        /synthBatchChars must be a positive number/,
        `synthBatchChars ${String(bad)} must be rejected, not run`,
      );
    }
    assert.equal(spy.batches.length, 0, `a rejected budget must cost no synthesis calls, made ${spy.batches.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
