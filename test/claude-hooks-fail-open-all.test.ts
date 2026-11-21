/**
 * D116 item 6: every Trail hook command `trail init` writes fails open when
 * its helper file is missing, in the `|| exit 0` shape PreToolUse already
 * has. A `git stash -u` or `git clean` before the wiring is committed takes
 * the untracked `.claude/helpers/trail-hooks.cjs` while the tracked
 * `.claude/settings.json` still names it; then Stop, the prompt hook and
 * SessionStart used to exit 1 on every turn. These tests run the exact
 * command strings the installs write, through the shell Claude Code runs
 * hooks in (sh, or Git Bash on Windows), with a
 * payload like the host's. The next `trail init` repairs older wiring.
 * Made-up folders only; every run gets its own HOME and TRAIL_HOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mergeGraftHooks, mergeGraftSettings, mergeTrailLocal } from '../src/claude/settings-merge.js';
import { installCodexHooks } from '../src/hosts/codex-hooks.js';
import { installCursorHooks } from '../src/hosts/cursor-hooks.js';
import { toPosixPath } from '../src/util/paths.js';
import { hookShell, tmpRepo } from './helpers.js';

type Cmd = { where: string; event: string; command: string };

/** Every hook command in a hooks object, Claude Code / Codex shape ({ hooks: [{ command }] }) or Cursor's ({ command }). */
function allCommands(where: string, hooks: Record<string, any[]>): Cmd[] {
  const out: Cmd[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    for (const e of entries) {
      if (typeof e.command === 'string') out.push({ where, event, command: e.command });
      for (const h of e.hooks ?? []) if (typeof h.command === 'string') out.push({ where, event, command: h.command });
    }
  }
  return out;
}

/** The commands of the repo install (both names), the ~/.claude one, Codex's and Cursor's. */
function installs(home: string, project: string): Cmd[] {
  mkdirSync(join(home, '.codex'), { recursive: true });
  installCodexHooks(home);
  installCursorHooks(project, 'trail');
  return [
    ...allCommands('repo (trail)', mergeGraftSettings({}, { name: 'trail' }).merged.hooks),
    ...allCommands('repo (graft)', mergeGraftSettings({}, { name: 'graft' }).merged.hooks),
    ...allCommands('~/.claude', mergeGraftHooks({}, toPosixPath(join(home, '.claude', 'helpers'))).merged.hooks),
    ...allCommands('codex', JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks),
    ...allCommands('cursor', JSON.parse(readFileSync(join(project, '.cursor', 'hooks.json'), 'utf8')).hooks),
  ];
}

function payload(event: string, cwd: string): string {
  return JSON.stringify({ session_id: 'fail-open-all', transcript_path: '/dev/null', cwd, hook_event_name: event });
}

function hostEnv(home: string, project: string): NodeJS.ProcessEnv {
  const win = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT } : {};
  return { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, '.trail'), CLAUDE_PROJECT_DIR: project, ...win };
}

const SHELL = hookShell();
const NO_SHELL = SHELL === null && 'no Git Bash on this Windows machine, the shell Claude Code runs hooks in';

function run(command: string, cwd: string, input: string, env: NodeJS.ProcessEnv) {
  return spawnSync(command, { shell: SHELL ?? true, cwd, input, encoding: 'utf8', timeout: 20000, env });
}

test('every hook command Trail writes, on every event, ends in a shell-level fail-open', () => {
  const cmds = installs(tmpRepo('fail-open-all-home'), tmpRepo('fail-open-all-project'));
  assert.ok(cmds.some((c) => c.event === 'Stop') && cmds.some((c) => c.event === 'UserPromptSubmit') && cmds.some((c) => c.event === 'SessionStart'));
  for (const c of cmds) {
    assert.match(c.command, /^node .+ \|\| exit 0$/, `${c.where} ${c.event}`);
    if (c.event !== 'SessionEnd') assert.match(c.command, /^node "[^"]+-hooks\.cjs" [\w-]+ \|\| exit 0$/);
  }
});

test('the lab case: settings.json kept, the helper stashed away; Stop, prompt and session-start exit 0 and print nothing', { skip: NO_SHELL }, () => {
  const home = tmpRepo('fail-open-stash-home');
  const project = tmpRepo('fail-open-stash-project');
  // Only the tracked settings remain, as after `git stash -u`: no .claude/helpers/ at all.
  mkdirSync(join(project, '.claude'), { recursive: true });
  const { merged } = mergeGraftSettings({}, { name: 'trail' });
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify(merged, null, 2));
  for (const c of allCommands('repo', JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')).hooks)) {
    const r = run(c.command, project, payload(c.event, project), hostEnv(home, project));
    assert.equal(r.status, 0, `${c.event}: ${c.command}\n${r.stderr}`);
    assert.equal(r.stdout, '', c.event);
    if (c.event === 'SessionEnd') assert.equal(r.stderr, '', 'a deleted worktree is normal at teardown');
  }
});

test('with the helper there, each command still runs it with its event and prints its one JSON object, even when it exits non-zero', { skip: NO_SHELL }, () => {
  const home = tmpRepo('fail-open-present-home');
  const project = tmpRepo('fail-open-present-project');
  const helpers = join(project, '.claude', 'helpers');
  mkdirSync(helpers, { recursive: true });
  const ran = join(project, 'ran.txt');
  writeFileSync(join(helpers, 'trail-hooks.cjs'),
    `require('fs').appendFileSync(${JSON.stringify(ran)}, process.argv[2] + '\\n');\n`
    + `process.stdout.write(JSON.stringify({ event: process.argv[2] }));\nprocess.exit(process.argv[2] === 'stop' ? 1 : 0);\n`);
  const cmds = allCommands('repo', mergeGraftSettings({}, { name: 'trail' }).merged.hooks);
  for (const c of cmds) {
    const r = run(c.command, project, payload(c.event, project), hostEnv(home, project));
    assert.equal(r.status, 0, `${c.event}: ${r.stderr}`);
    const sub = /" ([\w-]+) \|\|/.exec(c.command)![1];
    assert.deepEqual(JSON.parse(r.stdout), { event: sub }, `${c.event}: exactly one JSON object`);
  }
  assert.equal(readFileSync(ran, 'utf8').trim().split('\n').length, cmds.length);
});

test('the shared Trail SessionEnd command skips a removed shim and still runs a present one', { skip: NO_SHELL }, () => {
  const home = tmpRepo('session-end-home');
  const project = tmpRepo('session-end-project');
  const { merged } = mergeTrailLocal({}, { hooks: true });
  const [command] = allCommands('repo', { SessionEnd: merged.hooks.SessionEnd });
  const runEnd = () => run(command!.command, project, payload('SessionEnd', project), hostEnv(home, project));

  const missing = runEnd();
  assert.equal(missing.status, 0);
  assert.equal(missing.stderr, '');

  mkdirSync(join(project, '.trail'), { recursive: true });
  writeFileSync(join(project, '.trail', 'hook.cjs'), 'process.stdout.write(process.argv[2]);\n');
  const present = runEnd();
  assert.equal(present.status, 0);
  assert.equal(present.stderr, '');
  assert.equal(present.stdout, 'session-end');
});

test('the next trail init repairs older wiring: plain Stop, prompt and session-start commands become fail-open, once', () => {
  const old = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/trail-hooks.cjs" stop', timeout: 10 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/trail-hooks.cjs" prompt', timeout: 15 }] }],
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/trail-hooks.cjs" session-start', timeout: 10 }] },
        { hooks: [{ type: 'command', command: 'echo mine' }] },
      ],
    },
  };
  const { merged } = mergeGraftSettings(old, { name: 'trail' });
  for (const event of ['Stop', 'UserPromptSubmit', 'SessionStart']) {
    const ours = allCommands('repo', { [event]: merged.hooks[event] }).filter((c) => c.command.includes('trail-hooks.cjs'));
    assert.equal(ours.length, 1, event);
    assert.match(ours[0]!.command, / \|\| exit 0$/, event);
  }
  assert.ok(allCommands('repo', merged.hooks).some((c) => c.command === 'echo mine'), "the person's own hook is kept as it was");
  assert.deepEqual(mergeGraftSettings(merged, { name: 'trail' }).merged.hooks, merged.hooks, 'idempotent');
});
