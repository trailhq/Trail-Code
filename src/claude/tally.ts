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
 * Only what the transcript gained since the last Stop is read (a transcript
 * grows for the life of a session; a real one passed 233 MB), through the
 * trace layer's cursor, and what has to outlive one read (the reply in
 * progress, the responses already billed) rides in that cursor's memo.
 */
import { readNewEvents, isTypedByPerson, textOf } from '../trace/claude.js';
import type { Memo } from '../trace/cursor.js';
import { readJson } from '../util/state.js';
import { turnInputCostMicros, turnInputTokens } from '../context/price.js';

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

/** The reply since the person's last prompt, as far as the transcript has it. */
export interface OpenTurn {
  /** `uuid` of its last assistant entry with text, so the same reply is never counted twice; null before any. */
  uuid: string | null;
  /** Whether any of its text carried the tally (it can land in any block, not only the last). */
  tally: boolean;
  /** Whether it called a tool that puts a question to the person as buttons answered by a new message (an `ask`, as the Claude app's next-step box takes): the learning vote then counts only an answer about helping. */
  asks?: boolean;
}

/** What one read of the transcript brought. */
export interface TranscriptCatchUp {
  /** Something was read: false for an unreadable file or nothing appended since the last read. */
  fresh: boolean;
  /** What the input tokens of each main-thread response first seen in this read cost, in micro-dollars, and how many there were. */
  costMicros: number;
  tokens: number;
  /** The reply in progress after this read. */
  turn: OpenTurn;
  /** `uuid` of the last main-thread assistant line read: everything up to it is billed once this read's bill is kept. */
  lastUuid: string | null;
}

/** Responses remembered as billed: one response's lines sit together, so a short list is enough. */
const BILLED_KEPT = 64;

/** The Stop hook's own state in the cursor memo, under one key. */
interface HooksMemo {
  turn: OpenTurn;
  billed: string[];
}

/** The memo saved with the cursor, when it has the hooks' key. */
function savedHooks(memo: unknown): HooksMemo | null {
  const h = memo && typeof memo === 'object' ? ((memo as Memo).hooks as Partial<HooksMemo> | undefined) : undefined;
  return h && typeof h === 'object' && h.turn && Array.isArray(h.billed) ? (h as HooksMemo) : null;
}

/** A usage count as a bill can take it: a finite number of tokens, never below zero. */
function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * One read's bill. A read that resumes from the cursor bills every response
 * it sees for the first time. A read that starts over (no cursor yet, a lost
 * one, a transcript replaced, truncated, or another file under the same
 * session id) lands near the end of a transcript whose earlier turns were
 * billed already, by an earlier read or by a version from before the cursor:
 * it bills only the reply in progress, never a response an earlier read
 * remembers billing, and nothing up to the last reply billed before.
 */
interface Bill {
  out: TranscriptCatchUp;
  /** Starting over: what the reply in progress costs so far, billed when the read ends. */
  open: { costMicros: number; tokens: number } | null;
  /** The last reply already billed (`SessionState.lastBillingUuid`). */
  billedThrough?: string;
}

/** Fold one transcript line into the memo and this read's bill. */
function fold(e: any, m: HooksMemo, bill: Bill): void {
  // Subagent lines are another context's work: never what the user read, never this session's bill.
  if (e.isSidechain) return;
  // The person's own prompt starts a new reply. A task notice, a command
  // wrapper, a compaction summary or a hand-back does not.
  if (e.type === 'user') {
    if (isTypedByPerson(e)) {
      m.turn = { uuid: null, tally: false };
      if (bill.open) bill.open = { costMicros: 0, tokens: 0 };
    }
    return;
  }
  if (e.type !== 'assistant' || e.isApiErrorMessage) return;
  if (typeof e.uuid === 'string') bill.out.lastUuid = e.uuid;
  const msg = e.message;
  const text = textOf(msg?.content);
  if (text.trim()) {
    if (typeof e.uuid === 'string') m.turn.uuid = e.uuid;
    if (hasSavingsTally(text)) m.turn.tally = true;
  }
  if (asksPerson(msg?.content)) m.turn.asks = true;
  billResponse(msg, m, bill);
  // Everything up to here was billed before.
  if (bill.open && bill.billedThrough && e.uuid === bill.billedThrough) bill.open = { costMicros: 0, tokens: 0 };
}

/** Whether a response's tool calls put a question to the person: a tool input with an `ask`. */
function asksPerson(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((p) => p?.type === 'tool_use' && typeof p.input?.ask === 'string' && p.input.ask.trim() !== '');
}

/** Bill one response's input once, by `message.id`: its lines (thinking, text, tool_use) each repeat the same `usage`. */
function billResponse(msg: any, m: HooksMemo, bill: Bill): void {
  const id = msg?.id;
  const usage = msg?.usage;
  if (typeof id !== 'string' || !usage || m.billed.includes(id)) return;
  m.billed.push(id);
  if (m.billed.length > BILLED_KEPT) m.billed.splice(0, m.billed.length - BILLED_KEPT);
  const turn = {
    model: String(msg?.model ?? ''),
    input: count(usage.input_tokens),
    cacheCreate: count(usage.cache_creation_input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
  };
  const micros = turnInputCostMicros(turn);
  // An unpriced model contributes neither cost nor tokens: leaving its tokens
  // in the denominator alone would drag the blended rate toward zero and
  // quietly under-report every saving after it.
  if (micros === null || !Number.isFinite(micros)) return;
  const sink = bill.open ?? bill.out;
  sink.costMicros += micros;
  sink.tokens += turnInputTokens(turn);
}

/**
 * What a Claude Code transcript gained since the last read with the same
 * cursor: the cost of each response seen for the first time, and the reply in
 * progress. The first read of a session takes at most the transcript's last
 * 8 MB and bills only the reply in progress (see {@link Bill});
 * `billedThrough` is the last reply billed before (kept with the totals, so
 * it outlives a lost cursor). `also` sees each line of the same read, with
 * the same memo, for another turn-end reader (the learning ask) that keeps
 * its state under a key of its own. Never throws; an unreadable file reads
 * as nothing new.
 */
export function catchUpTranscript(
  transcriptPath: string,
  cursorPath: string,
  opts: { billedThrough?: string; also?: (entry: Record<string, unknown>, memo: Memo) => void } = {},
): TranscriptCatchUp {
  const out: TranscriptCatchUp = { fresh: false, costMicros: 0, tokens: 0, turn: { uuid: null, tally: false }, lastUuid: null };
  const bill: Bill = { out, open: null, billedThrough: opts.billedThrough };
  // What the last read billed, kept apart: a read that starts over gets an empty memo.
  let before: string[] = [];
  try {
    before = savedHooks((readJson<{ trace?: { memo?: unknown } }>(cursorPath))?.trace?.memo)?.billed.filter((id) => typeof id === 'string') ?? [];
  } catch {
    // No cursor yet, or one that can't be read: nothing to carry.
  }
  readNewEvents(transcriptPath, cursorPath, {
    onEntry: (entry, memo) => {
      try {
        let m = savedHooks(memo);
        if (!m) {
          m = { turn: { uuid: null, tally: false }, billed: before.slice(-BILLED_KEPT) };
          memo.hooks = m;
          bill.open = { costMicros: 0, tokens: 0 };
        }
        fold(entry, m, bill);
        opts.also?.(entry, memo);
        out.fresh = true;
        out.turn = m.turn;
      } catch {
        // One odd line costs that line, never the read.
      }
    },
  });
  if (bill.open) {
    out.costMicros += bill.open.costMicros;
    out.tokens += bill.open.tokens;
  }
  return out;
}
