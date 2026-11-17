/**
 * "Did it help? yes/no" (src/claude/learning-vote.ts): the credit line asks
 * once a session, the Stop hook marks the vote pending, and the next prompt
 * settles it into one `learning_rated` event: the vote and the learning's id,
 * never what the person typed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { notesForPrompt, notesOnTouch, type AskJson } from '../src/claude/format.js';
import { askedForVote, asksMore, markVoteAsked, settleVote, voteOf, VOTE_ASK } from '../src/claude/learning-vote.js';
import { catchUpTranscript } from '../src/claude/tally.js';
import { SESSION_IDLE_MS, flushClosedSessions } from '../src/telemetry/sessions.js';
import { handleStopEvent } from '../src/claude/stop.js';
import { readSession, writeSession, type SessionState } from '../src/claude/state.js';
import { track } from '../src/telemetry/track.js';
import { peek } from '../src/telemetry/queue.js';
import type { Note } from '../src/notes/notes.js';

const OPEN: NodeJS.ProcessEnv = {};
const note = { id: 'l-3f9a2c1d', path: '/n/a.md', title: 'gh repo clone success message', author: 'Maya', date: '2026-10-08', touches: ['clone.go'], body: '## Decided\nPrint it only on a TTY.\n', cost: { minutes: 4, tokens: 90_000 } };
const ask = { query: 'fork clone message', mode: 'lexical', hits: [], notes: [{ note, score: 1, shared: [] }] } as unknown as AskJson;
const CREDIT = `Done.\n\n📝 Started from Maya's learning · saved ~90k tokens · ${VOTE_ASK}`;

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'vote-home-'));
  mkdirSync(join(h, '.graft'), { recursive: true });
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_key';
  return h;
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vote-repo-'));
  mkdirSync(join(dir, 'graft', '.cache', 'session'), { recursive: true });
  return dir;
}

test('the credit instruction asks once a session, and remembers which learning it showed', () => {
  const s = {} as SessionState;
  const first = notesForPrompt(ask, s)!;
  assert.match(first, /end that line with " · did it help\? yes\/no"/);
  assert.match(first, /if it asks the user nothing else/);
  assert.equal(s.lastLearning, 'l-3f9a2c1d');
  s.vote = { learning: 'l-3f9a2c1d' };
  const touch = notesOnTouch([{ ...note, id: 'l-0000aaaa', path: '/n/b.md' } as unknown as Note], { file: 'clone.go', verb: 'opened' }, s)!;
  assert.match(touch, /📝 Started from Anirudh's learning/);
  assert.doesNotMatch(touch, /did it help/, 'asked already this session');
  assert.equal(s.lastLearning, 'l-0000aaaa');
});

test('a reply asked only when its credit line carries the question', () => {
  assert.equal(askedForVote(CREDIT), true);
  assert.equal(askedForVote("📝 Started from Maya's learning"), false);
  assert.equal(askedForVote("📝 Started from Maya's learning · Did it help? Yes / No"), true, 'any case and spacing');
  assert.equal(askedForVote("📝 Started from Maya's learning · did it help? 👍/👎"), false, 'the thumbs wording is gone');
  assert.equal(askedForVote('Ship it? did it help? yes/no'), false, 'no credit line, no learning to rate');
});

test('the vote: yes words and thumbs up; a short no, nope or thumbs down; "it helped" or "didn\'t help" anywhere', () => {
  for (const w of ['yes', 'Yes, now the tests', 'YES!', '👍', '👍🏽 thanks, now the tests', '+1', ':+1:', ':thumbsup: nice', 'yeah', 'Yep, ship it', 'sure', 'haan', 'sí', 'ja', 'it did', 'it helped 👍', 'fixed it, and yes it helped', 'that was really helpful']) assert.equal(voteOf(w), 'up', w);
  for (const w of ['no', 'No, it was stale', '👎', '-1 it was stale', ':-1:', ':thumbsdown:', 'nope', 'nah', 'not really', 'nahi', "it didn't", "that didn't help", 'it did not help with the build', 'not very helpful', 'no, it did not help at all and I had to redo the migration']) assert.equal(voteOf(w), 'down', w);
  for (const w of ['y', 'n', 'yse', 'kind of', 'yesterday it broke', 'not yet', 'now fix the tests', '+10 more rows', '-12 is the offset', 'no, I meant the other file', 'no worries', 'No problem!', 'no-op is fine', 'nonetheless', 'make the error more helpful', 'help me fix the tests']) assert.equal(voteOf(w), 'none', w);
});

test('strict (something else was asked since): only saying it helped or didn\'t counts', () => {
  for (const w of ['Yes please', 'Yes, fix 1', 'no', '👍', 'nope']) assert.equal(voteOf(w, true), 'none', w);
  assert.equal(voteOf('yes, and it helped', true), 'up');
  assert.equal(voteOf("commit it. the learning didn't help though", true), 'down');
});

test('a reply that asks anything else makes the vote strict, then or before the answer', () => {
  const plain = {} as SessionState;
  assert.equal(markVoteAsked(plain, CREDIT), true);
  assert.equal(plain.vote!.strict, undefined);
  assert.equal(markVoteAsked(plain, 'Ran the suite: all green.'), false, 'a later reply that asks nothing');
  assert.equal(markVoteAsked(plain, 'Save this as a learning? (y/n)'), true, "trail's own ask, before the answer");
  assert.equal(plain.vote!.strict, true);

  const mixed = {} as SessionState;
  markVoteAsked(mixed, `Done. Want me to commit?\n\n📝 Started from Maya's learning · ${VOTE_ASK}`);
  assert.equal(mixed.vote!.strict, true, 'Claude asked anyway');
  const buttons = {} as SessionState;
  markVoteAsked(buttons, CREDIT, true);
  assert.equal(buttons.vote!.strict, true, 'a question with answer buttons');

  for (const r of ['```ts\nconst a = b ? c : d;\n```', 'Use `a?.b` here.', 'See https://x.test/?q=1 for it.', CREDIT]) assert.equal(asksMore(r), false, r);
  for (const r of ['Ship it?', 'Which one do you want? I can do both.', 'Commit it with this change? (y/n)', '**Ready?**']) assert.equal(asksMore(r), true, r);
});

test('the transcript read notices a question tool with answer buttons in the reply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vote-transcript-'));
  const path = join(dir, 's.jsonl');
  const line = (o: object) => JSON.stringify(o);
  writeFileSync(path, [
    line({ type: 'user', uuid: 'u1', origin: { kind: 'human' }, message: { role: 'user', content: 'fix the clone message' } }),
    line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Fixed.', ask: 'Commit it?' } }] } }),
    line({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: CREDIT }] } }),
  ].join('\n') + '\n');
  assert.equal(catchUpTranscript(path, join(dir, 's.hooks.json')).turn.asks, true);
  writeFileSync(path, [
    line({ type: 'user', uuid: 'u1', origin: { kind: 'human' }, message: { role: 'user', content: 'fix the clone message' } }),
    line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Fixed.' } }] } }),
  ].join('\n') + '\n');
  assert.equal(catchUpTranscript(path, join(dir, 's2.hooks.json')).turn.asks, undefined, 'a recap alone asks nothing');
});

test('Stop marks the vote pending once; the next prompt settles it into one event with the vote and the id only', async () => {
  process.env[BRAND_ENV] = 'trail';
  const dir = repo();
  const h = home();
  writeSession(dir, 's1', { graftReads: 0, sourceReads: 0, savedTokens: 0, lastLearning: 'l-3f9a2c1d' });
  await handleStopEvent({ session_id: 's1', last_assistant_message: CREDIT }, dir, { skills: false });
  assert.deepEqual(readSession(dir, 's1').vote, { learning: 'l-3f9a2c1d' });
  const secret = 'yes, and rename Zebrafinchsynthetic in clone.go';
  settleVote(dir, 's1', secret, { home: h, env: OPEN });
  settleVote(dir, 's1', 'no', { home: h, env: OPEN });
  const sent = peek(h) as Array<{ event: string; properties: Record<string, string> }>;
  assert.equal(sent.length, 1, 'once a session');
  assert.equal(sent[0]!.event, 'learning_rated');
  assert.equal(sent[0]!.properties.vote, 'up');
  assert.equal(sent[0]!.properties.learning_id, 'l-3f9a2c1d');
  assert.doesNotMatch(JSON.stringify(sent), /Zebrafinch|rename|clone\.go/);
  const s = readSession(dir, 's1');
  assert.equal(markVoteAsked(s, CREDIT), false, 'a session asks once');
});

test('a prompt that moves on settles as none; harness text settles nothing', () => {
  const dir = repo();
  const h = home();
  writeSession(dir, 's2', { graftReads: 0, sourceReads: 0, savedTokens: 0, vote: {} });
  settleVote(dir, 's2', '', { home: h, env: OPEN });
  assert.equal(peek(h).length, 0);
  settleVote(dir, 's2', 'now the docs', { home: h, env: OPEN });
  const [e] = peek(h) as Array<{ properties: Record<string, string> }>;
  assert.equal(e!.properties.vote, 'none');
  assert.equal('learning_id' in e!.properties, false);
});

test('the contract drops a vote outside the set and anything under learning_id that is not an id', () => {
  const h = home();
  const e = track('learning_rated', { vote: 'meh', learning_id: 'gh repo clone success message', prompt: 'x' }, { home: h, env: OPEN })!;
  assert.equal('vote' in e.properties, false);
  assert.equal('learning_id' in e.properties, false);
  assert.equal('prompt' in e.properties, false);
});

test('a session closed with the question unanswered sends none, once', () => {
  const dir = repo();
  const h = home();
  const file = (id: string, body: SessionState) => {
    writeSession(dir, id, body);
    const when = new Date(Date.now() - SESSION_IDLE_MS - 1000);
    utimesSync(join(dir, 'graft', '.cache', 'session', `${id}.json`), when, when);
  };
  file('idle', { graftReads: 0, sourceReads: 0, savedTokens: 0, vote: { learning: 'l-3f9a2c1d' } });
  file('resumed', { graftReads: 0, sourceReads: 0, savedTokens: 0, summarized: true, vote: {} });
  file('answered', { graftReads: 0, sourceReads: 0, savedTokens: 0, vote: { learning: 'l-3f9a2c1d', settled: true } });
  flushClosedSessions(dir, Date.now(), h, OPEN);
  flushClosedSessions(dir, Date.now(), h, OPEN);
  const votes = (peek(h) as Array<{ event: string; properties: Record<string, string> }>).filter((e) => e.event === 'learning_rated');
  assert.equal(votes.length, 2, 'the idle one and the resumed one, each once');
  assert.deepEqual(votes.map((e) => e.properties.vote), ['none', 'none']);
  assert.equal(votes.filter((e) => e.properties.learning_id === 'l-3f9a2c1d').length, 1);
  assert.equal(readSession(dir, 'idle').vote!.settled, true);
  settleVote(dir, 'idle', 'yes', { home: h, env: OPEN });
  assert.equal((peek(h) as Array<{ event: string }>).filter((e) => e.event === 'learning_rated').length, 2, 'a late yes after the close counts nothing');
});
