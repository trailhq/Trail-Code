/**
 * Claude Code session state. The shared `graft/.cache/` pieces (the statusline's
 * `Stats` snapshot and the build lock) live in `../util/state.js` so the graph's
 * pre-query auto-refresh can take the same lock; they are re-exported here so
 * every existing import path keeps working.
 */
import { existsSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
  /** Prompts the prompt hook asked the graph about this session. A count:
   * nothing the person typed is kept (spec section 6). Optional so files
   * written before it still parse. */
  promptAsks?: number;
  /** The repo skills this session used, by name, to when it last went to the workspace as a run (skill-use.ts). */
  skillsUsed?: Record<string, number>;
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
  /** `uuid` of the last assistant entry already billed. Each response is
   * billed once, by the Stop read that first sees it (claude/tally.ts); a read
   * that has to start over (no cursor, a lost one, a replaced transcript)
   * bills nothing up to this entry again. */
  lastBillingUuid?: string;
  /** The signs the Stop hook has asked the agent to save a learning about
   * this session (note-signals.ts keys), so each is asked about once and a
   * session at most NOTE_ASKS_PER_SESSION times. */
  noteAsks?: string[];
  /** Id of the top learning the last injection showed, for the vote (learning-vote.ts). */
  lastLearning?: string;
  /** The session's one "did it help?" (learning-vote.ts): set when a reply asked, `settled` once the next prompt answered. */
  vote?: { learning?: string; settled?: boolean };
  /** Set once this session has been rolled up into a `session_summary`
   * telemetry event, so a resumed or long-lived session is counted once.
   * A flag rather than deleting the file: the file still holds
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
  return { graftReads: 0, sourceReads: 0, savedTokens: 0, injectedPointers: [], nudges: 0 };
}

/** Where versions before 0.23 kept the prompt itself (`lastQuery`, and `perAgentQuery` by agent name). */
const PROMPT_KEYS = ['lastQuery', 'perAgentQuery'] as const;

/** `s` without the prompt an older version stored in it. True when there was one. */
function withoutPrompts(s: Record<string, unknown>): boolean {
  let had = false;
  for (const key of PROMPT_KEYS) {
    if (key in s) { delete s[key]; had = true; }
  }
  return had;
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
  const s = readJson<SessionState>(sessionPath(d, id));
  if (!s || typeof s !== 'object') return emptySession();
  withoutPrompts(s as unknown as Record<string, unknown>);
  return s;
}
export function writeSession(d: string, id: string, s: SessionState): void {
  const out = { ...s } as Record<string, unknown>;
  withoutPrompts(out);
  writeJsonAtomic(sessionPath(d, id), out);
}

/** Left in the session dir once every file there is free of prompts. Not `.json`, so never read as a session. */
const PROMPTS_DROPPED = '.prompts-dropped';

/**
 * Take the prompt out of every session file an older version wrote here.
 * Once per repo: the marker skips the read of every file on later session
 * starts. Each file keeps its mtime, since the idle sweep that rolls sessions
 * up into telemetry judges a session closed by it. Best-effort: a file that
 * can't be read or written is tried again next time.
 */
export function dropStoredPrompts(d: string): void {
  const dir = sessionDir(d);
  const marker = join(dir, PROMPTS_DROPPED);
  if (existsSync(marker)) return;
  let clean = true;
  for (const id of listSessionIds(d)) {
    const path = sessionPath(d, id);
    try {
      const s = readJson<Record<string, unknown>>(path);
      if (!s || typeof s !== 'object' || !withoutPrompts(s)) continue;
      const { atime, mtime } = statSync(path);
      writeJsonAtomic(path, s);
      utimesSync(path, atime, mtime);
    } catch {
      clean = false;
    }
  }
  if (!clean || !existsSync(dir)) return;
  try { writeFileSync(marker, ''); } catch { /* swept again next time */ }
}
