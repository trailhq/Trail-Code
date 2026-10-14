/**
 * OrcaRouter transport. The OrcaRouter gateway speaks the OpenAI-compatible
 * wire format, so this reuses the OpenAI adapter's request/response translation
 * and simply points it at the gateway. The value over a bare `openai` provider +
 * `baseUrl` is a first-class, self-describing provider: a sensible default
 * gateway address and `/v1/models` auto-discovery (see {@link listOrcaRouterModels}),
 * so callers can enumerate whatever upstream models the gateway routes to —
 * reaching 150+ models from OpenAI, Anthropic, Google, DeepSeek, Qwen, and more
 * through one endpoint without a per-vendor code path.
 */
import OpenAI from "openai";
import { OpenAIChatModel, type OpenAIChatModelOptions } from "./openai.js";
import { withRetry } from "./retry.js";

/** Public endpoint of the OrcaRouter AI gateway. */
export const DEFAULT_ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

export type OrcaRouterChatModelOptions = OpenAIChatModelOptions;

/**
 * ChatModel backed by the OrcaRouter gateway. Inherits every translation detail
 * from {@link OpenAIChatModel} (the gateway is OpenAI-compatible) and only
 * changes the defaults: the gateway base URL and an `orcarouter:<model>` label.
 */
export class OrcaRouterChatModel extends OpenAIChatModel {
  constructor(opts: OrcaRouterChatModelOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl ?? DEFAULT_ORCAROUTER_BASE_URL,
      label: opts.label ?? `orcarouter:${opts.model}`,
    });
  }
}

/**
 * Auto-discover the models the OrcaRouter gateway can route to via `GET
 * /v1/models`. Returns the model ids so a caller can present/validate them
 * instead of hardcoding a model string. A stub `client` may be injected for tests.
 */
export async function listOrcaRouterModels(opts: {
  apiKey: string;
  baseUrl?: string;
  client?: OpenAI;
}): Promise<string[]> {
  const client =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_ORCAROUTER_BASE_URL,
      maxRetries: 0,
    });
  const res = await withRetry(() => client.models.list());
  return res.data.map((m) => m.id);
}
