/**
 * Whether overlap warnings earn their interruption: each one the agent is
 * given, with whether GitHub lists an open pull request for the branch (one
 * about an open pull request is real work; one about a branch with none is
 * often finished or given up) and whether the branch is the person's own, and
 * whether the person then named that teammate or branch in a prompt, which is
 * acting on it. The names stay in the session file on this machine; only `pr`
 * and `whose` travel.
 */
import { prState, type BranchCache } from '../notes/branches.js';
import type { FunctionOverlap } from '../notes/edit-overlap.js';
import { track } from '../telemetry/track.js';
import { readSession, writeSession, type SessionState } from './state.js';

/** Warnings remembered per session for the prompt that may follow. */
const SHOWN_CAP = 10;

/** The agent was just given these: count each, and remember who and which branch for `overlapActed`. */
export function overlapsShown(s: SessionState, shown: FunctionOverlap[], cache: BranchCache | null): void {
  for (const o of shown) {
    const pr = prState(cache, o.ref);
    const whose = o.mine ? ('mine' as const) : ('teammate' as const);
    track('overlap_warned', { pr, whose });
    s.shownOverlaps = [...(s.shownOverlaps ?? []), { who: o.author, branch: o.ref.replace(/^origin\//, ''), pr, whose }].slice(-SHOWN_CAP);
  }
}

/** The person's prompt names a teammate or branch a warning this session named: once per warning. Never throws. */
export function overlapActed(dir: string, sessionId: string, prompt: unknown): void {
  if (typeof prompt !== 'string' || !prompt) return;
  try {
    const s = readSession(dir, sessionId);
    const named = (s.shownOverlaps ?? []).filter((w) => !w.acted && (names(prompt, w.who) || names(prompt, w.branch)));
    if (!named.length) return;
    for (const w of named) {
      w.acted = true;
      track('overlap_acted', { pr: w.pr, whose: w.whose ?? 'teammate' });
    }
    writeSession(dir, sessionId, s);
  } catch {
    // Counting it never gets in the way of the prompt.
  }
}

/** `word` on its own in `text`, any case: `Kumar` in "ask kumar", not in "Kumaran". */
function names(text: string, word: string): boolean {
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w/-])${escaped}(?![\\w/-])`, 'i').test(text);
}
