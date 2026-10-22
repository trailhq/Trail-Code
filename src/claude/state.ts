/**
 * Claude Code session state. The shared `graft/.cache/` pieces (the statusline's
 * `Stats` snapshot and the build lock) live in `../util/state.js` so the graph's
 * pre-query auto-refresh can take the same lock; they are re-exported here so
 * every existing import path keeps working.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir, readJson, writeJsonAtomic } from '../util/state.js';
import type { AgentHost } from '../telemetry/contract.js';

export {
  LOCK_STALE_MS,
  acquireLock,
  acquireLockIn,
  releaseLockIn,
  cacheDir,
  emptyStats,
  patchStats,
  readStats,
  releaseLock,
  resolveContextDir,
  writeJsonAtomic,
  writeStats,
} from '../util/state.js';
export type { Stats } from '../util/state.js';

export interface SessionState {
  lastQuery: string | null;
  perAgentQuery: Record<string, string>;
  graftReads: number; sourceReads: number;
  /** Cumulative tokens saved this session via `ask --source` retrieval (est.). */
  savedTokens: number;
  /** Pointers the prompt hook already injected this session (novelty gate:
   * a hit whose pointer was shown once is never re-injected). Optional so
   * session files written before this field still parse. */
  injectedPointers?: string[];
  /** Notes already put in front of the agent this session by the per-prompt
   * hook, by path, so each is shown once (see `notesForPrompt`). */
  injectedNotes?: string[];
  /** `<branch> <function id>` pairs: a teammate's open branch on a function the agent edited, already put in front of it this session. */
  injectedOverlaps?: string[];
  /** Weak-match nudges spent this session, capped so the line stays signal.
   * Optional for the same backwards-compatibility reason as above. */
  nudges?: number;
  /** Turns this session in which the agent used a graft retrieval tool — the
   * denominator for "did it tell the user what that saved". Counted at Stop,
   * and only for turns whose reply we could actually read (see claude/tally.ts). */
  graftTurns?: number;
  /** Of those turns, the ones whose reply carried a "graft saved ~N tokens"
   * tally. `graftTurns - reportedTurns` is silent value: saved, never said. */
  reportedTurns?: number;
  /** Set by the tool-savings hook when the current turn touched graft, cleared
   * at Stop once the turn has been counted. Transient, not a total. */
  turnUsedGraft?: boolean;
  /** `uuid` of the last assistant reply already examined, so a Stop that fires
   * without new prose (or fires twice) can't count one reply as two turns. */
  lastTallyUuid?: string;
  /** Running micro-dollar cost of the input tokens this session has been billed
   * for, and the tokens that bought. Their ratio is the blended price of one
   * input token here — model and cache-hit ratio already folded in — which is
   * what turns `savedTokens` into a dollar figure. Stored as the pair rather
   * than the ratio so the rate re-blends as the session's cache warms rather
   * than freezing at whatever turn one happened to pay. Optional: absent on a
   * host that exposes no transcript, and on turn one of every session. */
  inputCostMicros?: number;
  inputTokensBilled?: number;
  /** `uuid` of the last assistant entry already billed, so a duplicate Stop
   * can't charge one turn twice. Separate from `lastTallyUuid` because the two
   * are sampled on different turns: the tally only on graft turns, the cost on
   * every one. */
  lastBillingUuid?: string;
  /** Set once the Stop hook has asked the agent to leave a note this session,
   * so it asks at most once (see `turnWantsNote`). */
  noteAsked?: boolean;
  /** Set once this session has been rolled up into a `session_summary`
   * telemetry event, so a resumed or long-lived session is counted once.
   * A flag rather than deleting the file: the file still holds `lastQuery` and
   * `injectedPointers`, which a resumed session needs. */
  summarized?: boolean;
  /** Which host recorded this session, stamped on the first tool use. Lets the
   * `session_summary` be attributed correctly even when Claude Code's idle sweep
   * is what finally flushes a Cursor session. Optional: files written before
   * host-stamping (or an empty session never touched by a tool) fall back to the
   * flushing host. */
  host?: AgentHost;
}

function emptySession(): SessionState {
  return { lastQuery: null, perAgentQuery: {}, graftReads: 0, sourceReads: 0, savedTokens: 0, injectedPointers: [], nudges: 0 };
}

/** The per-repo session directory holding one `<id>.json` per agent session. */
export function sessionDir(d: string): string { return join(cacheDir(d), 'session'); }

function sessionPath(d: string, id: string): string { return join(sessionDir(d), `${id}.json`); }

/** Every session id with a file on disk, or `[]` when none exist (never throws).
 *  Shared by the telemetry rollup and `graft stats` so they agree on the set. */
export function listSessionIds(d: string): string[] {
  try {
    return readdirSync(sessionDir(d)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch { return []; }
}

export function readSession(d: string, id: string): SessionState {
  return readJson<SessionState>(sessionPath(d, id)) ?? emptySession();
}
export function writeSession(d: string, id: string, s: SessionState): void {
  writeJsonAtomic(sessionPath(d, id), s);
}
