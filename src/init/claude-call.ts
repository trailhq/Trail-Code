/**
 * Asking the person's own Claude Code, headless, for `trail init`: finding a
 * copy to run and making the one call.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { flatLine } from "../notes/flatten.js";

/** Whether `claude` (Claude Code) is on PATH. */
function claudeOnPath(): boolean {
  const r = spawnSync("claude", ["--version"], { stdio: "ignore", timeout: 10_000, windowsHide: true });
  return r.status === 0;
}

/** `[2, 1, 296]` from `anthropic.claude-code-2.1.296-darwin-arm64`; null for anything else. */
function extensionVersion(name: string): number[] | null {
  const m = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The Claude Code to run: `claude` on PATH, else a standalone install's copy,
 * else the newest copy the VS Code, Cursor, VS Code Insiders or Windsurf
 * extension keeps. Someone who only uses the extension has no `claude` on
 * PATH, and without this their past sessions are never read. Null when
 * there's none.
 */
export function claudeBin(home: string = homedir(), onPath: () => boolean = claudeOnPath): string | null {
  if (onPath()) return "claude";
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const p of [join(home, ".local", "bin", exe), join(home, ".claude", "local", exe)]) if (existsSync(p)) return p;
  const copies: { version: number[]; path: string }[] = [];
  for (const editor of [".vscode", ".cursor", ".vscode-insiders", ".windsurf"]) {
    const dir = join(home, editor, "extensions");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const version = extensionVersion(name);
      const path = join(dir, name, "resources", "native-binary", exe);
      if (version && existsSync(path)) copies.push({ version, path });
    }
  }
  copies.sort((a, b) => b.version[0]! - a.version[0]! || b.version[1]! - a.version[1]! || b.version[2]! - a.version[2]!);
  return copies[0]?.path ?? null;
}

/** Whether there's a Claude Code to run, on PATH or not. */
export function hasClaude(home?: string): boolean {
  return claudeBin(home) !== null;
}

/** Why Claude Code gave no answer. */
export type ClaudeFailure = "not_signed_in" | "not_installed" | "timed_out" | "refused" | "failed";

/** What one call came back with: the findings, or why there are none (with Claude Code's own short words, when it said any). */
export type ClaudeAnswer<T> = { ok: true; findings: T[]; costUsd?: number } | { ok: false; why: ClaudeFailure; said?: string };

/** The CLI's words for a login that's missing or expired. */
const NOT_SIGNED_IN = /not logged in|please run \/login|log ?in again|failed to authenticate|authentication|oauth|invalid api key|unauthori[sz]ed|\b401\b/i;
/** The CLI's words when it ran but won't do this one: limits, credit, a refusal. */
const REFUSED = /limit|quota|credit|balance|overloaded|refus|not allowed|policy|can't help|cannot help/i;
const SAID_CHARS = 80;
/** How long a call past its time gets to stop on SIGTERM before it's killed. */
const KILL_GRACE_MS = 2000;

/** Claude Code's own message, on one short line, or undefined. A usage limit's reset stamp (`…|1760000000`) is left off. */
function saidOf(text: string): string | undefined {
  const line = text.replace(/\|\d{9,}\b/g, "").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > SAID_CHARS ? `${line.slice(0, SAID_CHARS - 1)}…` : line;
}

/** Why a finished call gave no findings, from its JSON result or its plain output. */
function failureOf(out: string, err: string): { why: ClaudeFailure; said?: string } {
  let result = "";
  try {
    const r = JSON.parse(out) as { is_error?: boolean; result?: unknown; errors?: unknown; api_error_status?: unknown };
    // A run that broke mid-way lists its errors instead of a result.
    const errors = Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === "string") : [];
    result = typeof r.result === "string" && r.result ? r.result : errors.join("; ");
    if (r.api_error_status === 401) return { why: "not_signed_in" };
    if (!r.is_error && !NOT_SIGNED_IN.test(result)) return { why: "refused", ...(saidOf(result) ? { said: saidOf(result) } : {}) };
  } catch {
    result = `${out}\n${err}`;
  }
  if (NOT_SIGNED_IN.test(result) || NOT_SIGNED_IN.test(err)) return { why: "not_signed_in" };
  const said = saidOf(result) ?? saidOf(err);
  if (REFUSED.test(result)) return { why: "refused", ...(said ? { said } : {}) };
  return { why: "failed", ...(said ? { said } : {}) };
}

/**
 * The findings an answer still being written has closed so far: each whole
 * object in its `findings` array, in order. A string's braces and quotes
 * don't count; an object cut off mid-way, or an answer that doesn't start
 * with `findings`, gives none.
 */
export function completedFindings(buf: string): unknown[] {
  const head = /^\s*\{\s*"findings"\s*:\s*\[/.exec(buf);
  if (!head) return [];
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = head[0].length; i < buf.length; i++) {
    const c = buf[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      if (depth === 0) break; // the findings array itself closed
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(buf.slice(start, i + 1)));
        } catch {
          /* not an object we can read: leave it to the final answer */
        }
        start = -1;
      }
    }
  }
  return out;
}

/** The last `result` line of a streamed run, or the output as it came when it has none. */
function resultLine(out: string): string {
  const lines = out.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      if ((JSON.parse(lines[i]!) as { type?: string }).type === "result") return lines[i]!;
    } catch {
      /* not a JSON line */
    }
  }
  return out;
}

/**
 * One headless Claude Code call with the person's own login: no tools, no MCP
 * servers, no slash commands, nothing saved as a session (so this run never
 * shows up as a past session), from a scratch folder so no repo's CLAUDE.md or
 * hooks load. `TRAIL_NO_HOOKS` keeps trail's own user-level hooks quiet too.
 * The caller brings its system prompt and schema, with `findings` at the top.
 * With `onFinding`, the answer streams and each finding is handed over the
 * moment it's whole; the answer at the end is the same. Never rejects: a
 * failure comes back with its reason.
 */
export function callClaude<T>(
  bin: string,
  prompt: string,
  model: string,
  timeoutMs: number,
  ask: { system: string; schema: object; onFinding?: (finding: T) => void },
): Promise<ClaudeAnswer<T>> {
  return new Promise((done) => {
    const streaming = ask.onFinding !== undefined;
    const args = [
      "-p",
      "--model", model,
      "--output-format", streaming ? "stream-json" : "json",
      ...(streaming ? ["--verbose", "--include-partial-messages"] : []),
      "--json-schema", JSON.stringify(ask.schema),
      "--system-prompt", ask.system,
      "--tools", "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--disable-slash-commands",
    ];
    let finished = false;
    const finish = (answer: ClaudeAnswer<T>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(answer);
    };
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child;
    try {
      child = spawn(bin, args, { cwd: tmpdir(), env: { ...process.env, TRAIL_NO_HOOKS: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      finish({ ok: false, why: (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "not_installed" : "failed" });
      return;
    }
    let out = "";
    let err = "";
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // One that ignores the signal is killed, and init goes on either way: it never hangs here.
      setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ ok: false, why: "timed_out" });
      }, KILL_GRACE_MS).unref();
    }, timeoutMs);
    // Streaming: the answer's JSON as it's written, and how many of its findings were handed over.
    let pending = "";
    let answer = "";
    let handed = 0;
    const streamed = (line: string) => {
      let m: { type?: string; event?: { type?: string; delta?: { type?: string; partial_json?: string } } };
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.type !== "stream_event") return;
      if (m.event?.type === "content_block_start") answer = "";
      const part = m.event?.delta?.type === "input_json_delta" ? m.event.delta.partial_json : undefined;
      if (!part) return;
      answer += part;
      const whole = completedFindings(answer);
      for (; handed < whole.length; handed++) {
        try {
          ask.onFinding!(whole[handed] as T);
        } catch {
          /* the listener's trouble never ends the read */
        }
      }
    };
    child.stdout.on("data", (b: Buffer) => {
      const text = b.toString("utf8");
      out += text;
      if (!streaming) return;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) streamed(line);
    });
    // Only a little of stderr: enough for the CLI's own reason, never a whole log.
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < 4096) err += b.toString("utf8");
    });
    child.on("error", (e: NodeJS.ErrnoException) => finish({ ok: false, why: e?.code === "ENOENT" || e?.code === "EACCES" ? "not_installed" : "failed" }));
    child.on("close", () => {
      if (timedOut) return finish({ ok: false, why: "timed_out" });
      if (streaming) out = resultLine(out);
      try {
        const r = JSON.parse(out) as { is_error?: boolean; structured_output?: { findings?: T[] }; total_cost_usd?: number };
        if (!r.is_error && r.structured_output) {
          return finish({ ok: true, findings: r.structured_output.findings ?? [], ...(typeof r.total_cost_usd === "number" ? { costUsd: r.total_cost_usd } : {}) });
        }
      } catch {
        /* not JSON: the CLI's own words say why */
      }
      finish({ ok: false, ...failureOf(out, err) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

/** `callClaude` for callers that only need the answer: null when there's none. */
export async function askClaude<T>(
  bin: string,
  prompt: string,
  model: string,
  timeoutMs: number,
  ask: { system: string; schema: object },
): Promise<{ findings: T[]; costUsd?: number } | null> {
  const a = await callClaude<T>(bin, prompt, model, timeoutMs, ask);
  return a.ok ? { findings: a.findings, ...(a.costUsd !== undefined ? { costUsd: a.costUsd } : {}) } : null;
}

/**
 * Why `what` couldn't be read, in plain words with what to do about it.
 * "couldn't read" never stands alone: the reason comes first.
 */
export function whyLine(f: { why: ClaudeFailure; said?: string }, what: string): string {
  // Plain `trail init` won't look back again once it has, so every retry points at --look-back; Claude Code's own
  // words are one flat line of at most 80 characters, double quotes made single (as the naming call's, b6 review).
  const said = f.said ? flatLine(f.said, 80).replace(/["\u201c\u201d]/g, "'") : "";
  const again = "To try again: trail init --look-back";
  switch (f.why) {
    case "not_signed_in":
      return `Claude Code isn't signed in on this terminal, so trail couldn't read ${what}. Run claude auth login, then trail init --look-back.`;
    case "not_installed":
      return `Claude Code isn't installed on this machine, so trail couldn't read ${what}. Install it, then run trail init --look-back.`;
    case "timed_out":
      return `Claude Code took longer than 3 minutes to answer, so trail stopped reading ${what}. ${again}`;
    case "refused":
      return `Claude Code said no${said ? ` ("${said}")` : ""}, so trail couldn't read ${what}. ${again}`;
    default:
      return `Claude Code stopped with an error${said ? ` ("${said}")` : ""}, so trail couldn't read ${what}. ${again}`;
  }
}
