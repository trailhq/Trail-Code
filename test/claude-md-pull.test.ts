/**
 * `graft claude-md pull` edits a file people also edit by hand, so what matters
 * is that it touches only what a change names, never guesses when the file has
 * moved on, and never writes the same change twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, fetchAcceptedChanges, markApplied, type ClaudeMdChange } from '../src/brain/claude-md.js';
import type { BrainLink } from '../src/brain/link.js';

const FILE = [
  '# chalk',
  '',
  'Terminal string styling.',
  '',
  '## Commands',
  '',
  '- `npm test` runs the test suite with ava.',
  '- `npx xo` lints the code.',
  '',
  '```bash',
  '## not a heading',
  '```',
  '',
  '## Architecture',
  '',
  '- `source/index.js` builds the chainable instance.',
  '',
].join('\n');

const edit = (over: Partial<ClaudeMdChange> = {}): ClaudeMdChange => ({
  id: 'e1',
  kind: 'edit',
  heading: 'Commands',
  find: '- `npm test` runs the test suite with ava.',
  text: '- `npm test` runs xo, c8 and ava. Always run the whole script, never ava alone.',
  ...over,
});
const add = (over: Partial<ClaudeMdChange> = {}): ClaudeMdChange => ({
  id: 'a1',
  kind: 'add',
  heading: 'Breaking changes',
  after_heading: 'Commands',
  text: 'Every exported name is public API. Deprecate for one major first.',
  ...over,
});

test('an edit replaces only its own text, and the rest comes back byte for byte', () => {
  const r = applyChanges(FILE, [edit()]);
  assert.deepEqual(r.written.map((c) => c.id), ['e1']);
  assert.equal(r.text, FILE.replace('- `npm test` runs the test suite with ava.', edit().text));
});

test('a new section goes after the one it names, with a blank line either side', () => {
  const r = applyChanges(FILE, [add()]);
  assert.match(r.text, /- `npx xo` lints the code\.\n\n```bash\n## not a heading\n```\n\n## Breaking changes\n\nEvery exported name is public API\. Deprecate for one major first\.\n\n## Architecture/);
});

test('a new section with no anchor goes at the end', () => {
  const r = applyChanges(FILE, [add({ after_heading: '' })]);
  assert.ok(r.text.endsWith('## Breaking changes\n\nEvery exported name is public API. Deprecate for one major first.\n'));
});

test('an edit whose text is gone is skipped, not guessed at', () => {
  const moved = FILE.replace('runs the test suite with ava', 'runs everything');
  const r = applyChanges(moved, [edit()]);
  assert.equal(r.written.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.text, moved, 'the file is untouched');
});

test('a heading inside a code fence is not a section', () => {
  const r = applyChanges(FILE, [edit({ heading: 'not a heading' })]);
  assert.equal(r.skipped.length, 1);
});

test('changes already in the file are reported as present, not written again', () => {
  const once = applyChanges(FILE, [edit(), add()]).text;
  const twice = applyChanges(once, [edit(), add()]);
  assert.equal(twice.written.length, 0);
  assert.deepEqual(twice.present.map((c) => c.id).sort(), ['a1', 'e1']);
  assert.equal(twice.text, once);
});

test('an empty find appends to the end of the section', () => {
  const r = applyChanges(FILE, [edit({ find: '', text: '- `npm run bench` runs the benchmarks.' })]);
  assert.match(r.text, /```\n- `npm run bench` runs the benchmarks\.\n\n## Architecture/);
});

test('a repo with no CLAUDE.md gets one from the accepted additions', () => {
  const r = applyChanges('', [add({ after_heading: '' })]);
  assert.equal(r.text, '## Breaking changes\n\nEvery exported name is public API. Deprecate for one major first.\n');
});

test('CRLF files stay CRLF', () => {
  const crlf = FILE.replace(/\n/g, '\r\n');
  const r = applyChanges(crlf, [edit()]);
  assert.ok(!/[^\r]\n/.test(r.text), 'no bare LF introduced');
  assert.ok(r.text.includes('never ava alone.'));
});

// --- the two calls ------------------------------------------------------------

const link = { brainId: 'b1', token: 'gbt_1.x', baseUrl: 'http://trail.test' } as unknown as BrainLink;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('pull reads the accepted changes with the brain token', async () => {
  let seen: { url: string; auth: string } | null = null;
  const got = await fetchAcceptedChanges(link, (async (u: string, init?: RequestInit) => {
    seen = { url: u, auth: String((init?.headers as Record<string, string>).authorization) };
    return json({ path: 'CLAUDE.md', head_sha: 'abc', changes: [edit()] });
  }) as typeof fetch);
  assert.ok(!('error' in got) && got.changes.length === 1);
  assert.equal(seen!.url, 'http://trail.test/api/public/brains/b1/claude-md');
  assert.equal(seen!.auth, 'Bearer gbt_1.x');

  const older = await fetchAcceptedChanges(link, (async () => json({ error: 'nope' }, 404)) as typeof fetch);
  assert.ok('error' in older);
});

test('applied ids are reported in batches of at most 100', async () => {
  const bodies: string[][] = [];
  const ok = await markApplied(
    link,
    Array.from({ length: 150 }, (_, i) => `id${i}`),
    (async (_u: string, init?: RequestInit) => {
      bodies.push((JSON.parse(String(init?.body)) as { ids: string[] }).ids);
      return json({ applied: 1 });
    }) as typeof fetch,
  );
  assert.equal(ok, true);
  assert.deepEqual(bodies.map((b) => b.length), [100, 50]);
});
