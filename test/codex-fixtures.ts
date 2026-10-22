/**
 * Synthetic Codex rollout lines, shaped like the files codex-cli 0.150 writes
 * (`{timestamp, type, payload}`; `session_meta` first; `response_item` and
 * `event_msg` lines; exec output with its `Process exited with code N`
 * header). Made-up repos, prompts and output only: nothing here comes from a
 * real rollout. Shared by the Codex tests; not a test file itself.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const CODEX_SID = "019fa295-20a9-7943-90ae-0c1d2e3f4a5b";
/** 2026-10-27T10:00:00Z plus `sec` seconds. */
export const at = (sec: number) => new Date(Date.UTC(2026, 9, 27, 10, 0, 0) + sec * 1000).toISOString();

export type Line = { timestamp: string; type: string; payload: Record<string, unknown> };
const line = (type: string, payload: Record<string, unknown>, sec = 0): Line => ({ timestamp: at(sec), type, payload });

export function meta(o: { id?: string; originator?: string; source?: unknown; cli?: string; cwd?: string; history?: string; branch?: string } = {}): Line {
  const id = o.id ?? CODEX_SID;
  return line("session_meta", {
    id, session_id: id, timestamp: at(0), cwd: o.cwd ?? "/home/dev/shop", originator: o.originator ?? "codex_cli_rs",
    cli_version: o.cli ?? "0.150.0-alpha.8", source: o.source ?? "cli", model_provider: "openai", history_mode: o.history ?? "legacy",
    base_instructions: { text: "You are a coding agent." }, git: { commit_hash: "0123456789abcdef0123456789abcdef01234567", branch: o.branch ?? "main", repository_url: "git@github.com:acme/shop.git" },
  });
}
export const turnContext = (cwd: string, turn = "turn-1", sec = 0) =>
  line("turn_context", { turn_id: turn, cwd, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: "gpt-5-codex" }, sec);
export const taskStarted = (turn = "turn-1", sec = 0) => line("event_msg", { type: "task_started", turn_id: turn, started_at: 1 }, sec);
/** A typed prompt, legacy history: the event, then the same text as a user message the model sees. */
export const userMessage = (text: string, sec = 0) =>
  line("event_msg", { type: "user_message", message: text, images: [], local_images: [], text_elements: [] }, sec);
export const userItem = (text: string, sec = 0, role = "user") =>
  line("response_item", { type: "message", role, content: [{ type: "input_text", text }] }, sec);
/** A typed prompt, paginated history. */
export const userCompleted = (text: string, sec = 0) =>
  line("event_msg", { type: "item_completed", thread_id: CODEX_SID, turn_id: "turn-1", completed_at_ms: 1, item: { type: "UserMessage", id: "um-1", content: [{ type: "text", text, text_elements: [] }] } }, sec);
export const agentMessage = (text: string, sec = 0) => line("event_msg", { type: "agent_message", message: text, phase: null }, sec);
export const assistantItem = (text: string, sec = 0) => line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] }, sec);
/** The agent's words as Codex records them: the event, then the message item (deduplicated by the reader). */
export const reply = (text: string, sec = 0) => [agentMessage(text, sec), assistantItem(text, sec)];

export const fnCall = (callId: string, name: string, args: unknown, sec = 0) =>
  line("response_item", { type: "function_call", name, arguments: typeof args === "string" ? args : JSON.stringify(args), call_id: callId }, sec);
export const exec = (callId: string, cmd: string, workdir?: string, sec = 0) =>
  fnCall(callId, "exec_command", { cmd, ...(workdir ? { workdir } : {}), yield_time_ms: 10000 }, sec);
export const output = (callId: string, out: unknown, sec = 0) => line("response_item", { type: "function_call_output", call_id: callId, output: out }, sec);
/** Unified exec's output text with its header. */
export const execText = (code: number, body: string) => `Chunk ID: 4f2a9c\nWall time: 0.4120 seconds\nProcess exited with code ${code}\nOriginal token count: 12\nOutput:\n${body}`;
export const runningText = (session: number, body: string) => `Chunk ID: 7b1e3d\nWall time: 10.0011 seconds\nProcess running with session ID ${session}\nOriginal token count: 9\nOutput:\n${body}`;
export const execOut = (callId: string, code: number, body: string, sec = 0) => output(callId, execText(code, body), sec);
export const writeStdin = (callId: string, session: number, chars = "", sec = 0) => fnCall(callId, "write_stdin", { session_id: session, chars, yield_time_ms: 5000 }, sec);
export const applyPatch = (callId: string, files: string[], sec = 0) =>
  line("response_item", { type: "custom_tool_call", call_id: callId, name: "apply_patch", input: `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n-old\n+new`).join("\n")}\n*** End Patch` }, sec);
export const customOut = (callId: string, text: string, sec = 0) => line("response_item", { type: "custom_tool_call_output", call_id: callId, output: text }, sec);
export const commandDone = (id: string, command: string[], exitCode: number, out: string, sec = 0) =>
  line("event_msg", { type: "item_completed", thread_id: CODEX_SID, turn_id: "turn-1", completed_at_ms: 2, item: { type: "CommandExecution", id, command, cwd: "/home/dev/shop", parsed_cmd: [], source: "agent", status: exitCode === 0 ? "completed" : "failed", aggregated_output: out, exit_code: exitCode } }, sec);
export const compacted = (sec = 0) => line("compacted", { message: "Summary of the earlier work." }, sec);
export const contextCompacted = (sec = 0) => line("event_msg", { type: "context_compacted" }, sec);
export const taskComplete = (turn = "turn-1", sec = 0) => line("event_msg", { type: "task_complete", turn_id: turn, last_agent_message: null }, sec);

export const jsonl = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

/** A Codex home under `root` with one rollout for `sid`; returns its path. */
export function rollout(root: string, lines: object[], sid = CODEX_SID, ext = ".jsonl"): string {
  const dir = join(root, ".codex", "sessions", "2026", "10", "27");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-27T10-00-00-${sid}${ext}`);
  writeFileSync(path, lines.length ? jsonl(lines) : "");
  return path;
}
export const appendLines = (path: string, lines: object[]) => appendFileSync(path, jsonl(lines));
