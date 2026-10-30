/**
 * When the Stop hook asks for a learning: on a sign in the transcript that the
 * session found something the code won't tell the next person, not on a count
 * of tool calls. A count fired on the first busy turn of a session, which is
 * usually setting things up, and the learnings it got were about that.
 *
 * The signs, best first:
 * - `fixed`: a test or build command failed, then passed after an edit;
 * - `corrected`: the person corrected the agent ("no, …", "we use …"), and the
 *   agent went on to change code;
 * - `undone`: an edit was undone (`git restore`, `git revert`, …);
 * - `chose`: the person picked one of the options the agent offered, and the
 *   agent went on to change code;
 * - `overrode`: `trail check` found the change goes against a learning, and
 *   the work shipped anyway with the files it named left as they were;
 * - `shipped`: `git commit`, `git push` or `gh pr create` after code edits;
 * - `explored`: one turn took NOTE_WORTHY_READING tokens of reading to answer,
 *   with no edit needed: where a feature lives, why a bug happens.
 *
 * Only what happened since the session's last saved learning counts, so each
 * learning starts the count over. Work on trail's own files (`.trail/`,
 * `.claude/`, AGENTS.md …) is never a sign: that's setup, not the repo's code.
 *
 * Pure, for tests: `noteSignals` takes the transcript's JSONL.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { trailOwnPath } from '../notes/git-facts.js';
import { NOTE_CALL } from '../notes/session-cost.js';
import { typedText } from '../trace/claude.js';

export type NoteSignalKind = 'fixed' | 'corrected' | 'undone' | 'chose' | 'overrode' | 'shipped' | 'explored';

export interface NoteSignal {
  kind: NoteSignalKind;
  /** What raised it (its transcript entry), so one sign is asked about once. */
  key: string;
  /** What happened, in the session's own terms: the first line of the ask. */
  what: string;
}

/** Most times the Stop hook asks for a learning in one session. */
export const NOTE_ASKS_PER_SESSION = 3;

/**
 * Reading in one turn, in tokens, before it counts as digging worth a learning:
 * what trail's answers stood in for, plus the repo files and search results the
 * agent read itself. trail answers most questions in one or two calls, so
 * finding where something lives never needed an edit to be worth saving.
 */
export const NOTE_WORTHY_READING = 30_000;

/** The reading a trail answer stood in for, from its `[trail] tokens saved ≈ N` line. A reused learning's own line doesn't count: that digging was done before. */
const TRAIL_SAVED = /\[(?:graft|trail)\] tokens saved ≈ ([\d,]+)/g;
/** Claude Code's tools that read the repo. */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/** Claude Code's tools that change a file. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * A shell command that writes files: an in-place `sed`/`perl`, a redirect or
 * `tee` into a file, a patch, or a script that opens one for writing. Agents
 * often edit this way (a `python3 - <<EOF` that rewrites a file), and a fix
 * made so is still a fix.
 */
const BASH_WRITE =
  /\bsed\s+(?:-[a-zA-Z]+\s+)*-i|\bperl\s+-[a-z]*i|\btee\s|(?:^|[^>&0-9])>>?\s*[\w./~-]+\.\w+|\bgit\s+apply\b|\bapply_patch\b|\bopen\([^)]*,\s*['"][wa]|\.write_text\(|\bwriteFileSync\(/m;
const CODE_EXT = '(?:go|tsx?|jsx?|mjs|cjs|py|rb|rs|java|kt|swift|cs|php|c|h|cc|cpp|hpp|scala|sql|ya?ml|json|toml|sh|css|scss|vue|svelte)';
/**
 * File names in a command, by their extension. On Windows a path also has a drive and backslashes
 * (`C:\Users\me\shop\src\client.ts`, or `C:/Users/...` in Git Bash): without them only `client.ts`, or a
 * path on the wrong drive, would be read.
 */
export function fileWordRe(platform: NodeJS.Platform = process.platform): RegExp {
  return platform === 'win32' ? new RegExp(`(?:\\b[A-Za-z]:)?[\\w./\\\\~-]+\\.${CODE_EXT}\\b`, 'g') : new RegExp(`[\\w./-]+\\.${CODE_EXT}\\b`, 'g');
}
const FILE_WORD = fileWordRe();
/** `cd <dir> &&` at the start of a command: where its relative paths start. */
const LEADING_CD = /^\s*cd\s+(["']?)([^"'&;|]+?)\1\s*(?:&&|;)/;
/** A file a command names by its full path, of any kind: `/tmp/pr-body.md`, `~/.claude/…/MEMORY.md`. */
const FULL_PATH = /(?:^|[\s='"(])((?:~|\/)[^\s'"();&|<>$]*\.[A-Za-z]\w*)(?=$|[\s'"();&|<>])/g;
const home = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

/**
 * A test, build or type check, as typed: `npm test`, `go test`, `pytest`,
 * `npx tsc`, `make`; or a deploy or CI step that can fail the same way:
 * `docker build`, `kubectl apply`, `terraform plan`, `helm upgrade`. A folder
 * flag before the verb counts too (`go -C backend test`, `npm --prefix web test`).
 * The match is the command's name for itself, so two runs of `go test` with
 * different flags are the same check.
 */
const CHECK =
  /(?:^|[;&|(]\s*|\s)((?:npx\s+|bunx\s+|pnpm\s+exec\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:(?:--prefix|--cwd|--dir|-C)[=\s]\S+\s+)?(?:run\s+)?(?:test|build|lint|typecheck|check)(?::[\w-]+)?|go\s+(?:-C[=\s]\S+\s+)?(?:test|build|vet)|cargo\s+(?:test|build|check|clippy)|python3?\s+-m\s+(?:pytest|unittest)|pytest|tsc|jest|vitest|mocha|rspec|node\s+--test|deno\s+test|swift\s+(?:test|build)|dotnet\s+(?:test|build)|mix\s+test|mvn\s+[\w:-]*(?:test|verify|package)|\.?\/?gradlew?\s+[\w:-]*(?:test|build)|make(?:\s+(?!-)[\w-]+)?|eslint|ruff|golangci-lint|docker\s+(?:build|compose\s+(?:up|build))|kubectl\s+(?:apply|rollout\s+status)|terraform\s+(?:plan|apply|validate)|helm\s+(?:install|upgrade|lint|template)))(?=$|[\s;&|)])/;

/** Output that says a check failed even when a pipe (`| tail`) hid its exit code. */
const FAILED_OUTPUT =
  /\b\d+ (?:failed|failing)\b|^FAIL\b|\bFAILED\b|^# fail [1-9]|\bpanic:|Traceback \(most recent|\berror TS\d+|npm ERR!|\bBUILD FAILED\b|\bcompilation failed\b|^error(?:\[E\d+\])?:/m;
const ZERO_FAILED = /\b0 (?:failed|failing)\b|^# fail 0\b/m;

const UNDO = /\bgit\s+(?:restore|revert|reset\s+--hard|checkout\s+(?:\S+\s+)?--\s)/;
const SHIP = /\b(git\s+commit|git\s+push|gh\s+pr\s+create)\b/;
/** `trail check` saying the change goes against a learning: its own exit 1, or the reason pre-bash-check.ts stops a commit with. */
const TRAIL_CHECK = /(?:^|[\s;&|])(?:trail|graft)\s+check\b/;
const CHECK_STOP = /^trail check found \d+ conflicts?\b/m;
/** The files a conflict names: `- path:line: …` in the stop's reason, `✗ path:line` in the check's own output. */
const CONFLICT_FILE = /^(?:- |✗ )([^\s:]+)(?::\d+)?:?/gm;
/** Commands that set tools up rather than work on the repo. */
const SETUP = /(?:^|[\s;&|])(?:trail|graft|npx\s+(?:-y\s+)?@(?:trailhq|nanonets)\/[\w-]+)\s|(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|uninstall)\b|\bbrew\s+install\b|\bpip3?\s+install\b/;

/** The person correcting the agent: at the start of their message, or a rule stated in it. */
const CORRECTION_LEAD = /^\s*(?:no|nope|nah|na|wrong|actually|don't|dont|do not|never|stop|not (?:that|this|like that|quite)|that's (?:not|wrong)|that is (?:not|wrong))\b[\s,.!:;-]/i;
/** "need not go to repo", "keep it out of the repo", "not in the repo" (not when asked as a question). */
const CORRECTION_RULE =
  /\b(?:instead of|instead,|use \S+ instead|we (?:always |usually |never )?(?:use|do|don't|keep|put|run)\b|not like that|that's not how|should(?:n't| not) (?:be|use|go)|need(?:n't| not) (?:to )?(?:go|be)\b|keep (?:it|this|that|these|them) out of (?:the )?repo|(?:not|never) (?:in|into|to) (?:the )?repo\b(?![^.!\n]*\?)|you (?:forgot|missed|broke)\b)/i;
/** A clarification, not a correction: "no, I mean the other file". */
const CLARIFY = /\bi mean(?:t)?\b|\bi was (?:just )?asking\b|\bjust asking\b/i;

/** The person picking one of the options the agent offered. */
const PICK =
  /^\s*(?:(?:option|choice|plan)\s*)?(?:[1-9]|[a-d])\s*[.)!]?\s*(?:please|pls)?\s*$|^\s*(?:let'?s |go with |use |pick |do |take |yes,? )?(?:the )?(?:first|second|third|last|1st|2nd|3rd|(?:option|choice|plan)\s*[a-d1-9])\b|^\s*go with\b/i;
const OPTION_LINE = /^\s*(?:\d+[.)]|[A-D][.)]|[-*]\s+\*\*(?:option|choice)|(?:option|choice)\s+[A-D1-9]\b)/gim;

interface ToolEvent {
  at: number;
  uuid: string;
  name: string;
  input: any;
  id: string;
  /** The session's folder when the call was made, as the transcript records it. */
  cwd?: string;
}
interface ToolResult {
  error: boolean;
  text: string;
}
interface Said {
  at: number;
  uuid: string;
  text: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/**
 * What the person typed, or null. The one filter every learning path uses
 * (trace/claude.ts): Claude Desktop's `<system-reminder>` before the message
 * is stripped and the words after it kept, an artifact comment is its quoted
 * text, and compaction summaries, task notices, hook feedback and tool results
 * aren't typed.
 */
function typed(e: any): string | null {
  const t = typedText(e);
  return t && !/^Stop hook feedback/i.test(t) ? t : null;
}

/** `"no, use a worktree for…"`: the first line, short, safe inside double quotes. */
export function quoted(s: string, n = 60): string {
  const line = s.split('\n')[0]!.trim().replace(/"/g, "'");
  return line.length > n ? `${line.slice(0, n - 1).trimEnd()}…` : line;
}

/**
 * Every sign since the session's last saved learning, best first. `repo` is
 * the folder the session works in, to tell its code from trail's files and
 * from files outside it. `branchHasLearning` says whether the branch's commits
 * already add one to the repo: then what it ships carries a learning.
 */
export function noteSignals(jsonl: string, repo: string, branchHasLearning: () => boolean = () => false): NoteSignal[] {
  const tools: ToolEvent[] = [];
  const results = new Map<string, ToolResult>();
  const prompts: Said[] = [];
  const said: Said[] = [];
  let at = 0;
  let agentSpoke = false;
  /** Where the turn that just ended began: the person's last message. */
  let turn: Said | null = null;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    at++;
    const uuid = typeof e?.uuid === 'string' ? e.uuid : `#${at}`;
    const content = e?.message?.content;
    const blocks: any[] = Array.isArray(content) ? content : [];
    if (e?.type === 'assistant') {
      for (const b of blocks) {
        if (b?.type === 'tool_use')
          tools.push({ at, uuid, name: String(b.name ?? ''), input: b.input ?? {}, id: String(b.id ?? ''), cwd: typeof e.cwd === 'string' ? e.cwd : undefined });
        else if (b?.type === 'text' && typeof b.text === 'string') said.push({ at, uuid, text: b.text });
      }
      if (blocks.length) agentSpoke = true;
      continue;
    }
    for (const b of blocks) {
      if (b?.type === 'tool_result') results.set(String(b.tool_use_id ?? ''), { error: b.is_error === true, text: textOf(b.content) });
    }
    const t = typed(e);
    if (t !== null) turn = { at, uuid, text: t };
    // The session's first message can't correct anything.
    if (t !== null && agentSpoke) prompts.push({ at, uuid, text: t });
  }

  // Start after the last learning that was saved (a note the gate turned away doesn't count).
  let from = 0;
  for (const t of tools) {
    const cmd = typeof t.input?.command === 'string' ? t.input.command : '';
    if (t.name === 'Bash' && NOTE_CALL.test(cmd) && results.get(t.id)?.error !== true) from = t.at;
  }
  const since = <T extends { at: number }>(xs: T[]) => xs.filter((x) => x.at > from);
  const work = since(tools);

  const inRepo = (file: unknown): string | null => {
    if (typeof file !== 'string' || !file) return null;
    const rel = isAbsolute(file) ? relative(repo, file) : file;
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const p = rel.split(sep).join('/');
    return trailOwnPath(p) ? null : p;
  };
  const outside = (p: string) => {
    const rel = relative(repo, p);
    return rel.startsWith('..') || isAbsolute(rel);
  };
  const bash = (t: ToolEvent) => (t.name === 'Bash' && typeof t.input?.command === 'string' ? (t.input.command as string) : null);
  /** The repo file a shell command wrote, '' when it wrote one this can't name, null when it wrote none. */
  const shellEdit = (t: ToolEvent): string | null => {
    const c = bash(t);
    if (!c || !BASH_WRITE.test(c) || results.get(t.id)?.error) return null;
    const cd = LEADING_CD.exec(c)?.[2]?.trim();
    const base = cd ? resolve(t.cwd ?? repo, home(cd)) : (t.cwd ?? repo);
    let ownOnly = false;
    for (const w of c.match(FILE_WORD) ?? []) {
      for (const at of isAbsolute(w) ? [w] : [resolve(base, w), resolve(repo, w)]) {
        if (!existsSync(at)) continue;
        const p = inRepo(at);
        if (p) return p;
        ownOnly = true;
      }
    }
    // Writing only trail's own files (settings, learnings) is setup, not a fix; writing only outside the
    // repo (Claude's memory after `cd ~/.claude/…`, a PR body in a scratch file) doesn't change its code.
    if (ownOnly || outside(base)) return null;
    const named = [...c.matchAll(FULL_PATH)].map((m) => home(m[1]!));
    return named.length && named.every(outside) ? null : '';
  };
  const codeEdit = (t: ToolEvent): string | null => (EDIT_TOOLS.has(t.name) ? inRepo(t.input?.file_path ?? t.input?.notebook_path) : shellEdit(t));
  /** Work on the repo after `at`: a code edit, or a command that isn't setting tools up. */
  const setupOnly = (c: string) => c.split(/&&|\|\||;/).every((part) => !part.trim() || SETUP.test(` ${part.trim()} `) || NOTE_CALL.test(part));
  const workedAfter = (when: number) => work.some((t) => t.at > when && (codeEdit(t) !== null || ((c) => c !== null && !setupOnly(c))(bash(t))));

  const out: NoteSignal[] = [];

  // fixed: the same check failed, then passed after an edit to the code.
  const checks = work
    .map((t) => {
      const c = bash(t);
      const m = c ? CHECK.exec(c) : null;
      const r = results.get(t.id);
      if (!m || !r) return null;
      const failed = r.error || (FAILED_OUTPUT.test(r.text) && !ZERO_FAILED.test(r.text));
      return { t, name: m[1]!.replace(/\s+/g, ' ').trim(), failed };
    })
    .filter((x): x is { t: ToolEvent; name: string; failed: boolean } => x !== null);
  for (let i = checks.length - 1; i >= 0; i--) {
    const pass = checks[i]!;
    if (pass.failed) continue;
    const fails = checks.slice(0, i).filter((c) => c.failed && c.name === pass.name);
    if (!fails.length) continue;
    const firstFail = fails[0]!.t.at;
    const edits = work.filter((t) => t.at > firstFail && t.at < pass.t.at).map(codeEdit).filter((f): f is string => f !== null);
    if (!edits.length) continue;
    const times = fails.length === 1 ? 'once' : `${fails.length} times`;
    const file = [...edits].reverse().find((f) => f !== '');
    // Keyed on the episode, the first pass after the last failure: a rerun that passes again is the same sign.
    const lastFail = fails[fails.length - 1]!.t.at;
    const first = checks.slice(0, i).find((c) => !c.failed && c.name === pass.name && c.t.at > lastFail) ?? pass;
    out.push({ kind: 'fixed', key: `fixed:${first.t.uuid}`, what: `${pass.name} failed ${times}, then passed after your change${file ? ` to ${file}` : ''}.` });
    break;
  }

  // corrected: the person set the agent straight, and it went on to change things.
  for (const p of since(prompts).reverse()) {
    if (CLARIFY.test(p.text) || !(CORRECTION_LEAD.test(p.text) || CORRECTION_RULE.test(p.text))) continue;
    if (!workedAfter(p.at)) continue;
    out.push({ kind: 'corrected', key: `corrected:${p.uuid}`, what: `The user corrected you ("${quoted(p.text)}").` });
    break;
  }

  // undone: an edit thrown away, which is an approach ruled out.
  for (const t of [...work].reverse()) {
    const c = bash(t);
    if (!c || !UNDO.test(c) || results.get(t.id)?.error) continue;
    const paths = c.split(/\s+/).filter((w) => /[/.]/.test(w) && !w.startsWith('-') && !/^(?:HEAD|origin)\b/.test(w));
    if (paths.length && paths.every((w) => trailOwnPath(w.replace(/^\.\//, '')))) continue;
    out.push({ kind: 'undone', key: `undone:${t.uuid}`, what: `You undid a change (\`${quoted(c, 50)}\`).` });
    break;
  }

  // chose: the person picked one of the agent's options, and it built that one.
  const picked = (): NoteSignal | null => {
    for (const t of [...work].reverse()) {
      if (t.name !== 'AskUserQuestion') continue;
      const r = results.get(t.id);
      if (!r || r.error || !workedAfter(t.at)) continue;
      const answer = r.text.replace(/^[^:]*answered[^:]*:\s*/i, '');
      return { kind: 'chose', key: `chose:${t.uuid}`, what: `The user picked one of your options ("${quoted(answer)}").` };
    }
    for (const p of since(prompts).reverse()) {
      if (p.text.length > 80 || !PICK.test(p.text)) continue;
      const offer = [...said].reverse().find((s) => s.at < p.at);
      if (!offer || !offer.text.includes('?') || (offer.text.match(OPTION_LINE) ?? []).length < 2) continue;
      if (!workedAfter(p.at)) continue;
      return { kind: 'chose', key: `chose:${p.uuid}`, what: `The user picked one of your options ("${quoted(p.text)}").` };
    }
    return null;
  };
  const choice = picked();
  if (choice) out.push(choice);

  // overrode: trail check named a conflict with a learning, and the work shipped anyway, those files left as they were.
  const conflict = [...work].reverse().find((t) => {
    const c = bash(t);
    const r = results.get(t.id);
    return !!c && !!r && (CHECK_STOP.test(r.text) || (TRAIL_CHECK.test(c) && r.error));
  });
  if (conflict) {
    const named = [...(results.get(conflict.id)?.text ?? '').matchAll(CONFLICT_FILE)].map((m) => m[1]!);
    const after = work.filter((t) => t.at > conflict.at);
    const touched = after.some((t) => named.includes(codeEdit(t) ?? '\0'));
    const shipped = after.find((t) => {
      const c = bash(t);
      return !!c && SHIP.test(c) && results.get(t.id)?.error !== true;
    });
    if (shipped && !touched) {
      out.push({ kind: 'overrode', key: `overrode:${shipped.uuid}`, what: `trail check found this change goes against a learning, and it shipped anyway.` });
    }
  }

  // shipped: the work went into a commit, a push or a PR with no learning beside it, on the branch or since.
  if (work.some((t) => codeEdit(t) !== null)) {
    for (const t of [...work].reverse()) {
      const c = bash(t);
      const m = c ? SHIP.exec(c) : null;
      if (!m || results.get(t.id)?.error) continue;
      if (branchHasLearning()) break;
      const verb = m[1]!.startsWith('gh') ? 'opened a PR for' : m[1]!.endsWith('push') ? 'pushed' : 'committed';
      out.push({ kind: 'shipped', key: `shipped:${t.uuid}`, what: `You ${verb} this work, and no learning went with it.` });
      break;
    }
  }

  // explored: this turn read a lot to find its answer. Asked once a turn, and never for reading trail's own files.
  const start = Math.max(from, turn?.at ?? 0);
  let reading = 0;
  for (const t of work) {
    if (t.at <= start) continue;
    const r = results.get(t.id);
    if (!r || r.error) continue;
    for (const m of r.text.matchAll(TRAIL_SAVED)) reading += Number(m[1]!.replace(/,/g, '')) || 0;
    if (!READ_TOOLS.has(t.name)) continue;
    if (t.name === 'Read' && inRepo(t.input?.file_path) === null) continue;
    reading += Math.round(r.text.length / 4);
  }
  if (reading >= NOTE_WORTHY_READING) {
    out.push({ kind: 'explored', key: `explored:${turn?.uuid ?? `#${start}`}`, what: `This turn took about ${Math.round(reading / 1000)}k tokens of reading to work out.` });
  }
  return out;
}

const SAVE = '`trail note --title "<the decision in plain words a teammate understands, no file names>"`';
const CLOSE = 'Put files, commands and values in the body under "In the code:". Sections: ## Decided, ## Tried and ruled out, ## Watch out. A summary, never a transcript, nothing secret. Then finish as trail\'s output asks.';
/** Where a learning goes when it isn't for the repo, even when the agent also keeps its own copy. */
const PERSONAL =
  "Add --personal when it's about how this person likes to work, or about business, growth, sign-up, pricing or competitor reasoning or internal numbers: those never go in the repo, even if you also keep your own copy.";

/** What the agent is told: the sign first, since Claude Code folds long hook output to its first lines. */
export function noteAsk(s: NoteSignal): string {
  const skip = 'Nothing worth keeping? Say so and stop.';
  const first =
    s.kind === 'fixed'
      ? `${s.what} If the cause isn't obvious from the diff, save it: ${SAVE}, with the why. ${skip}`
      : s.kind === 'corrected'
        ? `${s.what} Save it as a learning so nobody has to say it again: ${SAVE}. ${PERSONAL} ${skip}`
        : s.kind === 'undone'
          ? `${s.what} If you dropped an approach, save why under ## Tried and ruled out: ${SAVE}. ${skip}`
          : s.kind === 'overrode'
            ? `${s.what} If the learning no longer holds, save what changed and why, so the next person isn't told the old way: ${SAVE} with \`--replaces <the old learning's file>\`. If the learning still holds and this is an exception, say so and stop.`
            : s.kind === 'chose'
              ? `${s.what} If the choice matters to the next person, save it under ## Decided, with the options you dropped and why under ## Tried and ruled out: ${SAVE}. ${skip}`
              : s.kind === 'explored'
                ? `${s.what} If it found where something lives or why it works the way it does, and the code won't say so plainly, save it: ${SAVE}. ${skip}`
                : `${s.what} If the session found what the diff won't tell the next person (a cause, a dropped approach, how something is done here), save it now so it ships with the change: ${SAVE}. ${PERSONAL} ${skip}`;
  return `[trail] ${first}\n${CLOSE}`;
}

/**
 * Read on the stop after an ask: whether the agent saved a learning in answer,
 * in the repo or `--personal`, or `no`. Null when the last stop hook feedback
 * in the transcript isn't trail's ask, so another hook's block isn't counted.
 */
export function askAnswer(jsonl: string): 'repo' | 'personal' | 'no' | null {
  let asked = false;
  let saved: 'repo' | 'personal' | 'no' = 'no';
  const notes = new Map<string, string>();
  for (const line of jsonl.split('\n')) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = e?.message?.content;
    if (e?.type === 'user' && e.isMeta && /^Stop hook feedback/i.test(textOf(content))) {
      asked = textOf(content).includes(CLOSE);
      saved = 'no';
      continue;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string' && NOTE_CALL.test(b.input.command)) notes.set(String(b.id), b.input.command);
      const cmd = b?.type === 'tool_result' ? notes.get(String(b.tool_use_id)) : undefined;
      if (asked && cmd !== undefined && b.is_error !== true) saved = /\s--personal\b/.test(cmd) ? 'personal' : 'repo';
    }
  }
  return asked ? saved : null;
}
