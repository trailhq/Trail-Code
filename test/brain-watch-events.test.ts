/**
 * The live watch: when Trail streams the build, the terminal follows it as it
 * happens instead of polling every four seconds. What matters is that the
 * stream is parsed exactly (keep-alives, split chunks, CRLF), that the suggestion
 * counts ride along, and that a stream which drops costs nothing but the old
 * polling behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoBody, SseParser, watchBuild } from '../src/brain/watch.js';

const LINK = { brainId: 'b1', token: 'gbt_1.sig', baseUrl: 'http://trail.test' };

// --- the parser ---------------------------------------------------------------

test('events are parsed across chunk boundaries, and keep-alives are dropped', () => {
  const p = new SseParser();
  assert.deepEqual(p.push(': ping\n\nevent: prog'), []);
  assert.deepEqual(p.push('ress\ndata: {"a":'), []);
  assert.deepEqual(p.push('1}\n\n'), [{ event: 'progress', data: '{"a":1}' }]);
  assert.deepEqual(p.push('event: done\r\ndata: {}\r\n\r\n'), [{ event: 'done', data: '{}' }]);
});

test('multi-line data is joined, and a missing event name means message', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: one\ndata:two\n\n'), [{ event: 'message', data: 'one\ntwo' }]);
});

test('a lone CR at the end of a chunk waits for its LF', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: x\r'), []);
  assert.deepEqual(p.push('\n\r\n'), [{ event: 'message', data: 'x' }]);
});

test('the suggestion counts are read whether Trail sends numbers or lists', () => {
  const counted = parseRepoBody({
    repo: { status: 'ingesting' },
    claude_md: { status: 'ready', quick_ready: true, changes: 3 },
    context_files: { files: 2, changes: 5 },
  });
  assert.deepEqual(counted?.suggestions, { claudeMd: 3, contextFiles: 5 });
  const listed = parseRepoBody({
    repo: { status: 'ingesting' },
    claude_md: { changes: [{}, {}] },
    context_files: { files: [{ kind: 'agents_md', path: 'AGENTS.md', changes: [{}, {}, {}] }] },
  });
  assert.deepEqual(listed?.suggestions, {
    claudeMd: 2,
    contextFiles: 3,
    files: [{ kind: 'agents_md', path: 'AGENTS.md', changes: 3 }],
  });
  assert.equal(parseRepoBody({ repo: { status: 'ingesting' } })?.suggestions, undefined, 'an older Trail sends none');
});

test('the polled GET carries the context-file counts in context_files_progress', () => {
  // On GET /repo, `context_files` is the flag that says the routes exist.
  const polled = parseRepoBody({
    repo: { status: 'completed' },
    claude_md: { status: 'analyzing', changes: 3 },
    context_files: true,
    context_files_progress: { changes: 2, files: [{ kind: 'skill', path: '.claude/skills/a/SKILL.md', changes: 2 }] },
  });
  assert.deepEqual(polled?.suggestions, {
    claudeMd: 3,
    contextFiles: 2,
    files: [{ kind: 'skill', path: '.claude/skills/a/SKILL.md', changes: 2 }],
  });
});

// --- the stream ---------------------------------------------------------------

/** A text/event-stream response that sends each part in turn, then ends (or not). */
function stream(parts: string[], opts: { end?: boolean } = {}): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (i < parts.length) ctl.enqueue(enc.encode(parts[i++]));
      else if (opts.end !== false) ctl.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const progress = (body: unknown) => `event: progress\ndata: ${JSON.stringify(body)}\n\n`;
const NOW = { timeoutMs: 60_000, pollMs: 0, sleep: async () => {} };

test('the stream settles the watch on the first rules, with the suggestions it carried', async () => {
  const urls: string[] = [];
  const accepts: string[] = [];
  let seen: unknown = null;
  const outcome = await watchBuild(LINK, {
    ...NOW,
    events: true,
    write: () => {},
    onState: (_v, repo) => (seen = repo.suggestions),
    fetchImpl: (async (u: string, init?: RequestInit) => {
      urls.push(u);
      accepts.push(String((init?.headers as Record<string, string>).accept));
      return stream([
        ': ping\n\n',
        progress({ repo: { status: 'ingesting', commit_count: 412 } }),
        progress({
          repo: { status: 'ingesting', commit_count: 412 },
          build: { found_so_far: 40, filed_so_far: 5 },
          claude_md: { changes: 4 },
          context_files: { changes: 2 },
        }),
      ], { end: false });
    }) as typeof fetch,
  });
  assert.equal(outcome, 'building');
  assert.deepEqual(urls, ['http://trail.test/api/public/brains/b1/events'], 'one connection, no polling');
  assert.equal(accepts[0], 'text/event-stream');
  assert.deepEqual(seen, { claudeMd: 4, contextFiles: 2 });
});

test('a done event reports a failed build the same way polling would', async () => {
  const lines: string[] = [];
  const outcome = await watchBuild(LINK, {
    ...NOW,
    events: true,
    write: (l) => lines.push(l),
    fetchImpl: (async () =>
      stream([
        progress({ repo: { status: 'ingesting', commit_count: 10 } }),
        `event: done\ndata: ${JSON.stringify({ repo: { status: 'failed', commit_count: 10, error_message: 'miner fell over' } })}\n\n`,
      ])) as typeof fetch,
  });
  assert.equal(outcome, 'failed');
  assert.match(lines.join('\n'), /the build stopped while mining rules · nothing was lost/);
  assert.match(lines.join('\n'), /miner fell over/);
});

test('a stream that keeps dropping is reopened three times, then the watcher polls', async () => {
  const hits: string[] = [];
  const outcome = await watchBuild(LINK, {
    ...NOW,
    events: true,
    write: () => {},
    fetchImpl: (async (u: string) => {
      hits.push(u.endsWith('/events') ? 'events' : 'poll');
      if (u.endsWith('/events')) return stream([progress({ repo: { status: 'ingesting' } })]);
      return new Response(JSON.stringify({ repo: { status: 'completed', rule_count: 42, commit_count: 9 } }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(outcome, 'completed');
  assert.deepEqual(hits, ['events', 'events', 'events', 'events', 'poll']);
});

test('a Trail without the stream falls straight back to polling', async () => {
  const hits: string[] = [];
  const outcome = await watchBuild(LINK, {
    ...NOW,
    events: true,
    write: () => {},
    fetchImpl: (async (u: string) => {
      hits.push(u.endsWith('/events') ? 'events' : 'poll');
      if (u.endsWith('/events')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ repo: { status: 'completed', rule_count: 1, commit_count: 1 } }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(outcome, 'completed');
  assert.deepEqual(hits, ['events', 'poll']);
});

test('a silent stream counts as dropped once the keep-alives stop', async () => {
  let connections = 0;
  const outcome = await watchBuild(LINK, {
    ...NOW,
    events: true,
    idleMs: 20,
    maxReconnects: 0,
    write: () => {},
    fetchImpl: (async (u: string) => {
      if (u.endsWith('/events')) {
        connections++;
        return stream([], { end: false });
      }
      return new Response(JSON.stringify({ repo: { status: 'completed', rule_count: 3, commit_count: 1 } }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(outcome, 'completed');
  assert.equal(connections, 1);
});

test('without the events flag nothing asks for the stream', async () => {
  const hits: string[] = [];
  await watchBuild(LINK, {
    ...NOW,
    write: () => {},
    fetchImpl: (async (u: string) => {
      hits.push(u);
      return new Response(JSON.stringify({ repo: { status: 'completed', rule_count: 1, commit_count: 1 } }), { status: 200 });
    }) as typeof fetch,
  });
  assert.ok(hits.every((u) => u.endsWith('/repo')));
});
