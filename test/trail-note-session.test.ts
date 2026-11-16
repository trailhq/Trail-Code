/**
 * One learning per session: a long session that saves three times leaves one
 * file, the three saves folded into it section by section. A save on another
 * branch (another PR) or from another session starts a new file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNote } from "../src/notes/notes.js";
import { mergeBodies } from "../src/notes/session-learning.js";
import { homeEnv, tmpRepo } from "./helpers.js";

function run(args: string[], home: string, input: string, session?: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    input,
    encoding: "utf8",
    env: { ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_HOME: undefined, CLAUDE_CODE_SESSION_ID: session },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function shop(): { repo: string; home: string } {
  const repo = tmpRepo("note-session");
  const git = (...a: string[]) => spawnSync("git", a, { cwd: repo });
  git("init", "-q");
  git("config", "user.name", "Kumar S");
  writeFileSync(join(repo, "cart.ts"), "export function lineTotal(qty: number, cents: number) { return qty * cents; }\n");
  writeFileSync(join(repo, "price.ts"), "export function applyDiscount(cents: number, pct: number) { return cents - (cents * pct) / 100; }\n");
  git("add", "-A");
  git("-c", "user.email=k@example.com", "commit", "-qm", "shop");
  git("checkout", "-qb", "fix-rounding");
  return { repo, home: mkdtempSync(join(tmpdir(), "note-session-home-")) };
}

const files = (repo: string) => readdirSync(join(repo, ".trail", "learnings")).filter((f) => f.endsWith(".md")).sort();
const SESSION = "3f1c9a2e-5b7d-4e8a-9c1f-2d6b8e4a7c10";
const FIRST = "## Decided\n- lineTotal in cart.ts works in whole cents, because rounding each line drifted by a cent.\n";
const SECOND = "## Decided\n- lineTotal in cart.ts works in whole cents, because rounding each line drifted by a cent.\n- Round once at checkout, so nothing rounds twice.\n## Tried and ruled out\n- Floats with toFixed(2): 0.1 + 0.2 still drifted.\n";
const THIRD = "## Watch out\n- applyDiscount in price.ts runs before tax, otherwise tax is charged on the full price.\n";

test("three saves in one session leave one learning, with all three in it", () => {
  const { repo, home } = shop();
  const first = run(["note", repo, "--title", "Cart totals stay in whole cents", "--touches", "cart.ts"], home, FIRST, SESSION);
  assert.equal(first.status, 0, first.err);
  const [name] = files(repo);
  const id = parseNote(readFileSync(join(repo, ".trail", "learnings", name!), "utf8"), name!)!.id;

  const second = run(["note", repo, "--title", "Rounding happens once", "--touches", "cart.ts"], home, SECOND, SESSION);
  assert.equal(second.status, 0, second.err);
  assert.match(second.out, /^✓ added to the learning this session already saved · /m);
  const third = run(["note", repo, "--title", "Discounts come before tax", "--touches", "price.ts"], home, THIRD, SESSION);
  assert.equal(third.status, 0, third.err);

  assert.deepEqual(files(repo), [name], "one file for the session");
  const n = parseNote(readFileSync(join(repo, ".trail", "learnings", name!), "utf8"), name!)!;
  assert.equal(n.id, id, "its id stays, so --replaces still finds it");
  assert.equal(n.title, "Cart totals stay in whole cents");
  assert.deepEqual(n.touches, ["cart.ts", "price.ts"]);
  assert.equal(
    n.body,
    "## Decided\n- lineTotal in cart.ts works in whole cents, because rounding each line drifted by a cent.\n- Round once at checkout, so nothing rounds twice.\n\n" +
      "## Tried and ruled out\n- Floats with toFixed(2): 0.1 + 0.2 still drifted.\n\n" +
      "## Watch out\n- applyDiscount in price.ts runs before tax, otherwise tax is charged on the full price.",
  );
});

test("a save on another branch, from another session, or with no session starts a new file", () => {
  const { repo, home } = shop();
  assert.equal(run(["note", repo, "--title", "Cart totals stay in whole cents", "--touches", "cart.ts"], home, FIRST, SESSION).status, 0);
  spawnSync("git", ["checkout", "-qb", "discount-order"], { cwd: repo });
  const pr2 = run(["note", repo, "--title", "Discounts come before tax", "--touches", "price.ts"], home, THIRD, SESSION);
  assert.equal(pr2.status, 0, pr2.err);
  assert.match(pr2.out, /^✓ added to this repo · /m);
  assert.equal(files(repo).length, 2, "a new PR's branch gets its own learning");

  const other = run(["note", repo, "--title", "Checkout rounds half up", "--touches", "cart.ts"], home, "## Decided\n- cart.ts rounds half up, because the payment provider does.\n", "another-session");
  assert.equal(other.status, 0, other.err);
  assert.equal(files(repo).length, 3, "another session's save is its own learning");

  const none = run(["note", repo, "--title", "Floats drift in totals", "--touches", "cart.ts"], home, "## Tried and ruled out\n- toFixed(2) in cart.ts drifted on 0.1 + 0.2.\n");
  assert.equal(none.status, 0, none.err);
  assert.equal(files(repo).length, 4, "with no session to go by, every save is a new file as before");
});

test("a later save adds what's new under the same headings, and a line already there isn't written twice", () => {
  assert.equal(
    mergeBodies("Intro.\n\n## Decided\n- A, because B.\n", "## decided\n- A, because B.\n- C.\n\n## Watch out\n- D.\n"),
    "Intro.\n\n## Decided\n- A, because B.\n- C.\n\n## Watch out\n- D.",
  );
});
