import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeGraftSettings, mergeGraftHooks } from '../src/claude/settings-merge.js';

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
  assert.equal(savings.matcher, 'Bash|mcp__graft__|Read|Grep|Glob');
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
  assert.deepEqual(merged.permissions.allow, ['Bash(ls)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('fresh init adds the graft CLI allowlist', () => {
  const { merged } = mergeGraftSettings({});
  assert.deepEqual(merged.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('re-init does not duplicate allowlist entries', () => {
  const once = mergeGraftSettings({}).merged;
  const twice = mergeGraftSettings(once).merged;
  assert.deepEqual(twice.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('pre-existing unrelated allow entries are preserved and ours appended', () => {
  const existing = { permissions: { allow: ['Bash(ls)', 'Bash(git:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.allow, ['Bash(ls)', 'Bash(git:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('a partially-present allowlist gains only what it lacks, in order', () => {
  const existing = { permissions: { allow: ['Bash(graft:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('pre-existing allow entries are kept and only the missing ones appended', () => {
  const existing = { permissions: { allow: ['Bash(graft:*)', 'Bash(npx graft:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('permissions object with no allow key gets one added; other keys preserved', () => {
  const existing = { permissions: { deny: ['Bash(rm:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.deny, ['Bash(rm:*)']);
  assert.deepEqual(merged.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

// --- trailhq/Graft#283: hook timeouts are seconds, not ms ------------------

test('fresh init writes hook timeouts in seconds, not ms (trailhq/Graft#283)', () => {
  const { merged } = mergeGraftSettings({});
  assert.equal(merged.hooks.PostToolUse[0].hooks[0].timeout, 10, 'post-edit');
  assert.equal(merged.hooks.PostToolUse[1].hooks[0].timeout, 8, 'tool-savings');
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].timeout, 15, 'prompt');
  assert.equal(merged.hooks.SessionStart[0].hooks[0].timeout, 8, 'session-start');
  assert.equal(merged.hooks.Stop[0].hooks[0].timeout, 8, 'stop');
});

test('a pre-fix ms-shaped timeout (8000/10000/15000) is corrected, not preserved (trailhq/Graft#283)', () => {
  const preFix = mergeGraftSettings({}).merged;
  // Simulate a repo wired by a graft version that still had the #283 bug.
  preFix.hooks.PostToolUse[0].hooks[0].timeout = 10000;
  preFix.hooks.UserPromptSubmit[0].hooks[0].timeout = 15000;
  const { merged } = mergeGraftSettings(preFix);
  assert.equal(merged.hooks.PostToolUse[0].hooks[0].timeout, 10, 'corrected, not "preserved" as a 10000 raise');
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].timeout, 15, 'corrected, not "preserved" as a 15000 raise');
});

test('a genuine hand-raised sane timeout survives a re-merge (trailhq/Graft#366 part 2)', () => {
  const raised = mergeGraftSettings({}).merged;
  // The operator deliberately raised post-edit's budget from the template's 10s.
  raised.hooks.PostToolUse[0].hooks[0].timeout = 20;
  const { merged } = mergeGraftSettings(raised);
  assert.equal(merged.hooks.PostToolUse[0].hooks[0].timeout, 20, 'the raise survived the refresh');
  // A raise never lowers below the current template either.
  raised.hooks.PostToolUse[0].hooks[0].timeout = 3;
  const lowered = mergeGraftSettings(raised).merged;
  assert.equal(lowered.hooks.PostToolUse[0].hooks[0].timeout, 10, 'a value below the template floor is not "preserved" downward');
});

test('the LARGEST of two matching prior blocks survives, not just the first one found (trailhq/Graft#485 review finding 4)', () => {
  const prior = mergeGraftSettings({}).merged;
  const postEditCommand = prior.hooks.PostToolUse[0].hooks[0].command;
  // Simulate a hand-edited prior settings.json with TWO separate post-edit
  // blocks (distinct matchers, same subcommand) — the template's own is left
  // at its default 10s, and a second, narrower block carries the operator's
  // real deliberate raise to 60s. Order matters for the bug: the smaller,
  // unraised value comes first in the array.
  prior.hooks.PostToolUse.splice(1, 0, {
    matcher: 'Edit',
    hooks: [{ type: 'command', command: postEditCommand, timeout: 60 }],
  });
  const { merged } = mergeGraftSettings(prior);
  assert.equal(
    merged.hooks.PostToolUse[0].hooks[0].timeout,
    60,
    'the larger raise (60) must win, not the first-found entry (10, the unraised template default)',
  );
});

test('mergeGraftHooks (the global-install variant) has the same #283/#366 behavior', () => {
  const { merged: fresh } = mergeGraftHooks({}, '/abs/helpers');
  assert.equal(fresh.hooks.PostToolUse[0].hooks[0].timeout, 10);
  assert.equal(fresh.hooks.UserPromptSubmit[0].hooks[0].timeout, 15);

  const legacy = mergeGraftHooks({}, '/abs/helpers').merged;
  legacy.hooks.UserPromptSubmit[0].hooks[0].timeout = 15000;
  const { merged: corrected } = mergeGraftHooks(legacy, '/abs/helpers');
  assert.equal(corrected.hooks.UserPromptSubmit[0].hooks[0].timeout, 15, 'legacy ms value corrected, not preserved');

  const withRaise = mergeGraftHooks({}, '/abs/helpers').merged;
  withRaise.hooks.Stop[0].hooks[0].timeout = 30;
  const { merged: keptRaise } = mergeGraftHooks(withRaise, '/abs/helpers');
  assert.equal(keptRaise.hooks.Stop[0].hooks[0].timeout, 30, 'sane hand-raise survives here too');
});
