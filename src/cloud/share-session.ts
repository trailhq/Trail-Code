/**
 * `trail share-session`: one of this repo's Claude Code sessions, in full,
 * ready to send to the Trail team. Internal only: trail-cloud takes it from
 * the Trail team's own workspace and nobody else's.
 *
 * Claude Code keeps a session as `~/.claude/projects/<folder>/<id>.jsonl`,
 * its subagents' transcripts as `<id>/subagents/*.jsonl` next to it, and tool
 * output too big for the transcript as `<id>/tool-results/*`. The bundle is
 * every line of those, as one JSONL: each subagent line says its `agentId`, a
 * tool-result file goes as a `trail-share-file` line. Nothing is summarised.
 *
 * Before anything leaves the laptop every string in it goes through
 * `redactText`, the save check's own secret rule, and every value of a `.env`
 * file the session read or wrote is taken out. Images (pasted screenshots,
 * the browser's) are left out: they hold no words and are most of the bytes.
 * So are thinking signatures, opaque bytes of Anthropic's.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { flatLine } from "../notes/flatten.js";
import { sessionProjectDir } from "../notes/session-cost.js";
import { typedText } from "../trace/claude.js";
import { REDACTED, redactText, type Redaction } from "../trace/redact.js";

/** Most a zipped session can be: what trail-cloud takes. A long session zips to 1-3 MB. */
export const MAX_GZ_BYTES = 10 * 1024 * 1024;
/** How much of each end of a transcript the list reads for its title. */
const HEAD_BYTES = 512 * 1024;
/** A tool-result file bigger than this is left out. */
const MAX_TOOL_FILE = 5 * 1024 * 1024;
/** Tool-result files that are text, and so go. */
const TEXT_FILE = /\.(?:txt|json|jsonl|md|log|csv|tsv|html?|xml|ya?ml|diff|patch)$/i;
/** A `.env` file (`.env`, `.env.local`, `.envrc`, `prod.env`), not a template of one. */
const ENV_FILE = /(?:^|[\\/])(?:\.env(?:rc)?(?:\.[\w-]+)*|[\w-]+\.env)$/i;
const ENV_TEMPLATE = /\.(?:example|sample|template|dist|defaults)$/i;
/**
 * A shell step that reads a `.env` file: a reading command, `source`, `.` or
 * `--env-file`, then the file, before the next `|`, `;`, `&` or line. A
 * `.env` named anywhere else (in a script's text, a commit message) isn't one.
 */
const ENV_IN_COMMAND = /(?:\b(?:cat|head|tail|less|more|bat|grep|rg|ag|sed|awk|cut|sort|diff|cp|source|xargs|dotenv)\b|--env-file\b|(?:^|[;&|]\s*)\.(?=\s))[^|;&\n]*?(?:^|[\s'"=/<])(\.env(?:rc)?(?:\.[\w-]+)*|[\w-]+\.env)(?=$|[\s'";|&)<>])/gm;

function readsEnv(command: string): boolean {
  for (const m of command.matchAll(ENV_IN_COMMAND)) if (!ENV_TEMPLATE.test(m[1]!)) return true;
  return false;
}
/** `NAME=value` in a `.env` file, as read (`  12→API=…` from Claude's Read) or written (`export API=…`). */
const ENV_LINE = /^(\s*(?:\d+(?:→|\t))?\s*(?:export\s+)?)([A-Za-z_][\w.-]*)(\s*=\s*)(\S.*)$/gm;

export interface SessionFile {
  id: string;
  path: string;
  /** Last written, ms. */
  mtime: number;
  size: number;
}

/** This folder's Claude Code sessions (or the nearest folder above's), newest first. */
export function sessionsHere(dir: string, home?: string): SessionFile[] {
  const folder = sessionProjectDir(dir, home);
  if (!folder) return [];
  let names: string[];
  try {
    names = readdirSync(folder).filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  } catch {
    return [];
  }
  const out: SessionFile[] = [];
  for (const name of names) {
    try {
      const st = statSync(join(folder, name));
      if (st.isFile() && st.size > 0) out.push({ id: name.slice(0, -".jsonl".length), path: join(folder, name), mtime: st.mtimeMs, size: st.size });
    } catch {
      // gone while listing
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The session `pick` names: its number in the list (1 = newest), or its id or the start of it. */
export function pickSession(sessions: SessionFile[], pick: string | undefined): SessionFile | null {
  const p = (pick ?? "").trim();
  if (!p) return sessions[0] ?? null;
  if (/^\d{1,3}$/.test(p)) return sessions[Number(p) - 1] ?? null;
  const hits = p.length >= 4 ? sessions.filter((s) => s.id.startsWith(p)) : [];
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * What a session is called, for a list: the title Claude gave it (its last
 * `custom-title` line, which Claude Code appends as it goes, or the Desktop
 * app's `custom-title.json`), else the first thing typed into it. Reads the
 * file's two ends only.
 */
export function quickTitle(s: SessionFile): string {
  for (const line of readSpan(s, Math.max(0, s.size - HEAD_BYTES)).split("\n").reverse()) {
    if (!line.includes('"custom-title"')) continue;
    try {
      const t = (JSON.parse(line) as { customTitle?: unknown }).customTitle;
      if (typeof t === "string" && t.trim()) return flatLine(t, 80);
    } catch {
      // the first line read can be cut short
    }
  }
  return savedTitle(s) || firstPrompt(readSpan(s, 0).split("\n"));
}

/** Up to HEAD_BYTES of the file from `from`. */
function readSpan(s: SessionFile, from: number): string {
  const buf = Buffer.alloc(Math.min(s.size - from, HEAD_BYTES));
  let fd: number | null = null;
  try {
    fd = openSync(s.path, "r");
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function savedTitle(s: SessionFile): string {
  try {
    const t = JSON.parse(readFileSync(join(s.path.slice(0, -".jsonl".length), "custom-title.json"), "utf8")) as { customTitle?: unknown };
    return typeof t.customTitle === "string" ? flatLine(t.customTitle, 80) : "";
  } catch {
    return "";
  }
}

function firstPrompt(lines: string[]): string {
  for (const line of lines) {
    if (!line.includes('"user"')) continue;
    try {
      const said = typedText(JSON.parse(line));
      if (said) return flatLine(said, 80);
    } catch {
      // a line cut short
    }
  }
  return "";
}

export interface Bundle {
  session: SessionFile;
  title: string;
  /** Messages, the person's and Claude's, tool calls and results included, across the session and its subagents. */
  messages: number;
  subagents: number;
  /** When the session started and was last written, ISO, when its lines say. */
  startedAt?: string;
  endedAt?: string;
  /** The redacted JSONL, before zipping. */
  bytes: number;
  gz: Buffer;
  /** Secrets taken out, by kind ("an API key", "a .env value"). */
  redacted: Record<string, number>;
  /** Images and other files that aren't text, left out. */
  leftOut: number;
}

export function redactedCount(b: Bundle): number {
  return Object.values(b.redacted).reduce((n, c) => n + c, 0);
}

/** The session, its subagents and its tool-result files, redacted, as one zipped JSONL. */
export function bundleSession(session: SessionFile): Bundle {
  const own = session.path.slice(0, -".jsonl".length);
  const files = [session.path, ...subagentFiles(session)];
  const raw = files.map((f) => readLines(f));
  const envIds = envToolIds(raw.flat());

  // Each secret once: Claude Code keeps a tool's output twice (the result, and `toolUseResult`).
  const taken = new Map<string, string>();
  const count = (found: Redaction[]) => {
    for (const r of found) if (!taken.has(r.what)) taken.set(r.what, r.kind);
  };
  let leftOut = 0;
  let messages = 0;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let titleLine = "";
  const seen = new Set<string>();
  const out: string[] = [];

  for (const lines of raw) {
    for (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        const r = redactText(line);
        count(r.found);
        out.push(r.text);
        continue;
      }
      const e = entry as { type?: unknown; timestamp?: unknown; customTitle?: unknown; summary?: unknown; message?: { id?: unknown } };
      if (e.type === "custom-title" && typeof e.customTitle === "string") titleLine = e.customTitle;
      else if (e.type === "summary" && typeof e.summary === "string" && !titleLine) titleLine = e.summary;
      if (e.type === "user" || e.type === "assistant") {
        // Claude Code writes one line per block of a reply; they share the message id.
        const id = typeof e.message?.id === "string" ? e.message.id : null;
        if (!id || !seen.has(id)) messages++;
        if (id) seen.add(id);
      }
      if (typeof e.timestamp === "string") {
        startedAt ??= e.timestamp;
        endedAt = e.timestamp;
      }
      const env = touchesEnv(entry, envIds);
      const clean = walk(entry, (s) => {
        let text = s;
        if (env) {
          text = text.replace(ENV_LINE, (whole, lead: string, name: string, eq: string, value: string) => {
            if (value.startsWith(REDACTED)) return whole;
            count([{ kind: "a .env value", what: `${name}=${value}` }]);
            return `${lead}${name}${eq}${REDACTED}`;
          });
        }
        const r = redactText(text);
        count(r.found);
        return r.text;
      }, () => leftOut++);
      out.push(JSON.stringify(clean));
    }
  }

  for (const f of toolResultFiles(own)) {
    if (!TEXT_FILE.test(f.name) || f.size > MAX_TOOL_FILE) {
      leftOut++;
      continue;
    }
    let content: string;
    try {
      content = readFileSync(f.path, "utf8");
    } catch {
      continue;
    }
    const r = redactText(content);
    count(r.found);
    out.push(JSON.stringify({ type: "trail-share-file", sessionId: session.id, path: `tool-results/${f.name}`, content: r.text }));
  }

  const redacted: Record<string, number> = {};
  for (const kind of taken.values()) redacted[kind] = (redacted[kind] ?? 0) + 1;
  const title = redactText(flatLine(titleLine, 80) || savedTitle(session) || firstPrompt(raw[0] ?? [])).text;
  const text = `${out.join("\n")}\n`;
  return {
    session,
    title,
    messages,
    subagents: files.length - 1,
    startedAt,
    endedAt,
    bytes: Buffer.byteLength(text),
    gz: gzipSync(text),
    redacted,
    leftOut,
  };
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

/** The session's subagent transcripts: `<id>/subagents/*.jsonl`, and older Claude Code's `agent-*.jsonl` beside it that name the session. */
function subagentFiles(s: SessionFile): string[] {
  const own = join(s.path.slice(0, -".jsonl".length), "subagents");
  const out: string[] = [];
  try {
    for (const f of readdirSync(own).sort()) if (f.endsWith(".jsonl")) out.push(join(own, f));
  } catch {
    // no subagents
  }
  const folder = join(s.path, "..");
  try {
    for (const f of readdirSync(folder).sort()) {
      if (!f.startsWith("agent-") || !f.endsWith(".jsonl")) continue;
      const first = readLines(join(folder, f))[0];
      if (first && (JSON.parse(first) as { sessionId?: unknown }).sessionId === s.id) out.push(join(folder, f));
    }
  } catch {
    // unreadable, or a first line cut short
  }
  return out;
}

function toolResultFiles(own: string): Array<{ name: string; path: string; size: number }> {
  const dir = join(own, "tool-results");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .sort()
      .map((name) => ({ name, path: join(dir, name), size: statSync(join(dir, name)).size }));
  } catch {
    return [];
  }
}

type Block = { type?: unknown; id?: unknown; name?: unknown; input?: Record<string, unknown> | null; tool_use_id?: unknown };

function blocks(entry: unknown): Block[] {
  const content = (entry as { message?: { content?: unknown } } | null)?.message?.content;
  return Array.isArray(content) ? (content as Block[]).filter((b) => b && typeof b === "object") : [];
}

/** The tool calls that read or wrote a `.env` file: a file tool on one, or a shell command naming one. */
function envToolIds(lines: string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    if (!line.includes(".env") && !line.includes("env\"")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const b of blocks(entry)) {
      if (b.type !== "tool_use" || typeof b.id !== "string") continue;
      const input = b.input ?? {};
      const file = [input.file_path, input.notebook_path, input.path].find((v): v is string => typeof v === "string");
      const command = typeof input.command === "string" ? input.command : "";
      if ((file && ENV_FILE.test(file) && !ENV_TEMPLATE.test(file)) || (command && readsEnv(command))) ids.add(b.id);
    }
  }
  return ids;
}

/** Whether this line is one of those calls, or its result. */
function touchesEnv(entry: unknown, ids: Set<string>): boolean {
  if (!ids.size) return false;
  return blocks(entry).some((b) => (b.type === "tool_use" && ids.has(b.id as string)) || (b.type === "tool_result" && ids.has(b.tool_use_id as string)));
}

/** A long base64 run: an image or a file's bytes, not words. */
const BASE64 = /^[A-Za-z0-9+/=\r\n]{512,}$/;

/**
 * `value` with `fix` applied to every string in it. An image's bytes are left
 * out (`dropped` counts them), and so are a thinking block's signature and a
 * redacted thinking block's data: Anthropic's own opaque bytes, with nothing
 * in them to read.
 */
function walk(value: unknown, fix: (s: string) => string, dropped: () => void, key = "", parent?: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    if ((key === "signature" && parent?.type === "thinking") || (key === "data" && parent?.type === "redacted_thinking")) return "[left out]";
    if ((key === "data" || key === "base64") && BASE64.test(value)) {
      dropped();
      return "[left out: image or file bytes]";
    }
    return fix(value);
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, fix, dropped, key, parent));
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = walk(v, fix, dropped, k, o);
    return out;
  }
  return value;
}

/** A session's id as messages show it: its first 8 characters. */
export function shortId(s: SessionFile): string {
  return s.id.slice(0, 8);
}

/** `3.1 MB`, `640 KB`. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `today 14:02`, `yesterday 09:10`, `Oct 27 18:00`, in this laptop's time. */
export function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (day(d) === day(new Date(now))) return `today ${hm}`;
  if (day(d) === day(new Date(now - 24 * 60 * 60 * 1000))) return `yesterday ${hm}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

/** The numbered list `--list` prints. */
export function listLines(sessions: SessionFile[], now = Date.now(), max = 15): string[] {
  if (!sessions.length) return ["· no Claude Code sessions for this folder yet"];
  const rows = sessions.slice(0, max).map((s, i) => ({ n: String(i + 1), when: whenLabel(s.mtime, now), title: quickTitle(s) || "(nothing typed)", size: sizeLabel(s.size) }));
  const whenWidth = Math.max(...rows.map((r) => r.when.length));
  const out = ["This folder's Claude Code sessions, newest first:"];
  for (const r of rows) out.push(`  ${r.n.padStart(2)}  ${r.when.padEnd(whenWidth)}  ${r.title}  · ${r.size}`);
  if (sessions.length > max) out.push(`  … and ${sessions.length - max} older`);
  return out;
}

/** What will be sent, for the person to say yes to. */
export function previewLines(b: Bundle, to: { workspace: string; url: string }, now = Date.now()): string[] {
  const start = b.startedAt ? Date.parse(b.startedAt) : NaN;
  const end = b.endedAt ? Date.parse(b.endedAt) : b.session.mtime;
  const when = Number.isNaN(start) ? whenLabel(end, now) : spanLabel(start, end, now);
  const n = redactedCount(b);
  const kinds = Object.entries(b.redacted)
    .sort((x, y) => y[1] - x[1])
    .map(([k, c]) => `${k.replace(/^an? /, "")} ×${c}`)
    .join(", ");
  let host = to.url;
  try {
    host = new URL(to.url).host;
  } catch {
    // keep the address as it is
  }
  const rows: Array<[string, string]> = [
    ["Session", b.title || "(nothing typed)"],
    ["", [shortId(b.session), when, `${b.messages} message${b.messages === 1 ? "" : "s"}`, ...(b.subagents ? [`${b.subagents} subagent${b.subagents === 1 ? "" : "s"}`] : [])].join(" · ")],
    ["Size", `${sizeLabel(b.bytes)}, ${sizeLabel(b.gz.length)} zipped`],
    ["Secrets", n ? `${n} redacted: ${kinds}` : "none found"],
    ...(b.leftOut ? [["Left out", `${b.leftOut} image${b.leftOut === 1 ? "" : "s"} and other files that aren't text`] as [string, string]] : []),
    ["Goes to", `${to.workspace} on ${host}, read only by the Trail team`],
  ];
  return rows.map(([k, v]) => `${k.padEnd(10)}${v}`);
}

function spanLabel(start: number, end: number, now: number): string {
  const a = whenLabel(start, now);
  const b = whenLabel(end, now);
  const [aDay, bDay] = [a.slice(0, a.lastIndexOf(" ")), b.slice(0, b.lastIndexOf(" "))];
  return aDay === bDay ? `${a}–${b.slice(b.lastIndexOf(" ") + 1)}` : `${a} – ${b}`;
}
