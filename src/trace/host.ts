/**
 * Which agent sent a hook payload, and how much of what it did its transcript
 * keeps. Worked out from the payload itself, before any transcript is parsed,
 * never from the settings file that fired the hook: Cursor and Copilot CLI run
 * the Claude Code hooks in `.claude/settings.json` too, so a payload on a
 * Claude hook can carry a Cursor or Copilot transcript path. Parsed as Claude,
 * such a file shows no typed words and no tool results, and every save would
 * look like the agent's own.
 *
 * Tiers (how far Trail can trust the record):
 *  - A: typed words told apart, tool calls, results with a failure signal,
 *    compactions. Claude Code.
 *  - B: a full record whose host checks aren't written up yet. Codex, until HC1 to HC12 are (P31): its rollouts
 *    are read and folded (phase 2), but learning stays off.
 *  - C: typed words, calls at best, no results Trail can read. Copilot CLI,
 *    Gemini CLI (no hooks wired, no parser yet).
 *  - D: nothing Trail can read, or a shape it doesn't know. Cursor (its
 *    transcripts keep no results), anything unknown.
 * Only tier A can make a live item; everything else is held for a yes.
 *
 * `subagent` is set when the payload comes from a subagent's tool call or
 * stop (Claude Code adds `agent_id` there, never on the main thread). Its
 * transcript path still names the parent session, so the caller stays out.
 */

export type Host = "claude" | "codex" | "cursor" | "copilot" | "gemini" | "unknown";
export type Tier = "A" | "B" | "C" | "D";
export interface HostInfo {
  host: Host;
  tier: Tier;
  subagent?: true;
}

/**
 * Codex's tier (design 4.18, P31): the one constant that flips to "A", in the commit that writes up HC1 to HC12 in
 * host-checks.md and passes the Codex legs of J04, J10 and J13 in a real session. Until then a test home may set
 * TRAIL_TIER_CODEX=A (host-facts.ts `hostTier`).
 */
export const CODEX_TIER: Tier = "B";

const TIER: Record<Host, Tier> = { claude: "A", codex: CODEX_TIER, cursor: "D", copilot: "C", gemini: "C", unknown: "D" };

/** Keys only Cursor's hooks send, on its own events and on Claude's. */
const CURSOR_KEYS = ["conversation_id", "generation_id", "cursor_version", "workspace_roots"];
/** Antigravity: camelCase like Copilot, but its own. Not a host Trail reads yet. */
const ANTIGRAVITY_KEYS = ["conversationId", "artifactDirectoryPath", "workspacePaths"];
/** Copilot CLI's own hooks speak camelCase; on a .claude/settings.json it switches to snake_case with an ISO timestamp. */
const COPILOT_KEYS = ["sessionId", "toolName", "toolArgs", "transcriptPath", "toolResult"];
/** Events only Gemini CLI has; SessionStart, SessionEnd and Notification it shares with Claude Code. */
const GEMINI_EVENTS = new Set(["BeforeTool", "AfterTool", "BeforeAgent", "AfterAgent", "BeforeModel", "AfterModel", "BeforeToolSelection", "PreCompress"]);

function result(host: Host, subagent = false): HostInfo {
  return subagent ? { host, tier: TIER[host], subagent: true } : { host, tier: TIER[host] };
}

/** Forward slashes, so one set of checks reads Windows paths too. */
function slashed(p: string): string {
  return p.replace(/\\/g, "/");
}

/** The host that sent `payload` and its tier. Never throws; anything unreadable is unknown. */
export function detectHost(payload: unknown): HostInfo {
  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return result("unknown");
    const p = payload as Record<string, unknown>;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined && p[k] !== null;
    const rawPath = has("transcript_path") ? p.transcript_path : p.transcriptPath;
    const path = typeof rawPath === "string" ? slashed(rawPath) : "";
    const file = path.slice(path.lastIndexOf("/") + 1);
    const event = typeof p.hook_event_name === "string" ? p.hook_event_name : "";

    if (CURSOR_KEYS.some(has) || path.includes("/.cursor/") || path.includes("/agent-transcripts/")) return result("cursor");
    if (ANTIGRAVITY_KEYS.some(has) || path.includes("/.gemini/antigravity")) return result("unknown");
    if (has("turn_id") || /^rollout-.*\.jsonl(\.zst)?$/.test(file) || path.includes("/.codex/sessions/")) return result("codex");
    if (COPILOT_KEYS.some(has) || path.includes("/.copilot/")) return result("copilot");
    if (GEMINI_EVENTS.has(event) || path.includes("/.gemini/tmp/")) return result("gemini");
    // Copilot CLI running a .claude/settings.json speaks snake_case like Claude
    // Code, but stamps an ISO `timestamp`, which Claude Code never sends.
    if (typeof p.timestamp === "string") return result("copilot");

    // Claude Code sends a session id and its transcript's path on every event,
    // and names events in PascalCase. Without a transcript nothing proves it.
    const claudeEvent = !has("hook_event_name") || /^[A-Z][A-Za-z]+$/.test(event);
    if (typeof p.session_id === "string" && p.session_id && typeof rawPath === "string" && file.endsWith(".jsonl") && claudeEvent) {
      return result("claude", typeof p.agent_id === "string" && p.agent_id !== "");
    }
    return result("unknown");
  } catch {
    return result("unknown");
  }
}
