import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatusline, incomingEdges, formatBlastRadius, formatRetrieval, formatOrientation, renderSubagent, relevantRetrieval, INJECT_MIN_COVERAGE, NUDGE_CAP } from '../src/claude/format.js';
import { emptyStats } from '../src/claude/state.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('not-built state', () => {
  const lines = renderStatusline(null, null, { ctxPct: null });
  assert.match(strip(lines[0]), /not built/);
  assert.match(strip(lines[0]), /graft build/);
});

test('empty graph (0 nodes) is built, not "not built"', () => {
  // A successful `graft build` on a docs-only repo writes a real graph with
  // zero symbols. nodeCount === 0 must not be treated as "never built".
  const stats = { ...emptyStats(), nodeCount: 0, edgeCount: 0 };
  const line = strip(renderStatusline(stats, null, { ctxPct: null })[0]);
  assert.doesNotMatch(line, /not built/);
  assert.doesNotMatch(line, /graft build/);
  assert.match(line, /0 nodes \/ 0 edges/);
  assert.match(line, /✓ synced/);
});

test('two-line bar: size + freshness + ctx + last', () => {
  const stats = { ...emptyStats(), nodeCount: 319, edgeCount: 730, totalCount: 319, readyCount: 0,
    dirty: true, staleCount: 4, lastFile: 'pkce.ts' };
  const lines = renderStatusline(stats, null, { ctxPct: 34 }).map(strip);
  assert.match(lines[0], /graft/);
  assert.match(lines[0], /319 nodes \/ 730 edges/);
  assert.doesNotMatch(lines[0], /enriched/); // enriched segment removed from the bar
  assert.match(lines[0], /⚠ 4 stale/);
  assert.match(lines[1], /ctx 34%/);
  assert.match(lines[1], /last: pkce\.ts/);
});

test('syncing overrides stale; synced when clean', () => {
  const base = { ...emptyStats(), nodeCount: 1, edgeCount: 0, totalCount: 1 };
  assert.match(strip(renderStatusline({ ...base, syncing: true, dirty: true }, null, { ctxPct: null })[0]), /syncing/);
  assert.match(strip(renderStatusline(base, null, { ctxPct: null })[0]), /✓ synced/);
});

const wiring2 = {
  meta: { nodeCount: 3, edgeCount: 2, languages: ['typescript'] },
  nodes: [
    { id: 'src/pkce.ts#verify', name: 'verify', path: 'src/pkce.ts', summary_state: 'ready' },
    { id: 'src/client.ts#exchange', name: 'exchange', path: 'src/client.ts', summary_state: 'ready' },
    { id: 'src/pkce.ts#gen', name: 'gen', path: 'src/pkce.ts', summary_state: 'ready' },
  ],
  edges: [
    { source: 'src/client.ts#exchange', target: 'src/pkce.ts#verify', relation: 'calls', confidence: 'extracted' },
    { source: 'src/pkce.ts#gen', target: 'src/pkce.ts#verify', relation: 'calls', confidence: 'extracted' },
  ],
} as any;

test('incomingEdges: external callers of nodes in the edited file', () => {
  const e = incomingEdges(wiring2, '/abs/repo/src/pkce.ts');
  assert.equal(e.length, 1, 'same-file edge (gen→verify) excluded');
  assert.equal(e[0].source, 'src/client.ts#exchange');
});

test('formatBlastRadius renders callers or null', () => {
  const txt = formatBlastRadius(wiring2, '/abs/repo/src/pkce.ts');
  assert.match(strip(txt!), /blast radius for pkce\.ts/);
  assert.match(strip(txt!), /exchange \(client\.ts\)/);
  assert.equal(formatBlastRadius(wiring2, '/abs/repo/src/unknown.ts'), null);
  // The edited path is the OS's: on Windows '\' separates, elsewhere it is part of a file name.
  const backslashed = formatBlastRadius(wiring2, '/abs/repo/src\\pkce.ts');
  if (process.platform === 'win32') assert.match(strip(backslashed ?? ''), /exchange \(client\.ts\)/, 'a Windows path');
  else assert.equal(backslashed, null, 'a POSIX file name containing a backslash');
});

test('formatRetrieval renders top hits, trims snippet, first pointer only', () => {
  const ask = { query: 'pkce', mode: 'lexical', hits: [
    { kind: 'concept', title: 'PKCE', pointer: 'src/pkce.ts, src/client.ts', snippet: 'Validates   the   challenge.', score: 1 },
  ] } as any;
  const txt = strip(formatRetrieval(ask)!);
  assert.match(txt, /starting points for this task/); // pointers-only header (no inlined code)
  assert.match(txt, /PKCE: src\/pkce\.ts/);
  assert.match(txt, /Validates the challenge\./); // snippet trimmed, own line
  assert.doesNotMatch(txt, /client\.ts/); // only the first pointer segment
});

test('formatRetrieval keeps the substitutive header when code is inlined', () => {
  const ask = { query: 'pkce', mode: 'lexical', hits: [
    { kind: 'symbol', title: 'verify', pointer: 'src/pkce.ts:L1-L4', snippet: 's', score: 1, code: 'a\nb' },
  ] } as any;
  assert.match(strip(formatRetrieval(ask)!), /retrieved context, read these spans/);
});

test('formatRetrieval appends a tokens-saved line when ask reports a baseline', () => {
  const ask = { query: 'pkce', mode: 'lexical', saved: { files: 1, baselineChars: 8000 }, hits: [
    { kind: 'symbol', title: 'verify', pointer: 'src/pkce.ts:L1-L4', snippet: 's', score: 1, code: 'a\nb' },
  ] } as any;
  const txt = strip(formatRetrieval(ask)!);
  assert.match(txt, /tokens saved ≈ [\d,]+ \(\d+%\)/);
});

test('formatRetrieval returns null for no hits', () => {
  assert.equal(formatRetrieval({ query: 'x', mode: 'empty', hits: [] } as any), null);
});

// ── relevantRetrieval: the per-prompt injection gate ──
const gateAsk = (over: Record<string, unknown> = {}) => ({
  query: 'pkce', mode: 'lexical', coverage: 1,
  hits: [
    { kind: 'symbol', title: 'verify', pointer: 'src/pkce.ts:L1-L4', snippet: 's', score: 1 },
    { kind: 'symbol', title: 'gen', pointer: 'src/pkce.ts:L6-L9', snippet: 's', score: 0.8 },
  ],
  ...over,
}) as any;
const freshSession = () => ({ graftReads: 0, sourceReads: 0, savedTokens: 0, injectedPointers: [] as string[] });

test('relevantRetrieval injects on good coverage and records pointers', () => {
  const s = freshSession();
  const txt = relevantRetrieval(gateAsk(), s);
  assert.ok(txt && /verify/.test(strip(txt)));
  assert.deepEqual(s.injectedPointers, ['src/pkce.ts:L1-L4', 'src/pkce.ts:L6-L9']);
});

test('relevantRetrieval nudges instead of injecting when the match is weak both ways', () => {
  const s = freshSession();
  const txt = relevantRetrieval(gateAsk({ coverage: 0.2, coverageStrong: 0.05 }), s);
  assert.match(txt ?? '', /no strong match/, 'a weak pack is replaced by a named command');
  assert.match(txt ?? '', /graft ask/, 'the nudge names the command to run');
  assert.deepEqual(s.injectedPointers, [], 'nothing recorded — no pack was shown');
});

test('relevantRetrieval passes on a NAME hit even when broad coverage is low', () => {
  // The whole point of the second clause: a short prompt naming one real symbol
  // has low broad coverage and high strength, and must not be gated out.
  const txt = relevantRetrieval(gateAsk({ coverage: 0.2, coverageStrong: 0.45 }), freshSession());
  assert.ok(txt && /verify/.test(strip(txt)), 'strong name match injects');
});

test('relevantRetrieval: the traced turn-1 regression is now rejected', () => {
  // Measured from session ce3ca5f4: this exact pair cleared the old 0.15 floor by
  // 0.015 and injected three test files for a question answered elsewhere.
  const s = freshSession();
  const txt = relevantRetrieval(gateAsk({ coverage: 0.1649, coverageStrong: 0.0329 }), s);
  assert.match(txt ?? '', /no strong match/);
  assert.match(txt ?? '', /0\.03/, 'the nudge reports the strength it measured');
  assert.deepEqual(s.injectedPointers, []);
});

test('relevantRetrieval caps the nudge so it cannot become wallpaper', () => {
  const s = freshSession();
  const weak = () => gateAsk({ coverage: 0.1, coverageStrong: 0 });
  assert.ok(relevantRetrieval(weak(), s), 'first weak prompt nudges');
  assert.ok(relevantRetrieval(weak(), s), 'second still nudges');
  assert.equal(relevantRetrieval(weak(), s), null, 'third is silent');
  assert.equal(s.nudges, NUDGE_CAP);
});

test('INJECT_MIN_COVERAGE is retained as the superseded reference floor', () => {
  // Documented history, not live logic: 0.1649 used to clear this and no longer does.
  assert.equal(INJECT_MIN_COVERAGE, 0.15);
  assert.ok(0.1649 > INJECT_MIN_COVERAGE, 'the regression case cleared the old floor');
});

test('relevantRetrieval treats missing coverage (structural mode) as relevant', () => {
  const txt = relevantRetrieval(gateAsk({ coverage: undefined, mode: 'structural' }), freshSession());
  assert.ok(txt);
});

test('relevantRetrieval drops already-injected pointers, skips when none are fresh', () => {
  const s = freshSession();
  assert.ok(relevantRetrieval(gateAsk(), s), 'first prompt injects');
  assert.equal(relevantRetrieval(gateAsk(), s), null, 'same hits again → silent');
  const oneNew = gateAsk({ hits: [
    { kind: 'symbol', title: 'verify', pointer: 'src/pkce.ts:L1-L4', snippet: 's', score: 1 },
    { kind: 'symbol', title: 'exchange', pointer: 'src/client.ts:L2-L8', snippet: 's', score: 0.9 },
  ] });
  const txt = strip(relevantRetrieval(oneNew, s)!);
  assert.match(txt, /exchange/, 'fresh hit injected');
  assert.doesNotMatch(txt, /verify/, 'stale hit dropped from the pack');
});

test('formatOrientation labels and truncates to budget', () => {
  const md = 'X'.repeat(3000);
  const out = strip(formatOrientation(md, 1500));
  assert.match(out, /repo map/);
  assert.match(out, /reach for graft first/, 'always-on usage directive present');
  assert.match(out, /Already know the file or symbol to change\?/, 'known-target edit guidance present');
  // index truncated to budget (1500) + the fixed usage directive (per-tool descriptions + discipline).
  assert.match(out, /Refactor, rename, or multi-file change?/, 'refactor blast-radius nudge present');
  // The guard is on the INDEX being trimmed, not on the directive's exact byte
  // count: an untrimmed 3000-char index would land near 5200. The ceiling has
  // deliberate slack so teaching the directive one more thing (dollar values,
  // 0.7.x) doesn't fail a test that is watching something else.
  assert.ok(out.length < 4000, 'index trimmed to budget; only the fixed directive adds to it');
  // Regression: `graft impact` was folded into `graft callers --depth` in 0.6.0 —
  // the always-on directive must teach the current command, not a dead one.
  assert.doesNotMatch(out, /graft impact\b/, 'does not teach the removed `graft impact` command');
  assert.match(out, /graft callers .*--depth/, 'teaches blast radius via callers --depth instead');
});

test('formatOrientation prepends a staleness banner when one is supplied', () => {
  const md = 'repo index';
  const note = '⚠ graft index may be ahead of your working tree: 3 of 40 indexed files are not on disk';
  const out = strip(formatOrientation(md, 1500, note));
  // banner rides ABOVE the directive so it is the first thing the agent reads.
  assert.ok(out.indexOf('ahead of your working tree') < out.indexOf('reach for graft first'), 'banner precedes the directive');
  // absent by default (fresh index) — no banner noise when nothing supplied.
  assert.doesNotMatch(strip(formatOrientation(md, 1500)), /ahead of your working tree/);
});

test('renderSubagent shows the agent name', () => {
  const out = strip(renderSubagent('Explore', { graftReads: 2, sourceReads: 0, savedTokens: 0 }));
  assert.equal(out, '◤ Explore');
});

test('renderSubagent without a query still shows the agent', () => {
  const out = strip(renderSubagent('Plan', null));
  assert.match(out, /Plan/);
});

test('renderStatusline carries the dollar value once the session has been billed', () => {
  const stats = { ...emptyStats(), nodeCount: 1, edgeCount: 0, totalCount: 1 };
  const s = { ...freshSession(), savedTokens: 100_000, inputCostMicros: 600_000, inputTokensBilled: 1_000_000 };
  const line = strip(renderStatusline(stats, s as any, { ctxPct: null })[0]);
  assert.match(line, /~100,000 tok saved · ~\$0\.06/);
});

test('renderStatusline shows tokens alone until a turn has been billed', () => {
  // Turn one of every session, and every turn on a host that exposes no
  // transcript. Tokens are still true; a price nobody measured is not.
  const stats = { ...emptyStats(), nodeCount: 1, edgeCount: 0, totalCount: 1 };
  const s = { ...freshSession(), savedTokens: 100_000 };
  const line = strip(renderStatusline(stats, s as any, { ctxPct: null })[0]);
  assert.match(line, /~100,000 tok saved/);
  assert.doesNotMatch(line, /\$/);
});
