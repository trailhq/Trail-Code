/**
 * Which copy answers depends on who sent the payload. Claude Code (and
 * Cursor, which loads ~/.claude/settings.json beside the repo's) runs both
 * the repo copy and the ~/.claude copy, so the repo copy stands down there.
 * Copilot CLI reads only the repo's .claude/settings.json: when the repo copy
 * stood down for it, nothing from Trail reached the agent at all. So the host
 * is worked out from the payload first, and only a host that runs the
 * ~/.claude copy lets the repo copy stand down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { globalCopyCovers } from '../src/claude/hook-layers.js';
import { main as hooksMain } from '../src/claude/hooks.js';
import { main as preBashMain, shellCommand } from '../src/claude/pre-bash.js';
import { hooksShim } from '../src/claude/shim-template.js';
import { writeNote } from '../src/notes/notes.js';
import { tmpRepo } from './helpers.js';

const CLAUDE = { session_id: 's1', transcript_path: '/home/dev/.claude/projects/-home-dev-shop/s1.jsonl', cwd: '/home/dev/shop', hook_event_name: 'UserPromptSubmit', prompt: 'dns' };
const CLAUDE_SUBAGENT = { ...CLAUDE, hook_event_name: 'PreToolUse', agent_id: 'a1', agent_type: 'Explore' };
const CURSOR = { conversation_id: 'c1', generation_id: 'g1', cursor_version: '1.7.0', workspace_roots: ['/home/dev/shop'], hook_event_name: 'beforeSubmitPrompt', prompt: 'dns' };
const COPILOT = { sessionId: 'cp-1', timestamp: 1760000000000, cwd: '/home/dev/shop', prompt: 'dns' };
/** Copilot's "VS Code compatible" mode: snake_case, no transcript, an ISO timestamp. */
const COPILOT_PASCAL = { session_id: 'cp-2', timestamp: '2026-10-15T10:00:00Z', cwd: '/home/dev/shop', hook_event_name: 'UserPromptSubmit', prompt: 'dns' };
const GEMINI = { session_id: 'g-1', transcript_path: '/home/dev/.gemini/tmp/abc/chats/session.json', cwd: '/home/dev/shop', hook_event_name: 'BeforeTool' };

/** A home whose ~/.claude answers `events` with a shim that finds trail. */
function homeCovering(events: string[]): string {
  const home = tmpRepo('standdown-home');
  const helpers = join(home, '.claude', 'helpers');
  mkdirSync(helpers, { recursive: true });
  const shim = join(helpers, 'graft-hooks.cjs');
  writeFileSync(shim, hooksShim());
  const hooks = Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: 'command', command: `node "${shim.replace(/\\/g, '/')}" ${e}` }] }]]));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks }));
  return home;
}

const repoShim = (repo: string) => join(repo, '.claude', 'helpers', 'trail-hooks.cjs');

test('the repo copy stands down only for a host that also runs the ~/.claude copy', () => {
  const home = homeCovering(['prompt', 'pre-bash']);
  const shim = repoShim(tmpRepo('standdown-repo'));
  assert.equal(globalCopyCovers('prompt', shim, home, {}, CLAUDE), true, 'Claude Code runs both');
  assert.equal(globalCopyCovers('pre-bash', shim, home, {}, CLAUDE_SUBAGENT), true, 'a subagent is still Claude Code');
  assert.equal(globalCopyCovers('prompt', shim, home, {}, CURSOR), true, 'Cursor loads ~/.claude/settings.json too');
  assert.equal(globalCopyCovers('prompt', shim, home, {}, COPILOT), false, 'Copilot CLI reads only the repo settings');
  assert.equal(globalCopyCovers('prompt', shim, home, {}, COPILOT_PASCAL), false, 'a payload no host claims: answer rather than say nothing');
  assert.equal(globalCopyCovers('prompt', shim, home, {}, GEMINI), false);
  assert.equal(globalCopyCovers('prompt', shim, home, {}, 'not an object'), false);
  assert.equal(globalCopyCovers('prompt', shim, home, {}), true, 'no payload given: as before');
});

// Run from the Claude desktop app, the suite inherits its entrypoint, and the hooks would report claude-desktop.
delete process.env.CLAUDE_CODE_ENTRYPOINT;
delete process.env.TRAIL_AGENT_HOST;

/** Runs `fn` as the repo's copy of the hooks, with `home` as the home folder; returns stdout. */
async function asRepoCopy(repo: string, home: string, stdin: object, fn: () => Promise<void>): Promise<string> {
  const saved = { argv1: process.argv[1], home: process.env.HOME, profile: process.env.USERPROFILE, stdin: process.env.GRAFT_TEST_STDIN, project: process.env.CLAUDE_PROJECT_DIR, config: process.env.CLAUDE_CONFIG_DIR };
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? ((out += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.argv[1] = repoShim(repo);
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() follows USERPROFILE on Windows
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.GRAFT_TEST_STDIN = JSON.stringify(stdin);
  process.env.CLAUDE_PROJECT_DIR = repo;
  try {
    await fn();
  } finally {
    process.stdout.write = write;
    process.argv[1] = saved.argv1!;
    for (const [key, value] of [['HOME', saved.home], ['USERPROFILE', saved.profile], ['GRAFT_TEST_STDIN', saved.stdin], ['CLAUDE_PROJECT_DIR', saved.project], ['CLAUDE_CONFIG_DIR', saved.config]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return out;
}

test("under Copilot the repo copy's prompt hook brings the learnings; under Claude Code it leaves them to ~/.claude", async () => {
  process.env.TRAIL_HOME = tmpRepo('standdown-trail-home');
  process.env[BRAND_ENV] = 'trail';
  const repo = tmpRepo('standdown-prompt');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeNote(repo, { title: 'DNS changes go through the infra repo', body: '## Decided\nNever edit records by hand.\n', author: 'Kumar', date: '2026-10-06', touches: [] });
  const home = homeCovering(['prompt']);
  assert.equal(await asRepoCopy(repo, home, CLAUDE, () => hooksMain('prompt')), '', 'Claude Code: the ~/.claude copy answers');
  const copilot = await asRepoCopy(repo, home, COPILOT, () => hooksMain('prompt'));
  assert.match(JSON.parse(copilot).hookSpecificOutput.additionalContext, /DNS changes go through the infra repo/);
});

test('pre-bash answers only for a shell call, and stands down only for a host that runs ~/.claude', async () => {
  const repo = tmpRepo('standdown-pre-bash');
  const home = homeCovering(['pre-bash']);
  const deny = () => ({ permissionDecision: 'deny' as const, reason: 'test decision' });
  const bash = { ...CLAUDE, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm publish' } };
  const copilotBash = { sessionId: 'cp-1', timestamp: 1760000000000, cwd: '/home/dev/shop', toolName: 'bash', toolArgs: '{"command":"npm publish"}' };
  const copilotView = { ...copilotBash, toolName: 'view', toolArgs: '{"path":"README.md"}' };
  assert.equal(await asRepoCopy(repo, home, bash, () => preBashMain('pre-bash', deny)), '', 'Claude Code: the ~/.claude copy decides');
  const out = await asRepoCopy(repo, home, copilotBash, () => preBashMain('pre-bash', deny));
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny', 'Copilot: the repo copy decides');
  assert.equal(await asRepoCopy(repo, home, copilotView, () => preBashMain('pre-bash', deny)), '', 'Copilot ran the hook for a tool that is not a shell: nothing to decide');
  const noGlobal = tmpRepo('standdown-empty-home');
  assert.equal(await asRepoCopy(repo, noGlobal, { ...bash, tool_name: 'Write', tool_input: { file_path: '/home/dev/shop/a.ts' } }, () => preBashMain('pre-bash', deny)), '', 'not a shell call');
  assert.equal(JSON.parse(await asRepoCopy(repo, noGlobal, bash, () => preBashMain('pre-bash', deny))).hookSpecificOutput.permissionDecision, 'deny', 'only copy: it decides');
});

test('shellCommand reads the command out of each host shape, and nothing else', () => {
  assert.equal(shellCommand({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), 'npm test');
  assert.equal(shellCommand({ tool_name: 'Shell', tool_input: { command: 'ls' } }), 'ls', 'Cursor');
  assert.equal(shellCommand({ toolName: 'bash', toolArgs: '{"command":"git push"}' }), 'git push', 'Copilot, arguments as JSON text');
  assert.equal(shellCommand({ toolName: 'bash', toolArgs: { command: 'git push' } }), 'git push', 'Copilot, arguments as an object');
  for (const not of [{ tool_name: 'Write', tool_input: { command: 'x' } }, { toolName: 'view', toolArgs: '{}' }, { tool_name: 'Bash', tool_input: { command: '' } }, { tool_name: 'Bash', tool_input: null }, { toolName: 'bash', toolArgs: '{not json' }, {}, null, 'Bash', []]) {
    assert.equal(shellCommand(not as never), null, JSON.stringify(not));
  }
});

test('a session is keyed by its own id in every host shape, and the id never leaves the session folder', async () => {
  const { payloadSessionId } = await import('../src/claude/hook-io.js');
  assert.equal(payloadSessionId(CLAUDE), 's1');
  assert.equal(payloadSessionId(COPILOT), 'cp-1', "Copilot's camelCase sessionId");
  assert.equal(payloadSessionId(CURSOR), 'c1', "Cursor's conversation_id");
  for (const none of [{}, null, 'x', { session_id: '' }, { session_id: 42 }]) assert.equal(payloadSessionId(none), 'default', JSON.stringify(none));
  for (const odd of ['../../etc/passwd', 'a/b', '.hidden', 'x'.repeat(200), 'C:\\x']) {
    const id = payloadSessionId({ session_id: odd });
    assert.match(id, /^h-[0-9a-f]{16}$/, `${odd} becomes a plain name`);
    assert.equal(payloadSessionId({ session_id: odd }), id, 'the same every time');
  }
});

test('under Copilot the prompt hook keeps its session under its own id, not a shared default', async () => {
  process.env.TRAIL_HOME = tmpRepo('standdown-trail-home-2');
  process.env[BRAND_ENV] = 'trail';
  const repo = tmpRepo('standdown-session');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeNote(repo, { title: 'DNS changes go through the infra repo', body: '## Decided\nNever edit records by hand.\n', author: 'Kumar', date: '2026-10-06', touches: [] });
  await asRepoCopy(repo, tmpRepo('standdown-empty-home-2'), COPILOT, () => hooksMain('prompt'));
  const { existsSync } = await import('node:fs');
  // A repo with learnings is on trail, so its cache is under .trail/cache/ (#619, context/map-dir.ts).
  assert.equal(existsSync(join(repo, '.trail', 'cache', '.cache', 'session', 'cp-1.json')), true);
  assert.equal(existsSync(join(repo, '.trail', 'cache', '.cache', 'session', 'default.json')), false);
});

test('a tool use is put down to the host that sent it, so a session summary names Copilot or Cursor, not Claude Code', async () => {
  process.env.TRAIL_HOME = tmpRepo('standdown-trail-home-3');
  const repo = tmpRepo('standdown-host-stamp');
  const { readSession } = await import('../src/claude/state.js');
  const use = { tool_name: 'Bash', tool_input: { command: 'trail ask "cart total"' }, tool_response: '[graft] tokens saved ≈ 4,000' };
  const copilotSnake = { ...COPILOT_PASCAL, session_id: 'cp-9', hook_event_name: 'PostToolUse', ...use };
  const cursorShape = { ...CURSOR, conversation_id: 'c-9', hook_event_name: 'postToolUse', ...use };
  const claudeShape = { ...CLAUDE, session_id: 's-9', hook_event_name: 'PostToolUse', ...use };
  for (const payload of [copilotSnake, cursorShape, claudeShape]) await asRepoCopy(repo, tmpRepo('standdown-empty-home-3'), payload, () => hooksMain('tool-savings'));
  assert.equal(readSession(repo, 'cp-9').host, 'copilot');
  assert.equal(readSession(repo, 'c-9').host, 'cursor');
  assert.equal(readSession(repo, 's-9').host, 'claude-code');
});
