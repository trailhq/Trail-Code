/**
 * "Did it help? yes/no", asked once a session after a learning is reused.
 *
 * Reuse is the credit line: when a learning shapes a reply, the agent closes
 * it with "📝 Started from Maya's learning" (format.ts asks for that). Until
 * the session has asked, that ask also has the agent end the line with
 * {@link VOTE_ASK}, in a reply that asks the person nothing else, so the
 * question costs no extra turn and never stops the work. The Stop hook sees
 * the question in the reply's last words and marks a vote pending; the
 * person's next prompt settles it ({@link voteOf}), and the prompt goes on as
 * usual. A session closed with the question unanswered settles as `none`
 * (telemetry/sessions.ts). One `learning_rated` event carries the vote and the
 * learning's id. Nothing the person typed is kept or sent.
 */
import { track, type TrackContext } from '../telemetry/track.js';
import { readSession, writeSession, type SessionState } from './state.js';

/** What the agent ends its credit line with, the one time a session it asks. */
export const VOTE_ASK = 'did it help? yes/no';

/** The vote a prompt gives, or `none` for a prompt that isn't one. */
export type Vote = 'up' | 'down' | 'none';

/** The words the credit instruction gains until this session has asked. '' after. */
export function voteClause(s: SessionState): string {
  return s.vote ? '' : `, and in this reply only, if it asks the user nothing else, end that line with " · ${VOTE_ASK}"`;
}

/** Whether a reply asked: a credit line carrying the question. */
export function askedForVote(reply: string): boolean {
  return reply.split('\n').some((l) => l.includes('📝') && /did it help\?\s*yes\s*\/\s*no/i.test(l));
}

/**
 * Whether a reply asks the person something besides the vote: a sentence
 * ending in "?" or a "(y/n)" outside code and the credit line. A "yes" after
 * it may answer that instead.
 */
export function asksMore(reply: string): boolean {
  const prose = reply
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((l) => !l.includes('📝'))
    .join('\n');
  return /\?(?=[\s"'”’)\]*_]|$)/.test(prose) || /\((?:y\/n|yes\/no)\)/i.test(prose);
}

// What follows a word that counts: not a letter, digit or hyphen (`no-op`, `yesterday`, `sí` are judged whole).
const END = String.raw`(?![\p{L}\p{N}_'’-])`;
/** Yes as people type it: the word in a few spellings and languages, or a thumbs up. */
const UP = new RegExp(
  String.raw`^(?:(?:yes|yeah|yep|yup|yea|sure|definitely|absolutely|totally|indeed|haan|haa|han|ji|sí|si|ja|oui|sim|да|はい|네)${END}|👍|:\+1:|:thumbsup:|\+1(?!\d)|it did[\s.!]*$)`,
  'iu',
);
/** No as a word: counts only in a short reply, or one that says what didn't help. */
const DOWN_WORD = new RegExp(String.raw`^(?:no|nope|nah|nay|not really|nahi|nahin|nai|nein|non|não|nee|нет|いいえ|아니요|아니|it did ?n[o'’]?t)${END}`, 'iu');
/** No as a sign: a thumbs down or -1, whatever follows. */
const DOWN_SIGN = /^(?:👎|:-1:|:thumbsdown:|-1(?!\d))/u;
/** A leading no that is an idiom, not an answer. */
const NO_IDIOM = /^no[\s,.!]+(?:worries|problem|probs?|prob|rush|need|wait|way|idea|matter|clue|doubt|thanks|thank you|stop|more)\b/i;
/** Saying it didn't help, anywhere in the message. */
const DIDNT_HELP = /\b(?:(?:did|does|do|was|is|has|have|had) ?n[o'’]?t|not|never|no)\s+(?:(?:really|very|that|much|so|too|at all|of)\s+){0,2}help(?:ed|ful|s)?\b|\bunhelpful\b/i;
/** Saying it helped, anywhere in the message. */
const HELPED = /\bhelped\b|\b(?:was|is|very|really|super|quite|so|pretty|been|bahut|kaafi)\s+helpful\b|\b(?:it|that|this) (?:did|does) help\b/i;
/** Longest reply a leading no counts in without saying "help": "no, it was stale". */
const SHORT_NO_WORDS = 4;

/**
 * The person's answer. "It helped" or "didn't help" anywhere decides it.
 * Otherwise the start does: a yes word or a thumbs up is `up`; a thumbs down
 * or -1 is `down`, and so is a no word in a reply of up to four words or one
 * that mentions help, since "no, I meant the other file" is a correction, not
 * a vote. `strict` (something else was asked since the question) leaves only
 * the help phrases: a bare yes may answer the other question.
 */
export function voteOf(words: string, strict = false): Vote {
  const w = words.trim();
  if (DIDNT_HELP.test(w)) return 'down';
  if (HELPED.test(w)) return 'up';
  if (strict) return 'none';
  // Whole words only: a bare y/n may answer trail's own "(y/n)" in the same reply.
  if (UP.test(w)) return 'up';
  if (DOWN_SIGN.test(w)) return 'down';
  if (DOWN_WORD.test(w) && !NO_IDIOM.test(w) && (w.split(/\s+/).length <= SHORT_NO_WORDS || /\bhelp/i.test(w))) return 'down';
  return 'none';
}

/**
 * At Stop: a reply that asked marks the session's one vote pending, on the
 * learning shown last before it. Strict when that reply, or a later one before
 * the answer, asks something else too (`toolAsked`: a question the host shows
 * as buttons, which answer with a new message). True when `s` changed and
 * needs writing.
 */
export function markVoteAsked(s: SessionState, lastMessage: unknown, toolAsked = false): boolean {
  if (typeof lastMessage !== 'string') return false;
  const more = toolAsked || asksMore(lastMessage);
  if (!s.vote) {
    if (!askedForVote(lastMessage)) return false;
    s.vote = { ...(s.lastLearning ? { learning: s.lastLearning } : {}), ...(more ? { strict: true } : {}) };
    return true;
  }
  // Waiting still: this reply came after the question, so the next prompt may answer it instead.
  if (s.vote.settled || s.vote.strict || !more) return false;
  s.vote.strict = true;
  return true;
}

/**
 * Settle a waiting vote in `s` as `none`, for a session closed with the
 * question unanswered. The learning's id to send, or null when nothing waits.
 */
export function closeVote(s: SessionState): { learning?: string } | null {
  if (!s.vote || s.vote.settled) return null;
  s.vote.settled = true;
  return { learning: s.vote.learning };
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
    track('learning_rated', { vote: voteOf(words, s.vote.strict), learning_id: s.vote.learning }, { repo: dir, ...ctx });
  } catch {
    // The vote is lost; the prompt goes on.
  }
}
