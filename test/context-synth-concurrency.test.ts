/**
 * The concept pass synthesizes its batches CONCURRENTLY (phase 2 of
 * `context/build.ts`). A batch is an independent unit of work — its call sees only
 * its own summaries, and the merge waits for every call — so the calls overlap
 * while the graph they produce has to stay indistinguishable from the serial one.
 *
 * These tests pin that with a synthesizer that answers OUT OF ORDER (the first call
 * is the slowest), which is exactly what an implementation that merged batches as
 * their calls landed would get wrong: same nodes, same slugs, same bytes, but a
 * first-wins tie broken by network timing instead of by batch order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildContext, type BuildProgress } from "../src/context/build.js";
import { tmpRepo, PassthroughSummarizer } from "./helpers.js";
import type { FileSummary, SynthNode, Synthesizer } from "../src/index.js";

/** A repo big enough to be cut into several synthesis batches (1 file each). */
const BATCHES = 6;

/** One file per batch: two of them overshoot the char budget together. */
function makeRepo(tag: string): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < BATCHES; i++) {
    writeFileSync(join(dir, "src", `m${i}.ts`), `export const m${i} = 1;\n// ${"x".repeat(30_000)}\n`);
  }
  return dir;
}

/**
 * The nodes one batch contributes. Batch 0 and batch 1 both claim a `Shared` node
 * with DIFFERENT types, which is the merge's one first-wins tie: whichever batch
 * is merged first decides the type that lands on disk.
 */
function nodesFor(batch: number, files: FileSummary[]): SynthNode[] {
  const sources = files.map((f) => f.path);
  const nodes: SynthNode[] = [{ name: `Batch ${batch}`, type: "file", summary: `batch ${batch}`, sources, links: [] }];
  if (batch <= 1) {
    nodes.push({ name: "Shared", type: batch === 0 ? "system" : "api", summary: `shared from batch ${batch}`, sources, links: [] });
  }
  return nodes;
}

/**
 * Answers in reverse batch order — the first call started is the last to land — and
 * records both the completion order and the high-water mark of calls in flight, so
 * a test can show the calls really did overlap.
 */
class ReverseSynthesizer implements Synthesizer {
  readonly completionOrder: number[] = [];
  peakInFlight = 0;
  private inFlight = 0;
  private started = 0;

  constructor(private readonly stepMs: number) {}

  async synthesize(files: FileSummary[]): Promise<SynthNode[]> {
    // `mapWithConcurrency` hands each worker the next batch the moment it starts, so
    // the call order is the batch order.
    const batch = this.started++;
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      await sleep(this.stepMs * (BATCHES - batch));
      this.completionOrder.push(batch);
      return nodesFor(batch, files);
    } finally {
      this.inFlight--;
    }
  }
}

/** Every file under `dir`, as `relpath → sha256`, for a byte-for-byte comparison. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(dir, full).split("\\").join("/"), createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

function opts(synthesizer: Synthesizer, extra: Record<string, unknown> = {}) {
  return { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer, ...extra };
}

test("batches synthesize in parallel and the graph is byte-identical to a serial run", async () => {
  const serialDir = makeRepo("synth-serial");
  const parallelDir = makeRepo("synth-parallel");
  const quiet = () => {};
  const orig = console.error;
  console.error = quiet;
  try {
    const serial = new ReverseSynthesizer(5);
    const parallel = new ReverseSynthesizer(5);
    const a = await buildContext(serialDir, opts(serial, { synthConcurrency: 1, onProgress: quiet }));
    const b = await buildContext(parallelDir, opts(parallel, { synthConcurrency: BATCHES, onProgress: quiet }));

    assert.equal(a.batches, BATCHES);
    assert.equal(b.batches, BATCHES);
    assert.equal(serial.peakInFlight, 1, "synthConcurrency: 1 must not overlap calls");
    assert.ok(parallel.peakInFlight > 1, `expected overlapping calls, peak was ${parallel.peakInFlight}`);
    assert.deepEqual(
      parallel.completionOrder,
      [...parallel.completionOrder].sort((x, y) => y - x),
      "the stand-in must land out of batch order, or the run proves nothing",
    );

    const expected = snapshot(join(serialDir, "graft"));
    const actual = snapshot(join(parallelDir, "graft"));
    assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
    for (const [file, hash] of expected) {
      assert.equal(actual.get(file), hash, `${file} differs between the serial and parallel runs`);
    }
  } finally {
    console.error = orig;
    rmSync(serialDir, { recursive: true, force: true });
    rmSync(parallelDir, { recursive: true, force: true });
  }
});

test("a first-wins tie is broken by batch order, not by which call landed first", async () => {
  const dir = makeRepo("synth-order");
  const orig = console.error;
  console.error = () => {};
  try {
    const synth = new ReverseSynthesizer(5);
    const r = await buildContext(dir, opts(synth, { synthConcurrency: BATCHES }));
    assert.ok(r.nodes >= BATCHES);
    // Batch 0 lands last under the stand-in above, so this is batch 0's type only
    // if the merge consumes the results in batch order.
    const shared = readFileSync(join(dir, "graft", "shared.md"), "utf8");
    assert.match(shared, /^type: system$/m);
    assert.doesNotMatch(shared, /^type: api$/m);
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the failure gate stops issuing synthesis calls once the provider is fatal", async () => {
  const dir = makeRepo("synth-gate");
  let calls = 0;
  const synthesizer: Synthesizer = {
    async synthesize() {
      calls++;
      throw new Error("429 insufficient_quota");
    },
  };
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    // 2 in flight, so the gate is fatal long before the last four batches run.
    const r = await buildContext(dir, opts(synthesizer, { synthConcurrency: 2 }));
    assert.ok(r.fatal, "a spent quota must end the pass");
    assert.match(r.fatal, /quota/);
    assert.equal(r.nodes, 0);
    assert.equal(r.errors.length, calls, "every issued call is reported as an error");
    assert.ok(calls < r.batches, `the gate must stop issuing calls: ${calls} of ${r.batches} were made`);
    assert.ok(logged.some((l) => /synthesis batch 1\/\d+: 0 nodes, 0 links \(failed\)/.test(l)));
    assert.ok(logged.some((l) => /\(skipped\)/.test(l)), "a batch the gate skipped is labelled, not silently empty");
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesis progress climbs monotonically under concurrency", async () => {
  const dir = makeRepo("synth-progress");
  const progress: BuildProgress[] = [];
  const orig = console.error;
  console.error = () => {};
  try {
    await buildContext(dir, opts(new ReverseSynthesizer(5), {
      synthConcurrency: BATCHES,
      onProgress: (info: BuildProgress) => progress.push(info),
    }));
    const synth = progress.filter((p) => p.phase === "synthesize");
    assert.equal(synth.length, BATCHES, "one report per batch, however they interleave");
    // The CLI overwrites one line with these, so a counter that went backwards
    // would read as the pass rewinding itself.
    assert.deepEqual(synth.map((p) => p.index), [...synth.map((p) => p.index)].sort((x, y) => x - y));
    for (const p of synth) assert.equal(p.total, BATCHES);
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});
