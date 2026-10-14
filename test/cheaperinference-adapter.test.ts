/**
 * Network-free tests for the Cheaper Inference provider. The Cheaper Inference
 * gateway is OpenAI-compatible, so the adapter reuses the OpenAI translation
 * (verified in llm-adapters.test.ts); here we assert the cheaperinference-specific
 * behavior: reuse of that translation, the `cheaperinference:` label, factory
 * wiring, the default base URL, and `/v1/models` auto-discovery of chat models.
 * Stub clients mean no key and no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  CheaperInferenceChatModel,
  listCheaperInferenceModels,
  DEFAULT_CHEAPERINFERENCE_BASE_URL,
} from "../src/ai/llm/cheaperinference.js";
import { createChatModel } from "../src/ai/llm/factory.js";

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

test("cheaperinference: reuses OpenAI-compatible translation and labels as cheaperinference", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new CheaperInferenceChatModel({ apiKey: "x", model: "gpt-5.4-mini", client });
  const res = await m.create({ messages: [{ role: "user", content: "hi" }], temperature: 0 });
  assert.equal(box.params.model, "gpt-5.4-mini");
  assert.equal(box.params.temperature, 0); // OpenAI-compatible: temperature forwarded
  assert.equal(res.text, "ok");
  assert.equal(m.label, "cheaperinference:gpt-5.4-mini");
});

test("cheaperinference: /v1/models auto-discovery returns the gateway's chat model ids", async () => {
  const client = {
    models: {
      list: async () => ({
        data: [
          { id: "gpt-5.4-mini", type: "text" },
          { id: "claude-sonnet-5", type: "text" },
          { id: "some-image-model", type: "image" },
        ],
      }),
    },
  } as unknown as OpenAI;
  const ids = await listCheaperInferenceModels({ apiKey: "x", client });
  assert.deepEqual(ids, ["gpt-5.4-mini", "claude-sonnet-5"]);
});

test("cheaperinference: factory builds a CheaperInferenceChatModel for provider 'cheaperinference'", () => {
  const m = createChatModel({ provider: "cheaperinference", apiKey: "x", model: "gpt-5.4-mini" });
  assert.ok(m instanceof CheaperInferenceChatModel);
  assert.equal(m.label, "cheaperinference:gpt-5.4-mini");
});

test("cheaperinference: exposes a default gateway base URL", () => {
  assert.equal(DEFAULT_CHEAPERINFERENCE_BASE_URL, "https://api.cheaperinference.com/v1");
});
