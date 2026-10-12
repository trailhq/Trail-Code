import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { planInit } from '../src/hosts/plan.js';
import {
  KEY_CTRL_C, KEY_DOWN, KEY_ESC, KEY_UP,
  describeWrites, formatNonInteractiveHelp, formatPlan, initialPickerState,
  compactWrites, keyOf, keysOf, pickedHostIds, pickedIds, pickedTelemetry, reducePicker, renderPicker, tilde, visibleRows,
  TELEMETRY_ROW_ID,
  type PickerKey,
} from '../src/cli-picker.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-picker-')); }

function fullHome(): string {
  const home = fresh();
  for (const d of ['.codex', '.cursor', '.gemini', '.adal', join('.config', 'opencode')]) {
    mkdirSync(join(home, d), { recursive: true });
  }
  return home;
}

/** Feed a key sequence through the reducer, no TTY involved. */
function drive(repo: string, home: string, keys: PickerKey[]) {
  let state = initialPickerState(planInit(repo, { home }), repo, home);
  for (const k of keys) state = reducePicker(state, k);
  return state;
}

test('keyOf maps arrows, vim keys, toggles and aborts', () => {
  assert.equal(keyOf(KEY_UP), 'up');
  assert.equal(keyOf(KEY_DOWN), 'down');
  assert.equal(keyOf('k'), 'up');
  assert.equal(keyOf('j'), 'down');
  assert.equal(keyOf(' '), 'space');
  assert.equal(keyOf('a'), 'all');
  assert.equal(keyOf('\r'), 'enter');
  assert.equal(keyOf(KEY_ESC), 'abort');
  assert.equal(keyOf(KEY_CTRL_C), 'abort');
  assert.equal(keyOf('z'), null);
});

test('keysOf splits a batched chunk into every keypress it contains', () => {
  // A pty hands over held/pasted/replayed input in one chunk — this must not
  // read as a single unrecognised key (which used to hang the prompt).
  assert.deepEqual(keysOf(`${KEY_DOWN} \r`), ['down', 'space', 'enter']);
  assert.deepEqual(keysOf('jjk a'), ['down', 'down', 'up', 'space', 'all']);
});

test('keysOf consumes CSI sequences whole, so an arrow is never a bare ESC', () => {
  assert.deepEqual(keysOf(KEY_UP), ['up']);
  // An arrow followed by enter must not abort.
  assert.deepEqual(keysOf(`${KEY_UP}\r`), ['up', 'enter']);
  // A real lone ESC still aborts.
  assert.deepEqual(keysOf(KEY_ESC), ['abort']);
  // Unrecognised CSI (e.g. Home) is dropped, not mistaken for ESC.
  assert.deepEqual(keysOf('\x1b[H'), []);
  // Parameterised CSI (e.g. a mouse/modifier report) is also consumed whole.
  assert.deepEqual(keysOf('\x1b[1;5A'), []);
});

test('keysOf ignores keys with no binding', () => {
  assert.deepEqual(keysOf('xyz'), []);
  assert.deepEqual(keysOf(''), []);
});

test('a batched chunk drives the reducer to a complete selection', () => {
  const repo = fresh(); const home = fullHome();
  let state = initialPickerState(planInit(repo, { home }), repo, home);
  for (const key of keysOf(`${KEY_DOWN} \r`)) state = reducePicker(state, key);
  assert.ok(state.done);
  assert.deepEqual(pickedIds(state), ['claude', 'agents']);
});

test('claude starts checked, nothing else does', () => {
  const repo = fresh(); const home = fullHome();
  const state = initialPickerState(planInit(repo, { home }), repo, home);
  assert.deepEqual(pickedIds(state), ['claude']);
  assert.equal(state.rows[0].id, 'claude');
});

test('enter with no toggling wires claude only', () => {
  const repo = fresh(); const home = fullHome();
  const state = drive(repo, home, ['enter']);
  assert.ok(state.done);
  assert.deepEqual(pickedIds(state), ['claude']);
});

test('space toggles the row under the cursor, off and on again', () => {
  const repo = fresh(); const home = fullHome();
  assert.deepEqual(pickedIds(drive(repo, home, ['space'])), []);
  assert.deepEqual(pickedIds(drive(repo, home, ['space', 'space'])), ['claude']);
});

test('down then space adds the second host', () => {
  const repo = fresh(); const home = fullHome();
  const state = drive(repo, home, ['down', 'space', 'enter']);
  assert.deepEqual(pickedIds(state), ['claude', 'agents']);
});

/** Rows on screen before `m`: the agents graft found, and nothing else. */
function shownCount(repo: string, home: string): number {
  return visibleRows(initialPickerState(planInit(repo, { home }), repo, home)).length;
}

test('cursor wraps at both ends', () => {
  const repo = fresh(); const home = fullHome();
  const n = shownCount(repo, home);
  assert.equal(drive(repo, home, ['up']).cursor, n - 1);
  assert.equal(drive(repo, home, Array(n).fill('down') as PickerKey[]).cursor, 0);
});

test('a toggles all on, then all off', () => {
  const repo = fresh(); const home = fullHome();
  const n = shownCount(repo, home);
  assert.equal(pickedIds(drive(repo, home, ['all'])).length, n);
  assert.deepEqual(pickedIds(drive(repo, home, ['all', 'all'])), []);
});

test('picked ids come back in plan order, not toggle order', () => {
  const repo = fresh(); const home = fullHome();
  // Toggle a late row first, then an earlier one.
  const state = drive(repo, home, ['up', 'space', 'down', 'down', 'space', 'enter']);
  const ids = pickedIds(state);
  assert.deepEqual(ids, [...ids].sort((a, b) =>
    state.rows.findIndex((r) => r.id === a) - state.rows.findIndex((r) => r.id === b)));
});

test('abort sets aborted and never done', () => {
  const state = drive(fresh(), fullHome(), ['space', 'abort']);
  assert.ok(state.aborted);
  assert.ok(!state.done);
});

// These are *display* paths, which deliberately keep the platform separator — so
// the fixtures are built with `join`/`sep` rather than `/`-separated literals.
// `tilde` keys on `sep`, so a posix literal simply never matched on Windows.

test('tilde shortens home paths and leaves others alone', () => {
  const home = join(sep, 'Users', 'me');
  assert.equal(tilde(join(home, '.codex', 'config.toml'), home), `~${sep}${join('.codex', 'config.toml')}`);
  assert.equal(tilde(join(sep, 'repo', 'AGENTS.md'), home), join(sep, 'repo', 'AGENTS.md'));
  // A sibling directory that merely shares a prefix is not the home dir.
  const sibling = join(sep, 'Users', 'mediocre', 'x');
  assert.equal(tilde(sibling, home), sibling);
});

test('describeWrites names out-of-repo writes as machine-wide', () => {
  const repo = fresh(); const home = fullHome();
  const agents = planInit(repo, { home, ids: ['agents'] })[0];
  const summary = describeWrites(agents.writes, repo, home);
  assert.match(summary, /AGENTS\.md/);
  // `includes` rather than a regex: the expectation contains `sep`, which needs
  // escaping in a pattern on Windows and reads worse for it.
  assert.ok(
    summary.includes(`+ 3 in ~${sep}.codex${sep} (machine-wide)`),
    `machine-wide summary should name ~${sep}.codex${sep}, got: ${summary}`,
  );
});

test('describeWrites flags hosts with no MCP target', () => {
  const repo = fresh(); const home = fullHome();
  const adal = planInit(repo, { home, ids: ['adal'] })[0];
  assert.match(describeWrites(adal.writes, repo, home), /no MCP/);
  const cursor = planInit(repo, { home, ids: ['cursor'] })[0];
  assert.doesNotMatch(describeWrites(cursor.writes, repo, home), /no MCP/);
});

test('describeWrites truncates long path lists', () => {
  const repo = fresh(); const home = fullHome();
  const claude = planInit(repo, { home, ids: ['claude'] })[0];
  assert.match(describeWrites(claude.writes, repo, home), /\+2 more/);
});

test('renderPicker marks the cursor and folds undetected hosts into one line', () => {
  const repo = fresh(); const home = fresh(); // nothing installed
  const state = initialPickerState(planInit(repo, { home }), repo, home);
  const text = renderPicker(state, false);
  assert.match(text, /^graft init — pick the agents your team uses:/);
  assert.match(text, /› \[x\] claude/);
  assert.doesNotMatch(text, /\[ \] cursor/, 'an agent graft cannot find is folded away');
  assert.match(text, /\+ \d+ not detected \(.*cursor.*\) · m to show/);
  assert.match(text, /space toggle · a all · m more · enter confirm/);
  // Only the detected rows get a checkbox until `m`.
  assert.equal(text.split('\n').filter((l) => /\[[ x]\]/.test(l)).length, visibleRows(state).length);

  const opened = reducePicker(state, 'more');
  const all = renderPicker(opened, false);
  assert.match(all, /\[ \] cursor \(not detected\)/);
  assert.equal(all.split('\n').filter((l) => /\[[ x]\]/.test(l)).length, state.rows.length);
});

test('a never selects an agent that is folded away', () => {
  const repo = fresh(); const home = fresh();
  const state = reducePicker(initialPickerState(planInit(repo, { home }), repo, home), 'all');
  for (const id of pickedIds(state)) {
    assert.ok(state.rows.find((r) => r.id === id)?.detected, `${id} was folded and must not be picked`);
  }
});

test('compactWrites shows a folder written into several times once, and two entries at most', () => {
  const repo = fresh(); const home = fullHome();
  const [claude] = planInit(repo, { home, ids: ['claude'] });
  assert.equal(compactWrites(claude.writes, repo, home), `.claude${sep}, .mcp.json · + 3 in ~${sep}`);
  const cursor = planInit(repo, { home, ids: ['cursor'] })[0];
  assert.match(compactWrites(cursor.writes, repo, home), /^[^,]+, [^,]+ \+\d+ more$/);
});

test('formatPlan separates repo writes from machine-wide ones', () => {
  const repo = fresh(); const home = fullHome();
  const plan = planInit(repo, { home });
  const text = formatPlan(plan, ['claude', 'agents'], repo, home, false);
  const repoAt = text.indexOf('would write — this repo:');
  const globalAt = text.indexOf('affects ALL repos:');
  assert.ok(repoAt >= 0 && globalAt > repoAt, 'repo section comes first');
  assert.ok(text.includes(`~${sep}${join('.codex', 'hooks.json')}`), `plan should name the codex hooks file:\n${text}`);
  assert.match(text, /SessionStart \/ UserPromptSubmit \/ PostToolUse \/ Stop/);
  assert.match(text, /nothing was written \(--dry-run\)/);
  assert.match(text, /--no-global/);
});

test('formatPlan omits the machine-wide section when there is nothing global', () => {
  // Cursor, not Claude Code: the claude layer now always carries three writes under
  // `~/.claude` (src/hosts/claude-global.ts), so it can no longer stand in for a
  // repo-only selection. Cursor is one — `.cursor/rules/` plus `.cursor/mcp.json`.
  const repo = fresh(); const home = fullHome();
  const text = formatPlan(planInit(repo, { home }), ['cursor'], repo, home, false);
  assert.doesNotMatch(text, /affects ALL repos/);
  assert.doesNotMatch(text, /--no-global/);
});

test('formatPlan surfaces the claude layer\'s ~ writes as machine-wide', () => {
  const repo = fresh(); const home = fullHome();
  const text = formatPlan(planInit(repo, { home }), ['claude'], repo, home, false);
  assert.match(text, /affects ALL repos/);
  assert.match(text, /--no-global/);
  assert.match(text, /\.claude\.json/);
});

test('formatPlan says so when nothing is selected', () => {
  const repo = fresh();
  assert.match(formatPlan(planInit(repo, { home: fresh() }), [], repo, fresh(), false), /nothing/);
});

test('formatNonInteractiveHelp lists detected ids and a runnable command', () => {
  const text = formatNonInteractiveHelp(['claude', 'cursor']);
  assert.match(text, /nothing written/);
  assert.match(text, /detected: claude, cursor/);
  assert.match(text, /graft init --agents claude cursor {3}# wire these/);
  assert.match(text, /--dry-run/);
});

test('formatNonInteractiveHelp still helps when nothing was detected', () => {
  const text = formatNonInteractiveHelp([]);
  assert.match(text, /detected: none/);
  // No `--yes` example, since there is nothing for it to wire (the header
  // still mentions the flag by name).
  assert.doesNotMatch(text, /^ +graft init --yes/m);
  assert.match(text, /--agents claude/);
});

// --- the telemetry consent row ---

/** Same driver, but with the consent row offered. */
function driveWithConsent(repo: string, home: string, keys: PickerKey[]) {
  let state = initialPickerState(planInit(repo, { home }), repo, home, { offerTelemetry: true });
  for (const k of keys) state = reducePicker(state, k);
  return state;
}

test('the consent row is absent unless it is offered', () => {
  const repo = fresh(); const home = fullHome();
  const state = initialPickerState(planInit(repo, { home }), repo, home);
  assert.equal(state.rows.some((r) => r.id === TELEMETRY_ROW_ID), false);
  assert.equal(pickedTelemetry(state), undefined, 'not offered means no answer, not "no"');
});

test('when offered, the consent row is last and starts checked', () => {
  const repo = fresh(); const home = fullHome();
  const state = initialPickerState(planInit(repo, { home }), repo, home, { offerTelemetry: true });
  assert.equal(state.rows.at(-1)?.id, TELEMETRY_ROW_ID);
  assert.equal(state.rows.at(-1)?.kind, 'setting');
  assert.equal(pickedTelemetry(state), true);
});

test('unchecking the row is how a user declines', () => {
  const repo = fresh(); const home = fullHome();
  // Up from the first row wraps onto the consent row, which is last.
  const state = driveWithConsent(repo, home, ['up', 'space']);
  assert.equal(pickedTelemetry(state), false);
});

test('the consent row is never returned as an agent to wire', () => {
  const repo = fresh(); const home = fullHome();
  const state = driveWithConsent(repo, home, ['all']);
  assert.equal(pickedHostIds(state).includes(TELEMETRY_ROW_ID), false);
  assert.equal(pickedIds(state).includes(TELEMETRY_ROW_ID), true, 'pickedIds keeps its old meaning');
});

test('a (toggle all) is about agents and leaves the consent answer alone', () => {
  const repo = fresh(); const home = fullHome();
  const n = shownCount(repo, home);
  // On: every agent selected, consent still the default yes.
  const on = driveWithConsent(repo, home, ['all']);
  assert.equal(pickedHostIds(on).length, n);
  assert.equal(pickedTelemetry(on), true);
  // Off: no agents, and the consent answer is STILL untouched — "wire nothing"
  // is not the same statement as "share nothing".
  const off = driveWithConsent(repo, home, ['all', 'all']);
  assert.deepEqual(pickedHostIds(off), []);
  assert.equal(pickedTelemetry(off), true);
  // And a user who explicitly declined keeps that through a toggle-all.
  const declined = driveWithConsent(repo, home, ['up', 'space', 'all']);
  assert.equal(pickedTelemetry(declined), false);
});

test('the rendered row shows the label, a rule, and what is not collected', () => {
  const repo = fresh(); const home = fullHome();
  const out = renderPicker(initialPickerState(planInit(repo, { home }), repo, home, { offerTelemetry: true }), false);
  assert.match(out, /\[x\] anonymous usage stats/);
  assert.match(out, /no code, no file paths, no queries/);
  assert.equal(out.includes(TELEMETRY_ROW_ID), false, 'the internal id must never be shown');
  assert.match(out, /─/, 'a rule separates the settings from the agents');
});
