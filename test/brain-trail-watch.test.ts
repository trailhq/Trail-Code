/**
 * `graft trail watch` replaces a polling loop agents used to write for
 * themselves, so what matters is when it stops and what it says when it does:
 * suggestions with nothing accepted stop it at once, accepted changes stop it
 * only once they hold still, a timeout is its own exit code, and a failed read
 * is retried rather than reported. Trail is faked at the fetch layer, as in the
 * pull tests, and the clock is faked so an hour's watch takes no time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  filesSummary,
  readTrailSnapshot,
  watchExitCode,
  watchExitJson,
  watchExitLines,
  watchTrail,
  type WatchTrailOptions,
  withWatchHeader,
} from '../src/brain/watch-trail.js';
import type { BrainLink } from '../src/brain/link.js';
import { runCli, tmpRepo } from './helpers.js';

const link = { brainId: 'b1', token: 'gbt_1.x', baseUrl: 'http://trail.test' } as unknown as BrainLink;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** What Trail holds on one read. */
interface TrailView {
  /** CLAUDE.md suggestions Trail has made (the counts on GET /repo). */
  suggested?: number;
  claudeMd?: unknown[];
  files?: unknown[];
  /** Make this read fail: a thrown fetch (the network), or a status. */
  fail?: 'network' | number;
}

/** A Trail that answers each read from the next view in `views`, holding the last. */
function fakeTrail(views: TrailView[]) {
  let read = 0;
  let current: TrailView = views[0]!;
  const f = (async (u: string) => {
    const path = new URL(u).pathname;
    // Each read asks for /repo, /claude-md and /context-files, in that order
    // and all at once; the first of them is what moves to the next view.
    if (path.endsWith('/repo')) current = views[Math.min(read++, views.length - 1)]!;
    if (current.fail === 'network') throw new TypeError('fetch failed');
    if (typeof current.fail === 'number') return json({ error: 'no' }, current.fail);
    if (path.endsWith('/claude-md')) return json({ path: 'CLAUDE.md', head_sha: 'abc', changes: current.claudeMd ?? [] });
    if (path.endsWith('/context-files')) return json({ head_sha: 'abc', files: current.files ?? [] });
    if (path.endsWith('/repo')) {
      return json({ repo: { status: 'completed', rule_count: 10 }, claude_md: { status: 'ready', changes: current.suggested ?? 0 } });
    }
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;
  return { f, reads: () => read };
}

/** A clock that only moves when the watch sleeps. */
function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), elapsed: () => t - 1_000_000 };
}

const COMMANDS = { id: 'm1', kind: 'edit', heading: 'Commands', find: '', text: '- `npm run lint`' };
const TESTING = { id: 'm2', kind: 'add', heading: 'Testing', after_heading: 'Commands', text: 'node:test.' };
const SEO = { kind: 'folder_claude_md', path: 'web/CLAUDE.md', changes: [{ id: 'w1', kind: 'edit', heading: 'SEO metadata', find: '', text: 'Every page sets a title.' }] };

function repoWithClaudeMd(tag: string): string {
  const root = tmpRepo(tag);
  put(root, 'CLAUDE.md', '# app\n\n## Commands\n\n- `npm test`\n');
  return root;
}

function opts(f: typeof fetch, clock: ReturnType<typeof fakeClock>, extra: Partial<WatchTrailOptions> = {}): WatchTrailOptions {
  return { wired: ['claude'], fetchImpl: f, now: clock.now, sleep: clock.sleep, ...extra };
}

test('suggestions with nothing accepted end the watch on the first read', async () => {
  const root = repoWithClaudeMd('watch-suggested');
  const { f, reads } = fakeTrail([{ suggested: 5 }]);
  const clock = fakeClock();
  const r = await watchTrail(root, link, opts(f, clock));
  assert.equal(r.reason, 'suggestions');
  assert.equal(reads(), 1);
  assert.equal(watchExitCode(r), 0);
  const lines = watchExitLines(r, 3_600_000);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '● 5 suggestions are waiting for review');
  assert.equal(lines[1], `  review: ${r.reviewUrl}`);
  assert.match(r.reviewUrl, /\/brain\/b1\/context-files$/);
});

test('--accepted-only waits through suggestions, then times out with exit code 2', async () => {
  const root = repoWithClaudeMd('watch-accepted-only');
  const { f, reads } = fakeTrail([{ suggested: 5 }]);
  const clock = fakeClock();
  const r = await watchTrail(root, link, opts(f, clock, { acceptedOnly: true, intervalMs: 60_000, timeoutMs: 60 * 60_000 }));
  assert.equal(r.reason, 'timeout');
  assert.equal(watchExitCode(r), 2);
  assert.equal(clock.elapsed(), 60 * 60_000, 'the last read is at the deadline, not past it');
  assert.equal(reads(), 61, 'one read a minute, plus the one at the start');
  const lines = watchExitLines(r, 60 * 60_000);
  assert.equal(lines[0], '· still waiting after 60 minutes: 5 suggested, 0 accepted');
  assert.match(lines[1]!, /^ {2}review: \S+\/brain\/b1\/context-files$/);
});

test('accepted changes are reported only once they have held still for --settle', async () => {
  const root = repoWithClaudeMd('watch-accepted');
  const { f, reads } = fakeTrail([{ suggested: 9, claudeMd: [COMMANDS, TESTING], files: [SEO] }]);
  const clock = fakeClock();
  const r = await watchTrail(root, link, opts(f, clock, { settleMs: 60_000, intervalMs: 60_000 }));
  assert.equal(r.reason, 'accepted');
  assert.equal(reads(), 2, 'not on the first read, which may be someone mid-review');
  assert.equal(r.accepted, 3);
  assert.equal(watchExitCode(r), 0);
  assert.deepEqual(watchExitLines(r, 3_600_000), [
    '✓ 3 accepted changes are ready: CLAUDE.md (Commands, Testing), web/CLAUDE.md (SEO metadata)',
    '  run graft trail pull to write them',
  ]);
});

test('a change to the accepted set starts the settle over', async () => {
  const root = repoWithClaudeMd('watch-resettle');
  const { f, reads } = fakeTrail([
    { claudeMd: [COMMANDS] },
    { claudeMd: [COMMANDS, TESTING] },
    { claudeMd: [TESTING] }, // same count as the first read, different change
    { claudeMd: [TESTING] },
  ]);
  const clock = fakeClock();
  const r = await watchTrail(root, link, opts(f, clock, { settleMs: 60_000, intervalMs: 60_000 }));
  assert.equal(r.reason, 'accepted');
  assert.equal(reads(), 4);
  assert.deepEqual(watchExitLines(r, 3_600_000), ['✓ 1 accepted change is ready: CLAUDE.md (Testing)', '  run graft trail pull to write it']);
});

test('changes already in the files are not waiting for anything', async () => {
  const root = tmpRepo('watch-present');
  put(root, 'CLAUDE.md', '# app\n\n## Testing\n\nnode:test.\n');
  const snap = await readTrailSnapshot(root, link, ['claude'], fakeTrail([{ suggested: 1, claudeMd: [{ ...TESTING, after_heading: '' }] }]).f);
  assert.ok(snap.ok);
  assert.equal(snap.snapshot.accepted, 0);
  assert.equal(snap.snapshot.suggested, 1);
});

test('a failed read is retried on the next tick instead of ending the watch', async () => {
  const root = repoWithClaudeMd('watch-retry');
  const { f, reads } = fakeTrail([{ fail: 'network' }, { fail: 502 }, { suggested: 2 }]);
  const clock = fakeClock();
  const ticks: boolean[] = [];
  const r = await watchTrail(root, link, opts(f, clock, { onTick: (t) => ticks.push(t.ok) }));
  assert.equal(r.reason, 'suggestions');
  assert.equal(reads(), 3);
  assert.deepEqual(ticks, [false, false, true]);
  assert.deepEqual(watchExitLines(r, 3_600_000)[0], '● 2 suggestions are waiting for review');
});

test('a token Trail refuses ends the watch at once, with exit code 1', async () => {
  const root = repoWithClaudeMd('watch-refused');
  const { f, reads } = fakeTrail([{ fail: 401 }]);
  const r = await watchTrail(root, link, opts(f, fakeClock()));
  assert.equal(r.reason, 'refused');
  assert.equal(reads(), 1);
  assert.equal(watchExitCode(r), 1);
  assert.match(watchExitLines(r, 3_600_000).join('\n'), /✗ Trail refused the pull: 401[\s\S]*graft trail connect/);
});

test('a Trail never reached times out saying so', async () => {
  const root = repoWithClaudeMd('watch-unreachable');
  const { f } = fakeTrail([{ fail: 'network' }]);
  const r = await watchTrail(root, link, opts(f, fakeClock(), { timeoutMs: 5 * 60_000 }));
  assert.equal(r.reason, 'timeout');
  assert.equal(watchExitCode(r), 2);
  assert.deepEqual(watchExitLines(r, 5 * 60_000), ['· still waiting after 5 minutes: could not reach Trail']);
});

test('--json carries the same ending', async () => {
  const root = repoWithClaudeMd('watch-json');
  const { f } = fakeTrail([{ suggested: 4, claudeMd: [COMMANDS] }]);
  const clock = fakeClock();
  const r = await watchTrail(root, link, opts(f, clock, { settleMs: 0 }));
  assert.deepEqual(watchExitJson(r), {
    reason: 'accepted',
    suggested: 4,
    accepted: 1,
    files: [{ path: 'CLAUDE.md', headings: ['Commands'] }],
    review_url: r.reviewUrl,
    waited_s: 0,
  });
});

test('a whole-file change names its file and no section', () => {
  assert.equal(filesSummary([{ path: '.cursor/rules/money.mdc', headings: [] }, { path: 'CLAUDE.md', headings: ['Money'] }]), '.cursor/rules/money.mdc, CLAUDE.md (Money)');
});

test('graft trail watch on a repo with no trail exits 1 at once, and --help documents it', () => {
  const root = tmpRepo('watch-cli-unlinked');
  const run = runCli(['trail', 'watch', root, '--json'], { home: root });
  assert.equal(run.status, 1, run.describe());
  assert.equal(JSON.parse(run.stdout).reason, 'no_trail');

  const help = runCli(['trail', 'watch', '--help'], { home: root });
  assert.equal(help.status, 0, help.describe());
  assert.match(help.stdout, /Wait until Trail has suggestions to review or accepted changes to pull/);
  assert.match(help.stdout, /--accepted-only/);
  assert.match(help.stdout, /exit 2/);
});

// Trail tells the page that Claude Code is watching from this header; a watch
// must send it on every read, and a manual pull must not (it uses gatherPull
// with a plain fetch).
test('withWatchHeader adds X-Graft-Watch to every request and keeps the rest', async () => {
  const seen: Headers[] = [];
  const inner = (async (_u: string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const f = withWatchHeader(inner);
  await f('http://trail.test/a', { headers: { authorization: 'Bearer t', accept: 'application/json' } });
  await f('http://trail.test/b');
  assert.equal(seen[0]!.get('x-graft-watch'), '1');
  assert.equal(seen[0]!.get('authorization'), 'Bearer t');
  assert.equal(seen[1]!.get('x-graft-watch'), '1');
});
