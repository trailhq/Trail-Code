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
import { transportRetries } from "./types.js";
import type { ChatModel, ChatRequest, ChatResponse, ExtraBody, Message, ReasoningEffort, ToolCall, ToolSpec, Usage } from "./types.js";

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
  /**
   * Hidden-reasoning budget for reasoning-capable models. Set "none" when a
   * server silently spends the whole max_tokens budget on reasoning and returns
   * empty content. Omitted by default, leaving the model's own default in force.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Provider-specific parameters merged into the request body, for a parameter
   * the OpenAI schema has no name for. See {@link ExtraBody}.
   */
  extraBody?: ExtraBody;
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

/**
 * Body keys this adapter owns, and the only ones a passthrough may not set.
 * `messages`/`tools`/`tool_choice` carry the structured-output coercion the
 * caller asked for, `model` is what the graph manifest label is built from, and
 * `stream` would change the response shape out from under {@link fromResponse}.
 * Everything else is the caller's business — including `temperature` and
 * `reasoning_effort`, where overriding graft's value is the point.
 */
const RESERVED_BODY_KEYS = new Set(["model", "messages", "tools", "tool_choice", "stream"]);

/**
 * Drop reserved keys once, at construction, rather than per request: a
 * passthrough is set once for a whole run, so a silent drop on every call would
 * either say nothing or say it thousands of times. Warn and continue instead of
 * throwing — the rest of the body is still what the caller's gateway needs.
 */
function sanitizeExtraBody(extra: ExtraBody | undefined, label: string): ExtraBody | undefined {
  if (!extra) return undefined;
  const kept: ExtraBody = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(extra)) {
    if (RESERVED_BODY_KEYS.has(key)) dropped.push(key);
    else kept[key] = value;
  }
  if (dropped.length > 0) {
    console.warn(`graft: ignoring reserved extra-body key(s) for ${label}: ${dropped.join(", ")}`);
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

export class OpenAIChatModel implements ChatModel {
  readonly label: string;
  private client: OpenAI;
  private model: string;
  private reasoningEffort?: ReasoningEffort;
  private extraBody?: ExtraBody;

  constructor(opts: OpenAIChatModelOptions) {
    this.model = opts.model;
    this.label = opts.label ?? `${PROVIDER}:${opts.model}`;
    this.reasoningEffort = opts.reasoningEffort;
    this.extraBody = sanitizeExtraBody(opts.extraBody, this.label);
    this.client =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseUrl,
        defaultHeaders: opts.headers,
        maxRetries: transportRetries(),
      });
  }

  async create(req: ChatRequest): Promise<ChatResponse> {
    const messages = req.messages.map(toChatMessage);
    const tools = req.tools ? req.tools.map(toChatTool) : undefined;
    const params: ChatParams = { model: this.model, messages };
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.maxTokens !== undefined) params.max_tokens = req.maxTokens;
    // Sent up front, unlike the reasoning fallback in createChatCompletion: that
    // one reacts to a 400, but a server can instead accept the request and return
    // 200 with empty content, having spent the whole max_tokens budget on hidden
    // reasoning (LM Studio does this). Nothing throws, so no catch-based fallback
    // can reach it - the caller has to be able to say "no reasoning" up front.
    if (this.reasoningEffort !== undefined) params.reasoning_effort = this.reasoningEffort;

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

    // Merged last, so a caller who names a key graft also sets — reasoning_effort
    // and temperature are the ones that matter — gets their value on the wire.
    // That is the whole point of the escape hatch: the stack in front of the
    // model, not this adapter, is what decides which spelling actually works.
    if (this.extraBody) Object.assign(params as unknown as Record<string, unknown>, this.extraBody);

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
        return await this.client.chat.completions.create(attempt);
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
    return this.client.chat.completions.create(attempt);
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
