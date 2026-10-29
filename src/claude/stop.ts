/**
 * The one Stop handler: what happens when the agent's turn ends.
 *
 * Turn-end bookkeeping first: what the turn's input tokens cost, whether the
 * reply said what graft saved, and one background graph sync when an edit
 * left the graph dirty. Then the answer, one JSON object at most: the
 * learned-skills part's (stop-skills.ts, loaded only when skills are on), a
 * block (the repeated-job offer the agent says) or a notice, never both. When
 * that part has nothing to say, under trail a sign in the transcript that the
 * session found something the code won't tell the next person asks the agent
 * to save a learning (note-signals.ts). An offer or notice that wins leaves
 * the sign unasked, so the ask can come at a later Stop.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { claudeScriptPath } from './paths.js';
import { emitHook, payloadSessionId } from './hook-io.js';
import { stopPart } from './skills-wiring.js';
import { acquireLock, patchStats, readSession, readStats, writeSession, type SessionState } from './state.js';
import { catchUpTranscript, hasSavingsTally, type TranscriptCatchUp } from './tally.js';
import { detectHost } from '../trace/host.js';
import { hookCursorPath } from '../trace/state.js';
import { trailHome } from '../notes/trail-home.js';
import { keepsNotes } from '../notes/home.js';
import { maybeSyncInBackground } from '../cloud/workspace-sync.js';
import { brand } from '../brand.js';
import { NOTE_ASKS_PER_SESSION, askAnswer, noteAsk, noteSignals } from './note-signals.js';
import { branchAddsLearning } from '../cloud/diff.js';
import { track } from '../telemetry/track.js';
import type { HookOut } from '../skills/types.js';

/** The fields of a Stop payload this handler reads. */
interface StopInput {
  session_id?: unknown;
  transcript_path?: unknown;
  /** The reply's last words, which may not be in the transcript yet when Stop fires. */
  last_assistant_message?: unknown;
}

function sessionId(input: StopInput): string {
  return payloadSessionId(input);
}

/**
 * What the transcript gained since the last Stop, or null when there is no
 * transcript Trail may read as Claude Code's: no path, another host's payload
 * (Cursor and Copilot CLI run these hooks with transcripts of their own), or
 * a subagent's.
 */
function readTurnEnd(input: StopInput, s: SessionState): TranscriptCatchUp | null {
  const host = detectHost(input);
  if (host.host !== 'claude' || host.subagent) return null;
  const path = input.transcript_path;
  if (typeof path !== 'string' || !path) return null;
  // Billed up to this reply already, whatever the cursor says.
  return catchUpTranscript(path, hookCursorPath(sessionId(input)), { billedThrough: s.lastBillingUuid });
}

/**
 * What this turn's input tokens actually cost, added to the session's running
 * pair.
 *
 * Deliberately ungated, unlike {@link countTallyTurn}: the blended rate has to
 * describe the session, and graft turns are not a fair sample of it — they are
 * the long, tool-heavy, cache-warm ones. Sampling only those would report a
 * cheaper token than the session really pays.
 *
 * Accumulates the pair, never the ratio, so the rate re-blends every turn.
 * Each response is billed once, by the read that first sees it; the last
 * reply billed is kept beside the totals.
 */
function sampleTurnCost(s: SessionState, read: TranscriptCatchUp | null): boolean {
  if (!read?.lastUuid) return false;
  // Kept with the totals it guards: a read that has to start over (a lost
  // cursor, a replaced transcript) bills nothing up to here again.
  s.lastBillingUuid = read.lastUuid;
  if (read.tokens > 0 && read.costMicros >= 0) {
    s.inputCostMicros = (s.inputCostMicros ?? 0) + read.costMicros;
    s.inputTokensBilled = (s.inputTokensBilled ?? 0) + read.tokens;
  }
  return true;
}

/**
 * At turn end: did the reply the user just read say what graft saved?
 *
 * Judged only on turns the tool-savings hook flagged, so a conversational turn
 * costs nothing. A turn we cannot observe — a host whose Stop hook names no
 * transcript, another host's payload, an unreadable file, or a Stop with
 * nothing new on disk since the last one — is counted in NEITHER total: the
 * ratio these two numbers form has to mean "of the turns we could check", not
 * "of the turns we tried to".
 */
function countTallyTurn(s: SessionState, read: TranscriptCatchUp | null, lastMessage: unknown): boolean {
  if (!s.turnUsedGraft) return false;
  s.turnUsedGraft = false;
  if (!read?.fresh) return true;
  const said = typeof lastMessage === 'string' && lastMessage.trim() ? lastMessage : '';
  // The reply's last words may reach the payload before the transcript: then
  // they name the reply.
  const uuid = read.turn.uuid ?? (said ? `said-${createHash('sha1').update(said).digest('hex').slice(0, 12)}` : null);
  // Same reply as last time we looked: no new prose has landed, so this Stop
  // is a duplicate or a race with the transcript write.
  if (uuid === null || uuid === s.lastTallyUuid) return true;
  s.graftTurns = (s.graftTurns ?? 0) + 1;
  if (read.turn.tally || hasSavingsTally(said)) s.reportedTurns = (s.reportedTurns ?? 0) + 1;
  s.lastTallyUuid = uuid;
  return true;
}

/**
 * The turn's cost and tally, from one read of the transcript and one write of
 * the session. Returns the transcript's path when it is Claude Code's, for the
 * learning ask, or null when there was none to read.
 */
function turnEnd(input: StopInput, dir: string): string | null {
  try {
    const id = sessionId(input);
    const s = readSession(dir, id);
    const read = readTurnEnd(input, s);
    const billed = sampleTurnCost(s, read);
    const counted = countTallyTurn(s, read, input.last_assistant_message);
    if (billed || counted) writeSession(dir, id, s);
    return read && typeof input.transcript_path === 'string' ? input.transcript_path : null;
  } catch {
    // A turn-end metric is never worth failing the graph sync over.
    return null;
  }
}

/**
 * #663's save ask: under trail, a sign in the transcript that the session
 * found something the code won't tell the next person (a check that failed
 * then passed after an edit, a correction, an undone edit, a picked option, a
 * commit; see note-signals.ts) asks the agent to save a learning, by blocking
 * the stop with the reason. Each sign is asked about once, and a session is
 * asked at most NOTE_ASKS_PER_SESSION times; a saved learning starts the signs
 * over. Never blocks twice in a row: Claude Code sets `stop_hook_active` on
 * the stop that follows a block; that stop sends `note_asked`, what was asked
 * and whether a learning was saved in answer. The caller writes it only as the
 * Stop's one answer, so a sign is marked asked only when it was. Never throws.
 */
export function askForNote(input: { stop_hook_active?: unknown }, dir: string, id: string, transcript: string | null): HookOut {
  try {
    if (!transcript || brand() !== 'trail' || !keepsNotes(dir)) return {};
    const s = readSession(dir, id);
    const asked = s.noteAsks ?? [];
    if (input.stop_hook_active) {
      const saved = asked.length ? askAnswer(readFileSync(transcript, 'utf8')) : null;
      if (saved) track('note_asked', { kind: asked[asked.length - 1]!.split(':')[0], saved }, { repo: dir });
      return {};
    }
    if (asked.length >= NOTE_ASKS_PER_SESSION) return {};
    const sign = noteSignals(readFileSync(transcript, 'utf8'), dir, () => branchAddsLearning(dir)).find((x) => !asked.includes(x.key));
    if (!sign) return {};
    writeSession(dir, id, { ...s, noteAsks: [...asked, sign.key] });
    return { block: noteAsk(sign) };
  } catch {
    // A missed reminder costs one learning; a broken Stop hook costs the session.
    return {};
  }
}

/** One detached graph sync when an edit this turn left the graph dirty. */
function startSync(dir: string): void {
  try {
    // sync-run.js ships next to this module inside the package, so it resolves in
    // any repo that installs graft (not just graft's own). Defensive existsSync:
    // if the package is somehow incomplete, skip rather than wedge on syncing:true.
    // GRAFT_TEST_SYNC_RUN is a test seam (mirrors GRAFT_TEST_STDIN) so tests can point
    // this at a stub file inside their own sandbox instead of writing into src/claude/.
    const syncRun = process.env.GRAFT_TEST_SYNC_RUN ?? claudeScriptPath('sync-run.js');
    if (!existsSync(syncRun)) return;
    const stats = readStats(dir);
    if (stats?.dirty && acquireLock(dir)) {
      patchStats(dir, { syncing: true });
      const child = spawn(process.execPath, [syncRun, dir], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    }
  } catch {
    // The next Stop, or the next query, brings the graph up to date.
  }
}

/**
 * The Stop event, for every host that sends one: the turn-end bookkeeping, then the skills part's one answer.
 * `skills: false` for a caller whose payload is not a Stop's (`post-edit-sync` sends an edit's).
 */
export async function handleStopEvent(input: unknown, dir: string, opts: { skills?: boolean } = {}): Promise<void> {
  const i: StopInput = input && typeof input === 'object' && !Array.isArray(input) ? (input as StopInput) : {};
  const transcript = turnEnd(i, dir);
  startSync(dir);
  // A learning committed this turn, and the turn's skill runs and searches, reach the team now, not next session.
  maybeSyncInBackground(dir);
  if (opts.skills === false) return;
  let out: HookOut = {};
  try {
    out = await stopPart(i, dir);
  } catch {
    // A turn always ends; an offer can wait for the next one.
  }
  // The skills part's answer wins; with none, #663's save ask may be the answer.
  if (!out.block && !out.notice && !out.context) out = askForNote(i as { stop_hook_active?: unknown }, dir, sessionId(i), transcript);
  try {
    out = await forgetNotice(i, out);
  } catch {
    // The note waits for the next Stop.
  }
  emitHook('Stop', out);
}

/**
 * D117 (2), skills on or off: what an agent's `trail forget` dropped, told to the person once. One stat when there
 * is nothing to tell; the module loads only when there is.
 */
async function forgetNotice(i: StopInput, out: HookOut, env: NodeJS.ProcessEnv = process.env): Promise<HookOut> {
  if (out.block || (i as { stop_hook_active?: unknown }).stop_hook_active === true) return out;
  if (detectHost(i).subagent || !existsSync(join(trailHome(env), 'state', 'forgot.jsonl'))) return out;
  const { forgetNoticeAtStop } = await import('../skills/forget-notice.js');
  return forgetNoticeAtStop(out, env, detectHost(i).host);
}
