/**
 * `trail init`'s look-back from start to end in 1b (design 0 rule 4, 4.6 to
 * 4.9, R17, R25, R60): who may start `claude`, an agent's run relaying with
 * plain names and never starting `claude` (a stand-in on PATH counts its
 * calls), the person's script getting the list without the agent's line and
 * `--yes` keeping only their own words, and the person's screen naming,
 * showing and keeping. Synthetic sessions only (b5's acme/shop world).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { agentRun, beginLookBack, finishLookBack, mayCallClaude } from "../src/init/run.js";
import { readInitRecord } from "../src/init/init-record.js";
import { RELAY_LINE } from "../src/init/relay.js";
import { repoPlace } from "../src/notes/home.js";
import type { PsRow } from "../src/skills/person.js";
import { day, done, releaseJob, Tx, world, type World } from "./init-mine-fixtures.js";
import { jsLit } from "./escape.js";

const ME = 4242;
/** A process table with no claude and no pty wrapper above this process, or with one. */
const table = (ancestor?: string): PsRow[] => [
  { pid: 1, ppid: 0, comm: "/sbin/launchd", args: "/sbin/launchd" },
  { pid: 10, ppid: 1, comm: ancestor ?? "/bin/zsh", args: ancestor ?? "-zsh" },
  { pid: ME, ppid: 10, comm: "node", args: "node trail init" },
];
const deps = (tty: boolean, ancestor?: string) => ({ stdinTTY: tty, stdoutTTY: tty, ps: () => table(ancestor), pid: ME });

test("mayCallClaude: only the person at their own terminal, look-back on, without --plain (0 rule 4)", () => {
  assert.equal(mayCallClaude({}, { plain: false }, deps(true)), true);
  assert.equal(mayCallClaude({}, { plain: false }, deps(false)), false, "no TTY");
  assert.equal(mayCallClaude({ CLAUDECODE: "1" }, { plain: false }, deps(true)), false, "CLAUDECODE");
  assert.equal(mayCallClaude({}, { plain: false }, deps(true, "claude")), false, "a claude ancestor");
  assert.equal(mayCallClaude({}, { plain: false }, deps(true, "/usr/bin/script")), false, "a pty wrapper ancestor");
  assert.equal(mayCallClaude({ TRAIL_NO_LOOK_BACK: "1" }, { plain: false }, deps(true)), false, "TRAIL_NO_LOOK_BACK");
  assert.equal(mayCallClaude({}, { plain: true }, deps(true)), false, "--plain");
  assert.equal(mayCallClaude({}, { plain: false }, { stdinTTY: true, stdoutTTY: true, ps: () => null, pid: ME }), false, "an unreadable process table is no");
});

test("agentRun: CLAUDECODE or a claude/pty ancestor, with or without a TTY; the person's own script is not an agent (R17)", () => {
  assert.equal(agentRun({ CLAUDECODE: "1" }, deps(true)), true);
  assert.equal(agentRun({ CLAUDECODE: "1" }, deps(false)), true);
  assert.equal(agentRun({}, deps(false, "claude")), true);
  assert.equal(agentRun({}, deps(true, "expect")), true);
  assert.equal(agentRun({}, deps(false)), false, "a script the person runs");
  assert.equal(agentRun({}, deps(true)), false);
});

/* ---- the whole flow, in process, on b5's synthetic acme/shop ---- */

const PREF = "always run the lint script before you push";

/** Releases on 3 days (2 costly), a typed preference on 2 days, `timeout` missing on 2 days. */
function history(w: World): void {
  const a = new Tx(w.repo);
  releaseJob(a, 1, "1.0.1", { failedFirst: true });
  a.typed(day(1, 12), PREF);
  a.typed(day(1, 13), "time box the build").bash(day(1, 13, 1), "timeout 60 npm run build", "zsh:1: command not found: timeout", { isError: true });
  const b = new Tx(w.wt);
  releaseJob(b, 3, "1.0.3", { failedFirst: true });
  b.typed(day(3, 12), "always run the lint script before pushing");
  b.typed(day(3, 13), "time box the tests").bash(day(3, 13, 1), "timeout 60 npm test", "zsh:1: command not found: timeout", { isError: true });
  const c = new Tx(w.repo);
  releaseJob(c, 5, "1.0.5");
  a.write(w.home, "s-a");
  b.write(w.home, "s-b");
  c.write(w.home, "s-c");
}

function standIn(): { bin: string; calls: () => number; versions: () => boolean } {
  const bin = mkdtempSync(join(tmpdir(), "graft-b6-runclaude-"));
  const answer = JSON.stringify({ is_error: false, structured_output: { findings: [] } });
  writeFileSync(join(bin, "claude"), [
    "#!/usr/bin/env node",
    `const fs = require("fs");`,
    `if (process.argv.includes("--version")) { fs.appendFileSync(${jsLit(join(bin, "version-calls"))}, "v\\n"); console.log("9.9.9"); process.exit(0); }`,
    `fs.appendFileSync(${jsLit(join(bin, "calls"))}, "-p\\n");`,
    `process.stdin.resume(); process.stdin.on("end", () => { const s = ${jsLit(answer)}; console.log(s); });`,
  ].join("\n"));
  chmodSync(join(bin, "claude"), 0o755);
  return {
    bin,
    calls: () => (existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8").split("\n").filter(Boolean).length : 0),
    versions: () => existsSync(join(bin, "version-calls")),
  };
}

async function inWorld<T>(tag: string, fn: (w: World, env: NodeJS.ProcessEnv, claude: ReturnType<typeof standIn>) => Promise<T>): Promise<T> {
  const w = world(`b6-${tag}`);
  history(w);
  const claude = standIn();
  const saved = { trail: process.env.TRAIL_HOME, path: process.env.PATH, dnt: process.env.DO_NOT_TRACK };
  process.env.TRAIL_HOME = w.trail;
  process.env.PATH = `${claude.bin}${delimiter}${saved.path}`;
  process.env.DO_NOT_TRACK = "1";
  try {
    // No `timeout` on this env's PATH (the guardrail is still true), only the stand-in; no fetches (no gh).
    return await fn(w, { HOME: w.home, TRAIL_HOME: w.trail, PATH: claude.bin, TRAIL_NO_FETCH: "1", DO_NOT_TRACK: "1" }, claude);
  } finally {
    for (const [k, v] of [["TRAIL_HOME", saved.trail], ["PATH", saved.path], ["DO_NOT_TRACK", saved.dnt]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    done(w);
    rmSync(claude.bin, { recursive: true, force: true });
  }
}

const skillsOn = (env: NodeJS.ProcessEnv) => writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: "on" }));

/** Every file under a folder, as text. */
function texts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : out.push(readFileSync(join(d, e.name), "utf8")));
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

test("an agent's init looks back without a model and relays: a claude stand-in on PATH is never started (P2, J02)", async () => {
  await inWorld("agent", async (w, env, claude) => {
    skillsOn(env);
    const said: string[] = [];
    const agentEnv = { ...env, CLAUDECODE: "1" };
    const { reads, lines } = beginLookBack(w.repo, { env: agentEnv, deps: deps(false) });
    assert.deepEqual(lines, ["· looking back at your past Claude Code sessions here (about a minute)"]);
    const r = await finishLookBack(w.repo, reads, { yes: false, say: (l) => said.push(l) });
    assert.equal(r.kept, 0);
    assert.equal(claude.calls(), 0);
    assert.equal(claude.versions(), false, "not even claude --version");
    const out = said.join("\n");
    assert.match(out, /names are plain: to name them with Claude, run trail init --look-back in your own terminal/);
    assert.ok(said.includes(RELAY_LINE));
    assert.match(out, /^1\. release-npm \(skill, this repo only\)\n   Claude worked out how to publish shop to npm from scratch on 3 different days\.$/m);
    assert.match(out, /^2\. no-timeout \(always-follow learning, every repo\)\n   Claude won't use the timeout command, which this Mac doesn't have\.\n   Claude's commands failed with "timeout: command not found" on 2 days\.$/m);
    assert.match(out, /^3\. "always run the lint script before pushing" \(learning in your own words, this repo only\)\n   You said this on 2 days\.$/m, "the shortest of the person's lines");
    const rec = readInitRecord(repoPlace(w.repo, env).key, env);
    assert.deepEqual(rec.pending.map((p) => [p.n, p.kind]), [[1, "skill"], [2, "guardrail"], [3, "preference"]]);
    // For init --pair's page: the skill found, by name and day count, never its steps; nothing kept.
    assert.deepEqual(r.skills?.map((s) => [s.name, s.title, s.days]), [["release-npm", "release-npm", 3]]);
    assert.doesNotMatch(JSON.stringify(r.skills), /npm publish|npm run build/);
    assert.equal(rec.runs[0]!.by, "agent");
    assert.equal(rec.runs[0]!.modelWhy, "agent");
    for (const t of texts(w.trail)) for (const words of [PREF, "before pushing", "lint script", "npm publish", "npm run build", "time box"]) assert.ok(!t.includes(words), `no "${words}" on disk`);
  });
});

test("an agent's --yes keeps nothing and says so (R25); the person's script's --yes keeps only their own words (B5)", async () => {
  await inWorld("yes", async (w, env, claude) => {
    skillsOn(env);
    const said: string[] = [];
    const a = beginLookBack(w.repo, { env: { ...env, CLAUDECODE: "1" }, deps: deps(false) });
    const ra = await finishLookBack(w.repo, a.reads, { yes: true, say: (l) => said.push(l) });
    assert.equal(ra.kept, 0);
    assert.ok(said.includes("found 1 skill, 1 always-follow learning and 1 learning. Kept nothing: an agent ran this. The person picks with trail keep <numbers> after seeing the list, or trail init --look-back in their own terminal"));
    assert.ok(!existsSync(join(w.trail, "learnings")));

    const script: string[] = [];
    const s = beginLookBack(w.repo, { env, deps: deps(false), again: true });
    const rs = await finishLookBack(w.repo, s.reads, { yes: true, say: (l) => script.push(l) });
    assert.equal(rs.kept, 1);
    assert.equal(claude.calls(), 0, "no TTY: no naming call");
    assert.ok(script.includes("found 1 skill, 1 always-follow learning and 1 learning. Kept only the learnings in your own words. To pick the rest: trail init --look-back"));
    assert.ok(!script.includes(RELAY_LINE), "no agent line for the person's own script (B9)");
    assert.equal(script[script.length - 1], "Pick in a terminal: trail init");
    const files = readdirSync(join(w.trail, "repos"), { recursive: true }).map(String).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 1, "the preference names the lint script: this repo");
    const rec = readInitRecord(repoPlace(w.repo, env).key, env);
    assert.deepEqual(rec.pending.map((p) => p.kind), ["skill", "guardrail"], "the rest wait");
  });
});

function fakeTty(keys: string[]) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: (b: boolean) => unknown };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  let out = "";
  const stdout = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.isTTY = true;
  let k = 0;
  const next = () => {
    if (k < keys.length) {
      (stdin as unknown as PassThrough).write(keys[k++]!);
      setTimeout(next, 5);
    }
  };
  setTimeout(next, 50);
  return { io: { stdin, stdout }, out: () => out };
}

/** The naming call's stand-in is a shebang script, which Windows can't run. */
const posixOnly = { skip: process.platform === "win32" ? "shebang stand-ins" : false };

test("the person at their terminal: one naming call, the screen, and enter keeps the ticked items (J01)", posixOnly, async () => {
  await inWorld("person", async (w, env, claude) => {
    skillsOn(env);
    const said: string[] = [];
    const t = fakeTty([" ", "\r"]);
    const { reads } = beginLookBack(w.repo, { env, deps: deps(true) });
    assert.equal(reads.model, true);
    const r = await finishLookBack(w.repo, reads, { yes: false, say: (l) => said.push(l), io: t.io });
    assert.equal(claude.calls(), 1, "one naming call");
    assert.match(t.out(), /· sent Claude the steps of 1 skill to name it \(about [\d.k]+ tokens\), none of your messages/);
    assert.match(t.out(), /\[x\] 3 {2}"always run the lint script before pushing"/);
    assert.equal(r.kept, 2, "the ticked skill and the preference");
    assert.match(said.filter((l) => !l.startsWith("· still"))[0]!, /^✓ kept 2, just for you · in ~\/\.trail, never committed, never uploaded$/);
    assert.ok(said.includes("Not kept: no-timeout. Trail won't bring it up again."));
    assert.ok(existsSync(join(w.trail, "skills", "release-npm", "SKILL.md")));
    const rec = readInitRecord(repoPlace(w.repo, env).key, env);
    assert.deepEqual(rec.pending, []);
    assert.equal(rec.closed.length, 1);
    assert.deepEqual(rec.notice?.items.map((x) => x.kind), ["skill", "preference"]);
    // A closed item and a kept one never come back on --look-back (D46).
    const again: string[] = [];
    const t2 = fakeTty(["\r"]);
    const b = beginLookBack(w.repo, { env, deps: deps(true), again: true });
    await finishLookBack(w.repo, b.reads, { yes: false, say: (l) => again.push(l), io: t2.io });
    assert.doesNotMatch(t2.out(), /release-npm|no-timeout|lint script/);
  });
});

test("esc defers: nothing kept or closed, the items wait for the person's next init, and an agent's init never shows them (B5, P37)", async () => {
  await inWorld("esc", async (w, env) => {
    skillsOn(env);
    const said: string[] = [];
    const t = fakeTty(["\x1b"]);
    const { reads } = beginLookBack(w.repo, { env, deps: deps(true), plain: true });
    await finishLookBack(w.repo, reads, { yes: false, say: (l) => said.push(l), io: t.io });
    assert.deepEqual(said.filter((l) => !l.startsWith("· still")), ["kept nothing · they wait until you run trail init again"]);
    const rec = readInitRecord(repoPlace(w.repo, env).key, env);
    assert.equal(rec.deferred.length, 3);
    assert.deepEqual(rec.closed, []);
    const agent: string[] = [];
    const a = beginLookBack(w.repo, { env: { ...env, CLAUDECODE: "1" }, deps: deps(false) });
    await finishLookBack(w.repo, a.reads, { yes: true, say: (l) => agent.push(l) });
    assert.doesNotMatch(agent.join("\n"), /release-npm|no-timeout|lint script/, "deferred items are not the agent's to show");
  });
});

test("with skills off: no skill item, and init ends saying how to turn them on (R60)", async () => {
  await inWorld("off", async (w, env) => {
    writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: "off" }));
    const said: string[] = [];
    const { reads } = beginLookBack(w.repo, { env: { ...env, CLAUDECODE: "1" }, deps: deps(false) });
    await finishLookBack(w.repo, reads, { yes: false, say: (l) => said.push(l) });
    assert.doesNotMatch(said.join("\n"), /\(skill\)/);
    assert.equal(said[said.length - 1], "skills are off · trail skills on lets init also find repeated jobs and keep their steps");
  });
});

test("offers off: the screen's end says so with the day, and init never writes settings.json (J09)", async () => {
  await inWorld("offers-off", async (w, env) => {
    const file = join(w.trail, "settings.json");
    writeFileSync(file, JSON.stringify({ v: 1, skills: "on", offers: "off", offersOffAt: "2026-10-09T10:00:00.000Z" }));
    const before = readFileSync(file);
    const said: string[] = [];
    const t = fakeTty(["\r"]);
    const { reads } = beginLookBack(w.repo, { env, deps: deps(true), plain: true });
    await finishLookBack(w.repo, reads, { yes: false, say: (l) => said.push(l), io: t.io });
    assert.ok(said.some((l) => /^skill offers are off \(you turned them off on .+\) · trail skills offers on$/.test(l)), said.join("\n"));
    assert.ok(!said.some((l) => l.startsWith("skills: on")));
    assert.deepEqual(readFileSync(file), before, "byte-equal");
  });
});
