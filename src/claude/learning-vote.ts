/**
 * "Did it help? 👍/👎", asked once a session after a learning is reused.
 *
 * Reuse is the credit line: when a learning shapes a reply, the agent closes
 * it with "📝 Started from Maya's learning" (format.ts asks for that). Until
 * the session has asked, that ask also has the agent end the line with
 * {@link VOTE_ASK}, so the question costs no extra turn and never stops the
 * work. The Stop hook sees the question in the reply's last words and marks a
 * vote pending; the person's next prompt settles it: 👍 or +1 is `up`, 👎 or
 * -1 is `down`, anything else is `none`, and the prompt goes on as usual.
 * One `learning_rated` event carries the vote and the learning's id. Nothing
 * the person typed is kept or sent.
 */
import { track, type TrackContext } from '../telemetry/track.js';
import { readSession, writeSession, type SessionState } from './state.js';

/** What the agent ends its credit line with, the one time a session it asks. */
export const VOTE_ASK = 'did it help? 👍/👎';

/** The vote a prompt's first characters give, or `none` for a prompt that isn't one. */
export type Vote = 'up' | 'down' | 'none';

/** The words the credit instruction gains until this session has asked. '' after. */
export function voteClause(s: SessionState): string {
  return s.vote ? '' : `, and in this reply only, end that line with " · ${VOTE_ASK}"`;
}

/** Whether a reply asked: a credit line carrying both thumbs. */
export function askedForVote(reply: string): boolean {
  return reply.split('\n').some((l) => l.includes('📝') && l.includes('👍') && l.includes('👎'));
}

/** The person's answer, from the start of their own words. */
export function voteOf(words: string): Vote {
  const w = words.trim();
  if (/^(?:👍|:\+1:|:thumbsup:|\+1(?!\d))/u.test(w)) return 'up';
  if (/^(?:👎|:-1:|:thumbsdown:|-1(?!\d))/u.test(w)) return 'down';
  return 'none';
}

/**
 * At Stop: a reply that asked marks the session's one vote pending, on the
 * learning shown last before it. True when `s` changed and needs writing.
 */
export function markVoteAsked(s: SessionState, lastMessage: unknown): boolean {
  if (s.vote || typeof lastMessage !== 'string' || !askedForVote(lastMessage)) return false;
  s.vote = s.lastLearning ? { learning: s.lastLearning } : {};
  return true;
}

/**
 * At the next prompt: settle a pending vote and queue it. `words` is the
 * person's own text (promptWords); harness text ('') settles nothing. Never
 * throws: a lost vote costs one data point, a broken prompt hook the turn.
 * `ctx` is the telemetry test seam (a scratch home and env).
 */
export function settleVote(dir: string, id: string, words: string, ctx: Pick<TrackContext, 'home' | 'env'> = {}): void {
  try {
    if (!words) return;
    const s = readSession(dir, id);
    if (!s.vote || s.vote.settled) return;
    s.vote.settled = true;
    writeSession(dir, id, s);
    track('learning_rated', { vote: voteOf(words), learning_id: s.vote.learning }, { repo: dir, ...ctx });
  } catch {
    // The vote is lost; the prompt goes on.
  }
}
