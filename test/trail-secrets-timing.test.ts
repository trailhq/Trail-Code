/**
 * The secret check runs on every save and in hooks, so a long text built to
 * make one of its patterns backtrack must still be checked in milliseconds.
 * Each text below is 50 to 200 KB of one shape that took seconds (or never
 * finished) before the patterns were bounded: a long run every position of
 * which starts a match, a prefix repeated inside one run, a value that holds
 * the next name, a bracket with no end. The verdicts are the ones the old
 * patterns gave on a 4 KB text of the same shape.
 *
 * Synthetic text only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { secretReason } from "../src/notes/secrets.js";
import { slowness } from "./machine-speed.js";

const KB = 1024;
const rep = (s: string, bytes: number) => s.repeat(Math.ceil(bytes / s.length));

const shapes: [string, string, string | null][] = [
  ["a long run of one letter", "a".repeat(200 * KB), null],
  ["a long run of letters and digits", rep("a1", 100 * KB), null],
  ["sk- then a long run of dashes", "sk-" + "-".repeat(100 * KB), null],
  ["sk- repeated in one run", rep("sk-", 100 * KB), null],
  ["sb_secret_ repeated in one run", rep("-sb_secret_", 100 * KB), null],
  ["eyJ repeated in one run", rep("eyJ-", 100 * KB), null],
  ["a. repeated (a link's host and scheme)", rep("a.", 100 * KB), null],
  ["a- repeated", rep("a-", 100 * KB), null],
  ["a+ repeated (a link's scheme)", rep("a+", 100 * KB), null],
  ["a scheme then a long path", "x://" + rep("a/", 200 * KB), null],
  ["?key= repeated in a link", "https://x.test/" + rep("?key=", 100 * KB), "a key in a link"],
  ["&key= repeated in a link", "https://x.test/p" + rep("&key=abcdefgh", 100 * KB), null],
  ["a value that holds the next name, repeated", rep("token=/", 100 * KB), null],
  ["a secret's name repeated", rep("token ", 100 * KB), null],
  ["a name after a brace, repeated", rep("{ token ", 100 * KB), null],
  ["a bracket that never ends, with ranges in it", "token=a[" + rep("a-", 100 * KB), null],
  ["brackets that never end", "token=a" + "[".repeat(100 * KB), null],
  ["a bearer value with an open bracket", "bearer a[" + rep("a-", 100 * KB), null],
  ["a private key header that never ends", "-----BEGIN " + rep("A ", 100 * KB), null],
  ["SG. then a long run", "SG." + "a".repeat(100 * KB), null],
  ["a bot token prefix repeated", rep("123456:AA", 100 * KB), null],
  ["-u then a long user", " -u " + "a".repeat(100 * KB), null],
  ["a link login with a long password and no host", "x://u:" + "p".repeat(100 * KB), null],
  ["a host with no end", rep("a-a.", 100 * KB) + "b", null],
  ["a long base64-looking run", rep("Ab1+", 50 * KB), "a long secret-looking string"],
  ["a long hex run with a letter at the end", "a".repeat(100 * KB) + "Z", null],
  ["a secret flag repeated", rep(" --token=/", 100 * KB), null],
  ["github_pat_ with short bodies", rep("-github_pat_x", 100 * KB), null],
  ["a temp folder repeated", rep("/var/folders/ab/", 100 * KB), null],
  ["plain words", rep("the quick brown fox jumps over the lazy dog ", 100 * KB), null],
];

/**
 * The fastest of up to three runs, with its verdict: one GC pause or a busy
 * CPU is not a slow pattern, and a slow pattern is slow every time (so a run
 * over a second is not tried again).
 */
function timed(text: string): { ms: number; why: string | null } {
  let ms = Infinity;
  let why: string | null = null;
  for (let i = 0; i < 3 && (i === 0 || (ms >= 50 * slowness() && ms < 1000)); i++) {
    const t0 = performance.now();
    why = secretReason(text);
    ms = Math.min(ms, performance.now() - t0);
  }
  return { ms, why };
}

secretReason("warm up: sk-abc token=x https://x.test/?key=y eyJ.a [a-z]");

for (const [name, text, why] of shapes) {
  test(`${name} (${Math.round(text.length / KB)} KB) is checked in under 50 ms`, () => {
    const run = timed(text);
    assert.equal(run.why, why, name);
    // 50 ms where the bar was set, scaled to this machine: a backtracking pattern takes seconds here, on any machine.
    const bar = 50 * slowness();
    assert.ok(run.ms < bar, `${name}: ${run.ms.toFixed(1)} ms, over ${bar.toFixed(1)} ms`);
  });
}

/** A made-up key, from pieces, so the source holds nothing that looks like one. */
const k = (...parts: string[]) => parts.join("");

test("the bounded checks still find what they found before", () => {
  const cases: [string, string | null][] = [
    // A key prefix after other key characters, and a second prefix in the same run.
    [k("deploy-s", "k-proj-", "Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z"), "an API key"],
    [k("s", "k-x-s", "k-proj-", "Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z"), "an API key"],
    [k("x-sb_", "secret_", "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r"), "an API key"],
    ["pip install sk-learn-preprocessing-pipeline-extras", null],
    // A JWT after a dash, and one whose first part starts another eyJ.
    [k("t-ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), "a signed token (JWT)"],
    [k("ey", "J-eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), "a signed token (JWT)"],
    // A value that is a pattern: a bracket with a range, after other text and after an earlier bracket.
    ["token=x[a-z0-9]+", null],
    ["token=x[[a-z0-9]+", null],
    ["token=x[ab][c-d]", null],
    // Links with a longer scheme, a login in one, and a key in a link's query.
    [k("git clone git+ssh://deploy:", "Hx7rT2pq", "@git.example.test/shop.git"), "a password in a URL"],
    [k("open chrome-extension://abcdefghijklmnop/options.html?key=", "Q7mZp3Lx9KwR2vT8nB5yH1cF6dJ4gS0a"), "a key in a link"],
    ["see a.b.c.docs.example.test/d/1Bx7kQ2_mZp3Lx9KwR2vT8nB5yH1cF6dJ4gS0a-Zq8Xv3/edit", null],
    // A secret assigned to a name, after the name repeats inside a value.
    [k("TOKEN=/x/token=", "Q7mZp3Lx9KwR2"), "a password or token"],
    // A long assigned value: a long real token is still a token, a long path is still a path.
    [k("AWS_SESSION_TOKEN=", rep("Fq3Zx9Lm2Kp7Wn4Rt8Vb1Yc6Hd5Gj0", 600)), "a password or token"],
    [k("TOKEN=/home/dev/", rep("cache/", 100), "t.json"), null],
  ];
  for (const [text, why] of cases) assert.equal(secretReason(text), why, text.slice(0, 120));
});
