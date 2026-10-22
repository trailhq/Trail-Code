import type { Summarizer } from "./summarize.js";
import type { Synthesizer } from "./synthesize.js";
import type { CruxSummarizer } from "./crux.js";
import type { ChatModel } from "./llm/types.js";
import type { ProviderKind } from "./llm/factory.js";

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
  /** Model id for the synthesis pass alone (`graft build --synth-model`), so a fast
   *  non-reasoning model can write the concept nodes while per-file summaries use
   *  another. Env: GRAFT_SYNTH_MODEL. Default: {@link model}. */
  synthModel?: string;
  /** Base URL for OpenAI-compatible endpoints. Env: GRAFT_BASE_URL. */
  baseUrl?: string;

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
  /** The synthesis model: `synthModel` when configured, else {@link model}. */
  synthModel: string;
  baseUrl?: string;
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

  // Synthesis rides the build model unless a synthesis model of its own is set.
  const synthModel = config.synthModel ?? env.GRAFT_SYNTH_MODEL ?? model;

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

  return {
    contextDir: config.contextDir ?? env.GRAFT_DIR,
    provider,
    apiKey,
    model,
    synthModel,
    baseUrl,
    headers,
    usedLegacyEnv,
    chatModel: config.chatModel,
    synthesizer: config.synthesizer,
    summarizer: config.summarizer,
    cruxSummarizer: config.cruxSummarizer,
  };
}
