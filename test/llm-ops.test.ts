/**
 * The three engine ops (summarize / synthesize / crux) over a fake transport —
 * proves each builds the right ChatRequest and parses the response, with no key
 * and no network. Structured ops (synthesize, crux) ride forced tool-calling;
 * summarize is plain text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatSummarizer } from "../src/ai/summarize.js";
import { ChatSynthesizer } from "../src/ai/synthesize.js";
import {
  ChatCruxSummarizer,
  formatCruxMiss,
  formatCruxMissDetail,
  resolveTargetId,
} from "../src/ai/crux.js";
import { recoverToolArgsFromContent } from "../src/ai/llm/recover-tool.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";

/** Records the last request and replays a canned response. */
class FakeChatModel implements ChatModel {
  readonly label = "fake:model";
  last?: ChatRequest;
  constructor(private reply: { text?: string; toolCalls?: ToolCall[] }) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.last = req;
    return {
      text: this.reply.text ?? "",
      toolCalls: this.reply.toolCalls ?? [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "stop",
      assistant: { role: "assistant", content: this.reply.text ?? "" },
    };
  }
}

test("ChatSummarizer sends plain text and returns trimmed content", async () => {
  const m = new FakeChatModel({ text: "  a prose summary  " });
  const out = await new ChatSummarizer(m).summarize("code", { path: "a.ts" });
  assert.equal(out, "a prose summary");
  assert.equal(m.last?.responseFormat, undefined); // plain text
  assert.equal(m.last?.messages[0].role, "system");
});

test("ChatSynthesizer forces record_graph and cleans parsed args", async () => {
  const m = new FakeChatModel({
    toolCalls: [
      {
        id: "1",
        name: "record_graph",
        args: { nodes: [{ name: "Auth", type: "system", summary: "s", sources: ["a.ts"], links: [] }] },
      },
    ],
  });
  const nodes = await new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]);
  assert.deepEqual(m.last?.responseFormat, { kind: "tool", name: "record_graph" });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
});

test("ChatCruxSummarizer forces record_symbols and normalizes numbers", async () => {
  const m = new FakeChatModel({
    toolCalls: [
      { id: "1", name: "record_symbols", args: { symbols: [{ id: "sym1", summary: "does x", crux_start: 3.9, crux_end: 5 }] } },
    ],
  });
  const out = await new ChatCruxSummarizer(m).describeFile({
    path: "a.ts",
    source: "l1\nl2\nl3\nl4\nl5\n",
    nodes: [{ id: "sym1", kind: "function", signature: null, startLine: 1, endLine: 5 }],
  });
  assert.deepEqual(m.last?.responseFormat, { kind: "tool", name: "record_symbols" });
  assert.deepEqual(out, [{ id: "sym1", summary: "does x", crux_start: 3, crux_end: 5 }]);
});

/** A crux reply carrying one entry per id in `ids`, in order. */
function cruxReply(ids: string[]): FakeChatModel {
  const symbols = ids.map((id, i) => ({ id, summary: `summary ${i}`, crux_start: 0, crux_end: 0 }));
  return new FakeChatModel({ toolCalls: [{ id: "1", name: "record_symbols", args: { symbols } }] });
}

const CRUX_INPUT = {
  path: "Runtime/Core/Ctx.cs",
  source: "l1\nl2\nl3\nl4\nl5\n",
  nodes: [
    { id: "Runtime/Core/Ctx.cs", kind: "file" as const, signature: null, startLine: 1, endLine: 5 },
    {
      id: "Runtime/Core/Ctx.cs#Level",
      kind: "variable" as const,
      signature: "public int Level { get; }",
      startLine: 3,
      endLine: 3,
    },
  ],
};

test("crux target lines end with the id, so the id field is terminated (#259)", async () => {
  const m = cruxReply(["Runtime/Core/Ctx.cs", "Runtime/Core/Ctx.cs#Level"]);
  await new ChatCruxSummarizer(m).describeFile(CRUX_INPUT);
  const user = m.last?.messages.find((x) => x.role === "user")?.content ?? "";
  const rows = user.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(rows, [
    "- file | lines L1-L5 | id=Runtime/Core/Ctx.cs",
    "- variable | lines L3-L3 | public int Level { get; } | id=Runtime/Core/Ctx.cs#Level",
  ]);
});

test("ChatCruxSummarizer keeps an exact id and reports no miss", async () => {
  const s = new ChatCruxSummarizer(cruxReply(["Runtime/Core/Ctx.cs", "Runtime/Core/Ctx.cs#Level"]));
  const out = await s.describeFile(CRUX_INPUT);
  assert.deepEqual(out.map((r) => r.id), ["Runtime/Core/Ctx.cs", "Runtime/Core/Ctx.cs#Level"]);
  assert.equal(s.lastMiss, null);
});

test("ChatCruxSummarizer maps a whole echoed target row back to the requested id (#259)", async () => {
  const s = new ChatCruxSummarizer(
    cruxReply([
      // gpt-5.6-luna on 0.20.0: the old `id=` first row, echoed from the id onwards.
      "Runtime/Core/Ctx.cs | file | lines L1-L5",
      "Runtime/Core/Ctx.cs#Level | variable | lines L3-L3 | public int Level { get; }",
    ]),
  );
  const out = await s.describeFile(CRUX_INPUT);
  assert.deepEqual(out.map((r) => r.id), ["Runtime/Core/Ctx.cs", "Runtime/Core/Ctx.cs#Level"]);
  assert.equal(s.lastMiss, null);
});

test("ChatCruxSummarizer strips a leading id= and repairs an echo of the current layout", async () => {
  const s = new ChatCruxSummarizer(
    cruxReply([
      "id=Runtime/Core/Ctx.cs",
      "- variable | lines L3-L3 | public int Level { get; } | id=Runtime/Core/Ctx.cs#Level",
    ]),
  );
  const out = await s.describeFile(CRUX_INPUT);
  assert.deepEqual(out.map((r) => r.id), ["Runtime/Core/Ctx.cs", "Runtime/Core/Ctx.cs#Level"]);
  assert.equal(s.lastMiss, null);
});

test("an invented id is not repaired and is reported as id-mismatch", async () => {
  const invented = "Runtime/Core/Other.cs#Level | variable | lines L3-L3";
  const s = new ChatCruxSummarizer(cruxReply([invented, "id=Runtime/Core/Nope.cs"]));
  const out = await s.describeFile(CRUX_INPUT);
  assert.deepEqual(out.map((r) => r.id), [invented, "id=Runtime/Core/Nope.cs"]);
  assert.deepEqual(s.lastMiss, {
    kind: "id-mismatch",
    finishReason: "stop",
    returned: 2,
    firstId: invented,
  });
  assert.equal(
    formatCruxMiss("id-mismatch", "stop"),
    "model returned summaries but no id matched a requested target [id-mismatch, finish_reason=stop]",
  );
  assert.equal(formatCruxMissDetail(s.lastMiss), `first of 2 returned id(s): ${JSON.stringify(invented)}`);
});

test("resolveTargetId takes the longest requested id when several qualify", () => {
  const requested = ["a.ts#f", "a.ts#f | g"];
  assert.equal(resolveTargetId("a.ts#f | g | function | lines L1-L2", requested), "a.ts#f | g");
  assert.equal(resolveTargetId("a.ts#f | function | lines L1-L2", requested), "a.ts#f");
  assert.equal(resolveTargetId("  a.ts#f  ", requested), "a.ts#f");
  assert.equal(resolveTargetId("a.ts#fg | function", requested), null);
});

test("resolveTargetId preserves whitespace belonging to requested IDs", () => {
  for (const target of [" leading.ts#run", "a.ts#trailing ", " both "]) {
    const requested = [target];
    for (const raw of [target, `${target} | function | lines L1-L3`, `id=${target}`,
      `id=${target} | function | lines L1-L3`, `- function | lines L1-L3 | id=${target}`]) {
      assert.equal(resolveTargetId(raw, requested), target, JSON.stringify(raw));
    }
  }
  assert.equal(resolveTargetId("  id=  a.ts#run  ", ["a.ts#run"]), "a.ts#run");
  assert.equal(resolveTargetId("  a.ts#run | function  ", ["a.ts#run"]), "a.ts#run");
});

test("resolveTargetId takes the longest exact ID after id= whitespace fallbacks", () => {
  for (const requested of [["leading.ts", " leading.ts"], [" leading.ts", "leading.ts"]]) {
    assert.equal(resolveTargetId("id= leading.ts ", requested), " leading.ts");
  }
});

test("structured ops degrade gracefully when the model returns no tool call", async () => {
  const empty = new FakeChatModel({ toolCalls: [] });
  const { err } = await withCapturedError(async () => {
    assert.deepEqual(await new ChatSynthesizer(empty).synthesize([{ path: "a.ts", summary: "x" }]), []);
    assert.deepEqual(
      await new ChatCruxSummarizer(empty).describeFile({
        path: "a.ts",
        source: "x",
        nodes: [{ id: "s", kind: "function", signature: null, startLine: 1, endLine: 1 }],
      }),
      [],
    );
  });
  assert.ok(err.some((l) => /synthesize:.*no tool call and no content/.test(l)));
  assert.ok(err.some((l) => /crux:.*no tool call and no content/.test(l)));
});

const AUTH_NODE = { name: "Auth", type: "system", summary: "s", sources: ["a.ts"], links: [] as [] };
const AUTH_PAYLOAD = { nodes: [AUTH_NODE] };

test("#129: ChatSynthesizer recovers nodes from content JSON when toolCalls is empty", async () => {
  const m = new FakeChatModel({
    text: JSON.stringify([{ name: "emit_json", parameters: AUTH_PAYLOAD }]),
    toolCalls: [],
  });
  const { result: nodes, err } = await withCapturedError(() =>
    new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
  assert.equal(err.length, 0);
});

test("#129: ChatSynthesizer recovers a single-object wrapper and a fenced JSON payload", async () => {
  const objectWrap = new FakeChatModel({
    text: JSON.stringify({ name: "record_graph", parameters: AUTH_PAYLOAD }),
    toolCalls: [],
  });
  assert.equal((await new ChatSynthesizer(objectWrap).synthesize([{ path: "a.ts", summary: "x" }]))[0]?.name, "Auth");

  const fenced = new FakeChatModel({
    text: "```json\n" + JSON.stringify(AUTH_PAYLOAD) + "\n```",
    toolCalls: [],
  });
  assert.equal((await new ChatSynthesizer(fenced).synthesize([{ path: "a.ts", summary: "x" }]))[0]?.name, "Auth");
});

test("#129: unparseable content warns and does not throw", async () => {
  const m = new FakeChatModel({ text: "The architecture is a layered monolith.", toolCalls: [] });
  const { result: nodes, err } = await withCapturedError(() =>
    new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
  );
  assert.deepEqual(nodes, []);
  assert.ok(err.some((l) => /synthesize:.*not parseable tool-call JSON/.test(l)));
});

test("#129: a real toolCalls payload is preferred over content JSON", async () => {
  const m = new FakeChatModel({
    text: JSON.stringify({ nodes: [{ name: "WRONG", type: "system", summary: "s", sources: ["a.ts"], links: [] }] }),
    toolCalls: [{ id: "1", name: "record_graph", args: AUTH_PAYLOAD }],
  });
  const nodes = await new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
});

const RECOVER_OPTS = { toolNames: ["record_graph", "emit_json"] as const, payloadKey: "nodes" };

test("#129: recoverToolArgsFromContent accepts the three issue shapes and refuses the rest", () => {
  const payload = { nodes: [{ name: "Auth" }] };
  assert.deepEqual(
    recoverToolArgsFromContent(JSON.stringify([{ name: "emit_json", parameters: payload }]), RECOVER_OPTS)?.nodes,
    payload.nodes,
  );
  assert.deepEqual(
    recoverToolArgsFromContent(JSON.stringify({ name: "record_graph", parameters: payload }), RECOVER_OPTS)?.nodes,
    payload.nodes,
  );
  assert.deepEqual(
    recoverToolArgsFromContent("```json\n" + JSON.stringify(payload) + "\n```", RECOVER_OPTS)?.nodes,
    payload.nodes,
  );
  // CodeQL js/polynomial-redos: spaces around a fence must stay linear and still parse.
  const padded =
    " ".repeat(8_000) + "```json" + " ".repeat(8_000) + JSON.stringify(payload) + " ".repeat(8_000) + "```";
  assert.deepEqual(recoverToolArgsFromContent(padded, RECOVER_OPTS)?.nodes, payload.nodes);
  assert.equal(recoverToolArgsFromContent("The architecture is a layered monolith.", RECOVER_OPTS), undefined);
  assert.equal(recoverToolArgsFromContent("", RECOVER_OPTS), undefined);
  assert.equal(
    recoverToolArgsFromContent('[{"name":"emit_json","parameters":{"nodes":[', RECOVER_OPTS),
    undefined,
  );
  assert.equal(
    recoverToolArgsFromContent(JSON.stringify([{ name: "other_tool", parameters: payload }]), RECOVER_OPTS),
    undefined,
  );
});

/** Capture console.error so tests can assert the #129 warnings without leaking them. */
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
