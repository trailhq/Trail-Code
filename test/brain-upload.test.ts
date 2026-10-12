/**
 * The full digest goes up gzipped, and in retried 1 MiB chunks when Trail says
 * it takes them. What matters: the chunks reassemble into exactly the gzip of
 * the body a single POST would have sent, a blip costs one chunk rather than
 * the push, and an older Trail still gets the plain POST it always did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { uploadDigest, uploadChunked, RETRY_DELAYS_MS } from '../src/brain/upload.js';
import { fetchExpectedRepo, pushEarlyDigest, uploadCaps } from '../src/brain/push.js';
import type { RepoDigest } from '../src/app/history.js';
import type { BrainLink } from '../src/brain/link.js';

const link = { brainId: 'b1', token: 'gbt_1.x', baseUrl: 'http://trail.test' } as unknown as BrainLink;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A digest big enough to need several chunks at a small chunk size. */
function digest(): RepoDigest {
  return {
    provider: 'github',
    owner: 'chalk',
    name: 'chalk',
    head_sha: 'abc',
    default_branch: 'main',
    is_private: false,
    commits: Array.from({ length: 400 }, (_, i) => ({
      sha: `${i}`.padStart(40, '0'),
      subject: `commit ${i} ${Math.random().toString(36)}`,
      body: '',
      files: [`src/${i}.ts`],
      symbols: [],
    })),
    threads: [],
    symbols: [],
    sources: [],
    auto_approve: true,
  };
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function recorder(respond: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (u: string, init?: RequestInit) => {
    const c: Call = {
      method: init?.method ?? 'GET',
      url: u,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    };
    calls.push(c);
    return respond(c, calls.length);
  }) as typeof fetch;
  return { calls, f };
}

const noSleep = { sleep: async () => {} };

test('chunks reassemble into the gzip of exactly the body a single POST would send', async () => {
  const d = digest();
  const chunks = new Map<number, Buffer>();
  let opened: Record<string, unknown> = {};
  const { calls, f } = recorder((c) => {
    if (c.method === 'POST' && c.url.endsWith('/repo/uploads')) {
      opened = JSON.parse(String(c.body));
      return json({ upload_id: 'u-1' }, 201);
    }
    const m = /\/uploads\/u-1\/chunks\/(\d+)$/.exec(c.url);
    if (c.method === 'PUT' && m) {
      chunks.set(Number(m[1]), Buffer.from(c.body as Uint8Array));
      return new Response(null, { status: 204 });
    }
    if (c.url.endsWith('/uploads/u-1/complete')) return json({ repo: {}, job_id: 'job-9', status: 'queued' }, 202);
    return json({ error: 'unexpected' }, 500);
  });

  const got = await uploadDigest(link, d, { gzip: true, chunked: true }, { fetchImpl: f, chunkBytes: 2048, ...noSleep });
  assert.deepEqual(got, { jobId: 'job-9' });

  assert.equal(opened.stage, 'full');
  assert.equal(opened.auto_approve, true);
  assert.equal(opened.chunks, chunks.size);
  assert.ok(chunks.size > 1, 'the test digest must need more than one chunk');
  const joined = Buffer.concat([...chunks.keys()].sort((a, b) => a - b).map((i) => chunks.get(i)!));
  assert.equal(opened.bytes, joined.length);
  assert.equal(gunzipSync(joined).toString('utf8'), JSON.stringify(d));

  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.headers['content-type'], 'application/octet-stream');
  assert.equal(put.headers.authorization, 'Bearer gbt_1.x');
  assert.match(put.url, /^http:\/\/trail\.test\/api\/public\/brains\/b1\/repo\/uploads\/u-1\/chunks\/\d+$/);
});

test('a chunk that fails is retried on its own, on 5xx, 429 and network errors', async () => {
  const attempts = new Map<string, number>();
  const waits: number[] = [];
  const { f } = recorder((c) => {
    if (c.url.endsWith('/repo/uploads')) return json({ upload_id: 'u-2' }, 201);
    if (c.method === 'PUT') {
      const n = (attempts.get(c.url) ?? 0) + 1;
      attempts.set(c.url, n);
      if (c.url.endsWith('/chunks/1')) {
        if (n === 1) return json({ error: 'busy' }, 503);
        if (n === 2) return json({ error: 'slow down' }, 429);
        if (n === 3) throw new Error('ECONNRESET');
      }
      return new Response(null, { status: 204 });
    }
    return json({ job_id: 'job-2' }, 202);
  });
  const got = await uploadChunked(link, digest(), {
    fetchImpl: f,
    chunkBytes: 2048,
    sleep: async (ms) => void waits.push(ms),
  });
  assert.deepEqual(got, { jobId: 'job-2' });
  assert.equal(attempts.get('http://trail.test/api/public/brains/b1/repo/uploads/u-2/chunks/1'), 4);
  assert.equal(attempts.get('http://trail.test/api/public/brains/b1/repo/uploads/u-2/chunks/0'), 1, 'the others went once');
  assert.deepEqual(waits, [500, 1000, 2000], 'backoff doubles from half a second');
});

test('a chunk that keeps failing gives up after four retries and says which part', async () => {
  let tries = 0;
  const { f } = recorder((c) => {
    if (c.url.endsWith('/repo/uploads')) return json({ upload_id: 'u-3' }, 201);
    if (c.method === 'PUT') {
      tries++;
      return json({ error: 'down' }, 502);
    }
    return json({ job_id: 'never' }, 202);
  });
  const got = await uploadChunked(link, digest(), { fetchImpl: f, chunkBytes: 1 << 20, ...noSleep });
  assert.ok('error' in got && /part 1 of 1: 502/.test(got.error), JSON.stringify(got));
  assert.equal(tries, RETRY_DELAYS_MS.length + 1);
});

test('complete is retried on 5xx, and returns today\'s ingest response', async () => {
  let completes = 0;
  const { f } = recorder((c) => {
    if (c.url.endsWith('/repo/uploads')) return json({ upload_id: 'u-4' }, 201);
    if (c.method === 'PUT') return new Response(null, { status: 204 });
    completes++;
    return completes < 3 ? json({ error: 'hiccup' }, 500) : json({ repo: {}, job_id: 'job-4', status: 'queued' }, 202);
  });
  assert.deepEqual(await uploadChunked(link, digest(), { fetchImpl: f, ...noSleep }), { jobId: 'job-4' });
  assert.equal(completes, 3);
});

test('a 409 from complete is passed on as a refusal, as the single POST would be', async () => {
  const { f } = recorder((c) => {
    if (c.url.endsWith('/repo/uploads')) return json({ upload_id: 'u-5' }, 201);
    if (c.method === 'PUT') return new Response(null, { status: 204 });
    return json({ error: 'an ingest is already running' }, 409);
  });
  const got = await uploadChunked(link, digest(), { fetchImpl: f, ...noSleep });
  assert.ok('error' in got && /409 .*already running/.test(got.error));
});

test('a complete lost on the way back, then told 409 on its retry, counts as started', async () => {
  let completes = 0;
  const { f } = recorder((c) => {
    if (c.url.endsWith('/repo/uploads')) return json({ upload_id: 'u-6' }, 201);
    if (c.method === 'PUT') return new Response(null, { status: 204 });
    completes++;
    if (completes === 1) throw new Error('socket hang up');
    return json({ error: 'an ingest is already running' }, 409);
  });
  assert.deepEqual(await uploadChunked(link, digest(), { fetchImpl: f, ...noSleep }), { jobId: '' });
});

test('a server that advertised chunks but has no route falls back to the single POST', async () => {
  const { calls, f } = recorder((c) => {
    if (c.url.endsWith('/repo/uploads')) return json({ error: 'not found' }, 404);
    return json({ job_id: 'job-7' }, 202);
  });
  const got = await uploadDigest(link, digest(), { chunked: true, gzip: true }, { fetchImpl: f, ...noSleep });
  assert.deepEqual(got, { jobId: 'job-7' });
  const post = calls.at(-1)!;
  assert.equal(post.url, 'http://trail.test/api/public/brains/b1/repo');
  assert.equal(post.headers['content-encoding'], 'gzip');
});

test('an older Trail gets the plain POST it always did', async () => {
  const d = digest();
  const { calls, f } = recorder(() => json({ job_id: 'job-8' }, 202));
  assert.deepEqual(await uploadDigest(link, d, {}, { fetchImpl: f }), { jobId: 'job-8' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['content-encoding'], undefined);
  assert.equal(calls[0].body, JSON.stringify(d));
});

test('gzip alone is one gzipped POST of the same body', async () => {
  const d = digest();
  const { calls, f } = recorder(() => json({ job_id: 'job-10' }, 202));
  await uploadDigest(link, d, { gzip: true }, { fetchImpl: f });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(Buffer.from(calls[0].body as Uint8Array)).toString('utf8'), JSON.stringify(d));
});

test('the early upload is gzipped only when Trail says it takes gzip', async () => {
  const { calls, f } = recorder(() => json({ early: true }, 202));
  assert.equal(await pushEarlyDigest(link, digest(), f, { gzip: true }), true);
  assert.equal(calls[0].headers['content-encoding'], 'gzip');
  assert.match(calls[0].url, /\/repo\?stage=early$/);
  await pushEarlyDigest(link, digest(), f);
  assert.equal(calls[1].headers['content-encoding'], undefined);
});

test('the capability flags are read off the expected-repo response, and default to off', async () => {
  const older = await fetchExpectedRepo(link, (async () => json({ repo: { slug: 'chalk/chalk' } })) as typeof fetch);
  assert.deepEqual(uploadCaps(older), { gzip: false, chunked: false });
  assert.equal(older?.events, false);
  const newer = await fetchExpectedRepo(link, (async () =>
    json({ repo: { slug: 'chalk/chalk', rule_count: 12 }, gzip_upload: true, chunked_upload: true, events: true })) as typeof fetch);
  assert.deepEqual(uploadCaps(newer), { gzip: true, chunked: true });
  assert.equal(newer?.events, true);
  assert.equal(newer?.ruleCount, 12);
});

test('every call honours GRAFT_BRAIN_URL', async () => {
  const before = process.env.GRAFT_BRAIN_URL;
  process.env.GRAFT_BRAIN_URL = 'https://staging-agents.test/';
  try {
    const { calls, f } = recorder((c) => {
      if (c.url.endsWith('/repo/uploads')) return json({ upload_id: 'u-9' }, 201);
      if (c.method === 'PUT') return new Response(null, { status: 204 });
      return json({ job_id: 'j' }, 202);
    });
    await uploadChunked(link, digest(), { fetchImpl: f, ...noSleep });
    for (const c of calls) assert.ok(c.url.startsWith('https://staging-agents.test/api/public/brains/b1/repo/uploads'), c.url);
  } finally {
    if (before === undefined) delete process.env.GRAFT_BRAIN_URL;
    else process.env.GRAFT_BRAIN_URL = before;
  }
});
