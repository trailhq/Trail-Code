/**
 * #235: after #177, empty/unusable crux replies are real failures (not silent
 * pending). Combined with LlmFailureGate's consecutive-failure cutoff that
 * turned a 96% meaning pass into a hard abort — resume then died on the same
 * files. Content-quality misses must stay failed (and uncached), but must not
 * trip the gate the way quota/auth does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichGraph } from "../src/graph/enrich.js";
import { ChatCruxSummarizer } from "../src/ai/crux.js";
import { LlmFailureGate } from "../src/ai/failure.js";
import type { CruxSummarizer, FileCruxInput, NodeCrux } from "../src/ai/crux.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";
import type { NodeV1 } from "../src/graph/types.js";
import { extractFile } from "../src/graph/extract.js";

class EmptyCrux implements CruxSummarizer {
  calls = 0;
  async describeFile(_input: FileCruxInput): Promise<NodeCrux[]> {
    this.calls++;
    return [];
  }
}

class CannedModel implements ChatModel {
  readonly label = "fake:quality";
  constructor(
    private readonly reply: {
      text?: string;
      toolCalls?: ToolCall[];
      stopReason?: string | null;
    },
  ) {}
  async create(_req: ChatRequest): Promise<ChatResponse> {
    const text = this.reply.text ?? "";
    return {
      text,
      toolCalls: this.reply.toolCalls ?? [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: this.reply.stopReason ?? "stop",
      assistant: { role: "assistant", content: text },
    };
  }
}

function node(path: string): NodeV1 {
  return {
    id: `${path}#run`,
    name: "run",
    kind: "function",
    path,
    span: "L1-L3",
    signature: "run()",
    exported: true,
    origin: "ast",
    body_hash: `h-${path}`,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function fixture(n: number): { nodes: NodeV1[]; sources: Map<string, string> } {
  const paths = Array.from({ length: n }, (_, i) => `f${i}.ts`);
  return {
    nodes: paths.map(node),
    sources: new Map(paths.map((p) => [p, "export function run() {\n  return 1;\n}\n"])),
  };
}

function oneFile(summarizer: CruxSummarizer) {
  const { nodes, sources } = fixture(1);
  return enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 }).then((stats) => ({
    stats,
    nodes,
  }));
}

test("#235: consecutive empty crux replies do not abort the rest of the pass", async () => {
  const { nodes, sources } = fixture(12);
  const summarizer = new EmptyCrux();

  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.equal(stats.fatal, undefined, "content-quality misses must not trip the consecutive-failure gate");
  assert.ok(summarizer.calls >= 12, `every file must be attempted, saw ${summarizer.calls} calls`);
  assert.equal(stats.failedFiles, 12);
  assert.equal(stats.skippedFiles, 0);
  assert.equal(stats.computed, 0);
  for (const n of nodes) {
    assert.equal(n.summary_state, "pending", "empty replies must not be cached as ready (#177)");
    assert.equal(n.summary, null);
  }
});

test("#235: consecutive 401s still stop the pass immediately (#127)", async () => {
  const { nodes, sources } = fixture(10);
  class AuthFail implements CruxSummarizer {
    calls = 0;
    async describeFile(): Promise<NodeCrux[]> {
      this.calls++;
      throw new Error("401 Unauthorized: invalid api key");
    }
  }
  const summarizer = new AuthFail();

  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.match(stats.fatal ?? "", /rejected the API key/);
  assert.equal(summarizer.calls, 1, "quota/auth is still terminal on the first file");
  assert.equal(stats.failedFiles, 1);
  assert.equal(stats.skippedFiles, 9);
});

test("#235: LlmFailureGate.record quality misses never set fatal; quota still does", () => {
  const quality = new LlmFailureGate();
  for (let i = 0; i < 12; i++) {
    quality.record("model returned no usable symbol summaries [empty-toolCalls, finish_reason=stop]", {
      quality: true,
    });
  }
  assert.equal(quality.fatal, undefined);
  assert.equal(quality.failed, 12);
  assert.equal(quality.stopped, false);

  const auth = new LlmFailureGate();
  auth.record("401 Unauthorized: invalid api key", { quality: true });
  assert.match(auth.fatal ?? "", /rejected the API key/);
});

test("#235: empty toolCalls names empty-toolCalls and finish_reason", async () => {
  const summarizer = new ChatCruxSummarizer(new CannedModel({ toolCalls: [], text: "", stopReason: "stop" }));
  const { stats } = await oneFile(summarizer);
  assert.equal(stats.failedFiles, 1);
  assert.match(stats.errors[0] ?? "", /empty-toolCalls/);
  assert.match(stats.errors[0] ?? "", /finish_reason=stop/);
});

test("#235: truncated output names truncated and finish_reason=length", async () => {
  const summarizer = new ChatCruxSummarizer(
    new CannedModel({
      text: '{"symbols":[{"id":"f0.ts#run","summary":"partial',
      toolCalls: [],
      stopReason: "length",
    }),
  );
  const { stats } = await oneFile(summarizer);
  assert.equal(stats.failedFiles, 1);
  assert.match(stats.errors[0] ?? "", /truncated/);
  assert.match(stats.errors[0] ?? "", /finish_reason=length/);
});

test("#235: unparseable content names unparseable", async () => {
  const summarizer = new ChatCruxSummarizer(
    new CannedModel({
      text: "The architecture is a layered monolith.",
      toolCalls: [],
      stopReason: "stop",
    }),
  );
  const { stats } = await oneFile(summarizer);
  assert.equal(stats.failedFiles, 1);
  assert.match(stats.errors[0] ?? "", /unparseable/);
  assert.match(stats.errors[0] ?? "", /finish_reason=stop/);
});

test("#235: blank parsed summaries name empty-parsed and stay pending", async () => {
  const summarizer = new ChatCruxSummarizer(
    new CannedModel({
      toolCalls: [
        {
          id: "1",
          name: "record_symbols",
          args: { symbols: [{ id: "f0.ts#run", summary: "  ", crux_start: 0, crux_end: 0 }] },
        },
      ],
      stopReason: "stop",
    }),
  );
  const { stats, nodes } = await oneFile(summarizer);
  assert.equal(stats.failedFiles, 1);
  assert.equal(stats.computed, 0);
  assert.match(stats.errors[0] ?? "", /empty-parsed/);
  assert.equal(nodes[0].summary_state, "pending");
  assert.equal(nodes[0].summary, null);
});

test("#259: unmatched ids name id-mismatch with the returned id, and never reach the gate", async () => {
  // A returned id can hold any source text; "Quota" here must not read as a quota error.
  const invented = "f0.ts#Quota | function | lines L1-L3";
  const summarizer = new ChatCruxSummarizer(
    new CannedModel({
      toolCalls: [
        {
          id: "1",
          name: "record_symbols",
          args: { symbols: [{ id: invented, summary: "runs it", crux_start: 0, crux_end: 0 }] },
        },
      ],
      stopReason: "tool_calls",
    }),
  );
  const { stats, nodes } = await oneFile(summarizer);
  assert.equal(stats.failedFiles, 1);
  assert.equal(stats.fatal, undefined);
  assert.equal(
    stats.errors[0],
    "f0.ts: model returned summaries but no id matched a requested target [id-mismatch, finish_reason=tool_calls]" +
      `\n    first of 1 returned id(s): ${JSON.stringify(invented)}`,
  );
  assert.equal(nodes[0].summary_state, "pending");
});

test("#259: old-row echoes preserve a supported filename's leading whitespace", async () => {
  const path = " leading.ts";
  const source = "export function run() {\n  return 1;\n}\n";
  const { nodes } = extractFile(path, source, "typescript");
  let calls = 0;
  const model: ChatModel = {
    label: "fake:whitespace-path",
    async create() {
      calls++;
      return {
        text: "",
        toolCalls: [{ id: "1", name: "record_symbols", args: { symbols: nodes.map((n) => ({
          id: `${n.id} | ${n.kind} | lines L1-L3`, summary: "a useful purpose", crux_start: 0, crux_end: 0,
        })) } }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        stopReason: "tool_calls",
        assistant: { role: "assistant", content: "" },
      };
    },
  };
  const stats = await enrichGraph(nodes, new Map(), new Map([[path, source]]), {
    summarizer: new ChatCruxSummarizer(model), concurrency: 1,
  });
  assert.equal(nodes.length, 2);
  assert.equal(calls, 1, "decorated exact IDs need no retry");
  assert.equal(stats.computed, nodes.length);
  assert.equal(stats.failedFiles, 0);
  for (const n of nodes) assert.equal(n.summary_state, "ready");
});
