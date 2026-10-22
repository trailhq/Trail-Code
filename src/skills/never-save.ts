/**
 * Never save (design 4.11, spec 10): a command a skill may never hold, so a
 * run with one gives no skill at all (sudo, a download piped into a shell,
 * `rm -rf` on a variable or a home path, a force push to a shared branch, a
 * credential file, destructive SQL off this machine, anything that messages
 * people, Trail itself), and the 4.10 password backstop. Split from risk.ts,
 * whose gated list and agent guard the PreToolUse fast path loads; this file
 * is for the save side only.
 */
import { isTrailCommand } from '../trace/shell.js';
import { argsAfter, pushes, unknownDst, word, written } from './risk.js';

const LOCAL_HOSTS = /^(?:localhost|127\.0\.0\.1|::1|\[::1\])$/i;
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Hosts a database command names: `-h x`, `--host=x`, `host=x`, `scheme://user@x:port`. */
function namedHosts(cmd: string): string[] {
  const hosts: string[] = [];
  for (const m of cmd.matchAll(/(?:^|\s)(?:-h|--host)(?:=|\s+)['"]?([^\s'"/;]+)/g)) hosts.push(m[1]!);
  for (const m of cmd.matchAll(/\bhost=['"]?([^\s'";]+)/gi)) hosts.push(m[1]!);
  for (const m of cmd.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"]*@)?(\[[^\]]+\]|[^\s/:'"?]+)/gi)) hosts.push(m[1]!);
  return hosts;
}

/** A target `rm -r` or `find -delete` must never get: a variable, a {param}, home, an absolute path, the whole folder. */
const wildTarget = (t: string) => t !== '{}' && (/^[$~/]|^\.\.(?:\/|$)/.test(t) || /\$|`|\{[A-Za-z_]\w*\}/.test(t) || /^(?:\.\/?|(?:\.\/)?\*)$/.test(t));

function rmWild(text: string): boolean {
  const rms = [...text.matchAll(word('rm'))];
  for (const [i, m] of rms.entries()) {
    let recursive = false;
    let opts = true;
    const targets: string[] = [];
    for (const w of argsAfter(text, m.index! + m[0].length, rms[i + 1]?.index)) {
      if (opts && w === '--') opts = false;
      else if (opts && /^-[a-zA-Z]+$/.test(w)) recursive ||= /[rR]/.test(w);
      else if (opts && /^--[\w-]+$/.test(w)) recursive ||= w === '--recursive';
      else targets.push(w);
    }
    if (!recursive) continue;
    // `xargs rm -rf`: the targets come from elsewhere.
    if (!targets.length ? /\bxargs\b[^;&|\n]*$/.test(text.slice(0, m.index)) : targets.some(wildTarget)) return true;
  }
  const finds = [...text.matchAll(word('find'))];
  for (const [i, m] of finds.entries()) {
    const w = argsAfter(text, m.index! + m[0].length, finds[i + 1]?.index);
    const roots = w.slice(0, Math.max(0, w.findIndex((x) => /^[-(!]/.test(x))));
    const deletes = w.includes('-delete') || w.some((x, i) => /^-(?:exec|execdir|ok|okdir)$/.test(x) && /(?:^|\/)rm$/.test(w[i + 1] ?? ''));
    // `find . -name x -exec rm {} +` is fine; a root the skill can't know is not.
    if (deletes && roots.some((t) => /^[$~/{]/.test(t) || /\$|`/.test(t))) return true;
  }
  return false;
}

const SHARED = new Set(['main', 'master', 'prod', 'production', 'beta', 'dev', 'develop', 'staging', 'trunk']);
const forcePushShared = (c: string) => pushes(c).some((p) => p.force && p.dsts.some((d) => SHARED.has(d.toLowerCase()) || unknownDst(d)));
const SUDO = /(?:^|[^\w./-])(?:[\w./-]*\/)?(?:sudo|doas|pkexec)(?![\w-])/i;
const SHELL_WORD = String.raw`(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:\S+=\S*\s+)*)?(?:[\w./-]*\/)?`;
const DOWNLOAD = [
  new RegExp(String.raw`\b(?:curl|wget)\b[^\n]*?(?<!\|)\|(?!\|)\s*${SHELL_WORD}(?:ba|z|da|k|fi)?sh\b`, 'i'),
  new RegExp(String.raw`\b(?:curl|wget)\b[^\n]*?(?<!\|)\|(?!\|)\s*${SHELL_WORD}(?:python[\d.]*|node|perl|ruby|php)(?:\s+-)?\s*(?=$|[;&|)\n])`, 'i'),
  /(?:\b(?:ba|z|da|k)?sh|\bsource|(?:^|[\s;&|(])\.)\s+<\(\s*(?:curl|wget)\b/i,
  /\b(?:(?:ba|z|da|k)?sh\s+-\w*c|eval)\s+["']?(?:\$\(|`)\s*(?:curl|wget)\b/i,
];
/** `curl -o x.sh URL && sh x.sh`, `wget URL -O s.sh; chmod +x s.sh; ./s.sh`: a download saved to a file, then run. */
function downloadThenRun(text: string): boolean {
  for (const m of text.matchAll(/\b(curl|wget)\b([^;&|\n]*)/gi)) {
    const [, tool, args] = m as unknown as [string, string, string];
    const files = new Set<string>();
    const named = /(?:\s-[a-zA-Z]*o\s*|\s--output[= ]\s*|\s-O\s*(?=[^\s-])|\s--output-document[= ]\s*)['"]?([^\s'";&|]+)/.exec(args)?.[1];
    if (named && named !== '-' && named !== '/dev/null') files.add(named);
    // `wget URL` and `curl -O URL` save under the link's own name.
    const remote = /^wget$/i.test(tool) ? !/\s-[a-zA-Z]*O\b|--output-document/.test(args) : /\s-[a-zA-Z]*O\b|--remote-name\b/.test(args);
    if (remote) for (const u of args.matchAll(/https?:\/\/\S*\/([^\s/'"?#]+)/g)) files.add(u[1]!);
    const after = text.slice(m.index! + m[0].length);
    for (const f of files) {
      const e = escapeRe(f.replace(/^\.\//, '').split('/').pop()!);
      // Run as a program, or handed to a shell, `source`, `.` or `chmod +x`: at the start of a command.
      const run = new RegExp(String.raw`(?:^|[;&|(\n]|&&|\|\|)\s*(?:(?:(?:ba|z|da|k)?sh|source|\.|chmod\s+\S*x)\s+)?['"]?(?:\.?\.?\/[^\s'"]*\/|\.\/)?${e}['"]?(?=\s|$|[;&|)])`);
      const plainName = new RegExp(String.raw`(?:^|[;&|(\n]|&&|\|\|)\s*(?:(?:ba|z|da|k)?sh|source|\.|chmod\s+\S*x)\s+['"]?${e}['"]?(?=\s|$|[;&|)])`);
      if (plainName.test(after) || (run.test(after) && new RegExp(String.raw`(?:^|[\s;&|(])\.{0,2}\/(?:[^\s'"]*\/)?${e}(?=\s|$|[;&|)'"])`).test(after))) return true;
    }
  }
  return false;
}

const CREDENTIAL = /(?:\.npmrc|\.netrc|\.aws\/(?:credentials|sso\/cache|cli\/cache)|(?<![\w.])\.ssh\/|\.git-credentials|\.docker\/config\.json|gh\/hosts\.yml|com\.vercel\.cli\/auth\.json|\.config\/gcloud|Library\/Keychains|\.kube\/config|\.pypirc|\.gem\/credentials|\.cargo\/credentials|\.pgpass|\.my\.cnf|credentials\.tfrc\.json|\.terraformrc|\.config\/hub\b|\.azure\/|\.password-store|\.vault-token)/i;
/**
 * Commands that store a credential they were handed where every later command picks it up. Logging in at
 * the browser (`npm login`, `gh auth login`) needs the person there, holds no secret in the step, and is how
 * a release gets past an expired token: not on this list, but gated (D93, `login`), so it is never run unasked.
 */
const CREDENTIAL_WRITE = /\bnpm\s+config\s+set\s+\S*_(?:auth|password)|\b(?:docker|podman|helm\s+registry)\s+login\b[^;&|\n]*\s(?:-p|--password(?:-stdin)?)\b|\baws\s+configure\s+set\b|\bgit\s+credential\s+(?:approve|store)\b|\bgit\s+config\b[^;&|\n]*\bcredential\.helper\b|\bsecurity\s+add-(?:generic|internet)-password\b/i;
/** Commands that print a stored credential. */
const CREDENTIAL_READ = /\bgh\s+auth\s+token\b|\bgit\s+credential\s+fill\b|\bsecurity\s+(?:find|delete)-(?:generic|internet)-password\b|\bsecurity\s+dump-keychain\b|\bop\s+(?:read|item\s+get)\b|\bgcloud\s+auth\s+print-(?:access|identity)-token\b|\bheroku\s+auth:token\b|\bpass\s+show\b|\bvault\s+(?:read|kv\s+get)\b/i;

const DESTRUCTIVE_SQL = /\b(?:drop\s+(?:table|database|schema|view|materialized\s+view|index|owned|role|user|function|type|sequence|extension)|truncate(?!\s+-)|delete\s+from|alter\s+table\b[^;]*?\bdrop)\b|\bdropdb\b|\bflush(?:all|db)\b|\bdropDatabase\s*\(|\.drop(?:Collection)?\s*\(\s*\)|\bdeleteMany\s*\(\s*\{\s*\}\s*\)|\bsupabase\s+db\s+reset\b[^;&|\n]*--(?:linked|db-url)|\bprisma\s+(?:migrate\s+reset|db\s+push\b[^;&|\n]*--(?:force-reset|accept-data-loss))|\brails\s+db:(?:drop|reset)\b/i;

const MESSAGES = /\b(?:sendmail|mail\s+-s|mailx|mutt|msmtp|swaks|twilio)\b|\bgit\s+send-email\b|hooks\.slack\.com|\bslack\s+chat\b|graph\.facebook\.com|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|api\.(?:sendgrid\.com|mailgun\.net|postmarkapp\.com|resend\.com)|\bgh\s+(?:issue\s+(?:create|comment)|pr\s+(?:comment|review))\b/i;
/** `gh api` that writes: a POST/PATCH/PUT, or fields (`-f`, `-F`, `--input`) without `-X GET`. */
function ghApiWrite(c: string): boolean {
  if (!/\bgh\s+api\b/i.test(c)) return false;
  if (/\bgh\s+api\s+graphql\b/i.test(c)) return /\bmutation\b[\s\S]*?\b(?:add|create|submit|update)\w*(?:Comment|Review|Issue|Discussion)\w*\b/i.test(c);
  const method = /(?:-X|--method)[\s=]+([A-Z]+)/i.exec(c)?.[1]?.toUpperCase();
  const writes = method ? method !== 'GET' : /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?=[\s=])/.test(c);
  return writes && /\/(?:comments|reviews|issues|messages|replies)\b/i.test(c);
}

/** Trail run by a wrapper `isTrailCommand` doesn't open: `eval "trail …"`, `xargs trail`, `find -exec trail`. */
const TRAIL_VIA = /(?:\beval|\bxargs(?:\s+-\S+(?:\s+[^\s-]\S*)?)*|(?<!\S)-(?:exec|execdir|ok|okdir))\s+["']?(?:trail|graft|trail-code)\b/i;

const NEVER: Array<[string, (cmd: string) => boolean]> = [
  ['runs sudo', (c) => SUDO.test(c)],
  ['pipes a download into a shell', (c) => DOWNLOAD.some((re) => re.test(c)) || downloadThenRun(c)],
  ['runs rm -rf on a variable or a home path', rmWild],
  ['force-pushes a shared branch', forcePushShared],
  ['touches a credential file', (c) => CREDENTIAL.test(c) || CREDENTIAL_WRITE.test(c) || CREDENTIAL_READ.test(c)],
  ['runs destructive SQL off this machine', (c) => DESTRUCTIVE_SQL.test(c)
    && (namedHosts(c).some((h) => !LOCAL_HOSTS.test(h)) || !/(?:^|[;&|(]\s*)docker\s+exec\b/i.test(c))],
  ['messages people or submits to an outside service', (c) => MESSAGES.test(c) || ghApiWrite(c)],
  ['runs Trail itself', (c) => isTrailCommand(c) || TRAIL_VIA.test(c)],
];

/** Reason a command can never be in a skill (4.11), or null. */
export function neverSave(cmd: string): string | null {
  const c = String(cmd ?? '');
  for (const [why, hit] of NEVER) {
    if (!hit(c)) continue;
    if (why === 'touches a credential file') {
      const writes = CREDENTIAL_WRITE.test(c) || />>?\s*\S*(?:\.npmrc|\.netrc|credentials|\.ssh\/|config\.json|hosts\.yml|auth\.json|\.kube\/config|\.pypirc|\.pgpass)|\b(?:cp|mv|tee|ln)\b|security\s+add-/i.test(c);
      return writes ? 'writes a credential file' : 'reads a credential file';
    }
    return why;
  }
  return null;
}

const PASSWORD_AT: RegExp[] = [
  /\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^;&|\n]*?\s-p(?=\S)(\S+)/i,
  /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;&|\n]*?\s--password=(\S+)/i,
  /\b(?:docker|podman|nerdctl|buildah|skopeo|oras)\s+login\b[^;&|\n]*?\s(?:-p|--password)(?:=|\s+)(\S+)/i,
  /\bhelm\s+registry\s+login\b[^;&|\n]*?\s(?:-p|--password)(?:=|\s+)(\S+)/i,
  /\bsshpass\s+-p\s*(\S+)/i,
  /\bredis-cli\b[^;&|\n]*?\s(?:-a|--pass)\s+(\S+)/i,
  /\b(?:echo|printf)\s+(?:-n\s+)?(\S+)\s*\|[^;&\n]*--password-stdin\b/i,
  /\b(?:PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH|SSHPASS)=(\S+)/,
];

/** 4.10 backstop: a password written out after a flag that takes one. The fold names most secrets; these it can't tell from a word. */
export function literalPassword(cmd: string): boolean {
  const c = String(cmd ?? '');
  return PASSWORD_AT.some((re) => { const v = re.exec(c)?.[1]; return v !== undefined && written(v); });
}
