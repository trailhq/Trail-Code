/**
 * The symbol-summary prompt lists targets as `- id=<path> | <kind> | lines …`,
 * and a model that echoes the whole line's head — `"src/conditions.ts | file"`
 * — used to have its good summary discarded, because reply ids were matched
 * exactly (measured 2026-09-29: two summaries dropped, "no usable symbol
 * summaries [empty-parsed]"). The prompt now quotes the id so the delimiter
 * reads as a delimiter, and a reply id is canonicalized — trimmed, unquoted,
 * a trailing ` | <kind>` stripped — before it is given up on.
 *
 * Fixtures are synthetic: made-up paths, made-up one-line summaries, no real
 * source anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCruxSummarizer, type FileCruxInput, type NodeCrux } from "../src/ai/crux.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";

/** A stub model that replays one tool call, recording the request. */
class ReplayToolModel implements ChatModel {
  readonly label = "stub:echo";
  lastRequest: ChatRequest | null = null;
  constructor(private readonly call: { name: string; args: unknown }) {}
  async create(_req: ChatRequest): Promise<ChatResponse> {
    this.lastRequest = _req;
    const toolCall: ToolCall = { id: "c1", name: this.call.name, args: this.call.args };
    return {
      text: "",
      toolCalls: [toolCall],
      usage: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 },
      stopReason: "tool_calls",
      assistant: { role: "assistant", content: "", toolCalls: [toolCall] },
    };
  }
}

const INPUT: FileCruxInput = {
  path: "src/conditions.ts",
  source: ["export function check(x: number): boolean {", "  return x > 0;", "}"].join("\n"),
  nodes: [
    { id: "src/conditions.ts", kind: "file", signature: null, startLine: 1, endLine: 3 },
    { id: "src/conditions.ts:check", kind: "function", signature: "check(x: number): boolean", startLine: 1, endLine: 3 },
  ],
};

test("crux: the prompt quotes each target id so the | delimiter cannot read as part of it", async () => {
  const model = new ReplayToolModel({ name: "record_symbols", args: { symbols: [] } });
  await new ChatCruxSummarizer(model).describeFile(INPUT);

  const user = model.lastRequest?.messages.find((m) => m.role === "user")?.content ?? "";
  assert.match(user, /- id="src\/conditions\.ts" \| file \| lines L1-L3/);
  assert.match(user, /- id="src\/conditions\.ts:check" \| function \| lines L1-L3/);
});

test("crux: a summary filed under `id | kind` is credited to the plain id", async () => {
  // Shaped like the measured reply: the model echoed the prompt line's head,
  // twice for the same target, plus one id it copied verbatim.
  const model = new ReplayToolModel({
    name: "record_symbols",
    args: {
      symbols: [
        { id: "src/conditions.ts | file", summary: "holds the rule engine's guards.", crux_start: 2, crux_end: 2 },
        { id: "src/conditions.ts | file", summary: "echoed a second time.", crux_start: 0, crux_end: 0 },
        { id: "src/conditions.ts:check", summary: "accepts positives only.", crux_start: 2, crux_end: 2 },
      ],
    },
  });
  const out: NodeCrux[] = await new ChatCruxSummarizer(model).describeFile(INPUT);

  assert.deepEqual(
    [...new Set(out.map((c) => c.id))].sort(),
    ["src/conditions.ts", "src/conditions.ts:check"],
    `expected the echoed ids canonicalized, got ${out.map((c) => c.id).join(", ")}`,
  );
  // Both echoed entries are credited; the consumer (enrich) keeps the first.
  const file = out.filter((c) => c.id === "src/conditions.ts");
  assert.equal(file.length, 2);
  assert.equal(file[0].summary, "holds the rule engine's guards.");
  assert.deepEqual(
    out.find((c) => c.id === "src/conditions.ts:check"),
    { id: "src/conditions.ts:check", summary: "accepts positives only.", crux_start: 2, crux_end: 2 },
  );
});

test("crux: an id echoed in the prompt's quotes still matches once the quotes are gone", async () => {
  const model = new ReplayToolModel({
    name: "record_symbols",
    args: {
      symbols: [{ id: '"src/conditions.ts:check"', summary: "quoted echo.", crux_start: 0, crux_end: 0 }],
    },
  });
  const out = await new ChatCruxSummarizer(model).describeFile(INPUT);

  assert.equal(out.length, 1);
  assert.equal(out[0].id, "src/conditions.ts:check");
});

test("crux: a genuinely unknown id is left untouched for the re-ask loop to catch", async () => {
  const model = new ReplayToolModel({
    name: "record_symbols",
    args: {
      symbols: [{ id: "src/nowhere.ts:ghost | function", summary: "invented.", crux_start: 0, crux_end: 0 }],
    },
  });
  const out = await new ChatCruxSummarizer(model).describeFile(INPUT);

  assert.equal(out.length, 1);
  assert.equal(out[0].id, "src/nowhere.ts:ghost | function");
});
