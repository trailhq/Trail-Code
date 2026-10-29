/**
 * What the current agent session spent working something out, for a note's
 * cost line: active minutes, and tokens.
 *
 * Read from Claude Code's own transcript, which it keeps as JSONL under
 * `~/.claude/projects/<the repo path, every other character as "-">/`, one
 * file per session. The one being written right now is the newest. Other
 * agents keep no transcript we can read, so their notes carry no cost unless
 * the agent passes `--minutes` / `--tokens`.
 *
 * Counted from the session's last finished `trail note` (or its start), so two
 * notes from one long session don't both claim the same work. Within that,
 * from the turn where the work the note names first came up: the first prompt
 * or tool call that mentions one of its files, symbols or commands. A long
 * session that did other things first (a Slack search, a merge) doesn't charge
 * them to this learning. When nothing matches, only the last 30 active
 * minutes count, never the whole stretch. Tokens are the
 * ones the model actually processed fresh: input, cache writes and output.
 * Cache reads are left out, since they re-read the same context every turn and
 * would make an hour's work look like millions. Minutes are active minutes: a
 * gap of more than ten minutes between two entries counts as nothing, so a
 * session left open over lunch doesn't claim the lunch.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SessionCost {
  minutes: number;
  tokens: number;
  /** When the stretch since the last note began, epoch ms. */
  startedAt: number;
  /** When the counted work began, epoch ms: the first mention of what the note is about. */
  countedFrom: number;
  /** Files the agent edited or wrote in that stretch, absolute, in order. */
  edited: string[];
  /** Files the agent opened with Read in that stretch, absolute, in order. */
  read: string[];
}

const IDLE_MS = 10 * 60 * 1000;
/** With nothing in the transcript naming what the note is about, at most this much active time counts. */
export const FALLBACK_ACTIVE_MS = 30 * 60 * 1000;
/** A transcript untouched this long belongs to some earlier session. */
const ACTIVE_MS = 30 * 60 * 1000;

export function claudeProjectDir(repo: string, home: string = homedir()): string {
  return join(home, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
}

/**
 * The project folder of the session that `dir` is part of: `dir`'s own, or
 * the nearest ancestor's. A note saved from a subfolder, or from one repo of
 * a session started in the folder above several, still finds its session.
 */
export function sessionProjectDir(dir: string, home?: string): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const p = claudeProjectDir(d, home);
    if (existsSync(p)) return p;
    if (dirname(d) === d) return null;
  }
}

/** The transcript of the session running in `repo` now, or null. */
export function currentTranscript(repo: string, home?: string, now = Date.now()): string | null {
  const dir = sessionProjectDir(repo, home);
  if (!dir) return null;
  let best: { path: string; mtime: number } | null = null;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const mtime = statSync(join(dir, f)).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: join(dir, f), mtime };
    } catch {
      /* gone */
    }
  }
  return best && now - best.mtime <= ACTIVE_MS ? best.path : null;
}

interface Entry {
  type?: string;
  timestamp?: string;
  message?: {
    id?: string;
    usage?: { input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
    content?: unknown;
  };
}

function blocks(e: Entry): Array<Record<string, unknown>> {
  const c = e.message?.content;
  return Array.isArray(c) ? (c as Array<Record<string, unknown>>) : [];
}

/** Claude Code's tools that change a file, each naming it in `file_path` (`notebook_path` for notebooks). */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export const NOTE_CALL = /(^|[|&;]\s*|\s)(npx\s+(-y\s+)?(@trailhq\/|@nanonets\/)?)?(trail|graft)\s+note\b/;

/** Words too common to say what a note is about: they'd match the first turn of any session. */
const TOO_COMMON = new Set(["trail", "graft", "claude", "true", "false", "null", "main", "master", "node", "git", "npm", "test", "tests"]);

/**
 * What a note is about, as strings a transcript would show when that work
 * began: the files it names (path and file name) and anything it puts in
 * backticks, such as a symbol, a command or a setting.
 */
export function aboutTerms(body: string, files: string[] = []): string[] {
  const terms = new Set<string>();
  for (const f of files) {
    const path = f.split("#")[0]!.trim();
    if (!path) continue;
    terms.add(path);
    const name = path.split("/").pop()!;
    if (name.length >= 4) terms.add(name);
  }
  for (const m of body.matchAll(/`([^`\n]{3,80})`/g)) {
    const t = m[1]!.trim().replace(/\(\)$/, "");
    if (t.length >= 4 && !TOO_COMMON.has(t.toLowerCase()) && specific(t)) terms.add(t);
  }
  return [...terms];
}

/**
 * Whether a backticked term names something specific enough to date the work:
 * a path or file (`a/b`, `x.ts`), or an identifier (`dropHtmlComments`,
 * `repo_id`, `check-ignore`). A phrase or a plain word (`trail init`,
 * `publish`) comes up in any session about the product, so it would date
 * the work to the session's first turn.
 */
function specific(t: string): boolean {
  if (/\s/.test(t)) return false;
  return /[\/._]|[a-z][A-Z]|\w-\w/.test(t);
}

/** A prompt the person typed, as opposed to a tool's result coming back. */
function promptText(e: Entry): string | null {
  if (e.type !== "user") return null;
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.some((b) => (b as { type?: string }).type === "tool_result")) return null;
  const text = c.filter((b) => (b as { type?: string }).type === "text").map((b) => String((b as { text?: unknown }).text ?? "")).join("\n");
  return text || null;
}

/**
 * Index into `entries` where the work on a note began: the prompt of the turn
 * whose prompt or tool calls first mention one of `terms`, never earlier than
 * `from`. A `trail note` call doesn't count: the one being saved names them all.
 */
function firstMention(entries: Entry[], from: number, terms: string[]): number | null {
  if (!terms.length) return null;
  let turn = from;
  for (let i = from; i < entries.length; i++) {
    const e = entries[i]!;
    const prompt = promptText(e);
    if (prompt !== null) turn = i;
    const said = [prompt ?? ""];
    for (const b of blocks(e)) {
      if (b.type !== "tool_use") continue;
      const input = JSON.stringify(b.input ?? {});
      if (NOTE_CALL.test(input)) continue;
      said.push(input);
    }
    if (said.some((s) => s && terms.some((t) => s.includes(t)))) return turn;
  }
  return null;
}

/**
 * The cost of one transcript since its last finished note. Pure, for tests:
 * `text` is the JSONL, `now` closes the last stretch when the transcript ends
 * mid-turn (it always does: the note call itself is in flight). `terms` are
 * what the note is about (see `aboutTerms`); without them the whole stretch
 * since the last note counts, as before.
 */
export function costFromTranscript(text: string, now = Date.now(), terms?: string[]): SessionCost | null {
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      /* a half-written last line */
    }
  }
  // A note call is finished once its tool_result is in the transcript; the
  // call that is running right now has none yet, so it never counts as the
  // boundary.
  const noteCalls = new Set<string>();
  let boundary = -1;
  entries.forEach((e, i) => {
    for (const b of blocks(e)) {
      if (b.type === "tool_use" && typeof b.id === "string") {
        const cmd = (b.input as { command?: unknown } | undefined)?.command;
        if (typeof cmd === "string" && NOTE_CALL.test(cmd)) noteCalls.add(b.id);
      }
      if (b.type === "tool_result" && typeof b.tool_use_id === "string" && noteCalls.has(b.tool_use_id)) boundary = i;
    }
  });

  const after = entries.slice(boundary + 1);
  const since = after.filter((e) => e.timestamp && Number.isFinite(Date.parse(e.timestamp)));
  if (since.length === 0) return null;
  const startedAt = Date.parse(since[0]!.timestamp!);

  // Where this note's work began within the stretch.
  let counted = since;
  if (terms) {
    const at = firstMention(entries, boundary + 1, terms);
    const stretch = new Set(since);
    counted = at !== null ? entries.slice(at).filter((e) => stretch.has(e)) : lastActive(since, now, FALLBACK_ACTIVE_MS);
    if (counted.length === 0) counted = since.slice(-1);
  }
  const times = counted.map((e) => Date.parse(e.timestamp!));
  times.push(now);
  let activeMs = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    if (gap > 0 && gap <= IDLE_MS) activeMs += gap;
  }

  // Claude Code writes one line per content block, each repeating its
  // message's usage, so a message is counted once by its id.
  const seen = new Set<string>();
  let tokens = 0;
  for (const e of counted) {
    if (e.type !== "assistant" || !e.message?.usage) continue;
    const id = e.message.id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const u = e.message.usage;
    tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
  }
  const edited: string[] = [];
  const read: string[] = [];
  for (const e of after) {
    for (const b of blocks(e)) {
      if (b.type !== "tool_use") continue;
      const input = (b.input ?? {}) as { file_path?: unknown; notebook_path?: unknown };
      const file = typeof input.file_path === "string" ? input.file_path : input.notebook_path;
      if (typeof file !== "string" || !file) continue;
      if (EDIT_TOOLS.has(String(b.name)) && !edited.includes(file)) edited.push(file);
      else if (b.name === "Read" && !read.includes(file)) read.push(file);
    }
  }
  return { minutes: Math.max(1, Math.round(activeMs / 60_000)), tokens, startedAt, countedFrom: times[0]!, edited, read };
}

/** The entries in the last `budgetMs` of active time before `now`, oldest first. */
function lastActive(entries: Entry[], now: number, budgetMs: number): Entry[] {
  let used = 0;
  let prev = now;
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = Date.parse(entries[i]!.timestamp!);
    const gap = prev - t;
    if (gap > 0 && gap <= IDLE_MS) used += gap;
    if (used > budgetMs) return entries.slice(i + 1);
    prev = t;
  }
  return entries;
}

/** The running session's cost in `repo`, or null when there is no transcript to read. */
export function currentSessionCost(repo: string, home?: string, now = Date.now(), terms?: string[]): SessionCost | null {
  const path = currentTranscript(repo, home, now);
  if (!path) return null;
  try {
    return costFromTranscript(readFileSync(path, "utf8"), now, terms);
  } catch {
    return null;
  }
}
