/**
 * What a fix may not teach (b2 review, D104): the lists a repair's delta is
 * held to, beside 1a's `neverSave` and `gatedKind` (`risk.ts`). A delta, or
 * moment 4's fix command, becomes a lesson an agent reads as "what fixed
 * it", and an agent chose the command, so it may not carry a way around a
 * check: no flag that skips a hook, forces, widens what may run, points at
 * another registry or makes the command do less; no env var that carries a
 * credential, runs code or turns off a check; no step that logs in, changes
 * config for good or turns off a safety check; nothing that names Trail's,
 * the host's or the shell's own files; nothing the reader can't see.
 *
 * Moved here from `trace/repairs.ts` so moment 4 (offer-lesson.ts) reads the
 * same lists instead of a copy (D104). Not in `risk.ts`: that file is at its
 * size limit and on the PreToolUse fast path, which needs none of this.
 */
import type { FixDelta } from '../trace/types.js';
import { ASSIGN, unquote, words } from '../trace/shell-scan.js';

export const RISKY_FLAG = /^(?:--no-verify|--no-gpg-sign|--no-sign|-n|-f|--force(?:-[\w-]+)?|--dangerously[\w-]*|--permission-mode|--allow(?:ed)?-?tools|--privileged|--cap-add|--security-opt|--registry|--index-url|--extra-index-url|--trusted-host|--otp|--insecure|-k|--no-check-certificate|--unsafe-perm|--allow-root|--dry-run|--help|-h|--version|-v|-short|--pass-?with-?no-?tests|--skip[\w-]*|--ignore[\w-]*)$/i;
export const RISKY_ENV = /^(?:PATH|HOME|SHELL|IFS|ENV|BASH_ENV|ZDOTDIR|PROMPT_COMMAND|EDITOR|VISUAL|PAGER|BROWSER|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHTTPSVERIFY|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|HUSKY|SKIP|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|CLAUDECODE)$|^(?:LD_|DYLD_|XDG_|GIT_|SSH_|TRAIL_|GRAFT_|CLAUDE_|ANTHROPIC_|PRE_COMMIT|NPM_CONFIG_)|(?:^|_)(?:TOKEN|SECRET|PASS|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|KEY|AUTH\w*|CREDENTIALS?|OTP|PRIVATE\w*|COOKIE|SESSION)(?:_|$)/i;
export const RISKY_STEP = new RegExp([
  String.raw`\bgit\s+config\b[^;&|\n]{0,400}?(?:--global|--system|core\.hooksPath|safe\.directory|credential|\burl\.)`,
  String.raw`\bgh\s+auth\s+(?:login|logout|refresh|setup-git|token|switch)\b`,
  String.raw`\b(?:npm|pnpm|yarn)\b[^;&|\n]{0,200}?\s(?:login|logout|adduser|add-user|token)(?![\w:.-])`, String.raw`\b(?:npm|pnpm|yarn)\s+config\s+set\b`,
  String.raw`\bclaude\s+(?:setup-token|login|logout|auth)\b`,
  String.raw`\b(?:docker|podman|helm|vercel|netlify|fly(?:ctl)?|heroku|firebase|wrangler|az)\s+(?:registry\s+)?login\b`,
  String.raw`\baws\s+(?:configure|sso\s+login)\b`, String.raw`\bgcloud\s+auth\b`,
  String.raw`\bxattr\s+-[a-z]*[dc]`, String.raw`\b(?:spctl|csrutil|systemsetup|dscl|nvram|crontab|chown)\b`, String.raw`\bdefaults\s+write\b`,
  String.raw`\blaunchctl\s+(?:load|bootstrap|enable|submit)\b`,
  String.raw`(?:^|[\s;&|(='"])(?:/tmp/|/private/tmp/|/var/folders/|\$\{?TMPDIR\b)`,
  String.raw`\bchmod\b[^;&|\n]{0,200}?(?:\s0?[0-7]{2}[2367](?=\s|$)|[\s,][ao]*\+[rwxXst]*w)`,
].join('|'), 'i');
/** Git config set for one command (`git -c core.hooksPath=/dev/null push`). Case-sensitive: `git -C dir` is a directory. */
export const GIT_INLINE_CONFIG = /\bgit\b[^;&|\n]{0,200}?\s(?:-c\s*\S|--config-env\b)/;
export const OWN_FILES = /(?:^|[\s='":@/])\.(?:trail|claude(?:\.json)?|codex|cursor|gemini|agents|mcp\.json|zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|bash_login|profile|gitconfig|ssh|npmrc|netrc|config\/(?:fish|gh|git))(?![\w-])|(?:^|[\s='":])\/etc\/|\b(?:CLAUDE|AGENTS|GEMINI)\.md\b|Library\/LaunchAgents\b/;
export const UNSEEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** A delta that can't be a lesson, beyond `neverSave` and `gatedKind` (b2 review). A short-flag bundle (`-fq`) is read letter by letter. */
export function riskyDelta(d: Pick<FixDelta, 'kind' | 'name' | 'text'>): boolean {
  if (UNSEEN.test(d.text) || OWN_FILES.test(d.text)) return true;
  if ((d.kind === 'flag' || d.kind === 'env') && /\$\(|`|[<>]\(/.test(d.text)) return true; // a value that runs a command
  if (d.kind === 'flag') return RISKY_FLAG.test(d.name) || (/^-[a-z]{2,4}$/i.test(d.name) && /[nfkhv]/i.test(d.name));
  if (d.kind === 'env') return RISKY_ENV.test(d.name);
  return d.kind === 'enable-step' && (RISKY_STEP.test(d.text) || GIT_INLINE_CONFIG.test(d.text));
}

/** Past this a command is not read word by word: it is not a lesson's fix anyway (4.14 step 3 keeps 300 at most). */
const WORDS_MAX = 4096;

/**
 * Moment 4's fix command (4.14 step 3, D104): the whole command read as an enabling step, and each of its env
 * assignments and flags read as a delta of its own, so `git push --no-verify origin v1.4.3` or `HUSKY=0 git push`
 * never becomes "what fixed it". True: don't use it (the lesson is the phrase alone).
 */
export function riskyCommand(cmd: string): boolean {
  const text = String(cmd ?? '');
  if (!text.trim() || text.length > WORDS_MAX) return true;
  if (riskyDelta({ kind: 'enable-step', name: '', text })) return true;
  if (/\$\(|`|[<>]\(/.test(text)) return true; // runs a command of its own
  for (const raw of words(text)) {
    const w = unquote(raw);
    if (ASSIGN.test(raw) && riskyDelta({ kind: 'env', name: w.slice(0, w.indexOf('=')), text: w })) return true;
    if (w.length > 1 && w.startsWith('-') && w !== '--' && riskyDelta({ kind: 'flag', name: w.split('=')[0]!, text: w })) return true;
  }
  return false;
}
