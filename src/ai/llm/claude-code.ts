/**
 * Claude Code transport. Answers each request with one headless `claude -p`
 * call, run on the Claude Code the person installed and signed in to, so
 * `build --deep` can run on their Claude plan instead of an API key. trail
 * never asks for, reads or stores that login: `claude` finds it the way it
 * always does (its own sign-in, or `CLAUDE_CODE_OAUTH_TOKEN` from
 * `claude setup-token`).
 *
 * Every call is isolated from the person's own Claude Code setup:
 *   - `--setting-sources ""`: no user/project settings, so no hooks, plugins
 *     or CLAUDE.md; `--strict-mcp-config`, `--disable-slash-commands` and
 *     `--tools ""` leave it no MCP servers, skills or tools.
 *   - `--system-prompt-file` replaces Claude Code's own system prompt with
 *     the request's, and the call runs from a scratch folder of its own.
 *   - `--no-session-persistence`, so these calls never show up as sessions.
 *   - the child gets none of the parent's `CLAUDE*`/`ANTHROPIC*` variables
 *     (a Claude Code session running trail exports its own), except the two
 *     that say where the login is.
 * `--bare` is not used: it ignores the subscription login and only takes an
 * `ANTHROPIC_API_KEY`, which is what this provider exists to avoid.
 *
 * Only single-turn requests fit `claude -p`: system text plus one user
 * message, answered as text or as one forced tool call / JSON object, which
 * maps to `--json-schema`. That is every call the deep pass makes; anything
 * else fails loudly instead of being answered wrong. `temperature` and
 * `maxTokens` have no `claude -p` flag and are dropped. Claude Code retries
 * 429/5xx itself, so there is no transport retry here.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeBin } from "../../init/claude-call.js";
import { unwrapMarkdownFence } from "./recover-tool.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall, Usage } from "./types.js";

const PROVIDER = "claude-code";
/** A single deep-pass call takes 3 to 20 s; this only catches one that hangs. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** How long a call past its time gets to stop on SIGTERM before it's killed. */
const KILL_GRACE_MS = 2000;
const DEFAULT_SYSTEM = "You are a helpful assistant.";
const SAID_CHARS = 300;

/** The CLI's words for a login that's missing or expired (it often leaves `api_error_status` null). */
const NOT_SIGNED_IN = /not logged in|please run \/login|log ?in again|failed to authenticate|oauth|invalid api key|unauthori[sz]ed/i;
/** The CLI's words for a plan limit that is used up. */
const LIMIT_REACHED = /usage limit|limit reached|credit balance|out of credits/i;

/** What one `claude -p` process came back with. */
export interface ClaudeCodeRun {
  stdout: string;
  stderr: string;
  /** Spawn error code (`ENOENT` when there is no such program). */
  spawnError?: string;
  timedOut?: boolean;
}

/** Runs `bin args`, feeding `input` on stdin. Tests inject a fake; production spawns. */
export type ClaudeCodeRunner = (
  bin: string,
  args: string[],
  input: string,
  opts: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
) => Promise<ClaudeCodeRun>;

export interface ClaudeCodeChatModelOptions {
  model: string;
  label?: string;
  /** The `claude` to run. Default: the one `trail init` finds ({@link claudeBin}). */
  bin?: string;
  timeoutMs?: number;
  /** Inject a fake process (tests); production omits it. */
  run?: ClaudeCodeRunner;
}

/** The `claude -p --output-format json` result fields this adapter reads. */
interface ClaudeResult {
  is_error?: boolean;
  result?: unknown;
  errors?: unknown;
  api_error_status?: unknown;
  structured_output?: unknown;
  stop_reason?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export class ClaudeCodeChatModel implements ChatModel {
  readonly label: string;
  private model: string;
  private bin?: string;
  private timeoutMs: number;
  private run: ClaudeCodeRunner;
  private workDir?: string;

  constructor(opts: ClaudeCodeChatModelOptions) {
    this.model = opts.model;
    this.label = opts.label ?? `${PROVIDER}:${opts.model}`;
    this.bin = opts.bin;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.run = opts.run ?? spawnClaude;
  }

  async create(req: ChatRequest): Promise<ChatResponse> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const turns = req.messages.filter((m) => m.role !== "system");
    if (turns.length !== 1 || turns[0]!.role !== "user") {
      throw new Error(`${PROVIDER}: only single-turn requests (system + one user message) are supported`);
    }

    const fmt = req.responseFormat ?? { kind: "text" };
    let schema: Record<string, unknown> | undefined;
    if (fmt.kind === "tool") {
      const tool = req.tools?.find((t) => t.name === fmt.name);
      if (!tool) throw new Error(`${PROVIDER}: responseFormat names unknown tool "${fmt.name}"`);
      schema = tool.parameters;
    } else {
      if (req.tools?.length) throw new Error(`${PROVIDER}: tools are only supported as one forced tool call`);
      if (fmt.kind === "json") schema = { type: "object" };
    }

    const bin = this.bin ?? (this.bin = claudeBin() ?? undefined);
    if (!bin) throw new Error(`${PROVIDER}: Claude Code (claude) isn't installed on this machine`);

    const cwd = this.scratch();
    const systemFile = join(cwd, `system-${randomUUID()}.txt`);
    writeFileSync(systemFile, system || DEFAULT_SYSTEM, "utf8");
    const args = [
      "-p",
      "--model", this.model,
      "--setting-sources", "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--tools", "",
      "--no-session-persistence",
      "--no-chrome",
      "--system-prompt-file", systemFile,
      "--output-format", "json",
      ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
    ];
    let run: ClaudeCodeRun;
    try {
      run = await this.run(bin, args, turns[0]!.content, { env: childEnv(process.env), cwd, timeoutMs: this.timeoutMs });
    } finally {
      rmSync(systemFile, { force: true });
    }
    return this.fromRun(run, fmt.kind, fmt.kind === "tool" ? fmt.name : undefined);
  }

  /**
   * The cwd for every call: a folder of its own under the temp dir, so no
   * repo's CLAUDE.md or git state reaches the call. It is the same folder on
   * every run, so builds don't leave one behind each; it only ever holds the
   * per-call system prompt files, which are removed after each call.
   */
  private scratch(): string {
    if (!this.workDir) {
      this.workDir = join(tmpdir(), "trail-claude-code");
      mkdirSync(this.workDir, { recursive: true });
    }
    return this.workDir;
  }

  private fromRun(run: ClaudeCodeRun, format: "text" | "json" | "tool", toolName?: string): ChatResponse {
    if (run.spawnError === "ENOENT" || run.spawnError === "EACCES") {
      throw new Error(`${PROVIDER}: Claude Code (claude) isn't installed on this machine`);
    }
    if (run.timedOut) throw new Error(`${PROVIDER}: claude -p took longer than ${Math.round(this.timeoutMs / 1000)} s`);

    let out: ClaudeResult;
    try {
      out = JSON.parse(run.stdout) as ClaudeResult;
    } catch {
      const said = flat(run.stderr) || flat(run.stdout) || run.spawnError || "no output";
      if (NOT_SIGNED_IN.test(said)) throw new Error(notSignedIn(said));
      throw new Error(`${PROVIDER}: claude -p gave no JSON result: ${said}`);
    }
    if (out.is_error) throw new Error(errorOf(out));

    let text = typeof out.result === "string" ? out.result : "";
    let toolCalls: ToolCall[] = [];
    let stopReason = typeof out.stop_reason === "string" ? out.stop_reason : "end_turn";
    if (format !== "text") {
      let structured = out.structured_output;
      if (structured === undefined || structured === null) {
        try {
          structured = JSON.parse(unwrapMarkdownFence(text));
        } catch {
          throw new Error(`${PROVIDER}: claude -p returned no structured output`);
        }
      }
      if (format === "tool") {
        toolCalls = [{ id: `toolu_${randomUUID().replace(/-/g, "")}`, name: toolName!, args: structured }];
        text = "";
        stopReason = "tool_use";
      } else {
        text = JSON.stringify(structured);
      }
    }

    return {
      text,
      toolCalls,
      usage: normalizeUsage(out.usage),
      stopReason,
      assistant: { role: "assistant", content: text, toolCalls: toolCalls.length ? toolCalls : undefined },
    };
  }
}

/**
 * The parent's environment without anything a Claude Code session (or an
 * API setup) exported: those would point the child at the session's own
 * proxy or bill an API key. `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN`
 * stay, since they are where the person's own login lives.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    const key = k.toUpperCase();
    if ((key.startsWith("CLAUDE") || key.startsWith("ANTHROPIC")) && !keep.has(key)) continue;
    out[k] = v;
  }
  // trail's own user-level hooks stay quiet in the child, as for `trail init`'s calls.
  out.TRAIL_NO_HOOKS = "1";
  return out;
}

/**
 * A failed result as one error line. The words matter: `terminalReason`
 * (ai/failure.ts) stops the pass on "401" and "quota", so a lost login or a
 * used-up plan ends the build at once instead of failing every file.
 */
function errorOf(out: ClaudeResult): string {
  const errors = Array.isArray(out.errors) ? out.errors.filter((e): e is string => typeof e === "string") : [];
  const said = flat(typeof out.result === "string" && out.result ? out.result : errors.join("; ")) || "unknown error";
  const status = typeof out.api_error_status === "number" ? out.api_error_status : undefined;
  if (status === 401 || status === 403 || (status === undefined && NOT_SIGNED_IN.test(said))) return notSignedIn(said);
  if (status === 429 || LIMIT_REACHED.test(said)) {
    return `${PROVIDER}: 429 the Claude plan's usage quota is used up for now: ${said}`;
  }
  return `${PROVIDER}: ${status ?? "error"} ${said}`;
}

function notSignedIn(said: string): string {
  return (
    `${PROVIDER}: 401 Claude Code isn't signed in (${said}). ` +
    "Run claude and log in, or set CLAUDE_CODE_OAUTH_TOKEN from claude setup-token."
  );
}

/** Claude Code's message on one short line; a usage limit's reset stamp (`…|1760000000`) is left off. */
function flat(text: string): string {
  const line = text.replace(/\|\d{9,}\b/g, "").replace(/\s+/g, " ").trim();
  return line.length > SAID_CHARS ? `${line.slice(0, SAID_CHARS - 1)}…` : line;
}

/** Claude Code reports usage like the Messages API: uncached input, cache tokens apart. */
function normalizeUsage(u: ClaudeResult["usage"]): Usage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheCreate: u?.cache_creation_input_tokens ?? 0,
  };
}

/** The real runner: spawn `claude`, never reject, kill it past its time. */
const spawnClaude: ClaudeCodeRunner = (bin, args, input, opts) =>
  new Promise((done) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let out = "";
    let err = "";
    const finish = (r: Partial<ClaudeCodeRun>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ stdout: out, stderr: err, ...r });
    };
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      finish({ spawnError: (e as NodeJS.ErrnoException)?.code ?? String(e) });
      return;
    }
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        finish({ timedOut });
      }, KILL_GRACE_MS).unref();
    }, opts.timeoutMs);
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    // Only a little of stderr: enough for the CLI's own reason, never a whole log.
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < 4096) err += b.toString("utf8");
    });
    child.on("error", (e: NodeJS.ErrnoException) => finish({ spawnError: e?.code ?? e.message }));
    child.on("close", () => finish({ timedOut }));
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });
