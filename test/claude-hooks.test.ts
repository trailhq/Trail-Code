import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { underGraft, main, lastFileScopeHint, promptAskTimeout } from '../src/claude/hooks.js';
import { readStats, readSession } from '../src/claude/state.js';
import { runSync } from '../src/claude/sync-run.js';
import { savingsLine } from '../src/context/savings.js';
import { CI_ENV_VARS } from '../src/telemetry/gate.js';
import { writeStats, emptyStats, acquireLock, resolveContextDir } from '../src/claude/state.js';

test('underGraft detects edits inside graft/', () => {
  assert.equal(underGraft('/repo', '/repo/graft/x.md'), true);
  assert.equal(underGraft('/repo', '/repo/src/cli.ts'), false);
});

test('post-edit marks dirty and records lastFile', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-hooks-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({ meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] }));
  // No graft statusline is wired here, so post-edit skips `graft check` — just dirty + lastFile.
  process.env.CLAUDE_PROJECT_DIR = d;
  const stdin = JSON.stringify({ tool_input: { file_path: join(d, 'src', 'auth.ts') } });
  await runWithStdin(stdin, () => main('post-edit'));
  const s = readStats(d)!;
  assert.equal(s.dirty, true);
  assert.equal(s.lastFile, 'auth.ts');
});

test('post-edit ignores edits inside graft/', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-hooks-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  await runWithStdin(JSON.stringify({ tool_input: { file_path: join(d, 'graft', 'a.md') } }), () => main('post-edit'));
  assert.equal(readStats(d), null, 'no state written for graft/ edits');
});

// helper: hooks.ts reads process.env.GRAFT_TEST_STDIN first (test seam), else fd 0.
async function runWithStdin(text: string, fn: () => Promise<void>): Promise<void> {
  process.env.GRAFT_TEST_STDIN = text;
  try { await fn(); } finally { delete process.env.GRAFT_TEST_STDIN; }
}

// ── post-edit: `graft check` only when a graft statusline will read the count ──

const GRAFT_STATUSLINE = { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-statusline.cjs"' };

/** A `graft check` stub that records that it ran and whether `dirty` was already
 * on disk at that moment, then reports 3 drifted nodes. */
function writeCheckStub(d: string): { stub: string; seenFile: string } {
  const stub = join(d, 'check-stub.cjs');
  const seenFile = join(d, 'check-seen.json');
  const statsFile = join(d, 'graft', '.cache', 'stats.json');
  writeFileSync(
    stub,
    `const fs = require('fs');\n` +
      `let dirty = null;\n` +
      `try { dirty = JSON.parse(fs.readFileSync(${JSON.stringify(statsFile)}, 'utf8')).dirty; } catch {}\n` +
      `fs.writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ args: process.argv.slice(2), dirty }));\n` +
      `process.stdout.write(JSON.stringify({ graph: { changed: ['a', 'b'], added: ['c'], removed: [] } }));\n`,
  );
  return { stub, seenFile };
}

/** Run post-edit in a fresh repo with the given project and user settings, the
 * check stub standing in for the CLI. Returns what the stub saw (null if it never
 * ran) and the stats the hook left behind. */
async function postEditWith(project: object | null, user: object | null) {
  const d = mkdtempSync(join(tmpdir(), 'graft-post-edit-'));
  const home = mkdtempSync(join(tmpdir(), 'graft-post-edit-home-'));
  if (project) {
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify(project));
  }
  if (user) writeFileSync(join(home, 'settings.json'), JSON.stringify(user));
  const { stub, seenFile } = writeCheckStub(d);
  const previousHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_PROJECT_DIR = d;
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.GRAFT_TEST_CLI = stub;
  try {
    await runWithStdin(JSON.stringify({ tool_input: { file_path: join(d, 'src', 'auth.ts') } }), () => main('post-edit'));
    const seen = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, 'utf8')) : null;
    return { seen, stats: readStats(d)! };
  } finally {
    delete process.env.GRAFT_TEST_CLI;
    delete process.env.CLAUDE_PROJECT_DIR;
    if (previousHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousHome;
  }
}

test('post-edit skips graft check when no graft statusline is wired', async () => {
  const { seen, stats } = await postEditWith({ statusLine: { type: 'command', command: 'bash ~/my-statusline.sh' } }, null);
  assert.equal(seen, null, 'graft check never ran — nothing would read staleCount');
  assert.equal(stats.dirty, true);
  assert.equal(stats.lastFile, 'auth.ts');
});

test('post-edit counts drift when the repo wires the graft statusline', async () => {
  const { seen, stats } = await postEditWith({ statusLine: GRAFT_STATUSLINE }, null);
  assert.deepEqual(seen?.args.slice(0, 3), ['check', '.', '--json']);
  assert.equal(stats.staleCount, 3);
  assert.equal(stats.dirty, true);
});

test('post-edit counts drift when the graft statusline is wired at user level', async () => {
  const { seen, stats } = await postEditWith(null, { statusLine: GRAFT_STATUSLINE });
  assert.notEqual(seen, null, 'graft check ran');
  assert.equal(stats.staleCount, 3);
});

test('post-edit marks dirty before graft check runs, so a killed check cannot lose it', async () => {
  const { seen } = await postEditWith({ statusLine: GRAFT_STATUSLINE }, null);
  assert.equal(seen?.dirty, true, 'dirty was already on disk when the check child started');
});

test('post-edit-sync marks dirty and kicks off the background sync', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-hooks-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({ meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] }));
  process.env.CLAUDE_PROJECT_DIR = d;
  // handleStop's spawn path is gated on the sync-run script existing (real installs resolve it
  // via claudeScriptPath('sync-run.js') next to this module). GRAFT_TEST_SYNC_RUN is a test seam
  // (mirrors GRAFT_TEST_STDIN) that lets us point handleStop at a no-op stub inside this test's
  // own sandbox dir, so nothing is written into src/claude/.
  const syncRun = join(d, 'sync-run-stub.js');
  writeFileSync(syncRun, '// test stub: spawned as a detached no-op child\n');
  process.env.GRAFT_TEST_SYNC_RUN = syncRun;
  try {
    const stdin = JSON.stringify({ tool_input: { file_path: join(d, 'src', 'auth.ts') } });
    await runWithStdin(stdin, () => main('post-edit-sync'));
    const s = readStats(d)!;
    assert.equal(s.dirty, true, 'post-edit half ran');
    assert.equal(s.syncing, true, 'stop half ran');
    assert.equal(existsSync(join(d, 'graft', '.cache', '.sync.lock')), true, 'sync lock file exists');
  } finally {
    delete process.env.GRAFT_TEST_SYNC_RUN;
  }
});

test('post-edit-sync on a file under graft/ does not mark dirty', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-hooks-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  await runWithStdin(JSON.stringify({ tool_input: { file_path: join(d, 'graft', 'a.md') } }), () => main('post-edit-sync'));
  // The under-graft guard means handlePostEdit never marks dirty, and this is a fresh mkdtemp
  // dir so there is no prior state to inherit — stats are either absent or dirty: false.
  const s = readStats(d);
  assert.equal(s === null || s.dirty === false, true, 'dirty not newly set by this call');
});

test('runSync clears dirty/syncing, recomputes stats, releases lock', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-sync-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeStats(d, { ...emptyStats(), dirty: true, syncing: true, staleCount: 3 });
  acquireLock(d);
  // fake build: write a fresh wiring.json with 2 nodes, 1 ready
  const fakeBuild = (dir: string) => writeFileSync(join(dir, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({ meta: { nodeCount: 2, edgeCount: 1, languages: ['typescript'] },
      nodes: [{ id: 'a', summary_state: 'ready' }, { id: 'b', summary_state: 'pending' }],
      edges: [{ from: 'a', to: 'b' }] }));
  runSync(d, fakeBuild);
  const s = readStats(d)!;
  assert.equal(s.dirty, false);
  assert.equal(s.syncing, false);
  assert.equal(s.staleCount, 0);
  assert.equal(s.nodeCount, 2);
  assert.equal(s.readyCount, 1);
  assert.ok(s.syncedAt);
  assert.equal(acquireLock(d), true, 'lock released, so reacquire succeeds');
});

test("runSync's default build passes --dir <resolved> to graft build when GRAFT_DIR is set", () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-sync-dir-'));
  mkdirSync(join(d, 'elsewhere', '.graph'), { recursive: true });
  const argsFile = join(d, 'args-seen.json');
  const stub = join(d, 'build-stub.cjs');
  writeFileSync(
    stub,
    `const fs = require('fs');\n` +
      `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n` +
      `fs.writeFileSync(${JSON.stringify(join(d, 'elsewhere', '.graph', 'wiring.json'))}, JSON.stringify({ meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] }));\n`,
  );
  process.env.GRAFT_TEST_CLI = stub;
  process.env.GRAFT_DIR = 'elsewhere';
  try {
    runSync(d); // exercises the real (non-injected) build path
    const argsSeen: string[] = JSON.parse(readFileSync(argsFile, 'utf8'));
    const dirIdx = argsSeen.indexOf('--dir');
    assert.ok(dirIdx !== -1, 'the build call carries --dir when GRAFT_DIR is set');
    assert.equal(argsSeen[dirIdx + 1], resolveContextDir(d));
  } finally {
    delete process.env.GRAFT_TEST_CLI;
    delete process.env.GRAFT_DIR;
  }
});

test('runSync clears syncing even if build throws (money-safe failure)', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-sync-'));
  writeStats(d, { ...emptyStats(), dirty: true, syncing: true });
  acquireLock(d);
  runSync(d, () => { throw new Error('build failed'); });
  const s = readStats(d)!;
  assert.equal(s.syncing, false);
  assert.equal(s.dirty, true, 'stays dirty so the bar keeps ⚠ and it retries next turn');
  assert.equal(acquireLock(d), true, 'lock always released');
});

test('runSync stays dirty when build succeeds but wiring is unreadable', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-sync-'));
  writeStats(d, { ...emptyStats(), dirty: true, syncing: true, staleCount: 2 });
  acquireLock(d);
  runSync(d, () => { /* build "succeeds" but writes no wiring.json */ });
  const s = readStats(d)!;
  assert.equal(s.syncing, false);
  assert.equal(s.dirty, true, 'unreadable wiring → stay dirty, retry next turn');
  assert.equal(s.syncedAt, null, 'not marked synced');
  assert.equal(acquireLock(d), true, 'lock released');
});

// ── lastFileScopeHint (the "you're working in backend/, weight it" hint) ──

/** backend/ (py) + frontend/ (ts) scopes, one file node each, distinct
 * basenames so a lookup by basename is unambiguous. */
function writeMultiScopeWiring(d: string): void {
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(
    join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({
      meta: {
        nodeCount: 2, edgeCount: 0, languages: ['typescript', 'python'],
        scopes: [
          { prefix: 'backend', label: 'backend', markers: ['pyproject.toml'] },
          { prefix: 'frontend', label: 'frontend', markers: ['package.json'] },
        ],
      },
      nodes: [
        { id: 'backend/app.py', name: 'app.py', kind: 'file', path: 'backend/app.py', span: 'L1-L1' },
        { id: 'frontend/src/auth.ts', name: 'auth.ts', kind: 'file', path: 'frontend/src/auth.ts', span: 'L1-L1' },
      ],
      edges: [],
    }),
  );
}

test('lastFileScopeHint: resolves a matching lastFile to its scope prefix', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-hint-'));
  writeMultiScopeWiring(d);
  assert.equal(lastFileScopeHint(d, 'app.py'), 'backend');
  assert.equal(lastFileScopeHint(d, 'auth.ts'), 'frontend');
});

test('lastFileScopeHint: null on a single-scope graph, a missing lastFile, or no graph at all', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-hint-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(
    join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({
      meta: { nodeCount: 1, edgeCount: 0, languages: [] },
      nodes: [{ id: 'a.ts', name: 'a.ts', kind: 'file', path: 'a.ts', span: 'L1-L1' }],
      edges: [],
    }),
  );
  assert.equal(lastFileScopeHint(d, 'a.ts'), null, 'single-scope repo: no hint, no --in');
  assert.equal(lastFileScopeHint(d, null), null, 'no lastFile yet: no hint');
  assert.equal(lastFileScopeHint(d, undefined), null);
  const noGraphDir = mkdtempSync(join(tmpdir(), 'graft-hint-nograph-'));
  assert.equal(lastFileScopeHint(noGraphDir, 'a.ts'), null, 'no graph built yet: no hint');
});

test('lastFileScopeHint: a root-scope lastFile needs no --in (root already covers everything)', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-hint-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(
    join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({
      meta: {
        nodeCount: 2, edgeCount: 0, languages: [],
        scopes: [
          { prefix: '', label: '', markers: [] },
          { prefix: 'frontend', label: 'frontend', markers: ['package.json'] },
        ],
      },
      nodes: [
        { id: 'README.md', name: 'README.md', kind: 'file', path: 'README.md', span: 'L1-L1' },
        { id: 'frontend/a.ts', name: 'a.ts', kind: 'file', path: 'frontend/a.ts', span: 'L1-L1' },
      ],
      edges: [],
    }),
  );
  assert.equal(lastFileScopeHint(d, 'README.md'), null);
});

test('lastFileScopeHint: fails soft (null, logged to stderr) when lastFile is stale — not in the current graph', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-hint-'));
  writeMultiScopeWiring(d);
  const errors: string[] = [];
  const origError = console.error;
  (console as any).error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    assert.equal(lastFileScopeHint(d, 'nonexistent.ts'), null, 'a stale lastFile degrades to no hint, never throws');
    assert.ok(errors.length > 0, 'the skipped hint is logged to stderr, not silently swallowed');
    assert.match(errors[0], /nonexistent\.ts/);
  } finally {
    console.error = origError;
  }
});

test('lastFileScopeHint: fails soft (null, logged to stderr) when lastFile is ambiguous across scopes', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-hint-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(
    join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({
      meta: {
        nodeCount: 2, edgeCount: 0, languages: [],
        scopes: [
          { prefix: 'backend', label: 'backend', markers: ['go.mod'] },
          { prefix: 'frontend', label: 'frontend', markers: ['package.json'] },
        ],
      },
      nodes: [
        { id: 'backend/index.ts', name: 'index.ts', kind: 'file', path: 'backend/index.ts', span: 'L1-L1' },
        { id: 'frontend/index.ts', name: 'index.ts', kind: 'file', path: 'frontend/index.ts', span: 'L1-L1' },
      ],
      edges: [],
    }),
  );
  const errors: string[] = [];
  const origError = console.error;
  (console as any).error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    assert.equal(lastFileScopeHint(d, 'index.ts'), null, 'ambiguous across scopes degrades to no hint, never throws');
    assert.ok(errors.length > 0, 'the skipped hint is logged to stderr, not silently swallowed');
  } finally {
    console.error = origError;
  }
});

// ── prompt hook: --in <scope> narrowing end-to-end ─────────────────────────

/** A `graft ask` stub (`.cjs` so it runs as CommonJS regardless of this
 * package's `"type": "module"`) that records the exact argv it was invoked
 * with — GRAFT_TEST_CLI (mirrors GRAFT_TEST_STDIN/GRAFT_TEST_SYNC_RUN) points
 * graftJson at it instead of the real, unbuilt-in-tests CLI. */
function writeAskArgsStub(d: string): { stub: string; argsFile: string } {
  const stub = join(d, 'ask-stub.cjs');
  const argsFile = join(d, 'args-seen.json');
  writeFileSync(
    stub,
    `const fs = require('fs');\n` +
      `const args = process.argv.slice(2);\n` +
      `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));\n` +
      `process.stdout.write(JSON.stringify({ query: args[1] || '', mode: 'lexical', hits: [], coverage: 1 }));\n`,
  );
  return { stub, argsFile };
}

test('prompt hook passes --in <scope> when lastFile resolves to a scope on a multi-scope repo', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-prompt-scope-'));
  writeMultiScopeWiring(d);
  writeStats(d, { ...emptyStats(), lastFile: 'app.py' });
  const { stub, argsFile } = writeAskArgsStub(d);
  process.env.CLAUDE_PROJECT_DIR = d;
  process.env.GRAFT_TEST_CLI = stub;
  try {
    await runWithStdin(
      JSON.stringify({ session_id: 'p-scope', prompt: 'how does the backend handle auth' }),
      () => main('prompt'),
    );
    const argsSeen: string[] = JSON.parse(readFileSync(argsFile, 'utf8'));
    const inIdx = argsSeen.indexOf('--in');
    assert.ok(inIdx !== -1, 'the ask call carries --in');
    assert.equal(argsSeen[inIdx + 1], 'backend', 'narrowed to the scope lastFile (app.py) resolves to');
  } finally {
    delete process.env.GRAFT_TEST_CLI;
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test('prompt hook omits --in on a single-scope repo even with lastFile set', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-prompt-scope-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({ meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] }));
  writeStats(d, { ...emptyStats(), lastFile: 'auth.ts' });
  const { stub, argsFile } = writeAskArgsStub(d);
  process.env.CLAUDE_PROJECT_DIR = d;
  process.env.GRAFT_TEST_CLI = stub;
  try {
    await runWithStdin(
      JSON.stringify({ session_id: 'p-single', prompt: 'how does auth work here' }),
      () => main('prompt'),
    );
    const argsSeen: string[] = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.equal(argsSeen.indexOf('--in'), -1, 'single-scope repo: no --in narrowing');
  } finally {
    delete process.env.GRAFT_TEST_CLI;
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test('prompt hook omits --in and logs to stderr when lastFile is ambiguous across scopes', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-prompt-scope-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(
    join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({
      meta: {
        nodeCount: 2, edgeCount: 0, languages: [],
        scopes: [
          { prefix: 'backend', label: 'backend', markers: ['go.mod'] },
          { prefix: 'frontend', label: 'frontend', markers: ['package.json'] },
        ],
      },
      nodes: [
        { id: 'backend/index.ts', name: 'index.ts', kind: 'file', path: 'backend/index.ts', span: 'L1-L1' },
        { id: 'frontend/index.ts', name: 'index.ts', kind: 'file', path: 'frontend/index.ts', span: 'L1-L1' },
      ],
      edges: [],
    }),
  );
  writeStats(d, { ...emptyStats(), lastFile: 'index.ts' });
  const { stub, argsFile } = writeAskArgsStub(d);
  const errors: string[] = [];
  const origError = console.error;
  (console as any).error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  process.env.CLAUDE_PROJECT_DIR = d;
  process.env.GRAFT_TEST_CLI = stub;
  try {
    await runWithStdin(
      JSON.stringify({ session_id: 'p-ambig', prompt: 'how is the index wired up' }),
      () => main('prompt'),
    );
    const argsSeen: string[] = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.equal(argsSeen.indexOf('--in'), -1, 'ambiguous lastFile: no --in narrowing');
    assert.ok(errors.length > 0, 'the skipped hint is logged to stderr — never a silent no-op the hook can hide');
  } finally {
    console.error = origError;
    delete process.env.GRAFT_TEST_CLI;
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test('prompt branch stays silent and writes no session when graft is not built', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-prompt-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: any) => { chunks.push(String(s)); return true; };
  try {
    await runWithStdin(
      JSON.stringify({ session_id: 'p1', prompt: 'how does pkce verification work' }),
      () => main('prompt'),
    );
  } finally {
    (process.stdout as any).write = orig;
    delete process.env.CLAUDE_PROJECT_DIR;
  }
  assert.equal(chunks.join(''), '', 'no stdout when graft ask unavailable (no dist/cli.js in temp dir)');
  assert.equal(existsSync(join(d, 'graft', '.cache', 'session', 'p1.json')), false, 'no session file on no-op');
});

test('tool-savings sums the [graft] footer into the session total, keyed by session_id', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-savings-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    // A graft tool result the agent just read (shape mirrors a Bash tool_response).
    const stdin = JSON.stringify({
      session_id: 's1',
      tool_name: 'Bash',
      tool_response: { stdout: 'skeleton …\n\n[graft] tokens saved ≈ 2,181 (89%) — this output ≈ 258 tok …' },
    });
    await runWithStdin(stdin, () => main('tool-savings'));
    assert.equal(readSession(d, 's1').savedTokens, 2181);

    // A second graft call in the same session accumulates.
    const again = JSON.stringify({
      session_id: 's1',
      tool_response: { stdout: '[graft] tokens saved ≈ 7,510 (99%) — this output ≈ 57 tok …' },
    });
    await runWithStdin(again, () => main('tool-savings'));
    assert.equal(readSession(d, 's1').savedTokens, 2181 + 7510);

    // A different session keeps its own tally.
    assert.equal(readSession(d, 's2').savedTokens, 0);
  } finally {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test('tool-savings sums every footer when one payload carries several', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-savings-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    const stdin = JSON.stringify({
      session_id: 'multi',
      tool_response: {
        stdout:
          'graft callers …\n[graft] tokens saved ≈ 100 (90%) — …\n' +
          'graft map …\n[graft] tokens saved ≈ 1,000 (99%) — …',
      },
    });
    await runWithStdin(stdin, () => main('tool-savings'));
    assert.equal(readSession(d, 'multi').savedTokens, 1100);
  } finally {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test('tool-savings is a no-op (no session file) when the tool output has no graft footer', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-savings-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    const stdin = JSON.stringify({
      session_id: 'nofooter',
      tool_name: 'Bash',
      tool_response: { stdout: 'total 12\ndrwxr-xr-x  ...' },
    });
    await runWithStdin(stdin, () => main('tool-savings'));
    assert.equal(existsSync(join(d, 'graft', '.cache', 'session', 'nofooter.json')), false, 'no write without a footer');
  } finally {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test('tool-savings counts a REAL savings line (with the turn nudge) exactly once', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-savings-real-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    // body ≈ 10 tok, baseline ≈ 2000 tok → footer claims ≈ 1990 saved. The nudge
    // (with its "🌱 graft saved ~N tokens" example) must NOT be double-counted.
    const footer = savingsLine('x'.repeat(40), { files: 2, baselineChars: 8000 });
    const stdin = JSON.stringify({ session_id: 'real', tool_response: { stdout: `callers …${footer}` } });
    await runWithStdin(stdin, () => main('tool-savings'));
    assert.equal(readSession(d, 'real').savedTokens, 1990);
  } finally {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

// ── the usage-mix counters: graft vs source (both hosts) ───────────────────

test('tool-savings now scores the mix: a Read is a source read, a graft footer is a graft read', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-mix-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    await runWithStdin(JSON.stringify({ session_id: 'm', tool_name: 'Read', tool_input: { file_path: '/x' } }), () => main('tool-savings'));
    assert.equal(readSession(d, 'm').sourceReads, 1, 'Read counted as a source read');
    assert.equal(readSession(d, 'm').graftReads, 0);

    await runWithStdin(JSON.stringify({
      session_id: 'm', tool_name: 'Bash',
      tool_response: { stdout: '[graft] tokens saved ≈ 500 — …' },
    }), () => main('tool-savings'));
    assert.equal(readSession(d, 'm').graftReads, 1, 'a graft footer counts as a graft read');
    assert.equal(readSession(d, 'm').savedTokens, 500);
  } finally {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

// ── Cursor hook adapters ────────────────────────────────────────────────────

test('cursor-post-tool: Read → source read, Shell graft → graft read + savings, keyed by conversation_id', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-cursor-pt-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    await runWithStdin(JSON.stringify({ conversation_id: 'c1', tool_name: 'Read', tool_input: {} }), () => main('cursor-post-tool'));
    assert.equal(readSession(d, 'c1').sourceReads, 1);

    await runWithStdin(JSON.stringify({
      conversation_id: 'c1', tool_name: 'Shell',
      tool_input: { command: 'graft ask "x"' },
      tool_output: JSON.stringify({ stdout: '…\n[graft] tokens saved ≈ 900 — …' }),
    }), () => main('cursor-post-tool'));
    assert.equal(readSession(d, 'c1').graftReads, 1, 'Shell graft CLI is a graft read');
    assert.equal(readSession(d, 'c1').savedTokens, 900, 'savings parsed out of tool_output');
  } finally {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test('cursor-post-tool skips graft MCP tools — prefixed AND bare — so afterMCPExecution is the only counter', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-cursor-skip-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    // prefixed shape
    await runWithStdin(JSON.stringify({ conversation_id: 'c1', tool_name: 'MCP:graft_find_code', tool_output: '{}' }), () => main('cursor-post-tool'));
    assert.equal(existsSync(join(d, 'graft', '.cache', 'session', 'c1.json')), false, 'prefixed MCP tool not counted here');
    // bare shape — the guard, not just the installed matcher, must catch this or it double-counts
    await runWithStdin(JSON.stringify({ conversation_id: 'c2', tool_name: 'graft_find_code', tool_output: '{}' }), () => main('cursor-post-tool'));
    assert.equal(existsSync(join(d, 'graft', '.cache', 'session', 'c2.json')), false, 'bare graft MCP tool not counted here');
  } finally {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test('cursor-mcp: a graft MCP tool is a graft read with savings from result_json; a foreign MCP tool is a no-op', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-cursor-mcp-'));
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    await runWithStdin(JSON.stringify({
      conversation_id: 'c1', tool_name: 'graft_find_code',
      result_json: JSON.stringify({ text: '…\n[graft] tokens saved ≈ 1,200 — …' }),
    }), () => main('cursor-mcp'));
    assert.equal(readSession(d, 'c1').graftReads, 1);
    assert.equal(readSession(d, 'c1').savedTokens, 1200);

    await runWithStdin(JSON.stringify({ conversation_id: 'c2', tool_name: 'some_other_server_tool', result_json: '{}' }), () => main('cursor-mcp'));
    assert.equal(existsSync(join(d, 'graft', '.cache', 'session', 'c2.json')), false, 'foreign MCP tool ignored');
  } finally {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test('cursor-session-end force-closes THIS conversation even though its file was just touched (idle gate skipped)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-cursor-end-'));
  const home = mkdtempSync(join(tmpdir(), 'graft-cursor-end-home-'));
  mkdirSync(join(d, 'graft', '.cache', 'session'), { recursive: true });
  const sfile = join(d, 'graft', '.cache', 'session', 'c1.json');
  // mtime = now: the idle sweep would skip this, but the end hook must summarize it.
  writeFileSync(sfile, JSON.stringify({ graftReads: 8, sourceReads: 2, savedTokens: 7400 }));

  // Turn telemetry on against a scratch $HOME so the rollup actually queues (and
  // marks the file), the observable proof the force-close ran — not just no-throw.
  //
  // EVERY CI variable has to go, not just `CI`: `inCi` is deliberately generous and
  // also reads GITHUB_ACTIONS, GITLAB_CI and six more. Clearing `CI` alone passed on
  // a laptop and failed on GitHub Actions, where GITHUB_ACTIONS is set — so the list
  // comes from `CI_ENV_VARS` rather than being copied here, and cannot drift from it.
  const scrubbed = ['HOME', 'USERPROFILE', 'GRAFT_POSTHOG_KEY', 'DO_NOT_TRACK', ...CI_ENV_VARS];
  const saved = Object.fromEntries(scrubbed.map((k) => [k, process.env[k]]));
  for (const k of [...CI_ENV_VARS, 'DO_NOT_TRACK']) delete process.env[k];
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_key';
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    await runWithStdin(JSON.stringify({ conversation_id: 'c1' }), () => main('cursor-session-end'));
    assert.equal(readSession(d, 'c1').summarized, true, 'the just-ended conversation was rolled up');
  } finally {
    delete process.env.CLAUDE_PROJECT_DIR;
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

/**
 * The prompt hook's `graft ask` child must stay inside the budget THIS repo has
 * installed, not the one the current source would install. `mergeGraftSettings` runs
 * only during `graft init`, so an npm upgrade leaves every already-wired repo on its
 * old `timeout` — and a child that outlives it gets the whole hook killed by Claude
 * Code, which means no retrieval pack and no session write at all.
 */
function withSettings(timeout: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'graft-hooktimeout-'));
  mkdirSync(join(d, '.claude'), { recursive: true });
  const hooks = timeout === undefined ? {} : {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node ".claude/helpers/graft-hooks.cjs" prompt', timeout }] }],
  };
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ hooks }));
  return d;
}

test('promptAskTimeout is derived from the installed hook budget', () => {
  // User-level settings are one of the sources now, so point them somewhere empty:
  // otherwise these assertions read whatever the developer running the suite has
  // wired on their own machine.
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'graft-nouser-'));
  try {
    // A repo wired before the budget was raised.
    assert.equal(promptAskTimeout(withSettings(8000)), 6000);
    // A repo wired after.
    assert.equal(promptAskTimeout(withSettings(15000)), 13000);
    // Never so small the child has no chance.
    assert.equal(promptAskTimeout(withSettings(1000)), 4000);

    // Nothing readable: assume the conservative 8s budget the other hooks carry.
    assert.equal(promptAskTimeout(withSettings(undefined)), 6000);
    assert.equal(promptAskTimeout(withSettings('nonsense')), 6000);
    assert.equal(promptAskTimeout(mkdtempSync(join(tmpdir(), 'graft-nosettings-'))), 6000);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

/**
 * Hooks can be declared once at the user level, wiring every repo on the machine.
 * Such a repo has no `.claude/settings.json`, so a lookup that only reads the repo
 * finds nothing and falls back to the conservative 8s — starving the query in any
 * repo whose graph takes longer than that, with no error to say so.
 */
function withUserSettings(timeout: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'graft-userhooks-'));
  const hooks = timeout === undefined ? {} : {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/helpers/graft-hooks.cjs" prompt', timeout }] }],
  };
  writeFileSync(join(d, 'settings.json'), JSON.stringify({ hooks }));
  return d;
}

test('promptAskTimeout reads a user-level hook when the repo declares none', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = withUserSettings(15000);
    // A repo with no .claude/ of its own still gets the budget it truly runs under.
    assert.equal(promptAskTimeout(mkdtempSync(join(tmpdir(), 'graft-nosettings-'))), 13000);

    // Declared in both places: Claude Code fires both entries and this process
    // cannot tell which launched it, so the smallest budget is the only safe one.
    assert.equal(promptAskTimeout(withSettings(8000)), 6000);

    process.env.CLAUDE_CONFIG_DIR = withUserSettings(8000);
    assert.equal(promptAskTimeout(withSettings(15000)), 6000);

    // Nothing anywhere still means the conservative default.
    process.env.CLAUDE_CONFIG_DIR = withUserSettings(undefined);
    assert.equal(promptAskTimeout(mkdtempSync(join(tmpdir(), 'graft-nosettings-'))), 6000);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

// ── GRAFT_DIR: the hooks' own `graft ask`/`graft check` children, and the
// SessionStart INDEX.md read, must land on the same relocated context dir
// that readWiring/readStats/patchStats/acquireLock/session state already
// resolve through resolveContextDir. ──────────────────────────────────────

test('prompt hook passes --dir <resolved> to graft ask when GRAFT_DIR is set', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-prompt-dir-'));
  mkdirSync(join(d, 'elsewhere', '.graph'), { recursive: true });
  writeFileSync(join(d, 'elsewhere', '.graph', 'wiring.json'),
    JSON.stringify({ meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] }));
  const { stub, argsFile } = writeAskArgsStub(d);
  process.env.CLAUDE_PROJECT_DIR = d;
  process.env.GRAFT_TEST_CLI = stub;
  process.env.GRAFT_DIR = 'elsewhere';
  try {
    await runWithStdin(
      JSON.stringify({ session_id: 'p-dir', prompt: 'how does the relocated graph get queried' }),
      () => main('prompt'),
    );
    const argsSeen: string[] = JSON.parse(readFileSync(argsFile, 'utf8'));
    const dirIdx = argsSeen.indexOf('--dir');
    assert.ok(dirIdx !== -1, 'the ask call carries --dir when GRAFT_DIR is set');
    assert.equal(argsSeen[dirIdx + 1], resolveContextDir(d));
  } finally {
    delete process.env.GRAFT_TEST_CLI;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.GRAFT_DIR;
  }
});

test('prompt hook omits --dir when GRAFT_DIR is unset (byte-identical argv to before)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-prompt-dir-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({ meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] }));
  const { stub, argsFile } = writeAskArgsStub(d);
  process.env.CLAUDE_PROJECT_DIR = d;
  process.env.GRAFT_TEST_CLI = stub;
  try {
    await runWithStdin(
      JSON.stringify({ session_id: 'p-nodir', prompt: 'how does the default graph get queried' }),
      () => main('prompt'),
    );
    const argsSeen: string[] = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.equal(argsSeen.indexOf('--dir'), -1, 'unconfigured repo: no --dir added');
  } finally {
    delete process.env.GRAFT_TEST_CLI;
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test('post-edit passes --dir <resolved> to graft check when GRAFT_DIR is set', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-postedit-dir-'));
  mkdirSync(join(d, 'elsewhere', '.graph'), { recursive: true });
  writeFileSync(join(d, 'elsewhere', '.graph', 'wiring.json'),
    JSON.stringify({ meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] }));
  // post-edit only runs the check when a graft statusline will read the count.
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ statusLine: GRAFT_STATUSLINE }));
  const stub = join(d, 'check-stub.cjs');
  const argsFile = join(d, 'args-seen.json');
  writeFileSync(
    stub,
    `const fs = require('fs');\n` +
      `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n` +
      `process.stdout.write(JSON.stringify({ graph: { changed: [], added: [], removed: [] } }));\n`,
  );
  process.env.CLAUDE_PROJECT_DIR = d;
  process.env.GRAFT_TEST_CLI = stub;
  process.env.GRAFT_DIR = 'elsewhere';
  try {
    const stdin = JSON.stringify({ tool_input: { file_path: join(d, 'src', 'auth.ts') } });
    await runWithStdin(stdin, () => main('post-edit'));
    const argsSeen: string[] = JSON.parse(readFileSync(argsFile, 'utf8'));
    const dirIdx = argsSeen.indexOf('--dir');
    assert.ok(dirIdx !== -1, 'the check call carries --dir when GRAFT_DIR is set');
    assert.equal(argsSeen[dirIdx + 1], resolveContextDir(d));
  } finally {
    delete process.env.GRAFT_TEST_CLI;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.GRAFT_DIR;
  }
});

test('session-start reads INDEX.md from a GRAFT_DIR-relocated context dir', async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-session-start-dir-'));
  mkdirSync(join(d, 'elsewhere'), { recursive: true });
  writeFileSync(join(d, 'elsewhere', 'INDEX.md'), '# repo map (relocated)\n');
  process.env.CLAUDE_PROJECT_DIR = d;
  process.env.GRAFT_DIR = 'elsewhere';
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: any) => { chunks.push(String(s)); return true; };
  try {
    await runWithStdin('{}', () => main('session-start'));
  } finally {
    (process.stdout as any).write = orig;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.GRAFT_DIR;
  }
  assert.match(chunks.join(''), /repo map \(relocated\)/, 'orientation was built from the relocated INDEX.md');
});
