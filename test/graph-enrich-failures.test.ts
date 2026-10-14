/**
 * #127: a `--deep` build whose LLM calls failed used to degrade file by file and
 * still exit 0 — an 884-file run logged 1,617 quota rejections, printed the normal
 * success footer, and left `graft check` saying "in sync".
 *
 * Two behaviours are asserted here, both with a fake summarizer (no network):
 *   - the pass STOPS instead of issuing a doomed call per remaining file — on a
 *     quota/auth rejection immediately, and otherwise after a run of failures;
 *   - the failure is reported as DATA (`failedFiles`/`skippedFiles`/`fatal`), which
 *     is what lets the CLI exit non-zero without parsing message strings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichGraph } from "../src/graph/enrich.js";
import type { CruxSummarizer, FileCruxInput, NodeCrux } from "../src/ai/crux.js";
import type { NodeV1 } from "../src/graph/types.js";

/** Fails every call with `message`, counting how many calls it was asked for. */
class FailingCrux implements CruxSummarizer {
  calls = 0;
  constructor(private readonly message: string) {}
  async describeFile(_input: FileCruxInput): Promise<NodeCrux[]> {
    this.calls++;
    throw new Error(this.message);
  }
}

/** Fails only for the named files; every other file summarizes normally. */
class FlakyCrux implements CruxSummarizer {
  calls: string[] = [];
  constructor(private readonly failing: Set<string>) {}
  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    this.calls.push(input.path);
    if (this.failing.has(input.path)) throw new Error("500 upstream hiccup");
    return input.nodes.map((n) => ({ id: n.id, summary: `crux ${n.id}`, crux_start: 0, crux_end: 0 }));
  }
}

function node(path: string): NodeV1 {
  return {
    id: `${path}#run`, name: "run", kind: "function", path, span: "L1-L3",
    signature: "run()", exported: true, origin: "ast", body_hash: `h-${path}`,
    summary_state: "pending", summary: null, crux: null,
  };
}

/** `n` single-symbol files, each its own LLM call. */
function fixture(n: number): { nodes: NodeV1[]; sources: Map<string, string> } {
  const paths = Array.from({ length: n }, (_, i) => `f${i}.ts`);
  return {
    nodes: paths.map(node),
    sources: new Map(paths.map((p) => [p, "export function run() {\n  return 1;\n}\n"])),
  };
}

test("#127: a quota rejection stops the pass instead of failing every remaining file", async () => {
  const { nodes, sources } = fixture(40);
  const summarizer = new FailingCrux("429 Request exceeds your current quota, please check your plan");

  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.match(stats.fatal ?? "", /quota\/credit for this key is exhausted/);
  // The whole point: 40 files, one call. (`collectFileCrux` re-asks for symbols the
  // model omitted, but a thrown error ends that loop, so a failure costs one call.)
  assert.equal(summarizer.calls, 1, "the pass stopped at the first quota rejection");
  assert.equal(stats.failedFiles, 1);
  assert.equal(stats.skippedFiles, 39);
  assert.equal(stats.computed, 0);
  assert.equal(stats.pending, 40, "every symbol is still reported as unsummarized");
});

test("#127: a rejected API key is terminal too, and names the key as the cause", async () => {
  const { nodes, sources } = fixture(10);
  const summarizer = new FailingCrux("401 Unauthorized: invalid api key");

  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.match(stats.fatal ?? "", /rejected the API key/);
  assert.equal(stats.failedFiles, 1);
  assert.equal(stats.skippedFiles, 9);
});

test("#127: an unclassified error gives up only after a run of failures", async () => {
  const { nodes, sources } = fixture(30);
  const summarizer = new FailingCrux("503 upstream unavailable");

  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  // Not terminal by message, so the cutoff is consecutive failures — five files
  // tried, the rest skipped rather than 30 doomed calls.
  assert.equal(stats.failedFiles, 5);
  assert.equal(stats.skippedFiles, 25);
  assert.match(stats.fatal ?? "", /5 files in a row failed/);
});

test("#127: isolated failures are counted but never stop a build that is working", async () => {
  const { nodes, sources } = fixture(12);
  const summarizer = new FlakyCrux(new Set(["f3.ts", "f7.ts"]));

  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.equal(stats.fatal, undefined, "two scattered failures are not a dead provider");
  assert.equal(summarizer.calls.length, 12, "every file was attempted exactly once");
  assert.equal(stats.failedFiles, 2);
  assert.equal(stats.skippedFiles, 0);
  assert.equal(stats.computed, 10);
  assert.equal(stats.pending, 2);
  assert.equal(stats.errors.length, 2);
});

test("#127: a clean pass reports no failure at all — the flags are not noise", async () => {
  const { nodes, sources } = fixture(4);
  const stats = await enrichGraph(nodes, new Map(), sources, {
    summarizer: new FlakyCrux(new Set()),
    concurrency: 2,
  });

  assert.equal(stats.fatal, undefined);
  assert.equal(stats.failedFiles, 0);
  assert.equal(stats.skippedFiles, 0);
  assert.equal(stats.computed, 4);
});

test("a stopped pass does not read (and hash) the sources of the files it skips", async () => {
  const { nodes, sources } = fixture(10);
  const reads: string[] = [];
  const lookup = { has: (p: string) => sources.has(p), get: (p: string) => { reads.push(p); return sources.get(p); } };
  const stats = await enrichGraph(nodes, new Map(), lookup, {
    summarizer: new FailingCrux("429 Request exceeds your current quota, please check your plan"),
    concurrency: 1,
  });
  assert.equal(stats.skippedFiles, 9);
  assert.deepEqual(reads, ["f0.ts"], "only the file that was actually attempted");
});
