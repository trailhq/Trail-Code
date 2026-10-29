/**
 * "Did it help? 👍/👎" (src/claude/learning-vote.ts): the credit line asks
 * once a session, the Stop hook marks the vote pending, and the next prompt
 * settles it into one `learning_rated` event: the vote and the learning's id,
 * never what the person typed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { notesForPrompt, notesOnTouch, type AskJson } from '../src/claude/format.js';
import { askedForVote, markVoteAsked, settleVote, voteOf, VOTE_ASK } from '../src/claude/learning-vote.js';
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
  assert.match(first, /end that line with " · did it help\? 👍\/👎"/);
  assert.equal(s.lastLearning, 'l-3f9a2c1d');
  s.vote = { learning: 'l-3f9a2c1d' };
  const touch = notesOnTouch([{ ...note, id: 'l-0000aaaa', path: '/n/b.md' } as unknown as Note], { file: 'clone.go', verb: 'opened' }, s)!;
  assert.match(touch, /📝 Started from Anirudh's learning/);
  assert.doesNotMatch(touch, /did it help/, 'asked already this session');
  assert.equal(s.lastLearning, 'l-0000aaaa');
});

test('a reply asked only when its credit line carries both thumbs', () => {
  assert.equal(askedForVote(CREDIT), true);
  assert.equal(askedForVote("📝 Started from Maya's learning"), false);
  assert.equal(askedForVote('Ship it? 👍/👎'), false, 'no credit line, no learning to rate');
});

test('the vote is read from the start of the person\'s words', () => {
  for (const w of ['👍', '👍🏽 thanks, now the tests', '+1', ':+1:', ':thumbsup: nice']) assert.equal(voteOf(w), 'up', w);
  for (const w of ['👎', '-1 it was stale', ':-1:', ':thumbsdown:']) assert.equal(voteOf(w), 'down', w);
  for (const w of ['yes', 'now fix the tests', '+10 more rows', '-12 is the offset', 'it helped 👍']) assert.equal(voteOf(w), 'none', w);
});

test('Stop marks the vote pending once; the next prompt settles it into one event with the vote and the id only', async () => {
  process.env[BRAND_ENV] = 'trail';
  const dir = repo();
  const h = home();
  writeSession(dir, 's1', { graftReads: 0, sourceReads: 0, savedTokens: 0, lastLearning: 'l-3f9a2c1d' });
  await handleStopEvent({ session_id: 's1', last_assistant_message: CREDIT }, dir, { skills: false });
  assert.deepEqual(readSession(dir, 's1').vote, { learning: 'l-3f9a2c1d' });
  const secret = '👍 and rename Zebrafinchsynthetic in clone.go';
  settleVote(dir, 's1', secret, { home: h, env: OPEN });
  settleVote(dir, 's1', '👎', { home: h, env: OPEN });
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
