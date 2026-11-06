import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeGraftSettings } from '../src/claude/settings-merge.js';

const SL = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-statusline.cjs"';

test('empty settings gets the full Graft blocks', () => {
  const { merged, warnings } = mergeGraftSettings({});
  assert.equal(merged.statusLine.command, SL);
  assert.equal(merged.subagentStatusLine.command, SL);
  assert.ok(Array.isArray(merged.hooks.PostToolUse));
  assert.equal(merged.hooks.PostToolUse[0].matcher, 'Write|Edit|MultiEdit');
  for (const e of ['PostToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop']) {
    assert.ok(merged.hooks[e][0].hooks[0].command.includes('graft-hooks.cjs'), `${e} wired`);
  }
  // PostToolUse carries a second graft block: the usage-mix + tokens-saved
  // accumulator over the retrieval tools (Bash `graft …`, the graft_* MCP tools)
  // and the source-read tools (Read/Grep/Glob) it scores against.
  const savings = merged.hooks.PostToolUse[1];
  assert.equal(savings.matcher, 'Bash|mcp__graft__|mcp__trail__|Read|Grep|Glob|Skill');
  assert.ok(savings.hooks[0].command.includes('tool-savings'), 'savings hook wired');
  assert.ok(merged.footerLinksRegexes.includes('graft/[\\w./-]+\\.md'));
  assert.deepEqual(warnings, []);
});

test('foreign statusLine is preserved with a warning; Graft not forced in', () => {
  const { merged, warnings } = mergeGraftSettings({ statusLine: { type: 'command', command: 'my-bar.sh' } });
  assert.equal(merged.statusLine.command, 'my-bar.sh');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /statusLine/);
});

test('user wrapper statusLine mentioning helper path is preserved as foreign', () => {
  const customCmd = 'input=$(cat); printf "%s" "$input" | "$HOME/.claude/statusline.sh"; printf "%s" "$input" | node "${CLAUDE_PROJECT_DIR:-.}/.trail/statusline.cjs"';
  const { merged, warnings } = mergeGraftSettings({ statusLine: { type: 'command', command: customCmd } });
  assert.equal(merged.statusLine.command, customCmd);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /statusLine/);
});

test('a prior Graft statusLine (helper path, old command) is updated to the current command', () => {
  const { merged, warnings } = mergeGraftSettings({
    statusLine: { type: 'command', command: 'node .claude/helpers/graft-statusline.cjs' },
    subagentStatusLine: { type: 'command', command: 'node .claude/helpers/graft-statusline.cjs' },
  });
  assert.equal(merged.statusLine.command, SL);
  assert.equal(merged.subagentStatusLine.command, SL);
  assert.deepEqual(warnings, []);
});

test('statusline: false does not install a statusLine on empty settings', () => {
  const { merged } = mergeGraftSettings({}, { statusline: false });
  assert.equal(merged.statusLine, undefined);
  assert.equal(merged.subagentStatusLine, undefined);
  assert.ok(Array.isArray(merged.hooks.Stop), 'hooks still wired');
});

test('statusline: false strips a prior Graft statusLine so a user-level one can show', () => {
  const { merged } = mergeGraftSettings({
    statusLine: { type: 'command', command: SL },
    subagentStatusLine: { type: 'command', command: SL },
  }, { statusline: false });
  assert.equal(merged.statusLine, undefined);
  assert.equal(merged.subagentStatusLine, undefined);
});

test('statusline: false still leaves a foreign statusLine alone', () => {
  const { merged, warnings } = mergeGraftSettings(
    { statusLine: { type: 'command', command: 'my-bar.sh' } },
    { statusline: false },
  );
  assert.equal(merged.statusLine.command, 'my-bar.sh');
  assert.match(warnings.join('\n'), /statusLine/);
});

test('GRAFT_NO_STATUSLINE=1 skips installing a statusLine', () => {
  const prev = process.env.GRAFT_NO_STATUSLINE;
  process.env.GRAFT_NO_STATUSLINE = '1';
  try {
    const { merged } = mergeGraftSettings({});
    assert.equal(merged.statusLine, undefined);
    assert.equal(merged.subagentStatusLine, undefined);
  } finally {
    if (prev === undefined) delete process.env.GRAFT_NO_STATUSLINE;
    else process.env.GRAFT_NO_STATUSLINE = prev;
  }
});

test('existing foreign hooks are preserved; Graft appended', () => {
  const existing = { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
  const { merged } = mergeGraftSettings(existing);
  // foreign block + graft's two PostToolUse blocks (post-edit, tool-savings).
  assert.equal(merged.hooks.PostToolUse.length, 3);
  assert.equal(merged.hooks.PostToolUse[0].hooks[0].command, 'mine.sh');
  assert.ok(merged.hooks.PostToolUse[1].hooks[0].command.includes('graft-hooks.cjs'));
  assert.ok(merged.hooks.PostToolUse[2].hooks[0].command.includes('graft-hooks.cjs'));
});

test('re-running is idempotent (no duplicate Graft entries or footer)', () => {
  const once = mergeGraftSettings({}).merged;
  const twice = mergeGraftSettings(once).merged;
  assert.equal(twice.hooks.PostToolUse.length, 2); // post-edit + tool-savings, not duplicated
  assert.equal(twice.hooks.Stop.length, 1);
  assert.equal(twice.footerLinksRegexes.filter((r: string) => r === 'graft/[\\w./-]+\\.md').length, 1);
});

test('foreign top-level keys survive', () => {
  const { merged } = mergeGraftSettings({ model: 'claude-sonnet-5', permissions: { allow: ['Bash(ls)'] } });
  assert.equal(merged.model, 'claude-sonnet-5');
  assert.deepEqual(merged.permissions.allow, ['Bash(ls)', 'Bash(trail:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('fresh init adds the graft CLI allowlist', () => {
  const { merged } = mergeGraftSettings({});
  assert.deepEqual(merged.permissions.allow, ['Bash(trail:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('re-init does not duplicate allowlist entries', () => {
  const once = mergeGraftSettings({}).merged;
  const twice = mergeGraftSettings(once).merged;
  assert.deepEqual(twice.permissions.allow, ['Bash(trail:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('pre-existing unrelated allow entries are preserved and ours appended', () => {
  const existing = { permissions: { allow: ['Bash(ls)', 'Bash(git:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.allow, ['Bash(ls)', 'Bash(git:*)', 'Bash(trail:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('a partially-present allowlist gains only what it lacks, in order', () => {
  const existing = { permissions: { allow: ['Bash(graft:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.allow, ['Bash(trail:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('pre-existing allow entries are kept and only the missing ones appended', () => {
  const existing = { permissions: { allow: ['Bash(graft:*)', 'Bash(npx graft:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.allow, ['Bash(trail:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('permissions object with no allow key gets one added; other keys preserved', () => {
  const existing = { permissions: { deny: ['Bash(rm:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.deny, ['Bash(rm:*)']);
  assert.deepEqual(merged.permissions.allow, ['Bash(trail:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

/* ---- PostToolUseFailure: a failed Bash call (design 0.2, D34) ---- */

import { mkdirSync as mkdirP, readFileSync as readF, writeFileSync as writeF } from 'node:fs';
import { join as joinP } from 'node:path';
import { mergeGraftHooks } from '../src/claude/settings-merge.js';
import { runInit } from '../src/claude/init.js';
import { runRetract } from '../src/hosts/retract.js';
import { tmpRepo } from './helpers.js';

/** A failed-call hook the person wrote: kept through every install and uninstall. */
const THEIRS_FAIL = { matcher: 'Bash', hooks: [{ type: 'command', command: '/home/dev/bin/on-fail.sh' }] };
const failEntries = (hooks: any) => (hooks?.PostToolUseFailure ?? []).filter((e: any) => /(graft|trail)-hooks\.cjs/.test(JSON.stringify(e)));

test('the repo and ~/.claude installs both register PostToolUseFailure for Bash: post-bash-fail, 5 seconds, failing open', () => {
  for (const name of ['graft', 'trail'] as const) {
    assert.deepEqual(mergeGraftSettings({}, { name }).merged.hooks.PostToolUseFailure, [
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/${name}-hooks.cjs" post-bash-fail || exit 0`, timeout: 5 }] },
    ]);
  }
  const helpers = '/home/dev/.claude/helpers';
  const once = mergeGraftHooks({ hooks: { PostToolUseFailure: [THEIRS_FAIL] } }, helpers).merged;
  assert.deepEqual(once.hooks.PostToolUseFailure, [
    THEIRS_FAIL,
    { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${helpers}/graft-hooks.cjs" post-bash-fail || exit 0`, timeout: 5 }] },
  ]);
  assert.deepEqual(mergeGraftHooks(once, helpers).merged, once, 'merging again converges');
});

test("trail init writes PostToolUseFailure once, in ~/.claude, keeps the person's own in the shared file, and uninstall takes only ours", () => {
  const repo = tmpRepo('fail-hook-repo');
  const home = tmpRepo('fail-hook-home');
  mkdirP(joinP(repo, '.claude'), { recursive: true });
  mkdirP(joinP(home, '.claude'), { recursive: true });
  writeF(joinP(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUseFailure: [THEIRS_FAIL] } }));
  writeF(joinP(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUseFailure: [THEIRS_FAIL] } }));
  const prev = process.env.GRAFT_MCP_NPX;
  process.env.GRAFT_MCP_NPX = '1';
  try {
    runInit(repo, { build: false, home, brand: 'trail' });
    runInit(repo, { build: false, home, brand: 'trail' });
  } finally {
    if (prev === undefined) delete process.env.GRAFT_MCP_NPX;
    else process.env.GRAFT_MCP_NPX = prev;
  }
  const read = (p: string) => JSON.parse(readF(p, 'utf8')).hooks;
  // #619: the shared settings.json runs only session start; ~/.claude carries every other event.
  assert.deepEqual(read(joinP(repo, '.claude', 'settings.json')).PostToolUseFailure, [THEIRS_FAIL], 'none of ours in the shared file');
  const user = read(joinP(home, '.claude', 'settings.json'));
  assert.deepEqual(user.PostToolUseFailure[0], THEIRS_FAIL);
  assert.equal(failEntries(user).length, 1, 'one in ~/.claude');
  assert.match(failEntries(user)[0].hooks[0].command, /hooks\.cjs" post-bash-fail \|\| exit 0$/);
  runRetract(repo, { home, apply: true });
  for (const file of [joinP(repo, '.claude', 'settings.json'), joinP(home, '.claude', 'settings.json')]) {
    assert.deepEqual(read(file).PostToolUseFailure, [THEIRS_FAIL], `only the person's own is left in ${file}`);
  }
});

import { claudeGlobalTargets } from '../src/hosts/claude-global.js';

test('the ~/.claude install describes every hook event it writes, PostToolUseFailure included (g7 review)', () => {
  const what = claudeGlobalTargets('/home/dev').find((t) => t.id === 'claude-global-hooks')!.what;
  const events = Object.keys(mergeGraftHooks({}, '/home/dev/.claude/helpers').merged.hooks);
  assert.ok(events.includes('PostToolUseFailure'));
  assert.deepEqual(what.split(' / ').sort(), [...new Set(events)].sort(), what);
});
