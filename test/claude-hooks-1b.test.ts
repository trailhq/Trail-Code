/**
 * Phase 1b wired into Claude Code's hooks (design 3.1 to 3.5, b7): every
 * call goes through `main(event)` with the `GRAFT_TEST_STDIN` seam, a
 * sandbox Trail home, the test clock and a synthetic transcript that grows
 * between calls. Made-up repos, prompts and commands only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { LESSON_DENY, keepLessonCli } from '../src/skills/lesson-gate.js';
import { readWalls } from '../src/trace/wall-state.js';
import { everyRepoDir, writeEveryRepo } from '../src/notes/every-repo.js';
import { writeLesson } from '../src/skills/lessons.js';
import { guardrailLearning } from '../src/notes/guardrails.js';
import { stopSkillsRun } from '../src/claude/stop-skills.js';
import { keepReceiptPath } from '../src/init/keep-gate.js';
import { keepCommand } from '../src/init/keep.js';
import { offerLinesOf } from '../src/skills/offer-lines.js';
import { readInitRecord } from '../src/init/init-record.js';
import { updateInitRecord } from '../src/init/init-record.js';
import { relayLines } from '../src/init/review-screen.js';
import type { InitItem } from '../src/init/types.js';
import { factsOf, guardrailCandidate, skillCandidate } from './init-screen-fixtures.js';
import {
  agentRuns, at, box, cli, CWD, done, finish, hook, ls, offersLog, one, pathWithoutTimeout, preBashHook, promptHook, ran, release, reply, sayOfferLines, session, SHOP, skillsKept, startHook, stateOf, timeoutSeen, typedLine,
  type Box, type Session,
} from './claude-skills-journey-fixtures.js';
import { allowedValue, EVENTS } from '../src/telemetry/contract.js';

const decision = (out: string) => one(out)?.hookSpecificOutput ?? null;

/** Telemetry carries only the contract's keys and values (counts only, R16). */
function contractOnly(sent: Array<[string, Record<string, string>]>): void {
  for (const [event, props] of sent) {
    const keys = EVENTS[event];
    assert.ok(keys, `not a contract event: ${event}`);
    for (const [k, v] of Object.entries(props)) {
      assert.ok(keys.has(k), `${event}.${k} is not in the contract`);
      assert.ok(allowedValue(event, k, String(v)), `${event}.${k}=${v} is not a contract value`);
    }
  }
}

test('a trail skills lesson command reaches the lesson gate: no lesson offer in this session denies it (3.3 step 2)', async () => {
  const b = box('h1b-lesson-gate');
  try {
    const s = session(b);
    const d = decision(await preBashHook(s, at(17, 0), 'trail skills lesson release-npm --offer o-0a1b2c3d', 'toolu_l1'));
    assert.equal(d?.permissionDecision, 'deny');
    assert.equal(d?.permissionDecisionReason, LESSON_DENY.noOffer);
  } finally {
    done(b);
  }
});

/** Two init items waiting for the person's answer (b6's record), and the relay text `trail init` printed for them. */
function initWaiting(b: Box): { items: InitItem[]; listText: string } {
  const items: InitItem[] = [
    { ...skillCandidate(), n: 1, title: 'release-npm', description: '' },
    { ...guardrailCandidate(), n: 2, title: 'no-timeout', description: '' },
  ];
  updateInitRecord('github.com/acme/cli', (r) => {
    r.pending = items.map((i) => ({ ...i }));
    r.pendingFrom = 'ir-5d0e';
    r.shownAt = at(17, 0);
  }, { TRAIL_HOME: b.trail });
  return { items, listText: `✓ wired claude\n${relayLines(items, factsOf({ agent: true })).join('\n')}` };
}

test('trail keep: the copy that stands down does so before the keep check runs, so only the answering copy writes the keep receipt (R11)', async () => {
  const b = box('h1b-keep-copies');
  const argv1 = process.argv[1];
  try {
    const helpers = join(b.home, '.claude', 'helpers');
    mkdirSync(helpers, { recursive: true });
    const globalShim = join(helpers, 'trail-hooks.cjs');
    writeFileSync(globalShim, '// finds @trailhq/trail-code\n');
    writeFileSync(join(b.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${globalShim}" pre-bash || exit 0`, timeout: 5 }] }] } }));
    const { listText } = initWaiting(b);
    const s = session(b);
    typedLine(s, at(17, 1), 'set up trail in this repo');
    ran(s, at(17, 2), 'trail init', listText);
    reply(s, at(17, 3), 'Trail found two things:\n1. release-npm (skill)\n2. no-timeout (guardrail)\nWhich numbers should I keep?');
    typedLine(s, at(17, 4), 'keep 1 and 2');
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'trail keep 1 2' }, tool_use_id: 'toolu_k1' };
    const receipt = keepReceiptPath(s.sid, { TRAIL_HOME: b.trail });
    process.argv[1] = join(b.repo, '.claude', 'helpers', 'trail-hooks.cjs');
    assert.equal(await hook(s, 'pre-bash', payload, at(17, 5)), '');
    assert.equal(existsSync(receipt), false, 'the repo copy stood down before keepDecision wrote anything');
    process.argv[1] = globalShim;
    assert.equal(await hook(s, 'pre-bash', payload, at(17, 5)), '', 'allowed: nothing to say');
    assert.equal(existsSync(receipt), true, 'the answering copy wrote the one receipt');
  } finally {
    process.argv[1] = argv1!;
    done(b);
  }
});

const DOCKER_ERR = 'Exit code 1\n--- FAIL: TestOrders (0.01s)\npanic: rootless Docker not found [recovered]\nFAIL\tacme/shop/orders\t0.412s';
const GO_TEST = 'go test -tags integration ./...';
const FIXED = 'DOCKER_HOST=unix://$HOME/.colima/default/docker.sock go test -tags integration ./...';

/** J06's machine: a colima on the hooks' PATH. */
function colima(b: Box): void {
  const bin = join(b.root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'colima'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'colima'), 0o755);
  b.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
}

/** One session of J06: the integration tests hit the docker wall, the same command with Colima's socket passes. */
async function dockerDay(s: Session, day: number): Promise<{ stop: Record<string, any> | null }> {
  await promptHook(s, at(day, 0), 'run the integration tests');
  await agentRuns(s, at(day, 10), GO_TEST, () => ({ out: DOCKER_ERR, failed: true }));
  await agentRuns(s, at(day, 20), FIXED, () => ({ out: 'ok  \tacme/shop/orders\t0.512s' }));
  return { stop: await finish(s, day, 'Tests pass.') };
}

test('J06 end to end: day 1 hits the docker wall and gets the fix, Stop records the hit and the repair with no offer; day 2 offers the lesson, and yes keeps it', async () => {
  const b = box('h1b-j06');
  try {
    colima(b);
    // Day 1.
    const s1 = session(b);
    await promptHook(s1, at(10, 0), 'run the integration tests');
    const fail = await agentRuns(s1, at(10, 10), GO_TEST, () => ({ out: DOCKER_ERR, failed: true }));
    void fail;
    assert.equal(existsSync(join(b.trail, 'walls.json')), false, 'PostToolUseFailure wrote nothing');
    await agentRuns(s1, at(10, 20), FIXED, () => ({ out: 'ok  \tacme/shop/orders\t0.512s' }));
    const stop1 = await finish(s1, 10, 'Tests pass.');
    assert.equal(stop1?.decision, undefined, 'no offer on day 1');
    const w = readWalls({ TRAIL_HOME: b.trail });
    const cls = w.classes['docker-rootless'];
    assert.equal(cls?.seen.length, 1);
    assert.equal(cls?.fixed.length, 1);
    assert.deepEqual(cls?.fixed[0]?.delta, [{ kind: 'env', name: 'DOCKER_HOST' }]);
    assert.doesNotMatch(readFileSync(join(b.trail, 'walls.json'), 'utf8'), /go test|colima\/default|TestOrders/, 'no command or output text');

    // Day 2, another session.
    const s2 = session(b);
    const { stop } = await dockerDay(s2, 14);
    assert.equal(stop?.decision, 'block', JSON.stringify(stop));
    const offer = stateOf(s2).pendingOffer!;
    assert.equal(offer.moment, 'repaired');
    const lines = offer.lines!;
    assert.match(lines[0], /This is the 2nd time this week that go failed on "rootless Docker not found" and needed Colima's socket\.$/);
    assert.equal(lines[1], `Keep what fixed it as a learning, just for you in every repo: "'rootless Docker not found': DOCKER_HOST=unix://$HOME/.colima/default/docker.sock"? (yes / no)`);
    assert.ok(stop!.reason.includes(lines[0]) && stop!.reason.includes(lines[1]));
    await sayOfferLines(s2, 14, lines);
    await promptHook(s2, at(14, 60), 'yes');
    const cmd = `trail skills lesson --offer ${offer.offerId}`;
    const kept = await agentRuns(s2, at(14, 70), cmd, () => {
      const r = keepLessonCli(null, offer.offerId, { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(14, 71) }, new Date(at(14, 71)));
      return { out: r.line, failed: r.code !== 0 };
    });
    assert.equal(kept.decision, null, 'the lesson gate let it through');
    assert.match(kept.out, /^✓ learning kept, just for you in every repo · Trail shows it when "rootless Docker not found" comes back · undo: trail forget l-[0-9a-f]{8}$/);
    assert.ok(ls(everyRepoDir({ TRAIL_HOME: b.trail })).some((f) => f.startsWith('lesson-docker-rootless-')));
    assert.deepEqual(offersLog(b).map((o) => [o.event, o.moment, o.answer ?? null]), [['shown', 'repaired', null], ['answer', 'repaired', 'yes']]);
  } finally {
    done(b);
  }
});

/** A machine where Trail still finds a `timeout` (a system folder of 4.11, or Windows' System32) can't show a deny. */
const SYSTEM_TIMEOUT = timeoutSeen();

/** Stop's skills part in this process, with the telemetry it collected (the hook queues it; the test reads it). */
const stopSent = (s: Session, iso: string, said: string) => stopSkillsRun({ ...s.payload, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: said }, s.b.project,
  { HOME: s.b.home, TRAIL_HOME: s.b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: iso, DO_NOT_TRACK: '1', PATH: process.env.PATH });

test('J16 at Stop: each sure-fail deny is counted once, and the same command run without timeout right after counts as avoided', { skip: SYSTEM_TIMEOUT }, async () => {
  const b = box('h1b-j16-stop', { env: { PATH: pathWithoutTimeout() } });
  try {
    writeEveryRepo(guardrailLearning('timeout-missing', 'every repo', 'on 6 days', new Date(2026, 9, 1)), 'no-timeout.md', { TRAIL_HOME: b.trail });
    const s = session(b);
    await promptHook(s, at(17, 0), 'run the tests');
    const denied = await agentRuns(s, at(17, 10), 'timeout 60 npm test');
    assert.equal(denied.decision?.hookSpecificOutput?.permissionDecision, 'deny');
    await agentRuns(s, at(17, 20), 'npm test', () => ({ out: 'Tests: 12 passed, 12 total' }));
    reply(s, at(17, 30), 'Tests pass.');
    const r = stopSent(s, at(17, 31), 'Tests pass.');
    const guard = r.sent.filter(([e]) => e === 'guardrail');
    contractOnly(r.sent as Array<[string, Record<string, string>]>);
    assert.deepEqual(guard, [['guardrail', { class: 'no-timeout', outcome: 'sure-fail' }], ['guardrail', { class: 'no-timeout', outcome: 'avoided' }]]);
    assert.equal(stateOf(s).deniedSeen, 1);
    reply(s, at(17, 40), 'Anything else?');
    assert.deepEqual(stopSent(s, at(17, 41), 'Anything else?').sent.filter(([e]) => e === 'guardrail'), [], 'counted once');
  } finally {
    done(b);
  }
});

test('J02 leg C through the keep gate and the CLI: the handed-over list, the reply naming it, the person\'s "keep 2", then trail keep 2 keeps only that', async () => {
  const b = box('h1b-j02c');
  try {
    const items: InitItem[] = [
      { ...skillCandidate(), applies: SHOP, n: 1, title: 'release-npm', description: '' },
      { ...guardrailCandidate(), n: 2, title: 'no-timeout', description: '' },
    ];
    updateInitRecord(SHOP, (r) => {
      r.pending = items.map((i) => ({ ...i }));
      r.pendingFrom = 'ir-7a1b';
      r.shownAt = at(16, 0);
    }, { TRAIL_HOME: b.trail });
    const s = session(b);
    const started = one(await startHook(s, at(17, 0)));
    const context: string = started?.hookSpecificOutput?.additionalContext ?? '';
    assert.match(context, /trail init found 2 items/);
    assert.equal(readInitRecord(SHOP, { TRAIL_HOME: b.trail }).handover?.session, s.sid);
    await promptHook(s, at(17, 1), 'what did trail find?');
    reply(s, at(17, 2), 'Trail found two things it can keep:\n1. release-npm (skill)\n2. no-timeout (guardrail)\nWhich numbers should I keep?');
    await promptHook(s, at(17, 3), 'keep 2');
    const early = one(await preBashHook(s, at(17, 4), 'trail keep 1 2', 'toolu_k2'))?.hookSpecificOutput;
    assert.equal(early?.permissionDecision, 'deny', 'only the numbers typed');
    const ok = await preBashHook(s, at(17, 5), 'trail keep 2', 'toolu_k3');
    assert.equal(ok, '', 'allowed');
    const env = { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(17, 6), DO_NOT_TRACK: '1' };
    const r = keepCommand(['2'], env, new Date(at(17, 6)), { dir: CWD, tty: false });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.ok(existsSync(join(b.trail, 'learnings', 'no-timeout.md')), 'the guardrail is kept');
    assert.equal(existsSync(join(b.trail, 'skills', 'release-npm')), false, 'item 1 is not');
    // The session after says nothing more.
    const next = session(b);
    assert.doesNotMatch(one(await startHook(next, at(18, 0)))?.hookSpecificOutput?.additionalContext ?? '', /trail init found/);
  } finally {
    done(b);
  }
});

const startContext = async (s: Session, iso: string) => {
  const out = one(await startHook(s, iso));
  return { context: String(out?.hookSpecificOutput?.additionalContext ?? ''), notice: out?.systemMessage as string | undefined };
};

test('J16: a plain repo\'s session start carries the every-repo guardrail and preference, never a wall lesson, skills on or off', async () => {
  for (const skills of ['on', 'off']) {
    const b = box(`h1b-j16-start-${skills}`, { settings: { skills } });
    try {
      const env = { TRAIL_HOME: b.trail };
      writeEveryRepo(guardrailLearning('timeout-missing', 'every repo', 'on 6 days', new Date(2026, 9, 1)), 'no-timeout.md', env);
      writeEveryRepo({ title: 'explain it simply, one example first', body: 'explain it simply, one example first', author: '', date: '2026-10-01', kind: 'preference', src: 'init-typed' }, 'pref-explain-simply.md', env);
      writeLesson({ id: '', skill: null, at: '2026-10-02', text: '"rootless Docker not found": colima start', kind: 'lesson', src: 'repair', wall: 'docker-rootless' }, SHOP, env);
      const { context } = await startContext(session(b), at(17, 0));
      assert.match(context, /Standing learnings/, skills);
      assert.match(context, /No timeout on this Mac/, skills);
      assert.match(context, /explain it simply, one example first/, skills);
      assert.doesNotMatch(context, /colima start|rootless Docker/, `${skills}: a wall lesson never loads at start (R47)`);
    } finally {
      done(b);
    }
  }
});

test('D87: what the person kept on trail init\'s screen is named once at the next session start, each with its undo', async () => {
  const b = box('h1b-d87');
  try {
    updateInitRecord(SHOP, (r) => {
      r.notice = { run: 'ir-5d0e', at: at(16, 0), shownAt: null, items: [
        { kind: 'skill', name: 'release-npm', id: 's-7f3a2c', forget: 'release-npm' },
        { kind: 'guardrail', name: 'no-timeout', id: 'l-0a1b2c3d', forget: 'no-timeout' },
      ] };
    }, { TRAIL_HOME: b.trail });
    const first = await startContext(session(b), at(17, 0));
    assert.match(first.context, /\[trail\] From Trail, the tool this person installed[^\n]*tell them once, at the start of your first reply: "kept from trail init in your terminal: release-npm \(skill, undo: trail forget release-npm\) · no-timeout \(always-follow learning, undo: trail forget no-timeout\)"/);
    assert.ok(readInitRecord(SHOP, { TRAIL_HOME: b.trail }).notice?.shownAt);
    assert.doesNotMatch((await startContext(session(b), at(17, 5))).context, /kept from trail init/, 'once');
  } finally {
    done(b);
  }
});

const ctxOf = (out: string) => String(one(out)?.hookSpecificOutput?.additionalContext ?? '');

test('J07 end to end: a release from the block, the person\'s correction, the fix, the lesson offer, yes, trail skills lesson, and the next block ends with the lesson', async () => {
  const b = box('h1b-j07');
  try {
    // release-npm kept on Oct 20 ("save this as a skill").
    const s0 = session(b);
    await release(s0, 20, '1.4.0');
    await finish(s0, 20, 'Published 1.4.0.');
    const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(ctxOf(await promptHook(s0, at(20, 60), 'save this as a skill'))) ?? [];
    const add = `trail skills add ${name} --run ${runId}`;
    await agentRuns(s0, at(20, 70), add, cli(b, at(20, 70), add));
    assert.deepEqual(skillsKept(b), [name]);

    // Oct 22: the block, the run, then the correction and the fix.
    const s = session(b);
    assert.match(ctxOf(await promptHook(s, at(22, 0), 'publish 1.4.1')), new RegExp(`^\\[trail\\] Skill ${name} fits`));
    await agentRuns(s, at(22, 10), 'npm run build', () => ({ out: 'built' }));
    await agentRuns(s, at(22, 20), 'npm publish acme-cli-1.4.1.tgz --access public', () => ({ out: '+ acme-cli@1.4.1' }));
    await agentRuns(s, at(22, 30), 'npm view acme-cli version', () => ({ out: '1.4.1' }));
    await finish(s, 22, `Published 1.4.1.\nUsed skill ${name}`);
    await promptHook(s, at(22, 60), "no, it didn't push the tag");
    await agentRuns(s, at(22, 70), 'git push origin --tags', () => ({ out: 'To github.com:acme/shop.git\n * [new tag]         v1.4.1 -> v1.4.1' }));
    const stop = await finish(s, 22, 'Pushed the tag.', 80);
    assert.equal(stop?.decision, 'block', JSON.stringify(stop));
    const offer = stateOf(s).pendingOffer!;
    assert.equal(offer.moment, 'correction');
    // A correction's lines are rebuilt from the transcript (its typed words are never on disk).
    const lines = offerLinesOf(offer, s.tx, { HOME: b.home, TRAIL_HOME: b.trail })!;
    assert.ok(stop!.reason.includes(lines[0]) && stop!.reason.includes(lines[1]));
    assert.match(lines[0]!, new RegExp(`^You corrected ${name}: it didn't push the tag\\.`));
    assert.match(lines[1]!, /^Add a learning to it, just for you: "push the tag too: git push origin --tags"\? \(yes \/ no\)$/);
    await sayOfferLines(s, 22, lines, 85);
    await promptHook(s, at(22, 100), 'yes');
    const cmd = `trail skills lesson ${name} --offer ${offer.offerId}`;
    const kept = await agentRuns(s, at(22, 110), cmd, () => {
      const r = keepLessonCli(name!, offer.offerId, { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(22, 111) }, new Date(at(22, 111)));
      return { out: r.line, failed: r.code !== 0 };
    });
    assert.equal(kept.decision, null, 'the lesson gate let it through');
    assert.match(kept.out, new RegExp(`^✓ learning added to ${name}, just for you · it rides at the end of the skill's steps · undo: trail forget ls-[0-9a-f]{6}$`));
    assert.equal(ls(join(b.trail, 'skills', name!, 'lessons')).length, 1);

    // Oct 24: the next block ends with the lesson.
    const s2 = session(b);
    const block = ctxOf(await promptHook(s2, at(24, 0), 'publish 1.4.2'));
    const last = block.trimEnd().split('\n').pop()!;
    assert.equal(last.trim(), 'New learning (the person, Oct 22): push the tag too: git push origin --tags', block);
    assert.deepEqual(offersLog(b).filter((o) => o.moment === 'correction').map((o) => [o.event, o.answer ?? null]), [['shown', null], ['answer', 'yes']]);
  } finally {
    done(b);
  }
});

test('J14d through the hooks: a cue phrase whose block is passed over twice leaves asks, and the prompt hook sends skill_stale{unfollowed} once', async () => {
  const { savePersonal } = await import('../src/skills/store.js');
  const { compiled } = await import('./skills-store-fixtures.js');
  const { parseSkillMd } = await import('../src/skills/skillmd.js');
  const b = box('h1b-j14d');
  try {
    const PHRASE = 'redo the acme publish';
    const ref = savePersonal(compiled('release-npm', { trail: 's-7f3a2c', applies: SHOP, asks: `publish, release, ${PHRASE}` }),
      { from: 'repeated', runId: 'r-0930-0001', consent: 'offer-yes', stepsVerified: 2, env: { HOME: b.home, TRAIL_HOME: b.trail }, now: new Date(at(10, 0)) });
    const sent: Array<[string, Record<string, string>]> = [];
    for (const day of [12, 13]) {
      const s = session(b);
      assert.match(ctxOf(await promptHook(s, at(day, 0), PHRASE)), /^\[trail\] Skill release-npm fits/);
      await agentRuns(s, at(day, 10), 'git status', () => ({ out: 'nothing to commit, working tree clean' }));
      reply(s, at(day, 20), 'The tree is clean.');
      sent.push(...(stopSent(s, at(day, 21), 'The tree is clean.').sent as Array<[string, Record<string, string>]>));
      // The person moves to another job: the release run closes with none of its steps run, in the prompt hook's
      // credit step (its telemetry read through the hook's track).
      typedLine(s, at(day, 60), 'run the test suite');
      const { promptSkills } = await import('../src/claude/prompt-skills.js');
      promptSkills({ ...s.payload, hook_event_name: 'UserPromptSubmit', prompt: 'run the test suite' }, s.b.project,
        { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(day, 60), DO_NOT_TRACK: '1', PATH: process.env.PATH },
        { track: (e, p) => sent.push([e, p]) });
      await agentRuns(s, at(day, 65), 'npm test', () => ({ out: 'Tests: 12 passed, 12 total' }));
      reply(s, at(day, 70), 'Got it.');
      sent.push(...(stopSent(s, at(day, 71), 'Got it.').sent as Array<[string, Record<string, string>]>));
    }
    assert.equal(parseSkillMd(readFileSync(ref.file, 'utf8'), 'release-npm')!.meta.asks, 'publish, release');
    assert.deepEqual(sent.filter(([e]) => e === 'skill_stale'), [['skill_stale', { reason: 'unfollowed' }]], JSON.stringify(sent));
    contractOnly(sent);
  } finally {
    done(b);
  }
});
