import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readWiring } from './stats.js';
import { formatBlastRadius, formatOrientation, notesOnTouch, standingDirective, teamNotesDirective, type Touch } from './format.js';
import { commitLines, listNotes, setupCommitLine, standingLearnings } from '../notes/notes.js';
import { liveLearnings } from '../notes/learning-fields.js';
import { noteAuthor, teammatesOn } from '../notes/git-facts.js';
import { indexFreshness, staleBanner } from '../context/check.js';
import { dropStoredPrompts, patchStats, readSession, writeSession, resolveContextDir } from './state.js';
import { emit, emitHook, graftJson, payloadSessionId, withContextDirArg } from './hook-io.js';
import { codexPostBashPart, postBashPart, sessionStartPart } from './skills-wiring.js';
import { handlePrompt } from './prompt-hook.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion, wiredHostIds } from '../upkeep.js';
import { hostsWiredForTrail } from '../hosts/registry.js';
import { flushClosedSessions, summarizeSession } from '../telemetry/sessions.js';
import { maybeFlushInBackground } from '../telemetry/flush.js';
import { handleStopEvent } from './stop.js';
import { main as preBashMain } from './pre-bash.js';
import { classifyToolUse, commandInvokesGraft, isMcpToolName, isGraftMcpTool, parseSavings, recordToolUse, type ToolKind } from './session-metrics.js';
import { adoptRepoBrand, brand, commandOnPath, repoWiredForTrail, tag, trailHandoverLine, trailOnPath } from '../brand.js';
import { fitTrailServerToMachine } from '../hosts/claude-global.js';
import { globalCopyCovers } from './hook-layers.js';
import { keepsNotes, noteCounts, repoPlace, type NoteCounts } from '../notes/home.js';
import { branchesStale, overlapMark, readBranchCache, refreshBranches, SESSION_REFRESH_MS } from '../notes/branches.js';
import { learningFiles } from '../notes/repo-trail.js';
import { inWorkspace, maybeSyncInBackground } from '../cloud/workspace-sync.js';
import { hookNotice } from '../cloud/nudge.js';
import { cacheDir, readJson, writeJsonAtomic } from '../util/state.js';
import { countBucket, type AgentHost } from '../telemetry/contract.js';
import { detectHost } from '../trace/host.js';
import type { HookOut } from '../skills/types.js';
import { track } from '../telemetry/track.js';
import { skillsDirective } from '../skills/skills.js';
import { everyRepoLearnings } from '../notes/every-repo.js';
import type { Note } from '../notes/notes.js';
import { hostFacts } from '../skills/host-facts.js';
import { trailNow } from '../skills/settings.js';
import { recordSkillUse, skillOfToolUse } from './skill-use.js';
import { keptContext, keptNotice } from './start-init.js';
import { teamSignInLine } from '../cloud/team-file.js';
import { overlapsShown } from './overlap-telemetry.js';

export { lastFileScopeHint, promptAskTimeout } from './prompt-hook.js';

function readStdin(): any {
  const seam = process.env.GRAFT_TEST_STDIN;
  const raw = seam !== undefined ? seam : safeReadFd0();
  try {
    const input = JSON.parse(raw);
    return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  } catch { return {}; }
}
function safeReadFd0(): string { try { return readFileSync(0, 'utf8'); } catch { return ''; } }

function projectDir(input: any): string {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}
export function underGraft(dir: string, file: string): boolean {
  const rel = file.startsWith(dir) ? file.slice(dir.length) : file;
  const posix = rel.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return posix.startsWith('graft/') || posix.startsWith('.trail/cache/');
}
function checkStaleCount(dir: string): number {
  const r = graftJson(dir, withContextDirArg(dir, ['check', '.', '--json']));
  const g = r?.graph ?? {};
  return (g.changed?.length ?? 0) + (g.added?.length ?? 0) + (g.removed?.length ?? 0);
}
/**
 * The absolute path of the file a PostToolUse edit touched, across host edit-tool
 * shapes:
 *   - Claude Code (`Write`/`Edit`/`MultiEdit`) states it directly as
 *     `tool_input.file_path` (already absolute).
 *   - Codex (`apply_patch`) carries the whole patch in `tool_input.command` and
 *     names the file in the patch header (`*** Add File:` / `*** Update File:`),
 *     as a repo-relative path — resolved against `dir` here. Take the first
 *     Add/Update target; that one file is enough to mark the graph dirty and
 *     draw a blast radius (the sync re-checks the whole tree anyway).
 * Returns null when neither shape yields a path, so the hook stays a clean no-op.
 */
export function editedFilePath(input: any, dir: string): string | null {
  const direct = input?.tool_input?.file_path;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const cmd = input?.tool_input?.command;
  if (typeof cmd === 'string' && cmd) {
    const m = /^\*\*\*\s+(?:Add|Update)\s+File:\s+(.+?)\s*$/m.exec(cmd);
    if (m) return isAbsolute(m[1]) ? m[1] : join(dir, m[1]);
  }
  return null;
}

async function handlePostEdit(input: any, dir: string): Promise<void> {
  const file = editedFilePath(input, dir);
  if (!file || underGraft(dir, file)) return;
  patchStats(dir, { dirty: true, staleCount: checkStaleCount(dir), lastFile: basename(file) });
  const out: string[] = [];
  const w = readWiring(dir);
  if (w) { const br = formatBlastRadius(w, file); if (br) out.push(br); }
  const overlap = await editOverlap(input, dir, file);
  if (overlap) out.push(overlap);
  const learned = learningsOnTouch(input, dir);
  if (learned) out.push(learned);
  // One hook, one answer: two JSON objects on stdout would be read as neither.
  if (out.length) emit('PostToolUse', out.join('\n\n'));
}

/** Branch-and-function pairs remembered per session, so each is said once. */
const INJECTED_OVERLAPS_CAP = 40;

/**
 * Under trail, a teammate's open branch that changes the function this edit
 * just changed, for the agent to read and tell the person about, each branch
 * and function once a session. Parsing loads grammars, so it's imported only
 * when the edited file is one some branch changes. Never throws.
 */
async function editOverlap(input: any, dir: string, file: string): Promise<string | null> {
  if (brand() !== 'trail' || !keepsNotes(dir)) return null;
  try {
    const top = repoPlace(dir);
    if (!top.git) return null;
    const { functionOverlaps, editOverlapDirective } = await import('../notes/edit-overlap.js');
    const cache = readBranchCache(top.checkout);
    const found = await functionOverlaps(top.checkout, resolve(dir, file), input?.tool_input, noteAuthor(top.checkout), cache);
    if (!found.length) return null;
    const id = payloadSessionId(input);
    const s = readSession(dir, id);
    const seen = new Set(s.injectedOverlaps ?? []);
    const fresh = found.filter((o) => o.symbols.some((x) => !seen.has(`${o.ref} ${x.id}`)));
    if (!fresh.length) return null;
    s.injectedOverlaps = [...seen, ...fresh.flatMap((o) => o.symbols.map((x) => `${o.ref} ${x.id}`))].slice(-INJECTED_OVERLAPS_CAP);
    overlapsShown(s, fresh.slice(0, 2), cache);
    writeSession(dir, id, s);
    const base = cache?.base ?? 'origin/main';
    return fresh.slice(0, 2).map((o) => editOverlapDirective(o, base, tag(), overlapMark())).join('\n\n');
  } catch {
    return null;
  }
}

/**
 * PostToolUse on a retrieval tool. Two jobs, both a pure parse of the payload the
 * hook already received (no re-run):
 *
 *   1. Score the usage mix: classify the tool as a graft retrieval or a source
 *      read (Read/Grep/Glob) and bump the session's `graftReads`/`sourceReads`.
 *      Until this ran, those counters were never incremented, so
 *      `session_summary` telemetry shipped 0/0 for every session.
 *   2. Sum any `[graft] tokens saved ≈ N` footers in the output into the running
 *      `savedTokens` total, so the statusline's `~N tok saved` reflects the
 *      session across CLI and MCP.
 *
 * A `[graft]` footer is itself proof graft ran, so it also counts as a graft
 * read even when the tool name alone (a bare `Bash`) couldn't say so. A graft use
 * also flags the turn (`turnUsedGraft`) so the Stop hook's tally can resolve
 * whether the reply told the user what it saved. Stays a no-op on the
 * Write/Edit/unrelated-Bash majority: nothing to classify and no footer means
 * nothing is written.
 */
function handleToolUse(input: any, dir: string): void {
  recordToolUse(dir, payloadSessionId(input),
    { ...classifyAndScore(input?.tool_name, input?.tool_input?.command, () => input?.tool_response ?? input), host: telemetryHost(input) });
}

/**
 * Under trail, the learnings about the file a Read, Edit or Write just touched,
 * or that a shell command (`sed -n 1,40p src/a.ts`, `cat`, a test run) names,
 * each once a session. A trail command is skipped: its own output already
 * carries the learnings that bear on it. Never throws.
 */
export function learningsOnTouch(input: any, dir: string, before = false): string | null {
  try {
    if (brand() !== 'trail' || !keepsNotes(dir)) return null;
    const ti = input?.tool_input ?? {};
    const path = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.notebook_path === 'string' ? ti.notebook_path : null;
    let touch: Touch;
    if (path) {
      const rel = relative(dir, isAbsolute(path) ? path : join(dir, path)).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..') || underGraft(dir, path)) return null;
      touch = { file: rel, verb: before ? 'editing' : input?.tool_name === 'Read' ? 'opened' : 'changed' };
    } else if (typeof ti.command === 'string' && ti.command && !commandInvokesGraft(ti.command)) {
      touch = { command: ti.command };
    } else return null;
    const notes = liveLearnings(listNotes(dir, { branches: false }));
    if (!notes.length) return null;
    const id = payloadSessionId(input);
    const s = readSession(dir, id);
    const text = notesOnTouch(notes, touch, s);
    if (text) writeSession(dir, id, s);
    return text;
  } catch {
    // A learning that doesn't arrive costs one reminder; a broken hook costs the turn.
    return null;
  }
}

/**
 * PreToolUse on Write and Edit: the learnings on the file, before the agent
 * changes it, while they can still change the edit. They're marked shown, so
 * the PostToolUse after the edit doesn't repeat them. A teammate's learning
 * just reached the agent, which is when the person gets the workspace link.
 */
export function handlePreEdit(input: any, dir: string): void {
  const learned = learningsOnTouch(input, dir, true);
  if (!learned) return;
  const notice = hookNotice(dir, "Claude just got your team's learnings on the file it's changing", { session: payloadSessionId(input) }) ?? undefined;
  emitHook('PreToolUse', { context: learned, notice });
}

/**
 * PostToolUse's one answer: the skills part's, with the learnings about what
 * the call touched added to its context. Two JSON objects on stdout would be
 * read as neither. A block is the whole answer, so then no learning is used up.
 */
export function withTouchLearnings(out: HookOut, input: any, dir: string): HookOut {
  if (out.block) return out;
  const learned = learningsOnTouch(input, dir);
  if (!learned) return out;
  return { ...out, context: [out.context, learned].filter(Boolean).join('\n\n') };
}

/** Who to put a tool use down to: Cursor and Copilot CLI run these hooks too. */
function telemetryHost(input: unknown): AgentHost {
  const host = detectHost(input).host;
  return host === 'cursor' || host === 'copilot' ? host : 'claude-code';
}

/**
 * Classify a tool use and, only when it could carry a graft footer, parse the
 * savings out of its (lazily-serialised) output.
 *
 * Source reads (Read/Grep/Glob) never print a `[graft]` footer, and their output
 * is a whole file or every match — serialising and regexing that on every read
 * is the expensive, pointless case the widened PostToolUse matcher would
 * otherwise hit. So skip `payload()` entirely for them. For anything else, a
 * footer is itself proof graft ran (a bare `Bash graft …` the name couldn't
 * classify), so its presence upgrades the kind to 'graft'.
 */
function classifyAndScore(
  toolName: string | undefined,
  command: string | undefined,
  payload: () => unknown,
): { kind: ToolKind | null; savedTokens: number } {
  let kind = classifyToolUse(toolName, command);
  if (kind === 'source') return { kind, savedTokens: 0 };
  const savedTokens = parseSavings(JSON.stringify(payload() ?? ''));
  if (savedTokens > 0) kind = 'graft';
  return { kind, savedTokens };
}

/**
 * Cursor `postToolUse` (https://cursor.com/docs/hooks). Same job as
 * {@link handleToolUse} but over Cursor's payload shape: `tool_output` holds the
 * JSON-stringified result (a Shell `graft …` call's footer lives in its stdout),
 * and the session key is `conversation_id`. MCP graft calls are skipped here —
 * `afterMCPExecution` owns them, and counting both would double the graft tally.
 * The skip covers both the prefixed (`MCP:graft_find_code`) and bare
 * (`graft_find_code`) tool-name shapes, so the guard — not just the installed
 * matcher — is what prevents the double count.
 */
function handleCursorPostTool(input: any, dir: string): void {
  const toolName = String(input?.tool_name ?? '');
  if (isMcpToolName(toolName) || isGraftMcpTool(toolName)) return; // handled by handleCursorMcp
  const command = input?.tool_input?.command ?? input?.tool_input?.cmd;
  recordToolUse(dir, cursorSessionId(input),
    { ...classifyAndScore(toolName, command, () => input?.tool_output ?? input?.tool_response ?? input), host: 'cursor' });
}

/**
 * Cursor `afterMCPExecution`: fires only for MCP tools, so a graft tool is
 * recognised by its name and its savings read out of `result_json`. This is the
 * one place graft MCP calls are counted for Cursor.
 */
function handleCursorMcp(input: any, dir: string): void {
  const toolName = String(input?.tool_name ?? '');
  if (!isGraftMcpTool(toolName)) return;
  const savedTokens = parseSavings(JSON.stringify(input?.result_json ?? input?.result ?? input ?? ''));
  recordToolUse(dir, cursorSessionId(input), { kind: 'graft', savedTokens, host: 'cursor' });
}

/** Cursor keys a chat by `conversation_id` (its `session_id` equivalent). */
function cursorSessionId(input: any): string {
  return payloadSessionId({ session_id: input?.conversation_id || input?.session_id });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Once a day per repo, the `repo_seen` event: whether `.trail/` is committed
 * here, how many learnings it holds, and whether this machine shares the repo
 * with a workspace. Queued only, like every hook's telemetry.
 */
export function trackRepoSeen(dir: string, now = Date.now()): void {
  try {
    const place = repoPlace(dir);
    if (!place.git) return;
    const mark = join(cacheDir(place.checkout), 'trail-repo-seen.json');
    if (now - (readJson<{ at?: number }>(mark)?.at ?? 0) < DAY_MS) return;
    writeJsonAtomic(mark, { at: now }, true);
    const tracked = execFileSync('git', ['ls-files', '--', '.trail'], { cwd: place.checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true });
    track(
      'repo_seen',
      { trail_committed: String(tracked.trim().length > 0), learnings_bucket: countBucket(learningFiles(place.checkout).length), workspace: String(inWorkspace(place.checkout)) },
      { repo: place.checkout },
    );
  } catch {
    // A missed sighting undercounts one repo for one day.
  }
}

/**
 * When the learnings committed on this checkout's HEAD went up since the last
 * session here: how many came in and how many there are, as buckets. A repo
 * with committed learnings is where trail starts paying off, so this is the
 * activation count. `first_look` marks the first time this clone is seen, so
 * a clone of a repo that already had them isn't counted as new ones.
 */
export function trackLearningsCommitted(dir: string): void {
  try {
    const place = repoPlace(dir);
    if (!place.git) return;
    const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.trail/learnings'], {
      cwd: place.checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true,
    });
    const count = listed.split('\n').filter((f) => f.endsWith('.md')).length;
    const mark = join(cacheDir(place.checkout), 'trail-learnings-committed.json');
    const before = readJson<{ count?: number }>(mark)?.count;
    if (before === count) return;
    writeJsonAtomic(mark, { count }, true);
    if (count <= (before ?? 0)) return;
    track(
      'learnings_committed',
      { added_bucket: countBucket(count - (before ?? 0)), total_bucket: countBucket(count), first_look: String(before === undefined) },
      { repo: place.checkout },
    );
  } catch {
    // Not a repo with a HEAD yet, or git is slow: counted next session.
  }
}

/**
 * Learnings added to this repo but sitting uncommitted in `.trail/learnings/` (from trail init's
 * read of past sessions, or a session that ended before committing) reach no
 * teammate. Once a day per repo, the first reply says so, with the line that
 * makes the case for committing them. Empty when everything is committed.
 */
export function uncommittedDirective(dir: string, now = Date.now()): string {
  try {
    const place = repoPlace(dir);
    if (!place.git) return '';
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.trail/learnings'], {
      cwd: place.checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true,
    });
    const n = status.split('\n').filter((l) => l.trimEnd().endsWith('.md')).length;
    const setup = setupUncommitted(place.checkout);
    if (!n && !setup) return '';
    const mark = join(cacheDir(place.checkout), 'trail-uncommitted-said.json');
    if (now - (readJson<{ at?: number }>(mark)?.at ?? 0) < DAY_MS) return '';
    writeJsonAtomic(mark, { at: now }, true);
    if (setup) {
      const line = setupCommitLine(teammatesOn(place.checkout));
      return `${tag()} trail's shared setup here (.trail/ and .claude/settings.json) isn't committed yet, so teammates' Claude can't read the learnings. Say so once, at the end of your first reply, with this line, word for word: ${line}\n`;
    }
    const line = commitLines({}, teammatesOn(place.checkout), 'repo').uncommitted;
    const them = n === 1 ? "learning added to this repo (in .trail/learnings/) isn't committed yet, so no teammate's agent has it" : "learnings added to this repo (in .trail/learnings/) aren't committed yet, so no teammate's agent has them";
    return `${tag()} ${n} ${them}. Say so once, at the end of your first reply, with this line, word for word: ${line}\n`;
  } catch {
    return '';
  }
}

/**
 * trail's shared setup isn't in the last commit: `.trail/hook.cjs` isn't
 * tracked, or HEAD's `.claude/settings.json` doesn't run it. Only checked
 * where the hook is on disk, so a repo still set up the old way says nothing.
 */
export function setupUncommitted(checkout: string): boolean {
  if (!existsSync(join(checkout, '.trail', 'hook.cjs'))) return false;
  const git = (args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true });
  try {
    git(['ls-files', '--error-unmatch', '--', '.trail/hook.cjs']);
  } catch {
    return true;
  }
  try {
    return !git(['show', 'HEAD:.claude/settings.json']).includes('/.trail/hook.cjs');
  } catch {
    return true;
  }
}

/** The most the session-start hook waits on `git fetch` for teammates' branches. */
export const BRANCH_FETCH_CAP_MS = 3000;

/**
 * At session start, under trail: read what teammates have pushed, so the
 * session's first prompt already knows their learnings and where their work
 * overlaps; send any learnings and uses the workspace hasn't seen; and count
 * the repo once a day. The fetch is the one wait, capped at
 * BRANCH_FETCH_CAP_MS and skipped when the branches were read in the last
 * minute; a fetch that runs out of time still reads the branches already here.
 * The sync only spawns a detached child.
 */
function trailAtStart(dir: string): void {
  if (brand() !== 'trail' || !keepsNotes(dir)) return;
  try {
    const top = repoPlace(dir);
    if (top.git && branchesStale(top.checkout, Date.now(), SESSION_REFRESH_MS)) refreshBranches(top.checkout, { fetchTimeoutMs: BRANCH_FETCH_CAP_MS });
  } catch {
    // Without it, the first prompt sees what the last refresh saw.
  }
  maybeSyncInBackground(dir);
  trackRepoSeen(dir);
  trackLearningsCommitted(dir);
}

/** What the session-start text says about learnings, read once. */
interface StartLearnings {
  /** This repo keeps learnings on this machine. */
  kept: boolean;
  count: number | NoteCounts;
  /** The skills line, plus under trail the standing learnings and the uncommitted line. */
  extra: string;
}

/**
 * The learnings part of the session-start text. It needs nothing from
 * `graft/`: the learnings are their own files. Empty on any read failure,
 * which costs the session its learnings, never its start.
 */
function learningsAtStart(dir: string): StartLearnings {
  // 1b (P21, J16): every-repo personal learnings load in every repo, a plain one too, skills on or off; never a
  // lesson (R47: everyRepoLearnings leaves them out). Shown as standing learnings, phase 0's framing.
  let every: Note[] = [];
  try { every = everyRepoLearnings(); } catch { /* none this time */ }
  try {
    if (!keepsNotes(dir)) return { kept: false, count: 0, extra: standingDirective(every) };
    const skills = skillsDirective(dir);
    const standing = brand() === 'trail' ? standingDirective(withEvery(standingLearnings(dir), every)) + uncommittedDirective(dir) : standingDirective(every);
    return { kept: true, count: noteCounts(dir), extra: skills + standing };
  } catch {
    return { kept: false, count: 0, extra: standingDirective(every) };
  }
}

/** This repo's standing learnings, then the every-repo ones not already among them (by id). */
function withEvery(here: Note[], every: Note[]): Note[] {
  const ids = new Set(here.map((n) => n.id).filter(Boolean));
  return [...here, ...every.filter((n) => !n.id || !ids.has(n.id))];
}

/**
 * D87: what the person kept on `trail init`'s screen, named once at the next interactive startup or resume in that
 * repo with its undo. Skills on or off. A notice where the host shows one, else context from Trail.
 */
function keptAtStart(input: any, dir: string): { notice?: string; context?: string } {
  try {
    const source = typeof input?.source === 'string' && input.source ? input.source : 'startup';
    if (source !== 'startup' && source !== 'resume') return {};
    if (typeof input?.agent_id === 'string' && input.agent_id) return {};
    if (String(process.env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk')) return {};
    const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : dir;
    const line = keptNotice(repoPlace(cwd).key, process.env, trailNow(process.env));
    if (!line) return {};
    return hostFacts(process.env, detectHost(input).host).startNotice ? { notice: line } : { context: keptContext(line) };
  } catch {
    return {};
  }
}

/**
 * The session-start text: the orientation from `graft/INDEX.md` with the
 * learnings in it, or, where INDEX.md is missing (never built here; `graft/` is
 * git-ignored, so a teammate's fresh clone has none), the learnings alone.
 */
function orientationAtStart(dir: string, learnings: StartLearnings): string {
  try {
    const idx = readFileSync(join(resolveContextDir(dir), 'INDEX.md'), 'utf8');
    const banner = staleBanner(indexFreshness(dir)) ?? undefined;
    // Where the map is: `.trail/cache/` in a repo on trail, `graft/` elsewhere (context/map-dir.ts).
    const mapDir = relative(dir, resolveContextDir(dir)).split('\\').join('/') || 'graft';
    return formatOrientation(idx, undefined, banner, learnings.count, learnings.kept, learnings.extra, mapDir);
  } catch {
    return learnings.kept ? `${tag()} ${teamNotesDirective(learnings.count, true)}${learnings.extra}` : learnings.extra;
  }
}

/** The repo's committed `.mcp.json` still registers trail's server (set up before 0.23). */
function repoNamesTrailServer(dir: string): boolean {
  try {
    return Boolean(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))?.mcpServers?.trail);
  } catch {
    return false;
  }
}

export async function main(event: string): Promise<void> {
  // Shims before pre-bash.js existed send PreToolUse here: hand it straight
  // over, before any of the work the other events share.
  if (event === 'pre-bash') { await preBashMain(event); return; }
  // trail's own headless Claude calls (the first-run read of past sessions) run with this set.
  if (process.env.TRAIL_NO_HOOKS === '1') return;
  const input = readStdin();
  // Registered in the repo and in ~/.claude, Claude Code runs both: one answers.
  // Who sent the payload decides first: Copilot CLI runs only the repo's copy.
  if (globalCopyCovers(event, process.argv[1], homedir(), process.env, input)) return;
  const dir = projectDir(input);
  // A failed Bash call (PostToolUseFailure, D34): the skills mark, and 1b's wall fix as its one answer, before any of
  // the work the other events share.
  if (event === 'post-bash-fail') { emitHook('PostToolUseFailure', await postBashPart(input, dir, true)); return; }
  // Codex's PostToolUse on Bash, on every exit (3.4): the skills mark, and the wall fix where its context reaches the model.
  if (event === 'codex-post-bash') { emitHook('PostToolUse', await codexPostBashPart(input, dir)); return; }
  adoptRepoBrand(dir, process.env, hostsWiredForTrail);

  if (event === 'session-start') {
    // The skills part first, so nothing below can skip it (a repo with no graft/INDEX.md included).
    const skills = await sessionStartPart(input, dir);
    // Before anything is emitted: refresh this repo's wiring if it was written by
    // an older graft, and pick up any cached "newer version on npm" answer.
    // background:false — the registry check stays off the network here; the CLI
    // and the MCP server fill that cache, this only reads it.
    const upkeep = runUpkeep(dir, runningVersion(), { background: false }).lines;
    // On graft without trail, in a repo graft set up: once a week, the agent
    // tells the person how to get it.
    const handover = wiredHostIds(dir).includes('claude') ? trailHandoverLine() : null;
    if (handover) upkeep.push(handover);
    // Roll up any session that ended since we were last here, then send the
    // queue from a detached child: what session end didn't get to (a killed
    // terminal never fires it) goes now. Once a day at most, never waited on.
    flushClosedSessions(dir);
    maybeFlushInBackground();
    // Once per repo: older versions kept the prompt in each session file.
    try { dropStoredPrompts(dir); } catch { /* tried again next session */ }
    trailAtStart(dir);
    // A repo on trail, opened on a machine that has graft but not the trail command.
    // Only while its .mcp.json still names a trail server: once it doesn't, trail: true takes back the stand-in.
    if (repoWiredForTrail(dir)) fitTrailServerToMachine(homedir(), resolve(dir), { trail: trailOnPath() || !repoNamesTrailServer(dir), graft: commandOnPath('graft') });
    const text = orientationAtStart(dir, learningsAtStart(dir));
    const kept = keptAtStart(input, dir);
    // The skills context comes after the learnings; its notice is for the person.
    // A repo whose team uses a Trail workspace, on a laptop not signed in to it: offered once a session.
    const team = teamSignInLine(dir);
    const out = [upkeep.join('\n'), text, team, skills.context, kept.context].filter(Boolean).join('\n\n');
    const notice = [skills.notice, kept.notice].filter(Boolean).join('\n') || undefined;
    emitHook('SessionStart', { context: out, notice });
    return;
  }

  // Claude closing: send the queue from a detached child, so quitting isn't slowed.
  if (event === 'session-end') { maybeFlushInBackground(); return; }

  if (event === 'pre-edit') { handlePreEdit(input, dir); return; }

  if (event === 'post-edit') { await handlePostEdit(input, dir); return; }

  if (event === 'tool-savings') {
    handleToolUse(input, dir);
    recordSkillUse(skillOfToolUse(input), input, dir);
    // PostToolUse on Bash: the skills mark, and the post-tool offer channel's context (3.4),
    // then the learnings about the file the call touched, in the same one answer.
    emitHook('PostToolUse', withTouchLearnings(await postBashPart(input, dir, false), input, dir));
    return;
  }

  if (event === 'cursor-post-tool') { handleCursorPostTool(input, dir); return; }

  if (event === 'cursor-mcp') { handleCursorMcp(input, dir); return; }

  // Cursor closes a chat: force-close THIS conversation into a bucketed
  // `session_summary` now (its file's mtime is fresh, so the idle sweep would
  // skip it). Attributed to Cursor. The idle sweep stays on Claude's
  // session-start, whose Stop fires per turn and so has no real end signal.
  if (event === 'cursor-session-end') { summarizeSession(dir, cursorSessionId(input), { host: 'cursor' }); return; }

  if (event === 'stop') { await handleStopEvent(input, dir); return; }

  // An edit's payload, not a Stop's: the turn-end bookkeeping only, so its one answer stays the edit's.
  if (event === 'post-edit-sync') { await handlePostEdit(input, dir); await handleStopEvent(input, dir, { skills: false }); return; }

  if (event === 'prompt') { await handlePrompt(input, dir); return; }
}
