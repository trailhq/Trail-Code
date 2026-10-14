/**
 * OpenCode transport. OpenCode (https://opencode.ai) runs two OpenAI-compatible
 * gateways: Zen — the pay-as-you-go gateway — and Zen Go, a subscription for
 * coding agents. Both speak the OpenAI-compatible wire format, so this reuses
 * the OpenAI adapter's request/response translation and only points it at the
 * gateway.
 *
 * The value over a bare `openai` provider + `baseUrl` is a first-class,
 * self-describing provider: a sensible default address for each gateway, an
 * `opencode:<model>` / `opencode-go:<model>` label, `/models` auto-discovery,
 * and the two headers OpenCode asks coding agents to send. Zen Go rejects a
 * request that arrives without the `x-opencode-session` header (the gateway uses
 * it to keep routing and prompt caching coherent), which is exactly why a bare
 * base URL is not enough here — the header is part of the wire contract.
 */
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { OpenAIChatModel, type OpenAIChatModelOptions } from "./openai.js";
import { transportRetries } from "./types.js";
import { runningVersion } from "../../upkeep.js";

/** OpenCode Zen — pay-as-you-go gateway. */
export const DEFAULT_OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
/** OpenCode Zen Go — subscription gateway for coding agents. */
export const DEFAULT_OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * Fallback session id, generated once per process and shared by every OpenCode
 * model in it, so all the calls one `--deep` build makes look like one session.
 */
const FALLBACK_SESSION = randomUUID();

/**
 * The id sent as `x-opencode-session`. Stable for the process unless the caller
 * pins one with `OPENCODE_SESSION_ID` (e.g. to tie several runs to one session).
 */
export function openCodeSessionId(): string {
  return process.env.OPENCODE_SESSION_ID || FALLBACK_SESSION;
}

/**
 * The headers OpenCode asks a coding agent to identify itself with: a
 * `graft/<version>` User-Agent rather than the generic SDK string, and the
 * routing session id. `extra` overrides these when a caller has its own.
 */
export function openCodeHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "User-Agent": `graft/${runningVersion()}`,
    "x-opencode-session": openCodeSessionId(),
    ...extra,
  };
}

export type OpenCodeChatModelOptions = OpenAIChatModelOptions;

/**
 * ChatModel backed by OpenCode Zen. Inherits every translation detail from
 * {@link OpenAIChatModel} (the gateway is OpenAI-compatible) and only changes
 * the defaults: the Zen base URL, an `opencode:<model>` label, and the OpenCode
 * identification headers.
 */
export class OpenCodeChatModel extends OpenAIChatModel {
  constructor(opts: OpenCodeChatModelOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl ?? DEFAULT_OPENCODE_BASE_URL,
      label: opts.label ?? `opencode:${opts.model}`,
      headers: openCodeHeaders(opts.headers),
    });
  }
}

/**
 * ChatModel backed by OpenCode Zen Go. Same as {@link OpenCodeChatModel} but
 * pointed at the Go gateway; the `x-opencode-session` header it adds is required
 * by that endpoint, not merely recommended.
 */
export class OpenCodeGoChatModel extends OpenAIChatModel {
  constructor(opts: OpenCodeChatModelOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl ?? DEFAULT_OPENCODE_GO_BASE_URL,
      label: opts.label ?? `opencode-go:${opts.model}`,
      headers: openCodeHeaders(opts.headers),
    });
  }
}

/**
 * Auto-discover the models a gateway serves via `GET /models`, authenticated
 * with the same key and sending the same identification headers. Returns the
 * model ids so a caller can present/validate them instead of hardcoding a model
 * string. Defaults to Zen; pass the Go base URL for Go. A stub `client` may be
 * injected for tests.
 */
export async function listOpenCodeModels(opts: {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  client?: OpenAI;
}): Promise<string[]> {
  const client =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_OPENCODE_BASE_URL,
      defaultHeaders: openCodeHeaders(opts.headers),
      maxRetries: transportRetries(),
    });
  const res = await client.models.list();
  return res.data.map((m) => m.id);
}
