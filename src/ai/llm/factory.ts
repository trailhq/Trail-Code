/**
 * One place that turns resolved config into a {@link ChatModel}. `provider` names
 * the WIRE FORMAT, not a vendor: `openai` speaks the OpenAI-compatible API (point
 * `baseUrl` at OpenRouter, Fireworks, a LiteLLM proxy, Groq, a local server, …),
 * `anthropic` speaks the native Messages API. Adding a vendor is a base URL, not
 * a code change; adding a wire format is one new adapter here.
 *
 * `litellm` is a convenience over `openai`: same wire format, but pointed at a
 * LiteLLM proxy by default and paired with `/v1/models` auto-discovery
 * (see litellm.ts), so one endpoint reaches 100+ providers.
 *
 * `orcarouter` is the same kind of convenience over `openai`, pointed at the
 * OrcaRouter AI gateway by default (see orcarouter.ts) so its users get the
 * gateway's routing, failover, and guardrails behind a named provider instead
 * of a bare custom base URL.
 */
import type { ChatModel, ExtraBody, ReasoningEffort } from "./types.js";
import { OpenAIChatModel } from "./openai.js";
import { AnthropicChatModel } from "./anthropic.js";
import { LiteLLMChatModel } from "./litellm.js";
import { OrcaRouterChatModel } from "./orcarouter.js";

export type ProviderKind = "openai" | "anthropic" | "litellm" | "orcarouter";

export interface ChatModelConfig {
  provider: ProviderKind;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Extra default headers for OpenAI-compatible endpoints (e.g. OpenRouter `X-Title`). */
  headers?: Record<string, string>;
  /** Hidden-reasoning budget for OpenAI-compatible endpoints. Ignored by anthropic. */
  reasoningEffort?: ReasoningEffort;
  /** Provider-specific request-body parameters for OpenAI-compatible endpoints. Ignored by anthropic. */
  extraBody?: ExtraBody;
}

export function createChatModel(cfg: ChatModelConfig): ChatModel {
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicChatModel({ apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl });
    case "openai":
      return new OpenAIChatModel({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
        reasoningEffort: cfg.reasoningEffort,
        extraBody: cfg.extraBody,
      });
    case "litellm":
      return new LiteLLMChatModel({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
        reasoningEffort: cfg.reasoningEffort,
        extraBody: cfg.extraBody,
      });
    case "orcarouter":
      return new OrcaRouterChatModel({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
        reasoningEffort: cfg.reasoningEffort,
        extraBody: cfg.extraBody,
      });
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`unknown provider: ${String(_exhaustive)}`);
    }
  }
}
