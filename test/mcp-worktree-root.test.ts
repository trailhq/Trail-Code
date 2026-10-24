import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildGraph } from '../src/graph/build.js';
import { __parseCount, __resetParseCounts, loadGraphCached } from '../src/graph/load.js';
import { TOOLS, callTool } from '../src/mcp/tools.js';

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'graft test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'graft test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const source = (version: string, caller: string): string =>
  `export function version(): string {\n  return '${version}';\n}\nexport function ${caller}(): string {\n  return version();\n}\nexport function entry(): string {\n  return ${caller}();\n}\n`;
async function fixture(t: { after: (fn: () => void) => void }) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'graft-mcp-roots-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = join(base, 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  git(main, 'init', '-b', 'main');
  writeFileSync(join(main, '.gitignore'), 'graft/\n');
  writeFileSync(join(main, 'src', 'version.ts'), source('old-checkout', 'reviewOnly'));
  git(main, 'add', '-A'); git(main, 'commit', '-m', 'old version');
  const olderHead = git(main, 'rev-parse', 'HEAD');
  const review = join(main, '.claude', 'worktrees', 'review');
  git(main, 'worktree', 'add', '--detach', review, olderHead);
  writeFileSync(join(main, 'src', 'version.ts'), source('current-checkout', 'parentOnly'));
  git(main, 'add', 'src/version.ts'); git(main, 'commit', '-m', 'current version');
  const mainHead = git(main, 'rev-parse', 'HEAD');
  await buildGraph(main);
  assert.equal(existsSync(join(review, 'graft')), false);
  return { base, main, review, olderHead, mainHead };
}
function body(text: string): string { return text.split('\n[graft] root:')[0]; }
function provenance(text: string, root: string, head: string): void {
  const footer = text.slice(text.lastIndexOf('\n[graft] root:') + 1);
  assert.equal(footer, `[graft] root: ${realpathSync.native(root)} · HEAD: ${head}`);
}

test('every schema accepts an optional root', () => {
  for (const tool of TOOLS) {
    const schema = tool.inputSchema as { properties: Record<string, { type?: string }>; required?: string[] };
    assert.equal(schema.properties.root?.type, 'string', tool.name);
    assert.ok(!schema.required?.includes('root'));
  }
});

for (const brand of ['graft', 'trail'] as const) {
  test(`${brand} and legacy aliases select the same worktree with branded provenance`, async (t) => {
    const previous = process.env.TRAIL_INVOKED_AS;
    process.env.TRAIL_INVOKED_AS = brand;
    t.after(() => {
      if (previous === undefined) delete process.env.TRAIL_INVOKED_AS;
      else process.env.TRAIL_INVOKED_AS = previous;
    });
    const f = await fixture(t);
    for (const prefix of ['graft', 'trail']) {
      const answer = await callTool(f.main, `${prefix}_find_all`, { pattern: 'checkout', root: f.review });
      assert.equal(answer.isError, false, answer.text);
      assert.match(answer.text, /old-checkout/);
      assert.doesNotMatch(answer.text, /current-checkout/);
      assert.ok(answer.text.endsWith(`[${brand}] root: ${f.review} · HEAD: ${f.olderHead}`));
    }
    const missing = join(f.base, 'empty');
    mkdirSync(missing);
    const rejected = await callTool(f.main, `${brand}_find_all`, { pattern: 'checkout', root: missing });
    assert.equal(rejected.isError, true);
    assert.equal(existsSync(join(missing, 'graft')), false, 'invalid roots never create a graph');
    const noGraph = await callTool(missing, `${brand}_trace_calls`, { symbol: 'missing' });
    assert.equal(noGraph.isError, true);
    assert.ok(noGraph.text.includes(`${brand} build`), noGraph.text);
  });
}

test('two checkout graphs, source spans and HEADs stay isolated across all tools and cached calls', async (t) => {
  const f = await fixture(t);
  const defaults = await callTool(f.main, 'graft_find_code', { query: 'version', full: true });
  assert.equal(defaults.isError, false);
  assert.match(body(defaults.text), /current-checkout/);
  provenance(defaults.text, f.main, f.mainHead);
  const selected = await callTool(f.main, 'graft_find_code', { query: 'version', full: true, root: f.review });
  assert.equal(selected.isError, false);
  assert.match(body(selected.text), /old-checkout/);
  assert.doesNotMatch(body(selected.text), /current-checkout|parentOnly/);
  provenance(selected.text, f.review, f.olderHead);
  assert.ok(existsSync(join(f.review, 'graft', '.graph', 'wiring.json')), 'target seeds then refreshes');

  for (const [name, args, expected, absent] of [
    ['graft_find_all', { pattern: 'checkout' }, 'old-checkout', 'current-checkout'],
    ['graft_file_api', { file: 'src/version.ts' }, 'reviewOnly', 'parentOnly'],
    ['graft_trace_calls', { symbol: 'version' }, 'reviewOnly', 'parentOnly'],
    ['graft_repo_map', {}, 'reviewOnly', 'parentOnly'],
    ['graft_check_freshness', {}, 'graph check: OK', 'graph check: stale'],
  ] as const) {
    const answer = await callTool(f.main, name, { ...args, root: f.review });
    assert.equal(answer.isError, false, answer.text);
    assert.ok(body(answer.text).includes(expected), answer.text);
    assert.ok(!body(answer.text).includes(absent), answer.text);
    provenance(answer.text, f.review, f.olderHead);
  }
  const alias = await callTool(f.main, 'graft_grep', { pattern: 'checkout', root: f.review });
  assert.match(body(alias.text), /old-checkout/);
  provenance(alias.text, f.review, f.olderHead);

  loadGraphCached(join(f.main, 'graft')); loadGraphCached(join(f.review, 'graft'));
  __resetParseCounts();
  for (let i = 0; i < 3; i++) {
    const parent = await callTool(f.main, 'graft_trace_calls', { symbol: 'version' });
    const target = await callTool(f.main, 'graft_trace_calls', { symbol: 'version', root: f.review });
    assert.match(body(parent.text), /parentOnly/); assert.doesNotMatch(body(parent.text), /reviewOnly/);
    assert.match(body(target.text), /reviewOnly/); assert.doesNotMatch(body(target.text), /parentOnly/);
    provenance(parent.text, f.main, f.mainHead); provenance(target.text, f.review, f.olderHead);
    const parentAsk = await callTool(f.main, 'graft_find_code', { query: 'version', full: true });
    const targetAsk = await callTool(f.main, 'graft_find_code', { query: 'version', full: true, root: f.review });
    assert.match(body(parentAsk.text), /current-checkout/); assert.match(body(targetAsk.text), /old-checkout/);
  }
  assert.equal(__parseCount.graph, 0, 'each root retains its graph cache');
  assert.equal(__parseCount.askIndex, 0, 'each root retains its ask-index cache');

  const mainGraphBefore = readFileSync(join(f.main, 'graft', '.graph', 'wiring.json'), 'utf8');
  writeFileSync(join(f.review, 'src', 'version.ts'), source('updated-review', 'reviewUpdated'));
  git(f.review, 'add', 'src/version.ts'); git(f.review, 'commit', '-m', 'advance review HEAD');
  const newHead = git(f.review, 'rev-parse', 'HEAD');
  const reviewGraphBefore = readFileSync(join(f.review, 'graft', '.graph', 'wiring.json'), 'utf8');
  const drift = await callTool(f.main, 'graft_check_freshness', { root: f.review });
  assert.match(body(drift.text), /changed \(|removed \(|added \(/);
  assert.equal(readFileSync(join(f.review, 'graft', '.graph', 'wiring.json'), 'utf8'), reviewGraphBefore, 'freshness reports drift without repairing it');
  provenance(drift.text, f.review, newHead);
  const updated = await callTool(f.main, 'graft_find_code', { query: 'version', full: true, root: f.review });
  assert.match(body(updated.text), /updated-review/); assert.doesNotMatch(body(updated.text), /old-checkout/);
  provenance(updated.text, f.review, newHead);
  assert.equal(readFileSync(join(f.main, 'graft', '.graph', 'wiring.json'), 'utf8'), mainGraphBefore);
  const parent = await callTool(f.main, 'graft_find_code', { query: 'version', full: true });
  assert.match(body(parent.text), /current-checkout/); provenance(parent.text, f.main, f.mainHead);
});

test('relative roots, checkout subdirectories and symlink aliases resolve within the same repository', async (t) => {
  const f = await fixture(t);
  for (const root of [relative(f.main, f.review), join(f.review, 'src')]) {
    const answer = await callTool(f.main, 'graft_find_all', { pattern: 'checkout', root });
    assert.equal(answer.isError, false, answer.text); assert.match(body(answer.text), /old-checkout/);
    provenance(answer.text, f.review, f.olderHead);
  }
  const alias = join(f.base, 'review-alias');
  symlinkSync(f.review, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const answer = await callTool(f.main, 'graft_find_all', { pattern: 'checkout', root: alias });
  assert.equal(answer.isError, false, answer.text); provenance(answer.text, f.review, f.olderHead);
});

test('invalid, foreign, cloned and submodule roots are refused before any graph write', async (t) => {
  const f = await fixture(t);
  const plain = join(f.base, 'plain'); mkdirSync(plain);
  const foreign = join(f.base, 'foreign'); mkdirSync(foreign); git(foreign, 'init', '-b', 'main');
  const clone = join(f.base, 'clone'); git(f.base, 'clone', f.main, clone);
  const submodule = join(f.main, 'module');
  git(f.main, '-c', 'protocol.file.allow=always', 'submodule', 'add', clone, 'module');
  const foreignAlias = join(f.base, 'foreign-alias');
  symlinkSync(foreign, foreignAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const before = readFileSync(join(f.main, 'graft', '.graph', 'wiring.json'), 'utf8');
  for (const root of ['', 42, null, join(f.base, 'missing'), plain, foreign, clone, submodule, foreignAlias]) {
    const answer = await callTool(f.main, 'graft_repo_map', { root });
    assert.equal(answer.isError, true, `root=${root}: ${answer.text}`);
    assert.match(answer.text, /root/i);
  }
  assert.equal(readFileSync(join(f.main, 'graft', '.graph', 'wiring.json'), 'utf8'), before);
  for (const root of [plain, foreign, clone, submodule]) assert.equal(existsSync(join(root, 'graft')), false);
});

test('a pinned --dir never follows root to another checkout', async (t) => {
  const f = await fixture(t);
  const graphDir = join(f.main, 'custom-graph'); await buildGraph(f.main, { contextDir: graphDir });
  const before = readFileSync(join(graphDir, '.graph', 'wiring.json'), 'utf8');
  const denied = await callTool(f.main, 'graft_find_all', { pattern: 'checkout', root: f.review }, graphDir);
  assert.equal(denied.isError, true); assert.match(denied.text, /--dir/);
  assert.equal(readFileSync(join(graphDir, '.graph', 'wiring.json'), 'utf8'), before);
  assert.equal(existsSync(join(f.review, 'graft')), false);
  const own = await callTool(f.main, 'graft_find_all', { pattern: 'checkout', root: f.main }, graphDir);
  assert.equal(own.isError, false, own.text); assert.match(body(own.text), /current-checkout/);
  provenance(own.text, f.main, f.mainHead);
  const scope = join(f.main, 'src');
  const scopedGraph = join(f.base, 'scoped-graph'); await buildGraph(scope, { contextDir: scopedGraph });
  const scoped = await callTool(scope, 'graft_find_all', { pattern: 'checkout', root: f.main }, scopedGraph);
  assert.equal(scoped.isError, false, scoped.text); assert.match(body(scoped.text), /current-checkout/);
  provenance(scoped.text, scope, f.mainHead);
});

test('non-Git default queries keep working and report unavailable HEAD', async (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'graft-mcp-no-git-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'x.ts'), 'export function standalone() { return 1; }\n');
  await buildGraph(dir);
  const answer = await callTool(dir, 'graft_file_api', { file: 'x.ts' });
  assert.equal(answer.isError, false, answer.text); assert.match(body(answer.text), /standalone/);
  provenance(answer.text, dir, 'unavailable');
});

test('inherited Git root overrides cannot change checkout identity or reported HEAD', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.review, 'src', 'target-only.ts'), 'export function targetOnly() { return 42; }\n');
  git(f.review, 'add', 'src/target-only.ts'); git(f.review, 'commit', '-m', 'target-only file');
  const targetHead = git(f.review, 'rev-parse', 'HEAD');
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];
  const previous = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
  process.env.GIT_DIR = join(f.main, '.git');
  process.env.GIT_WORK_TREE = f.main;
  process.env.GIT_COMMON_DIR = join(f.main, '.git');
  const answer = await callTool(f.main, 'graft_find_all', { pattern: 'checkout', root: f.review });
  assert.equal(answer.isError, false, answer.text); assert.match(body(answer.text), /old-checkout/);
  provenance(answer.text, f.review, targetHead);
  const unique = await callTool(f.main, 'graft_trace_calls', { symbol: 'targetOnly', root: f.review });
  assert.equal(unique.isError, false, unique.text); assert.match(body(unique.text), /targetOnly/);
  provenance(unique.text, f.review, targetHead);
  const foreign = join(f.base, 'foreign'); mkdirSync(foreign); git(foreign, 'init', '-b', 'main');
  const denied = await callTool(f.main, 'graft_repo_map', { root: foreign });
  assert.equal(denied.isError, true); assert.match(denied.text, /not a checkout/);
  assert.equal(existsSync(join(foreign, 'graft')), false);
});
