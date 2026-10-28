/**
 * Tests for the shared "tokens saved" estimate ({@link savingsFor} +
 * {@link withSavings}) that every retrieval-style command routes through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savingsFor, savingsLine, withSavings, toTokens, setInputRate, groupDigits } from '../src/context/savings.js';
import { hasSavingsTally } from '../src/claude/tally.js';
import type { GraphV1, NodeV1 } from '../src/graph/types.js';

function fileNode(path: string, chars?: number): NodeV1 {
  return {
    id: path,
    name: path,
    kind: 'file',
    path,
    span: 'L1-L1',
    signature: null,
    exported: true,
    origin: 'ast',
    body_hash: '',
    summary_state: 'pending',
    summary: null,
    crux: null,
    chars,
  };
}

function graphOf(nodes: NodeV1[]): GraphV1 {
  return { meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: [] }, nodes, edges: [] };
}

test('savingsFor: sums the sizes of the distinct baseline files', () => {
  const g = graphOf([fileNode('a.ts', 400), fileNode('b.ts', 600)]);
  const s = savingsFor(g, ['a.ts', 'b.ts', 'a.ts']); // duplicate a.ts counted once
  assert.deepEqual(s, { files: 2, baselineChars: 1000 });
});

test('savingsFor: skips files with no known size, returns undefined when none are sized', () => {
  const g = graphOf([fileNode('a.ts'), fileNode('b.ts', 800)]);
  assert.deepEqual(savingsFor(g, ['a.ts', 'b.ts']), { files: 1, baselineChars: 800 });
  assert.equal(savingsFor(graphOf([fileNode('a.ts')]), ['a.ts']), undefined);
  assert.equal(savingsFor(g, ['missing.ts']), undefined);
});

test('savingsLine: reports saved tokens and percent when the output is smaller', () => {
  const body = 'x'.repeat(40); // ≈ 10 tok
  const footer = savingsLine(body, { files: 2, baselineChars: 8000 }); // baseline ≈ 2000 tok
  assert.match(footer, /tokens saved ≈ [\d,]+ \(\d+%\)/);
  assert.match(footer, /2 file\(s\)/);
  const base = toTokens(8000);
  // Through the same pinned formatter the footer uses: rendered with the test
  // machine's locale instead, this asserted `1.990` against a footer that says
  // `1,990` — the mirror image of #338, and just as invisible on an en-US runner.
  assert.ok(footer.includes(groupDigits(base - toTokens(body.length))));
  // The nudge rides along so the agent reports the turn total without SKILL.md.
  assert.match(footer, /end of your reply/i);
  assert.match(footer, /graft saved ~N tokens this turn/);
  // The nudge must NOT introduce a second "[graft] tokens saved ≈ <n>" token —
  // the PostToolUse accumulator sums every such match, so a stray one double-counts.
  assert.equal((footer.match(/\[graft\] tokens saved ≈ [\d,]+/g) ?? []).length, 1);
});

test('savingsLine: stays silent when there is nothing honest to claim', () => {
  assert.equal(savingsLine('anything', undefined), '');
  assert.equal(savingsLine('anything', { files: 1, baselineChars: 0 }), '');
  // Baseline no bigger than the output itself (tiny file) → no claim.
  assert.equal(savingsLine('x'.repeat(1000), { files: 1, baselineChars: 40 }), '');
});

test('withSavings: puts the line on top so `head -N` and host truncation keep it', () => {
  const body = 'line1\nline2\nline3';
  const out = withSavings(body, { files: 2, baselineChars: 8000 });
  const first = out.split('\n')[0];
  assert.match(first, /^\[graft\] tokens saved ≈ [\d,]+/);
  assert.ok(out.endsWith(body), 'body follows the header verbatim');
  // Exactly one number in the whole output — a second copy would be
  // double-counted by the PostToolUse accumulator's matchAll.
  assert.equal((out.match(/\[graft\] tokens saved ≈ [\d,]+/g) ?? []).length, 1);
});

test('withSavings: returns the body untouched when there is nothing to claim', () => {
  assert.equal(withSavings('body', undefined), 'body');
});

test('the turn nudge carries no dollar figure until a rate is set', () => {
  setInputRate(null);
  const footer = savingsLine('body', { files: 2, baselineChars: 8000 });
  assert.match(footer, /graft saved ~N tokens this turn/);
  assert.doesNotMatch(footer, /\$/, 'no rate measured, so nothing is priced');
});

test('the turn nudge prices this call once a rate is set', () => {
  // $5/Mtok: a 1,000-token saving is worth half a cent, which must read as
  // "<$0.01" rather than "$0.00" — see formatDollars.
  setInputRate(5);
  const footer = savingsLine('x'.repeat(400), { files: 2, baselineChars: 8000 });
  assert.match(footer, /worth <\$0\.01/);
  assert.match(footer, /~\$X.*this turn/, 'the example shows the dollar-bearing form');
  setInputRate(null);
});

test('a priced nudge still leaves exactly one number for the accumulator', () => {
  // The nudge must never grow a second `[graft] tokens saved ≈ <n>` — the
  // PostToolUse accumulator sums every match, so an example carrying the
  // pattern would double-count the call.
  setInputRate(5);
  const footer = savingsLine('x'.repeat(400), { files: 2, baselineChars: 8000 });
  assert.equal((footer.match(/\[graft\] tokens saved ≈ [\d,]+/g) ?? []).length, 1);
  setInputRate(null);
});

test('a priced nudge still matches the reported-turns tally regex', () => {
  // Adding money to the example must not quietly zero `reportedTurns`, which
  // measures whether the agent told the user anything at all.
  assert.equal(hasSavingsTally('🌱 graft saved ~12,400 tokens (~$0.04) this turn'), true);
});

test('setInputRate refuses a rate that would render as $NaN', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    setInputRate(bad);
    const footer = savingsLine('x'.repeat(400), { files: 2, baselineChars: 8000 });
    assert.doesNotMatch(footer, /\$/, `rate ${bad} must price nothing`);
  }
  setInputRate(null);
});
