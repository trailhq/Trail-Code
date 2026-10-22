/**
 * The secret check every save runs: a skill step or a learning holding a key,
 * a token or a password is refused, not scrubbed. Every key here is synthetic
 * and assembled from pieces at run time, so the source holds nothing that
 * looks like a live credential.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { secretReason } from "../src/notes/secrets.js";

/** A made-up key, from pieces. */
const k = (...parts: string[]) => parts.join("");
const HEX64 = "3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1c3e5a7b9d1f3a5c7e9b1d3f";
const B62 = "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6S7t8";

const secrets: [string, string, string][] = [
  ["an OpenAI-style key", k("s", "k-proj-", "Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z"), "an API key"],
  ["an Anthropic-style key", k("s", "k-ant-api03-", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed"), "an API key"],
  ["a GitHub token", k("gh", "p_", B62), "an API key"],
  ["a GitHub OAuth token", k("gh", "o_", B62), "an API key"],
  ["a fine-grained GitHub token", k("github", "_pat_", "11ABCDEFG0", "abcdefghijklmn", "_", B62, B62), "an API key"],
  ["a Slack bot token", k("xo", "xb-", "1234567890-1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx"), "an API key"],
  ["a Slack user token", k("xo", "xp-", "1234567890-1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx"), "an API key"],
  ["an AWS access key id", k("AK", "IA", "Z7Q2X9W4V1T8R3S6"), "an API key"],
  ["an npm token", k("np", "m_", B62), "an API key"],
  ["a Google API key", k("AI", "za", "Sy", "D1f2G3h4J5k6L7m8N9p0Q1r2S3t4U5v"), "an API key"],
  ["a Stripe live key", k("s", "k_live_", "4eC39HqLyjWDarjtT1zdp7dc"), "an API key"],
  ["a vendor key: short prefix and a long hex body", k("n", "n", HEX64), "an API key"],
  ["a vendor key: short prefix, underscore, base62 body", k("m", "b_", "a1B2c3D4e5F6g7H8i9J0"), "an API key"],
  ["a vendor key: dashed prefix and a hex body", k("ke", "y-", HEX64.slice(0, 32)), "an API key"],
  ["a vendor key inside a command", `curl -H "X-Api-Key: ${k("tr", "l_", "Q7mZp3Lx9KwR2vT8nB5y")}" https://api.example.test/v1`, "an API key"],
  ["an API key assigned to a name", "TRAIL_API_KEY=abc123def456ghi789", "a password or token"],
  ["a password in an export", "export DB_PASSWORD='s3cr3t-Pa55'", "a password or token"],
  ["a token in YAML", "token: 9f8e7d6c5b4a", "a password or token"],
  ["a secret in JSON", '{"client_secret": "Zx9-kQ2-pL7"}', "a password or token"],
  ["a short real password", "password: hunter2", "a password or token"],
  ["a UUID assigned to an API key", "API_KEY=123e4567-e89b-12d3-a456-426614174000", "a password or token"],
  ["a password flag", "deploy --password Tr4ck3r99x", "a password or token"],
  ["a bearer token", `curl -H 'Authorization: Bearer ${k("abcDEF", "123456ghiJKL789")}' https://api.example.test`, "a bearer token"],
  ["a basic login header", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "a login in an Authorization header"],
  ["an RSA private key", k("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"), "a private key"],
  ["an OpenSSH private key", k("-----BEGIN OPENSSH ", "PRIVATE KEY-----"), "a private key"],
  ["an EC private key", k("-----BEGIN EC ", "PRIVATE KEY-----"), "a private key"],
  ["a PKCS8 private key", k("-----BEGIN ", "PRIVATE KEY-----"), "a private key"],
  ["a PGP private key", k("-----BEGIN PGP ", "PRIVATE KEY BLOCK-----"), "a private key"],
  ["a JWT", k("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), "a signed token (JWT)"],
  ["a password in a database URL", "psql postgres://admin:Hx7rT2pq@db.example.test:5432/app", "a password in a URL"],
  ["a login in curl -u", "curl -u deploy:Tr4ck3r99 https://ci.example.test/api", "a password in a command"],
  ["a long base64 secret", k("Zq8+Xv3/Lp9nRt2W", "m5Kd7Fh1Bs4Gj6Hc0Ny8Ue3Ao"), "a long secret-looking string"],
  ["a bare 32-character random key", k("Q7mZp3Lx9KwR2vT8", "nB5yH1cF6dJ4gS0a"), "a long secret-looking string"],
  ["a key in a link", k("curl 'https://maps.example.test/api/geocode?address=x&key=", "Q7mZp3Lx9KwR2vT8nB5yH1cF6dJ4gS0a", "'"), "a key in a link"],
  ["a signed link", k("curl -O 'https://bucket.example.test/f.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=", HEX64, "'"), "a key in a link"],
  ["a Slack webhook", k("curl -X POST https://hooks.slack.com/services/", "T0A1B2C3D/B0A1B2C3D/", "abcDEF123ghiJKL456mnoPQR"), "a webhook link"],
  ["a Discord webhook", k("https://discord.com/api/webhooks/123456789012345678/", "AbCdEf0123456789-AbCdEf0123456789_AbCdEf0123456789AbCdEf0123456789ab"), "a webhook link"],
  ["a Telegram bot token", k("curl https://api.telegram.org/bot", "123456789:", "AA", "Hx9TcvQ1vGWJxfSeofSAs0K5PALDzz", "/getMe"), "an API key"],
  ["a Supabase secret key", k("sb_", "secret_", "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r"), "an API key"],
  ["a Google client secret", k("GOC", "SPX-", "A1b2C3d4E5f6G7h8J9k0L1m2N3p4"), "an API key"],
  ["a dev password with underscores", "PGPASSWORD=shop_dev_pass psql -h db.example.test", "a password or token"],
  ["a password with symbols", "password: P@ss(w0rd)!", "a password or token"],
  ["a token in a link's query", k("curl 'https://api.example.test/v1/me?access_token=", "EA", "Ab1C2d3E4f5G6h7I8j9K0l1M2n3O4p5Q6r", "&fields=id'"), "a password or token"],
  ["a quoted token", k('TOKEN="', "EA", "Ab1C2d3E4f5G6h7I8j9K0l1M2n3O4p5Q6rS7t8U9v0", '"'), "a password or token"],
];

const clean: [string, string][] = [
  ["a git sha", "git checkout 3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a"],
  ["a short sha range", "git log a1b2c3d..e4f5a6b"],
  ["an image digest", `docker pull registry.example.test/shop@sha256:${HEX64}`],
  ["an uppercase hex checksum", "echo 9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08"],
  ["a version", "npm version 0.22.1 && git tag v0.22.1"],
  ["a pre-release version", "npm publish --tag next 1.4.0-beta.2+build.15"],
  ["a UUID as an id", "trail runs show 123e4567-e89b-12d3-a456-426614174000"],
  ["a UUID in a path", "cat /tmp/sessions/123E4567-E89B-12D3-A456-426614174000/Run.json"],
  ["an uppercase UUID between short path pieces", "cat /srv/v1/9F8E7D6C-5B4A-3C2D-1E0F-A9B8C7D6E5F4/a.json"],
  ["a lowercase UUID in a long path", "ls /home/dev/.trail/sessions/123e4567-e89b-12d3-a456-426614174000.json"],
  ["a source path", "vim /home/dev/shop/src/server/routes/v1/AdminController.ts"],
  ["a placeholder in an export", "export DB_PASSWORD=$DB_PASSWORD"],
  ["a braced placeholder", "API_KEY=${API_KEY:?set API_KEY}"],
  ["an angle placeholder", "TOKEN=<token>"],
  ["a bearer placeholder", 'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.example.test'],
  ["masked", "password: ***"],
  ["an example value", "API_KEY=your_api_key_here"],
  ["changeme", "SECRET=changeme"],
  ["advice, not a token", "token: always in the keychain"],
  ["a token count", "MAX_TOKENS=4096 max_tokens: 8000"],
  ["a token lifetime", "TOKEN_TTL=3600"],
  ["a password rule", "PASSWORD_MIN_LENGTH=12"],
  ["a reference to the environment", "API_KEY = process.env.API_KEY"],
  ["a Python lookup", "token=os.environ['GH_TOKEN']"],
  ["a local database login", "psql postgres://postgres:postgres@localhost:5432/app"],
  ["a local login with a real-looking password", "psql postgres://app:Hx7rT2pq@127.0.0.1:5432/app"],
  ["plain commands", "npm publish --access public && git push origin main && gh pr checks 42 --watch"],
  ["a long identifier", "getS3BucketPolicyForAccountV2AndRegion"],
  ["a library name", "pip install sk-learn-preprocessing-pipeline"],
  ["a dotted class name", "java -cp app.jar com.example.app.v2.PaymentService3Impl"],
  ["a pod name", "kubectl logs web-7d4b9c8f6d-x2k9p"],
  ["a timestamp", "since 2026-10-15T10:00:00.000Z"],
  ["API object ids", "curl https://api.example.test/v1/deployments?teamId=team_a1B2c3D4e5F6g7H8i9J0 && stripe customers retrieve cus_Q7mZp3Lx9KwR2vT8nB"],
  ["a one-time code flag", "npm publish --otp=123456"],
  ["empty", ""],
  ["a sentence about secrets", "Never commit the .env file; the API key lives in the keychain."],
  // Read from somewhere else at run time: the command holds no secret.
  ["a token read from a command", 'TOKEN=$(gh auth token) && curl -H "Authorization: Bearer $TOKEN" https://api.example.test'],
  ["a password read from the keychain", "PGPASSWORD=$(security find-generic-password -s db -w) psql -h db.example.test"],
  ["a key read with backticks", "API_KEY=`cat /home/dev/.config/shop/key` npm run sync"],
  ["a bearer read from a script", "curl -H \"Authorization: Bearer $(python3 mint.py)\" https://api.example.test"],
  ["a length check", 'echo "secret_present=${#SECRET}"'],
  ["a printf format", "printf 'API_KEY=%s\\n' \"$KEY\" >> .env"],
  ["a curl write-out format", "curl -s -o /dev/null -w 'no-token=%{http_code}' https://api.example.test"],
  ["an elided key", "export TRAIL_API_KEY=nn... and run trail init"],
  ["a value that says it is a stand-in", 'SUPABASE_SECRET_KEY="sb_secret_placeholder"'],
  ["a fake key for tests", "GEMINI_API_KEY=fake-key-for-tests npm test"],
  ["another variable's name", 'echo "api_key_rejected=VENDOR_API_KEY"'],
  // Patterns and code that mention a secret's name.
  ["a sed that redacts", "sed -E 's/password=.*/password=***/' app.ini"],
  ["a grep for bearer tokens", "grep -oE 'Bearer [A-Za-z0-9._-]+' access.log"],
  ["a grep for npm tokens", "grep -E '_authToken=(.+)' /home/dev/.npmrc"],
  ["a regex capture", "m=re.search(r'access_token=([^&]*)', url)"],
  ["a schema", "const env = z.object({ OPENAI_API_KEY: z.string().min(1) })"],
  ["a generated id", "const trackingToken = crypto.randomUUID()"],
  ["a type annotation", "function sign(token: string): void {}"],
  ["a comparison", "if (process.env.TRAIL_API_KEY === undefined) throw new Error('missing')"],
  ["an escaped newline", 'python3 -c "self.token = None\\nprint(1)"'],
  // `-u` is not always a login.
  ["a UTC timestamp", "date -u +%Y-%m-%dT%H:%M:%SZ"],
  ["a quoted UTC time", 'NOW=$(date -u "+%H:%M:%S")'],
  ["a user and group id", "docker run --rm -u 1000:1000 -v /home/dev/shop:/app shop:dev npm test"],
  ["a login read at run time", 'curl -u "deploy:$(cat /home/dev/.config/ci-pass)" https://ci.example.test/api'],
  ["test values", "OPENAI_API_KEY=sk-test npm test && curl -H 'Authorization: Bearer test-key' localhost:3000 && API_KEY=invalid_key_for_401 npm run check"],
  ["a destructured name", "const { OPENAI_API_KEY: _omit, ...rest } = env"],
  ["a slice by a name's length", 'const v = raw.slice("TRAIL_API_KEY=".length)'],
  ["a call", "const secret = secretFor(`${repo}`)"],
  ["a call with arguments", "const trackingToken = crypto.randomBytes(16).toString('hex')"],
  ["a grep for a key shape", "grep -E 'Bearer nn[a-f0-9]{64}' access.log"],
  ["a document link without its scheme", "see docs.example.test/d/1Bx7kQ2_mZp3Lx9KwR2vT8nB5yH1cF6dJ4gS0a-Zq8Xv3/edit"],
  // Ids in links and variables: hashes and object ids, not keys.
  ["a sha in a variable", `BASE=${HEX64.slice(0, 40)} && git diff $BASE..HEAD`],
  ["an image file on a CDN", "curl -O https://cdn.example.test/user_2abcDEF3ghiJKL4mnoPQR5stuVW/hf_20261015_a1b2c3d4.png"],
  ["a deployment link", "curl https://api.example.test/v13/deployments/dpl_8xKfR2mNpQ7sT4vW9yZ1aB3cD5eF"],
  ["a document link", "open https://docs.example.test/spreadsheets/d/1GAbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf/edit"],
  ["a share link", "https://share.example.test/artifact/Azy3kLm9PqR2sT8vW1xY4z and https://share.example.test/s/Q7mZp3Lx9KwR2vT8nB5yH1cF6dJ4gS0aZq8Xv3Lp"],
  ["a click id", "https://shop.example.test/page?fbclid=IwY2xjawF0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEfGhIjKlMnOpQrStUv"],
  ["a temp folder", "ls /var/folders/rz/4bn1x2y3z4a5b6c7d8e9f0g1h2i3j4/T/"],
  ["an account id with a hex body", `ACCOUNT=AC${HEX64.slice(0, 32)} && echo $ACCOUNT`],
  ["a product id", "billing products get pdt_A1b2C3d4E5f6G7h8J9k0L"],
  ["an id named after a key", '{"APIKeyID": "k-2026-10-15", "tokenUrl": "https://auth.example.test/t0k3n"}'],
];

test("secrets are found and named", () => {
  for (const [name, text, why] of secrets) assert.equal(secretReason(text), why, `${name}: ${text}`);
});

test("ids, hashes, versions, paths, placeholders and words are not secrets", () => {
  for (const [name, text] of clean) assert.equal(secretReason(text), null, `${name}: ${text}`);
});

test("the reason never repeats the secret", () => {
  for (const [, text] of secrets) {
    const why = secretReason(text)!;
    for (const word of text.split(/[\s'"=:]+/).filter((w) => w.length >= 8 && /\d/.test(w))) assert.ok(!why.includes(word), why);
  }
});

test("a huge text is checked quickly", () => {
  const big = "ok line of build output\n".repeat(40_000) + `TOKEN=${k("Zq8Xv3Lp9n", "Rt2Wm5Kd7F")}`;
  const t0 = performance.now();
  assert.equal(secretReason(big), "a password or token");
  assert.ok(performance.now() - t0 < 500);
});

/** A made-up macOS temp folder (`/var/folders/<2>/<28>0000gn/T/`) and a `mkdtemp`-style name in it, from a fixed seed. */
function tempPaths(count: number): string[] {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (chars: string, n: number) => Array.from({ length: n }, () => chars[Math.floor(rnd() * chars.length)]).join("");
  const low = "abcdefghijklmnopqrstuvwxyz0123456789_";
  const mixed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: count }, (_, i) => {
    const dir = `/var/folders/${pick(low, 2)}/${pick(low, 24)}0000gn/${i % 7 ? "T" : "C"}/`;
    const forms = [
      `${dir}x-${pick(mixed, 6)}`, `cat ${dir}trail-test-${pick(mixed, 6)}/sessions/a.json`, `ls /private${dir}tmp.${pick(mixed, 10)}`,
      `rm -rf ${dir}${pick(mixed, 6)}`, `node --test --test-reporter=dot ${dir}build-${pick(mixed, 6)}/out.js 2>&1 | tail -5`, `cd ${dir.slice(0, -3)}`,
    ];
    return forms[i % forms.length]!;
  });
}

test("D62: macOS temp folder paths are not secrets", () => {
  const flagged = tempPaths(6000).filter((t) => secretReason(t) !== null);
  assert.deepEqual(flagged.slice(0, 5), [], `${flagged.length} of 6000 flagged`);
});

test("D62: a real secret inside a temp folder path is still found", () => {
  const dir = "/var/folders/q_/cvygw2vb7rq41f7mdic22vap0000gn/T/";
  const cases: [string, string][] = [
    [`${dir}${k("gh", "p_", B62)}`, "an API key"],
    [`cat /private${dir}${k("m", "b_", "a1B2c3D4e5F6g7H8i9J0")}.json`, "an API key"],
    [`ls ${dir}${B62}`, "a long secret-looking string"],
    [`TOKEN=${k("Zq8Xv3Lp9n", "Rt2Wm5Kd7F")} node ${dir}x-AbCdEf/run.js`, "a password or token"],
    [`psql postgres://app:${k("hunter", "42xyz")}@db.example.test/app -f ${dir}q.sql`, "a password in a URL"],
  ];
  for (const [text, why] of cases) assert.equal(secretReason(text), why, text);
});
