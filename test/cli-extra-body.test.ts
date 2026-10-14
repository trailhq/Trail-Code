/**
 * The request-body passthrough at the process boundary: does what the user typed
 * actually reach the socket?
 *
 * The unit tests prove the adapter merges the body it is given; they cannot prove
 * the value survives the CLI flag, config resolution, the factory, and the
 * `openai` SDK's own serialization — and a passthrough that silently goes missing
 * on that path sends the exact request the user added it to avoid. So the
 * assertion here is on the JSON a real `graft build --deep` puts on the wire.
 *
 * The stand-in gateway answers 429, as in cli-deep-failure.test.ts: the response
 * is irrelevant to what is under test, and a hard failure stops the passes after
 * a couple of calls instead of summarizing a whole repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";

/** Records every request body, then fails the call so the build gives up early. */
async function recordingGateway(): Promise<{
  url: string;
  bodies: () => Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (raw += c));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // A body we cannot parse is not a request this test can speak about.
      }
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "quota", type: "insufficient_quota" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    bodies: () => bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function repo(): string {
  const d = tmpRepo("extrabody");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "add.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  return d;
}

/**
 * Spawned asynchronously, never with spawnSync: the gateway above is served by
 * this process's event loop, which a synchronous spawn would block — the child
 * would then wait forever for a response that cannot be sent.
 */
async function runBuild(
  dir: string,
  baseUrl: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    [
      "--import", "tsx", "src/cli.ts",
      "--provider", "litellm",
      "--api-key", "test-key",
      "--base-url", baseUrl,
      "--model", "test-model",
      ...args,
      "build", dir, "--deep", "-j", "1",
    ],
    // No transport retries: the SDK's backoff is right in production but would
    // make this test wait seconds to learn what the first response already said.
    { env: { ...process.env, GRAFT_LLM_RETRIES: "0", GRAFT_LLM_EXTRA_BODY: "", GRAFT_REASONING_EFFORT: "", ...env } },
  );
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, stderr };
}

test("--extra-body reaches the wire, in the shapes real gateways need", async () => {
  const gateway = await recordingGateway();
  try {
    await runBuild(repo(), gateway.url, [
      "--reasoning-effort", "high",
      "--extra-body", '{"extra_body":{"reasoning_effort":"none"},"chat_template_kwargs":{"enable_thinking":false}}',
    ]);

    const body = gateway.bodies()[0];
    assert.ok(body, "the build made no LLM request at all");
    // A LiteLLM proxy drops a top-level reasoning_effort during its own param
    // mapping but forwards extra_body to the server it fronts…
    assert.deepEqual(body.extra_body, { reasoning_effort: "none" });
    // …while a vLLM server reached directly wants its own chat-template switch,
    // which no field in the OpenAI schema can express.
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    // The typed flag still lands where it always did — the passthrough is an
    // addition to the body, not a replacement for it.
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.model, "test-model");
  } finally {
    await gateway.close();
  }
});

test("GRAFT_LLM_EXTRA_BODY reaches the wire, and a reserved key is refused out loud", async () => {
  const gateway = await recordingGateway();
  try {
    const r = await runBuild(repo(), gateway.url, [], {
      GRAFT_LLM_EXTRA_BODY: '{"top_p":0.5,"model":"hijacked"}',
    });

    const body = gateway.bodies()[0];
    assert.ok(body, "the build made no LLM request at all");
    assert.equal(body.top_p, 0.5);
    assert.equal(body.model, "test-model", "the adapter's own model is not overridable");
    assert.match(r.stderr, /ignoring reserved extra-body key\(s\).*model/);
  } finally {
    await gateway.close();
  }
});
