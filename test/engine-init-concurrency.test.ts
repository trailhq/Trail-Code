/**
 * `graft build --deep -j N` must cap the concept pass's file summaries at N.
 * `Graft.init` used to drop `concurrency`, so `buildContext` always fell back to
 * its default of 8 calls in flight, even under `-j 1`.
 *
 * No LLM: a summarizer that records the high-water mark of calls in flight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Graft } from "../src/engine.js";
import { tmpRepo, BracketSynthesizer } from "./helpers.js";
import type { Summarizer } from "../src/index.js";

const FILES = 10;

function makeRepo(): string {
  const dir = tmpRepo("init-concurrency");
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < FILES; i++) writeFileSync(join(dir, "src", `m${i}.ts`), `export const m${i} = 1;\n`);
  return dir;
}

class PeakSummarizer implements Summarizer {
  peakInFlight = 0;
  private inFlight = 0;

  async summarize(code: string): Promise<string> {
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      await sleep(5);
      return code;
    } finally {
      this.inFlight--;
    }
  }
}

for (const concurrency of [1, 3]) {
  test(`Graft.init forwards concurrency=${concurrency} to the summary pass`, async () => {
    const dir = makeRepo();
    const summarizer = new PeakSummarizer();
    try {
      const engine = new Graft({ summarizer, synthesizer: new BracketSynthesizer() });
      await engine.init(dir, { concurrency });
      assert.equal(summarizer.peakInFlight, concurrency);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
