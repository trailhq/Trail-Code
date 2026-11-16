/**
 * `trail keep`'s CLI half (design 4.9, R23, R24, B5): it keeps only with the
 * receipt its PreToolUse half wrote, reads the list, the reply and the typed
 * answer again from the very transcript the hooks read, uses the receipt
 * once, and keeps a relayed skill only when its source compiles again to the
 * same sha. Synthetic sessions only (b5's acme/shop world).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keepCommand, KEEP_AT_TTY, KEEP_HELD, KEEP_NOTHING_WAITS } from "../src/init/keep.js";
import { keepDecision, keepReceiptPath } from "../src/init/keep-gate.js";
import { readInitRecord, updateInitRecord } from "../src/init/init-record.js";
import { beginLookBack, finishLookBack } from "../src/init/run.js";
import { repoPlace } from "../src/notes/home.js";
import { sessionPath } from "../src/trace/gate-file.js";
import { day, done, folderOf, releaseJob, Tx, world, type World } from "./init-mine-fixtures.js";
import { jsonl, said, toolResult, toolUse, typed } from "./trace-fixtures.js";

const SESSION = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const PS = () => [{ pid: 1, ppid: 0, comm: "/sbin/launchd", args: "" }, { pid: 9, ppid: 1, comm: "/bin/zsh", args: "-zsh" }, { pid: 77, ppid: 9, comm: "node", args: "node" }];

function history(w: World): void {
  const a = new Tx(w.repo);
  releaseJob(a, 1, "1.0.1", { failedFirst: true });
  a.typed(day(1, 12), "never use em dashes in the copy");
  a.typed(day(1, 13), "time box the build").bash(day(1, 13, 1), "timeout 60 npm run build", "zsh:1: command not found: timeout", { isError: true });
  const b = new Tx(w.wt);
  releaseJob(b, 3, "1.0.3", { failedFirst: true });
  b.typed(day(3, 12), "never use em dashes in the copy please");
  b.typed(day(3, 13), "time box the tests").bash(day(3, 13, 1), "timeout 60 npm test", "zsh:1: command not found: timeout", { isError: true });
  const c = new Tx(w.repo);
  releaseJob(c, 5, "1.0.5");
  a.write(w.home, "s-a");
  b.write(w.home, "s-b");
  c.write(w.home, "s-c");
}

interface Ctx { w: World; env: NodeJS.ProcessEnv; repoKey: string; listText: string; reply: string }

/** An agent ran trail init in acme/shop: the relay printed, pending written. */
async function relayed(w: World): Promise<Ctx> {
  const env = { HOME: w.home, TRAIL_HOME: w.trail, PATH: "/nonexistent", TRAIL_NO_FETCH: "1", DO_NOT_TRACK: "1" };
  writeFileSync(join(w.trail, "settings.json"), JSON.stringify({ v: 1, skills: "on" }));
  const said: string[] = [];
  const { reads } = beginLookBack(w.repo, { env: { ...env, CLAUDECODE: "1" }, deps: { stdinTTY: false, stdoutTTY: false, ps: PS, pid: 77 } });
  await finishLookBack(w.repo, reads, { yes: false, say: (l) => said.push(l) });
  const listText = said.filter((l) => !l.startsWith("· still")).join("\n");
  const reply = "From Trail's look-back:\n1. release-npm (skill)\n2. no-timeout (guardrail)\n3. \"never use em dashes in the copy\" (your own words)\nWhich numbers should I keep?";
  return { w, env, repoKey: repoPlace(w.repo, env).key, listText, reply };
}

/** The keep session's transcript where Claude Code keeps it, and the hooks' cursor on it (receiptTranscriptRead). */
function keepSession(c: Ctx, answer: string, extra: object[] = []): string {
  const dir = join(c.w.home, ".claude", "projects", folderOf(c.w.repo));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SESSION}.jsonl`);
  const at = { cwd: c.w.repo, sessionId: SESSION };
  writeFileSync(path, jsonl([
    typed("set up trail here", at), toolUse("tu1", "Bash", { command: "trail init --agents claude" }, at), toolResult("tu1", c.listText, undefined, at),
    said(c.reply, at), ...extra, typed(answer, at),
  ]));
  const st = statSync(path);
  const state = sessionPath(SESSION, ".json", c.env);
  mkdirSync(join(state, ".."), { recursive: true });
  writeFileSync(state, JSON.stringify({ trace: { dev: st.dev, ino: st.ino } }));
  return path;
}

const gate = (c: Ctx, path: string, command: string) =>
  keepDecision({ session_id: SESSION, transcript_path: path, cwd: c.w.repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_k1", tool_input: { command } }, c.w.repo, c.env);

async function inWorld(tag: string, fn: (c: Ctx) => Promise<void> | void): Promise<void> {
  const w = world(`b6-${tag}`);
  history(w);
  const saved = process.env.TRAIL_HOME;
  process.env.TRAIL_HOME = w.trail;
  try {
    await fn(await relayed(w));
  } finally {
    if (saved === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = saved;
    done(w);
  }
}

test("the relayed list kept with the receipt: the skill compiles again, the guardrail and the person's line are written, the receipt is used once", async () => {
  await inWorld("keep-all", (c) => {
    const path = keepSession(c, "keep all");
    assert.equal(gate(c, path, "trail keep all"), null);
    const r = keepCommand(["all"], c.env, new Date(), { dir: c.w.repo, tty: false });
    assert.equal(r.code, 0, r.lines.join("\n"));
    assert.match(r.lines[0]!, /^✓ kept 3, just for you/);
    assert.ok(existsSync(join(c.w.trail, "skills", "release-npm", "SKILL.md")), "compiled again from the source range");
    assert.ok(existsSync(join(c.w.trail, "learnings", "no-timeout.md")));
    assert.ok(JSON.parse(readFileSync(keepReceiptPath(SESSION, c.env), "utf8")).usedAt, "used");
    assert.deepEqual(readInitRecord(c.repoKey, c.env).pending, []);
    // The same list waiting again (an edit to the record) can't be kept with the used receipt.
    const rec = readInitRecord(c.repoKey, c.env);
    updateInitRecord(c.repoKey, (x) => {
      x.pending = [{ n: 2, id: "i-77b10e3d02", kind: "guardrail", key: "wall:timeout-missing", plainName: "no-timeout", nameWords: ["no-timeout"], count: { days: 2, from: "2026-09-01", to: "2026-09-03" }, applies: "every repo", scope: "personal", typed: false, ticked: false, guardrail: { cls: "timeout-missing", check: "no-timeout" } }];
      x.pendingFrom = rec.runs[0]!.id;
    }, c.env);
    assert.deepEqual(keepCommand(["2"], c.env, new Date(), { dir: c.w.repo, tty: false }).lines, [KEEP_HELD]);
  });
});

test("no receipt: nothing kept, with its words; at a TTY it points to the screen; with nothing waiting it says so", async () => {
  await inWorld("keep-none", (c) => {
    assert.deepEqual(keepCommand(["1"], c.env, new Date(), { dir: c.w.repo, tty: false }), { code: 1, lines: [KEEP_HELD] });
    assert.deepEqual(keepCommand(["1"], c.env, new Date(), { dir: c.w.repo, tty: true }), { code: 1, lines: [KEEP_AT_TTY] });
    assert.equal(keepCommand(["--help"], c.env, new Date(), { dir: c.w.repo }).code, 0);
    assert.ok(!existsSync(join(c.w.trail, "learnings")));
    updateInitRecord(c.repoKey, (x) => {
      x.pending = [];
    }, c.env);
    assert.deepEqual(keepCommand(["1"], c.env, new Date(), { dir: c.w.repo, tty: false }).lines, [KEEP_NOTHING_WAITS]);
  });
});

test("a receipt the transcript doesn't back keeps nothing: an edited receipt, a transcript the hooks never read, numbers that differ", async () => {
  await inWorld("keep-forged", (c) => {
    const path = keepSession(c, "2");
    assert.equal(gate(c, path, "trail keep 2"), null);
    const rp = keepReceiptPath(SESSION, c.env);
    const good = readFileSync(rp, "utf8");
    writeFileSync(rp, JSON.stringify({ ...JSON.parse(good), replySha: "0".repeat(64) }));
    assert.deepEqual(keepCommand(["2"], c.env, new Date(), { dir: c.w.repo, tty: false }).lines, [KEEP_HELD]);
    writeFileSync(rp, JSON.stringify({ ...JSON.parse(good), numbers: [1, 2] }));
    assert.deepEqual(keepCommand(["1", "2"], c.env, new Date(), { dir: c.w.repo, tty: false }).lines, [KEEP_HELD], "the person typed 2");
    writeFileSync(rp, good);
    writeFileSync(sessionPath(SESSION, ".json", c.env), JSON.stringify({ trace: { dev: 1, ino: 2 } }));
    assert.deepEqual(keepCommand(["2"], c.env, new Date(), { dir: c.w.repo, tty: false }).lines, [KEEP_HELD], "not the file the hooks read");
    assert.ok(!existsSync(join(c.w.trail, "learnings")));
  });
});

test("a relayed skill whose source changed or was pointed elsewhere is not kept, with its words (R24)", async () => {
  await inWorld("keep-changed", (c) => {
    const src = readInitRecord(c.repoKey, c.env).pending[0]!.skill!.src;
    updateInitRecord(c.repoKey, (x) => {
      x.pending[0]!.skill!.src = { ...src, run: { from: src.run.from + 1, to: src.run.to } };
    }, c.env);
    const path = keepSession(c, "1");
    assert.equal(gate(c, path, "trail keep 1"), null);
    const r = keepCommand(["1"], c.env, new Date(), { dir: c.w.repo, tty: false });
    assert.ok(r.lines.includes("release-npm: its past session changed or is gone, so Trail can't check the steps. It will offer it again after the job checks out."), r.lines.join("\n"));
    assert.ok(!existsSync(join(c.w.trail, "skills", "release-npm")));
  });
  await inWorld("keep-grown", (c) => {
    appendFileSync(readInitRecord(c.repoKey, c.env).pending[0]!.skill!.src.t, "\n");
    const path = keepSession(c, "1");
    assert.equal(gate(c, path, "trail keep 1"), null);
    const r = keepCommand(["1"], c.env, new Date(), { dir: c.w.repo, tty: false });
    assert.match(r.lines.join("\n"), /release-npm: its past session changed or is gone/);
    assert.ok(!existsSync(join(c.w.trail, "skills", "release-npm")));
  });
});

test("a deferred item is kept only when the person's typed numbers named it on this list (B5)", async () => {
  await inWorld("keep-deferred", (c) => {
    const pending = readInitRecord(c.repoKey, c.env).pending;
    updateInitRecord(c.repoKey, (x) => {
      x.deferred = [pending[1]!.id];
    }, c.env);
    const path = keepSession(c, "all");
    assert.equal(gate(c, path, "trail keep all"), null);
    const r = keepCommand(["all"], c.env, new Date(), { dir: c.w.repo, tty: false });
    assert.equal(r.code, 0);
    assert.ok(!existsSync(join(c.w.trail, "learnings", "no-timeout.md")), "'all' doesn't name the deferred guardrail");
  });
});

test("a relayed skill the person's numbers left out is closed for good, said no to in the offer log under its job key (R53)", async () => {
  await inWorld("keep-close", (c) => {
    const path = keepSession(c, "just 2");
    assert.equal(gate(c, path, "trail keep 2"), null);
    assert.equal(keepCommand(["2"], c.env, new Date(), { dir: c.w.repo, tty: false }).code, 0);
    const offers = readFileSync(join(c.w.trail, "offers.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(offers.map((o) => [o.event, o.moment, o.key]), [["closed", "init", `${c.repoKey}|job:release`]]);
    assert.equal(readInitRecord(c.repoKey, c.env).closed.length, 2);
  });
});

test("the handover: the next session gets the same list once with its offset recorded, the one after says nothing and drops it (J02 leg C)", async () => {
  const { initHandover } = await import("../src/init/handover.js");
  const { RELAY_LINE, KEEP_LINE } = await import("../src/init/relay.js");
  await inWorld("handover", (c) => {
    const dir = join(c.w.home, ".claude", "projects", folderOf(c.w.repo));
    mkdirSync(dir, { recursive: true });
    const s2 = join(dir, "s-two.jsonl");
    writeFileSync(s2, jsonl([typed("good morning", { sessionId: "s-two" })]));
    const text = initHandover(c.repoKey, { id: "s-two", transcriptPath: s2 }, c.env, new Date())!;
    assert.match(text, /^\[trail\] From Trail, the tool this person installed to keep commands that worked as skills\. trail init found 3 items in this person's past sessions that they haven't answered yet\./);
    const lines = text.split("\n");
    assert.ok(lines.includes(RELAY_LINE) && lines.includes(KEEP_LINE));
    assert.ok(lines.includes("1. release-npm (skill, this repo only)"), lines.join("\n"));
    assert.ok(lines.includes("   Claude worked out how to publish shop to npm from scratch on 3 different days."));
    assert.ok(lines.some((l) => l.startsWith('3. "never use em dashes in the copy" (learning in your own words')), "the person's line read again by its pointer");
    for (const l of lines.filter((x) => /^\d\. /.test(x))) assert.ok(c.listText.includes(l), `the same line as the relay printed: ${l}`);
    let rec = readInitRecord(c.repoKey, c.env);
    assert.deepEqual(rec.handover, { session: "s-two", offset: statSync(s2).size });
    assert.equal(initHandover(c.repoKey, { id: "s-two", transcriptPath: s2 }, c.env), null, "once");
    assert.equal(readInitRecord(c.repoKey, c.env).pending.length, 3, "the same session (a compaction) keeps it");
    assert.equal(initHandover(c.repoKey, { id: "s-three", transcriptPath: null }, c.env), null, "the one after says nothing");
    rec = readInitRecord(c.repoKey, c.env);
    assert.deepEqual([rec.pending, rec.handover, rec.pendingFrom], [[], null, null], "and drops the list");
  });
});

test("a handed-over list is kept from the handover offset: the gate reads after it and the CLI checks the same session and offset", async () => {
  const { initHandover } = await import("../src/init/handover.js");
  await inWorld("handover-keep", (c) => {
    const dir = join(c.w.home, ".claude", "projects", folderOf(c.w.repo));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${SESSION}.jsonl`);
    const at = { cwd: c.w.repo, sessionId: SESSION };
    writeFileSync(path, jsonl([typed("keep 1 and 3", at)]));
    assert.ok(initHandover(c.repoKey, { id: SESSION, transcriptPath: path }, c.env));
    appendFileSync(path, jsonl([said(c.reply, at), typed("1 and 3", at)]));
    const st = statSync(path);
    const state = sessionPath(SESSION, ".json", c.env);
    mkdirSync(join(state, ".."), { recursive: true });
    writeFileSync(state, JSON.stringify({ trace: { dev: st.dev, ino: st.ino } }));
    assert.match(gate(c, path, "trail keep 1 2 3")!.reason, /The person typed 1 and 3/);
    assert.equal(gate(c, path, "trail keep 1 3"), null, "a line typed before the handover doesn't count; the one after does");
    const r = keepCommand(["1", "3"], c.env, new Date(), { dir: c.w.repo, tty: false });
    assert.equal(r.code, 0, r.lines.join("\n"));
    assert.ok(existsSync(join(c.w.trail, "skills", "release-npm", "SKILL.md")));
    assert.ok(!existsSync(join(c.w.trail, "learnings", "no-timeout.md")), "2 wasn't typed");
  });
});

test("the session that showed the list, resumed: no handover into it, and the person's next 1 answers the list they saw (fix-lab5)", async () => {
  const { initHandover } = await import("../src/init/handover.js");
  await inWorld("handover-resume", (c) => {
    // Turn 1 (headless -p): the agent ran trail init and relayed the list in its own words. Turn 2 resumes the same session.
    const path = keepSession(c, "set up trail here");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${lines.slice(0, -1).join("\n")}\n`);
    assert.equal(initHandover(c.repoKey, { id: SESSION, transcriptPath: path }, c.env, new Date()), null, "its own list is already in it");
    assert.equal(readInitRecord(c.repoKey, c.env).handover, null, "not recorded as handed over");
    appendFileSync(path, jsonl([typed("1", { cwd: c.w.repo, sessionId: SESSION })]));
    const st = statSync(path);
    const state = sessionPath(SESSION, ".json", c.env);
    writeFileSync(state, JSON.stringify({ trace: { dev: st.dev, ino: st.ino } }));
    assert.equal(gate(c, path, "trail keep 1 2>&1"), null, "the typed 1 answers the list");
    const r = keepCommand(["1"], c.env, new Date(), { dir: c.w.repo, tty: false });
    assert.equal(r.code, 0, r.lines.join("\n"));
    assert.ok(existsSync(join(c.w.trail, "skills", "release-npm", "SKILL.md")));
  });
});

test("a session that holds another, older list still gets this one handed over", async () => {
  const { initHandover } = await import("../src/init/handover.js");
  await inWorld("handover-other-list", (c) => {
    const old = c.listText.replace(/release-npm/g, "deploy-old").replace(/no-timeout/g, "no-sleep");
    const dir = join(c.w.home, ".claude", "projects", folderOf(c.w.repo));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "s-old.jsonl");
    const at = { cwd: c.w.repo, sessionId: "s-old" };
    writeFileSync(path, jsonl([typed("set up trail", at), toolUse("tu1", "Bash", { command: "trail init --agents claude" }, at), toolResult("tu1", old, undefined, at), said("done", at)]));
    assert.ok(initHandover(c.repoKey, { id: "s-old", transcriptPath: path }, c.env, new Date()));
  });
});
