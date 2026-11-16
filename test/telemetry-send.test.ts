/**
 * The send path, against a real local server rather than a mock.
 *
 * One path, `/batch/`, verified by probe against `events.nanonets.com` (401 to a
 * well-formed batch with a bad key — the path is there and parses the body).
 * These cover what the client does with each answer it can get back, since that
 * is what decides whether a week of events survives or is thrown away.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { buildBatch, sendBatch } from '../src/telemetry/send.js';
import { posthogHost } from '../src/telemetry/key.js';

interface Hit { path: string; body: any }

let server: Server;
let port = 0;
let hits: Hit[] = [];
/** Paths this stub pretends not to have, so a 404 can be provoked. */
let missing = new Set<string>();
/** Status to answer with on a path that does exist. */
let status = 200;

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (missing.has(req.url ?? '')) { res.writeHead(404); res.end('no such path'); return; }
      hits.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : null });
      res.writeHead(status); res.end('{"status":1}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  process.env.GRAFT_POSTHOG_KEY = 'phc_send_test';
  process.env.GRAFT_POSTHOG_HOST = `http://127.0.0.1:${port}`;
});

after(() => { server.close(); });

function reset(): void { hits = []; missing = new Set(); status = 200; }

const EVENTS = [{ event: 'query', properties: { command: 'ask' }, distinct_id: 'abc', timestamp: '2026-01-01T00:00:00Z' }];

test('the batch goes to /batch/, in one request', async () => {
  reset();
  const res = await sendBatch(EVENTS);
  assert.equal(res.ok, true);
  assert.deepEqual(hits.map((h) => h.path), ['/batch/']);
  assert.equal(hits[0].body.api_key, 'phc_send_test');
  assert.equal(hits[0].body.batch[0].event, 'query');
  assert.equal(hits[0].body.batch[0].properties.$process_person_profile, false);
});

test('a 404 is reported rather than retried elsewhere', async () => {
  reset();
  missing.add('/batch/');
  const res = await sendBatch(EVENTS);
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.deepEqual(hits, [], 'no second path is attempted');
});

test('a rejected key is reported as 401 — the state the probe produced', async () => {
  reset();
  status = 401;
  const res = await sendBatch(EVENTS);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.deepEqual(hits.map((h) => h.path), ['/batch/']);
});

test('a 500 is reported so the queue keeps the batch', async () => {
  reset();
  status = 500;
  const res = await sendBatch(EVENTS);
  assert.equal(res.status, 500);
});

test('an unreachable host is a transport error, not a path problem', async () => {
  reset();
  const saved = process.env.GRAFT_POSTHOG_HOST;
  process.env.GRAFT_POSTHOG_HOST = 'http://127.0.0.1:1';
  const res = await sendBatch(EVENTS);
  process.env.GRAFT_POSTHOG_HOST = saved;
  assert.equal(res.ok, false);
  assert.ok(res.error, 'a transport failure carries an error, not a status');
  assert.equal(res.status, undefined);
});

test('an empty batch is not a request', async () => {
  reset();
  assert.deepEqual(await sendBatch([]), { ok: true });
  assert.deepEqual(hits, []);
});

test('the default host is the one the other server-side integration uses', () => {
  const saved = process.env.GRAFT_POSTHOG_HOST;
  delete process.env.GRAFT_POSTHOG_HOST;
  assert.equal(posthogHost(), 'https://events.nanonets.com');
  process.env.GRAFT_POSTHOG_HOST = saved;
});

test('a trailing slash on the configured host does not produce a double slash', () => {
  const saved = process.env.GRAFT_POSTHOG_HOST;
  process.env.GRAFT_POSTHOG_HOST = 'https://events.nanonets.com///';
  assert.equal(posthogHost(), 'https://events.nanonets.com');
  process.env.GRAFT_POSTHOG_HOST = saved;
});

test('timestamp is the send time; the event keeps its own time as occurred_at', () => {
  const sentAt = new Date('2026-01-02T08:00:00Z');
  const [ev] = (buildBatch(EVENTS, sentAt) as { batch: any[] }).batch;
  assert.equal(ev.timestamp, '2026-01-02T08:00:00.000Z');
  assert.equal(ev.properties.occurred_at, '2026-01-01T00:00:00Z');
});

test('a batch sent now is stamped now, not when it was queued', async () => {
  reset();
  const start = Date.now();
  await sendBatch(EVENTS);
  const at = Date.parse(hits[0].body.batch[0].timestamp);
  assert.ok(at >= start && at <= Date.now(), 'timestamp is the moment of the POST');
  assert.equal(hits[0].body.batch[0].properties.occurred_at, '2026-01-01T00:00:00Z');
});

test('buildBatch still carries no key, whichever path is used', () => {
  assert.equal('api_key' in buildBatch(EVENTS), false);
});
