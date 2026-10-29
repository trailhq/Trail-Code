/**
 * The review screen's keys through a fake TTY (design 4.7): move, tick, see
 * the steps, flip where an item applies, add a preference to the repo, and
 * the three ways out (enter, n, esc/q/Ctrl-C). The screen never keeps
 * anything itself: it says what the person picked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { runScreen } from "../src/init/review-tty.js";
import { factsOf, REPO_KEY, threeItems } from "./init-screen-fixtures.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";

function fakeTty(keys: string[]) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: (b: boolean) => void; isRaw: boolean };
  let raw = false;
  stdin.isTTY = true;
  stdin.setRawMode = (b: boolean) => {
    raw = b;
    return stdin;
  };
  let out = "";
  const stdout = new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.isTTY = true;
  (stdout as { columns?: number }).columns = 200;
  // One key per tick, as a person types.
  let k = 0;
  const next = () => {
    if (k < keys.length) {
      (stdin as unknown as PassThrough).write(keys[k++]!);
      setImmediate(next);
    }
  };
  setImmediate(next);
  return { io: { stdin, stdout }, out: () => out, raw: () => raw };
}

const run = (keys: string[], facts = factsOf()) => {
  const t = fakeTty(keys);
  return runScreen(threeItems(), facts, t.io, { repoKey: REPO_KEY, env: {} }).then((r) => ({ r, out: t.out(), raw: t.raw() }));
};

test("enter keeps what is ticked: the preference starts ticked, space ticks the skill", async () => {
  const { r, raw } = await run([" ", "\r"]);
  assert.equal(r.how, "enter");
  assert.deepEqual(r.ticked.sort(), [1, 3]);
  assert.equal(raw, false, "raw mode is put back");
});

test("arrows move, space unticks; n keeps nothing; esc, q and Ctrl-C decide later", async () => {
  const moved = await run([DOWN, DOWN, " ", UP, UP, UP, "\r"]);
  assert.deepEqual(moved.r.ticked, [], "the preference unticked");
  for (const [keys, how] of [[["n"], "n"], [[ESC], "esc"], [["q"], "esc"], [["\x03"], "esc"]] as const) {
    const { r } = await run([...keys]);
    assert.equal(r.how, how, JSON.stringify(keys));
  }
});

test("s opens a skill's steps in place and esc or s closes it (esc then doesn't leave)", async () => {
  const { r, out } = await run(["s", ESC, "s", "s", "\r"]);
  assert.equal(r.how, "enter");
  assert.match(out, /release-npm · copied from a run that worked on Oct 3/);
  assert.match(out, /1 {2}npm version \{version\}/);
  assert.match(out, /can't be undone/);
  assert.match(out, /check {2}npm view acme-cli version shows \{version\}/);
});

test("s on a guardrail shows its template text", async () => {
  const { out } = await run([DOWN, "s", "\r"]);
  assert.match(out, /This Mac has no `timeout`\. Run long commands in the background/);
});

test("w twice flips a skill to every repo and back; on no-timeout it says why it stays every repo", async () => {
  const once = await run(["w", "\r"]);
  assert.deepEqual(once.r.scopes[1], { applies: "every repo", scope: "personal" });
  assert.match(once.out, /release-npm \(every repo\)/);
  const twice = await run(["w", "w", "\r"]);
  assert.deepEqual(twice.r.scopes[1], { applies: REPO_KEY, scope: "personal" });
  const g = await run([DOWN, "w", "\r"]);
  assert.deepEqual(g.r.scopes[2], { applies: "every repo", scope: "personal" });
  assert.match(g.out, /this Mac has no timeout in any repo, so it stays every repo/);
});

test("r adds a preference to the repo (committed) and back; on a skill or guardrail it says that comes later", async () => {
  const p = await run([DOWN, DOWN, "r", "\r"]);
  assert.deepEqual(p.r.scopes[3], { applies: REPO_KEY, scope: "repo" });
  assert.match(p.out, /\(added to this repo: your team gets it once you commit\)/);
  const back = await run([DOWN, DOWN, "r", "r", "\r"]);
  assert.equal(back.r.scopes[3]!.scope, "personal");
  for (const keys of [["r", "\r"], [DOWN, "r", "\r"]]) {
    const x = await run(keys);
    assert.match(x.out, /adding skills and always-follow learnings to the repo comes in a later version/);
    assert.equal(x.r.scopes[1]!.scope, "personal");
    assert.equal(x.r.scopes[2]!.scope, "personal");
  }
});

test("a closed stdin ends the screen as esc: nothing kept, nothing closed", async () => {
  const t = fakeTty([]);
  setImmediate(() => (t.io.stdin as unknown as PassThrough).end());
  const r = await runScreen(threeItems(), factsOf(), t.io, { repoKey: REPO_KEY, env: {} });
  assert.equal(r.how, "esc");
});
