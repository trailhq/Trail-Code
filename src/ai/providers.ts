import type { Summarizer } from "./summarize.js";
import type { Synthesizer } from "./synthesize.js";
import type { CruxSummarizer } from "./crux.js";
import type { ChatModel } from "./llm/types.js";
import type { ProviderKind } from "./llm/factory.js";
import type { ExtraBody, ReasoningEffort } from "./llm/types.js";

/**
 * User-facing configuration. Anything omitted falls back to environment
 * variables and then to sensible defaults.
 *
 * graft is vendor-neutral: `provider` names only the WIRE FORMAT, not a company.
 * `openai` speaks the OpenAI-compatible API — point `baseUrl` at OpenRouter,
 * Fireworks, a LiteLLM proxy, Groq, a local server, or OpenAI itself, and pass
 * your own key. `anthropic` speaks the native Messages API. Any LLM-backed
 * operation needs an API key.
 */
export interface EngineConfig {
  /** Where the graph lives. Env: GRAFT_DIR. Default: `<repo>/.context`. */
  contextDir?: string;

  /** Wire format / SDK. Env: GRAFT_PROVIDER. Default: `openai`. */
  provider?: ProviderKind;
  /** API key for the chosen provider. Env: GRAFT_API_KEY (legacy: OPENROUTER_API_KEY). */
  apiKey?: string;
  /** Model id. Env: GRAFT_MODEL. Provider-specific default. */
  model?: string;
  /** Base URL for OpenAI-compatible endpoints. Env: GRAFT_BASE_URL. */
  baseUrl?: string;
  /**
   * Hidden-reasoning budget for reasoning-capable models, on OpenAI-compatible
   * providers. Env: GRAFT_REASONING_EFFORT. Unset leaves the model's own default.
   * Set "none" against a server that spends the whole token budget on reasoning
   * and returns empty content.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Provider-specific parameters merged into the request body on
   * OpenAI-compatible providers. Env: GRAFT_LLM_EXTRA_BODY, as a JSON object.
   * Accepts a JSON string too, so the env var and `--extra-body` parse in one
   * place. See {@link ExtraBody} for why the typed fields are not always enough.
   */
  extraBody?: ExtraBody | string;

  // --- advanced: bring your own components ---
  /** Override the whole transport (skips provider/apiKey/baseUrl). */
  chatModel?: ChatModel;
  /** Override the synthesizer. */
  synthesizer?: Synthesizer;
  /** Override the code summarizer. */
  summarizer?: Summarizer;
  /** Override the per-symbol crux summarizer. */
  cruxSummarizer?: CruxSummarizer;
}

/** Fully-resolved configuration with all defaults applied. */
export interface ResolvedConfig {
  contextDir?: string;
  provider: ProviderKind;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  extraBody?: ExtraBody;
  headers?: Record<string, string>;
  /** True when the key came from the deprecated OPENROUTER_* fallback. */
  usedLegacyEnv: boolean;
  chatModel?: ChatModel;
  synthesizer?: Synthesizer;
  summarizer?: Summarizer;
  cruxSummarizer?: CruxSummarizer;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

/** Per-provider default model. */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  openai: "openai/gpt-4o-mini",
  anthropic: "claude-sonnet-5",
  // Provider-prefixed so the LiteLLM proxy routes it; override with GRAFT_MODEL.
  litellm: "openai/gpt-4o-mini",
  // Provider-prefixed so the OrcaRouter gateway routes it; override with GRAFT_MODEL.
  orcarouter: "openai/gpt-4o-mini",
};

export const DEFAULTS = {
  provider: "openai" as ProviderKind,
  model: DEFAULT_MODELS.openai,
} as const;

/**
 * Parse an extra-body value that may arrive as an object (a programmatic caller)
 * or as JSON text (the env var and the CLI flag).
 *
 * Throws rather than ignoring bad input: a passthrough exists precisely because
 * the request fails without it, so silently dropping a malformed one would send
 * the very request the user was trying to avoid — and they would see whatever
 * their gateway does with it, not what they got wrong here.
 */
export function parseExtraBody(value: ExtraBody | string | undefined, source: string): ExtraBody | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} must be valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object, e.g. '{"extra_body":{"reasoning_effort":"none"}}'`);
  }
  return parsed as ExtraBody;
}

/** Merge user config with environment variables and defaults. */
export function resolveConfig(config: EngineConfig = {}): ResolvedConfig {
  const env = process.env;
  const provider = config.provider ?? (env.GRAFT_PROVIDER as ProviderKind | undefined) ?? DEFAULTS.provider;

  const explicitKey = config.apiKey ?? env.GRAFT_API_KEY;
  const legacyKey = env.OPENROUTER_API_KEY;
  const apiKey = explicitKey ?? legacyKey ?? env.ORCAROUTER_API_KEY;
  const usedLegacyEnv = !explicitKey && !!legacyKey;

  const model =
    config.model ??
    env.GRAFT_MODEL ??
    env.GRAFT_OPENROUTER_MODEL ??
    env.ORCAROUTER_MODEL ??
    DEFAULT_MODELS[provider];

  let baseUrl = config.baseUrl ?? env.GRAFT_BASE_URL ?? env.OPENROUTER_BASE_URL ?? env.ORCAROUTER_BASE_URL;
  // Back-compat: an existing setup with only OPENROUTER_API_KEY keeps hitting
  // OpenRouter without any config change.
  if (!baseUrl && provider === "openai" && usedLegacyEnv) baseUrl = OPENROUTER_BASE_URL;
  // The orcarouter provider points at the gateway unless a base URL is given.
  if (!baseUrl && provider === "orcarouter") baseUrl = ORCAROUTER_BASE_URL;

  const headers =
    provider === "openai" && baseUrl?.includes("openrouter.ai")
      ? { "X-Title": "graft" }
      : undefined;

  const reasoningEffort =
    config.reasoningEffort ?? (env.GRAFT_REASONING_EFFORT as ReasoningEffort | undefined);

  const extraBody =
    config.extraBody !== undefined
      ? parseExtraBody(config.extraBody, "extraBody")
      : parseExtraBody(env.GRAFT_LLM_EXTRA_BODY, "GRAFT_LLM_EXTRA_BODY");

  return {
    contextDir: config.contextDir ?? env.GRAFT_DIR,
    provider,
    apiKey,
    model,
    baseUrl,
    reasoningEffort,
    extraBody,
    headers,
    usedLegacyEnv,
    chatModel: config.chatModel,
    synthesizer: config.synthesizer,
    summarizer: config.summarizer,
    cruxSummarizer: config.cruxSummarizer,
  };
}
