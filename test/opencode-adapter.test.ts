/**
 * Network-free tests for the OpenCode providers. OpenCode Zen and Zen Go are
 * OpenAI-compatible, so the adapters reuse the OpenAI translation (verified in
 * llm-adapters.test.ts); here we assert the OpenCode-specific behavior: reuse of
 * that translation, the `opencode:` / `opencode-go:` labels, factory wiring, the
 * default base URLs, `/models` auto-discovery, the identification headers the
 * gateways require, and the opt-in `OPENCODE_*` env resolution. Stub clients mean
 * no key and no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  OpenCodeChatModel,
  OpenCodeGoChatModel,
  listOpenCodeModels,
  openCodeHeaders,
  openCodeSessionId,
  DEFAULT_OPENCODE_BASE_URL,
  DEFAULT_OPENCODE_GO_BASE_URL,
} from "../src/ai/llm/opencode.js";
import { createChatModel } from "../src/ai/llm/factory.js";
import { resolveConfig, parseHeaders, DEFAULT_MODELS } from "../src/ai/providers.js";

function fakeOpenAI(resp: unknown) {
  const box: { params?: any } = {};
  const client = {
    chat: { completions: { create: async (params: any) => ((box.params = params), resp) } },
  } as unknown as OpenAI;
  return { client, box };
}

function openAiResp(over: Partial<any> = {}): any {
  return {
    choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...over,
  };
}

/** Run `fn` with a scrubbed provider environment, restoring it afterwards. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const keys = [
    "GRAFT_PROVIDER", "GRAFT_API_KEY", "GRAFT_MODEL", "GRAFT_BASE_URL", "GRAFT_HEADERS",
    "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "GRAFT_OPENROUTER_MODEL",
    "ORCAROUTER_API_KEY", "ORCAROUTER_BASE_URL", "ORCAROUTER_MODEL",
    "OPENCODE_API_KEY", "OPENCODE_BASE_URL", "OPENCODE_GO_API_KEY", "OPENCODE_GO_BASE_URL",
    "OPENCODE_SESSION_ID",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("opencode: reuses OpenAI-compatible translation and labels as opencode", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new OpenCodeChatModel({ apiKey: "x", model: "deepseek-v4.1-flash", client });
  const res = await m.create({ messages: [{ role: "user", content: "hi" }], temperature: 0 });
  assert.equal(box.params.model, "deepseek-v4.1-flash");
  assert.equal(box.params.temperature, 0); // OpenAI-compatible: temperature forwarded
  assert.equal(res.text, "ok");
  assert.equal(m.label, "opencode:deepseek-v4.1-flash");
});

test("opencode-go: factory builds an OpenCodeGoChatModel and labels as opencode-go", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new OpenCodeGoChatModel({ apiKey: "x", model: "deepseek-v4.1-flash", client });
  await m.create({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(box.params.model, "deepseek-v4.1-flash");
  assert.equal(m.label, "opencode-go:deepseek-v4.1-flash");
});

test("opencode: factory builds an OpenCodeChatModel for provider 'opencode'", () => {
  const m = createChatModel({ provider: "opencode", apiKey: "x", model: "kimi-k3" });
  assert.ok(m instanceof OpenCodeChatModel);
  assert.equal(m.label, "opencode:kimi-k3");
});

test("opencode-go: factory builds an OpenCodeGoChatModel for provider 'opencode-go'", () => {
  const m = createChatModel({ provider: "opencode-go", apiKey: "x", model: "kimi-k3" });
  assert.ok(m instanceof OpenCodeGoChatModel);
  assert.equal(m.label, "opencode-go:kimi-k3");
});

test("opencode: exposes the two gateway base URLs and a model default", () => {
  assert.equal(DEFAULT_OPENCODE_BASE_URL, "https://opencode.ai/zen/v1");
  assert.equal(DEFAULT_OPENCODE_GO_BASE_URL, "https://opencode.ai/zen/go/v1");
  assert.equal(DEFAULT_MODELS.opencode, "deepseek-v4.1-flash");
  assert.equal(DEFAULT_MODELS["opencode-go"], "deepseek-v4.1-flash");
});

test("opencode: identification headers carry a session id and a graft User-Agent", () => {
  withEnv({ OPENCODE_SESSION_ID: "session-42" }, () => {
    const h = openCodeHeaders();
    assert.equal(h["x-opencode-session"], "session-42");
    assert.match(h["User-Agent"], /^graft\//);
    // A caller's own header wins over the defaults.
    assert.equal(openCodeHeaders({ "x-opencode-session": "pinned" })["x-opencode-session"], "pinned");
  });
});

test("opencode: the session id is stable, and OPENCODE_SESSION_ID overrides it", () => {
  assert.equal(openCodeSessionId(), openCodeSessionId());
  withEnv({ OPENCODE_SESSION_ID: "pinned" }, () => assert.equal(openCodeSessionId(), "pinned"));
});

test("opencode: /models auto-discovery returns the gateway's model ids", async () => {
  const client = {
    models: { list: async () => ({ data: [{ id: "deepseek-v4.1-flash" }, { id: "kimi-k3" }] }) },
  } as unknown as OpenAI;
  const ids = await listOpenCodeModels({ apiKey: "x", client });
  assert.deepEqual(ids, ["deepseek-v4.1-flash", "kimi-k3"]);
});

test("opencode: resolveConfig honors the per-provider key, base URL and defaults", () => {
  const zen = withEnv({ GRAFT_PROVIDER: "opencode", OPENCODE_API_KEY: "zen-key" }, () => resolveConfig());
  assert.equal(zen.provider, "opencode");
  assert.equal(zen.apiKey, "zen-key");
  assert.equal(zen.baseUrl, "https://opencode.ai/zen/v1");

  const go = withEnv({ GRAFT_PROVIDER: "opencode-go", OPENCODE_GO_API_KEY: "go-key" }, () => resolveConfig());
  assert.equal(go.apiKey, "go-key");
  assert.equal(go.baseUrl, "https://opencode.ai/zen/go/v1");

  const overridden = withEnv(
    { GRAFT_PROVIDER: "opencode-go", OPENCODE_GO_API_KEY: "go-key", OPENCODE_GO_BASE_URL: "http://proxy.local" },
    () => resolveConfig(),
  );
  assert.equal(overridden.baseUrl, "http://proxy.local");

  const zenProxy = withEnv(
    { GRAFT_PROVIDER: "opencode", OPENCODE_API_KEY: "zen-key", OPENCODE_BASE_URL: "http://zen-proxy.local" },
    () => resolveConfig(),
  );
  assert.equal(zenProxy.baseUrl, "http://zen-proxy.local");
});

test("opencode: a Zen key is never used for opencode-go, and vice versa", () => {
  const go = withEnv({ GRAFT_PROVIDER: "opencode-go", OPENCODE_API_KEY: "zen-key" }, () => resolveConfig());
  assert.equal(go.apiKey, undefined);
  const zen = withEnv({ GRAFT_PROVIDER: "opencode", OPENCODE_GO_API_KEY: "go-key" }, () => resolveConfig());
  assert.equal(zen.apiKey, undefined);
});

test("headers: parseHeaders reads a JSON object and drops non-string values", () => {
  assert.deepEqual(parseHeaders('{"x-org":"acme","n":1,"ok":"yes"}'), { "x-org": "acme", ok: "yes" });
  assert.deepEqual(parseHeaders("[1,2]"), {});
  assert.deepEqual(parseHeaders("not json"), {});
  assert.deepEqual(parseHeaders(undefined), {});
});

test("headers: GRAFT_HEADERS is merged, and explicit config wins over it", () => {
  const r = withEnv({ GRAFT_PROVIDER: "openai", GRAFT_HEADERS: '{"x-org":"acme","x-shared":"env"}' }, () =>
    resolveConfig({ headers: { "x-shared": "explicit" } }),
  );
  assert.equal(r.headers?.["x-org"], "acme");
  assert.equal(r.headers?.["x-shared"], "explicit");
});

test("headers: the OpenRouter X-Title default is preserved", () => {
  const r = withEnv(
    { GRAFT_PROVIDER: "openai", GRAFT_BASE_URL: "https://openrouter.ai/api/v1" },
    () => resolveConfig(),
  );
  assert.equal(r.headers?.["X-Title"], "graft");
});
