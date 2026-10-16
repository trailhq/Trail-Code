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
import { ChatCruxSummarizer } from "../src/ai/crux.js";
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
  // Unrepairable truncation: no complete object, so do not guess (#253).
  assert.equal(
    recoverToolArgsFromContent('[{"name":"emit_json","parameters":{"nodes":[', RECOVER_OPTS),
    undefined,
  );
  assert.equal(
    recoverToolArgsFromContent(JSON.stringify([{ name: "other_tool", parameters: payload }]), RECOVER_OPTS),
    undefined,
  );
});

const BARE_NODE = { name: "Auth", type: "system", summary: "s", sources: ["a.ts"] };
const BARE_NODE_2 = { name: "Api", type: "system", summary: "billing", sources: ["b.ts"] };
const CRUX_OPTS = { toolNames: ["record_symbols", "emit_json"] as const, payloadKey: "symbols" };
const CRUX_ITEM = { id: "a.ts#create", summary: "creates a user", crux_start: 38, crux_end: 41 };

test("#253: recoverToolArgsFromContent accepts a bare item array (no tool envelope)", () => {
  const items = [BARE_NODE, BARE_NODE_2];
  // Synth concept/system nodes carry `name`; that must not be treated as a tool wrapper.
  assert.deepEqual(recoverToolArgsFromContent(JSON.stringify(items), RECOVER_OPTS)?.nodes, items);
  assert.deepEqual(
    recoverToolArgsFromContent("```json\n" + JSON.stringify(items) + "\n```", RECOVER_OPTS)?.nodes,
    items,
  );
  assert.deepEqual(recoverToolArgsFromContent("Response:\n" + JSON.stringify(items), RECOVER_OPTS)?.nodes, items);
  const cruxItems = [CRUX_ITEM, { id: "a.ts#login", summary: "logs in", crux_start: 50, crux_end: 55 }];
  assert.deepEqual(recoverToolArgsFromContent(JSON.stringify(cruxItems), CRUX_OPTS)?.symbols, cruxItems);
});

test("#253: recoverToolArgsFromContent repairs truncated JSON at a complete object", () => {
  const truncatedBare = `[${JSON.stringify(BARE_NODE)},{"name":"Api","type":"system","summary":"par`;
  assert.deepEqual(recoverToolArgsFromContent(truncatedBare, RECOVER_OPTS)?.nodes, [BARE_NODE]);

  const truncatedEnvelope = `{"nodes":[${JSON.stringify(BARE_NODE)},{"name":"Api","type":`;
  assert.deepEqual(recoverToolArgsFromContent(truncatedEnvelope, RECOVER_OPTS)?.nodes, [BARE_NODE]);

  const truncatedCrux = `[${JSON.stringify(CRUX_ITEM)},{"id":"a.ts#login","summary":"par`;
  assert.deepEqual(recoverToolArgsFromContent(truncatedCrux, CRUX_OPTS)?.symbols, [CRUX_ITEM]);

  // Nested `}` then a cut: keep the complete item, do not invent the rest.
  const nested = {
    name: "Auth",
    type: "system",
    summary: "s",
    sources: ["a.ts"],
    extra: { x: 1 },
  };
  const truncatedNested = `[${JSON.stringify(nested)},{"name":"Api","summary":`;
  assert.deepEqual(recoverToolArgsFromContent(truncatedNested, RECOVER_OPTS)?.nodes, [nested]);
});

test("#253: truncation inside a trailing item's nested objects keeps only complete items", () => {
  const partial = '{"name":"Api","type":"system","summary":"s","sources":["b.ts"],"links":[{"to":"Auth","relation":"depends_on"},';
  for (const prefix of ["[", '{"nodes":[', '[{"name":"record_graph","parameters":{"nodes":[']) {
    assert.deepEqual(
      recoverToolArgsFromContent(prefix + JSON.stringify(BARE_NODE) + "," + partial, RECOVER_OPTS)?.nodes,
      [BARE_NODE],
      "must not invent the closing delimiters of a partially emitted payload item",
    );
    assert.equal(recoverToolArgsFromContent(prefix + partial, RECOVER_OPTS), undefined);
  }
});

test("#253: bare-array recovery does not bypass a rejected tool envelope", () => {
  const wrongTool = { name: "other_tool", parameters: { nodes: [BARE_NODE] } };
  for (const prefix of ["", "Response:\n"]) {
    assert.equal(recoverToolArgsFromContent(prefix + JSON.stringify(wrongTool), RECOVER_OPTS), undefined);
    assert.equal(recoverToolArgsFromContent(prefix + JSON.stringify(wrongTool).slice(0, -2), RECOVER_OPTS), undefined);
  }
});

test("#253: unrepairable truncation still fails without guessing", () => {
  assert.equal(recoverToolArgsFromContent('{"nodes":[', RECOVER_OPTS), undefined);
  assert.equal(recoverToolArgsFromContent('[{"id":"', CRUX_OPTS), undefined);
  assert.equal(recoverToolArgsFromContent('{"nodes":[{"name":"Auth","summary":"has } in text', RECOVER_OPTS), undefined);
});

test("#253: long whitespace around a truncated prefix stays linear", () => {
  const padded =
    "[" + " ".repeat(8_000) + JSON.stringify(BARE_NODE) + ',{"name":"Api","type":"system","summary":"par';
  assert.deepEqual(recoverToolArgsFromContent(padded, RECOVER_OPTS)?.nodes, [BARE_NODE]);
});

test("#253: ChatSynthesizer recovers a bare node array from content", async () => {
  const m = new FakeChatModel({
    text: JSON.stringify([AUTH_NODE, { name: "Api", type: "system", summary: "s", sources: ["b.ts"], links: [] }]),
    toolCalls: [],
  });
  const { result: nodes, err } = await withCapturedError(() =>
    new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
  );
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].name, "Auth");
  assert.equal(nodes[1].name, "Api");
  assert.equal(err.length, 0);
});

test("#253: ChatCruxSummarizer keeps complete items from truncated content", async () => {
  const m = new FakeChatModel({
    text: `[${JSON.stringify({ id: "sym1", summary: "does x", crux_start: 3, crux_end: 5 })},{"id":"sym2","summary":"par`,
    toolCalls: [],
  });
  const { result: out, err } = await withCapturedError(() =>
    new ChatCruxSummarizer(m).describeFile({
      path: "a.ts",
      source: "l1\nl2\nl3\nl4\nl5\n",
      nodes: [
        { id: "sym1", kind: "function", signature: null, startLine: 1, endLine: 5 },
        { id: "sym2", kind: "function", signature: null, startLine: 6, endLine: 8 },
      ],
    }),
  );
  assert.deepEqual(out, [{ id: "sym1", summary: "does x", crux_start: 3, crux_end: 5 }]);
  assert.equal(err.length, 0);
});

test("#253: a real toolCalls payload is still preferred over a bare content array", async () => {
  const m = new FakeChatModel({
    text: JSON.stringify([{ name: "WRONG", type: "system", summary: "s", sources: ["a.ts"], links: [] }]),
    toolCalls: [{ id: "1", name: "record_graph", args: AUTH_PAYLOAD }],
  });
  const nodes = await new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
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
