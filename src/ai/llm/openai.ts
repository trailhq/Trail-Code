/**
 * OpenAI-compatible transport. Wraps the `openai` SDK pointed at any
 * OpenAI-compatible endpoint (OpenAI, OpenRouter, Fireworks, a LiteLLM proxy,
 * Groq, Together, DeepSeek, a local server, …) — the user picks the endpoint
 * with `baseUrl` and authenticates with their own key.
 *
 * This adapter reproduces graft's historical wire behavior exactly: temperature
 * is forwarded, cache breakpoints become `cache_control` content parts (which
 * OpenRouter forwards to Anthropic), and cached tokens are subtracted out of the
 * input count so {@link Usage.input} is uncached-only.
 */
import OpenAI from "openai";
import { withRetry } from "./retry.js";
import type { ChatModel, ChatRequest, ChatResponse, Message, ToolCall, ToolSpec, Usage } from "./types.js";

const PROVIDER = "openai";
/** Synthetic tool used to coerce a plain JSON object out of `{ kind: "json" }`. */
const JSON_TOOL = "emit_json";

export interface OpenAIChatModelOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Stable manifest label; defaults to `openai:<model>`. */
  label?: string;
  /** Extra default headers (e.g. OpenRouter's `X-Title`). */
  headers?: Record<string, string>;
  /** Inject a pre-built client (tests pass a stub; production omits it). */
  client?: OpenAI;
}

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** A text content part, optionally carrying a cache breakpoint (OpenRouter passthrough). */
function textPart(text: string, cache: boolean | undefined) {
  return cache
    ? [{ type: "text" as const, text, cache_control: { type: "ephemeral" as const } }]
    : text;
}

function toChatMessage(m: Message): ChatMessage {
  switch (m.role) {
    case "system":
      return { role: "system", content: textPart(m.content, m.cacheBreakpoint) } as ChatMessage;
    case "user":
      return { role: "user", content: textPart(m.content, m.cacheBreakpoint) } as ChatMessage;
    case "tool":
      return {
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: textPart(m.content, m.cacheBreakpoint),
      } as ChatMessage;
    case "assistant": {
      if (m.providerRaw?.provider === PROVIDER) return m.providerRaw.raw as ChatMessage;
      const tool_calls = m.toolCalls?.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      }));
      return {
        role: "assistant",
        content: m.content || null,
        ...(tool_calls?.length ? { tool_calls } : {}),
      } as ChatMessage;
    }
  }
}

function toChatTool(t: ToolSpec): OpenAI.Chat.Completions.ChatCompletionTool {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

/**
 * Some OpenAI-compatible servers — LM Studio's local server, at least as of
 * 2026 — reject the object form of `tool_choice` outright with a 400
 * ("Invalid tool_choice type: 'object'. Supported string values: none, auto,
 * required"), even though the upstream OpenAI spec allows it.
 */
function isRejectedObjectToolChoice(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /tool_choice/i.test(String((err as { message?: string }).message ?? ""))
  );
}

/**
 * Newer reasoning-family models (o1/o3/o4, the gpt-5.x line, …) reject the
 * classic `max_tokens` param outright and require `max_completion_tokens`
 * instead, even though both are still in wide use across OpenAI-compatible
 * servers. Detect the specific 400 rather than guessing from the model name,
 * so older endpoints that still expect `max_tokens` are untouched.
 */
function isRejectedMaxTokens(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /max_tokens.*not supported.*max_completion_tokens/i.test(String((err as { message?: string }).message ?? ""))
  );
}

/** Same reasoning-family models: temperature is fixed at 1, not caller-settable. */
function isRejectedTemperature(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /temperature.*does not support/i.test(String((err as { message?: string }).message ?? ""))
  );
}

/**
 * Same models again: function tools are rejected on /v1/chat/completions while
 * the model's default reasoning effort is active. The API's own error message
 * names the fix — `reasoning_effort: "none"` — so apply exactly that.
 *
 * DeepSeek's v4 line refuses the same combination ("Thinking mode does not
 * support this tool_choice") for every tool_choice except "auto", and accepts
 * the identical `reasoning_effort: "none"` remedy. Matching both phrasings here
 * keeps a forced tool_choice working rather than degrading it to "auto", which
 * would leave the model free not to call the tool the caller asked for.
 */
function isRejectedToolsWithReasoning(err: unknown): boolean {
  const message = String((err as { message?: string }).message ?? "");
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    (/function tools with reasoning_effort/i.test(message) ||
      /thinking mode does not support this tool_choice/i.test(message))
  );
}

export class OpenAIChatModel implements ChatModel {
  readonly label: string;
  private client: OpenAI;
  private model: string;

  constructor(opts: OpenAIChatModelOptions) {
    this.model = opts.model;
    this.label = opts.label ?? `${PROVIDER}:${opts.model}`;
    this.client =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseUrl,
        defaultHeaders: opts.headers,
        // graft owns retry/backoff (see retry.ts); the SDK must not double-retry.
        maxRetries: 0,
      });
  }

  async create(req: ChatRequest): Promise<ChatResponse> {
    const messages = req.messages.map(toChatMessage);
    const tools = req.tools ? req.tools.map(toChatTool) : undefined;
    const params: ChatParams = { model: this.model, messages };
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.maxTokens !== undefined) params.max_tokens = req.maxTokens;

    const fmt = req.responseFormat ?? { kind: "text" };
    if (fmt.kind === "json") {
      // Coerce JSON via a forced synthetic tool — the one structured-output
      // mechanism shared with Anthropic (no reliance on `response_format`).
      params.tools = [
        ...(tools ?? []),
        { type: "function", function: { name: JSON_TOOL, description: "Return the answer as a JSON object.", parameters: { type: "object", additionalProperties: true } } },
      ];
      params.tool_choice = { type: "function", function: { name: JSON_TOOL } };
    } else if (fmt.kind === "tool") {
      params.tools = tools;
      params.tool_choice = { type: "function", function: { name: fmt.name } };
    } else if (tools) {
      params.tools = tools;
    }

    const resp = await this.createChatCompletion(params);
    return this.fromResponse(resp, fmt.kind);
  }

  /**
   * Wraps `chat.completions.create` with a narrow, safe fallback: if the
   * server rejects an object-form `tool_choice` and exactly one tool was
   * offered, "required" is behaviorally identical (the model has nothing
   * else to pick), so retry once with the string form instead of failing
   * the whole build. Left alone when more than one tool is offered, since
   * "required" would then let the model choose freely instead of the
   * caller-specified tool — that ambiguity isn't safe to paper over
   * automatically.
   */
  private async createChatCompletion(params: ChatParams): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let attempt = params;
    // Bounded: one retry per known incompatibility below, never an open loop.
    for (let i = 0; i < 4; i++) {
      try {
        return await withRetry(() => this.client.chat.completions.create(attempt));
      } catch (err) {
        // Checked before the tool_choice fallback below: a reasoning refusal
        // also names tool_choice, and turning reasoning off keeps the caller's
        // chosen tool instead of loosening the choice to work around it.
        if (isRejectedToolsWithReasoning(err) && attempt.reasoning_effort === undefined) {
          attempt = { ...attempt, reasoning_effort: "none" } as ChatParams;
          continue;
        }
        if (isRejectedObjectToolChoice(err) && typeof attempt.tool_choice === "object" && attempt.tools?.length === 1) {
          attempt = { ...attempt, tool_choice: "required" };
          continue;
        }
        if (isRejectedMaxTokens(err) && attempt.max_tokens !== undefined) {
          const { max_tokens, ...rest } = attempt;
          attempt = { ...rest, max_completion_tokens: max_tokens } as ChatParams;
          continue;
        }
        if (isRejectedTemperature(err) && attempt.temperature !== undefined) {
          const { temperature, ...rest } = attempt;
          attempt = rest as ChatParams;
          continue;
        }
        throw err;
      }
    }
    return withRetry(() => this.client.chat.completions.create(attempt));
  }

  private fromResponse(
    resp: OpenAI.Chat.Completions.ChatCompletion,
    format: "text" | "json" | "tool",
  ): ChatResponse {
    const choice = resp.choices[0];
    const msg = choice?.message;
    const rawCalls = (msg?.tool_calls ?? []).filter(
      (c): c is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: "function" } =>
        c.type === "function",
    );
    const parse = (s: string): unknown => {
      try {
        return JSON.parse(s || "{}");
      } catch {
        return {};
      }
    };

    let text = msg?.content ?? "";
    let toolCalls: ToolCall[] = rawCalls.map((c) => ({
      id: c.id,
      name: c.function.name,
      args: parse(c.function.arguments),
    }));

    if (format === "json") {
      // Surface the synthetic tool's object as JSON text; hide it from `toolCalls`.
      const jsonCall = toolCalls.find((c) => c.name === JSON_TOOL);
      if (jsonCall) text = JSON.stringify(jsonCall.args);
      toolCalls = toolCalls.filter((c) => c.name !== JSON_TOOL);
    }

    return {
      text,
      toolCalls,
      usage: normalizeUsage(resp.usage),
      stopReason: choice?.finish_reason ?? null,
      assistant: {
        role: "assistant",
        content: msg?.content ?? "",
        toolCalls: toolCalls.length ? toolCalls : undefined,
        providerRaw: { provider: PROVIDER, raw: msg },
      },
    };
  }
}

/** Cached tokens are inside `prompt_tokens`; subtract so `input` is uncached-only. */
function normalizeUsage(u: OpenAI.Completions.CompletionUsage | undefined): Usage {
  const prompt = u?.prompt_tokens ?? 0;
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, prompt - cacheRead),
    output: u?.completion_tokens ?? 0,
    cacheRead,
    cacheCreate: 0,
  };
}
