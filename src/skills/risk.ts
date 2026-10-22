/**
 * The risk lists (design 4.11, spec 10).
 *
 * Never save (never-save.ts, kept off the PreToolUse fast path): a command a
 * skill may never hold, so a run with one gives no skill at all.
 *
 * Gated: a step that can't be undone (publish, push to prod or main, deploy,
 * `gh pr merge`, migrations, `docker system prune`) or that logs in to a
 * service (D93: `npm login`, `gh auth login`, `aws sso login`, ...). It stays
 * in the skill, marked, and Claude Code asks the person right before it runs.
 *
 * The agent guard: commands only the person may run (turn skills or offers
 * on, keep a held skill) and Trail's hook scripts run by hand, which would
 * forge a hook payload. Turning things off is open to anyone.
 *
 * Agents wrap commands (`bash -c`, `env`, `xargs`, `find -exec`, `eval`,
 * `{ }`, `if`, `for`), put flags anywhere (`git push origin main --force`,
 * `npm --registry x publish`) and leave the branch implicit (`git push`), so
 * the lists read the whole text, quotes included, and a target the skill
 * can't know (a variable, a {param}, the current branch) counts as the risky
 * one.
 *
 * The PreToolUse fast path imports this file: besides types it loads only
 * `shell.ts`, which loads only its lexer.
 */
import type { GatedKind } from '../trace/types.js';
import { hookUnrun, quotedTextHit, simpleCommands } from '../trace/shell.js';

export const MAX_RUN_LINES = 12;
export const MAX_STEP_CHARS = 300;

/** The words after a program, to the end of its command (an unquoted-looking `;`, `&`, `|`, `)`, newline or backtick), quotes dropped. */
/** How far past a program word its arguments are read: a call's own arguments, never the rest of a 2 MB command. */
const ARGS_MAX = 4096;

/**
 * The words after `from`, up to the end of that call. `until` is where the next match of the same program starts
 * (callers pass it), so `git push git push …` reads each call once and the whole scan stays linear (g7 review).
 */
export function argsAfter(text: string, from: number, until = text.length): string[] {
  // `$(git rev-parse HEAD)` is one word to the shell, not the end of the command.
  const rest = text.slice(from, Math.min(until, from + ARGS_MAX)).replace(/\$\([^()]*\)/g, '$X');
  const end = rest.search(/[;&|)\n`]/);
  return (end < 0 ? rest : rest.slice(0, end)).split(/\s+/).map((w) => w.replace(/^['"]+|['"]+$/g, '')).filter(Boolean);
}
/** Where a program word starts: not inside another word or path name (`/bin/rm` counts, `git-rm` doesn't). */
export const word = (name: string) => new RegExp(String.raw`(?<![\w./-])(?:[\w./-]*\/)?${name}(?=\s|$)`, 'g');

const PROD = new Set(['main', 'master', 'prod', 'production']);
const GIT_PUSH = /(?<![\w./-])(?:[\w./-]*\/)?git((?:\s+(?:-C|-c|--git-dir|--work-tree|--namespace)\s+\S+|\s+(?!(?:-C|-c|--git-dir|--work-tree|--namespace)\s)-[\w-]+(?:=\S+)?)*)\s+push(?=\s|$|[;&|)'"])/g;

/** One `git push`: forced or not, where it went (`<current>` for the checked-out branch, `<unknown>` for a variable or {param}, `<all>`), and from what. */
export interface Push { force: boolean; dsts: string[]; srcs: string[] }

export function pushes(text: string): Push[] {
  const out: Push[] = [];
  const calls = [...text.matchAll(GIT_PUSH)];
  for (const [i, m] of calls.entries()) {
    const words = argsAfter(text, m.index! + m[0].length, calls[i + 1]?.index);
    let force = false;
    let all = false;
    let tags = false;
    let flagsDone = false;
    const pos: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (!flagsDone && w === '--') flagsDone = true;
      else if (flagsDone || !w.startsWith('-')) pos.push(w);
      else if (/^--force(?:-with-lease)?(?:=.*)?$/.test(w) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(w)) force = true;
      else if (w === '--mirror') force = all = true;
      else if (w === '--all' || w === '--branches') all = true;
      else if (w === '--tags') tags = true;
      else if (/^(?:-o|--push-option|--repo|--receive-pack|--exec)$/.test(w)) i++;
    }
    const refspecs = pos.slice(1);
    const dsts: string[] = [];
    const srcs: string[] = [];
    for (const r of refspecs) {
      if (r.startsWith('+')) force = true;
      const x = r.replace(/^\+/, '');
      const colon = x.lastIndexOf(':');
      const src = colon < 0 ? x : x.slice(0, colon);
      const dst = (colon < 0 ? x : x.slice(colon + 1)).replace(/^refs\/heads\//, '');
      srcs.push(src);
      dsts.push(dst === 'HEAD' || dst === '@' ? '<current>' : /[$`{}]/.test(dst) || !dst ? '<unknown>' : dst);
    }
    if (all) dsts.push('<all>');
    else if (!refspecs.length && !tags) dsts.push('<current>');
    out.push({ force, dsts, srcs });
  }
  return out;
}
export const unknownDst = (d: string) => d.startsWith('<');
const pushProd = (c: string) => pushes(c).some((p) => p.dsts.some((d) => PROD.has(d.toLowerCase()) || unknownDst(d)));

/** A value written out in the command, not read from a variable or a {param} (`$PW`, `"${PW:?set PW}"`, `{password}`, `<pw>`). */
export const written = (v: string) => {
  const u = v.replace(/^['"]+|['"]+$/g, '');
  return u.length >= 4 && !/^\$|^\{[A-Za-z_]\w*\}$|^<[^>]*>$|^\*+$|^-/.test(u);
};
/** The end of a branch name: not more of a name (`main-fix`, `main/x`, `main.old`). */
const SEP_END = String.raw`(?![\w:-])`;

/**
 * The gated patterns, built once (they ran on every call: a 2 MB command split into pieces built them per piece). Every
 * span inside a call is bounded, and migrate's flags can't be read two ways, so no command makes them backtrack (g7 review).
 */
const PUBLISH_RE = new RegExp(String.raw`\b(?:npm|pnpm|yarn|bun)\b(?:\s+[^\s;&|]+){0,12}?\s+(?:publish|pub)(?![\w:.-])|\b(?:changeset|lerna)\s+publish\b|\bnpx\s+np(?![\w-])|\b(?:poetry|uv|flit|hatch|deno|jsr|vsce|ovsx)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\b(?:docker|podman)\s+(?:image\s+)?push\b|\bdocker\s+buildx\s+build\b[^;&|\n]{0,300}\s--push\b|\bdotnet\s+nuget\s+push\b|\bpod\s+trunk\s+push\b|\b(?:flutter|dart)\s+pub\s+publish\b|\bmix\s+hex\.publish\b|\bmvn\b[^;&|\n]{0,300}\sdeploy\b|\bgradlew?\b[^;&|\n]{0,300}\spublish\w*\b`, 'i');
const DEPLOY_RE = new RegExp(String.raw`\bvercel\b[^;&|\n]{0,300}\s--prod\b|\bvercel\s+(?:deploy|promote|rollback)\b|\bvercel\s+alias\s+set\b|\bnetlify(?:-cli)?\s+deploy\b[^;&|\n]{0,300}\s--prod\b|\bfly(?:ctl)?\s+deploy\b|\bkubectl\b[^;&|\n]{0,300}?\s(?:apply|create|replace|patch|delete|scale|set|edit|rollout\s+(?:restart|undo))(?![\w-])|\bhelm\b[^;&|\n]{0,300}?\s(?:upgrade|install|uninstall|rollback|delete)(?![\w-])|\b(?:terraform|tofu)\b(?:\s+-chdir=\S+)?\s+(?:apply|destroy)\b|\bwrangler\b[^;&|\n]{0,300}\s(?:deploy|publish)\b|\bgcloud\b[^;&|\n]{0,300}\sdeploy\b|\b(?:serverless|sls|cdk|sam)\s+deploy\b|\bpulumi\s+up\b|\bfirebase\s+deploy\b|\brailway\s+up\b|\bheroku\s+(?:releases:rollback|container:release)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy(?:[:-]prod(?:uction)?)?${SEP_END}|\bmake\s+deploy(?:-prod(?:uction)?)?${SEP_END}`, 'i');
const MIGRATE_RE = new RegExp(String.raw`\bprisma\s+(?:migrate\s+deploy|db\s+push)\b|\bsupabase\s+(?:db\s+push|migration\s+up)\b|\bknex\s+migrate:latest\b|\balembic\s+upgrade\b|\bdb:migrate\b|\bmanage\.py\s+migrate\b|\becto\.migrate\b|\bflyway\s+migrate\b|\bliquibase\s+update\b|\bdbmate\s+(?:up|migrate)\b|\bdrizzle-kit\s+(?:push|migrate)\b|\bgoose\b[^;&|\n]{0,300}\sup\b|\batlas\s+migrate\s+apply\b|(?:^|[\s/])migrat\w*(?:\s+-{1,2}\w[\w-]*(?:=\S+|\s+(?!-)(?!(?:up|deploy|apply|run)\b)\S+)?){0,16}\s+(?:up|deploy|apply|run)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:db:)?migrat\w*(?::(?:up|deploy|prod|latest))?${SEP_END}`, 'i');
/**
 * D93: logging in to a service, wherever it sits in the call (`script -q /dev/null npm login`, `env … npm login`,
 * `npx vercel login`). Flags before npm's command are read only as `--flag` or `--flag=value` (a value after a space
 * would let every word be either, which costs a second on 2 MB of `npm --a `); aws's flags take a value either way,
 * a flag word starting with `-` and a value not. Every span is bounded.
 */
const LOGIN_RE = new RegExp([
  String.raw`\b(?:npm|pnpm)(?:\s+-{1,2}[\w-]{1,64}(?:=[^\s;&|]{0,256})?){0,6}\s+(?:login|adduser|add-user)(?![\w:.-])`,
  String.raw`\byarn(?:\s+npm)?\s+login(?![\w:.-])`,
  String.raw`\bgh\s+auth\s+login\b`,
  String.raw`\bvercel\s+login\b`,
  String.raw`\b(?:docker|podman)\s+login\b`,
  String.raw`\baws(?:\s+--[\w-]{1,64}(?:=[^\s;&|]{0,256}|\s+(?!-)[^\s;&|]{1,256})?){0,6}\s+(?:configure(?![\w-])(?!\s+(?:get|list|list-profiles|export-credentials)\b)|sso\s+login\b)`,
  String.raw`\bgcloud\s+auth\s+(?:application-default\s+)?login\b`,
  String.raw`\bfirebase(?:-tools)?\s+login\b`,
  String.raw`\bheroku\s+(?:auth:)?login\b`,
  String.raw`\baz\s+login\b`,
].join('|'), 'i');
const GATED: Array<[GatedKind, (c: string) => boolean]> = [
  ['publish', (c) => PUBLISH_RE.test(c)],
  ['push-prod', pushProd],
  ['deploy', (c) => DEPLOY_RE.test(c)],
  ['merge', (c) => /\bgh\s+pr\s+merge\b|\bglab\s+mr\s+merge\b/i.test(c)
    || (/\bgh\s+api\b/i.test(c) && /(?:-X|--method)[\s=]+(?:PUT|POST)\b/i.test(c) && /\/pulls\/[^/\s'"]+\/merge\b|\/merges\b/i.test(c))],
  ['migrate', (c) => MIGRATE_RE.test(c)],
  ['prune', (c) => /\b(?:docker|podman)\s+(?:system|volume|image|container)\s+prune\b|\b(?:docker|podman)\s+volume\s+rm\b/i.test(c)],
  ['login', (c) => LOGIN_RE.test(c)],
];

/** `--dry-run`, `--dry-run=client`: changes nothing. `--dry-run=false` and kubectl's `--dry-run=none` do. */
const DRY = /(?:^|\s)--dry-run(?:=(?!(?:false|0|none)\b)\S+)?(?=\s|$|[;&|)])/;

/** Every gated kind whose pattern appears anywhere in `cmd`, dry run or not: linear, for a command too long to split (3.3). */
export function gatedAnywhere(cmd: string): Set<GatedKind> {
  const c = String(cmd ?? '');
  return new Set(GATED.filter(([, hit]) => hit(c)).map(([kind]) => kind));
}

export function gatedKind(cmd: string): GatedKind | null {
  const c = String(cmd ?? '');
  // A dry run changes nothing: only the commands without one count.
  const parts = DRY.test(c) ? simpleCommands(c).filter((x) => !DRY.test(x)) : [c];
  for (const p of parts) for (const [kind, hit] of GATED) if (hit(p)) return kind;
  return null;
}

const REGISTRY: Array<[RegExp, string]> = [
  [/\bcargo\s+publish\b/i, 'crates.io'], [/\btwine\s+upload\b|\b(?:poetry|uv|flit|hatch)\s+publish\b/i, 'PyPI'], [/\bgem\s+push\b/i, 'RubyGems'],
  [/\b(?:docker|podman)\b/i, 'the image registry'], [/\b(?:vsce|ovsx)\s+publish\b/i, 'the extension marketplace'],
];
const SHA = /^[0-9a-f]{7,40}$/;
/** Which service a login step logs in to, for its ask. */
const LOGIN_TO: Array<[RegExp, string]> = [
  [/\b(?:npm|pnpm|yarn)\b/i, 'npm'], [/\bgh\s+auth\b/i, 'GitHub'], [/\bvercel\b/i, 'Vercel'], [/\b(?:docker|podman)\s+login\b/i, 'the image registry'],
  [/\baws\b/i, 'AWS'], [/\bgcloud\b/i, 'Google Cloud'], [/\bfirebase/i, 'Firebase'], [/\bheroku\b/i, 'Heroku'], [/\baz\s+login\b/i, 'Azure'],
];

/** D116 item 5: the login a command runs, as the person would type it (flags dropped), and the service; null when none. */
export function loginOf(cmd: string): { service: string; login: string } | null {
  const m = LOGIN_RE.exec(String(cmd ?? ''));
  if (!m) return null;
  const login = m[0].replace(/\s+-{1,2}[\w-]+(?:=\S*)?/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return { service: LOGIN_TO.find(([re]) => re.test(m[0]))?.[1] ?? 'the service', login };
}

/** "publishes 0.22.1 to npm", "moves prod to 4e1c9a2", ... (4.11). */
export function gatedWhat(kind: GatedKind, cmd: string, values: Record<string, string>): string {
  // A value worked out when it runs (`$(git rev-parse HEAD)`) reads as a variable.
  const fill = (t: string) => t.replace(/\{([A-Za-z_]\w*)\}/g, (m, k: string) => (values[k] === undefined ? m : /[$`]/.test(values[k]!) ? '$X' : values[k]!));
  const c = fill(String(cmd ?? ''));
  if (kind === 'publish') {
    const where = REGISTRY.find(([re]) => re.test(c))?.[1] ?? 'npm';
    const v = values.version;
    return `publishes ${v && !v.includes('$') ? v : 'a new version'} to ${where}`;
  }
  if (kind === 'push-prod') {
    for (const p of pushes(c)) {
      const i = p.dsts.findIndex((d) => PROD.has(d.toLowerCase()));
      if (i >= 0) {
        const src = p.srcs[i] ?? '';
        const to = SHA.test(src) ? src.slice(0, 7) : !src || /[$`{}]/.test(src) || src === 'HEAD' || src === p.dsts[i] ? 'HEAD' : src;
        return `moves ${p.dsts[i]} to ${to}`;
      }
      if (p.dsts.includes('<all>')) return 'pushes every branch';
      if (p.dsts.includes('<current>')) return 'pushes the current branch';
      if (p.dsts.includes('<unknown>')) return 'pushes to a branch named when it runs';
    }
    // A branch the skill fills in when it runs: not a branch name to show.
    if (c !== String(cmd ?? '') && pushes(String(cmd).replace(/\{[A-Za-z_]\w*\}/g, '$X')).some((p) => p.dsts.includes('<unknown>'))) {
      return 'pushes to a branch named when it runs';
    }
    return 'moves prod';
  }
  if (kind === 'deploy') return 'deploys to production';
  if (kind === 'merge') {
    const pr = values.pr ?? /\bmerge\s+#?(\d+)\b|\/pulls\/(\d+)\/merge\b/.exec(c)?.slice(1).find(Boolean);
    return pr && /^\d+$/.test(pr) ? `merges PR #${pr}` : 'merges a PR';
  }
  if (kind === 'migrate') return 'runs a database migration';
  if (kind === 'login') return `logs in to ${LOGIN_TO.find(([re]) => re.test(c))?.[1] ?? 'a service'}`;
  return 'deletes unused Docker data';
}

/** Consecutive steps of one gated kind form one group; one host ask covers a group (3.3). */
export function gatedGroups(steps: Array<{ n: number; gated: GatedKind | null }>): Array<{ kind: GatedKind; steps: number[] }> {
  const out: Array<{ kind: GatedKind; steps: number[] }> = [];
  let prev: GatedKind | null = null;
  for (const s of steps) {
    if (s.gated && s.gated === prev) out[out.length - 1]!.steps.push(s.n);
    else if (s.gated) out.push({ kind: s.gated, steps: [s.n] });
    prev = s.gated;
  }
  return out;
}

/** Phase 2 (P28): `restore-version`, an older version of a skill brought back. */
export type GuardHit = 'skills-on' | 'offers-on' | 'keep-held' | 'hook-script' | 'restore-version';

/** A Trail program word anywhere in the call: named, through a package, an alias or a variable (`t=trail`). */
const TRAIL_WORD = /(?<![\w./-])(?:trail|graft|trail-code)(?![\w./-])|@trailhq\/trail-code\b|@nanonets\/graft\b|\bbin\/(?:trail|graft)\.js\b/i;
/**
 * Flags between `skills` and the switch. Bounded, like every quantifier below: the guard reads commands of up to
 * 2 MB on the 5 s PreToolUse budget, after which Claude Code runs the command anyway (g7 review).
 */
const FL = String.raw`(?:-[^\s]{1,64}\s+){0,8}`;
const REASONS: Record<GuardHit, string> = {
  'offers-on': 'Only the person turns skill offers on, in their own terminal: trail skills offers on. Tell the person; don\'t run it for them.',
  'skills-on': 'Only the person turns skills on, in their own terminal: trail skills on. Tell the person; don\'t run it for them.',
  'keep-held': 'Keeping a held skill is the person\'s yes, so only the person runs trail skills keep, in their own terminal. Tell the person; don\'t run it for them.',
  'hook-script': 'Trail\'s hook scripts run only from the host\'s hooks, never by hand. If something about Trail looks wrong, tell the person.',
  'restore-version': 'Only the person brings back an older version of a skill, in their own terminal: trail skills restore {name} --version {n}. Tell the person; don\'t run it for them.',
};

/**
 * The person-only switches after `skills`, whatever runs them: a Trail binary, a renamed or copied one
 * (`node /tmp/t.js skills on`), an alias or a variable (`T=trail; $T skills on`). Printing them is denied too.
 */
const SWITCH: Array<[GuardHit, RegExp]> = [
  ['offers-on', new RegExp(String.raw`\bskills\s+${FL}offers\s+${FL}on\b`, 'i')],
  ['skills-on', new RegExp(String.raw`\bskills\s+${FL}on\b`, 'i')],
  ['keep-held', new RegExp(String.raw`\bskills\s+${FL}keep\b`, 'i')],
];
/** With a Trail word in the call: the switch not written out (`trail skills $x`, `trail skills $(echo on)`). */
const DYNAMIC_SWITCH: Array<[GuardHit, RegExp]> = [
  ['offers-on', new RegExp(String.raw`\bskills\s+${FL}offers\s+${FL}[$\x60]`, 'i')],
  ['skills-on', new RegExp(String.raw`\bskills\s+${FL}[$\x60]`, 'i')],
];
/** With a Trail word in the call: the word `skills` not written out (`trail $s on`, `trail $(echo skills) on`). */
const AFTER = String.raw`\s+${FL}(?:(offers)\s+${FL}on|(on)|(keep))\b`;
const DYNAMIC_WORD: Array<[RegExp, RegExp]> = [
  [/\$\w/, new RegExp(String.raw`\$\w{1,64}${AFTER}`, 'i')],
  [/\$\{/, new RegExp(String.raw`\}${AFTER}`, 'i')],
  [/\$\(/, new RegExp(String.raw`\)${AFTER}`, 'i')],
  [/\x60/, new RegExp(String.raw`\x60${AFTER}`, 'i')],
];
/** xargs or parallel supplying the switch from stdin: `skills` ends the call or a placeholder follows it. */
const XARGS = /\b(?:xargs|parallel)\b/i;
const XARGS_SKILLS = /\bskills(?:\s+-[^\s]{1,64}){0,8}\s*(?:$|\{\}|%)/i;
/**
 * P28: `skills restore <name> --version <n>`, read per command (split on `; & | newline`, one pass, so a flag
 * any distance after the verb is found and a 2 MB command stays linear). With a Trail word in the call, also the
 * forms that don't write it out: the flag or the verb from a variable or a substitution, or `skills` itself.
 */
const RESTORE_AT = new RegExp(String.raw`\bskills\s+${FL}restore\b`, 'i');
const RESTORE_SKILLS_DYNAMIC = new RegExp(String.raw`\bskills\s+${FL}[$\x60]`, 'i');
const RESTORE_WORD_DYNAMIC = new RegExp(String.raw`(?:\$\w{1,64}|[})\x60])\s+${FL}restore\b`, 'i');
const VERSION_FLAG = /(?<![\w-])--version(?![\w-])/;
function restoreVersionIn(c: string, trailWord: boolean): boolean {
  if (!/restore|--version/i.test(c)) return false;
  for (const seg of c.split(/[;&|\n]/)) {
    const m = RESTORE_AT.exec(seg);
    const rest = m ? seg.slice(m.index + m[0].length) : '';
    if (m && VERSION_FLAG.test(rest)) return true;
    if (!trailWord) continue;
    if (m && /[$\x60]/.test(rest)) return true;
    if (VERSION_FLAG.test(seg) && (RESTORE_SKILLS_DYNAMIC.test(seg) || RESTORE_WORD_DYNAMIC.test(seg))) return true;
  }
  return false;
}
/**
 * Trail's hook scripts and hook modules: the shims by name or by a glob (`t*-hooks.cjs`, `trail-hook?.cjs`), a
 * helpers path the shell works out (`.claude/helpers/*`, `.claude/helpers/$(ls …)`), and the package's
 * `dist/claude/<module>.js` run or imported by hand.
 */
const HOOK_SCRIPT = [
  /\b(?:trail|graft)-hooks?[\w*?[\]-]{0,64}(?:\.cjs\b|\*)/i,
  /hooks?[*?[\]]{0,8}\.cjs\b/i,
  /\.claude\/helpers\/[^\s/]{0,64}[*?[$\x60]/i,
  /(?:@trailhq\/trail-code|@nanonets\/graft|\bdist)\/(?:dist\/)?claude\/[\w-]{1,64}\.js\b/i,
];

/** What `shellWords` drops: a line continuation, then any quote or backslash. */
const UNSAID = /\\\n|["'\\]/g;

/** The words the shell runs: quotes and backslashes don't change them, and a line continuation joins with nothing. */
export function shellWords(cmd: string): string {
  const s = String(cmd ?? '');
  // Slices between the few dropped characters; past 4,096 of them, one pass over char codes (two regex
  // replaces cost 20+ ms on 2 MB of `"a" `; a copy of a 2 MB command with a few quotes costs 13).
  let r = '';
  let last = 0;
  let n = 0;
  UNSAID.lastIndex = 0;
  for (let m = UNSAID.exec(s); m; m = UNSAID.exec(s)) {
    r += s.slice(last, m.index);
    last = m.index + m[0].length;
    if (++n > 4096) return r + dropUnsaid(s, last);
  }
  return last ? r + s.slice(last) : s;
}

function dropUnsaid(s: string, from: number): string {
  const out = new Uint16Array(s.length - from);
  let k = 0;
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 39) continue;
    if (c === 92) {
      if (s.charCodeAt(i + 1) === 10) i++;
      continue;
    }
    out[k++] = c;
  }
  let r = '';
  for (let i = 0; i < k; i += 8192) r += String.fromCharCode.apply(null, out.subarray(i, Math.min(k, i + 8192)) as unknown as number[]);
  return r;
}

function hitOf(m: RegExpExecArray): GuardHit {
  return m[1] ? 'offers-on' : m[2] ? 'skills-on' : 'keep-held';
}

/** Past this a command is read whole: any switch denies, wherever it sits (the lexer on 2 MB takes seconds). */
const TEXT_MAX = 64 * 1024;

/** The switch written out, as the shell's words read: `skills on`, `skills offers on`, `skills keep`. */
function staticSwitch(c: string): GuardHit | null {
  if (!/skills/i.test(c)) return null;
  for (const [hit, re] of SWITCH) if (re.test(c)) return hit;
  return restoreVersionIn(c, false) ? 'restore-version' : null;
}

/** The switch or the word `skills` not written out, with a Trail word in the call, and xargs supplying it. */
function dynamicSwitch(c: string, trailWord: boolean): GuardHit | null {
  if (trailWord && restoreVersionIn(c, true)) return 'restore-version';
  if (trailWord) {
    for (const [hit, re] of DYNAMIC_SWITCH) if (re.test(c)) return hit;
    for (const [has, re] of DYNAMIC_WORD) {
      const m = has.test(c) ? re.exec(c) : null;
      if (m) return hitOf(m);
    }
  }
  if (XARGS.test(c)) {
    for (const seg of c.split(/[;&|\n]/)) if (XARGS.test(seg) && XARGS_SKILLS.test(seg)) return 'skills-on';
  }
  return null;
}

/**
 * D89: a switch found in the text is denied where the shell runs it, not where it is only words: inside quoted
 * arguments of grep, rg, git commit or log, echo or printf not fed to a shell, sed, awk patterns, cat. Over
 * TEXT_MAX, or when no one command carries it, the whole text decides.
 */
function runsSwitch(cmd: string, whole: GuardHit, find: (c: string) => GuardHit | null): GuardHit | null {
  if (cmd.length > TEXT_MAX) return whole;
  return quotedTextHit(cmd, (t) => find(shellWords(t)), whole);
}

const hookNamed = (t: string) => (HOOK_SCRIPT.some((re) => re.test(shellWords(t))) ? true : null);

const namesHook = (t: string) => hookNamed(t) === true;
/** fix-lab5: a command only naming a hook script leaves it unrun (shell-words' hookUnrun: a read, a delete, a check, an edit of another file). */
const leavesHookUnrun = <T>(head: string, bodies: string[], hitOf: (text: string) => T | null) => hookUnrun(head, bodies, hitOf, namesHook);

/** D116 item 2: the hook script is run, not only read (an argument of grep, sed, cat, a pager, head, git log) or named (fix-lab5). */
function runsHookScript(raw: string): boolean {
  if (raw.length > TEXT_MAX) return true;
  return quotedTextHit(raw, hookNamed, true, 0, leavesHookUnrun) !== null;
}

/** P28's words, with the person's own command when the name and version are written out (else `<name>`, `<n>`). */
function restoreReason(c: string): string {
  const m = /\bskills\s+restore\s+([a-z0-9][a-z0-9-]{0,63})\s+--version[=\s]([1-9]\d{0,5})(?![\w-])/i.exec(c)
    ?? /\bskills\s+restore\s+--version[=\s]([1-9]\d{0,5})\s+([a-z0-9][a-z0-9-]{0,63})(?![\w-])/i.exec(c);
  const [name, n] = m ? (/^\d/.test(m[1]!) ? [m[2]!, m[1]!] : [m[1]!, m[2]!]) : ['<name>', '<n>'];
  return REASONS['restore-version'].replace('{name}', name).replace('{n}', n);
}

/** 4.11 agent guard: commands only the person may run, and Trail's hook scripts run by hand. Linear in the command. */
export function agentGuard(cmd: string): { hit: GuardHit; reason: string } | null {
  const raw = String(cmd ?? '');
  const c = shellWords(raw);
  const found = (hit: GuardHit) => ({ hit, reason: hit === 'restore-version' ? restoreReason(c) : REASONS[hit] });
  const fixed = staticSwitch(c);
  const ran = fixed && runsSwitch(raw, fixed, staticSwitch);
  if (ran) return found(ran);
  if (HOOK_SCRIPT.some((re) => re.test(c)) && runsHookScript(raw)) return found('hook-script');
  const trailWord = TRAIL_WORD.test(c);
  const dynamic = dynamicSwitch(c, trailWord);
  const ranDynamic = dynamic && runsSwitch(raw, dynamic, (t) => dynamicSwitch(t, trailWord));
  return ranDynamic ? found(ranDynamic) : null;
}
