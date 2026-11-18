import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyToolUse,
  commandInvokesGraft,
  isGraftMcpTool,
  isMcpToolName,
  parseSavings,
  recordToolUse,
  latestSession,
  formatSessionStats,
} from '../src/claude/session-metrics.js';
import { readSession } from '../src/claude/state.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-metrics-')); }

// ── the classifier: the load-bearing table ────────────────────────────────

/**
 * Every host names its tools differently; this is the one place those names are
 * mapped to graft / source / neither. The MCP rows cover the three prefixes a
 * graft tool arrives under across hosts (bare, `MCP:`, `mcp__…__`) — the matcher
 * must recognise all three, since it is what decides whether a call is counted.
 */
const CASES: Array<{ name: string; command?: string; want: 'graft' | 'source' | null }> = [
  // graft MCP tools, every host prefix
  { name: 'graft_find_code', want: 'graft' },
  { name: 'MCP:graft_find_code', want: 'graft' },
  { name: 'mcp__graft__graft_find_code', want: 'graft' },
  { name: 'graft_repo_map', want: 'graft' },
  // native source-read tools (Claude + Cursor)
  { name: 'Read', want: 'source' },
  { name: 'Grep', want: 'source' },
  { name: 'Glob', want: 'source' },
  { name: 'Search', want: 'source' },
  // shell running the graft CLI → graft
  { name: 'Bash', command: 'graft ask "how does auth work"', want: 'graft' },
  { name: 'Shell', command: 'graft map', want: 'graft' },
  { name: 'Shell', command: 'npx -y @nanonets/graft callers foo', want: 'graft' },
  { name: 'Bash', command: 'node dist/cli.js grep bar', want: 'graft' },
  // shell running something else → neither
  { name: 'Bash', command: 'ls -la', want: null },
  { name: 'Shell', command: 'git status', want: null },
  // a path that merely contains "graft" is not an invocation
  { name: 'Bash', command: './mygraft/run.sh', want: null },
  // a third-party MCP tool whose NAME merely contains "graft" is NOT a graft read —
  // the name test is anchored on the real vocabulary, not a loose substring
  { name: 'mygraft_search', want: null },
  { name: 'graft-adjacent-tool', want: null },
  { name: 'some__graft__tool', want: null },
  // edits / spawns / unknown → neither
  { name: 'Write', want: null },
  { name: 'Edit', want: null },
  { name: 'Task', want: null },
  { name: '', want: null },
];

for (const c of CASES) {
  test(`classifyToolUse(${c.name || '∅'}${c.command ? ` :: ${c.command}` : ''}) → ${c.want}`, () => {
    assert.equal(classifyToolUse(c.name, c.command), c.want);
  });
}

test('isGraftMcpTool recognises graft tools across prefixes, and rejects lookalikes', () => {
  // every host prefix, canonical and legacy names
  assert.ok(isGraftMcpTool('MCP:graft_find_code'));
  assert.ok(isGraftMcpTool('mcp__graft__graft_find_code'));
  assert.ok(isGraftMcpTool('graft_trace_calls'));
  assert.ok(isGraftMcpTool('graft_ask'), 'a legacy alias still counts');
  // anchored on the real name list — a third-party tool that merely CONTAINS
  // "graft" must not be counted as a graft read
  assert.ok(!isGraftMcpTool('Read'));
  assert.ok(!isGraftMcpTool('mygraft_search'));
  assert.ok(!isGraftMcpTool('graft-adjacent-tool'));
  assert.ok(!isGraftMcpTool('mcp__other__graft_helper'));
});

test('isMcpToolName recognises the server-prefixed shapes', () => {
  assert.ok(isMcpToolName('MCP:graft_find_code'));
  assert.ok(isMcpToolName('mcp__graft__graft_find_code'));
  assert.ok(!isMcpToolName('Read'));
  assert.ok(!isMcpToolName('Shell'));
});

test('commandInvokesGraft is anchored — not fooled by a substring path', () => {
  assert.ok(commandInvokesGraft('graft ask x'));
  assert.ok(commandInvokesGraft('cd repo && graft map'));
  assert.ok(!commandInvokesGraft('cat mygraft.txt'));
  assert.ok(!commandInvokesGraft('echo upgraft'));
});

// ── parseSavings ───────────────────────────────────────────────────────────

test('parseSavings sums every footer, tolerant of commas', () => {
  assert.equal(parseSavings('nothing here'), 0);
  assert.equal(parseSavings('[graft] tokens saved ≈ 2,181 (89%) — …'), 2181);
  assert.equal(
    parseSavings('a\n[graft] tokens saved ≈ 100 — …\nb\n[graft] tokens saved ≈ 1,000 — …'),
    1100,
  );
});

// Issue #624 part 2: a footer quoted inside prose is data, not savings. The
// PostToolUse accumulator sweeps JSON.stringify(tool_response), so a document
// that merely mentions the footer must not move the session total.
test('parseSavings ignores a footer quoted inside prose', () => {
  assert.equal(parseSavings('he wrote "[graft] tokens saved ≈ 13,509" in the doc'), 0);
  assert.equal(
    parseSavings(JSON.stringify({ tool_response: { stdout: 'he wrote "[graft] tokens saved ≈ 13,509" in the doc' } })),
    0,
  );
});

test('parseSavings still counts footers at JSON field boundaries and after escaped newlines', () => {
  assert.equal(
    parseSavings(JSON.stringify({ tool_response: { stdout: '[graft] tokens saved ≈ 1,200 (92%) — …' } })),
    1200,
  );
  // a bare-string tool_response: the hooks stringify the WHOLE payload, so the
  // footer sits right after the field's opening quote (`:"`)
  assert.equal(
    parseSavings(JSON.stringify({ session_id: 's1', tool_response: '[graft] tokens saved ≈ 517 (88%) — …' })),
    517,
  );
  // a real footer of the tally-test family: bare, ending right after the number
  assert.equal(parseSavings(JSON.stringify({ session_id: 's1', tool_response: '[graft] tokens saved ≈ 4,000' })), 4000);
  assert.equal(
    parseSavings(JSON.stringify({ content: [{ type: 'text', text: 'intro\n[graft] tokens saved ≈ 300 (41%) — …' }] })),
    300,
  );
  assert.equal(
    parseSavings('[graft] tokens saved ≈ 500 (36%) — …\n[trail] learnings saved ≈ 200 tokens (estimate): …'),
    700,
  );
  // glued right after output content, no separator (claude-hooks.test.ts' real-line shape)
  assert.equal(parseSavings('callers …[graft] tokens saved ≈ 1,990 (88%) — …'), 1990);
});

// ── recordToolUse ──────────────────────────────────────────────────────────

test('recordToolUse increments the right counter and accumulates savings', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: 'graft', savedTokens: 500 });
  recordToolUse(d, 's1', { kind: 'graft' });
  recordToolUse(d, 's1', { kind: 'source' });
  const s = readSession(d, 's1');
  assert.equal(s.graftReads, 2);
  assert.equal(s.sourceReads, 1);
  assert.equal(s.savedTokens, 500);
});

test('recordToolUse is a no-op when there is nothing to record (no file written)', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: null, savedTokens: 0 });
  recordToolUse(d, 's1', {});
  // readSession returns the empty default without a file; the proof it never
  // wrote is that a fresh empty session equals what we read.
  const s = readSession(d, 's1');
  assert.equal(s.graftReads, 0);
  assert.equal(s.sourceReads, 0);
  assert.equal(s.savedTokens, 0);
});

test('recordToolUse can log savings on a graft read with no explicit kind classification', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: 'graft', savedTokens: 1990 });
  assert.equal(readSession(d, 's1').savedTokens, 1990);
  assert.equal(readSession(d, 's1').graftReads, 1);
});

test('recordToolUse stamps the host once — the first tool use owns the attribution', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: 'graft', host: 'cursor' });
  assert.equal(readSession(d, 's1').host, 'cursor');
  // a later use from a different host must not overwrite the stamp
  recordToolUse(d, 's1', { kind: 'source', host: 'claude-code' });
  assert.equal(readSession(d, 's1').host, 'cursor', 'host is not re-stamped');
});

// ── latestSession + formatSessionStats (what `graft stats` reads) ──────────

function writeSession(d: string, id: string, body: object, ageMs = 0): void {
  const dir = join(d, 'graft', '.cache', 'session');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.json`);
  writeFileSync(p, JSON.stringify(body));
  if (ageMs) { const w = new Date(Date.now() - ageMs); utimesSync(p, w, w); }
}

test('latestSession returns null when no session exists', () => {
  assert.equal(latestSession(fresh()), null);
});

test('latestSession picks the most recently touched session file', () => {
  const d = fresh();
  writeSession(d, 'old', { graftReads: 1, sourceReads: 9 }, 60_000);
  writeSession(d, 'new', { graftReads: 8, sourceReads: 2 }, 0);
  const s = latestSession(d)!;
  assert.equal(s.id, 'new');
  assert.equal(s.graftReads, 8);
});

test('formatSessionStats renders the mix, savings and how many prompts were asked about', () => {
  const out = formatSessionStats({
    id: 'abc', promptAsks: 4,
    graftReads: 8, sourceReads: 2, savedTokens: 12345,
  });
  assert.match(out, /session abc/);
  assert.match(out, /graft reads:\s+8/);
  assert.match(out, /source reads:\s+2/);
  assert.match(out, /80% graft/);
  assert.match(out, /12,345/);
  assert.match(out, /prompts asked:\s+4/);
});

test('formatSessionStats has a friendly empty state', () => {
  assert.match(formatSessionStats(null), /no session recorded yet/);
});

test('formatSessionStats prices the saving once the session has been billed', () => {
  // Billed $0.60 for 1M input tokens = $0.60/Mtok, so 100k saved is worth $0.06 —
  // which formats as <$0.01? No: $0.06. The point is that it is the MEASURED
  // rate, an order of magnitude under this model's $5/Mtok list price.
  const out = formatSessionStats({
    id: 'abc',
    graftReads: 8, sourceReads: 2, savedTokens: 100_000,
    inputCostMicros: 600_000, inputTokensBilled: 1_000_000,
  });
  assert.match(out, /tokens saved:\s+~100,000/);
  assert.match(out, /value saved:\s+~\$0\.06/);
});

test('formatSessionStats omits the dollar line rather than claiming zero', () => {
  // Cursor: its hooks name no transcript, so nothing has ever been billed. The
  // token count still stands; a "$0.00" next to it would be a false claim.
  const out = formatSessionStats({
    id: 'abc',
    graftReads: 8, sourceReads: 2, savedTokens: 100_000,
  });
  assert.match(out, /tokens saved:\s+~100,000/);
  assert.doesNotMatch(out, /value saved/);
  assert.doesNotMatch(out, /\$/);
});
