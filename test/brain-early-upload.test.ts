/**
 * The early upload sends the instruction file and the newest pull requests
 * before the rest of the history, so Trail's first CLAUDE.md suggestions start
 * while the full read is still on this machine. Two things make that safe, and
 * both are tested here: it is only sent to a brain that says it takes it, and
 * the full read does not ask GitHub again for threads the early one read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchExpectedRepo, pushEarlyDigest } from '../src/brain/push.js';
import { newThreadReadCache, readThreads, THREAD_FETCH_CONCURRENCY, type HistoryThread, type RepoDigest } from '../src/app/history.js';
import type { BrainLink } from '../src/brain/link.js';

const link = { brainId: 'b1', token: 'gbt_1.x', baseUrl: 'http://trail.test' } as unknown as BrainLink;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// --- only to a brain that takes it -------------------------------------------

// An older Trail ignores ?stage=early and would read the partial history as a
// whole ingest, then refuse the real one as already running. So the flag is
// read, and absent means no.
test('a brain that does not say it takes the early upload is not sent one', async () => {
  const older = await fetchExpectedRepo(link, (async () => json({ repo: { slug: 'chalk/chalk', status: 'pending' } })) as typeof fetch);
  assert.equal(older?.earlyUpload, false);

  const newer = await fetchExpectedRepo(link, (async () =>
    json({ repo: { slug: 'chalk/chalk', status: 'pending' }, early_upload: true })) as typeof fetch);
  assert.equal(newer?.earlyUpload, true);
});

test('the early upload is posted with ?stage=early and reports whether Trail took it', async () => {
  let url = '';
  const took = await pushEarlyDigest(link, { owner: 'chalk', name: 'chalk' } as RepoDigest, (async (u: string) => {
    url = u;
    return json({ early: true }, 202);
  }) as typeof fetch);
  assert.equal(took, true);
  assert.match(url, /\/api\/public\/brains\/b1\/repo\?stage=early$/);

  const ignored = await pushEarlyDigest(link, {} as RepoDigest, (async () => json({ early: false }, 202)) as typeof fetch);
  assert.equal(ignored, false, 'a brain without the CLAUDE.md step accepts and ignores it');

  const refused = await pushEarlyDigest(link, {} as RepoDigest, (async () => json({ error: 'no' }, 409)) as typeof fetch);
  assert.equal(refused, false);

  const down = await pushEarlyDigest(link, {} as RepoDigest, (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch);
  assert.equal(down, false, 'best-effort: the full upload still does everything');
});

// --- no second read of the same threads --------------------------------------

test('the full read reuses threads the early upload already fetched', async () => {
  const fetched: string[] = [];
  const fake = (async (u: string) => {
    fetched.push(u);
    if (u.includes('/pulls?state=closed')) {
      return json(u.includes('page=1') ? [{ number: 2, title: 'two' }, { number: 1, title: 'one' }] : []);
    }
    return json([{ body: 'use the whole test script', user: { login: 'dev', type: 'User' } }]);
  }) as never;

  const early: HistoryThread = { number: 2, title: 'two', body: '', mergeSha: '', comments: [{ body: 'from the early read' }] };
  const threads = await readThreads('chalk', 'chalk', 'tok', fake, 'https://api.test', 200, new Map([[2, early]]));

  assert.equal(threads.find((t) => t.number === 2)?.comments[0]?.body, 'from the early read');
  assert.ok(threads.some((t) => t.number === 1), 'the rest is still read');
  assert.ok(!fetched.some((u) => /\/(issues|pulls)\/2\/comments/.test(u)), 'no comment request for #2');
  assert.ok(fetched.some((u) => /\/(issues|pulls)\/1\/comments/.test(u)));
});

// The early read and the full read share one cache, so a thread the early read
// is still fetching is waited on, not fetched again — and one with no
// discussion is remembered too, which a map of finished threads cannot say.
test('the early and full reads share every GitHub request, even ones in flight', async () => {
  const fetched: string[] = [];
  const fake = (async (u: string) => {
    fetched.push(u);
    await new Promise((r) => setTimeout(r, 5));
    if (u.includes('/pulls?state=closed')) {
      return json(/&page=1$/.test(u) ? Array.from({ length: 40 }, (_, i) => ({ number: 40 - i, title: `pr ${40 - i}` })) : []);
    }
    // Odd pull requests have no discussion at all.
    const n = Number(/\/(\d+)\/comments/.exec(u)?.[1]);
    return json(n % 2 ? [] : [{ body: `on #${n}`, user: { type: 'User' } }]);
  }) as never;

  const cache = newThreadReadCache();
  const [early, full] = await Promise.all([
    readThreads('chalk', 'chalk', 'tok', fake, 'https://api.test', 30, undefined, cache),
    readThreads('chalk', 'chalk', 'tok', fake, 'https://api.test', 200, undefined, cache),
  ]);
  assert.equal(early.length, 15);
  assert.equal(full.length, 20);
  const perThread = fetched.filter((u) => /\/issues\/\d+\/comments/.test(u));
  assert.equal(perThread.length, 40, 'each pull request asked about once, however many reads wanted it');
  assert.equal(fetched.filter((u) => u.includes('/pulls?state=closed') && /&page=1$/.test(u)).length, 1, 'the first page of the list is read once');
});

test('comment reads run in a pool, not in batches that wait for their slowest', async () => {
  let inFlight = 0;
  let peak = 0;
  const fake = (async (u: string) => {
    if (u.includes('/pulls?state=closed')) {
      return json(/&page=1$/.test(u) ? Array.from({ length: 60 }, (_, i) => ({ number: i + 1 })) : []);
    }
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return json([]);
  }) as never;
  await readThreads('chalk', 'chalk', 'tok', fake, 'https://api.test', 60);
  assert.equal(peak, THREAD_FETCH_CONCURRENCY * 2, 'two comment endpoints per pull request, 24 pull requests at once');
});
