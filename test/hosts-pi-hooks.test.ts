import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPiHooks, piHookTargets, piExtensionPathFor, piShimPathFor, piExtensionTemplate } from '../src/hosts/pi-hooks.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-pihooks-')); }

/**
 * Windows has no POSIX exec bit (see the codex-hooks test of the same name) —
 * assert the property that exists on both platforms and check the mode only
 * where there is one.
 */
const HAS_EXEC_BIT = process.platform !== 'win32';

function assertRunnableShim(shim: string, note: string): void {
  assert.ok(existsSync(shim), `${note}: shim missing at ${shim}`);
  if (HAS_EXEC_BIT) assert.ok(statSync(shim).mode & 0o111, note);
}

test('no-op when the Pi config dir is absent', () => {
  assert.deepEqual(installPiHooks(fresh()), []);
});

test('writes shim + extension, idempotent on re-run', () => {
  const home = fresh();
  mkdirSync(join(home, '.pi'), { recursive: true });
  const w = installPiHooks(home);
  assert.equal(w.length, 2);
  const shim = piShimPathFor(home);
  assertRunnableShim(shim, 'shim is executable');
  const ext = piExtensionPathFor(home);
  assert.ok(existsSync(ext), 'extension written');
  // The adapter is the translation layer: same four sub-commands as the Codex entries.
  const text = readFileSync(ext, 'utf8');
  for (const sub of ['session-start', 'prompt', 'post-edit', 'stop']) {
    assert.ok(text.includes(`"${sub}"`), `adapter spawns the ${sub} sub-command`);
  }
  // It spawns the shim it was installed next to, not a hard-coded other path.
  assert.ok(text.includes(JSON.stringify(shim)), 'adapter points at the installed shim');
  // Event names mirror the Codex hook set.
  for (const ev of ['session_start', 'before_agent_start', 'tool_result', 'agent_end']) {
    assert.ok(text.includes(`pi.on("${ev}"`), `adapter handles ${ev}`);
  }

  const again = installPiHooks(home);
  assert.deepEqual(again.map((x) => x.action), ['unchanged', 'unchanged'], 'idempotent');
});

test('targets are scoped global and gated on ~/.pi', () => {
  const home = fresh();
  assert.deepEqual(piHookTargets(home), [], 'no ~/.pi, no targets');
  mkdirSync(join(home, '.pi'), { recursive: true });
  const targets = piHookTargets(home);
  assert.equal(targets.length, 2);
  assert.ok(targets.every((t) => t.scope === 'global' && t.hostId === 'pi' && t.kind === 'hook'));
});

test('trail naming replaces graft copies so pi never loads both', () => {
  const home = fresh();
  mkdirSync(join(home, '.pi'), { recursive: true });
  installPiHooks(home, 'graft');
  assert.ok(existsSync(piExtensionPathFor(home, 'graft')), 'graft adapter present');
  installPiHooks(home, 'trail');
  assert.ok(!existsSync(piExtensionPathFor(home, 'graft')), 'graft adapter removed');
  assert.ok(!existsSync(piShimPathFor(home, 'graft')), 'graft shim removed');
  assert.ok(existsSync(piExtensionPathFor(home, 'trail')), 'trail adapter present');
  assert.ok(existsSync(piShimPathFor(home, 'trail')), 'trail shim present');
});

test('re-heals shim exec bit when a prior install had its mode stripped', () => {
  const home = fresh();
  mkdirSync(join(home, '.pi'), { recursive: true });
  installPiHooks(home);
  const shim = piShimPathFor(home);
  if (HAS_EXEC_BIT) {
    chmodSync(shim, 0o644);
    assert.ok(!(statSync(shim).mode & 0o111), 'exec bit stripped before re-run');
  }
  installPiHooks(home);
  assertRunnableShim(shim, 'exec bit restored after re-run');
});

// ── the adapter's event contract ─────────────────────────────────────────────
// The adapter is generated TypeScript that spawns the shim per event; these
// tests pin the contract by generating one against a stub shim and driving it
// through a fake pi, the same seam style as claude-hooks.test.ts's GRAFT_TEST_*.

/** A shim stand-in: prints the canned hook output for whatever sub-command it is called with. */
function stubShim(dir: string, extra = ''): string {
  const path = join(dir, 'stub-shim.cjs');
  writeFileSync(
    path,
    `const fs = require('fs');\n` +
      `const sub = process.argv[2] || '';\n` +
      `let raw = '';\n` +
      `process.stdin.on('data', (d) => (raw += d));\n` +
      `process.stdin.on('end', () => {\n` +
      `  ${extra}\n` +
      `  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Test', additionalContext: sub + ' pack' } }));\n` +
      `});\n`,
  );
  return path;
}

/** Load a generated adapter and return a fake pi capturing its handlers. */
async function loadAdapter(home: string, shim: string, name: 'graft' | 'trail' = 'graft') {
  const ext = join(home, 'adapter.ts');
  writeFileSync(ext, piExtensionTemplate(shim, name));
  const mod = await import(`file://${ext}`);
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const pi = { on: (ev: string, h: any) => handlers.set(ev, h) };
  mod.default(pi);
  return { handlers };
}

function ctxFor(dir: string) {
  return { cwd: dir, sessionManager: { getSessionId: () => 'pi-session-1' } };
}

test('before_agent_start delivers orientation once, then the prompt pack', async () => {
  const home = fresh();
  const shim = stubShim(home);
  const { handlers } = await loadAdapter(home, shim);
  const ctx = ctxFor(home);

  await handlers.get('session_start')!({ type: 'session_start' }, ctx);
  const first = await handlers.get('before_agent_start')!({ prompt: 'how does auth work?' }, ctx);
  assert.ok(first?.message?.content.includes('session-start pack'), 'orientation delivered on first prompt');
  assert.ok(first.message.content.includes('prompt pack'), 'retrieval pack delivered');

  const second = await handlers.get('before_agent_start')!({ prompt: 'and the tokens?' }, ctx);
  assert.ok(!second.message.content.includes('session-start pack'), 'orientation not re-delivered');
  assert.ok(second.message.content.includes('prompt pack'), 'prompt pack still delivered');
});

test('tool_result appends blast radius for edit/write, ignores other tools', async () => {
  const home = fresh();
  const seen = join(home, 'seen.json');
  const shim = stubShim(home, `fs.writeFileSync(${JSON.stringify(seen)}, raw);`);
  const { handlers } = await loadAdapter(home, shim);
  const ctx = ctxFor(home);
  await handlers.get('session_start')!({ type: 'session_start' }, ctx);

  // A relative path (pi's shape) must arrive at the shim absolute (Claude Code's shape).
  const result = await handlers.get('tool_result')!({
    toolName: 'edit', isError: false, input: { path: 'src/auth.ts' },
    content: [{ type: 'text', text: 'edited' }],
  }, ctx);
  assert.equal(result.content.length, 2, 'blast radius appended to the result');
  assert.equal(result.content[1].text, 'post-edit pack');
  const payload = JSON.parse(readFileSync(seen, 'utf8'));
  assert.equal(payload.tool_input.file_path, join(home, 'src', 'auth.ts'), 'path resolved absolute');

  const read = await handlers.get('tool_result')!({
    toolName: 'read', isError: false, input: { path: 'src/auth.ts' }, content: [],
  }, ctx);
  assert.equal(read, undefined, 'read results are not decorated');

  const failed = await handlers.get('tool_result')!({
    toolName: 'edit', isError: true, input: { path: 'src/auth.ts' }, content: [],
  }, ctx);
  assert.equal(failed, undefined, 'failed edits are not decorated');
});

test('a shim that prints nothing leaves every event a clean no-op', async () => {
  const home = fresh();
  const silent = join(home, 'silent.cjs');
  writeFileSync(silent, 'process.stdin.resume();\n'); // reads stdin, prints nothing
  const { handlers } = await loadAdapter(home, silent);
  const ctx = ctxFor(home);
  await handlers.get('session_start')!({ type: 'session_start' }, ctx);
  const prompt = await handlers.get('before_agent_start')!({ prompt: 'anything at all' }, ctx);
  assert.equal(prompt, undefined, 'no orientation and no pack → no message');
  const edit = await handlers.get('tool_result')!({
    toolName: 'edit', isError: false, input: { path: 'a.ts' }, content: [{ type: 'text', text: 'x' }],
  }, ctx);
  assert.equal(edit, undefined, 'no blast radius → result untouched');
});

test('a missing shim never throws — events resolve empty', async () => {
  const home = fresh();
  const { handlers } = await loadAdapter(home, join(home, 'not-here.cjs'));
  const ctx = ctxFor(home);
  await handlers.get('session_start')!({ type: 'session_start' }, ctx);
  const prompt = await handlers.get('before_agent_start')!({ prompt: 'anything at all' }, ctx);
  assert.equal(prompt, undefined);
});
