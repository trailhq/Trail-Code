/**
 * Config resolution for the LLM request-body passthrough: where the value may
 * come from (programmatic object, JSON string, env var), what it does with input
 * it cannot use, and that the resolved value actually reaches each
 * OpenAI-compatible adapter the factory can build.
 *
 * The passthrough only exists for stacks that fail without it, so a value that
 * quietly goes missing between the env var and the wire is the failure worth
 * testing for — not the happy path alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, parseExtraBody } from "../src/ai/providers.js";
import { createChatModel } from "../src/ai/llm/factory.js";
import type { ExtraBody } from "../src/ai/llm/types.js";

const ENV_KEY = "GRAFT_LLM_EXTRA_BODY";

/** Run with GRAFT_LLM_EXTRA_BODY set to `value` (or unset), then restore it. */
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, ENV_KEY);
  const previous = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[ENV_KEY] = previous;
    else delete process.env[ENV_KEY];
  }
}

/** The adapter keeps its sanitized body privately; read it to prove it arrived. */
function bodyOf(model: unknown): ExtraBody | undefined {
  return (model as { extraBody?: ExtraBody }).extraBody;
}

test("extra body: unset everywhere resolves to undefined", () => {
  withEnv(undefined, () => {
    assert.equal(resolveConfig().extraBody, undefined);
  });
});

test("extra body: read from the env var as JSON", () => {
  withEnv('{"extra_body":{"reasoning_effort":"none"}}', () => {
    assert.deepEqual(resolveConfig().extraBody, { extra_body: { reasoning_effort: "none" } });
  });
});

test("extra body: an explicit config value beats the env var, as object or string", () => {
  withEnv('{"from":"env"}', () => {
    assert.deepEqual(resolveConfig({ extraBody: { from: "object" } }).extraBody, { from: "object" });
    assert.deepEqual(resolveConfig({ extraBody: '{"from":"string"}' }).extraBody, { from: "string" });
  });
});

test("extra body: blank text is treated as unset, not as an error", () => {
  withEnv("   ", () => {
    assert.equal(resolveConfig().extraBody, undefined);
  });
});

test("extra body: unusable input fails loudly, naming its source", () => {
  // Silence here would send the exact request the passthrough was added to
  // avoid, and the user would debug their gateway rather than their JSON.
  withEnv("{not json", () => {
    assert.throws(() => resolveConfig(), /GRAFT_LLM_EXTRA_BODY must be valid JSON/);
  });
  withEnv('["reasoning_effort"]', () => {
    assert.throws(() => resolveConfig(), /GRAFT_LLM_EXTRA_BODY must be a JSON object/);
  });
  withEnv('"none"', () => {
    assert.throws(() => resolveConfig(), /GRAFT_LLM_EXTRA_BODY must be a JSON object/);
  });
  assert.throws(() => parseExtraBody("null", "extraBody"), /extraBody must be a JSON object/);
});

test("extra body: reaches every OpenAI-compatible provider the factory builds", () => {
  const extraBody = { chat_template_kwargs: { enable_thinking: false } };
  for (const provider of ["openai", "litellm", "orcarouter"] as const) {
    const model = createChatModel({ provider, apiKey: "x", model: "m", extraBody });
    assert.deepEqual(bodyOf(model), extraBody, `${provider} received the body`);
  }
  // anthropic has no OpenAI-compatible body to merge into; it must simply ignore
  // the field rather than fail to build.
  assert.ok(createChatModel({ provider: "anthropic", apiKey: "x", model: "m", extraBody }));
});
