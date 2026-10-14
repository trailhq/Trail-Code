/**
 * Cheaper Inference transport. The Cheaper Inference gateway speaks the
 * OpenAI-compatible wire format, so this reuses the OpenAI adapter's
 * request/response translation and simply points it at the gateway. The value
 * over a bare `openai` provider + `baseUrl` is a first-class, self-describing
 * provider: a sensible default gateway address and `/v1/models` auto-discovery
 * (see {@link listCheaperInferenceModels}), so callers can enumerate the chat
 * models the gateway serves from several labs through one endpoint and one key,
 * without a per-vendor code path.
 */
import OpenAI from "openai";
import { OpenAIChatModel, type OpenAIChatModelOptions } from "./openai.js";
import { transportRetries } from "./types.js";

/** Public endpoint of the Cheaper Inference gateway. */
export const DEFAULT_CHEAPERINFERENCE_BASE_URL = "https://api.cheaperinference.com/v1";

export type CheaperInferenceChatModelOptions = OpenAIChatModelOptions;

/**
 * ChatModel backed by the Cheaper Inference gateway. Inherits every translation
 * detail from {@link OpenAIChatModel} (the gateway is OpenAI-compatible) and only
 * changes the defaults: the gateway base URL and a `cheaperinference:<model>` label.
 */
export class CheaperInferenceChatModel extends OpenAIChatModel {
  constructor(opts: CheaperInferenceChatModelOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl ?? DEFAULT_CHEAPERINFERENCE_BASE_URL,
      label: opts.label ?? `cheaperinference:${opts.model}`,
    });
  }
}

/**
 * Auto-discover the chat models the Cheaper Inference gateway serves via `GET
 * /v1/models`. The gateway also lists image and video models (`type` other than
 * `"text"`); those are skipped. Returns the model ids so a caller can
 * present/validate them instead of hardcoding a model string. A stub `client`
 * may be injected for tests.
 */
export async function listCheaperInferenceModels(opts: {
  apiKey: string;
  baseUrl?: string;
  client?: OpenAI;
}): Promise<string[]> {
  const client =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_CHEAPERINFERENCE_BASE_URL,
      maxRetries: transportRetries(),
    });
  const res = await client.models.list();
  return res.data
    .filter((m) => {
      const type = (m as { type?: unknown }).type;
      return type === undefined || type === "text";
    })
    .map((m) => m.id);
}
