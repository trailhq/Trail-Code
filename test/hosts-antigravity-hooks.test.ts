import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ANTIGRAVITY_EDIT_MATCHER,
  antigravityAdapterPathFor,
  antigravityAdapterTemplate,
  antigravityHookTargets,
  antigravityHooksConfigPathFor,
  antigravityShimPathFor,
  antigravityStateDirFor,
  installAntigravityHooks,
} from '../src/hosts/antigravity-hooks.js';
import { changed, runRetract } from '../src/hosts/retract.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-agyhooks-')); }

const HAS_EXEC_BIT = process.platform !== 'win32';

function assertRunnable(file: string, note: string): void {
  assert.ok(existsSync(file), `${note}: missing at ${file}`);
  if (HAS_EXEC_BIT) assert.ok(statSync(file).mode & 0o111, note);
}

test('no-op when ~/.gemini/config is absent', () => {
  const home = fresh();
  assert.deepEqual(antigravityHookTargets(home), []);
  assert.deepEqual(installAntigravityHooks(home), []);
});

test('writes shim, adapter and hooks.json with Antigravity schema, idempotent on re-run', () => {
  const home = fresh();
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });

  const w = installAntigravityHooks(home, 'trail');
  assert.deepEqual(w.map((x) => [x.id, x.action]), [
    ['antigravity-hook-shim', 'created'],
    ['antigravity-hook-adapter', 'created'],
    ['antigravity-hooks', 'created'],
  ]);

  const shim = antigravityShimPathFor(home, 'trail');
  const adapter = antigravityAdapterPathFor(home, 'trail');
  const cfgPath = antigravityHooksConfigPathFor(home);
  assertRunnable(shim, 'shim is executable');
  assertRunnable(adapter, 'adapter is executable');
  assert.ok(readFileSync(adapter, 'utf8').includes(JSON.stringify(shim)), 'adapter points at installed shim');

  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.deepEqual(Object.keys(cfg), ['trail']);
  const block = cfg.trail;
  // Flat arrays for SessionStart, PreInvocation, Stop
  assert.equal(block.SessionStart.length, 1);
  assert.match(block.SessionStart[0].command, /^node "[^"]+trail-antigravity-hooks\.cjs" session-start \|\| exit 0$/);
  assert.equal(block.SessionStart[0].timeout, 10);

  assert.equal(block.PreInvocation.length, 1);
  assert.match(block.PreInvocation[0].command, /^node "[^"]+trail-antigravity-hooks\.cjs" prompt \|\| exit 0$/);
  assert.equal(block.PreInvocation[0].timeout, 15);

  assert.equal(block.Stop.length, 1);
  assert.match(block.Stop[0].command, /^node "[^"]+trail-antigravity-hooks\.cjs" stop \|\| exit 0$/);
  assert.equal(block.Stop[0].timeout, 10);

  // Grouped matcher + hooks array for PostToolUse
  assert.equal(block.PostToolUse.length, 1);
  assert.equal(block.PostToolUse[0].matcher, ANTIGRAVITY_EDIT_MATCHER);
  assert.equal(block.PostToolUse[0].hooks.length, 1);
  assert.match(block.PostToolUse[0].hooks[0].command, /^node "[^"]+trail-antigravity-hooks\.cjs" post-edit \|\| exit 0$/);
  assert.equal(block.PostToolUse[0].hooks[0].timeout, 10);

  const again = installAntigravityHooks(home, 'trail');
  assert.deepEqual(again.map((x) => x.action), ['unchanged', 'unchanged', 'unchanged'], 'idempotent');
});

test('preserves foreign top-level hooks and skips unparseable hooks.json', () => {
  const home = fresh();
  const cfgDir = join(home, '.gemini', 'config');
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = antigravityHooksConfigPathFor(home);
  const foreign = { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }] };
  writeFileSync(cfgPath, JSON.stringify({ 'lint-checker': foreign }, null, 2));

  const w = installAntigravityHooks(home, 'trail');
  assert.equal(w[2].action, 'updated');
  const root = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.deepEqual(root['lint-checker'], foreign, 'foreign hook preserved');
  assert.ok(root.trail, 'trail hook added');

  // Unparseable JSON is left untouched
  const broken = '{ "lint-checker": [ broken ';
  writeFileSync(cfgPath, broken);
  const bad = installAntigravityHooks(home, 'trail');
  assert.equal(bad[2].action, 'skipped-unparseable');
  assert.equal(readFileSync(cfgPath, 'utf8'), broken);
});

test('trail naming replaces graft copies, and a graft repo leaves machine-wide trail alone', () => {
  const home = fresh();
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });

  installAntigravityHooks(home, 'graft');
  assert.ok(existsSync(antigravityAdapterPathFor(home, 'graft')));
  assert.ok('graft' in JSON.parse(readFileSync(antigravityHooksConfigPathFor(home), 'utf8')));

  installAntigravityHooks(home, 'trail');
  assert.ok(!existsSync(antigravityAdapterPathFor(home, 'graft')), 'graft adapter removed');
  assert.ok(!existsSync(antigravityShimPathFor(home, 'graft')), 'graft shim removed');
  assert.ok(existsSync(antigravityAdapterPathFor(home, 'trail')), 'trail adapter present');
  const afterTrail = JSON.parse(readFileSync(antigravityHooksConfigPathFor(home), 'utf8'));
  assert.deepEqual(Object.keys(afterTrail), ['trail']);

  // A repo still on graft leaves the machine-wide trail hooks untouched
  const graftRun = installAntigravityHooks(home, 'graft');
  assert.deepEqual(graftRun.map((x) => x.action), ['unchanged', 'unchanged', 'unchanged']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(antigravityHooksConfigPathFor(home), 'utf8'))), ['trail']);
});

test('re-heals exec bit on shim and adapter when stripped', () => {
  const home = fresh();
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  installAntigravityHooks(home, 'trail');
  const shim = antigravityShimPathFor(home, 'trail');
  const adapter = antigravityAdapterPathFor(home, 'trail');
  if (HAS_EXEC_BIT) {
    chmodSync(shim, 0o644);
    chmodSync(adapter, 0o644);
  }
  installAntigravityHooks(home, 'trail');
  assertRunnable(shim, 'shim exec bit restored');
  assertRunnable(adapter, 'adapter exec bit restored');
});

test('retract strips our hook block, preserves foreign hooks, and removes shim/adapter/state', () => {
  const home = fresh();
  const repo = fresh();
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  const cfgPath = antigravityHooksConfigPathFor(home);
  const foreign = { PreInvocation: [{ type: 'command', command: './reminder.sh' }] };
  writeFileSync(cfgPath, JSON.stringify({ reminder: foreign }, null, 2));

  installAntigravityHooks(home, 'trail');
  mkdirSync(antigravityStateDirFor(home, 'trail'), { recursive: true });
  writeFileSync(join(antigravityStateDirFor(home, 'trail'), 's.json'), '{}');

  // --no-global leaves ~/.gemini/config alone
  runRetract(repo, { home, apply: true, global: false });
  assert.ok(existsSync(antigravityAdapterPathFor(home, 'trail')));

  // exclude: ['antigravity'] spares Antigravity's files
  runRetract(repo, { home, apply: true, global: true, exclude: ['antigravity'] });
  assert.ok(existsSync(antigravityAdapterPathFor(home, 'trail')));

  // Full retract removes trail block, shim, adapter, and state, keeping foreign hook
  runRetract(repo, { home, apply: true, global: true });
  assert.ok(!existsSync(antigravityAdapterPathFor(home, 'trail')));
  assert.ok(!existsSync(antigravityShimPathFor(home, 'trail')));
  assert.ok(!existsSync(antigravityStateDirFor(home, 'trail')));
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { reminder: foreign });
  assert.deepEqual(changed(runRetract(repo, { home, apply: true, global: true })), [], 'idempotent retract');

  // When hooks.json holds only our block, the file itself is deleted
  writeFileSync(cfgPath, '{}');
  installAntigravityHooks(home, 'trail');
  runRetract(repo, { home, apply: true, global: true });
  assert.ok(!existsSync(cfgPath), 'empty hooks.json deleted');
});

// ── the adapter's stdin/stdout event contract ────────────────────────────────

function makeAdapter(dir: string, shimPath: string, name: 'graft' | 'trail' = 'trail'): string {
  const p = join(dir, `${name}-antigravity-hooks.cjs`);
  writeFileSync(p, antigravityAdapterTemplate(shimPath, name));
  return p;
}

function makeStubShim(dir: string, body: string): string {
  const p = join(dir, 'stub-shim.cjs');
  writeFileSync(
    p,
    `const fs = require('fs');\n` +
      `const sub = process.argv[2] || '';\n` +
      `let raw = '';\n` +
      `process.stdin.on('data', (d) => (raw += d));\n` +
      `process.stdin.on('end', () => {\n` +
      `  const payload = JSON.parse(raw || '{}');\n` +
      `  ${body}\n` +
      `});\n`,
  );
  return p;
}

function runAdapter(adapter: string, event: string, stdinObj: unknown, cwd?: string): any {
  const r = spawnSync(process.execPath, [adapter, event], {
    input: typeof stdinObj === 'string' ? stdinObj : JSON.stringify(stdinObj),
    encoding: 'utf8',
    cwd,
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(r.status, 0, `adapter exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('SessionStart injects orientation + user notice, and no-ops without cwd/workspacePaths', () => {
  const dir = fresh();
  const seen = join(dir, 'seen.json');
  const shim = makeStubShim(
    dir,
    `fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ sub, payload }));\n` +
      `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'repo map' }, systemMessage: 'welcome note' }));`,
  );
  const adapter = makeAdapter(dir, shim);

  // Without cwd or workspacePaths, never fall back to process.cwd() (which is ~/.gemini/config)
  const empty = runAdapter(adapter, 'session-start', { conversationId: 'c1', workspacePaths: [] }, dir);
  assert.deepEqual(empty, {});
  assert.ok(!existsSync(seen), 'shim not spawned when no workspace is open');

  const out = runAdapter(adapter, 'session-start', {
    conversationId: 'c1',
    cwd: join(dir, 'repo'),
    workspacePaths: [join(dir, 'repo')],
    hookEventName: 'SessionStart',
  }, dir);
  assert.deepEqual(out, {
    injectSteps: [
      { systemMessage: { systemMessage: 'repo map' } },
      { systemMessage: { systemMessage: '', metadata: { user_markdown: 'welcome note' } } },
    ],
  });
  const got = JSON.parse(readFileSync(seen, 'utf8'));
  assert.equal(got.sub, 'session-start');
  assert.equal(got.payload.cwd, join(dir, 'repo'));
  assert.equal(got.payload.session_id, 'c1');
});

test('PreInvocation deduplicates prompt within a turn and re-runs after Stop or new prompt', () => {
  const dir = fresh();
  const log = join(dir, 'calls.log');
  const shim = makeStubShim(
    dir,
    `fs.appendFileSync(${JSON.stringify(log)}, sub + ':' + (payload.prompt || '') + '\\n');\n` +
      `if (sub === 'prompt') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'pack for ' + payload.prompt } }));`,
  );
  const adapter = makeAdapter(dir, shim);
  const repo = join(dir, 'repo');

  // Turn 1, invocation 1 → runs prompt
  const first = runAdapter(adapter, 'prompt', {
    conversationId: 'conv-1',
    workspacePaths: [repo],
    lastUserInput: 'how does auth work?',
    invocationNum: 1,
  });
  assert.deepEqual(first, {
    injectSteps: [{ systemMessage: { systemMessage: 'pack for how does auth work?' } }],
  });

  // Turn 1, invocation 2 (after a tool call, same lastUserInput) → fast no-op, does not re-spawn shim
  const second = runAdapter(adapter, 'prompt', {
    conversationId: 'conv-1',
    workspacePaths: [repo],
    lastUserInput: 'how does auth work?',
    invocationNum: 2,
  });
  assert.deepEqual(second, {});

  // Turn ends
  const stop = runAdapter(adapter, 'stop', {
    conversationId: 'conv-1',
    cwd: repo,
    terminationReason: 'NO_TOOL_CALL',
    continuationActive: false,
  });
  assert.deepEqual(stop, {});

  // Turn 2, even with the exact same prompt text → runs prompt again
  const third = runAdapter(adapter, 'prompt', {
    conversationId: 'conv-1',
    cwd: repo,
    lastUserInput: 'how does auth work?',
    invocationNum: 1,
  });
  assert.deepEqual(third, {
    injectSteps: [{ systemMessage: { systemMessage: 'pack for how does auth work?' } }],
  });

  // Different prompt without Stop → also triggers prompt
  const fourth = runAdapter(adapter, 'prompt', {
    conversationId: 'conv-1',
    cwd: repo,
    lastUserInput: 'now check billing',
    invocationNum: 2,
  });
  assert.deepEqual(fourth, {
    injectSteps: [{ systemMessage: { systemMessage: 'pack for now check billing' } }],
  });

  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    'prompt:how does auth work?',
    'stop:',
    'prompt:how does auth work?',
    'prompt:now check billing',
  ]);
});

test('PostToolUse runs post-edit, returns {}, and delivers blast radius on next PreInvocation', () => {
  const dir = fresh();
  const seen = join(dir, 'edits.jsonl');
  const shim = makeStubShim(
    dir,
    `if (sub === 'post-edit') {\n` +
      `  fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify(payload) + '\\n');\n` +
      `  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'blast:' + payload.tool_input.file_path } }));\n` +
      `}`,
  );
  const adapter = makeAdapter(dir, shim);
  const repo = join(dir, 'repo');

  // Start a turn so prompt won't re-run on the follow-up PreInvocation
  runAdapter(adapter, 'prompt', { conversationId: 'conv-edit', cwd: repo, lastUserInput: 'edit auth' });

  // Antigravity 2.0 edit_file with relative Path
  const editOut = runAdapter(adapter, 'post-edit', {
    conversationId: 'conv-edit',
    cwd: repo,
    toolCall: { id: 't1', name: 'edit_file', args: { Path: 'src/auth.ts' } },
  });
  assert.deepEqual(editOut, {}, 'PostToolUse must output {}');

  // Antigravity IDE replace_file_content with absolute TargetFile
  const absTarget = join(repo, 'src', 'session.ts');
  const replaceOut = runAdapter(adapter, 'post-edit', {
    conversationId: 'conv-edit',
    cwd: repo,
    toolCall: { id: 't2', name: 'replace_file_content', args: { TargetFile: absTarget } },
  });
  assert.deepEqual(replaceOut, {});

  // Failed tool call is ignored
  runAdapter(adapter, 'post-edit', {
    conversationId: 'conv-edit',
    cwd: repo,
    error: 'file not found',
    toolCall: { id: 't3', name: 'edit_file', args: { Path: 'src/missing.ts' } },
  });

  // Next PreInvocation inside the SAME turn pops and injects both stashed blast radii
  const nextInv = runAdapter(adapter, 'prompt', {
    conversationId: 'conv-edit',
    cwd: repo,
    lastUserInput: 'edit auth',
  });
  assert.deepEqual(nextInv, {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: `blast:${join(repo, 'src', 'auth.ts')}\n\nblast:${absTarget}`,
        },
      },
    ],
  });

  // Subsequent PreInvocation has nothing left pending
  assert.deepEqual(
    runAdapter(adapter, 'prompt', { conversationId: 'conv-edit', cwd: repo, lastUserInput: 'edit auth' }),
    {},
  );

  const edits = readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(edits.length, 2, 'failed edit skipped');
  assert.equal(edits[0].tool_input.file_path, join(repo, 'src', 'auth.ts'));
  assert.equal(edits[1].tool_input.file_path, absTarget);
});

test('Stop maps block to continue only on normal turn end when continuationActive is false', () => {
  const dir = fresh();
  const shim = makeStubShim(
    dir,
    `process.stdout.write(JSON.stringify({ decision: 'block', reason: 'save learning' }));`,
  );
  const adapter = makeAdapter(dir, shim);
  const repo = join(dir, 'repo');

  assert.deepEqual(
    runAdapter(adapter, 'stop', { conversationId: 'c-stop', cwd: repo, terminationReason: 'NO_TOOL_CALL', continuationActive: false }),
    { decision: 'continue', reason: 'save learning' },
  );
  assert.deepEqual(
    runAdapter(adapter, 'stop', { conversationId: 'c-stop', cwd: repo, terminationReason: 'NO_TOOL_CALL', continuationActive: true }),
    {},
    'never loops when continuationActive is true',
  );
  assert.deepEqual(
    runAdapter(adapter, 'stop', { conversationId: 'c-stop', cwd: repo, terminationReason: 'USER_CANCELED', continuationActive: false }),
    {},
    'never forces continuation on user cancel',
  );
});

test('missing shim or malformed stdin degrades cleanly to {}', () => {
  const dir = fresh();
  const adapter = makeAdapter(dir, join(dir, 'does-not-exist.cjs'));
  assert.deepEqual(runAdapter(adapter, 'session-start', { conversationId: 'c', cwd: dir }), {});
  assert.deepEqual(runAdapter(adapter, 'prompt', { conversationId: 'c', cwd: dir, lastUserInput: 'hi' }), {});
  assert.deepEqual(runAdapter(adapter, 'post-edit', { conversationId: 'c', cwd: dir, toolCall: { name: 'edit_file', args: { Path: 'a.ts' } } }), {});
  assert.deepEqual(runAdapter(adapter, 'stop', { conversationId: 'c', cwd: dir }), {});
  assert.deepEqual(runAdapter(adapter, 'session-start', 'not-valid-json{{{'), {});
});

test('every command in hooks.json runs cleanly via host shell and fails open when adapter is missing', () => {
  const home = fresh();
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  installAntigravityHooks(home, 'trail');
  const cfg = JSON.parse(readFileSync(antigravityHooksConfigPathFor(home), 'utf8')).trail;
  const cmds: string[] = [
    cfg.SessionStart[0].command,
    cfg.PreInvocation[0].command,
    cfg.PostToolUse[0].hooks[0].command,
    cfg.Stop[0].command,
  ];
  const shell = process.platform === 'win32' ? true : '/bin/sh';

  // With adapter present (and empty workspace payload) every command exits 0 and prints {}
  for (const cmd of cmds) {
    const r = spawnSync(cmd, { shell, input: '{}', encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(r.status, 0, `present: ${cmd}\n${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), {}, `present stdout: ${cmd}`);
  }

  // With adapter deleted, every command still exits 0 (fail-open)
  const adapter = antigravityAdapterPathFor(home, 'trail');
  rmSync(adapter, { force: true });
  for (const cmd of cmds) {
    const r = spawnSync(cmd, { shell, input: '{}', encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(r.status, 0, `missing adapter must fail open: ${cmd}\n${r.stderr}`);
  }
});
