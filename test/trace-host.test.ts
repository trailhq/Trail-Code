/**
 * Which host sent a hook payload, worked out before any transcript is parsed.
 * Cursor and Copilot CLI run the Claude Code hooks a repo or a home folder
 * sets up, so a payload arriving on a Claude hook is not proof it came from
 * Claude Code. Payloads here are synthetic, shaped after each host's docs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHost } from "../src/trace/host.js";

const claudeStop = {
  session_id: "0b5c3c1e-4c1a-4a53-9a59-0d8f4f0c2a11",
  transcript_path: "/home/dev/.claude/projects/-home-dev-shop/0b5c3c1e-4c1a-4a53-9a59-0d8f4f0c2a11.jsonl",
  cwd: "/home/dev/shop",
  permission_mode: "default",
  hook_event_name: "Stop",
  stop_hook_active: false,
};

test("a Claude Code payload is claude, tier A", () => {
  assert.deepEqual(detectHost(claudeStop), { host: "claude", tier: "A" });
  const pre = {
    session_id: "s1",
    transcript_path: "/home/dev/.claude/projects/-home-dev-shop/s1.jsonl",
    cwd: "/home/dev/shop",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  };
  assert.deepEqual(detectHost(pre), { host: "claude", tier: "A" });
});

test("a Claude Code payload from a subagent says so, so callers can stay out of it", () => {
  const pre = { ...claudeStop, hook_event_name: "PreToolUse", agent_id: "a1b2c3", agent_type: "Explore", tool_name: "Bash", tool_input: { command: "ls" } };
  assert.deepEqual(detectHost(pre), { host: "claude", tier: "A", subagent: true });
  const stop = { ...claudeStop, hook_event_name: "SubagentStop", agent_id: "a1b2c3", agent_type: "general-purpose" };
  assert.deepEqual(detectHost(stop), { host: "claude", tier: "A", subagent: true });
  // The main thread carries no agent id.
  assert.deepEqual(detectHost({ ...claudeStop, agent_id: "" }), { host: "claude", tier: "A" });
});

test("a Claude Code payload from a custom config folder is still claude", () => {
  const p = { ...claudeStop, transcript_path: "/opt/claude-config/projects/-srv-app/abc.jsonl" };
  assert.deepEqual(detectHost(p), { host: "claude", tier: "A" });
});

test("a Cursor payload is cursor, tier D, even when it arrives on Claude's hooks", () => {
  const native = {
    conversation_id: "c-123",
    generation_id: "g-456",
    hook_event_name: "stop",
    cursor_version: "2.4.1",
    workspace_roots: ["/home/dev/shop"],
    user_email: "dev@example.test",
    transcript_path: "/home/dev/.cursor/projects/home-dev-shop/agent-transcripts/c-123/c-123.jsonl",
  };
  assert.deepEqual(detectHost(native), { host: "cursor", tier: "D" });
  // Cursor's third-party hooks: Claude's event names and keys, Cursor's own markers alongside.
  const onClaudeHooks = { ...claudeStop, conversation_id: "c-123", cursor_version: "2.4.1" };
  assert.deepEqual(detectHost(onClaudeHooks), { host: "cursor", tier: "D" });
  const pathOnly = { ...claudeStop, transcript_path: "/home/dev/.cursor/projects/home-dev-shop/agent-transcripts/c-1/c-1.jsonl" };
  assert.deepEqual(detectHost(pathOnly), { host: "cursor", tier: "D" });
  const versionOnly = { ...claudeStop, cursor_version: "2.4.1" };
  assert.deepEqual(detectHost(versionOnly), { host: "cursor", tier: "D" });
});

test("a Codex payload is codex, tier B until its parser lands", () => {
  const codex = {
    session_id: "019a-thread",
    turn_id: "turn-7",
    transcript_path: "/home/dev/.codex/sessions/2026/10/15/rollout-2026-10-15T10-00-00-019a-thread.jsonl",
    cwd: "/home/dev/shop",
    hook_event_name: "Stop",
    model: "gpt-5",
    stop_hook_active: false,
    last_assistant_message: "Done.",
  };
  assert.deepEqual(detectHost(codex), { host: "codex", tier: "B" });
  // No turn_id, but a rollout file is Codex's.
  const { turn_id: _drop, ...noTurn } = codex;
  assert.deepEqual(detectHost(noTurn), { host: "codex", tier: "B" });
});

test("a Copilot CLI payload is copilot, tier C", () => {
  const camel = { sessionId: "cp-1", timestamp: 1760000000000, cwd: "/home/dev/shop", toolName: "bash", toolArgs: '{"command":"ls"}' };
  assert.deepEqual(detectHost(camel), { host: "copilot", tier: "C" });
  const stop = { sessionId: "cp-1", timestamp: 1760000000000, cwd: "/home/dev/shop", transcriptPath: "/home/dev/.copilot/session-state/cp-1/events.jsonl" };
  assert.deepEqual(detectHost(stop), { host: "copilot", tier: "C" });
  // Copilot running a repo's Claude hooks, snake_case payload, its own transcript file.
  const onClaudeHooks = { session_id: "cp-1", cwd: "/home/dev/shop", hook_event_name: "Stop", transcript_path: "/home/dev/.copilot/session-state/cp-1/events.jsonl" };
  assert.deepEqual(detectHost(onClaudeHooks), { host: "copilot", tier: "C" });
  // Its "VS Code compatible" mode (the one it uses for a .claude/settings.json,
  // whose event names are PascalCase): snake_case like Claude Code, but with an
  // ISO timestamp Claude Code never sends, and COPILOT_HOME can put its
  // transcript anywhere.
  const vscodeMode = { hook_event_name: "Stop", session_id: "cp-2", timestamp: "2026-10-15T10:00:00Z", cwd: "/home/dev/shop", transcript_path: "/srv/copilot-home/session-state/cp-2/events.jsonl", stop_hook_active: false };
  assert.deepEqual(detectHost(vscodeMode), { host: "copilot", tier: "C" });
  assert.deepEqual(detectHost({ ...vscodeMode, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), { host: "copilot", tier: "C" });
});

test("a Gemini CLI payload is gemini, tier C", () => {
  const before = {
    session_id: "g-1",
    transcript_path: "/home/dev/.gemini/tmp/4f2a/chats/session-2026-10-15T10-00-g-1.jsonl",
    cwd: "/home/dev/shop",
    hook_event_name: "BeforeTool",
    timestamp: "2026-10-15T10:00:00.000Z",
    tool_name: "run_shell_command",
    tool_input: { command: "ls" },
  };
  assert.deepEqual(detectHost(before), { host: "gemini", tier: "C" });
  // An event name both hosts share: the chats folder decides.
  assert.deepEqual(detectHost({ ...before, hook_event_name: "SessionStart" }), { host: "gemini", tier: "C" });
  // A Gemini-only event name with no transcript.
  assert.deepEqual(detectHost({ session_id: "g-1", cwd: "/x", hook_event_name: "AfterAgent", prompt: "hi", prompt_response: "ok" }), { host: "gemini", tier: "C" });
});

test("anything else is unknown, tier D", () => {
  for (const p of [null, undefined, "Stop", 42, [], {}, { session_id: "s1" }, { hook_event_name: "Stop" }]) {
    assert.deepEqual(detectHost(p), { host: "unknown", tier: "D" }, JSON.stringify(p));
  }
  // Claude-looking, but no transcript to read: nothing proves it is Claude Code.
  assert.deepEqual(detectHost({ session_id: "s1", cwd: "/x", hook_event_name: "Stop" }), { host: "unknown", tier: "D" });
  // A transcript that isn't JSONL.
  assert.deepEqual(detectHost({ ...claudeStop, transcript_path: "/home/dev/notes.txt" }), { host: "unknown", tier: "D" });
  // An unknown event name on Claude-shaped keys.
  assert.deepEqual(detectHost({ ...claudeStop, hook_event_name: "beforeShellExecution" }), { host: "unknown", tier: "D" });
  // Antigravity: camelCase like Copilot, but not Copilot.
  const antigravity = {
    conversationId: "a-1",
    workspacePaths: ["/home/dev/shop"],
    transcriptPath: "/home/dev/.gemini/antigravity/brain/a-1/.system_generated/logs/transcript.jsonl",
    artifactDirectoryPath: "/home/dev/.gemini/antigravity/brain/a-1",
    modelName: "m",
  };
  assert.deepEqual(detectHost(antigravity), { host: "unknown", tier: "D" });
});

test("Windows paths are read the same way", () => {
  const p = { ...claudeStop, transcript_path: "C:\\Users\\dev\\.cursor\\projects\\shop\\agent-transcripts\\c-1\\c-1.jsonl" };
  assert.deepEqual(detectHost(p), { host: "cursor", tier: "D" });
  const c = { ...claudeStop, transcript_path: "C:\\Users\\dev\\.claude\\projects\\C--shop\\s1.jsonl" };
  assert.deepEqual(detectHost(c), { host: "claude", tier: "A" });
});

test("a hostile payload never throws", () => {
  const evil = new Proxy({}, { get() { throw new Error("boom"); }, has() { throw new Error("boom"); } });
  assert.deepEqual(detectHost(evil), { host: "unknown", tier: "D" });
  assert.deepEqual(detectHost({ ...claudeStop, transcript_path: 7 }), { host: "unknown", tier: "D" });
});
