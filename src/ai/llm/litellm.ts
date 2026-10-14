/**
 * LiteLLM transport. A LiteLLM proxy speaks the OpenAI-compatible wire format,
 * so this reuses the OpenAI adapter's request/response translation and simply
 * points it at the proxy. The value over a bare `openai` provider + `baseUrl`
 * is a first-class, self-describing provider: a sensible default proxy address
 * and `/v1/models` auto-discovery (see {@link listLiteLLMModels}), so callers
 * can enumerate whatever models the proxy is configured to serve — reaching
 * 100+ providers (OpenAI, Anthropic, Gemini, Bedrock, Vertex, …) through one
 * endpoint without a per-vendor code path.
 */
import OpenAI from "openai";
import { OpenAIChatModel, type OpenAIChatModelOptions } from "./openai.js";
import { withRetry } from "./retry.js";

/** Conventional local address of a self-hosted LiteLLM proxy. */
export const DEFAULT_LITELLM_BASE_URL = "http://localhost:4000";

export type LiteLLMChatModelOptions = OpenAIChatModelOptions;

/**
 * ChatModel backed by a LiteLLM proxy. Inherits every translation detail from
 * {@link OpenAIChatModel} (the proxy is OpenAI-compatible) and only changes the
 * defaults: the proxy base URL and a `litellm:<model>` label.
 */
export class LiteLLMChatModel extends OpenAIChatModel {
  constructor(opts: LiteLLMChatModelOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl ?? DEFAULT_LITELLM_BASE_URL,
      label: opts.label ?? `litellm:${opts.model}`,
    });
  }
}

/**
 * Auto-discover the models a LiteLLM proxy is serving via `GET /v1/models`.
 * Returns the model ids so a caller can present/validate them instead of
 * hardcoding a model string. A stub `client` may be injected for tests.
 */
export async function listLiteLLMModels(opts: {
  apiKey: string;
  baseUrl?: string;
  client?: OpenAI;
}): Promise<string[]> {
  const client =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_LITELLM_BASE_URL,
      maxRetries: 0,
    });
  const res = await withRetry(() => client.models.list());
  return res.data.map((m) => m.id);
}
