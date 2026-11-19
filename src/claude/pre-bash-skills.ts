/**
 * The skills part of PreToolUse on Bash (design 3.3): the agent guard, the
 * save gate, and the one ask before a step of a live run block that can't
 * be undone.
 *
 * `pre-bash.ts` loads this file only when its prefilter holds (the command
 * says `skills` or names a Trail hook script, or this session has a gate
 * file), and only in the copy of the hooks that answers (0 rule 15). It runs
 * before a shell command, so its static imports are the fast-path modules
 * alone: the shell lexer, the gate file, the risk lists, the host facts and
 * host detection, each loading only node:path and node:os. The save gate,
 * the session state and compile load by `import()` on the save-gate path
 * only.
 *
 * In order:
 *  1. The agent guard, whatever the settings say: commands only the person
 *     may run (turn skills or offers on, keep a held skill) and Trail's hook
 *     scripts run by hand are denied.
 *  2. Skills off: nothing more.
 *  2b. 1b's sure-fail guardrail (4.11, recall half, subagents too): a
 *     `timeout N` command on a machine with no `timeout`, when the person
 *     kept the no-timeout guardrail, is denied and the deny marked for Stop's
 *     count (no telemetry module on this path). Nothing else runs for it.
 *  3. `skills add` or `skills lesson`: the save gate decides (a deny, or a
 *     receipt and null); the lesson gate loads only for a lesson command.
 *  4. A step of a live run block that can't be undone: Claude Code asks the
 *     person once per group of such steps; where it can't ask (headless, a
 *     mode that doesn't ask, another host), the step is denied and its
 *     command shown for the person to run.
 * Anything thrown lets the command through: a hook that can wedge every
 * shell command is worse than none.
 */
import { bareCommand, normalizeCommand, programOf, simpleCommands, stepMatches } from '../trace/shell.js';
import { markAsked, markHanded, readGateFile, skillsOnFast, trailHomeFast, type GateFile, type GateGroup } from '../trace/gate-file.js';
import { agentGuard, gatedAnywhere, gatedKind, gatedWhat, shellWords } from '../skills/risk.js';
import { hostFacts, isTestHome, labInteractive } from '../skills/host-facts.js';
import { detectHost } from '../trace/host.js';
import { markDenied, sureFail } from '../trace/guard-fast.js';
import type { PreBashDecision } from './pre-bash.js';
import type * as Fs from 'node:fs';
import { join } from 'node:path';

/** save-parse.ts SKILLS_ADD_RE, kept here so the fast path needn't load the save gate to test for it (a test holds them equal). */
export const SKILLS_ADD = /\bskills\s+add\b/;
/** save-parse.ts SAVE_GATE_RE (`skills add`, `skills lesson`, phase 2 `skills update`), kept here for the same reason (a test holds them equal). */
export const SAVE_GATE = /\bskills\s+(?:add|lesson|update)\b/;
/** The gate verbs, as a subcommand of the CLI. */
const GATE_SUBS = /^(?:add|lesson|update)$/;
/** Issue #832: does the command RUN `trail skills add|lesson|update` — some simple command's program (wrappers
 *  gone, via `bareCommand`, the same parser the agent guard trusts) is the trail CLI and its subcommand is
 *  `skills` + a gate verb? Quoted data that merely names the words (a commit message, a heredoc, another tool's
 *  CLI) never fires the gate. */
export function runsTrailSkillsGate(cmd: string): boolean {
  return simpleCommands(cmd).some((simple) => {
    const w = bareCommand(simple).split(' ').filter(Boolean);
    for (let i = 0; i < w.length; i++) {
      const cli = /(?:^|\/)(?:trail|graft)(?:-dev)?$/.test(w[i]!)
        || (w[i] === 'npx' && /@(?:nanonets\/graft|trailhq\/trail-code)$/.test(w[i + 1] ?? ''));
      if (!cli) continue;
      const rest = w.slice(i + (w[i] === 'npx' ? 2 : 1));
      return rest[0] === 'skills' && GATE_SUBS.test(rest[1] ?? '');
    }
    return false;
  });
}
/** How long a yes to the first step of a group covers its later steps. */
export const APPROVED_MS = 30 * 60 * 1000;
const SHOWN_MAX = 500;
/** directive-words.ts FROM_TRAIL's who, kept here so the fast path loads nothing more (a test holds them equal). */
export const TRAIL_WHO = 'Trail, the tool this person installed to keep commands that worked as skills,';
/** Past this a command is not split into its simple commands on the fast path (a 2 MB one takes seconds). */
const SPLIT_MAX = 64 * 1024;

/** The words the shell runs, as the agent guard reads them (risk.ts shellWords): `tr''ail sk"ills" on`, a line continuation joined. */
export const guardWords = shellWords;

/** 3.3. `command` is the shell call's command when the caller has it (any host's shape); else Claude Code's `tool_input.command`. */
export async function preBashSkills(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, command?: string): Promise<PreBashDecision | null> {
  try {
    const cmd = typeof command === 'string' ? command : typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';
    if (!cmd) return null;
    // 1. Any settings, no file read.
    const guard = agentGuard(cmd);
    if (guard) return { permissionDecision: 'deny', reason: `trail: ${guard.reason}` };
    // 2.
    if (!skillsOnFast(env)) return null;
    // 2b. 1b: the sure-fail guardrail. Its deny is the whole answer; Stop counts it from the mark (3.5 step 5).
    const sure = sureFail(cmd, env);
    if (sure) {
      const sid = rawSessionId(input);
      if (sid) markDenied(sid, cmd, env, nowOf(env));
      return { permissionDecision: 'deny', reason: sure.deny };
    }
    // 3. The only path that loads more code.
    if (runsTrailSkillsGate(cmd)) {
      const { saveOrLessonGate } = await import('../skills/save-gate.js');
      return saveOrLessonGate(input, dir, env);
    }
    // 4.
    return gatedAsk(input, cmd, env);
  } catch (e) {
    await logThrow(e, env);
    return null;
  }
}

/**
 * 0 rule 5: one line in `state/hook-errors.log`, as skills-hook-util's hookError writes it (the time, the hook, the
 * error's name and file, never its message), with node:fs from the process so the fast path loads nothing more.
 */
async function logThrow(e: unknown, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const fs = process.getBuiltinModule('node:fs') as typeof Fs;
    const err = e instanceof Error ? e : new Error('not an Error');
    const where = (err.stack ?? '').split('\n').slice(1).map((l) => /\(?([^\s()]+:\d+):\d+\)?$/.exec(l.trim())?.[1]).find(Boolean) ?? '';
    const file = (where.split('/').pop() ?? '').replace(/[^\w.:-]/g, '');
    const dir = join(trailHomeFast(env), 'state');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'hook-errors.log');
    // Non-blocking, and only into a regular file: a FIFO planted here would hold PreToolUse (D100 18).
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    const fd = fs.openSync(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | (O_NONBLOCK ?? 0), 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) return;
      fs.writeSync(fd, `${new Date().toISOString()} pre-bash ${err.name.replace(/[^\w]/g, '').slice(0, 40)}${file ? ` ${file}` : ''}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* the log is best effort; skills-hook-util cuts it to 100 KB on its next write */
  }
}

/** The session id as payloadSessionId reads it; gate-file.ts turns it into a file name the same way. */
function rawSessionId(input: any): string | null {
  const p = input && typeof input === 'object' ? input : {};
  const id = [p.session_id, p.sessionId, p.conversation_id].find((v) => typeof v === 'string' && v !== '');
  return typeof id === 'string' ? id : null;
}

/** trailNow without the settings module: TRAIL_TEST_NOW only in a test home (0 rule 10). */
function nowOf(env: NodeJS.ProcessEnv): Date {
  const fixed = env.TRAIL_TEST_NOW;
  if (fixed && isTestHome(env)) {
    const d = new Date(fixed);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/**
 * Claude Code's own prompt reaches the person (D17): an interactive entrypoint (headless is decided by
 * CLAUDE_CODE_ENTRYPOINT, as skillsGate decides it, D16, unless the lab's switch, D26), a permission mode the host
 * asks in, and Claude Code itself.
 */
export function canAskHere(input: any, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = detectHost(input).host;
  const ep = env.CLAUDE_CODE_ENTRYPOINT;
  const script = (typeof ep === 'string' && ep.startsWith('sdk')) || (!ep && host === 'claude');
  if (script && !labInteractive(env)) return false;
  const mode = typeof input?.permission_mode === 'string' ? input.permission_mode : '';
  return host === 'claude' && hostFacts(env, host).askModes.includes(mode);
}

interface Hit { live: GateFile['live'][number]; gi: number; group: GateGroup; step: GateGroup['steps'][number] }

/**
 * The gated step this command runs: newest live block first, each group, each step. First by the step's own
 * text (at the start of the command or after `&&` / `;`); then by what the command does, for each simple
 * command in it (`true || npm publish x`, `echo y | npm publish x`), against a step of the same kind and program.
 */
function findStep(gate: GateFile, cmd: string): Hit | null {
  const live = [...gate.live].reverse();
  if (cmd.length > SPLIT_MAX) {
    // Too long to split piece by piece inside the hook's 5 s: any gated pattern anywhere in it is that group's ask (errs safe).
    const kinds = gatedAnywhere(cmd);
    for (const l of live) for (const [gi, group] of l.groups.entries()) if (kinds.has(group.kind) && group.steps[0]) return { live: l, gi, group, step: group.steps[0] };
    return null;
  }
  for (const l of live) {
    for (const [gi, group] of l.groups.entries()) {
      for (const step of group.steps) if (stepMatches(step.text, cmd, l.params)) return { live: l, gi, group, step };
    }
  }
  const simple = simpleCommands(cmd).map((s) => ({ kind: gatedKind(s), program: programOf(s) })).filter((s) => s.kind !== null);
  if (!simple.length) return null;
  for (const l of live) {
    for (const [gi, group] of l.groups.entries()) {
      for (const step of group.steps) {
        if (simple.some((s) => s.kind === group.kind && s.program === step.program)) return { live: l, gi, group, step };
      }
    }
  }
  return null;
}

/** A name or command as one line of the reason: spaces collapsed, cut. */
function oneLine(text: string, max: number): string {
  const t = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * For the person's own prompt (Claude Code shows them the reason): `step 5`, `steps 5 and 6; your yes here is for
 * both`, `steps 4, 5 and 6; your yes here is for all 3`. The agent's words never say what a yes covers (D101).
 */
function stepWords(group: GateGroup): string {
  const ns = group.steps.map((s) => s.n);
  if (ns.length === 1) return `step ${ns[0]}`;
  const list = `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
  return `steps ${list}; your yes here is for ${ns.length === 2 ? 'both' : `all ${ns.length}`}`;
}

/**
 * The command is that step exactly, its params filled as the block showed them: a yes covers what the person was
 * told, never more (`git push origin beta --force`). A step with a param the block left blank is never covered.
 */
function sameStep(cmd: string, step: string, params: Record<string, string>): boolean {
  let plain = true;
  const filled = step.replace(/\{([A-Za-z_]\w*)\}/g, (m, k: string) => {
    const v = params[k];
    if (typeof v !== 'string') return m;
    // A value is a version, a sha, a branch: one that carries more shell (`x && npm publish y`, `$(…)`) was never what the person saw asked.
    if (!PLAIN_VALUE.test(v)) plain = false;
    return v;
  });
  return plain && !/\{[A-Za-z_]\w*\}/.test(filled) && normalizeCommand(cmd) === normalizeCommand(filled);
}

/** recall.ts SAFE_VALUE: the shape a filled value must have for a yes to cover the step it is in. */
const PLAIN_VALUE = /^[A-Za-z0-9][A-Za-z0-9._@:+\/-]{0,99}$/;

/** 3.3 step 4. */
function gatedAsk(input: any, cmd: string, env: NodeJS.ProcessEnv): PreBashDecision | null {
  const sid = rawSessionId(input);
  if (!sid) return null;
  const gate = readGateFile(sid, env);
  if (!gate) return null;
  const hit = findStep(gate, cmd);
  if (!hit) return null;
  const { live, gi, group, step } = hit;
  const what = gatedWhat(group.kind, step.text, live.params);
  const name = oneLine(live.name, 80);
  if (!canAskHere(input, env)) {
    // D137: the step is handed to the person; credit counts it so, and their next ask of this job continues the run.
    try { markHanded(sid, live.injId, step.n, nowOf(env), env); } catch { /* the deny stands either way */ }
    return {
      permissionDecision: 'deny',
      // D101: who stopped it and why, and what to do instead; never a bare order.
      reason: `trail: ${TRAIL_WHO} stopped step ${step.n} of skill ${name}: it ${what} and can't be undone, and this session can't ask the person first. So don't run it, and don't try it again this turn, even after a yes in chat; ask the person to run this command in their own terminal: ${oneLine(cmd, SHOWN_MAX)}`,
    };
  }
  const now = nowOf(env);
  const since = group.approvedAt === null ? NaN : now.getTime() - Date.parse(group.approvedAt);
  // A yes from the last 30 minutes; one stamped after now (a clock that moved back, a file written by hand) covers nothing.
  const approved = since >= 0 && since <= APPROVED_MS;
  if (approved && typeof group.askedStep === 'number' && step.n > group.askedStep && sameStep(cmd, step.text, live.params)) return null;
  const toolUseId = typeof input?.tool_use_id === 'string' ? input.tool_use_id : '';
  markAsked(sid, live.injId, gi, toolUseId, now, env, step.n);
  return { permissionDecision: 'ask', reason: `trail: this ${what} and can't be undone (${name}, ${stepWords(group)}).` };
}
