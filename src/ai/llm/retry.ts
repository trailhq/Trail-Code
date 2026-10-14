/**
 * Provider-neutral retry + backoff for every LLM call graft makes.
 *
 * Every adapter used to lean on its SDK's `maxRetries` for this. That covered
 * the common case but not all of it: the SDKs retry on 429/5xx and honour
 * `Retry-After` in delta-seconds, yet they drop `retry-after-ms`, an
 * HTTP-date `Retry-After`, and the `x-ratelimit-reset-*` hints some gateways
 * (OpenAI, Azure OpenAI, the OpenCode Zen/Go front door) send instead; they
 * differ on whether 408/409/425/529 are transient; and neither maps a gateway's
 * own rate-limit error *body* (OpenCode's `GoUsageLimitError`, an "Overloaded"
 * payload, a bare `too_many_requests`) to a retry decision. Owning the policy
 * here makes one implementation cover all of it, for every provider, rather
 * than five SDK behaviours graft cannot see or test.
 *
 * The adapters therefore construct their clients with `maxRetries: 0` and wrap
 * each request in {@link withRetry}. What the SDK did implicitly, graft now does
 * explicitly and observably.
 *
 * Conventions honoured:
 *   - `Retry-After` — delta-seconds *or* an HTTP-date (RFC 9110).
 *   - `retry-after-ms` — gateway-specific milliseconds, checked first.
 *   - `x-ratelimit-reset-requests` / `x-ratelimit-reset-tokens` — OpenAI-style
 *     Go duration strings ("1s", "6m0s", "1h2m3s"); the longest wins.
 *   - Retryable: 408 Request Timeout, 409 Conflict (a racing idempotent write),
 *     425 Too Early, 429 Too Many Requests, and every 5xx (529 Overloaded
 *     included). Connection/timeout errors with no HTTP status are retryable.
 *   - Non-retryable: 400/401/403/404/413/422, context-window overflow, and
 *     account/quota exhaustion (`GoUsageLimitError`, `FreeUsageLimitError`,
 *     "quota", "billing") — a retry cannot fix any of them and only spends time.
 *   - Exponential backoff with *equal jitter* (half fixed, half random) so a
 *     fleet of parallel calls does not retry in lockstep, capped per delay. A
 *     gateway-supplied delay is honoured as-is: retrying earlier than it asked
 *     causes a second 429 and is what #33955 was about.
 *   - A whole-request budget: if the next delay would exceed it, graft gives up
 *     rather than hang a build (a hostile or misconfigured `Retry-After:
 *     86400` surfaces immediately instead of sleeping for a day).
 *
 * All four knobs are env-overridable (see `.env.example`).
 */
import { transportRetries } from "./types.js";

/** Base of the exponential backoff, before jitter. */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
/** Ceiling for a *computed* backoff delay. A `Retry-After` hint is not capped by this. */
export const DEFAULT_BACKOFF_MAX_MS = 30_000;
/** Total time one request may spend waiting to retry before graft gives up. */
export const DEFAULT_RETRY_BUDGET_MS = 300_000;
/** Largest value `setTimeout` accepts; the practical cap for a gateway delay. */
const MAX_TIMER_MS = 2_147_483_647;

/** Reported once per retry, just before the wait. */
export interface RetryInfo {
  /** 1-based number of the attempt about to be made (the failed one + 1). */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  /** HTTP status of the failure, when it had one. */
  status?: number;
  reason: string;
}

export interface RetryOptions {
  /** Total attempts including the first. Defaults to `transportRetries() + 1`. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxElapsedMs?: number;
  /** Injected seams — tests pass deterministic versions. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  onRetry?: (info: RetryInfo) => void;
}

/** The decision made about one failure. */
export interface Failure {
  retryable: boolean;
  status?: number;
  /** A gateway-provided wait, when it sent one. Honoured over computed backoff. */
  retryAfterMs?: number;
  reason: string;
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** Base delay in ms (env `GRAFT_LLM_BACKOFF_MS`). */
export function backoffBaseMs(): number {
  return envMs("GRAFT_LLM_BACKOFF_MS", DEFAULT_BACKOFF_BASE_MS);
}

/** Per-delay ceiling in ms (env `GRAFT_LLM_BACKOFF_MAX_MS`). */
export function backoffMaxMs(): number {
  return envMs("GRAFT_LLM_BACKOFF_MAX_MS", DEFAULT_BACKOFF_MAX_MS);
}

/** Whole-request retry budget in ms (env `GRAFT_LLM_BACKOFF_BUDGET_MS`). */
export function retryBudgetMs(): number {
  return envMs("GRAFT_LLM_BACKOFF_BUDGET_MS", DEFAULT_RETRY_BUDGET_MS);
}

/** Flatten a `Headers`, a plain object, or nothing into a lowercase map. */
function headerMap(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const forEach = (headers as { forEach?: unknown }).forEach;
  if (typeof forEach === "function") {
    (headers as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === "string") out[key.toLowerCase()] = value;
      else if (Array.isArray(value) && typeof value[0] === "string") out[key.toLowerCase()] = value[0];
    }
  }
  return out;
}

/** Parse a Go duration ("1s", "6m0s", "1h2m3s", "250ms") into milliseconds. */
export function parseGoDurationMs(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number.parseFloat(m[1]);
    const unit = m[2];
    total += unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(total) : undefined;
}

/**
 * The wait a gateway asked for, in ms, or undefined when it sent no hint.
 * `retry-after-ms` wins, then `Retry-After`, then the `x-ratelimit-reset-*`
 * hints (longest of the set, since a token-bucket reset can outlast a request
 * reset). `noHeaders` in the key name is deliberate: these are the standard
 * spellings OpenAI-compatible gateways and the OpenCode Zen/Go front door use.
 */
export function parseRetryAfterMs(headers: unknown): number | undefined {
  const h = headerMap(headers);

  const ms = h["retry-after-ms"];
  if (ms !== undefined && ms.trim() !== "") {
    const n = Number.parseFloat(ms);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }

  const after = h["retry-after"];
  if (after !== undefined && after.trim() !== "") {
    const trimmed = after.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      // Delta-seconds. (A bare number: an HTTP-date never starts with a digit.)
      return Math.round(Number.parseFloat(trimmed) * 1000);
    }
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }

  const resetKeys = [
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset-requests-day",
    "x-ratelimit-reset-tokens-day",
  ];
  let longest: number | undefined;
  for (const key of resetKeys) {
    const value = h[key];
    if (value === undefined) continue;
    const parsed = parseGoDurationMs(value);
    if (parsed === undefined) continue;
    longest = longest === undefined ? parsed : Math.max(longest, parsed);
  }
  return longest;
}

/** HTTP statuses worth another attempt. Every 5xx is transient by definition. */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function headersOf(err: unknown): unknown {
  const e = err as { headers?: unknown; response?: { headers?: unknown } };
  return e?.headers ?? e?.response?.headers;
}

function bodyOf(err: unknown): string {
  const e = err as { error?: unknown; responseBody?: unknown; body?: unknown };
  for (const candidate of [e?.responseBody, e?.body, e?.error]) {
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      try {
        return JSON.stringify(candidate);
      } catch {
        /* circular or unserialisable — fall through */
      }
    }
  }
  return "";
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  const e = err as { message?: unknown };
  return typeof e?.message === "string" ? e.message : String(err ?? "");
}

function isConnectionError(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return true;
  const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" && /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR_|ERR_SOCKET)/.test(code);
}

/**
 * Decide whether a thrown value is worth retrying, and how long the gateway
 * asked us to wait. Message-text matching is a fallback only — an HTTP status,
 * when present, is authoritative, with the two exceptions a status cannot
 * express: a 4xx body that really means "out of budget" (terminal) and a
 * connection error that never reached a status at all (retryable).
 */
export function classifyError(err: unknown): Failure {
  const status = statusOf(err);
  const message = messageOf(err);
  const hay = `${message} ${bodyOf(err)}`.toLowerCase();

  if (/gousagelimiterror|freeusagelimiterror|usage limit reached|quota|insufficient[ _](?:funds|quota|credits?)|billing|payment required|\b402\b/.test(hay)) {
    return { retryable: false, status, reason: message || "the account's usage limit or quota is exhausted" };
  }
  if (/context[ _]length|context_length_exceeded|maximum context|too many tokens|reduce the length|prompt is too long|context window/.test(hay)) {
    return { retryable: false, status, reason: message || "the request exceeds the model's context window" };
  }

  const retryAfterMs = parseRetryAfterMs(headersOf(err));

  if (status !== undefined) {
    return { retryable: retryableStatus(status), status, retryAfterMs, reason: message || `HTTP ${status}` };
  }

  if (
    isConnectionError(err) ||
    /overloaded|rate increased too quickly|rate limit|too many requests|temporarily unavailable|server error|try again|timed? ?out|socket hang up|econnreset|etimedout|econnrefused|eai_again|epipe/.test(hay)
  ) {
    return { retryable: true, retryAfterMs, reason: message || "transient transport error" };
  }

  return { retryable: false, reason: message || String(err) };
}

/** Exponential backoff with equal jitter: half the window fixed, half random. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const window = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const half = window / 2;
  return Math.round(half + random() * half);
}

function formatDelay(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

/** One stderr line per retry. `GRAFT_LLM_RETRY_LOG=0` silences it. */
function defaultOnRetry(info: RetryInfo): void {
  if (process.env.GRAFT_LLM_RETRY_LOG === "0") return;
  const label = info.status !== undefined ? `HTTP ${info.status}` : info.reason;
  console.error(`⚠ LLM ${label} — retrying in ${formatDelay(info.delayMs)} (attempt ${info.attempt}/${info.maxAttempts})`);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying the failures worth retrying per {@link classifyError}.
 * Generic over the call so every adapter wraps its one SDK request with the
 * exact same policy. The first success returns immediately; a non-retryable
 * failure, or a retry whose wait would blow the budget, rethrows the original
 * error untouched so the caller's own fallbacks (`openai.ts`'s param
 * degradations, `failure.ts`'s terminal classification) still see it.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? transportRetries() + 1);
  if (maxAttempts <= 1) return fn();

  const baseMs = options.baseDelayMs ?? backoffBaseMs();
  const maxMs = options.maxDelayMs ?? backoffMaxMs();
  const budgetMs = options.maxElapsedMs ?? retryBudgetMs();
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const onRetry = options.onRetry ?? defaultOnRetry;
  const start = now();

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) throw err;
      const failure = classifyError(err);
      if (!failure.retryable) throw err;
      const delayMs =
        failure.retryAfterMs !== undefined
          ? Math.min(Math.max(0, Math.round(failure.retryAfterMs)), MAX_TIMER_MS)
          : backoffDelayMs(attempt, baseMs, maxMs, random);
      if (now() - start + delayMs > budgetMs) throw err;
      onRetry({ attempt: attempt + 1, maxAttempts, delayMs, status: failure.status, reason: failure.reason });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
