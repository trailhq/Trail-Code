/**
 * #383: a forced record_graph call whose `nodes` argument is a JSON *string*
 * (double-encoded, sometimes with a stray `}`) is dropped by `clean()`'s
 * `Array.isArray` guard. warnToolChoiceIgnored does not fire — there was a
 * real tool call — so the CLI prints `✓ concepts: 0 nodes`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatSynthesizer } from "../src/ai/synthesize.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";

class FakeChatModel implements ChatModel {
  readonly label = "fake:synthesize-clean";
  last?: ChatRequest;
  constructor(private reply: { text?: string; toolCalls?: ToolCall[] }) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.last = req;
    return {
      text: this.reply.text ?? "",
      toolCalls: this.reply.toolCalls ?? [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "tool_calls",
      assistant: { role: "assistant", content: this.reply.text ?? "", toolCalls: this.reply.toolCalls },
    };
  }
}

const GRAPH = {
  name: "Graph Engine",
  type: "system",
  summary: "Builds the code graph from tree-sitter.",
  sources: ["src/graph/build.ts"],
  links: [] as [],
};
const PARSE = {
  name: "Parse",
  type: "concept",
  summary: "Depth-tier extract walks one file at a time.",
  sources: ["src/graph/extract.ts"],
  links: [{ to: "Graph Engine", relation: "part_of" }],
};

/** 12k+ double-encoded payload with a stray `}` between the two objects (#383 capture). */
function stringifiedNodesWithStrayBrace(): string {
  const fat = { ...GRAPH, summary: GRAPH.summary + " " + "x".repeat(12_000) };
  const inner = JSON.stringify([fat, PARSE]);
  const seam = inner.indexOf("},{");
  if (seam < 0) throw new Error("expected two-object JSON array");
  const broken = `${inner.slice(0, seam + 1)}}${inner.slice(seam + 1)}`;
  assert.ok(broken.length >= 12_000, `fixture must be 12k+ chars, got ${broken.length}`);
  assert.throws(() => JSON.parse(broken), "stray brace must make JSON.parse fail");
  return broken;
}

test("#383: a 12k stringified nodes payload with a stray brace still yields nodes", async () => {
  const raw = stringifiedNodesWithStrayBrace();
  const m = new FakeChatModel({
    toolCalls: [{ id: "1", name: "record_graph", args: { nodes: raw } }],
  });
  const { result, err } = await withCapturedError(() =>
    new ChatSynthesizer(m).synthesize([{ path: "src/graph/build.ts", summary: "x" }]),
  );
  assert.ok(result.length >= 2, `expected salvaged nodes, got ${result.map((n) => n.name).join(",") || "(none)"}`);
  assert.ok(result.some((n) => n.name === GRAPH.name));
  assert.ok(result.some((n) => n.name === PARSE.name));
  assert.ok(
    err.some((l) => /synthesize:/.test(l) && /string/.test(l) && /12000|12\d{3}/.test(l)),
    `must warn with type and char count, got: ${err.join(" | ") || "(silence)"}`,
  );
  assert.ok(
    err.some((l) => /salvaged|2/.test(l) && /tool call/.test(l)),
    `must mention salvage count and tool-call count, got: ${err.join(" | ")}`,
  );
  assert.ok(!err.some((l) => /✓/.test(l)), "must not tick a successful empty batch");
});

test("#383: a genuine empty nodes array stays 0 but does not look like success", async () => {
  const m = new FakeChatModel({
    toolCalls: [{ id: "1", name: "record_graph", args: { nodes: [] } }],
  });
  const { result, err } = await withCapturedError(() =>
    new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
  );
  assert.deepEqual(result, []);
  assert.ok(
    err.some((l) => /synthesize:/.test(l) && /empty/.test(l)),
    `empty array must warn, not stay silent, got: ${err.join(" | ") || "(silence)"}`,
  );
  assert.ok(!err.some((l) => /✓/.test(l)), "0-node batch must not print a success tick");
});

async function withCapturedError<T>(fn: () => Promise<T>): Promise<{ result: T; err: string[] }> {
  const err: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => {
    err.push(args.map((a) => String(a)).join(" "));
  };
  console.log = (...args: unknown[]) => {
    err.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { result: await fn(), err };
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
}
