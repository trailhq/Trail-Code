/**
 * A learning may be stale when a file under its `touches:` is gone from the
 * checkout, or a `file#Symbol`'s file no longer has the symbol's name as a
 * whole word. It is marked where it's shown, so Claude checks it before
 * following it, and the same list goes to Trail Cloud at sync.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { learningsPayload, syncIsDue, syncRepo } from '../src/cloud/workspace-sync.js';
import type { Cloud } from '../src/cloud/workspace.js';
import { standingDirective } from '../src/claude/format.js';
import { formatNoteHits, type Note } from '../src/notes/notes.js';
import { goneTouches, markStale } from '../src/notes/stale.js';
import { EVENTS } from '../src/telemetry/contract.js';
import { tmpRepo } from './helpers.js';

const BODY = '## Decided\n- Retry with jitter.\n';
const note = (touches: string[], extra: Partial<Note> = {}): Note => ({ path: '/r/.trail/learnings/a.md', id: 'l-1234abcd', title: 'Retry with jitter', author: 'Priya', date: '2026-10-07', touches, body: BODY, scope: 'repo', ...extra });

/** A checkout with src/retry.ts (`withJitter`, `Backoff.delay`), a docs folder and README.md. */
function repo(): string {
  const dir = tmpRepo('stale');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'src', 'retry.ts'), 'export function withJitter() {}\nclass Backoff { delay() {} }\n// withJitterLegacy was removed\n');
  writeFileSync(join(dir, 'README.md'), '# r\n');
  return dir;
}

test('a touched file or folder the checkout has is there; one it lacks is gone', () => {
  const dir = repo();
  assert.deepEqual(goneTouches(note(['src/retry.ts', 'README.md', 'docs', 'src/gone.ts']), dir), ['src/gone.ts']);
});

test("a touched symbol is gone when its file's text no longer has it as a whole word", () => {
  const dir = repo();
  assert.deepEqual(goneTouches(note(['src/retry.ts#withJitter', 'src/retry.ts#withBackoff', 'src/retry.ts#Backoff.delay', 'src/retry.ts#Backoff.delay~2']), dir), ['src/retry.ts#withBackoff']);
  assert.deepEqual(goneTouches(note(['src/retry.ts#Legacy', 'src/gone.ts#withJitter']), dir), ['src/retry.ts#Legacy', 'src/gone.ts#withJitter'], 'part of a longer word is not the word');
});

test("a teammate's unmerged learning isn't judged, nor a folder's symbol", () => {
  const dir = repo();
  assert.deepEqual(goneTouches(note(['src/gone.ts'], { ref: 'origin/kumar/jitter' }), dir), []);
  assert.deepEqual(goneTouches(note(['docs#anything']), dir), []);
});

test('markStale sets and clears the mark, and ask shows it under the title', () => {
  const dir = repo();
  const [stale, fine] = markStale([note(['src/gone.ts']), note(['src/retry.ts'], { stale: ['old'] })], dir);
  assert.deepEqual(stale!.stale, ['src/gone.ts']);
  assert.equal(fine!.stale, undefined);
  const lines = formatNoteHits([{ note: stale!, score: 1, shared: [] }]);
  assert.match(lines[0]!, /· Retry with jitter$/);
  assert.match(lines[1]!, /^ {2}may be stale {2}src\/gone\.ts is gone from the code\. Check it against the code before you follow it; .*trail note --replaces l-1234abcd$/);
  assert.doesNotMatch(formatNoteHits([{ note: fine!, score: 1, shared: [] }]).join('\n'), /may be stale/);
});

test("a gone file's gone symbol is named once", () => {
  const lines = formatNoteHits([{ note: note([], { stale: ['src/retry.ts', 'src/retry.ts#withJitter'] }), score: 1, shared: [] }]);
  assert.match(lines[1]!, /may be stale {2}src\/retry\.ts#withJitter is gone from the code\./);
});

test('the session-start list marks a stale standing learning', () => {
  const text = standingDirective([note(['src/gone.ts', 'src/a.ts', 'src/b.ts'], { standing: true, stale: ['src/gone.ts', 'src/a.ts', 'src/b.ts'] })]);
  assert.match(text, /\n {4}may be stale: src\/gone\.ts, src\/a\.ts and 1 more are gone from the code\./);
});

test('a sync sends each committed learning\'s missing touches, and goes again when that list changes', async () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'stale-sync-home-'));
  const d = repo();
  const git = (...args: string[]) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@acme.test', ...args], { cwd: d, encoding: 'utf8' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/acme/billing.git');
  mkdirSync(join(d, '.trail', 'learnings'), { recursive: true });
  writeFileSync(join(d, '.trail', 'learnings', '2026-10-07-jitter-t.md'), '---\ntitle: Retry with jitter\nauthor: t\ndate: 2026-10-07\ntouches:\n  - src/retry.ts#withJitter\n  - README.md\n---\n\n## Decided\n- Jitter.\n');
  git('add', '-A');
  git('commit', '-qm', 'learning');
  assert.deepEqual(learningsPayload(d)!.map((l) => l.missing), [[]], 'checked, all there');

  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return new Response(JSON.stringify({ repo: body.repo.key, learnings: body.learnings.length, added: 0 }), { status: 200 });
  }) as typeof fetch;
  const cloud: Cloud = { url: 'http://trail.test', token: 'trl_x', user: { name: 't', email: 't@acme.test' }, workspace: { id: 'w', name: 'Acme', slug: 'acme', url: 'http://trail.test/w/acme', invite_url: 'http://trail.test/join/x' }, repos: ['github.com/acme/billing'], linkedAt: 0 };
  await syncRepo(d, cloud, { fetch: false, fetchImpl });
  assert.deepEqual(bodies[0].learnings[0].missing, []);
  assert.equal(syncIsDue(d), false);

  rmSync(join(d, 'src', 'retry.ts'));
  assert.equal(syncIsDue(d), true, 'the learning is unchanged, but the code it names went');
  assert.deepEqual(learningsPayload(d)![0]!.missing, ['src/retry.ts#withJitter']);
});

test('query may carry how many shown learnings may be stale', () => {
  assert.ok(EVENTS.query!.has('stale'));
});
