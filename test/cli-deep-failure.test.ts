/**
 * #127, at the process boundary: `graft build --deep` against a provider that
 * rejects every call must EXIT NON-ZERO and say the meaning tier is incomplete.
 *
 * The reported case was an 884-file repo behind a gateway with a hard token quota:
 * 1,617 files failed with 429, the build printed its normal success footer, and
 * exited 0 — so the degradation was only discovered days later through bad `ask`
 * results. A local server standing in for that gateway is the only way to pin the
 * exit code down, since the failure lives in the CLI's reporting, not in a unit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpRepo, wasmParserFailureCliArgs } from "./helpers.js";

/** A gateway that answers every request the way an exhausted quota does. */
async function quotaExhaustedServer(): Promise<{ url: string; close: () => Promise<void>; calls: () => number }> {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    calls++;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Request exceeds your current quota, please check your plan and billing details", type: "insufficient_quota" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function repo(files: number): string {
  const d = tmpRepo("deepfail");
  mkdirSync(join(d, "src"), { recursive: true });
  for (let i = 0; i < files; i++) {
    writeFileSync(join(d, "src", `m${i}.ts`), `export function run${i}(): number {\n  return ${i};\n}\n`);
  }
  return d;
}

/**
 * Runs the build ASYNCHRONOUSLY on purpose. `spawnSync` would deadlock: the stand-in
 * gateway is served by this very process's event loop, which a synchronous spawn
 * blocks — so the child would wait forever for a response that cannot be sent.
 */
async function runBuild(
  dir: string,
  baseUrl: string,
  extra: string[] = [],
  injectWasmFailure = false,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const cliArgs = [
    "--provider", "openai",
    "--api-key", "test-key",
    "--base-url", baseUrl,
    "--model", "test-model",
    "build", dir, "--deep", "-j", "1",
    ...extra,
  ];
  const child = spawn(
    process.execPath,
    injectWasmFailure
      ? wasmParserFailureCliArgs(cliArgs)
      : ["--import", "tsx", "src/cli.ts", ...cliArgs],
    {
      // No transport retries: the SDK's backoff is correct behaviour but would make
      // this test spend seconds waiting to learn what the first response already said.
      env: { ...process.env, GRAFT_LLM_RETRIES: "0" },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, stdout, stderr };
}

test("#127: a quota-exhausted --deep build exits 1 and says the meaning tier is incomplete", async () => {
  const gateway = await quotaExhaustedServer();
  try {
    const d = repo(20);
    const r = await runBuild(d, gateway.url);

    assert.equal(r.status, 1, `expected a failing exit\n${r.stderr}`);
    assert.match(r.stderr, /the deep pass did not complete/);
    assert.match(r.stderr, /quota\/credit for this key is exhausted/);
    // Nothing summarized at all: the denominator is every node in the graph (file
    // nodes carry a summary too), so it is matched loosely on purpose.
    assert.match(r.stderr, /meaning coverage: 0\/\d+ symbols \(0%\)/);
    assert.match(r.stderr, /re-run `graft build --deep` to resume/);
    // The structural tier still succeeded and is still written — this is a loud
    // warning about a degraded tier, not a rolled-back build.
    assert.match(r.stdout, /✓ wiring: /);
  } finally {
    await gateway.close();
  }
});

test("#127: --allow-partial keeps the same report but exits 0, for callers that accept a partial tier", async () => {
  const gateway = await quotaExhaustedServer();
  try {
    const d = repo(5);
    const r = await runBuild(d, gateway.url, ["--allow-partial"]);

    assert.equal(r.status, 0, `expected --allow-partial to exit 0\n${r.stderr}`);
    assert.match(r.stderr, /the deep pass did not complete/);
  } finally {
    await gateway.close();
  }
});

test("--allow-partial cannot waive a structural failure during a degraded deep build", async () => {
  const gateway = await quotaExhaustedServer();
  try {
    const d = repo(5);
    writeFileSync(join(d, "Broken.cs"), "public class Broken {}\n");
    const r = await runBuild(d, gateway.url, ["--allow-partial"], true);

    assert.equal(r.status, 1, `expected the structural failure to win\n${r.stderr}`);
    assert.match(r.stderr, /wiring incomplete: 1 structural error\(s\)/);
    assert.match(r.stderr, /the deep pass did not complete/);
  } finally {
    await gateway.close();
  }
});

test("#127: the doomed calls stop instead of one per file", async () => {
  const gateway = await quotaExhaustedServer();
  try {
    const d = repo(40);
    await runBuild(d, gateway.url);
    // 40 files, plus the concept pass ahead of the crux pass. The old behaviour was
    // one call per file per pass and a clean exit; the bound here is what "stopped
    // early" means in requests, which is the part that costs money.
    assert.ok(gateway.calls() < 20, `expected the passes to give up early, saw ${gateway.calls()} requests`);
  } finally {
    await gateway.close();
  }
});
