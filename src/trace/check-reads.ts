/**
 * D140: the check families the demo lab's real repos needed, split from checks.ts (500-line rule). Each only reads:
 * - bats, a tests runner: its TAP (`ok 1`, `not ok 2`) and its pretty summary (`2 tests, 0 failures`);
 * - `gcloud run services describe`, a deploy status: passed when the service's Ready condition is True;
 * - a `curl --fail` GET of a health URL (`/healthz`, `/status`, ...), a deploy status only once the run pushed or
 *   deployed, passed when it came back with nothing unhealthy in it.
 * A command that changes things (`gcloud run deploy`) is never one of them. Pure: no files, no clock.
 */

/** bats with something to run: never `--version`, `--help`, or bats alone. */
export const BATS = String.raw`(?:npx )?bats\b(?=.*\s[^-\s])(?!.*\s(?:--version|--help|-v|-h)(?:\s|$))`;

/** `gcloud run services describe <svc>`. */
export const GCLOUD_DESCRIBE = String.raw`gcloud run services describe (?!-)\S+`;

/**
 * A GET of a deployed service's health path with --fail (`-f` in a flag cluster), so an HTTP error fails the call.
 * Never a write, and never a local server (localhost is a dev server, not a deploy).
 */
export const HEALTH_CURL = String.raw`curl\b(?=.*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--fail(?:-with-body)?)(?:\s|$))(?!.*\s(?:-X\s*(?!GET\b)\w|--request\s+(?!GET\b)\w|-d\b|--data\b|--data-\w+|-F\b|--form\b|-T\b|--upload-file\b))(?=.*\shttps?:\/\/(?!(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?:[:/]|$))[^\s'"]*\/(?:health|healthz|healthcheck|_health|status|ping|ready|readyz|livez|up)(?:[\s'"?#/]|$))`;

const HEALTH_RE = new RegExp(`^${HEALTH_CURL}`);
export const isHealthCurl = (bare: string): boolean => HEALTH_RE.test(bare);

/** A loop that waits on something: a health read inside one is the wait step (D58 d), not a check. */
export const inLoop = (cmd: string): boolean => /(?:^|[\s;&|(])(?:while|until|for)\b[\s\S]*?\bdo\b/.test(cmd);

/** A step that deploys (D140: what a health read can follow), as a simple command. */
export const DEPLOY_STEP = /^(?:gcloud run deploy|gcloud app deploy|fly(?:ctl)? deploy|netlify deploy|(?:npx )?vercel(?: deploy)?(?: --prod)?\s*$|(?:npx )?vercel deploy\b|kubectl (?:apply|set image|rollout restart)\b|helm (?:upgrade|install)\b|git push\b)/;

/** bats's own output: TAP, or the pretty formatter's summary. Null when it isn't bats's. */
export function batsPassed(text: string): { passed: boolean; count?: number } | null {
  const summary = /^\s*(\d+) tests?, (\d+) failures?\b/m.exec(text);
  if (summary) return { passed: Number(summary[1]) > 0 && summary[2] === '0', count: Number(summary[1]) - Number(summary[2]) };
  if (!/^1\.\.\d+\s*$/m.test(text) && !/^not ok \d+/m.test(text)) return null;
  const oks = text.match(/^ok \d+/gm)?.length ?? 0;
  return { passed: oks > 0 && !/^not ok \d+/m.test(text), count: oks };
}

/** The service's Ready condition, from JSON, YAML, a `value(...)` read of it, or the default view's first line. */
export function gcloudReady(text: string, shas: string[]): { passed: boolean; state?: string; sha?: string } {
  const t = String(text ?? '');
  const sha = shas.find((s) => new RegExp(`(?<![0-9a-f])${s}`).test(t));
  const withSha = (passed: boolean) => ({ passed, ...(passed ? { state: 'Ready' } : {}), ...(sha && passed ? { sha } : {}) });
  const json = /"type"\s*:\s*"Ready"[^}]*?"status"\s*:\s*"(\w+)"|"status"\s*:\s*"(\w+)"[^}]*?"type"\s*:\s*"Ready"/.exec(t);
  if (json) return withSha((json[1] ?? json[2]) === 'True');
  const yaml = /status:\s*'?(\w+)'?\s*\n\s*type:\s*Ready\b|type:\s*Ready\s*\n\s*status:\s*'?(\w+)'?/.exec(t);
  if (yaml) return withSha((yaml[1] ?? yaml[2]) === 'True');
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && /^(?:True|False|Unknown)$/.test(lines[0]!)) return withSha(lines[0] === 'True');
  if (/^✔ Service\b/.test(lines[0] ?? '')) return withSha(true);
  return { passed: false };
}

/** A health read that came back: nothing unhealthy, down or failing in it. */
export function healthy(text: string): boolean {
  const t = String(text ?? '').trim();
  return t !== '' && !/\b(?:unhealthy|down|degraded|fail\w*|errors?|starting|unavailable)\b/i.test(t);
}
