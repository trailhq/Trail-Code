/**
 * Did the agent actually TELL the user what graft saved?
 *
 * `savedTokens` (state.ts) counts what graft *computed* — every
 * `[graft] tokens saved ≈ N` footer the PostToolUse accumulator swept up. That
 * number is real whether or not anyone sees it. This module measures the other
 * half: whether the reply the user read closed with the one-line tally that
 * SKILL.md and `savingsTurnNudge` (context/savings.ts) both ask for. A turn
 * that saved 20k tokens in silence is a turn where the product did its job and
 * got no credit for it, and the two are indistinguishable in the numbers we
 * ship today.
 *
 * The assistant's own prose exists in exactly one place a hook can reach: the
 * host's transcript JSONL, named on the Stop hook's stdin as `transcript_path`.
 * So this reads that file — locally, at turn end, for a boolean. Nothing out of
 * it is stored or sent; the session keeps a count and the telemetry contract
 * carries that count as a bucket. See TELEMETRY.md.
 *
 * Only the tail is read. A transcript grows for the life of a session and can
 * reach many megabytes, while the answer is always in its last few entries — a
 * hook that read the whole file would get slower every turn for no extra signal.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { turnInputCostMicros, turnInputTokens } from '../context/price.js';

/**
 * How much of the transcript's end to read. Comfortably larger than any single
 * turn's worth of entries, small enough that the read cost is flat as the
 * session grows.
 */
const TAIL_BYTES = 1024 * 1024;

/**
 * The tally, as the agent is actually asked to write it: a "graft saved ~N
 * tokens" claim in prose. Deliberately loose about the decoration around it —
 * the 🌱, the "this turn", the "(3 calls)" suffix and the thousands separator
 * are all optional in practice, and a metric that only counted the one exact
 * phrasing from the example would measure the agent's formatting rather than
 * whether the user was told. Anchored on "graft saved" + a number + "tokens" so
 * ordinary prose about graft can't trip it.
 */
const TALLY = /(?:graft|trail)\s+saved\s*[~≈]?\s*[\d,.]+\s*[km]?\s*(?:tok|tokens)/i;

/** Did this reply tell the user what graft saved? */
export function hasSavingsTally(text: string): boolean {
  return TALLY.test(text);
}

/** One turn's worth of assistant prose, plus the id of the entry it ended on. */
export interface AssistantTurn {
  /** `uuid` of the last assistant entry, so the same reply is never counted twice. */
  uuid: string;
  /** Every text block the agent emitted since the last user prompt, joined. */
  text: string;
}

/** What the last turn's input tokens cost, alongside how many there were. The
 * pair is what a blended rate is made of; neither half means much alone. */
export interface TurnBilling {
  /** `uuid` of the last assistant entry, so a repeated Stop can't bill a turn twice. */
  uuid: string;
  /** Micro-dollars this turn's input tokens cost, cache multipliers applied. */
  costMicros: number;
  /** Input tokens billed this turn, cached and fresh alike. */
  tokens: number;
}

/** Read the last {@link TAIL_BYTES} of a file as utf8, dropping the leading
 * partial line a byte-offset read leaves behind. Returns '' on any I/O trouble —
 * a hook never fails over a metric. */
function readTail(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, size - len);
    const raw = buf.toString('utf8');
    return len < size ? raw.slice(raw.indexOf('\n') + 1) : raw;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/** Is this entry a user's own prompt, rather than a tool result wearing the
 * `user` role? Tool results carry a `tool_result` part; a real prompt does not.
 * The boundary matters because the tally can land in any text block of the turn,
 * not only the last one. */
function isUserPrompt(entry: any): boolean {
  if (entry?.type !== 'user' || entry?.isMeta) return false;
  const content = entry?.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && !content.some((p: any) => p?.type === 'tool_result');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p: any) => (p?.type === 'text' ? String(p.text ?? '') : '')).join('\n');
}

/**
 * The assistant prose of the turn the transcript ends on, or null when it can't
 * be read (no path — a host whose Stop hook doesn't name one — unreadable file,
 * or a tail with no assistant text in it).
 *
 * Null is meaningfully different from "no tally found": a turn we cannot observe
 * is left out of BOTH the numerator and the denominator by the caller, so a host
 * that exposes no transcript reports no ratio rather than a ratio of zero.
 *
 * Sidechain entries (subagents) are skipped throughout — a subagent's own prose
 * is never what the user read.
 */
export function lastAssistantTurn(transcriptPath: unknown): AssistantTurn | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const tail = readTail(transcriptPath);
  if (!tail) return null;

  const entries: any[] = [];
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* clipped or partial line */ }
  }

  // Walk back to the turn boundary, collecting assistant text on the way.
  const parts: string[] = [];
  let uuid: string | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.isSidechain) continue;
    if (isUserPrompt(e)) break;
    if (e?.type !== 'assistant') continue;
    const text = textOf(e?.message?.content);
    if (!text.trim()) continue;
    if (uuid === null && typeof e?.uuid === 'string') uuid = e.uuid;
    parts.unshift(text);
  }
  if (uuid === null || parts.length === 0) return null;
  return { uuid, text: parts.join('\n') };
}

/**
 * What the turn the transcript ends on cost in input tokens — the measured
 * half of the dollar figure the statusline and the turn nudge report.
 *
 * Costed per API response, not per turn, so a turn that switched models is
 * priced correctly rather than labelled with whichever model happened to go
 * last. Responses are deduped by `message.id`: one response is written to the
 * transcript as several entries (a `thinking` block and a `tool_use` block land
 * on their own lines) and every one of them repeats the same `usage`, so
 * summing the lines would bill the turn two or three times over.
 *
 * Null when there is nothing to bill — no transcript path (a host whose Stop
 * hook names none), an unreadable file, a turn whose entries carry no `usage`,
 * or a model with no price in {@link inputUsdPerMtok}. As everywhere in this
 * file, null means "not observed", never "zero".
 */
export function lastTurnBilling(transcriptPath: unknown): TurnBilling | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const tail = readTail(transcriptPath);
  if (!tail) return null;

  const entries: any[] = [];
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* clipped or partial line */ }
  }

  const seen = new Set<string>();
  let uuid: string | null = null;
  let costMicros = 0;
  let tokens = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.isSidechain) continue;
    if (isUserPrompt(e)) break;
    if (e?.type !== 'assistant') continue;
    if (uuid === null && typeof e?.uuid === 'string') uuid = e.uuid;
    const msg = e?.message;
    const id = msg?.id;
    if (typeof id !== 'string' || seen.has(id)) continue;
    const usage = msg?.usage;
    if (!usage) continue;
    seen.add(id);
    const turn = {
      model: String(msg?.model ?? ''),
      input: Number(usage.input_tokens) || 0,
      cacheCreate: Number(usage.cache_creation_input_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
    };
    const micros = turnInputCostMicros(turn);
    // An unpriced model contributes neither cost nor tokens: leaving its tokens
    // in the denominator alone would drag the blended rate toward zero and
    // quietly under-report every saving after it.
    if (micros === null) continue;
    costMicros += micros;
    tokens += turnInputTokens(turn);
  }
  if (uuid === null || tokens === 0) return null;
  return { uuid, costMicros, tokens };
}
