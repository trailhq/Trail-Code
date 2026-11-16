/**
 * The synthesis model at the engine boundary (`src/engine.ts`).
 *
 * Everything below the engine — the cache key, the batching — is covered by the
 * build-level tests, but the engine is the piece that turns `--synth-model` into
 * a second transport and a cache-key label, and it had no test at all: reverting
 * it wholesale left the suite green while synthesis rode the wrong model. So
 * this pins the whole path against a local OpenAI-compatible endpoint: which
 * model each wire request NAMES, what the manifest credits, and the fact that
 * the cache keys by the synthesis model — a switch re-synthesizes, a re-run
 * costs nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Graft } from "../src/engine.js";
import { tmpRepo } from "./helpers.js";

/** What one chat request named: the model it asked for, and the tool it forced
 *  (summaries are plain text; synthesis forces `record_graph`). */
interface ChatRequest {
  model: string;
  tool: string | null;
}

/**
 * An OpenAI-compatible endpoint that answers every call and records what each
 * asked for: summaries come back as plain text, synthesis as a `record_graph`
 * tool call carrying one node per `## path` in the prompt.
 */
async function graftEndpoint(): Promise<{ url: string; requests: ChatRequest[]; close: () => Promise<void> }> {
  const requests: ChatRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const tool: string | null = body?.tool_choice?.function?.name ?? null;
      requests.push({ model: body.model, tool });

      let message: Record<string, unknown>;
      if (tool === "record_graph") {
        const prompt = String(body.messages.at(-1)?.content ?? "");
        const paths = [...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
        message = {
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "record_graph",
                arguments: JSON.stringify({
                  nodes: paths.map((p) => ({ name: p, type: "file", summary: `synth: ${p}`, sources: [p], links: [] })),
                }),
              },
            },
          ],
        };
      } else {
        message = { content: "A short prose summary.", tool_calls: [] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    })().catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function repo(tag: string): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < 4; i++) writeFileSync(join(dir, "src", `m${i}.ts`), `export function run${i}(): number {\n  return ${i};\n}\n`);
  return dir;
}

/** The model-related env the engine reads, scrubbed so the test's own config is
 *  the only voice, with GRAFT_LLM_RETRIES off so a hiccup fails fast. */
function engineEnv(): NodeJS.ProcessEnv {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["GRAFT_DIR", "GRAFT_MODEL", "GRAFT_SYNTH_MODEL", "GRAFT_LLM_RETRIES"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GRAFT_LLM_RETRIES = "0";
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  delete process.env.GRAFT_LLM_RETRIES;
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v;
  }
}

test("--synth-model names its own model on the wire, credits the manifest, and keys the cache", async () => {
  const saved = engineEnv();
  const endpoint = await graftEndpoint();
  const dir = repo("engine-synth");
  try {
    const base = { provider: "openai" as const, apiKey: "test-key", model: "main-model", baseUrl: endpoint.url };

    const first = await new Graft({ ...base, synthModel: "synth-model" }).init(dir);
    assert.equal(first.nodes, 4, "the synthesis result must land as graph nodes");
    const summaries = endpoint.requests.filter((q) => q.tool === null);
    const syntheses = endpoint.requests.filter((q) => q.tool === "record_graph");
    assert.equal(summaries.length, 4, "one summary call per file");
    assert.equal(syntheses.length, 1, "one synthesis call for the whole repo");
    assert.ok(summaries.every((q) => q.model === "main-model"), "summaries must ride the build model");
    assert.ok(syntheses.every((q) => q.model === "synth-model"), `synthesis must ride the synthesis model, saw: ${syntheses.map((q) => q.model).join(",")}`);

    const manifest = JSON.parse(readFileSync(join(dir, "graft", "manifest.json"), "utf8")) as { model: string };
    assert.equal(manifest.model, "openai:main-model + synth:synth-model", "the manifest must credit both models");

    // Same build again: everything is cached, the endpoint hears nothing.
    const after = endpoint.requests.length;
    await new Graft({ ...base, synthModel: "synth-model" }).init(dir);
    assert.equal(endpoint.requests.length, after, "an unchanged build must be fully cached, synthesis included");

    // A different synthesis model is a different result: synthesis re-runs and
    // names the new model, while the per-file summaries stay cached.
    const rerun = endpoint.requests.length;
    await new Graft({ ...base, synthModel: "other-synth" }).init(dir);
    const fresh = endpoint.requests.slice(rerun);
    const freshSynths = fresh.filter((q) => q.tool === "record_graph");
    assert.equal(fresh.filter((q) => q.tool === null).length, 0, "summaries must not be re-summarized");
    assert.ok(freshSynths.length >= 1, "a different synthesis model must re-synthesize");
    assert.ok(freshSynths.every((q) => q.model === "other-synth"), "the re-synthesis must name the new model");
  } finally {
    restoreEnv(saved);
    await endpoint.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a synth model the build model takes both passes and the manifest says so", async () => {
  const saved = engineEnv();
  const endpoint = await graftEndpoint();
  const dir = repo("engine-synth-default");
  try {
    await new Graft({ provider: "openai", apiKey: "test-key", model: "main-model", baseUrl: endpoint.url }).init(dir);
    const models = new Set(endpoint.requests.map((q) => q.model));
    assert.deepEqual([...models], ["main-model"], "every call must ride the build model");
    const manifest = JSON.parse(readFileSync(join(dir, "graft", "manifest.json"), "utf8")) as { model: string };
    assert.equal(manifest.model, "openai:main-model");
  } finally {
    restoreEnv(saved);
    await endpoint.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
