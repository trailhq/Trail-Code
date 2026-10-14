/**
 * The synthesis cache across an upgrade (`src/context/batches.ts`).
 *
 * Caches written before the synthesis model existed key each batch by its files'
 * content hashes alone — no model line. Folding the model into every key
 * unconditionally would make one upgrade re-synthesize every graph, on a build
 * where the synthesis model IS the build model anyway (the default) and the new
 * line adds no information. These tests pin the compatibility guard: without a
 * separate synthesis model the old keys still hit; with one, re-synthesizing is
 * correct and still happens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../src/context/build.js";
import { planSynthesis } from "../src/context/batches.js";
import { contentHash } from "../src/util/id.js";
import { tmpRepo, PassthroughSummarizer } from "./helpers.js";
import type { FileSummary, SynthNode, Synthesizer } from "../src/index.js";

const FILES = 40;
const SUMMARY_CHARS = 2_000;

function makeRepo(tag: string): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < FILES; i++) {
    writeFileSync(join(dir, "src", `m${String(i).padStart(3, "0")}.ts`), `export const v${i} = ${i};\n// ${"x".repeat(SUMMARY_CHARS)}\n`);
  }
  return dir;
}

/** The repo's summaries and content hashes, derived the way the build does. */
function summariesOf(dir: string): { summaries: FileSummary[]; hashByPath: Map<string, string> } {
  const summaries: FileSummary[] = [];
  const hashByPath = new Map<string, string>();
  for (const name of readdirSync(join(dir, "src")).sort((a, b) => a.localeCompare(b))) {
    const rel = `src/${name}`;
    const code = readFileSync(join(dir, rel), "utf8");
    summaries.push({ path: rel, summary: code });
    hashByPath.set(rel, contentHash(code));
  }
  return { summaries, hashByPath };
}

/** The key format caches were written with BEFORE the synthesis model existed:
 *  the batch's `path:hash` lines, sorted, and nothing else. */
function preSynthModelKey(batch: FileSummary[], hashByPath: ReadonlyMap<string, string>): string {
  return contentHash(batch.map((f) => `${f.path}:${hashByPath.get(f.path) ?? ""}`).sort().join("\n"));
}

/** One recognizable node per batch, so a served cache proves itself on disk. */
function nodesFor(batch: number, files: FileSummary[]): SynthNode[] {
  return [{ name: `legacy batch ${batch}`, type: "concept", summary: "seeded", sources: files.map((f) => f.path), links: [] }];
}

/** A synthesizer that counts the calls it was asked for — the metered thing an
 *  upgrade must not repeat — and answers one recognizable node per batch. */
class CountingSynthesizer implements Synthesizer {
  calls = 0;

  async synthesize(files: FileSummary[]): Promise<SynthNode[]> {
    return nodesFor(this.calls++, files);
  }
}

test("a cache written before the synthesis model existed still hits after the upgrade", async () => {
  const dir = makeRepo("synth-compat-upgrade");
  const spy = new CountingSynthesizer();
  const orig = console.error;
  console.error = () => {};
  try {
    // Seed the cache in the old shape: one flat key→nodes map, keyed the old way.
    const { summaries, hashByPath } = summariesOf(dir);
    const plan = planSynthesis(summaries, hashByPath);
    assert.ok(plan.length >= 2, `need several batches for this to say anything, got ${plan.length}`);
    const synth: Record<string, SynthNode[]> = {};
    for (const [b, batch] of plan.entries()) synth[preSynthModelKey(batch.files, hashByPath)] = nodesFor(b, batch.files);
    const cacheDir = join(dir, "graft", ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "summaries.json"), JSON.stringify({ summaries: {}, synth }));

    const r = await buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: spy });
    assert.equal(spy.calls, 0, `an upgraded cache must serve every batch for free, but ${spy.calls} calls were made`);
    assert.equal(r.nodes, plan.length, "the seeded nodes must actually be served, not just skipped");
    assert.equal(r.batches, plan.length);

    // The first upgrade build rewrote the cache in the current shape; the next
    // one must not lose what it migrated.
    const r2 = await buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: spy });
    assert.equal(spy.calls, 0, "the rewritten cache must still serve every batch");
    assert.equal(r2.nodes, plan.length);
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with a separate synthesis model an old cache still re-synthesizes, as it must", async () => {
  const dir = makeRepo("synth-compat-synth-model");
  let calls = 0;
  const synthesizer: Synthesizer = {
    async synthesize(files) {
      calls++;
      return [{ name: `fresh ${calls}`, type: "concept", summary: "s", sources: files.map((f) => f.path), links: [] }];
    },
  };
  const orig = console.error;
  console.error = () => {};
  try {
    const { summaries, hashByPath } = summariesOf(dir);
    const plan = planSynthesis(summaries, hashByPath);
    const synth: Record<string, SynthNode[]> = {};
    for (const [b, batch] of plan.entries()) synth[preSynthModelKey(batch.files, hashByPath)] = nodesFor(b, batch.files);
    const cacheDir = join(dir, "graft", ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "summaries.json"), JSON.stringify({ summaries: {}, synth }));

    const r = await buildContext(dir, {
      model: "fake",
      summarizer: new PassthroughSummarizer(),
      synthesizer,
      synthModel: "other-model",
    });
    assert.equal(r.batches, plan.length);
    assert.equal(calls, r.batches, "a different synthesis model is a different result: the old cache must not serve it");
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});
