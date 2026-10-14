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
  /** Base URL for OpenAI-compatible endpoints. Env: GRAFT_BASE_URL. */
  baseUrl?: string;
  /**
   * Extra default HTTP headers for the endpoint. Env: GRAFT_HEADERS (a JSON
   * object of string→string). Lets any gateway that needs an auth, routing, or
   * identification header work without a provider-specific code path.
   */
  headers?: Record<string, string>;

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
const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/** Parse the `GRAFT_HEADERS` JSON object into a header map, ignoring anything
 *  that is not a string-valued entry. Malformed JSON yields no headers (and a
 *  one-line warning) rather than failing every command that resolves config. */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("⚠ GRAFT_HEADERS is not valid JSON — ignoring it. Expected an object, e.g. '{\"x-org\": \"acme\"}'.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Per-provider default model. */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  openai: "openai/gpt-4o-mini",
  anthropic: "claude-sonnet-5",
  // Provider-prefixed so the LiteLLM proxy routes it; override with GRAFT_MODEL.
  litellm: "openai/gpt-4o-mini",
  // Provider-prefixed so the OrcaRouter gateway routes it; override with GRAFT_MODEL.
  orcarouter: "openai/gpt-4o-mini",
  // Cheap, capable coding models on OpenCode Zen / Zen Go; override with GRAFT_MODEL.
  opencode: "deepseek-v4.1-flash",
  "opencode-go": "deepseek-v4.1-flash",
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
  // OPENCODE_API_KEY / OPENCODE_GO_API_KEY are honored only for their own
  // provider, so a key that other tools already keep in the environment is
  // never sent to a different endpoint.
  const openCodeKey = provider === "opencode" ? env.OPENCODE_API_KEY : undefined;
  const openCodeGoKey = provider === "opencode-go" ? env.OPENCODE_GO_API_KEY : undefined;
  const apiKey = explicitKey ?? openCodeKey ?? openCodeGoKey ?? legacyKey ?? env.ORCAROUTER_API_KEY;
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
  // Likewise for the two OpenCode gateways (OPENCODE_BASE_URL / OPENCODE_GO_BASE_URL
  // let a deployment pin a proxy or an alternate host).
  if (!baseUrl && provider === "opencode") baseUrl = env.OPENCODE_BASE_URL ?? OPENCODE_BASE_URL;
  if (!baseUrl && provider === "opencode-go") baseUrl = env.OPENCODE_GO_BASE_URL ?? OPENCODE_GO_BASE_URL;

  // Built-in defaults first, then GRAFT_HEADERS, then explicit config/CLI — so a
  // caller can always override what the provider adds.
  const mergedHeaders: Record<string, string> = {
    ...(provider === "openai" && baseUrl?.includes("openrouter.ai") ? { "X-Title": "graft" } : {}),
    ...parseHeaders(env.GRAFT_HEADERS),
    ...(config.headers ?? {}),
  };
  const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;

  return {
    contextDir: config.contextDir ?? env.GRAFT_DIR,
    provider,
    apiKey,
    model,
    baseUrl,
    headers,
    usedLegacyEnv,
    chatModel: config.chatModel,
    synthesizer: config.synthesizer,
    summarizer: config.summarizer,
    cruxSummarizer: config.cruxSummarizer,
  };
}
