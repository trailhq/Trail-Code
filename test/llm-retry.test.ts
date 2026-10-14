/**
 * Network-free tests for the shared LLM retry policy (`src/ai/llm/retry.ts`).
 *
 * The value here is that graft, not the SDKs, decides what to retry: it reads
 * every rate-limit hint a gateway can send (`retry-after-ms`, a delta-seconds or
 * HTTP-date `Retry-After`, the `x-ratelimit-reset-*` Go durations), classifies
 * quota/context failures as terminal, and applies exponential backoff with
 * jitter. Sleeps, clock, and RNG are injected so a full backoff schedule runs
 * instantly and deterministically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import {
  withRetry,
  classifyError,
  parseRetryAfterMs,
  parseGoDurationMs,
  retryableStatus,
  backoffDelayMs,
  type RetryInfo,
} from "../src/ai/llm/retry.js";
import { OpenAIChatModel } from "../src/ai/llm/openai.js";
import { AnthropicChatModel } from "../src/ai/llm/anthropic.js";

function apiError(status: number, message: string, headers: Record<string, string> = {}): OpenAI.APIError {
  return new OpenAI.APIError(status, { message }, message, new Headers(headers));
}

/** Run `fn` with a scrubbed retry environment, restoring it afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const keys = [
    "GRAFT_LLM_RETRIES",
    "GRAFT_LLM_BACKOFF_MS",
    "GRAFT_LLM_BACKOFF_MAX_MS",
    "GRAFT_LLM_BACKOFF_BUDGET_MS",
    "GRAFT_LLM_RETRY_LOG",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// --- Header parsing ---------------------------------------------------------

test("retry: retry-after-ms wins, then delta-seconds, then an HTTP-date", () => {
  assert.equal(parseRetryAfterMs({ "retry-after-ms": "1500" }), 1500);
  assert.equal(parseRetryAfterMs({ "retry-after": "2" }), 2000);
  assert.equal(parseRetryAfterMs({ "retry-after": "2.5" }), 2500);
  // retry-after-ms beats retry-after when both are present.
  assert.equal(parseRetryAfterMs({ "retry-after-ms": "10", "retry-after": "30" }), 10);

  const at = Date.now() + 5000;
  const httpDate = new Date(at).toUTCString();
  const parsed = parseRetryAfterMs({ "retry-after": httpDate });
  assert.ok(parsed !== undefined && parsed > 0 && parsed <= 5000, `HTTP-date parsed ${parsed}`);

  assert.equal(parseRetryAfterMs({}), undefined);
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs(new Headers({ "Retry-After": "3" })), 3000);
});

test("retry: x-ratelimit-reset-* Go durations are parsed, longest wins", () => {
  assert.equal(parseGoDurationMs("1s"), 1000);
  assert.equal(parseGoDurationMs("6m0s"), 360_000);
  assert.equal(parseGoDurationMs("1h2m3s"), 3_723_000);
  assert.equal(parseGoDurationMs("250ms"), 250);
  assert.equal(parseGoDurationMs("nonsense"), undefined);
  assert.equal(
    parseRetryAfterMs({ "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "30s" }),
    30_000,
  );
});

test("retry: statuses worth another attempt", () => {
  for (const s of [408, 409, 425, 429, 500, 502, 503, 504, 529]) assert.equal(retryableStatus(s), true, `${s}`);
  for (const s of [400, 401, 403, 404, 413, 422]) assert.equal(retryableStatus(s), false, `${s}`);
});

// --- Classification ---------------------------------------------------------

test("retry: transient statuses and connection errors are retryable", () => {
  assert.equal(classifyError(apiError(503, "server error")).retryable, true);
  assert.equal(classifyError(apiError(529, "Overloaded")).retryable, true);
  const conn = Object.assign(new Error("socket hang up"), { name: "APIConnectionError" });
  assert.equal(classifyError(conn).retryable, true);
  const reset = Object.assign(new Error("boom"), { code: "ECONNRESET" });
  assert.equal(classifyError(reset).retryable, true);
});

test("retry: a 429 carries the gateway's wait hint through classification", () => {
  const f = classifyError(apiError(429, "rate limited", { "retry-after": "7" }));
  assert.equal(f.retryable, true);
  assert.equal(f.retryAfterMs, 7000);
  assert.equal(f.status, 429);
});

test("retry: auth, bad request, context overflow, and quota limits are terminal", () => {
  assert.equal(classifyError(apiError(401, "invalid api key")).retryable, false);
  assert.equal(classifyError(apiError(400, "bad request")).retryable, false);
  assert.equal(classifyError(apiError(400, "This model's maximum context length is 8192 tokens")).retryable, false);
  assert.equal(classifyError(apiError(429, "FreeUsageLimitError")).retryable, false);
  const go = apiError(429, '{"error":{"type":"GoUsageLimitError"}}');
  assert.equal(classifyError(go).retryable, false);
  assert.equal(classifyError(new Error("plain failure")).retryable, false);
});

// --- Backoff schedule -------------------------------------------------------

test("retry: equal-jitter backoff halves at the floor, doubles, then caps", () => {
  assert.equal(backoffDelayMs(1, 1000, 30000, () => 0), 500);
  assert.equal(backoffDelayMs(1, 1000, 30000, () => 1), 1000);
  assert.equal(backoffDelayMs(2, 1000, 30000, () => 1), 2000);
  assert.equal(backoffDelayMs(3, 1000, 30000, () => 1), 4000);
  assert.equal(backoffDelayMs(10, 1000, 30000, () => 1), 30000); // capped
});

// --- The loop ---------------------------------------------------------------

test("retry: retries a transient failure, then returns the success", async () => {
  const sleeps: number[] = [];
  const retries: RetryInfo[] = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls <= 2) throw apiError(503, "server error");
      return "ok";
    },
    {
      maxAttempts: 4,
      random: () => 1,
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: (info) => retries.push(info),
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.deepEqual(retries.map((r) => r.attempt), [2, 3]);
  assert.equal(retries[0].status, 503);
});

test("retry: a gateway Retry-After is honoured exactly, not jittered", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls === 1) throw apiError(429, "slow down", { "retry-after": "3" });
      return "ok";
    },
    {
      maxAttempts: 3,
      random: () => 1,
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: () => {},
    },
  );
  assert.deepEqual(sleeps, [3000]);
});

test("retry: gives up after maxAttempts and rethrows the last error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw apiError(503, "server error");
      },
      { maxAttempts: 3, random: () => 0, now: () => 0, sleep: async () => {}, onRetry: () => {} },
    ),
    /server error/,
  );
  assert.equal(calls, 3);
});

test("retry: a non-retryable failure is rethrown without an attempt", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw apiError(401, "invalid api key");
      },
      { maxAttempts: 5, random: () => 0, now: () => 0, sleep: async () => {}, onRetry: () => {} },
    ),
    /invalid api key/,
  );
  assert.equal(calls, 1);
});

test("retry: a wait that would blow the budget gives up instead of hanging", async () => {
  let calls = 0;
  let slept = false;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw apiError(429, "slow down", { "retry-after": "86400" });
      },
      {
        maxAttempts: 5,
        maxElapsedMs: 60_000,
        now: () => 0,
        sleep: async () => {
          slept = true;
        },
        onRetry: () => {},
      },
    ),
    /slow down/,
  );
  assert.equal(calls, 1);
  assert.equal(slept, false);
});

test("retry: maxAttempts of 1 (GRAFT_LLM_RETRIES=0) disables the loop", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw apiError(503, "server error");
      },
      { maxAttempts: 1, sleep: async () => {}, onRetry: () => {} },
    ),
  );
  assert.equal(calls, 1);
});

// --- Adapter integration ----------------------------------------------------

test("retry: the OpenAI adapter retries a 429 and then succeeds", async () => {
  await withEnv({ GRAFT_LLM_BACKOFF_MS: "0", GRAFT_LLM_RETRY_LOG: "0" }, async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            if (calls === 1) throw apiError(429, "rate limited", { "retry-after-ms": "0" });
            return {
              choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        },
      },
    } as unknown as OpenAI;
    const m = new OpenAIChatModel({ apiKey: "x", model: "gpt-x", client });
    const res = await m.create({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.text, "ok");
    assert.equal(calls, 2);
  });
});

test("retry: the Anthropic adapter retries a 503 and then succeeds", async () => {
  await withEnv({ GRAFT_LLM_BACKOFF_MS: "0", GRAFT_LLM_RETRY_LOG: "0" }, async () => {
    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          calls++;
          if (calls === 1) throw apiError(503, "overloaded", { "retry-after-ms": "0" });
          return {
            content: [{ type: "text", text: "hi there" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    } as unknown as Anthropic;
    const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
    const res = await m.create({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.text, "hi there");
    assert.equal(calls, 2);
  });
});
