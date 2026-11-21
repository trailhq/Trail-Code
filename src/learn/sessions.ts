/**
 * Learnings from a repo's past Claude Code sessions, for `trail init`: what
 * the person and Claude decided, ruled out, or got burned by here.
 *
 * Both sides of each conversation are read, newest first: what the person
 * typed, Claude's replies, the questions the person answered, plans, and the
 * commits and PRs made. Tool output never is (it's most of the bytes and says
 * nothing about why). To keep it cheap without losing decisions, a routine
 * reply is clipped, while the reply just before something the person said
 * (what they were answering), a reply that names a decision, and the
 * session's last reply stay whole.
 *
 * The digest goes, secrets scrubbed, to the person's own Claude Code,
 * headless, on their machine: session text never leaves it otherwise. Claude
 * answers to the shared bar (src/learn/bar.ts) and trail keeps a learning only
 * when its quotes are in the digest. A repo is read once; `--look-back` reads
 * the sessions since.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { BAR, LEARNING_SCHEMA, learningBody, sameLearning, verifyLearnings, type Learning } from "./bar.js";
import { callClaude, claudeBin, claudeInitModel, initModelLabel, norm, scrub, type ClaudeFailure, type QuoteSource } from "../notes/cold-start.js";
import { type PastSession } from "../init/sessions.js";
import { discoverOffThread } from "../init/discover-worker.js";
import { eachLine } from "../init/transcript.js";
import { typedText } from "../trace/claude.js";
import { countBucket, durationBucket } from "../telemetry/contract.js";
import { track } from "../telemetry/track.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { noteAuthor } from "../notes/git-facts.js";
import { ensureRepoHome } from "../notes/home.js";
import { shortDate, writeNote, type Note } from "../notes/notes.js";
import { alreadySaid, codeAnchors, knownText } from "../notes/team-check.js";

/** About 25k tokens: a handful of recent sessions, whole where it matters. */
const SESSION_DIGEST_CHARS = 100_000;
const TYPED_CHARS = 1_000;
const REPLY_CHARS = 700;
/** A routine reply: enough to follow the thread. */
const ROUTINE_CHARS = 240;
const ANSWER_CHARS = 400;
const PLAN_CHARS = 1_500;
const RAN_CHARS = 900;
/** A reply that says a decision, a cause or a reversal stays whole. */
const DECISION = /\b(decided|instead|ruled out|won't|wont|reverted?|rolled back|root cause|the cause|turned out|because|trade-?off|we chose|going with|dropped|not worth)\b/i;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

type Entry = { kind: "person" | "claude" | "answered" | "plan" | "ran"; text: string };

/**
 * One past session as digest lines, in order. `stretch` reads only that byte
 * range (a session started in a folder above the repo); `full` keeps every
 * reply whole, for comparing what the clipping costs.
 */
export function sessionLines(path: string, stretch?: { from: number; to: number }, opts: { full?: boolean } = {}): string[] {
  const entries: Entry[] = [];
  const asks = new Map<string, string>();
  try {
    eachLine(
      path,
      (line) => {
        if (!line.startsWith("{")) return;
        let r: { type?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } };
        try {
          r = JSON.parse(line);
        } catch {
          return;
        }
        if (r.isSidechain || r.isMeta || !r.message) return;
        const content = r.message.content;
        if (r.type === "user") {
          if (Array.isArray(content)) {
            for (const p of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
              if (p?.type !== "tool_result" || !p.tool_use_id || !asks.has(p.tool_use_id)) continue;
              const said = typeof p.content === "string" ? p.content : Array.isArray(p.content) ? (p.content as Array<{ text?: string }>).map((x) => x?.text ?? "").join(" ") : "";
              entries.push({ kind: "answered", text: `${asks.get(p.tool_use_id)} -> ${clip(oneLine(scrub(said)), ANSWER_CHARS)}` });
            }
          }
          const typed = typedText(r);
          if (typed) entries.push({ kind: "person", text: clip(oneLine(scrub(typed)), TYPED_CHARS) });
        } else if (r.type === "assistant" && Array.isArray(content)) {
          for (const p of content as Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
            if (p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 40) entries.push({ kind: "claude", text: oneLine(scrub(p.text)) });
            if (p?.type !== "tool_use") continue;
            const input = p.input ?? {};
            if (p.name === "AskUserQuestion" && p.id) {
              const qs = Array.isArray(input.questions) ? (input.questions as Array<{ question?: string }>).map((q) => q?.question ?? "").filter(Boolean) : [];
              if (qs.length) asks.set(p.id, oneLine(scrub(qs.join(" / "))));
            }
            if (p.name === "ExitPlanMode" && typeof input.plan === "string") entries.push({ kind: "plan", text: clip(oneLine(scrub(input.plan)), PLAN_CHARS) });
            const cmd = typeof input.command === "string" ? input.command : "";
            if (/\bgit commit\b|\bgh pr create\b/.test(cmd)) entries.push({ kind: "ran", text: clip(oneLine(scrub(cmd)), RAN_CHARS) });
          }
        }
      },
      stretch,
    );
  } catch {
    return [];
  }
  const lastReply = entries.map((e) => e.kind).lastIndexOf("claude");
  return entries.map((e, i) => {
    if (e.kind !== "claude") return `[${e.kind}] ${e.text}`;
    const answered = entries[i + 1]?.kind === "person";
    const whole = opts.full || i === lastReply || answered || DECISION.test(e.text);
    return `[claude] ${clip(e.text, whole ? REPLY_CHARS : ROUTINE_CHARS)}`;
  });
}

/**
 * Sessions as one text for Claude, newest first, cut at `maxChars`; each
 * headed by the id learnings cite. A newest session bigger than that keeps its
 * latest lines. `sources` hold only the lines sent, so a quote is checked
 * against what Claude saw.
 */
export function sessionsDigest(sessions: PastSession[], maxChars = SESSION_DIGEST_CHARS, opts: { full?: boolean } = {}): { text: string; sources: QuoteSource[]; read: string[] } {
  const parts: string[] = [];
  const sources: QuoteSource[] = [];
  const read: string[] = [];
  let size = 0;
  for (const s of [...sessions].sort((a, b) => b.at.localeCompare(a.at))) {
    if (!s.path) continue;
    let lines = sessionLines(s.path, s.stretch, opts).map(scrub);
    if (!lines.length) continue;
    const id = s.id.slice(0, 8);
    const head = `=== session ${id} (${s.at.slice(0, 10)}${s.branch ? `, branch ${s.branch}` : ""})`;
    let block = `${head}\n${lines.join("\n")}`;
    if (size + block.length > maxChars) {
      if (parts.length) break;
      // The newest session alone is too big: its latest lines, where the last decisions are.
      let room = maxChars - head.length - 1;
      let from = lines.length;
      while (from > 0 && room - (lines[from - 1]!.length + 1) >= 0) room -= lines[--from]!.length + 1;
      lines = lines.slice(from);
      if (!lines.length) continue;
      block = `${head}\n${lines.join("\n")}`;
    }
    parts.push(block);
    sources.push({ id, at: s.at, said: lines.map(norm) });
    read.push(id);
    size += block.length + 2;
  }
  return { text: parts.join("\n\n"), sources, read };
}

export interface SessionResult {
  /** Past sessions found in this repo. */
  sessions: number;
  /** How many of them Claude read. */
  read: number;
  findings: Learning[];
  durationMs: number;
  model: string;
  /** ISO time of the newest session found: the next read starts after it. */
  newest?: string;
  costUsd?: number;
  reason?: "no_sessions" | "no_claude" | "failed" | "none_found";
  why?: ClaudeFailure;
  said?: string;
}

/**
 * What the repo's past sessions say was decided, ruled out or got burned
 * by, checked against the digest. Never throws. `since` reads only sessions
 * after it.
 */
export async function findSessionLearnings(
  repo: string,
  opts: { env?: NodeJS.ProcessEnv; capMs?: number; since?: string; model?: string; full?: boolean; onLearning?: (l: Learning) => void } = {},
): Promise<SessionResult> {
  const env = opts.env ?? process.env;
  const model = opts.model ?? claudeInitModel(env);
  const started = Date.now();
  const left = () => (opts.capMs === undefined ? Infinity : opts.capMs - (Date.now() - started));
  const found = await pastSessions(repo, env);
  const newest = found.reduce<string | undefined>((m, s) => (!m || s.at > m ? s.at : m), undefined);
  const sessions = opts.since ? found.filter((s) => s.at > opts.since!) : found;
  const base = { sessions: sessions.length, read: 0, findings: [] as Learning[], model, ...(newest ? { newest } : {}) };
  if (!sessions.length) return { ...base, durationMs: Date.now() - started, reason: "no_sessions" };
  const bin = claudeBin(env.HOME || homedir());
  if (!bin) return { ...base, durationMs: Date.now() - started, reason: "no_claude", why: "not_installed" };
  const { text, sources, read } = sessionsDigest(sessions, SESSION_DIGEST_CHARS, { full: opts.full });
  if (!read.length) return { ...base, durationMs: Date.now() - started, reason: "no_sessions" };
  const asked = await callClaude<unknown>(
    bin,
    `Past Claude Code sessions in this repository, newest first. Lines are what the person said, what Claude said, questions the person answered, plans, and the commits and PRs made. Find the learnings.\n\n${text}`,
    model,
    Math.max(1, Math.min(180_000, left())),
    {
      system: BAR,
      schema: LEARNING_SCHEMA,
      // Each one checked against the digest the moment it's written, for init to show then.
      ...(opts.onLearning ? { onFinding: (raw: unknown) => verifyLearnings([raw], sources).forEach(opts.onLearning!) } : {}),
    },
  );
  const durationMs = Date.now() - started;
  if (!asked.ok) return { ...base, read: read.length, durationMs, reason: asked.why === "not_installed" ? "no_claude" : "failed", why: asked.why, ...(asked.said ? { said: asked.said } : {}) };
  const findings = verifyLearnings(asked.findings, sources);
  return { ...base, read: read.length, findings, durationMs, costUsd: asked.costUsd, reason: findings.length ? undefined : "none_found" };
}

/** The repo's past sessions, found in a worker so init's first lines and its spinner don't wait on the transcripts. */
async function pastSessions(repo: string, env: NodeJS.ProcessEnv): Promise<PastSession[]> {
  try {
    return (await discoverOffThread(repo, env.HOME || homedir(), env)).sessions;
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* At trail init                                                              */
/* -------------------------------------------------------------------------- */

/** Where a repo remembers its past sessions were read, on this machine. */
function readMark(repo: string): string {
  return join(ensureRepoHome(repo).place.dir, "session-learnings.json");
}

export interface SessionRead {
  started: number;
  result: Promise<SessionResult>;
  done: boolean;
}

/**
 * Start reading the repo's past sessions, for `trail init` to collect at its
 * end; null when they were read on this machine before (unless `again`,
 * which reads the sessions since), or TRAIL_NO_FETCH is set. A read that
 * finds no sessions leaves no mark, so a later init reads them.
 */
export function beginSessionRead(repo: string, env: NodeJS.ProcessEnv = process.env, opts: { capMs?: number; again?: boolean; onLearning?: (l: Learning) => void } = {}): SessionRead | null {
  try {
    if (env.TRAIL_NO_FETCH === "1") return null;
    const mark = readJson<{ at?: number; newest?: string }>(readMark(repo));
    if (mark?.at && !opts.again) return null;
    const since = mark?.at ? mark.newest : undefined;
    const read: SessionRead = { started: Date.now(), done: false, result: findSessionLearnings(repo, { env, ...(opts.capMs === undefined ? {} : { capMs: opts.capMs }), ...(since ? { since } : {}), ...(opts.onLearning ? { onLearning: opts.onLearning } : {}) }) };
    void read.result.then(() => (read.done = true));
    return read;
  } catch {
    return null;
  }
}

/**
 * The learnings fit to offer: not already said in CLAUDE.md, AGENTS.md or a
 * learning (`also`: ones offered beside them, like the PR read's), each with
 * the code it names that exists now as `touches`.
 */
export function offeredSessions(repo: string, findings: Learning[], also: Array<{ title: string; body: string }> = []): Array<Learning & { touches: string[] }> {
  const known = knownText(repo);
  const out: Array<Learning & { touches: string[] }> = [];
  for (const l of findings) {
    const body = learningBody(l, "");
    if (alreadySaid(known, l.headline, body) || also.some((a) => sameLearning(a.title, l.headline, a.body, body))) continue;
    out.push({ ...l, touches: codeAnchors(repo, `${l.headline}\n${body}`) });
  }
  return out;
}

/** Each learning as the team's, in `.trail/learnings/`. */
export function saveSessionLearnings(repo: string, findings: Array<Learning & { touches?: string[] }>, author = noteAuthor(repo), date = new Date().toISOString().slice(0, 10)): Note[] {
  return findings.map((l) =>
    writeNote(
      repo,
      { title: l.headline, author, date, body: learningBody(l, `_From past Claude sessions here, ${shortDate(l.last)}._`), touches: l.touches ?? [], standing: true, src: "init-sessions" },
      "repo",
    ),
  );
}

/**
 * Wait for the read, save the learnings the person keeps (all, unless `keep`
 * picks), and remember the sessions were read. `keep` resolving null means
 * they cancelled: nothing is saved and the next init asks again. `also`:
 * headlines offered beside these, so the same learning isn't saved twice.
 */
export async function finishSessionRead(
  repo: string,
  read: SessionRead,
  keep?: (findings: Array<Learning & { touches: string[] }>) => Promise<Array<Learning & { touches: string[] }> | null>,
  also: Array<{ title: string; body: string }> = [],
): Promise<{ result: SessionResult; saved: Note[]; kept: Learning[]; offered: number; cancelled: boolean }> {
  const result = await read.result;
  const offered = offeredSessions(repo, result.findings, also);
  const chosen = offered.length && keep ? await keep(offered) : offered;
  const kept = chosen ?? [];
  const saved = kept.length ? saveSessionLearnings(repo, kept) : [];
  const outcome = chosen === null ? "cancelled" : offered.length ? "found" : (result.reason ?? "none_found");
  if (chosen !== null && result.reason !== "no_claude" && result.reason !== "failed" && result.reason !== "no_sessions")
    writeJsonAtomic(readMark(repo), { at: Date.now(), model: result.model, saved: saved.length, ms: result.durationMs, ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }), ...(result.newest ? { newest: result.newest } : {}) }, true);
  track(
    "cold_start",
    {
      source: "sessions_read",
      outcome,
      sessions_bucket: countBucket(result.sessions),
      offered_bucket: countBucket(offered.length),
      picked_bucket: countBucket(saved.length),
      duration_bucket: durationBucket(result.durationMs),
      model: initModelLabel(result.model),
    },
    { repo },
  );
  return { result, saved, kept, offered: offered.length, cancelled: chosen === null };
}
