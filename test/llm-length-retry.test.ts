/**
 * A reasoning model that spends the whole output allowance thinking and gets
 * cut off: HTTP 200, `finish_reason: "length"`, empty `content`, no tool call,
 * thousands of characters of `message.reasoning` (measured on 2026-09-29
 * through a logging proxy in front of OpenRouter: six such calls, 0 nodes out,
 * while the same run with `reasoning: { effort: "low" }` produced 56).
 *
 * A structured call that ends that way must be retried once with a larger
 * output allowance and a low reasoning effort — running out of tokens says
 * nothing about `tool_choice` support, so it must not walk the forced-choice
 * downgrade either.
 *
 * Network-free: a STUB client replays the exact bodies and records every
 * request, so the boost is asserted on the wire params.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { OpenAIChatModel } from "../src/ai/llm/openai.js";
import { ChatSynthesizer } from "../src/ai/synthesize.js";
import type { ChatRequest } from "../src/ai/llm/types.js";

/** A stub client that answers each call with the next queued body. */
function stubClient(...bodies: unknown[]): { client: OpenAI; calls: any[] } {
  const calls: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push(params);
          const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
          if (body instanceof Error) throw body;
          return body;
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

/** No-op backoff, so retry budgets never wait. */
function instantSleep() {
  return { sleep: async (_ms: number) => {} };
}

/**
 * The length-truncated reasoning reply: 200, nothing usable in `content`, no
 * tool call, a big reasoning field the endpoint wrote instead of an answer.
 */
function reasoningLengthBody(reasoningChars = 1000) {
  return {
    choices: [
      {
        message: { content: "", reasoning: "s".repeat(reasoningChars), tool_calls: [] },
        finish_reason: "length",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 8192 },
  };
}

function toolBody(name: string, args: unknown) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function textBody(content: string) {
  return {
    choices: [{ message: { content, tool_calls: [] }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

const SYNTH_TOOL = "record_graph";
const SYNTH_REQ: ChatRequest = {
  temperature: 0,
  maxTokens: 8192,
  messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
  tools: [{ name: SYNTH_TOOL, description: "d", parameters: { type: "object" } }],
  responseFormat: { kind: "tool", name: SYNTH_TOOL },
};

/** Capture console.error so the one-off notices neither leak nor collide. */
async function withCapturedError<T>(fn: () => Promise<T>): Promise<{ result: T; err: string[] }> {
  const err: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void err.push(args.map(String).join(" "));
  try {
    return { result: await fn(), err };
  } finally {
    console.error = orig;
  }
}

/** Set one env var for the duration of `fn`, restoring whatever it held. */
async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const orig = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (orig === undefined) delete process.env[name];
    else process.env[name] = orig;
  }
}

test("openai: a structured call cut off at length is retried once with a bigger allowance and low reasoning effort", async () => {
  const { client, calls } = stubClient(reasoningLengthBody(), toolBody(SYNTH_TOOL, { nodes: [{ name: "api" }] }));
  const m = new OpenAIChatModel({ apiKey: "x", model: "reasoner", client, sleep: instantSleep().sleep });

  const { result, err } = await withCapturedError(() => m.create(SYNTH_REQ));

  assert.equal(calls.length, 2, "one re-send, not a loop");
  assert.equal(calls[1].max_tokens, 8192 * 4, "the output allowance is quadrupled");
  assert.deepEqual(calls[1].reasoning, { effort: "low" }, "the re-send asks for low reasoning effort");
  assert.deepEqual(
    calls[1].tool_choice,
    { type: "function", function: { name: SYNTH_TOOL } },
    "the re-send keeps the same forced tool_choice rung",
  );
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0].args, { nodes: [{ name: "api" }] });
  // Running out of tokens is not evidence about tool_choice: no downgrade notice.
  assert.equal(err.length, 0, `expected no forced-choice warnings, got ${JSON.stringify(err)}`);
});

test("openai: the boost is capped and derives from the caller's max_tokens", async () => {
  const { client, calls } = stubClient(
    reasoningLengthBody(),
    toolBody(SYNTH_TOOL, { nodes: [] }),
  );
  const m = new OpenAIChatModel({ apiKey: "x", model: "reasoner", client, sleep: instantSleep().sleep });

  await withCapturedError(() =>
    m.create({ ...SYNTH_REQ, maxTokens: 20_000 }),
  );

  assert.equal(calls[1].max_tokens, 32_768, "20_000 * 4 would overshoot the cap");
});

test("openai: a small allowance is still quadrupled, not floored at the cap", async () => {
  const { client, calls } = stubClient(reasoningLengthBody(), toolBody(SYNTH_TOOL, { nodes: [] }));
  const m = new OpenAIChatModel({ apiKey: "x", model: "reasoner", client, sleep: instantSleep().sleep });

  await withCapturedError(() => m.create({ ...SYNTH_REQ, maxTokens: 2048 }));

  assert.equal(calls[1].max_tokens, 8192);
});

test("openai: every attempt cut off at length spends one boost per rung and never downgrades tool_choice", async () => {
  const { client, calls } = stubClient(
    reasoningLengthBody(),
    reasoningLengthBody(),
    reasoningLengthBody(),
    reasoningLengthBody(),
    reasoningLengthBody(),
    reasoningLengthBody(),
  );
  const m = new OpenAIChatModel({ apiKey: "x", model: "always-reasoning", client, sleep: instantSleep().sleep });

  const { result, err } = await withCapturedError(() => m.create(SYNTH_REQ));

  assert.equal(calls.length, 6, "forced + boost, required + boost, auto + boost");
  assert.deepEqual(
    calls.map((c) => c.tool_choice),
    [
      { type: "function", function: { name: SYNTH_TOOL } },
      { type: "function", function: { name: SYNTH_TOOL } },
      "required",
      "required",
      "auto",
      "auto",
    ],
  );
  for (const boosted of [1, 3, 5]) {
    assert.equal(calls[boosted].max_tokens, 32_768);
    assert.deepEqual(calls[boosted].reasoning, { effort: "low" });
  }
  assert.equal(result.stopReason, "length");
  assert.equal(
    err.some((l) => l.includes("did not honor a forced tool_choice")),
    false,
    "a length stop must not be read as tool_choice being ignored",
  );
});

test("openai: GRAFT_REASONING_EFFORT overrides the boost's effort, and \"off\" omits the field", async () => {
  {
    const { client, calls } = stubClient(reasoningLengthBody(), toolBody(SYNTH_TOOL, { nodes: [] }));
    const m = new OpenAIChatModel({ apiKey: "x", model: "m", client, sleep: instantSleep().sleep });
    await withEnv("GRAFT_REASONING_EFFORT", "high", () => withCapturedError(() => m.create(SYNTH_REQ)));
    assert.deepEqual(calls[1].reasoning, { effort: "high" });
  }
  {
    const { client, calls } = stubClient(reasoningLengthBody(), toolBody(SYNTH_TOOL, { nodes: [] }));
    const m = new OpenAIChatModel({ apiKey: "x", model: "m", client, sleep: instantSleep().sleep });
    await withEnv("GRAFT_REASONING_EFFORT", "off", () => withCapturedError(() => m.create(SYNTH_REQ)));
    assert.equal("reasoning" in calls[1], false, "\"off\" means: do not send the reasoning knob");
  }
});

test("openai: an endpoint that rejects the reasoning knob gets the boosted allowance without it", async () => {
  const rejection = new OpenAI.APIError(
    400,
    { message: "Unrecognized request argument supplied: reasoning" },
    "Unrecognized request argument supplied: reasoning",
    new Headers(),
  );
  const { client, calls } = stubClient(reasoningLengthBody(), rejection, toolBody(SYNTH_TOOL, { nodes: [1] }));
  const m = new OpenAIChatModel({ apiKey: "x", model: "strict-endpoint", client, sleep: instantSleep().sleep });

  const { result } = await withCapturedError(() => m.create(SYNTH_REQ));

  assert.equal(calls.length, 3);
  assert.equal("reasoning" in calls[2], false);
  assert.equal(calls[2].max_tokens, 32_768, "the larger allowance survives the param rejection");
  assert.equal(result.toolCalls.length, 1);
});

test("openai: the boost also rescues a JSON-format call cut off at length", async () => {
  const { client, calls } = stubClient(reasoningLengthBody(), textBody('{"ok":true}'));
  const m = new OpenAIChatModel({ apiKey: "x", model: "json-reasoner", client, sleep: instantSleep().sleep });

  const { result } = await withCapturedError(() =>
    m.create({ messages: [{ role: "user", content: "go" }], responseFormat: { kind: "json" }, maxTokens: 1024 }),
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].max_tokens, 4096);
  assert.deepEqual(JSON.parse(result.text), { ok: true });
});

test("synthesize: a length stop with nothing usable warns about output tokens, not tool_choice", async () => {
  const stub = {
    label: "stub:lengthy",
    create: async () => ({
      text: "",
      toolCalls: [],
      usage: { input: 10, output: 8192, cacheRead: 0, cacheCreate: 0 },
      stopReason: "length",
      assistant: { role: "assistant" as const, content: "" },
    }),
  };
  const err: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void err.push(args.map(String).join(" "));
  try {
    await new ChatSynthesizer(stub).synthesize([{ path: "a.ts", summary: "does things" }]);
  } finally {
    console.error = orig;
  }

  assert.equal(err.length, 1);
  assert.match(err[0], /ran out of output tokens while reasoning/);
  assert.match(err[0], /GRAFT_REASONING_EFFORT/);
  assert.equal(err[0].includes("may ignore forced tool_choice"), false);
});

test("synthesize: an empty reply that stopped normally still names the tool_choice suspect", async () => {
  const stub = {
    label: "stub:empty",
    create: async () => ({
      text: "",
      toolCalls: [],
      usage: { input: 10, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "stop",
      assistant: { role: "assistant" as const, content: "" },
    }),
  };
  const err: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void err.push(args.map(String).join(" "));
  try {
    await new ChatSynthesizer(stub).synthesize([{ path: "a.ts", summary: "does things" }]);
  } finally {
    console.error = orig;
  }

  assert.equal(err.length, 1);
  assert.match(err[0], /no tool call and no content/);
});
