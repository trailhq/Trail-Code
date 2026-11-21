import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeGraftHooks, mergeGraftSettings, mergeTrailLocal, mergeTrailShared, withoutOurs } from '../src/claude/settings-merge.js';

const teamCommand = { type: 'command', command: 'bash "${CLAUDE_PROJECT_DIR:-.}/tools/setup.sh"', timeout: 300 };
const notifier = { type: 'http', url: 'https://example.test/.trail/hook.cjs', timeout: 20 };
const wrapper = { type: 'command', command: 'bash setup.sh ".trail/hook.cjs"', timeout: 30 };
const trailHook = { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/.trail/hook.cjs" session-start || exit 0', timeout: 10 };
const graftHook = { type: 'command', command: 'node ".claude/helpers/graft-hooks.cjs" session-start', timeout: 10 };
const shareSync = { type: 'command', command: 'node "/home/space user/.claude/helpers/graft-hooks.cjs" share-sync || exit 0', timeout: 10 };

test('refreshing shared Claude settings preserves teammates’ handlers and their matcher', () => {
  const foreign = { matcher: 'startup', hooks: [teamCommand, notifier, wrapper] };
  const settings = { hooks: { SessionStart: [{ ...foreign, hooks: [teamCommand, trailHook, notifier, wrapper] }] } };
  const original = structuredClone(settings);
  const updated = mergeTrailShared(settings);
  assert.deepEqual(updated.hooks.SessionStart, [foreign, { hooks: [trailHook] }]);
  assert.deepEqual(mergeTrailShared(updated), updated);
  assert.deepEqual(settings, original);
});

test('the user-level refresh keeps share-sync and team commands without duplicating session-start', () => {
  const settings = { hooks: { SessionStart: [{ matcher: 'resume', hooks: [graftHook, shareSync, teamCommand] }] } };
  const helpers = '/home/space user/.claude/helpers';
  const updated = mergeGraftHooks(settings, helpers).merged;
  assert.deepEqual(updated.hooks.SessionStart[0], { matcher: 'resume', hooks: [shareSync, teamCommand] });
  assert.equal(updated.hooks.SessionStart.length, 2);
  assert.match(updated.hooks.SessionStart[1].hooks[0].command, /session-start/);
  assert.deepEqual(mergeGraftHooks(updated, helpers).merged, updated);
});

test('project, local and uninstall rewrites keep the same foreign handlers', () => {
  const foreign = { matcher: 'resume', hooks: [teamCommand] };
  const settings = { hooks: { SessionStart: [{ ...foreign, hooks: [graftHook, teamCommand] }, { hooks: [trailHook] }] } };
  assert.deepEqual(mergeGraftSettings(settings).merged.hooks.SessionStart[0], foreign);
  assert.deepEqual(mergeTrailLocal(settings).merged.hooks.SessionStart, [foreign]);
  assert.deepEqual(withoutOurs(settings).hooks.SessionStart, [foreign]);
});
