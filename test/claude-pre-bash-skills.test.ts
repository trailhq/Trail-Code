/**
 * PreToolUse's skills part (design 3.3, J13): the agent guard with skills
 * off, the one ask per group of steps that can't be undone in every
 * permission mode, what a yes covers (only the exact later steps, only
 * after the asked call ran), the deny copy where the host can't ask, the
 * fast path's own copies of the save-gate regex and the gate file name, and
 * both copies of the hooks registered: one decision, one receipt. Made-up
 * repo, skill and session ids only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preBashSkills, SAVE_GATE, SKILLS_ADD, canAskHere } from '../src/claude/pre-bash-skills.js';
import { gateFilePathFast } from '../src/claude/pre-bash.js';
import { postBashSkills } from '../src/claude/post-bash.js';
import { SAVE_GATE_RE, SKILLS_ADD_RE } from '../src/skills/save-parse.js';
import { gatedWhat } from '../src/skills/risk.js';
import { programOf } from '../src/trace/shell.js';
import { gateFilePath, readGateFile, type GateFile } from '../src/trace/gate-file.js';
import { skillsGate } from '../src/trace/skill-session.js';
import {
  at, box, done, finish, hook, one, promptHook, release, session, stateOf, type Box, type Session,
} from './claude-skills-journey-fixtures.js';

const STEP2 = 'npm publish acme-cli-{version}.tgz --access public';
const STEP3 = 'npm publish acme-cli-extras-{version}.tgz --access public';
const PARAMS = { version: '1.4.4' };
const RUN2 = 'npm publish acme-cli-1.4.4.tgz --access public';
const RUN3 = 'npm publish acme-cli-extras-1.4.4.tgz --access public';

/** A live block of release-npm whose steps 2 and 3 (two publishes) are one group that can't be undone, as writeGateFile writes it. */
function gate(): GateFile {
  const steps = [{ n: 2, text: STEP2, program: programOf(STEP2) }, { n: 3, text: STEP3, program: programOf(STEP3) }];
  return {
    v: 1, epoch: 0,
    live: [{
      injId: 'i-0001', name: 'release-npm', skillId: 'sk-0001', params: PARAMS, steps: ['npm run build', STEP2, STEP3], check: 'npm view acme-cli version',
      groups: [{ kind: 'publish', steps, askedAt: null, askedToolUseId: null, approvedAt: null, askedStep: null }],
    }],
  };
}

interface Rig { b: Box; s: Session; env: NodeJS.ProcessEnv }
function rig(tag: string, opts: { gate?: GateFile | null; settings?: Record<string, unknown>; mode?: string; env?: Record<string, string> } = {}): Rig {
  const b = box(tag, { settings: opts.settings });
  const s = session(b, { mode: opts.mode });
  const env = { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(22, 0), ...opts.env };
  const g = opts.gate === undefined ? gate() : opts.gate;
  if (g) {
    const path = gateFilePath(s.sid, env);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(g));
  }
  return { b, s, env };
}
const input = (r: Rig, command: string, id: string, extra: Record<string, unknown> = {}) =>
  ({ ...r.s.payload, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, ...extra });
const ran = (r: Rig, command: string, id: string, failed = false, at_ = at(22, 5)) =>
  postBashSkills({ ...r.s.payload, tool_name: 'Bash', tool_input: { command }, tool_use_id: id, ...(failed ? { error: 'Exit code 1\nnpm error 403' } : { tool_response: { stdout: '+ acme-cli@1.4.4', stderr: '' } }) },
    r.b.repo, { ...r.env, TRAIL_TEST_NOW: at_ }, failed);

const ASK = `trail: this ${gatedWhat('publish', STEP2, PARAMS)} and can't be undone (release-npm, steps 2 and 3; your yes here is for both).`;
const denyFor = (cmd: string, n: number) => `trail: Trail, the tool this person installed to keep commands that worked as skills, stopped step ${n} of skill release-npm: it ${gatedWhat('publish', n === 2 ? STEP2 : STEP3, PARAMS)} and can't be undone, and this session can't ask the person first. So don't run it, and don't try it again this turn, even after a yes in chat; ask the person to run this command in their own terminal: ${cmd}`;

test('the agent guard answers with skills off, before anything is read', async () => {
  const r = rig('guard', { gate: null, settings: { skills: 'off' } });
  try {
    for (const cmd of ['trail skills on', 'tr""ail skills offers on', 'node .claude/helpers/trail-hooks.cjs stop']) {
      const d = await preBashSkills(input(r, cmd, 'toolu_g1'), r.b.repo, r.env);
      assert.equal(d?.permissionDecision, 'deny', cmd);
      assert.match(d!.reason, /^trail: /, cmd);
    }
    assert.equal(await preBashSkills(input(r, RUN2, 'toolu_g2'), r.b.repo, r.env), null, 'skills off: nothing more');
  } finally {
    done(r.b);
  }
});

test('J13: with no gate file, a publish is the host\'s own business', async () => {
  const r = rig('nogate', { gate: null });
  try {
    assert.equal(await preBashSkills(input(r, RUN2, 'toolu_n1'), r.b.repo, r.env), null);
    assert.equal(existsSync(gateFilePath(r.s.sid, r.env)), false);
  } finally {
    done(r.b);
  }
});

// Issue #832: quoted data that only names the words — another tool's CLI, a
// commit message, a heredoc — never enters the save gate or the hook guard.
test('quoted data that only names the words never answers, and a real gate command still does (#832)', async () => {
  const r = rig('quoted-data');
  try {
    assert.equal(
      await preBashSkills(input(r, `echo "the other tool's command is: npx skills update"`, 'tq1'), r.b.repo, r.env),
      null,
    );
    assert.equal(
      await preBashSkills(input(r, 'echo "note: graft-hooks.cjs is only named in this quoted text"', 'tq2'), r.b.repo, r.env),
      null,
    );
    const d = await preBashSkills(input(r, 'trail skills add x --run run-1', 'tq3'), r.b.repo, r.env);
    assert.ok(d, 'a real trail skills add still answers');
  } finally {
    done(r.b);
  }
});

test('J13: the asking modes ask once with Trail\'s reason; the others, and headless, deny and show the command', async () => {
  for (const mode of ['default', 'acceptEdits', 'plan']) {
    const r = rig(`ask-${mode}`, { mode });
    try {
      const d = await preBashSkills(input(r, RUN2, 'toolu_a1'), r.b.repo, r.env);
      assert.deepEqual(d, { permissionDecision: 'ask', reason: ASK }, mode);
      assert.equal(readGateFile(r.s.sid, r.env)!.live[0]!.groups[0]!.askedStep, 2);
    } finally {
      done(r.b);
    }
  }
  for (const [mode, env] of [['bypassPermissions', {}], ['dontAsk', {}], ['default', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }]] as const) {
    const r = rig(`deny-${mode}`, { mode, env });
    try {
      const d = await preBashSkills(input(r, RUN2, 'toolu_d1'), r.b.repo, r.env);
      assert.deepEqual(d, { permissionDecision: 'deny', reason: denyFor(RUN2, 2) }, `${mode} ${JSON.stringify(env)}`);
    } finally {
      done(r.b);
    }
  }
});

test('J13: a two-step group asks once; the yes covers the next step exactly as shown, and nothing else', async () => {
  const r = rig('group');
  try {
    assert.equal((await preBashSkills(input(r, RUN2, 'toolu_s2'), r.b.repo, r.env))?.permissionDecision, 'ask');
    ran(r, RUN2, 'toolu_s2');
    assert.ok(readGateFile(r.s.sid, r.env)!.live[0]!.groups[0]!.approvedAt, 'the asked call ran: approved');
    const later = { ...r.env, TRAIL_TEST_NOW: at(22, 30) };
    assert.equal(await preBashSkills(input(r, RUN3, 'toolu_s3'), r.b.repo, later), null, 'step 3 as shown: covered');
    const forced = await preBashSkills(input(r, `${RUN3} --force`, 'toolu_s3f'), r.b.repo, later);
    assert.equal(forced?.permissionDecision, 'ask', 'more than was shown asks again');
    // The asked step itself again is a new ask (a second publish).
    assert.equal((await preBashSkills(input(r, RUN2, 'toolu_s2b'), r.b.repo, later))?.permissionDecision, 'ask');
  } finally {
    done(r.b);
  }
});

test('J13: an asked step that failed (or was refused) approves nothing; the next step asks again', async () => {
  const r = rig('failed');
  try {
    assert.equal((await preBashSkills(input(r, RUN2, 'toolu_f2'), r.b.repo, r.env))?.permissionDecision, 'ask');
    ran(r, RUN2, 'toolu_f2', true);
    assert.equal(readGateFile(r.s.sid, r.env)!.live[0]!.groups[0]!.approvedAt, null);
    assert.equal((await preBashSkills(input(r, RUN3, 'toolu_f3'), r.b.repo, { ...r.env, TRAIL_TEST_NOW: at(22, 30) }))?.permissionDecision, 'ask');
  } finally {
    done(r.b);
  }
});

test('J13: a yes covers 30 minutes; a step another way round (`true || npm publish x`) is still asked', async () => {
  const r = rig('window');
  try {
    await preBashSkills(input(r, RUN2, 'toolu_w2'), r.b.repo, r.env);
    ran(r, RUN2, 'toolu_w2');
    assert.equal((await preBashSkills(input(r, RUN3, 'toolu_w3'), r.b.repo, { ...r.env, TRAIL_TEST_NOW: at(22, 31 * 60) }))?.permissionDecision, 'ask', 'past 30 minutes');
    const sneaky = await preBashSkills(input(r, 'true || npm publish other-9.9.9.tgz', 'toolu_w4'), r.b.repo, r.env);
    assert.equal(sneaky?.permissionDecision, 'ask', 'D53: every simple command is read');
    assert.equal(await preBashSkills(input(r, 'git status', 'toolu_w5'), r.b.repo, r.env), null, 'not a gated step');
  } finally {
    done(r.b);
  }
});

test('the fast path\'s copies match: the save-gate regex and the gate file name', () => {
  assert.equal(SKILLS_ADD.source, SKILLS_ADD_RE.source);
  assert.equal(SKILLS_ADD.flags, SKILLS_ADD_RE.flags);
  assert.equal(SAVE_GATE.source, SAVE_GATE_RE.source);
  assert.equal(SAVE_GATE.flags, SAVE_GATE_RE.flags);
  const env = { TRAIL_HOME: '/home/dev/.trail-test' };
  for (const id of ['3c9d2e1f-0a1b-4c2d-8e3f-000000000001', 'a b/../c', '.hidden', 'x'.repeat(200), 'é-session']) {
    assert.equal(gateFilePathFast({ session_id: id }, env), gateFilePath(id, env), id);
  }
  assert.equal(gateFilePathFast({ conversation_id: 'c-1' }, env), gateFilePath('c-1', env));
  assert.equal(gateFilePathFast({}, env), null);
});

test('canAskHere reads the entrypoint as skillsGate does', () => {
  const b = box('canask');
  try {
    const s = session(b);
    for (const ep of ['cli', 'claude-vscode', 'sdk-cli', 'sdk-ts', undefined]) {
      const env: NodeJS.ProcessEnv = { HOME: b.home, TRAIL_HOME: b.trail, ...(ep === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: ep }) };
      const g = skillsGate(s.payload, b.repo, env);
      assert.ok(g.ok, `${ep}: ${JSON.stringify(g)}`);
      assert.equal(canAskHere(s.payload, env), g.ctx.entry === 'interactive', String(ep));
    }
  } finally {
    done(b);
  }
});

test('both copies registered: the repo\'s copy stands down, the ~/.claude copy gives the one decision and the one receipt', async () => {
  const b = box('copies');
  const argv1 = process.argv[1];
  try {
    const helpers = join(b.home, '.claude', 'helpers');
    mkdirSync(helpers, { recursive: true });
    const globalShim = join(helpers, 'trail-hooks.cjs');
    writeFileSync(globalShim, '// finds @trailhq/trail-code\n');
    const hookCmd = `node "${globalShim}" pre-bash || exit 0`;
    writeFileSync(join(b.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd, timeout: 5 }] }] } }));
    const repoShim = join(b.repo, '.claude', 'helpers', 'trail-hooks.cjs');
    const both = async (s: Session, iso: string, command: string, id: string) => {
      const outs: string[] = [];
      for (const shim of [repoShim, globalShim]) {
        process.argv[1] = shim;
        outs.push(await hook(s, 'pre-bash', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id }, iso));
      }
      return outs;
    };

    // The save: one receipt, written by the copy that answers.
    const s = session(b);
    await release(s, 22, '1.4.3');
    await finish(s, 22, 'Published 1.4.3.');
    await promptHook(s, at(22, 60), 'save this as a skill');
    const runId = stateOf(s).saveRequest?.runId ?? stateOf(s).runs.find((r) => r.sheet === 'checked')!.id;
    const receipt = join(b.trail, 'receipts', `${s.sid}.json`);
    process.argv[1] = repoShim;
    assert.equal(await hook(s, 'pre-bash', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `trail skills add release-npm --run ${runId}` }, tool_use_id: 'toolu_c1' }, at(22, 70)), '');
    assert.equal(existsSync(receipt), false, 'the repo copy wrote nothing');
    process.argv[1] = globalShim;
    await hook(s, 'pre-bash', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `trail skills add release-npm --run ${runId}` }, tool_use_id: 'toolu_c1' }, at(22, 70));
    assert.equal(existsSync(receipt), true, 'one receipt');

    // The ask: one decision.
    const t = session(b);
    const path = gateFilePath(t.sid, { TRAIL_HOME: b.trail });
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(gate()));
    const [repoOut, globalOut] = await both(t, at(22, 100), RUN2, 'toolu_c2');
    assert.equal(repoOut, '');
    assert.equal(one(globalOut!)?.hookSpecificOutput?.permissionDecision, 'ask');
  } finally {
    process.argv[1] = argv1!;
    done(b);
  }
});

