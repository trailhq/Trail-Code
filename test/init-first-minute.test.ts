/**
 * `trail init`'s last lines (src/init/first-minute.ts): the last task picked
 * and said with only the figures its transcript gives, the learnings listed
 * with where each came from, "right? (y/n)" kept on this machine, a first
 * prompt shown only when the prompt hook's own match brings its learning up
 * first, and graft's epilogue untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import {
  activeMinutes, bringsUp, checksPath, firstPrompt, learningLines, learningsForTask, listLines, MAX_SHOWN, pickLastTask, planEnding,
  promptsFor, repoLearnings, sayEnding, sourceOf, taskFacts, taskLines, tryLines, type Ending, type Shown,
} from '../src/init/first-minute.js';
import { formatInitEpilogue } from '../src/cli-epilogue.js';
import type { PastSession } from '../src/init/sessions.js';
import { listNotes, type Note } from '../src/notes/notes.js';

const session = (id: string, at: string, texts: string[], extra: Partial<PastSession> = {}): PastSession => ({
  id, at, prompts: texts.map((text, i) => ({ text, at: new Date(Date.parse(at) + i * 60_000).toISOString() })), ...extra,
});

const note = (over: Partial<Note> = {}): Note => ({
  path: '/r/.trail/learnings/x.md', title: 'Retries stay at 4 because the gateway times out', author: 'Shrish', date: '2026-10-27',
  touches: [], body: '## Decided\n- Keep MAX at 4.\n', ...over,
} as Note);

/** A scratch git repo with these learnings committed in `.trail/learnings/`, and a Trail home of its own. */
function repoWith(learnings: Array<{ name: string; text: string }>): { repo: string; env: NodeJS.ProcessEnv } {
  const repo = mkdtempSync(join(tmpdir(), 'first-minute-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.trail', 'learnings'), { recursive: true });
  for (const l of learnings) writeFileSync(join(repo, '.trail', 'learnings', l.name), l.text);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'retry.ts'), 'export const MAX = 4;\n');
  writeFileSync(join(repo, 'src', 'billing.ts'), 'export function chargeInCents(n: number) { return n; }\n');
  return { repo, env: { ...process.env, TRAIL_HOME: join(repo, '..', `${repo.split(/[\\/]/).pop()}-home`), DO_NOT_TRACK: '1' } };
}

const RETRY = `---
title: Retries stay at 4 because the gateway times out at 30 s
author: Shrish
date: 2026-10-27
id: l-1111aaaa
scope: repo
status: active
touches:
  - src/retry.ts#withRetry
---

## Decided
- Keep MAX at 4 in src/retry.ts: 4 tries of 7 s fit under the gateway's 30 s.
`;

const CENTS = `---
title: Payments are stored in cents, never floats, after a rounding bug
author: Anirudh
date: 2026-10-29
id: l-2222bbbb
scope: repo
status: active
touches:
  - src/billing.ts
---

## Decided
- \`chargeInCents\` takes integer cents; a float total was off by a cent on invoices.

_From past Claude sessions here, Oct 29._
`;

/** Runs `fn` with TRAIL_HOME pointed at the scratch home: the prompt hook's reads take process.env. */
function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const before = process.env.TRAIL_HOME;
  process.env.TRAIL_HOME = env.TRAIL_HOME;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = before;
  }
}

test('the last task: the newest session with 3+ typed messages, by its last one; a question is not a task', () => {
  const old = session('old', '2026-10-01T10:00:00Z', ['fix the retry loop in the gateway', 'ok', 'ship it']);
  const quick = session('quick', '2026-11-03T10:00:00Z', ['what does this do?']);
  const long = session('long', '2026-09-01T10:00:00Z', ['a', 'b', 'c']);
  long.prompts.push({ text: 'still here', at: '2026-10-20T10:00:00Z' });
  assert.equal(pickLastTask([old, quick, long])?.id, 'long', 'its last message is the newest');
  assert.equal(pickLastTask([quick]), null);
});

test('task facts: the first line that asks for something, corrections by trail\'s own check, minutes only when measured', () => {
  const s = session('t1', '2026-11-03T10:00:00Z', ['hi', 'Repo: acme/shop (local clone at /src/shop)\nmake enter at the who-is-it-for question pick the team', "no, that's wrong: keep just me second", 'ok']);
  const f = taskFacts(s);
  assert.equal(f.what, 'make enter at the who-is-it-for question pick the team', 'not the pasted header');
  assert.equal(f.messages, 4);
  assert.equal(f.corrections, 1);
  assert.equal('minutes' in f, false, 'no figure without a measurement');
  assert.equal(taskFacts(s, 36).minutes, 36);
  assert.equal(f.day, '2026-11-03');
  assert.equal('since' in f, false, 'one day');
  const weeks = session('t2', '2026-10-13T10:00:00Z', ['fix the retry loop in the gateway', 'ok', 'ship it']);
  weeks.prompts.push({ text: 'and the docs', at: '2026-11-04T10:00:00Z' });
  assert.deepEqual([taskFacts(weeks).since, taskFacts(weeks).day], ['2026-10-13', '2026-11-04']);
  assert.equal(taskLines(taskFacts(weeks), 1)[0], 'Your last task here, Oct 13 to Nov 4: "fix the retry loop in the gateway"');
});

test('active minutes: every entry\'s time, gaps over 10 minutes count as nothing; none without times', () => {
  const dir = mkdtempSync(join(tmpdir(), 'first-minute-t-'));
  const path = join(dir, 's.jsonl');
  const at = (min: number) => new Date(Date.parse('2026-11-03T10:00:00Z') + min * 60_000).toISOString();
  // 0 → 5 → 9 (9 min), a 2-hour lunch, then 129 → 135 (6 min).
  writeFileSync(path, [0, 5, 9, 129, 135].map((m) => JSON.stringify({ type: 'user', timestamp: at(m) })).join('\n') + '\n');
  assert.equal(activeMinutes({ path }), 15);
  const none = join(dir, 'n.jsonl');
  writeFileSync(none, '{"type":"user"}\n');
  assert.equal(activeMinutes({ path: none }), undefined);
  assert.equal(activeMinutes({}), undefined);
});

test('where a learning came from: that session, the provenance init wrote, else whose and when', () => {
  assert.equal(sourceOf(note({ id: 'l-1' }), { fromTask: new Set(['l-1']) }), 'from that session');
  assert.equal(sourceOf(note({ body: 'x\n\n_From past Claude sessions here, Nov 3._\n' })), 'from your past sessions, Nov 3');
  assert.equal(sourceOf(note({ author: 'Anirudh', body: 'x\n\n_From past Claude sessions here, Nov 3._\n' }), { me: 'Rushabh' }), "from Anirudh's past sessions, Nov 3", "a teammate's init wrote it");
  assert.equal(sourceOf(note({ body: 'x\n\n_From PR #12 here, Oct 2._' })), 'from PR #12 here, Oct 2');
  assert.equal(sourceOf(note()), 'Shrish, Oct 27');
  assert.equal(sourceOf(note({ author: 'Rushabh' }), { me: 'Rushabh' }), 'you, Oct 27');
});

test('the list: the task\'s learnings under it, the rest under their own heading, numbered on; y/n goes on each one\'s last line', () => {
  const shown = (title: string, group: Shown['group']): Shown => ({ note: note({ title, path: `/r/${title}.md` }), line: 'Keep MAX at 4.', from: 'Shrish, Oct 27', group });
  const task = { id: 't', day: '2026-11-03', what: 'fix the retry loop', messages: 14, minutes: 96, corrections: 2 };
  const lines = listLines({ task, shown: [shown('A', 'task'), shown('B', 'kept')] });
  assert.deepEqual(lines.map((l) => l.line), [
    '',
    'Your last task here, Nov 3: "fix the retry loop"',
    '  14 messages from you, about 1 h 36 min of work, 2 of them corrected Claude',
    '  Trail now has 1 learning for work like it:',
    '  1. A',
    '     Keep MAX at 4.',
    '     Shrish, Oct 27',
    '',
    'Also kept from your past sessions:',
    '  2. B',
    '     Keep MAX at 4.',
    '     Shrish, Oct 27',
  ]);
  assert.deepEqual(lines.filter((l) => l.ask).map((l) => l.ask!.n), [1, 2]);
  // No task: only what was kept, under its own heading, from 1.
  const bare = listLines({ task: null, shown: [shown('B', 'kept')] }).map((l) => l.line);
  assert.deepEqual(bare, ['', 'Kept from your past sessions:', '  1. B', '     Keep MAX at 4.', '     Shrish, Oct 27']);
  // Nothing from the person's sessions: the team's, under their own heading.
  const team = listLines({ task: null, shown: [shown('C', 'repo'), shown('D', 'repo')] });
  assert.deepEqual(team.map((l) => l.line).slice(0, 3), ['', "Your team's learnings in this repo:", '  1. C']);
  assert.deepEqual(team.filter((l) => l.ask).map((l) => l.ask!.n), [1, 2]);
  assert.deepEqual(taskLines({ ...task, minutes: undefined, corrections: 0, messages: 3 }, 2).slice(1), [
    '  3 messages from you',
    '  Trail now has 2 learnings for work like it:',
  ], 'only the figures there are');
  assert.deepEqual(learningLines(shown('C', false), 12).slice(1), ['      Keep MAX at 4.', '      Shrish, Oct 27'], 'lines under a 2-digit number line up');
});

test('prompts come from the code a learning names, never its title; a name from its text only with a file that holds it', () => {
  const holds = (file: string, sym: string) => file === 'src/retry.ts' && sym === 'backoffMs';
  assert.ok(!promptsFor({ touches: ['src/retry.ts#withRetry'], body: '- `backoffMs` doubles' }).some((p) => p.includes('backoffMs in')), 'no file said to hold it');
  assert.ok(!promptsFor({ touches: ['src/other.ts'], body: '- `backoffMs` doubles' }, holds).some((p) => p.includes('backoffMs in')), 'not in that file');
  const p = promptsFor({ touches: ['src/retry.ts#withRetry', 'test/retry.test.ts'], body: '- `backoffMs` doubles' }, holds);
  assert.deepEqual(p, [
    "I'm about to change withRetry in src/retry.ts. What should I know first?",
    "I'm about to change backoffMs in src/retry.ts. What should I know first?",
    "I'm about to change src/retry.ts. What should I know first?",
    "I'm about to change backoffMs. What should I know first?",
  ]);
  assert.deepEqual(promptsFor({ touches: [], body: 'no code named' }), []);
});

test('first prompt: the first listed learning and prompt the check passes, numbered as listed; none passing is none', () => {
  const a = note({ path: '/a', title: 'A', touches: ['src/a.ts'] });
  const b = note({ path: '/b', title: 'B', touches: ['src/b.ts'] });
  const only = (path: string) => (_r: string, _p: string, n: Pick<Note, 'path'>) => n.path === path;
  assert.deepEqual(firstPrompt('/r', [a, b], only('/b')), { prompt: "I'm about to change src/b.ts. What should I know first?", n: 2, title: 'B' });
  assert.equal(firstPrompt('/r', [a, b], () => false), null);
  assert.equal(firstPrompt('/r', [], () => true), null, 'nothing listed: the lookup instead');
});

test('the check is the prompt hook\'s own match: its learning first for the prompt, or no', () => {
  const { repo, env } = repoWith([{ name: '2026-10-27-retries.md', text: RETRY }, { name: '2026-10-29-cents.md', text: CENTS }]);
  withEnv(env, () => {
    const [retry, cents] = ['Retries', 'Payments'].map((t) => listNotes(repo).find((n) => n.title.startsWith(t))!);
    assert.equal(bringsUp(repo, "I'm about to change withRetry in src/retry.ts. What should I know first?", retry!), true);
    assert.equal(bringsUp(repo, "I'm about to change withRetry in src/retry.ts. What should I know first?", cents!), false, 'not the one it brings up');
    assert.equal(bringsUp(repo, 'rename the logo file', retry!), false);
  });
});

test('planned end to end: the last task, what bears on it, and a prompt that passes; no lookup then', () => {
  const { repo, env } = repoWith([{ name: '2026-10-27-retries.md', text: RETRY }, { name: '2026-10-29-cents.md', text: CENTS }]);
  withEnv(env, () => {
    const notes = listNotes(repo);
    const task = session('cafe1234-0000', '2026-11-03T10:00:00Z', ['the invoices are a cent off again, check how billing stores payments', 'use cents', 'ok ship it']);
    assert.deepEqual(learningsForTask(task, notes).map((h) => h.note.title), ['Payments are stored in cents, never floats, after a rounding bug']);
    const cents = notes.find((n) => n.title.startsWith('Payments'))!;
    const e = planEnding({ repo, notes, kept: [cents], sources: new Map([[cents.id!, ['cafe1234']]]), sessions: [task] });
    assert.equal(e.task?.what, 'the invoices are a cent off again, check how billing stores payments');
    assert.deepEqual(e.shown.map((s) => [s.note.title, s.from, s.group]), [['Payments are stored in cents, never floats, after a rounding bug', 'from that session', 'task']]);
    assert.equal(e.tryPrompt?.n, 1);
    assert.equal(bringsUp(repo, e.tryPrompt!.prompt, cents), true);
    assert.equal(e.lookup, null);
  });
});

test('no sessions, nothing kept: the team\'s committed learnings with whose and when, and a prompt checked to bring one up first', () => {
  const { repo, env } = repoWith([{ name: '2026-10-27-retries.md', text: RETRY }, { name: '2026-10-29-cents.md', text: CENTS }]);
  withEnv(env, () => {
    const notes = listNotes(repo);
    const e = planEnding({ repo, notes, kept: [], sessions: null });
    assert.equal(e.task, null);
    assert.deepEqual(e.shown.map((s) => [s.note.title, s.from, s.group]), [
      ['Payments are stored in cents, never floats, after a rounding bug', 'Anirudh, Oct 29', 'repo'],
      ['Retries stay at 4 because the gateway times out at 30 s', 'Shrish, Oct 27', 'repo'],
    ], 'newest first, whose and when');
    assert.ok(e.tryPrompt, 'a prompt passes');
    assert.equal(bringsUp(repo, e.tryPrompt!.prompt, e.shown[e.tryPrompt!.n - 1]!.note), true, 'the hook brings up the learning it names, first');
    assert.equal(e.lookup, null, 'no lookup when a prompt passes');
  });
});

test('the team\'s list: newest five, a passing one past them takes the last place, the person\'s own and branch ones left out', () => {
  const notes = Array.from({ length: 8 }, (_x, i) => note({ path: `/n${i}`, title: `N${i}`, date: `2026-10-${String(20 - i).padStart(2, '0')}`, scope: 'repo', touches: [`src/n${i}.ts`] }));
  const mine = note({ path: '/p', title: 'P', scope: 'personal', touches: ['src/p.ts'] });
  const branch = note({ path: 'origin/x:.trail/learnings/b.md', title: 'B', scope: 'repo', ref: 'origin/x', touches: ['src/b.ts'] });
  const passes = (path: string) => (_r: string, _p: string, n: Pick<Note, 'path'>) => n.path === path;
  const first = repoLearnings('/r', [mine, branch, ...notes], 'Rushabh', passes('/n1'));
  assert.deepEqual(first.shown.map((s) => s.note.title), ['N0', 'N1', 'N2', 'N3', 'N4']);
  assert.deepEqual(first.tryPrompt, { prompt: "I'm about to change src/n1.ts. What should I know first?", n: 2, title: 'N1' });
  const later = repoLearnings('/r', notes, 'Rushabh', passes('/n6'));
  assert.deepEqual(later.shown.map((s) => s.note.title), ['N0', 'N1', 'N2', 'N3', 'N6'], 'the one the prompt brings up is on the list');
  assert.equal(later.tryPrompt?.n, MAX_SHOWN);
  assert.equal(repoLearnings('/r', notes, 'Rushabh', () => false).tryPrompt, null, 'none passes: the lookup instead');
  assert.equal(repoLearnings('/r', [mine, branch], 'Rushabh', () => true).shown.length, 0);
});

test('nothing to show and no map: no task, no list, no prompt, no lookup, and no throw', () => {
  const { repo, env } = repoWith([]);
  withEnv(env, () => {
    assert.deepEqual(planEnding({ repo, notes: [], kept: [], sessions: null }), { task: null, shown: [], tryPrompt: null, lookup: null });
  });
});

test('the try lines: the prompt, else the lookup\'s top file:line and tokens saved, else nothing', () => {
  assert.deepEqual(tryLines({ tryPrompt: { prompt: 'p', n: 2, title: 'T' }, lookup: null }), [
    '', 'Try it now. Start a new Claude Code session here and paste:', '  "p"', '  Trail hands Claude learning 2 with it, before Claude reads any code.',
  ]);
  assert.deepEqual(tryLines({ tryPrompt: null, lookup: { question: 'how does runInit work', top: 'src/cli.ts:L10-L90', saved: 52_699, pct: 95, files: 8 } }), [
    '',
    'Try it now. Trail just answered "how does runInit work" from this repo\'s map:',
    '  src/cli.ts:L10-L90',
    '  ~52,699 tokens saved (95%) against reading the 8 files whole',
    '  Ask Claude the same in a new session here: it starts from that answer instead of reading files.',
  ]);
  assert.deepEqual(tryLines({ tryPrompt: null, lookup: null }), []);
});

/** A terminal for sayEnding, said lines and asks on one screen as init's stderr has them: each "right? (y/n)" gets the next key. */
function terminal(keys: string[]): { io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }; say: (l: string) => void; out: () => string } {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  let text = '';
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      if (String(chunk).endsWith('right? (y/n) ')) setImmediate(() => (stdin as unknown as PassThrough).write(keys.shift() ?? '\x1b'));
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  return { io: { stdin, stdout }, say: (l) => (text += `${l}\n`), out: () => text };
}

test('right? (y/n): y and n saved on this machine by learning id, n says Claude still reads it, enter skips', async () => {
  const { repo, env } = repoWith([]);
  const shown = (id: string, title: string): Shown => ({ note: note({ id, title, path: `/r/${id}.md` }), line: 'one line', from: 'Shrish, Oct 27', group: 'kept' });
  const e: Ending = { task: null, shown: [shown('l-aaaa1111', 'A'), shown('l-bbbb2222', 'B'), shown('l-cccc3333', 'C')], tryPrompt: { prompt: 'p', n: 1, title: 'A' }, lookup: null };
  const t = terminal(['y', 'n', '\r']);
  const tally = await sayEnding(e, repo, { say: t.say, io: t.io, env });
  const said = t.out().split('\n');
  assert.deepEqual(tally, { answered: 2, right: 1 });
  assert.match(t.out(), /1\. A\n {5}one line\n {5}Shrish, Oct 27 · right\? \(y\/n\) y\n/);
  assert.match(t.out(), /Shrish, Oct 27 · right\? \(y\/n\) n\n/);
  assert.ok(said.includes("     saved on this laptop · Claude still reads it until a new learning replaces it: tell Claude what's wrong and it saves one"));
  const saved = JSON.parse(readFileSync(checksPath(repo, env), 'utf8')) as { checks: Record<string, { right: boolean }> };
  assert.deepEqual(Object.fromEntries(Object.entries(saved.checks).map(([k, v]) => [k, v.right])), { 'l-aaaa1111': true, 'l-bbbb2222': false });
  assert.ok(said.includes('  "p"'), 'the try lines come after');
});

test('esc stops asking and the rest are listed; with no terminal nothing is asked', async () => {
  const { repo, env } = repoWith([]);
  const shown = (id: string): Shown => ({ note: note({ id, title: id, path: `/r/${id}.md` }), line: '', from: 'x', group: 'kept' });
  const e: Ending = { task: null, shown: [shown('l-1'), shown('l-2')], tryPrompt: null, lookup: null };
  const t = terminal(['\x1b']);
  assert.deepEqual(await sayEnding(e, repo, { say: t.say, io: t.io, env }), { answered: 0, right: 0 });
  assert.equal(t.out().match(/right\?/g)?.length, 1);
  const said = t.out().split('\n');
  assert.ok(said.includes('     x'), 'the second is still listed');
  const plain: string[] = [];
  await sayEnding(e, repo, { say: (l) => plain.push(l), env });
  assert.ok(!plain.some((l) => l.includes('right?')));
});

test('epilogue: under trail a checked prompt replaces "code as usual"; graft\'s stays byte for byte', () => {
  const before = process.env.TRAIL_INVOKED_AS;
  try {
    delete process.env.TRAIL_INVOKED_AS;
    const graft = formatInitEpilogue({ graphBuilt: true, nodes: 4, edges: 4 });
    assert.equal(formatInitEpilogue({ graphBuilt: true, nodes: 4, edges: 4, tryPrompt: 'p' }), graft);
    process.env.TRAIL_INVOKED_AS = 'trail';
    const trail = formatInitEpilogue({ graphBuilt: true, nodes: 4, edges: 4, tryPrompt: "I'm about to change src/retry.ts. What should I know first?" });
    assert.match(trail, /2\. try it\s+paste "I'm about to change src\/retry\.ts\. What should I know first\?"\n\s+Trail hands Claude a learning with it/);
    assert.doesNotMatch(trail, /code as usual/);
    assert.match(formatInitEpilogue({ graphBuilt: true, nodes: 4, edges: 4 }), /code as usual/, 'no prompt, no change');
  } finally {
    if (before === undefined) delete process.env.TRAIL_INVOKED_AS;
    else process.env.TRAIL_INVOKED_AS = before;
  }
});
