/**
 * Reading a Claude Code transcript: whose words each line holds.
 *
 * Only what the person typed can teach Trail anything. A transcript's `user`
 * lines also carry text the agent read: compaction summaries (the model's
 * own retelling, which can repeat what a tool returned), task notices from
 * background work, slash-command wrappers, other sessions' hand-backs,
 * subagent lines, tool results. About a third of what a naive `type: user`
 * test calls a prompt is one of these. The flags Claude Code writes
 * (`origin.kind`, `isMeta`, `isCompactSummary`, `isSidechain`) and the
 * wrappers it puts around harness text decide; a line from a build too old to
 * stamp `origin` is judged by its wrappers alone. `promptSource` does not
 * decide: the desktop app and the IDE extension mark typed prompts `sdk`.
 * A row from `claude -p` or an SDK (`entrypoint: sdk…`) is a script's prompt,
 * never the person's, except in a lab home with the lab switch on (D26, D99),
 * where the lab's headless runs stand in for a person.
 *
 * IDE context (`<ide_opened_file>`, `<ide_selection>`) and reminders ride in
 * the same message as a real prompt, so they are stripped and the prompt is
 * kept. A pasted block becomes a marker: the person sent it, but didn't write
 * it.
 *
 * This is the one filter every learning path uses: cold start, the trace
 * stream, provenance.
 *
 * `readNewEvents` turns what a transcript gained since the last read into one
 * stream: typed words, injected text, tool calls, their results (failed or
 * not), assistant text and compactions. Built in memory, never stored.
 */
import { readAppended, type Memo, type ReadOptions } from "./cursor.js";
import { failedText } from "./failure.js";
import { labInteractive } from "../skills/host-facts.js";

/**
 * `offset` is the byte offset of the line the event came from (the save gate
 * re-reads that line). A call carries the folder (`cwd`) and branch
 * (`gitBranch`) the host recorded on its line; a result carries the host's own
 * error flag (`isError`) apart from `ok`, which also reads failure text.
 * `uuid` is the line's entry id: a transcript that repeats a block of its
 * history repeats the ids, so the fold can tell old lines from new (D56d).
 */
export type TraceEvent =
  | { kind: "typed"; text: string; at: string; offset?: number; uuid?: string }
  | { kind: "injected"; text: string; at: string; offset?: number; uuid?: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown; at: string; offset?: number; uuid?: string; cwd?: string; branch?: string }
  | { kind: "tool_result"; id: string; ok: boolean; text: string; at: string; offset?: number; uuid?: string; isError?: boolean }
  | { kind: "compaction"; at: string; offset?: number; uuid?: string }
  | { kind: "assistant"; text: string; at: string; offset?: number; uuid?: string };

interface Entry {
  type?: string;
  uuid?: unknown;
  subtype?: string;
  timestamp?: string;
  cwd?: unknown;
  gitBranch?: unknown;
  isApiErrorMessage?: boolean;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  entrypoint?: string;
  origin?: { kind?: string } | null;
  message?: { content?: unknown } | null;
  attachment?: { type?: string; commandMode?: string; isMeta?: boolean; origin?: { kind?: string } | null; prompt?: unknown; content?: unknown } | null;
}

/** What stands for a pasted block in the person's words. */
export const PASTE_MARK = "[pasted text]";

/** Context the harness or IDE wraps around a real prompt: stripped, the prompt kept. */
const WRAPPED = /<(ide_[a-z_]+|system-reminder|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;
/** Claude Code writes `<pasted_content id="1">…</pasted_content id="1">`; a cut-off one runs to the end. */
const PASTED = /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content[^>]*>|$)/g;
/**
 * Harness text that stands where a prompt would: a leading tag
 * (`<task-notification>`, `<command-name>`, `<local-command-stdout>`,
 * `<bash-input>`, `<agent-message>`, …), an interruption, a resumed
 * session's preamble, a hand-back from another session.
 */
const NOT_TYPED = [
  /^<[a-z][a-z0-9_-]*(?:\s[^>]*)?>/,
  /^Caveat:/,
  /^Another Claude session sent a message/,
  /^\[Request interrupted/,
  /^This session is being continued/,
];
/**
 * A comment the person sent from an artifact (Claude Desktop): the harness's
 * framing, then the comment quoted with "> " between BEGIN and END lines. Only
 * the quoted comment is typed.
 */
const ARTIFACT_COMMENT = /^\[Artifact comment sent to Claude\]/;
const ARTIFACT_QUOTE = /^=== BEGIN ARTIFACT COMMENT (\S+) ===\n([\s\S]*?)\n=== END ARTIFACT COMMENT \1 ===$/m;

/** The text parts of a message's content, joined; images, tool parts and the rest left out. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const p of content) {
    if (p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string") {
      out.push((p as { text: string }).text);
    }
  }
  return out.join("\n");
}

/**
 * The person's own words in one message's raw text: wrappers stripped,
 * pastes marked, and "" when what's left is harness text or nothing typed.
 */
export function ownText(raw: string): string {
  let t = raw.replace(WRAPPED, "").replace(PASTED, PASTE_MARK).trim();
  if (ARTIFACT_COMMENT.test(t)) t = (ARTIFACT_QUOTE.exec(t)?.[2] ?? "").replace(/^> ?/gm, "").trim();
  if (!t || NOT_TYPED.some((re) => re.test(t))) return "";
  if (!t.split(PASTE_MARK).join("").trim()) return "";
  return t;
}

/** The raw text of a line that could be the person's, or null when its flags say it isn't. */
function candidateText(entry: unknown, env: NodeJS.ProcessEnv): string | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Entry;
  if (e.isMeta || e.isSidechain || e.isCompactSummary || e.isVisibleInTranscriptOnly) return null;
  // `claude -p` and the SDKs: a script's prompt, written once and replayed. Only a lab home with the switch (D99) reads it.
  if (typeof e.entrypoint === "string" && e.entrypoint.startsWith("sdk") && !labInteractive(env)) return null;
  const human = (o: Entry["origin"]) => o === undefined || o === null || (typeof o === "object" && o.kind === "human");
  if (e.type === "user") {
    if (!human(e.origin)) return null;
    const content = e.message?.content;
    if (Array.isArray(content) && content.some((p) => p && typeof p === "object" && (p as { type?: unknown }).type === "tool_result")) return null;
    return textOf(content);
  }
  // A message typed while the agent was busy is queued and lands as an attachment.
  if (e.type === "attachment") {
    const a = e.attachment;
    if (!a || a.type !== "queued_command" || a.commandMode !== "prompt" || a.isMeta || !human(a.origin)) return null;
    return textOf(a.prompt);
  }
  return null;
}

/**
 * What the person typed in this transcript line, IDE tags and reminders stripped; "" when it isn't theirs.
 * `env` decides only whether an sdk row can be typed (a lab home with the switch, D99).
 */
export function typedText(entry: unknown, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const raw = candidateText(entry, env);
    return raw === null ? "" : ownText(raw);
  } catch {
    return "";
  }
}

/** Whether this transcript line is something the person typed. */
export function isTypedByPerson(entry: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return typedText(entry, env) !== "";
}

/* -------------------------------------------------------------------------- */
/* The event stream                                                           */
/* -------------------------------------------------------------------------- */

/** Tools whose results are command output, so their text can say they failed. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
/** Open tool calls carried between reads, so a late result still knows its tool. */
const MAX_PENDING = 500;
/** Text kept per event: the head, and the tail where outcomes print. */
const MAX_TEXT = 40_000;
const KEEP_HEAD = 8_000;

function clip(t: string): string {
  return t.length > MAX_TEXT ? `${t.slice(0, KEEP_HEAD)}\n…\n${t.slice(-(MAX_TEXT - KEEP_HEAD))}` : t;
}

/** The wrapped and pasted blocks taken out of a typed message: text the agent saw, not the person's words. */
function strippedBlocks(raw: string): string {
  return [...raw.matchAll(WRAPPED), ...raw.matchAll(PASTED)].map((m) => m[0]).join("\n").trim();
}

function pendingOf(memo: Memo): Record<string, string> {
  const p = memo.pending;
  if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, string>;
  return (memo.pending = {}) as Record<string, string>;
}

function hookText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((c): c is string => typeof c === "string").join("\n") : "";
}

/** The events one transcript line holds, appended to `out`. `offset`: where the line starts in the file. */
function eventsOf(e: Entry & { message?: { content?: unknown } | null }, memo: Memo, out: TraceEvent[], offset: number | undefined, env: NodeJS.ProcessEnv): void {
  const at = typeof e.timestamp === "string" ? e.timestamp : "";
  // Subagent lines are another context's work; their hand-back arrives as a result or a notice.
  if (e.isSidechain) return;
  const where = { ...(offset === undefined ? {} : { offset }), ...(typeof e.uuid === "string" && e.uuid ? { uuid: e.uuid } : {}) };
  const push = (ev: TraceEvent) => {
    if (ev.kind !== "injected") memo.boundary = false;
    out.push({ ...ev, ...where });
  };
  const injected = (text: string) => {
    const t = text.trim();
    if (t) out.push({ kind: "injected", text: clip(t), at, ...where });
  };
  const cwd = typeof e.cwd === "string" && e.cwd ? { cwd: e.cwd } : {};
  const branch = typeof e.gitBranch === "string" && e.gitBranch ? { branch: e.gitBranch } : {};

  if (e.type === "system") {
    if (e.subtype === "compact_boundary") {
      push({ kind: "compaction", at });
      memo.boundary = true;
    }
    return;
  }

  if (e.type === "assistant") {
    if (e.isApiErrorMessage) return;
    const content = e.message?.content;
    if (typeof content === "string") {
      if (content.trim()) push({ kind: "assistant", text: clip(content), at });
      return;
    }
    if (!Array.isArray(content)) return;
    const pending = pendingOf(memo);
    for (const part of content as Array<Record<string, unknown> | null>) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) push({ kind: "assistant", text: clip(part.text), at });
      if (part.type === "tool_use") {
        const id = String(part.id ?? "");
        const name = String(part.name ?? "");
        pending[id] = name;
        push({ kind: "tool_call", id, name, input: part.input ?? null, at, ...cwd, ...branch });
      }
    }
    const ids = Object.keys(pending);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PENDING))) delete pending[id];
    return;
  }

  if (e.type === "user") {
    const content = e.message?.content;
    if (e.isCompactSummary) {
      // Older builds write the summary with no boundary line before it.
      if (!memo.boundary) push({ kind: "compaction", at });
      memo.boundary = false;
      injected(textOf(content));
      return;
    }
    if (Array.isArray(content) && content.some((p) => p && typeof p === "object" && (p as { type?: unknown }).type === "tool_result")) {
      const pending = pendingOf(memo);
      for (const part of content as Array<Record<string, unknown> | null>) {
        if (!part || typeof part !== "object" || part.type !== "tool_result") continue;
        const id = String(part.tool_use_id ?? "");
        const name: string | undefined = pending[id];
        delete pending[id];
        const text = typeof part.content === "string" ? part.content : textOf(part.content);
        // A call never seen (read before this window) is judged as a command.
        const isError = part.is_error === true;
        const ok = !(isError || ((name === undefined || SHELL_TOOLS.has(name)) && failedText(text)));
        push({ kind: "tool_result", id, ok, text: clip(text), at, isError });
      }
      return;
    }
    const typed = typedText(e, env);
    if (typed) {
      push({ kind: "typed", text: typed, at });
      injected(strippedBlocks(textOf(content)));
      return;
    }
    injected(textOf(content));
    return;
  }

  if (e.type === "attachment") {
    const a = e.attachment;
    if (!a || typeof a !== "object") return;
    if (a.type === "queued_command") {
      const typed = typedText(e, env);
      if (typed) {
        push({ kind: "typed", text: typed, at });
        injected(strippedBlocks(textOf(a.prompt)));
      } else injected(textOf(a.prompt));
    } else if (a.type === "hook_additional_context") {
      injected(hookText(a.content));
    }
  }
}

/**
 * The events one parsed transcript line holds: the reader `readNewEvents` uses, for a caller that walks a file
 * itself (init's replay over a byte range, b5). `memo` carries the open tool calls from line to line: start it
 * as `{}` and pass the same object for every line of one read. Never throws on a line that isn't an entry.
 */
export function lineEvents(entry: unknown, memo: Memo, offset?: number, env: NodeJS.ProcessEnv = process.env): TraceEvent[] {
  const out: TraceEvent[] = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return out;
  eventsOf(entry as Entry, memo, out, offset, env);
  return out;
}

export interface EventReadOptions extends ReadOptions {
  /**
   * Each line read, parsed, before its events: for a reader that needs what
   * the events leave out (a reply's uuid, a response's usage). `memo` is the
   * one saved with the cursor and started over with it; keep the caller's
   * state under one key of its own. A throw is the caller's to avoid: it
   * ends the read without saving the cursor.
   */
  onEntry?: (entry: Record<string, unknown>, memo: Memo) => void;
  /** Whose env decides whether an sdk row is typed (`typedText`); default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The events a Claude Code transcript gained since the last call with the
 * same `cursorPath`. The first call with no cursor reads at most the last
 * 8 MB (`opts.firstReadBytes`; `Infinity` for the whole file). Never throws: a
 * transcript that can't be read gives no events, and a cursor that can't be
 * saved still returns what was read.
 */
export function readNewEvents(transcriptPath: string, cursorPath: string, opts: EventReadOptions = {}): TraceEvent[] {
  const out: TraceEvent[] = [];
  const onEntry = opts.onEntry;
  const env = opts.env ?? process.env;
  try {
    readAppended(
      transcriptPath,
      cursorPath,
      (line, memo, offset) => {
        let e: unknown;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (!e || typeof e !== "object" || Array.isArray(e)) return;
        if (onEntry) onEntry(e as Record<string, unknown>, memo);
        eventsOf(e as Entry, memo, out, offset, env);
      },
      opts,
    );
  } catch {
    /* fail open */
  }
  return out;
}
