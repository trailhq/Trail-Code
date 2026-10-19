/**
 * #260: one crux call per file hits maxTokens (~8192) around 125 symbols. The
 * adapter's JSON.parse of the truncated tool arguments fails, parseResults
 * returns [], and the whole file is dropped. Re-running --deep hits the same
 * ceiling, so those files stay failed forever.
 *
 * Fix: chunk targets at {@link CRUX_CHUNK_SIZE} (pinned here; not a silent 125),
 * merge chunk results, and log truncation instead of swallowing it. Small files
 * still cost one call. Empty chunks must not be cached as ready (#177).
 *
 * All of this is a fake ChatModel — no provider key, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCruxSummarizer, chunkCruxTargets, CRUX_CHUNK_SIZE } from "../src/ai/crux.js";
import { enrichGraph } from "../src/graph/enrich.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";
import type { FileCruxInput, NodeRef } from "../src/ai/crux.js";
import type { NodeV1 } from "../src/graph/types.js";

/** Observed production cliff from #260 — test-only. Production chunks at CRUX_CHUNK_SIZE. */
const TRUNCATE_ABOVE = 125;
const DENSE = 200;

test("#260: CRUX_CHUNK_SIZE is pinned and dense files split, small files do not", () => {
  assert.equal(CRUX_CHUNK_SIZE, 80);
  assert.ok(CRUX_CHUNK_SIZE < TRUNCATE_ABOVE, "chunk size must sit under the observed truncation cliff");
  assert.deepEqual(
    chunkCruxTargets(Array.from({ length: 80 }, (_, i) => i)).map((c) => c.length),
    [80],
  );
  assert.deepEqual(
    chunkCruxTargets(Array.from({ length: 81 }, (_, i) => i)).map((c) => c.length),
    [80, 1],
  );
  assert.deepEqual(
    chunkCruxTargets(Array.from({ length: DENSE }, (_, i) => i)).map((c) => c.length),
    [80, 80, 40],
  );
  assert.deepEqual(chunkCruxTargets([]), []);
});

test("#260: a 200-symbol file truncated in one call is not silently dropped", async () => {
  const model = new CeilingModel();
  const { result, err } = await withCapturedError(() =>
    new ChatCruxSummarizer(model).describeFile(denseInput(DENSE)),
  );

  assert.ok(result.length > 0, "chunking must keep at least some summaries instead of dropping the file");
  assert.equal(result.length, DENSE, "every target in a dense file should come back once chunks fit under the cliff");
  assert.ok(model.calls >= 2, `dense file must take more than one LLM call, saw ${model.calls}`);
  assert.ok(
    model.sizes.every((n) => n <= CRUX_CHUNK_SIZE),
    `every call must pack ≤ ${CRUX_CHUNK_SIZE} targets, saw ${model.sizes.join(",")}`,
  );
  assert.equal(err.filter((l) => /truncated/i.test(l)).length, 0, "successful chunks must not log truncation");
});

test("#260: a small file is still one LLM call", async () => {
  const model = new CeilingModel();
  const out = await new ChatCruxSummarizer(model).describeFile(denseInput(5));
  assert.equal(out.length, 5);
  assert.equal(model.calls, 1);
  assert.deepEqual(model.sizes, [5]);
});

test("#260: finish_reason=length is logged, not swallowed", async () => {
  const model = new TruncatedModel();
  const { result, err } = await withCapturedError(() =>
    new ChatCruxSummarizer(model).describeFile(denseInput(3)),
  );
  assert.equal(result.length, 0);
  assert.ok(
    err.some((l) => /truncated/i.test(l) && /finish_reason=length/.test(l)),
    `truncation must be logged, got: ${err.join(" | ") || "(silence)"}`,
  );
});

test("#260: empty chunks stay pending and are not cached as ready (#177)", async () => {
  const { nodes, sources } = denseNodes(DENSE);
  const summarizer = new ChatCruxSummarizer(new EmptyModel());
  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.equal(stats.computed, 0);
  assert.equal(stats.failedFiles, 1);
  assert.ok(stats.errors.length > 0);
  for (const n of nodes) {
    assert.equal(n.summary_state, "pending", "empty chunk must not flip the node to ready");
    assert.equal(n.summary, null);
  }
});

test("#260: a later empty chunk does not wipe earlier summaries or cache the empty ids", async () => {
  const { nodes, sources } = denseNodes(DENSE);
  const summarizer = new ChatCruxSummarizer(new FirstChunkOnlyModel());
  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.ok(stats.computed >= CRUX_CHUNK_SIZE, "first chunk's summaries must be kept");
  assert.ok(stats.pending > 0, "ids the later chunks missed must remain retryable");
  const ready = nodes.filter((n) => n.summary_state === "ready");
  const pending = nodes.filter((n) => n.summary_state === "pending");
  assert.equal(ready.length, stats.computed);
  assert.equal(pending.length, stats.pending);
  for (const n of pending) assert.equal(n.summary, null);
});

test("#260: each chunk's numbered source includes its targets' file-absolute lines", async () => {
  // numberLines clips 18k chars from the start of the file. Put 80 short
  // functions in the prefix (chunk 1), then enough padding that a 81st
  // function sits past that clip. Chunk 2 must still see that late line —
  // the existing dense-file fixture (`source: "export const x = 1"`) cannot.
  const n = CRUX_CHUNK_SIZE + 1;
  const head = Array.from(
    { length: CRUX_CHUNK_SIZE },
    (_, i) => `export function f${i}() { return ${i}; }`,
  );
  const pad = Array.from({ length: 120 }, () => `// ${"x".repeat(160)}`);
  const tail = [`export function f${CRUX_CHUNK_SIZE}() { return ${CRUX_CHUNK_SIZE}; }`];
  const source = [...head, ...pad, ...tail].join("\n") + "\n";
  const lateLine = head.length + pad.length + 1;
  const nodes: NodeRef[] = [
    ...Array.from({ length: CRUX_CHUNK_SIZE }, (_, i) => ({
      id: `late.ts#f${i}`,
      kind: "function" as const,
      signature: `f${i}()`,
      startLine: i + 1,
      endLine: i + 1,
    })),
    {
      id: `late.ts#f${CRUX_CHUNK_SIZE}`,
      kind: "function",
      signature: `f${CRUX_CHUNK_SIZE}()`,
      startLine: lateLine,
      endLine: lateLine,
    },
  ];
  assert.equal(nodes.length, n);
  assert.ok(source.length > 18_000, "fixture must exceed the per-request source cap");

  const model = new RecordingModel();
  await new ChatCruxSummarizer(model).describeFile({ path: "late.ts", source, nodes });
  assert.equal(model.prompts.length, 2, "81 targets must split into two chunks");
  for (const prompt of model.prompts) {
    const shown = shownLineNumbers(prompt);
    const starts = [...prompt.matchAll(/lines L(\d+)-L(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(starts.length > 0, "chunk must list TARGETS with file-absolute lines");
    for (const start of starts) {
      assert.ok(
        shown.has(start),
        `target startLine ${start} must appear in this chunk's numbered source (shown ${[...shown].at(0)}–${[...shown].at(-1)})`,
      );
    }
  }
});

test("#260: a source window over 18k splits even below the target-count cap", async () => {
  const padding = Array.from({ length: 120 }, () => `// ${"x".repeat(160)}`);
  const source = ["export function first() {}", ...padding, "export function last() {}"].join("\n");
  const lateLine = padding.length + 2;
  const nodes: NodeRef[] = [
    {
      id: "sparse.ts#first",
      kind: "function",
      signature: "first()",
      startLine: 1,
      endLine: 1,
    },
    {
      id: "sparse.ts#last",
      kind: "function",
      signature: "last()",
      startLine: lateLine,
      endLine: lateLine,
    },
  ];
  assert.ok(nodes.length < CRUX_CHUNK_SIZE, "fixture must stay below the count-only split");
  assert.ok(source.length > 18_000, "fixture must exceed the per-request source cap");

  const model = new RecordingModel();
  await new ChatCruxSummarizer(model).describeFile({ path: "sparse.ts", source, nodes });

  assert.equal(model.prompts.length, 2, "source span must split two sparse targets");
  for (const prompt of model.prompts) {
    const shown = shownLineNumbers(prompt);
    const starts = [...prompt.matchAll(/lines L(\d+)-L(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(starts.length, 1);
    assert.ok(shown.has(starts[0]), `target line ${starts[0]} must be visible in its chunk`);
  }
});

test("#260: source window splits strictly above 18k, including reversed targets", async () => {
  for (const length of [18_000, 18_001]) {
    for (const reversed of [false, true]) {
      const source = ["a", "x".repeat(length - 4), "z"].join("\n");
      assert.equal(source.length, length);
      const nodes: NodeRef[] = [
        { ...ref(0), startLine: 1, endLine: 1 },
        { ...ref(1), startLine: 3, endLine: 3 },
      ];
      if (reversed) nodes.reverse();
      const model = new RecordingModel();
      const out = await new ChatCruxSummarizer(model).describeFile({ path: "boundary.ts", source, nodes });
      assert.equal(model.prompts.length, length === 18_000 ? 1 : 2);
      assert.deepEqual(out.map((n) => n.id), nodes.map((n) => n.id));
      for (const prompt of model.prompts) {
        assert.ok(!prompt.includes("… (truncated)"));
        const shown = shownLineNumbers(prompt);
        for (const match of prompt.matchAll(/lines L(\d+)-L(\d+)/g)) {
          assert.ok(shown.has(Number(match[1])));
        }
      }
    }
  }
});

test("#260: an oversized single target stays clipped but does not hide the next target", async () => {
  const source = ["export function huge() {", "x".repeat(18_100), "}", "export function next() {}"].join("\n");
  const nodes: NodeRef[] = [
    { ...ref(0), startLine: 1, endLine: 3 },
    { ...ref(1), startLine: 4, endLine: 4 },
  ];
  const model = new RecordingModel();
  await new ChatCruxSummarizer(model).describeFile({ path: "huge.ts", source, nodes });
  assert.equal(model.prompts.length, 2);
  assert.ok(model.prompts[0].includes("… (truncated)"));
  assert.ok(!model.prompts[0].includes("3\t}"), "oversized target's tail remains outside the clip");
  assert.ok(model.prompts[1].includes("4\texport function next() {}"));
});

test("#260: empty target input makes no request and clears an earlier miss", async () => {
  const model = new RecordingModel();
  const summarizer = new ChatCruxSummarizer(model);
  summarizer.lastMiss = { kind: "empty-toolCalls", finishReason: "stop" };
  assert.deepEqual(await summarizer.describeFile(denseInput(0)), []);
  assert.equal(model.prompts.length, 0);
  assert.equal(summarizer.lastMiss, null);
});

test("#260: duplicate results across source windows are merged once", async () => {
  const source = ["a", "x".repeat(18_000), "z"].join("\n");
  const nodes: NodeRef[] = [
    { ...ref(0), startLine: 1, endLine: 1 },
    { ...ref(0), startLine: 3, endLine: 3 },
  ];
  const model = new RecordingModel();
  const out = await new ChatCruxSummarizer(model).describeFile({ path: "duplicate.ts", source, nodes });
  assert.equal(model.prompts.length, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, nodes[0].id);
});

test("#260: a later provider failure keeps completed chunks and reports the error", async () => {
  const { nodes, sources } = denseNodes(CRUX_CHUNK_SIZE + 1);
  const model = new LaterChunkFailureModel("503 upstream unavailable");
  const stats = await enrichGraph(nodes, new Map(), sources, {
    summarizer: new ChatCruxSummarizer(model), concurrency: 1,
  });

  assert.equal(model.calls, 2, "provider failure must end retries for this file");
  assert.equal(stats.computed, CRUX_CHUNK_SIZE, "completed chunks must be retained");
  assert.equal(stats.pending, 1);
  assert.equal(stats.failedFiles, 1);
  assert.equal(stats.fatal, undefined);
  assert.match(stats.errors[0], /503 upstream unavailable/);
  assert.equal(nodes.filter((n) => n.summary_state === "ready").length, CRUX_CHUNK_SIZE);
  assert.equal(nodes.at(-1)?.summary_state, "pending");
});

test("#260: a later quota rejection keeps completed chunks and stops remaining files", async () => {
  const { nodes, sources } = denseNodes(CRUX_CHUNK_SIZE + 1);
  const later = { ...nodes[0], id: "later.ts#run", name: "run", path: "later.ts" };
  nodes.push(later);
  sources.set(later.path, "export function run() {}\n");
  const model = new LaterChunkFailureModel("429 quota exhausted");
  const stats = await enrichGraph(nodes, new Map(), sources, {
    summarizer: new ChatCruxSummarizer(model), concurrency: 1,
  });

  assert.equal(model.calls, 2, "quota rejection must not issue further chunk, retry, or file calls");
  assert.equal(stats.computed, CRUX_CHUNK_SIZE);
  assert.equal(stats.pending, 2);
  assert.equal(stats.failedFiles, 1);
  assert.equal(stats.skippedFiles, 1);
  assert.match(stats.fatal ?? "", /quota\/credit for this key is exhausted/);
  assert.match(stats.errors[0], /429 quota exhausted/);
  assert.equal(nodes.filter((n) => n.summary_state === "ready").length, CRUX_CHUNK_SIZE);
  assert.equal(later.summary_state, "pending");

  const resumed = nodes.map((n) => ({ ...n, summary_state: "pending" as const, summary: null, crux: null }));
  const recovery = new CeilingModel();
  const recovered = await enrichGraph(resumed, new Map(nodes.map((n) => [n.id, n])), sources, {
    summarizer: new ChatCruxSummarizer(recovery), concurrency: 1,
  });
  assert.equal(recovered.cached, CRUX_CHUNK_SIZE, "completed chunks must be reused on the next build");
  assert.equal(recovered.computed, 2);
  assert.equal(recovered.pending, 0);
  assert.deepEqual(recovery.sizes, [1, 1], "only pending symbols should be requested after recovery");
});

/** A completed first chunk followed by a provider error, rather than an empty reply. */
class LaterChunkFailureModel implements ChatModel {
  readonly label = "fake:later-failure";
  calls = 0;
  private readonly message: string;
  constructor(message: string) { this.message = message; }
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    if (this.calls > 1) throw new Error(this.message);
    return okReply(requestedIds(req));
  }
}

function denseInput(n: number): FileCruxInput {
  return {
    path: "dense.ts",
    source: "export const x = 1;\n",
    nodes: Array.from({ length: n }, (_, i) => ref(i)),
  };
}

function ref(i: number): NodeRef {
  return {
    id: `dense.ts#f${i}`,
    kind: "function",
    signature: `f${i}()`,
    startLine: 1,
    endLine: 1,
  };
}

function denseNodes(n: number): { nodes: NodeV1[]; sources: Map<string, string> } {
  const path = "dense.ts";
  return {
    nodes: Array.from({ length: n }, (_, i) => ({
      id: `${path}#f${i}`,
      name: `f${i}`,
      kind: "function",
      path,
      span: "L1-L1",
      signature: `f${i}()`,
      exported: true,
      origin: "ast",
      body_hash: `h-${i}`,
      summary_state: "pending",
      summary: null,
      crux: null,
    })),
    sources: new Map([[path, "export const x = 1;\n"]]),
  };
}

function requestedIds(req: ChatRequest): string[] {
  const user = req.messages.find((m) => m.role === "user")?.content ?? "";
  return [...user.matchAll(/^- id=(\S+)/gm)].map((m) => m[1]);
}

function okReply(ids: string[]): ChatResponse {
  const toolCalls: ToolCall[] = [
    {
      id: "1",
      name: "record_symbols",
      args: {
        symbols: ids.map((id) => ({ id, summary: `purpose of ${id}`, crux_start: 0, crux_end: 0 })),
      },
    },
  ];
  return {
    text: "",
    toolCalls,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    stopReason: "stop",
    assistant: { role: "assistant", content: "", toolCalls },
  };
}

/** Same shape the OpenAI adapter yields when JSON.parse of truncated tool args fails. */
function truncatedReply(): ChatResponse {
  const toolCalls: ToolCall[] = [{ id: "1", name: "record_symbols", args: {} }];
  return {
    text: "",
    toolCalls,
    usage: { input: 0, output: 8192, cacheRead: 0, cacheCreate: 0 },
    stopReason: "length",
    assistant: { role: "assistant", content: "", toolCalls },
  };
}

function emptyReply(): ChatResponse {
  return {
    text: "",
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    stopReason: "stop",
    assistant: { role: "assistant", content: "" },
  };
}

/** Truncates (and drops) any call packed above the observed ~125-symbol cliff. */
class CeilingModel implements ChatModel {
  readonly label = "fake:ceiling";
  calls = 0;
  sizes: number[] = [];
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    const ids = requestedIds(req);
    this.sizes.push(ids.length);
    if (ids.length > TRUNCATE_ABOVE) return truncatedReply();
    return okReply(ids);
  }
}

class TruncatedModel implements ChatModel {
  readonly label = "fake:truncated";
  async create(_req: ChatRequest): Promise<ChatResponse> {
    return truncatedReply();
  }
}

class EmptyModel implements ChatModel {
  readonly label = "fake:empty";
  async create(_req: ChatRequest): Promise<ChatResponse> {
    return emptyReply();
  }
}

/** Succeeds only for f0..f79 — later chunks (and the collectFileCrux retry) stay empty. */
class FirstChunkOnlyModel implements ChatModel {
  readonly label = "fake:first-chunk";
  async create(req: ChatRequest): Promise<ChatResponse> {
    const ids = requestedIds(req).filter((id) => {
      const n = Number(/#f(\d+)$/.exec(id)?.[1]);
      return Number.isFinite(n) && n < CRUX_CHUNK_SIZE;
    });
    if (ids.length === 0) return emptyReply();
    return okReply(ids);
  }
}

/** Records each user prompt so tests can see which numbered source lines went out. */
class RecordingModel implements ChatModel {
  readonly label = "fake:record";
  prompts: string[] = [];
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.prompts.push(req.messages.find((m) => m.role === "user")?.content ?? "");
    return okReply(requestedIds(req));
  }
}

function shownLineNumbers(prompt: string): Set<number> {
  const body = prompt.split("\n\nTARGETS")[0] ?? prompt;
  const nums = new Set<number>();
  for (const line of body.split("\n")) {
    const m = /^(\d+)\t/.exec(line);
    if (m) nums.add(Number(m[1]));
  }
  return nums;
}

async function withCapturedError<T>(fn: () => Promise<T>): Promise<{ result: T; err: string[] }> {
  const err: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    err.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { result: await fn(), err };
  } finally {
    console.error = orig;
  }
}
