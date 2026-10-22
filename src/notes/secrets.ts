/**
 * Whether a text holds a secret: the check every save runs before a skill
 * step, a lesson or a learning is written. A text with one is refused, not
 * scrubbed: a scrubbed command no longer works, and a missed shape in a
 * shared file is the worst case. Matches the shapes that turn up in real
 * sessions: provider keys, vendor keys (a short prefix and a long random
 * body), names like `TRAIL_API_KEY=` with a real value, bearer and basic
 * logins, private keys, passwords in URLs and commands, and long random
 * strings.
 *
 * Not secrets: git shas and other hex digests (the same shape as a hash of
 * anything), versions, UUIDs (session, run and request ids show up in paths
 * and commands; a UUID only counts when it is assigned to a secret's name),
 * paths (macOS temp folders `/var/folders/<2>/<random>/T/` included: the
 * random folder name is the system's, D62), placeholders (`$TOKEN`,
 * `${TOKEN}`, `<token>`, `***`) and words.
 *
 * The reason names the kind of secret, never the secret.
 *
 * Every check is linear in the text: it runs on every save and in hooks, on
 * texts of any length. A pattern that starts at every position of a long run
 * and reads to the run's end (`aaaa…`, `sk-sk-sk-…`, `a.a.a.…`) is quadratic,
 * so each one here starts only where a match can start, or is a short loop
 * that reads a run once.
 */

const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

/** Keys whose provider prefix says what they are. */
const PROVIDER_KEYS = [
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bya29\.[A-Za-z0-9_-]{20,}/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}/,
  // A Telegram bot token, often inside its API link (`/bot123:AA…`).
  /(?<!\d)\d{6,12}:AA[A-Za-z0-9_-]{30,}/,
];

/**
 * Keys with a prefix and a body that holds a digit (`sk-…`, `sb_secret_…`; the
 * digit keeps out names like `sk-learn-…`), with the body's least length. Only
 * the first prefix in a run of key characters is looked at: a later one in the
 * same run has less of that run after it, so it can't hold a key where the
 * first didn't, and a lookahead tried at each of them (`sk-sk-sk-…`) is
 * quadratic.
 */
const DIGIT_KEYS: [RegExp, number][] = [
  [/\bsk-([A-Za-z0-9_-]*)/g, 16],
  [/\bsb_secret_([A-Za-z0-9_-]*)/g, 20],
];

function digitKey(text: string): boolean {
  for (const [re, min] of DIGIT_KEYS) {
    for (const m of text.matchAll(re)) if (m[1]!.length >= min && /\d/.test(m[1]!)) return true;
  }
  return false;
}

/** Links that are a credential: whoever has one can post. */
const WEBHOOKS = [/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{20,}/, /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/];
/** A link with its scheme (`https://…`) or without one (`docs.example.test/d/…`); see linkSpans. */
const SCHEMED = /[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+/iy;
const BARE = /(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s'"<>`]*/iy;
const HOST_RUN = /(?:[a-z0-9-]+\.)*[a-z0-9-]*/iy;
const LINK_START = /\b[a-z0-9-]/gi;
const LETTER_START = /\b[a-z]/gi;
/** From the first place a link can start in a run of scheme characters to the run's end. */
const SCHEME_RUN = /\b[a-z0-9-][a-z0-9+.-]*/gi;

/** The length of `re`'s (sticky) match at `i`, or -1. */
function at(re: RegExp, text: string, i: number): number {
  re.lastIndex = i;
  return re.test(text) ? re.lastIndex - i : -1;
}

/**
 * The links in `text` as [start, end], in order: what the pattern
 * /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s'"<>`]*\/gi
 * finds. That pattern reads a long run that is neither (`a.a.a.…`) to its end
 * from each of its positions; here each run of scheme characters is read once.
 * A link with a scheme starts at the run's first letter after a non-word
 * character, when `://` ends the run. One without needs a dot in the run, and
 * every start in one run of host labels reaches the same last label, so where
 * one failed the rest of those labels are skipped.
 */
function linkSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  SCHEME_RUN.lastIndex = 0;
  for (let run; (run = SCHEME_RUN.exec(text)); ) {
    const start = run.index;
    const end = start + run[0].length;
    const schemed = text.startsWith("://", end) && /[^\s'"<>`]/.test(text[end + 3] ?? " ");
    if (!schemed && !run[0].includes(".")) continue;
    let first = end;
    if (schemed) {
      LETTER_START.lastIndex = 1;
      first = /[a-z]/i.test(run[0][0]!) ? start : start + (LETTER_START.exec(run[0])?.index ?? run[0].length);
    }
    let span: [number, number] | null = null;
    // A link without a scheme can start before the one with a scheme.
    for (let i = start, noHost = start; !span; ) {
      LINK_START.lastIndex = i;
      const p = LINK_START.exec(text)?.index;
      if (p === undefined || p >= first) break;
      if (p >= noHost) {
        const len = at(BARE, text, p);
        if (len > 0) span = [p, p + len];
        else noHost = p + at(HOST_RUN, text, p);
      }
      i = Math.max(p + 1, noHost);
    }
    if (!span && first < end) span = [first, first + at(SCHEMED, text, first)];
    if (span) {
      spans.push(span);
      SCHEME_RUN.lastIndex = span[1];
    }
  }
  return spans;
}

/** `text` with each link replaced by a space. */
function withoutLinks(text: string): string {
  let out = "";
  let from = 0;
  for (const [a, b] of linkSpans(text)) {
    out += `${text.slice(from, a)} `;
    from = b;
  }
  return out + text.slice(from);
}

/** A login in a link: `postgres://user:pass@host`. */
const URL_LOGIN = /[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@/'"]+)@([^\s/'"?#]+)/iy;

/**
 * Each login in a link, in order: what URL_LOGIN finds tried after every word
 * boundary. It starts in the run of scheme characters before a `://`, and
 * every letter after a non-word character in that run gives the same answer,
 * so only the first is tried and each run is read once.
 */
function* urlLogins(text: string): Generator<RegExpExecArray> {
  let after = 0;
  for (let c = text.indexOf("://"); c >= 0; c = text.indexOf("://", c + 1)) {
    let p = c;
    while (p > after && /[a-z0-9+.-]/i.test(text[p - 1]!)) p--;
    while (p < c && !(/[a-z]/i.test(text[p]!) && (p === 0 || !/\w/.test(text[p - 1]!)))) p++;
    if (p === c) continue;
    URL_LOGIN.lastIndex = p;
    const hit = URL_LOGIN.exec(text);
    if (hit) {
      yield hit;
      after = URL_LOGIN.lastIndex;
    }
  }
}

/** Query keys that carry a key or a signature (`token=`, `api_key=` and the like are caught by name below). */
const KEYED = /[?&#](?:key|sig|signature|x-amz-signature|x-goog-signature|auth)=([^&#\s'"]+)/gi;

/**
 * A macOS temp folder's own part: `/var/folders/<2>/<random>/` (lowercase, digits, `_`), then `T`, `C` or `0`.
 * Taken out with its last slash before the random-string checks (D62): what follows is read on its own, so a
 * random name in the folder is still caught.
 */
const MAC_TEMP = /(?:\/private)?\/var\/folders\/[a-z0-9_+-]{2}\/[a-z0-9_+-]{20,40}(?:\/[A-Z0-9])?(?:\/|(?=[\s'"`;|&)<>:,]|$))/g;

/**
 * A JWT: `eyJ…​.eyJ…​.…`, each part at least 10 characters. A part ends at a dot,
 * so the first part is the rest of its run; only the first `eyJ` in a run is
 * looked at (a later one has less of the run after it), as with DIGIT_KEYS.
 */
function jwt(text: string): boolean {
  const rest = /\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10}/y;
  for (const m of text.matchAll(/\beyJ[A-Za-z0-9_-]*/g)) {
    if (m[0].length < 13) continue;
    rest.lastIndex = m.index! + m[0].length;
    if (rest.test(text)) return true;
  }
  return false;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Where a value stands in for the secret or reads it at run time: the safe way
 * to write one down. `$TOKEN`, `${TOKEN}`, `$(gh auth token)`, `${#TOKEN}`,
 * backticks, `%s` formats, `<token>`, `***`.
 */
const PLACEHOLDER = /^(?:\$|`|%|\{|<|\*{3}|x{3,}|\.{3}|\[redacted\]|changeme$|password$|secret$|your[_-]|example)/i;
/** A value that says it is a stand-in: `sb_secret_placeholder`, `fake-key-for-tests`, `nn...`. */
const STAND_IN = /placeholder|example|dummy|redacted|changeme|(?:^|[_-])(?:fake|test|invalid|wrong|bogus)(?:[_-]|$)|(?:\.{3}|…)$/i;
/** A pattern, not a value: `(.+)`, `[^&]*`, `.*`, `\d+` (a grep or sed that looks for secrets). */
const PATTERN = /^[()[\]|\\^]|\.[*+?{]|\[\^|\\[dswbDSW]|\(\?|\]\{\d/;

/**
 * …or a bracket with a range in it (`[a-z0-9]`). Only the first `[` after a
 * `]` is looked at: a later one before the same `]` holds less of it.
 */
function bracketRange(v: string): boolean {
  for (const m of v.matchAll(/\[([^\]]*)(\]?)/g)) if (m[2] && /\w-\w/.test(m[1]!)) return true;
  return false;
}
/** Another variable's name: `VENDOR_API_KEY`. */
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(?::\d+)?$/i;

/**
 * Names that hold a secret: `TRAIL_API_KEY`, `DB_PASSWORD`, `client_secret`,
 * `token`. A name starts where its run of name characters starts: that is
 * where every match of the unanchored pattern began, and starting at each
 * position of a long run made it quadratic.
 */
const SECRET_NAME = /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key)[A-Za-z0-9_-]*/gi;
/** …unless the name is about the secret rather than holding it: `MAX_TOKENS`, `TOKEN_TTL`, `API_KEY_ID`. */
const ABOUT_A_SECRET = /tokens\b|tokeniz|(?:^|[_.-])(?:max|min|num)[_-]|[_.-](?:ttl|expiry|expires?|expiration|length|len|count|limit|max|min|size|timeout|url|uri|path|file|dir|name|type|header|endpoint|id|env|var|field|policy|rotation|days|hours|seconds)$/i;
/** …in camelCase: `APIKeyID`, `tokenUrl`, `secretName`. */
const ABOUT_A_SECRET_CAMEL = /[a-z0-9](?:Id|ID|Ids|IDs|Name|Url|URL|Uri|URI|Path|File|Type|Header|Env|Length|Count|Ttl|TTL|Expiry|Field)$/;
/** `= value` or `: value`, not `==`, `===` or `::`. The value ends where code or a query would go on. */
const ASSIGNED = /^['"]?\s*(?::(?!:)|=(?!=))\s*['"]?([^\s'",;}\\)\]&>]{1,257})/;
/**
 * An assigned value is judged by its first 256 characters. A value can hold the
 * next name (`token=/a/token=/b/…`), so reading each one to its end is
 * quadratic. The cut is marked with a character no check accepts, so a cut
 * value is never plainer than the whole one: what ends there (`…_fake`,
 * `ENV_NAME`) does not count.
 */
const MAX_VALUE = 256;
const cutValue = (v: string) => (v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}\u0000` : v);
const SECRET_FLAG = /(?:^|\s)--?(?:password|passwd|pass|token|api-?key|secret|client-secret)(?:=|\s+)['"]?([^\s'"]+)/gi;

/**
 * A value too plain to be a secret: a placeholder, a word, a reference, a path.
 * The checks read from the start first; the ones that look anywhere in the
 * value come last.
 */
function plainValue(v: string): boolean {
  if (v.length < 4 || PLACEHOLDER.test(v) || ENV_NAME.test(v) || /^(?:\/|~\/|\.\.?\/)/.test(v)) return true;
  // "token: always in the keychain" is advice, not a token; `{ API_KEY: _omit }` renames it.
  if (/^_?[A-Za-z]+$/.test(v) && v.length < 16) return true;
  // process.env.API_KEY, os.environ[…], settings.token, z.string(), crypto.randomUUID(), secretFor(…), "…".length
  if (/^[A-Za-z_]\w*(?:\.\w+)+[[(]?$|^[A-Za-z_]\w*(?:\.\w+)*[[(]|^\.[A-Za-z_]\w*$/.test(v)) return true;
  return STAND_IN.test(v) || PATTERN.test(v) || bracketRange(v);
}

/** Random-looking: letters and digits in short pieces, not words. `getS3BucketPolicy` is words. */
function looksRandom(run: string): boolean {
  if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/\d/.test(run)) return false;
  const pieces = run.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
  const avg = pieces.reduce((n, p) => n + p.length, 0) / Math.max(1, pieces.length);
  return avg < 2.5;
}

/** `src/server/routes/v1/Admin.ts`: words between slashes, not an opaque blob. */
function looksLikePath(tok: string): boolean {
  const segs = tok.replace(/^\.{0,2}\//, "").replace(/\/$/, "").split("/");
  return segs.length >= 2 && segs.every((seg) => seg.length > 0 && seg.length <= 40 && (seg.match(/[A-Z]/g) ?? []).length <= 2);
}

/**
 * Object ids with the same shape as a vendor key, which APIs hand out in the
 * open: Stripe's `cus_`/`price_`, Vercel's `team_`/`prj_`, the model APIs'
 * `msg_`/`file-`. A secret under one of these names is still caught by its
 * name (`API_KEY=…`).
 */
const OPEN_ID_PREFIXES = new Set([
  "acct", "batch", "ch", "cus", "dpl", "evt", "file", "in", "msg", "org", "pay", "pdt", "pi", "pm", "po", "price", "prj", "prod", "re", "req", "run", "seti", "sub", "team", "toolu", "txn", "user",
]);

/** A vendor key: a short lowercase prefix, then a long random body (`ab_…`, `abc-…`, or a prefix glued to hex). */
function vendorKey(text: string): boolean {
  for (const m of text.matchAll(/\b([a-z]{2,5})([_-]?)([A-Za-z0-9]+)\b/g)) {
    const [, prefix, sep, body] = m as unknown as [string, string, string, string];
    if (sep && OPEN_ID_PREFIXES.has(prefix)) continue;
    const mixed = (body.match(/\d/g) ?? []).length >= 2 && (body.match(/[A-Za-z]/g) ?? []).length >= 2;
    if (sep === "_" && body.length >= 16 && mixed) return true;
    if (sep === "-" && body.length >= 24 && mixed) return true;
    // `ab` + 64 hex: the prefix has a letter hex doesn't, so it isn't a digest.
    if (sep === "" && body.length >= 32 && /[g-z]/.test(prefix) && /^[0-9a-f]+$/.test(body)) return true;
  }
  return false;
}

/** Why `text` can't be saved as it is, or null when it holds no secret. */
export function secretReason(text: string): string | null {
  if (typeof text !== "string" || !text) return null;
  if (PRIVATE_KEY.test(text)) return "a private key";
  if (digitKey(text) || PROVIDER_KEYS.some((re) => re.test(text))) return "an API key";
  if (jwt(text)) return "a signed token (JWT)";
  // Ids are ids: a UUID is judged only where it is assigned to a secret's name, below.
  const noIds = text.replace(UUID, " ").replace(MAC_TEMP, " ");
  if (vendorKey(noIds)) return "an API key";
  if (WEBHOOKS.some((re) => re.test(text))) return "a webhook link";
  for (const [a, b] of linkSpans(text)) {
    const link = text.slice(a, b);
    for (const m of link.matchAll(KEYED)) {
      if (m[1]!.length >= 8 && !plainValue(m[1]!)) return "a key in a link";
    }
  }

  for (const m of text.matchAll(/\bbearer\s+([^\s'"]+)/gi)) {
    if (!plainValue(m[1]!) && m[1]!.length >= 8) return "a bearer token";
  }
  if (/\bauthorization:\s*basic\s+[A-Za-z0-9+/=]{8,}/i.test(text)) return "a login in an Authorization header";
  // postgres://user:pass@host, https://user:pass@host
  for (const m of urlLogins(text)) {
    if (!PLACEHOLDER.test(m[1]!) && !LOCAL_HOST.test(m[2]!)) return "a password in a URL";
  }
  // curl -u user:pass, --user=user:pass; not `date -u +%H:%M` or `docker run -u 1000:1000`.
  for (const m of text.matchAll(/(?:^|\s)(?:-u|--user)[\s=]+['"]?([A-Za-z0-9_][\w.@-]*):([^\s'"]+)/g)) {
    if (/^\d+$/.test(m[1]!) && /^\d+$/.test(m[2]!)) continue;
    if (!PLACEHOLDER.test(m[2]!) && !STAND_IN.test(m[2]!)) return "a password in a command";
  }
  // DB_PASSWORD=…, TRAIL_API_KEY: …, "client_secret": "…"
  for (const m of text.matchAll(SECRET_NAME)) {
    // `${API_KEY:?set it}` reads a variable; it assigns nothing.
    if (ABOUT_A_SECRET.test(m[0]) || ABOUT_A_SECRET_CAMEL.test(m[0]) || /[{$]/.test(text[m.index! - 1] ?? "")) continue;
    const value = ASSIGNED.exec(text.slice(m.index! + m[0].length))?.[1];
    if (value && !plainValue(cutValue(value))) return "a password or token";
  }
  for (const m of text.matchAll(SECRET_FLAG)) {
    if (!plainValue(m[1]!)) return "a password or token";
  }
  // Long random strings, outside links: a link's path and ids (deployments,
  // documents, uploads, click ids) look random and aren't secrets; a link that
  // carries one was judged above, by its query key or its host.
  for (const run of withoutLinks(noIds).match(/[A-Za-z0-9+/_=.-]{32,}/g) ?? []) {
    if (looksLikePath(run) || /^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+$/.test(run)) continue;
    // `SHA=<digest>`: the name and the value apart; base64 padding stays on its value.
    for (const part of run.split(/=+(?=.)/)) {
      // Hex digests, and ids built on one (`AC` + 32 hex), have one case only.
      if (part.length < 32 || /^[A-Za-z]{0,5}[_-]?(?:[0-9a-f]+|[0-9A-F]+)=*$/.test(part)) continue;
      const bare = /^[A-Za-z0-9]+$/.test(part);
      if ((bare || part.length >= 40) && looksRandom(part)) return "a long secret-looking string";
    }
  }
  return null;
}
