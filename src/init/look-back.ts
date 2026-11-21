/**
 * What stays of phase 0's look-back (design 0 rule 1, R60, D87): the quote
 * checks (a finding's quotes really typed, on two different days, not one
 * sitting), the secret filter, and whether `trail init` looks back here.
 *
 * Phase 0's find call, which sent up to 320k characters of the person's
 * typed messages to the model, is gone for everyone, skills on or off: the
 * no-model look-back (look-back-mine.ts) finds preferences itself, and the
 * only model call left is the naming call over skills (name-call.ts).
 */
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { ensureRepoHome } from "../notes/home.js";
import type { PastSession } from "./sessions.js";
import { dayOf } from "./transcript.js";
import { secretReason } from "../notes/secrets.js";

export interface Finding {
  title: string;
  /** `team`: about the code or how the team works here. `you`: this person's own habits or machine. */
  for: "team" | "you";
  /** Markdown under `## Decided` and maybe `## Watch out`, secrets scrubbed. */
  body: string;
  /** Sessions the cited quotes were found in, newest first. */
  sessions: string[];
  /** Different days the cited quotes were typed on: a restart the same morning is not a second time. */
  days: number;
  /** YYYY-MM-DD of the newest of them. */
  last: string;
  quotes: string[];
  /** A quote matched typed words that hold a secret, though the quote as Claude copied it (punctuation and case set aside) doesn't show it. */
  secret?: true;
}

/** The default model for init's Claude Code calls. */
export const COLD_START_MODEL = "claude-sonnet-5-5";

export function claudeInitModel(env: NodeJS.ProcessEnv): string {
  return env.TRAIL_INIT_MODEL?.trim() || COLD_START_MODEL;
}

/** Telemetry carries fixed labels, even when a relay supplies its own model name. */
export function initModelLabel(model: string): string {
  return model === "none" || model === COLD_START_MODEL ? model : "custom";
}

interface RawFinding {
  title?: string;
  for?: string;
  body?: string;
  evidence?: { session?: string; quote?: string }[];
}

/* -------------------------------------------------------------------------- */
/* Keeping only what's really there                                           */
/* -------------------------------------------------------------------------- */

export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”"'`‘’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Where a finding's quotes can be: one past session's messages, or one PR's review comments. */
export interface QuoteSource {
  id: string;
  /** ISO time, for newest first. */
  at: string;
  /** What was said there, each through norm(). */
  said: string[];
}

/**
 * The sources a finding's quotes really are in, newest first, and the quotes
 * that were found. A quote filed under the wrong source still counts for the
 * one it's in; a quote under three words proves nothing.
 */
export function placeQuotes(evidence: { cited?: QuoteSource; quote?: string }[], sources: QuoteSource[]): { places: QuoteSource[]; quotes: string[] } {
  const found = new Map<string, QuoteSource>();
  const quotes: string[] = [];
  const cited = evidence
    .map((ev, order) => {
      const q = norm(ev.quote ?? "");
      const has = (x: QuoteSource) => x.said.some((w) => w.includes(q));
      return { ev, order, has, in: q.split(" ").length < 3 ? [] : sources.filter(has) };
    })
    .filter((c) => c.in.length);
  // The quote that fits fewest sources picks first, so a looser one can still count somewhere else.
  for (const c of [...cited].sort((a, b) => a.in.length - b.in.length || a.order - b.order)) {
    // Misfiled: the source it's really in, one not counted yet when there is one.
    const hit = c.ev.cited && c.has(c.ev.cited) ? c.ev.cited : (c.in.find((x) => !found.has(x.id)) ?? c.in[0]!);
    found.set(hit.id, hit);
  }
  for (const c of cited) quotes.push(c.ev.quote!.trim());
  return { places: [...found.values()].sort((a, b) => b.at.localeCompare(a.at)), quotes };
}

/**
 * The findings whose quotes are really in the person's messages, in two or
 * more sessions, best first. A quote filed under the wrong session still
 * counts for the session it's in.
 */
export function verify(raw: RawFinding[], sessions: PastSession[], _ids?: Map<string, string>): Finding[] {
  // One place per session per day, so a quote counts once a day: restarts don't add up, a long session's days do.
  const sources: (QuoteSource & Typed & { session: string; day: string })[] = [];
  for (const s of sessions) {
    const byDay = new Map<string, Typed & { said: string[] }>();
    for (const p of s.prompts) {
      const day = dayOf(p.at) || dayOf(s.at) || `session ${s.id}`;
      const place = byDay.get(day) ?? { said: [], times: [], raw: [] };
      place.said.push(norm(p.text));
      place.times.push(Date.parse(p.at ?? s.at));
      place.raw.push(p.text);
      byDay.set(day, place);
    }
    for (const [day, place] of byDay) sources.push({ id: `${s.id} ${day}`, at: day, ...place, session: s.id, day });
  }
  const out: Finding[] = [];
  for (const f of raw) {
    const title = f.title?.trim();
    const body = f.body?.trim();
    if (!title || !body) continue;
    // Where a quote really is decides, wherever the model filed it.
    const evidence = (f.evidence ?? []).map((ev) => ({ quote: ev.quote }));
    const { places, quotes } = placeQuotes(evidence, sources);
    const placed = places as (typeof sources)[number][];
    const days = new Set(placed.map((p) => p.day));
    const typed = typedFor(placed, quotes.map(norm));
    if (days.size < 2 || oneSitting(typed.map((t) => t.time))) continue;
    out.push({
      title: noEmails(title).slice(0, 80),
      for: f.for === "you" ? "you" : "team",
      body: noEmails(body),
      sessions: [...new Set(placed.map((p) => p.session))],
      days: days.size,
      last: places[0]!.at.slice(0, 10),
      quotes,
      ...(typed.some((t) => secretReason(t.text) !== null) ? { secret: true as const } : {}),
    });
  }
  return out.sort((a, b) => b.days - a.days || b.last.localeCompare(a.last));
}

/** Two dates closer than this are one sitting that crossed midnight, not two days. */
const SITTING_MS = 8 * 60 * 60 * 1000;

/** What each typed message in a place was, as written, and when. */
interface Typed {
  times: number[];
  raw: string[];
}

/** The typed messages in `places` that hold one of the (normalised) quotes. */
function typedFor(places: (Typed & { said: string[] })[], quotes: string[]): { text: string; time: number }[] {
  const out: { text: string; time: number }[] = [];
  for (const p of places) p.said.forEach((w, i) => quotes.some((q) => q && w.includes(q)) && out.push({ text: p.raw[i]!, time: p.times[i]! }));
  return out;
}

/** Whether every time the quotes were typed falls within one sitting (a restart at 11:55 pm and 12:05 am). Unknown times don't decide. */
function oneSitting(times: number[]): boolean {
  if (times.length < 2 || times.some((t) => !Number.isFinite(t))) return false;
  return Math.max(...times) - Math.min(...times) < SITTING_MS;
}

/** Email addresses replaced: a learning can be committed, and an address is nobody's business there. */
export function noEmails(text: string): string {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}

/**
 * The findings with no secret in their title, body or quotes (or in the typed
 * words a quote was found in), and how many were left out for one. A finding with a secret is refused whole, never
 * scrubbed and kept: a missed shape in a committed file is the worst case.
 */
export function withoutSecrets<T extends { title: string; body: string; quotes: string[]; secret?: true }>(findings: T[]): { findings: T[]; leftOut: number } {
  const kept = findings.filter((f) => !f.secret && ![f.title, f.body, ...f.quotes].some((t) => secretReason(t) !== null));
  return { findings: kept, leftOut: findings.length - kept.length };
}

/** Anything that looks like a credential, a key or an email address, replaced. Learnings get committed. */
export function scrub(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]")
    // A key with no end marker (cut off, or pasted in part): everything after its start.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[redacted]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[:=]\s*)\S+/g, "$1$2[redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]")
    .replace(/\b(?:mb|trl|nn)_[A-Za-z0-9]{16,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}

/* -------------------------------------------------------------------------- */
/* At trail init                                                              */
/* -------------------------------------------------------------------------- */

/** Where a repo remembers that its past sessions were read, on this machine. */
function readMark(repo: string, env: NodeJS.ProcessEnv): string {
  return join(ensureRepoHome(repo, env).place.dir, "past-sessions.json");
}

/** `TRAIL_NO_LOOK_BACK=1` turns the look-back off. (`TRAIL_NO_FETCH` doesn't: nothing here is fetched.) */
export function lookBackOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRAIL_NO_LOOK_BACK === "1";
}

/** Whether `trail init` would look back here: on, and not done on this machine before (`--look-back` looks again). */
export function lookBackDue(repo: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return !lookBackOff(env) && !readJson<{ at?: number }>(readMark(repo, env))?.at;
  } catch {
    return false;
  }
}

/** The person answered what the look-back found here (or it found nothing): plain `trail init` won't look back again. */
export function markLookedBack(repo: string, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): void {
  try {
    writeJsonAtomic(readMark(repo, env), { at: now.getTime(), v: 2 }, true);
  } catch { /* the next init looks again */ }
}
