/**
 * Graft — public API.
 *
 * The graph is a folder of linked markdown files (`.context/`) committed to the
 * repo. Build it from code, then check it stays in sync.
 *
 * @example
 * ```ts
 * import { Graft } from "@nanonets/graft";
 *
 * const engine = new Graft();
 * await engine.init(".");             // writes .context/*.md + manifest.json
 *
 * const result = engine.check(".");   // { ok: boolean, ...drift }
 * if (!result.ok) process.exitCode = 1;
 * ```
 */
export { Graft, CODE_EXTENSIONS } from "./engine.js";
export type { InitOptions, CheckRunOptions, BuildResult, BuildProgress, CheckResult } from "./engine.js";

export { buildContext } from "./context/build.js";
export type { BuildOptions } from "./context/build.js";
export { checkContext, formatCheckReport } from "./context/check.js";
export type { CheckOptions } from "./context/check.js";
export { checkGraph, formatGraphCheckReport } from "./graph/check.js";
export type { GraphCheckResult, GraphCheckOptions } from "./graph/check.js";
export type { ContextNode, NodeLink, SourceRef, Manifest } from "./context/node-file.js";

export type { EngineConfig, ResolvedConfig } from "./ai/providers.js";
export { resolveConfig, DEFAULTS, DEFAULT_MODELS } from "./ai/providers.js";

// Provider transport, for advanced/custom setups.
export type { ChatModel, ChatRequest, ChatResponse, Message, ToolSpec, ToolCall, Usage } from "./ai/llm/types.js";
export { createChatModel, type ProviderKind, type ChatModelConfig } from "./ai/llm/factory.js";
export { OpenAIChatModel } from "./ai/llm/openai.js";
export { AnthropicChatModel } from "./ai/llm/anthropic.js";
export { LiteLLMChatModel, listLiteLLMModels, DEFAULT_LITELLM_BASE_URL } from "./ai/llm/litellm.js";
export { OrcaRouterChatModel, listOrcaRouterModels, DEFAULT_ORCAROUTER_BASE_URL } from "./ai/llm/orcarouter.js";
export {
  OpenCodeChatModel,
  OpenCodeGoChatModel,
  listOpenCodeModels,
  openCodeHeaders,
  openCodeSessionId,
  DEFAULT_OPENCODE_BASE_URL,
  DEFAULT_OPENCODE_GO_BASE_URL,
} from "./ai/llm/opencode.js";

// Engine ops, for advanced/custom setups.
export { ChatSynthesizer } from "./ai/synthesize.js";
export type { Synthesizer, SynthNode, SynthLink, FileSummary } from "./ai/synthesize.js";
export { ChatSummarizer } from "./ai/summarize.js";
export type { Summarizer } from "./ai/summarize.js";
export { ChatCruxSummarizer } from "./ai/crux.js";
export type { CruxSummarizer, FileCruxInput, NodeCrux, NodeRef } from "./ai/crux.js";
