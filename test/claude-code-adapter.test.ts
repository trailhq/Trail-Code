/**
 * Network-free tests for the claude-code provider. A fake runner stands in for
 * the `claude -p` process, so these need no Claude Code install and no login:
 * they assert the isolating flags, the single-turn mapping, the translation of
 * the CLI's JSON result into a ChatResponse, and that a lost login or a used-up
 * plan stops the deep pass the way a bad key or spent quota does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeChatModel, childEnv, type ClaudeCodeRun, type ClaudeCodeRunner } from "../src/ai/llm/claude-code.js";
import { createChatModel, providerNeedsApiKey } from "../src/ai/llm/factory.js";
import { resolveConfig } from "../src/ai/providers.js";
import { LlmFailureGate } from "../src/ai/failure.js";
import type { ChatRequest } from "../src/ai/llm/types.js";
import { nameReport } from "../src/blast/name.js";
import type { BlastReport } from "../src/blast/blast.js";
import type { GraphV1 } from "../src/graph/types.js";

interface Seen {
  bin: string;
  args: string[];
  input: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  system: string;
}

/** A runner that records the call (and the system prompt file while it exists) and answers `reply`. */
function fakeRun(reply: Partial<ClaudeCodeRun> | object) {
  const box: { seen?: Seen } = {};
  const run: ClaudeCodeRunner = async (bin, args, input, opts) => {
    const file = args[args.indexOf("--system-prompt-file") + 1]!;
    box.seen = { bin, args, input, env: opts.env, cwd: opts.cwd, system: readFileSync(file, "utf8") };
    if ("stdout" in reply || "spawnError" in reply || "timedOut" in reply) return { stdout: "", stderr: "", ...reply };
    return { stdout: JSON.stringify(reply), stderr: "" };
  };
  return { run, box };
}

function model(run: ClaudeCodeRunner) {
  return new ClaudeCodeChatModel({ model: "claude-haiku-5-5", bin: "claude", run });
}

const ask = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [
    { role: "system", content: "You summarize code." },
    { role: "user", content: "Summarize this file." },
  ],
  ...over,
});

/** Set env vars for one test body, then put back exactly what was there. */
async function withEnv(vars: Record<string, string | undefined>, body: () => unknown): Promise<void> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (v: Record<string, string | undefined>) => {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  };
  put(vars);
  try {
    await body();
  } finally {
    put(before);
  }
}

const RECORD = { name: "record", description: "Record it.", parameters: { type: "object", properties: { a: { type: "string" } } } };
const usage = { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };

test("claude-code: one isolated claude -p, system prompt from a file, user text on stdin", async () => {
  const { run, box } = fakeRun({ is_error: false, result: "A summary.", usage });
  const res = await model(run).create(ask({ temperature: 0, maxTokens: 100 }));
  const { args } = box.seen!;
  assert.equal(box.seen!.bin, "claude");
  assert.equal(args[0], "-p");
  assert.equal(args[args.indexOf("--model") + 1], "claude-haiku-5-5");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(!args.includes("--bare"), "--bare ignores the subscription login");
  assert.ok(!args.includes("--json-schema"), "plain text needs no schema");
  assert.equal(box.seen!.system, "You summarize code.");
  assert.equal(box.seen!.input, "Summarize this file.");
  // The system prompt file is gone once the call is over.
  assert.ok(!existsSync(args[args.indexOf("--system-prompt-file") + 1]!));

  assert.equal(res.text, "A summary.");
  assert.deepEqual(res.toolCalls, []);
  assert.deepEqual(res.usage, { input: 12, output: 5, cacheRead: 3, cacheCreate: 2 });
  assert.equal(res.stopReason, "end_turn");
  assert.deepEqual(res.assistant, { role: "assistant", content: "A summary.", toolCalls: undefined });
});

test("claude-code: a forced tool becomes --json-schema, and structured_output comes back as that tool call", async () => {
  const { run, box } = fakeRun({ is_error: false, result: "", structured_output: { a: "x" }, usage });
  const res = await model(run).create(ask({ tools: [RECORD], responseFormat: { kind: "tool", name: "record" } }));
  const { args } = box.seen!;
  assert.deepEqual(JSON.parse(args[args.indexOf("--json-schema") + 1]!), RECORD.parameters);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0]!.name, "record");
  assert.deepEqual(res.toolCalls[0]!.args, { a: "x" });
  assert.match(res.toolCalls[0]!.id, /^toolu_[0-9a-f]{32}$/);
  assert.equal(res.text, "");
  assert.equal(res.stopReason, "tool_use");
  assert.deepEqual(res.assistant.toolCalls, res.toolCalls);
});

test("claude-code: without structured_output the result text is parsed, fenced or not", async () => {
  const fenced = fakeRun({ is_error: false, result: '```json\n{"a":"y"}\n```' });
  const res = await model(fenced.run).create(ask({ tools: [RECORD], responseFormat: { kind: "tool", name: "record" } }));
  assert.deepEqual(res.toolCalls[0]!.args, { a: "y" });

  const prose = fakeRun({ is_error: false, result: "Sure! Here it is." });
  await assert.rejects(
    model(prose.run).create(ask({ tools: [RECORD], responseFormat: { kind: "tool", name: "record" } })),
    /returned no structured output/,
  );
});

test("claude-code: json format asks for an object and returns it as text", async () => {
  const { run, box } = fakeRun({ is_error: false, result: "", structured_output: { k: 1 } });
  const res = await model(run).create(ask({ responseFormat: { kind: "json" } }));
  const { args } = box.seen!;
  assert.deepEqual(JSON.parse(args[args.indexOf("--json-schema") + 1]!), { type: "object" });
  assert.equal(res.text, '{"k":1}');
  assert.deepEqual(res.toolCalls, []);
});

test("claude-code: multi-turn requests and unforced tools fail loudly instead of being answered wrong", async () => {
  const { run } = fakeRun({ is_error: false, result: "x" });
  const m = model(run);
  await assert.rejects(
    m.create({
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    }),
    /only single-turn requests/,
  );
  await assert.rejects(m.create(ask({ tools: [RECORD] })), /only supported as one forced tool call/);
  await assert.rejects(m.create(ask({ tools: [RECORD], responseFormat: { kind: "tool", name: "other" } })), /unknown tool "other"/);
});

test("claude-code: the child gets no CLAUDE*/ANTHROPIC* variables except where the login lives", () => {
  const env = childEnv({
    PATH: "/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "sdk",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    ANTHROPIC_API_KEY: "sk-ant-x",
    Anthropic_Api_Key: "sk-ant-y",
    CLAUDE_CONFIG_DIR: "/home/me/.claude",
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    CLAUDE_CONFIG_DIR: "/home/me/.claude",
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
    TRAIL_NO_HOOKS: "1",
  });
});

test("claude-code: a lost login stops the deep pass at once, like a rejected API key", async () => {
  const cases = [
    { is_error: true, api_error_status: 401, result: "Invalid bearer token" },
    // The CLI often leaves the status null on an expired login.
    { is_error: true, api_error_status: null, result: "Failed to authenticate: OAuth session expired and could not be refreshed" },
    { stdout: "", stderr: "Not logged in · Please run /login" },
  ];
  for (const reply of cases) {
    const { run } = fakeRun(reply);
    const err = await model(run).create(ask()).then(() => null, (e: Error) => e);
    assert.ok(err, JSON.stringify(reply));
    assert.match(err.message, /\b401\b.*claude setup-token/);
    const gate = new LlmFailureGate();
    gate.record(err.message);
    assert.ok(gate.stopped, err.message);
  }
});

test("claude-code: a used-up plan limit stops the deep pass at once, like a spent quota", async () => {
  for (const reply of [
    { is_error: true, api_error_status: 429, result: "Rate limited" },
    { is_error: true, api_error_status: null, result: "Claude AI usage limit reached|1760000000" },
  ]) {
    const { run } = fakeRun(reply);
    const err = await model(run).create(ask()).then(() => null, (e: Error) => e);
    assert.ok(err);
    assert.match(err.message, /quota/);
    assert.ok(!err.message.includes("1760000000"), "the reset stamp is left off");
    const gate = new LlmFailureGate();
    gate.record(err.message);
    assert.ok(gate.stopped);
  }
});

test("claude-code: an overloaded API or a broken run is an ordinary failure, not terminal", async () => {
  for (const reply of [
    { is_error: true, api_error_status: 529, result: "Overloaded" },
    { stdout: "segfault", stderr: "" },
    { timedOut: true },
  ]) {
    const { run } = fakeRun(reply);
    const err = await model(run).create(ask()).then(() => null, (e: Error) => e);
    assert.ok(err);
    const gate = new LlmFailureGate();
    gate.record(err.message);
    assert.ok(!gate.stopped, err.message);
  }
  const missing = fakeRun({ spawnError: "ENOENT" });
  await assert.rejects(model(missing.run).create(ask()), /isn't installed/);
});

test("claude-code: factory wiring, no API key needed, a default model, and a claude-code label", () => {
  const m = createChatModel({ provider: "claude-code", apiKey: "", model: "claude-haiku-5-5" });
  assert.ok(m instanceof ClaudeCodeChatModel);
  assert.equal(m.label, "claude-code:claude-haiku-5-5");
  assert.equal(providerNeedsApiKey("claude-code"), false);
  assert.equal(providerNeedsApiKey("anthropic"), true);

  return withEnv({ GRAFT_MODEL: undefined, GRAFT_OPENROUTER_MODEL: undefined, ORCAROUTER_MODEL: undefined }, () => {
    assert.equal(resolveConfig({ provider: "claude-code" }).model, "claude-haiku-5-5");
  });
});

test("claude-code: blast naming uses it only from the CLI, never from the GitHub App, even with a key set", async () => {
  await withEnv({ GRAFT_PROVIDER: "claude-code", GRAFT_API_KEY: "sk-other" }, async () => {
    const contextDir = mkdtempSync(join(tmpdir(), "claude-code-name-"));
    const graph = { nodes: [], edges: [] } as unknown as GraphV1;
    const report = () => ({ modules: [], areas: [] }) as unknown as BlastReport;
    const app = await nameReport(graph, report(), contextDir);
    assert.match(app.note ?? "", /only for commands you run yourself/);
    const cli = await nameReport(graph, report(), contextDir, { allowClaudeCode: true });
    assert.doesNotMatch(cli.note ?? "", /only for commands you run yourself|no API key/);
  });
});

test("claude-code: the real runner spawns the program and reads its JSON", { skip: process.platform === "win32" ? "shebang stand-in" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-stand-in-"));
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (b) => (input += b));
process.stdin.on("end", () => {
  console.log(JSON.stringify({ is_error: false, result: "echo:" + input + ":" + (process.env.TRAIL_NO_HOOKS || "") }));
});
`,
  );
  chmodSync(bin, 0o755);
  const res = await new ClaudeCodeChatModel({ model: "m", bin }).create(ask());
  assert.equal(res.text, "echo:Summarize this file.:1");

  const slow = join(dir, "slow");
  writeFileSync(slow, `#!/usr/bin/env node\nprocess.stdin.resume();\nsetTimeout(() => console.log("{}"), 5000);\n`);
  chmodSync(slow, 0o755);
  await assert.rejects(new ClaudeCodeChatModel({ model: "m", bin: slow, timeoutMs: 300 }).create(ask()), /took longer than/);
});
