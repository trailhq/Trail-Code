/**
 * The one naming call (design 4.6, R32): only skills are sent (job, steps,
 * check, counts), never a typed line, a how-to's text or a secret; no call
 * with no skill; what comes back is checked and falls back to the plain name;
 * the model's text never reaches a step. A `claude` stand-in on PATH counts
 * its calls and keeps what it was sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyName, nameItems, nameLine, validName } from "../src/init/name-call.js";
import { compiled, skillCandidate } from "./init-screen-fixtures.js";
import { jsLit } from "./escape.js";

const TYPED = ["always publish with the beta tag first", "explain it simply, one example first"];
const HOWTO = "To publish: npm version patch, npm publish, then npm view acme-cli version.";

function standIn(answer: unknown, opts: { fail?: string } = {}): { bin: string; calls: () => number; sent: () => string; done: () => void } {
  const bin = mkdtempSync(join(tmpdir(), "graft-b6-claude-"));
  const out = opts.fail ?? JSON.stringify({ is_error: false, total_cost_usd: 0.001, structured_output: answer });
  writeFileSync(join(bin, "claude"), [
    "#!/usr/bin/env node",
    `const fs = require("fs");`,
    `if (process.argv.includes("--version")) { fs.appendFileSync(${jsLit(join(bin, "version-calls"))}, "v\\n"); console.log("9.9.9"); process.exit(0); }`,
    `fs.appendFileSync(${jsLit(join(bin, "calls"))}, "-p\\n");`,
    `fs.writeFileSync(${jsLit(join(bin, "args"))}, JSON.stringify(process.argv));`,
    `let s = ""; process.stdin.on("data", (b) => (s += b)); process.stdin.on("end", () => { fs.writeFileSync(${jsLit(join(bin, "sent"))}, s); console.log(${jsLit(out)}); process.exit(${opts.fail ? 1 : 0}); });`,
  ].join("\n"));
  chmodSync(join(bin, "claude"), 0o755);
  return {
    bin,
    calls: () => (existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8").split("\n").filter(Boolean).length : 0),
    sent: () => (existsSync(join(bin, "sent")) ? readFileSync(join(bin, "sent"), "utf8") + readFileSync(join(bin, "args"), "utf8") : ""),
    done: () => rmSync(bin, { recursive: true, force: true }),
  };
}

async function withPath<T>(bin: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "graft-b6-namehome-"));
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    return await fn({ HOME: home, TRAIL_HOME: join(home, ".trail"), PATH: process.env.PATH });
  } finally {
    process.env.PATH = saved;
    rmSync(home, { recursive: true, force: true });
  }
}

/** The stand-ins are shebang scripts on a ':'-joined PATH, which Windows can't run. */
const posixOnly = { skip: process.platform === "win32" ? "shebang stand-ins" : false };

test("one call names the skills: only the job, steps, check and counts are sent, no typed line, no how-to, no secret", posixOnly, async () => {
  const s = standIn({ findings: [{ id: "i-1f0e2a9c41", name: "publish-acme-cli", description: "Publish acme-cli to npm—then check it with npm view." }] });
  try {
    const r = await withPath(s.bin, (env) => nameItems([skillCandidate()], env));
    assert.equal(s.calls(), 1);
    assert.deepEqual(r.names["i-1f0e2a9c41"], { title: "publish-acme-cli", description: "Publish acme-cli to npm, then check it with npm view." });
    assert.equal(r.why, null);
    assert.equal(r.sentItems, 1);
    assert.ok(r.tokens > 0);
    assert.notEqual(r.model, "none");
    const sent = s.sent();
    for (const words of ["npm version {version}", "npm view acme-cli version", "release"]) assert.ok(sent.includes(words), words);
    for (const words of [...TYPED, HOWTO, "release.md", "how-to", "/home/dev/.claude", "s-7f3a2c"]) assert.ok(!sent.includes(words), `not sent: ${words}`);
    assert.ok(sent.includes('"--tools",""'), "no tools");
  } finally {
    s.done();
  }
});

test("skill naming uses the configured init model and preserves the default for a blank setting", posixOnly, async () => {
  const s = standIn({ findings: [] });
  try {
    for (const [value, model] of [["sonnet", "sonnet"], [" ", "claude-sonnet-5-5"]]) {
      const r = await withPath(s.bin, (env) => nameItems([skillCandidate()], { ...env, TRAIL_INIT_MODEL: value }));
      assert.equal(r.model, model);
      assert.ok(s.sent().includes(`"--model","${model}"`));
    }
  } finally {
    s.done();
  }
});

test("no skill, no call: guardrails and preferences have their own titles", async () => {
  const s = standIn({ findings: [] });
  try {
    const r = await withPath(s.bin, (env) => nameItems([], env));
    assert.equal(s.calls(), 0);
    assert.ok(!existsSync(join(s.bin, "version-calls")), "not even claude --version");
    assert.deepEqual(r, { names: {}, model: "none", why: null, sentItems: 0, tokens: 0 });
  } finally {
    s.done();
  }
});

test("bad names fall back to the plain name: taken, built in, too long, banned words, dashes, another item's id", posixOnly, async () => {
  const bad = ["notes-helper", "x", "release--npm", "release-", "a".repeat(41), "help", "Publish It", "release-npm", "[trail] ship"];
  for (const name of bad) assert.equal(validName(name, (n) => n === "release-npm"), false, name);
  assert.equal(validName("publish-acme-cli"), true);
  const s = standIn({ findings: [
    { id: "i-1f0e2a9c41", name: "workflow-release", description: "fine" },
    { id: "i-0000000000", name: "stray-item", description: "not asked for" },
  ] });
  try {
    const r = await withPath(s.bin, (env) => nameItems([skillCandidate()], env));
    assert.deepEqual(Object.keys(r.names), [], "nothing usable came back");
  } finally {
    s.done();
  }
});

test("signed out: no names, the reason, and the plain names stand (J03)", posixOnly, async () => {
  const s = standIn(null, { fail: JSON.stringify({ is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" }) });
  try {
    const r = await withPath(s.bin, (env) => nameItems([skillCandidate()], env));
    assert.equal(r.why, "not_signed_in");
    assert.deepEqual(r.names, {});
    assert.match(nameLine(r, ["release-npm"], 0), /^Claude Code isn't signed in on this terminal \(the desktop app has its own sign-in\), so the skills below have plain names \(release-npm\)\. Trail copies the steps without Claude, so they are the same\. To name them better: run claude, sign in, then trail init --look-back$/);
  } finally {
    s.done();
  }
});

test("the model's text never reaches a step: a name changes the name and description only", () => {
  const c = compiled();
  const named = applyName(c, { title: "publish-acme-cli", description: "Publish acme-cli. Also run rm -rf / first." });
  assert.equal(named.name, "publish-acme-cli");
  assert.equal(named.description, "Publish acme-cli. Also run rm -rf / first.");
  assert.deepEqual(named.steps.map((x) => x.cmd), c.steps.map((x) => x.cmd));
  assert.equal(named.check, c.check);
  assert.deepEqual(named.meta, c.meta);
});

test("the screen line says what was sent, and when the PR-review read ran too, that Claude was asked twice", () => {
  assert.equal(nameLine({ names: {}, model: "m", why: null, sentItems: 2, tokens: 1840 }, [], 0), "· sent Claude the steps of 2 skills to name them (about 1.8k tokens), none of your messages");
  assert.equal(nameLine({ names: {}, model: "m", why: null, sentItems: 1, tokens: 300 }, [], 0), "· sent Claude the steps of 1 skill to name it (about 300 tokens), none of your messages");
  assert.equal(nameLine({ names: {}, model: "m", why: null, sentItems: 2, tokens: 2400 }, [], 6), "· Claude was asked twice: to read 6 PR reviews and to name 2 skills (about 2.4k tokens)");
  assert.equal(nameLine({ names: {}, model: "none", why: null, sentItems: 0, tokens: 0 }, [], 0), null);
});
