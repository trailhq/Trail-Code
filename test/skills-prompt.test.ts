/**
 * The UserPromptSubmit skills part (design 3.2, spec 11; J05, J10-J13, J24):
 * a sandbox Trail home, a real webshop checkout and a transcript that grows
 * between prompts, as Claude Code writes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptSkills, type PromptDeps } from "../src/claude/prompt-skills.js";
import { gateFilePath, readGateFile, sessionPath } from "../src/trace/gate-file.js";
import { readLedger } from "../src/skills/ledger.js";
import { getSkillState } from "../src/skills/state.js";
import { saveHeld } from "../src/skills/store.js";
import type { PendingOffer } from "../src/trace/types.js";
import { emptyState } from "./trace-run-fixtures.js";
import { releaseSkill, shipSkill, WEBSHOP } from "./skills-recall-fixtures.js";
import { box, CWD, deadlineClock, gateFor, grow, payload, ranIn, replyAt, save, SID, stateOf, typedIn, withNow, type Box } from "./skills-prompt-fixtures.js";
import { timeBar } from "./machine-speed.js";

const FROM = "[trail] From Trail, the tool this person installed to keep commands that worked as skills.";
const webshopRelease = () => releaseSkill({ applies: WEBSHOP, trail: "s-7f3a2c" });
const events: Array<[string, Record<string, string>]> = [];
const deps = (b: Box, extra: Partial<PromptDeps> = {}): Partial<PromptDeps> => ({ track: (e, p) => events.push([e, p]), gate: gateFor(b), clock: deadlineClock, ...extra });
const run = (b: Box, prompt: string, extra: Record<string, unknown> = {}, env = b.env, d: Partial<PromptDeps> = deps(b)) =>
  promptSkills(payload(b, prompt, extra), CWD, env, d);

function shipBox(tag: string) {
  const b = box(tag);
  save(b, shipSkill());
  return b;
}

test("nothing when skills are off, without a session, or when the prompt is not the person's words", () => {
  const off = box("off", { skills: false });
  save(off, shipSkill());
  assert.deepEqual(run(off, "now ff to prod please"), {});
  const b = shipBox("nosession");
  assert.deepEqual(promptSkills({ prompt: "now ff to prod please", cwd: CWD }, CWD, b.env, deps(b)), {});
  assert.deepEqual(run(b, "<task-notification>\n<status>completed</status>\n</task-notification>"), {});
  assert.deepEqual(run(b, "ff"), {});
});

test("a job cue brings the run block once, the person's notice, and the gated step in the gate file (J10)", () => {
  const b = shipBox("block");
  const out = run(b, "now ff to prod please");
  assert.match(out.context ?? "", /^\[trail\] Skill ship-beta-then-prod fits \(yours, v1, last worked Oct 14\)\. Start from these exact steps, in order:\n/);
  assert.ok(out.context!.includes("  5 git push git@github.com:acme/webshop.git $(git rev-parse HEAD):refs/heads/prod\n    Claude Code will ask the person before step 5 (it can't be undone); wait for that. If they say no, don't retry this turn; ask them to run it."));
  assert.ok(out.context!.length <= 1200);
  assert.equal(out.notice, "trail: using skill ship-beta-then-prod (v1, worked Oct 14)");
  assert.equal(out.block, undefined);
  const st = stateOf(b);
  assert.equal(st.injected.length, 1);
  assert.deepEqual([st.injected[0]!.cue, st.injected[0]!.live, st.injected[0]!.epoch], ["job", true, 0]);
  const gate = readGateFile(SID, b.env);
  assert.deepEqual(gate?.live[0]?.groups.map((g) => [g.kind, g.steps.map((s) => s.n)]), [["push-prod", [5]]]);
});

test("once per epoch: the same ask re-arms the block with a fresh run id (D65); new values bring a full block in its place", () => {
  const b = box("rearm");
  save(b, webshopRelease());
  const first = run(b, "can you pull and publish 1.4.2");
  assert.ok(first.context?.includes("npm publish acme-cli-1.4.2.tgz"));
  grow(b, [typedIn(b, "can you pull and publish 1.4.2", 0), ...ranIn(b, "npm run build", "built", 5)]);
  const again = run(b, "ok publish 1.4.2 again please", {}, withNow(b, "2026-10-20T10:01:00.000Z"));
  assert.equal(again.context, "[trail] Same job as before: start from the steps of skill release-npm above.");
  assert.equal(again.notice, undefined);
  let st = stateOf(b);
  assert.equal(st.injected.length, 1);
  assert.equal(st.injected[0]!.runId, null, "re-armed: the next ask's run gets it");
  assert.equal(st.injected[0]!.at, "2026-10-20T10:01:00.000Z");
  assert.equal(st.injected[0]!.live, true);
  const injId = st.injected[0]!.injId;
  const newer = run(b, "now publish 1.4.3", {}, withNow(b, "2026-10-20T10:02:00.000Z"));
  assert.ok(newer.context?.startsWith("[trail] Skill release-npm fits"));
  assert.ok(newer.context!.includes("npm publish acme-cli-1.4.3.tgz") && !newer.context!.includes("1.4.2"));
  st = stateOf(b);
  assert.equal(st.injected.length, 1);
  assert.equal(st.injected[0]!.injId, injId);
  assert.equal(st.injected[0]!.params.version, "1.4.3");
  assert.ok(st.injected[0]!.steps.includes("npm publish acme-cli-1.4.3.tgz --access public"));
});

test("a status question gets the check line of the skill used here, and nothing to run (J11)", () => {
  const b = shipBox("check");
  run(b, "now ff to prod please");
  const out = run(b, "is it live yet?", {}, withNow(b, "2026-10-20T10:05:00.000Z"));
  assert.equal(out.context,
    "[trail] To check ship-beta-then-prod: gh api repos/acme/webshop/commits/$(git rev-parse HEAD)/statuses --jq '.[0].state' (it should show success). Answer from what it shows; don't run any other step.");
  assert.equal(out.notice, undefined);
  const st = stateOf(b);
  assert.deepEqual(st.injected.map((i) => [i.cue, i.live, i.steps.length]), [["job", true, 5], ["check", false, 0]]);
  // A history question gets nothing at all (J12).
  assert.deepEqual(run(b, "tell me how did we ship the new search page", {}, withNow(b, "2026-10-20T10:06:00.000Z")), {});
});

test("the check line carries the values of the block it checks", () => {
  const b = box("checkvals");
  save(b, webshopRelease());
  run(b, "can you pull and publish 1.4.2");
  assert.equal(run(b, "is it published?", {}, withNow(b, "2026-10-20T10:05:00.000Z")).context,
    "[trail] To check release-npm: npm view acme-cli version (it should show 1.4.2). Answer from what it shows; don't run any other step.");
  // A version the question names wins.
  assert.ok(run(b, "is 1.4.3 published?", {}, withNow(b, "2026-10-20T10:06:00.000Z")).context?.includes("(it should show 1.4.3)"));
});

test("liveness: another job, over 25 words, or 2 hours end the block; a status question keeps it", () => {
  for (const [prompt, at, live] of [
    ["is it live yet?", "2026-10-20T10:05:00.000Z", true],
    ["now publish 1.4.2 to npm", "2026-10-20T10:05:00.000Z", false],
    [`ok ${"and then one more thing ".repeat(6)}`, "2026-10-20T10:05:00.000Z", false],
    ["what does the cart page do", "2026-10-20T12:00:01.000Z", false],
  ] as const) {
    const b = shipBox("live");
    run(b, "now ff to prod please");
    run(b, prompt, {}, withNow(b, at));
    assert.equal(stateOf(b).injected[0]!.live, live, prompt);
    assert.equal(existsSync(gateFilePath(SID, b.env)), live, `gate file for: ${prompt}`);
  }
});

test("where the host can't ask the person, the block says show the command (bypass, headless, another host; D17)", () => {
  const cant = "This session can't ask the person, so don't run step 5 (it can't be undone), not even after a yes in chat; show them the command to run themselves.";
  const b1 = shipBox("bypass");
  assert.ok(run(b1, "now ff to prod please", { permission_mode: "bypassPermissions" }).context!.includes(cant));
  const b2 = box("headless", { entry: "sdk-cli" });
  save(b2, shipSkill());
  const headless = run(b2, "now ff to prod please");
  assert.ok(headless.context!.includes(cant), "recall runs headless too (D16), and says it can't ask");
  const b3 = shipBox("cursor");
  const cursor = promptSkills({ conversation_id: "c1", generation_id: "g1", cursor_version: "1.7", session_id: SID, transcript_path: b3.transcript, cwd: CWD, prompt: "now ff to prod please" }, CWD, b3.env, deps(b3));
  assert.ok(cursor.context!.includes(cant));
});

test("held items, needs-fix skills and other repos' skills never come back", () => {
  const b = box("never");
  saveHeld(shipSkill({ trail: "s-0000ff" }, { name: "ship-held" }), "no-yes", { host: "claude", job: "ship", repoKey: WEBSHOP }, b.env);
  save(b, releaseSkill());   // applies to acme/cli, not webshop
  assert.deepEqual(run(b, "now ff to prod please"), {});
  assert.deepEqual(run(b, "can you pull and publish 1.4.2"), {});
});

test("the deadline: slow probes are left out, the block still comes inside 400 ms", () => {
  const b = shipBox("slow");
  const slow: NonNullable<PromptDeps["probes"]>["git"] = (_a, _c, ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return { code: null, out: "", timedOut: true };
  };
  const t0 = Date.now();
  const out = run(b, "now ff to prod please", {}, b.env, deps(b, { probes: { git: slow }, clock: Date.now }));
  const took = Date.now() - t0;
  assert.ok(out.context?.startsWith("[trail] Skill ship-beta-then-prod fits"));
  assert.ok(!out.context!.includes("ready:"));
  // The 400 ms deadline, and what a slow machine adds around it (a shared Windows runner took 607 ms).
  assert.ok(took < 400 + timeBar(50, process.platform === "win32" ? 600 : 200), `took ${took} ms`);
  // Past the deadline before the cue (a long lock wait, a slow catch-up): no block, nothing half-done.
  let now = 0;
  const lb = shipBox("late");
  const late = run(lb, "now ff to prod please", {}, lb.env, deps(lb, { clock: () => (now += 500) }));
  assert.deepEqual(late, {});
});

test("ready probes: passed ones in one line, a failed one said first and kept on the injection", () => {
  const clean = shipBox("probes-ok");
  assert.ok(run(clean, "now ff to prod please").context!.includes("\n  ready: no uncommitted changes, on beta\n"));
  assert.equal((stateOf(clean).injected[0] as { readyFailed?: string[] }).readyFailed, undefined);
  // D118 a's no-retry words on the gated note put the full fixture with a failed probe over the 1,200 cap (the
  // pointer, as runblock's overflow test pins); without its If it fails line it fits, and the order is what's read.
  const b = box("probes");
  save(b, shipSkill({}, { ifFails: [] }));
  writeFileSync(join(b.repo, "wip.txt"), "x");
  const out = run(b, "now ff to prod please");
  // The failed probe comes first, then the passed ones (4.15).
  assert.match(out.context!, /^\[trail\] Skill ship-beta-then-prod fits .*\n  ready: Uncommitted changes here\. Tell the person; don't commit or stash for them\.\n  ready: on beta\n  check first: gh auth status\n/);
  assert.deepEqual((stateOf(b).injected[0] as { readyFailed?: string[] }).readyFailed, ["git status --porcelain"]);
});

test("save this: nothing yet, a failed last run, a refusal, then the add directive with the typed line from this catch-up (J05)", () => {
  const b = box("save");
  assert.equal(run(b, "save this as a skill").context,
    `${FROM} They typed: "save this as a skill". Trail keeps only a job that worked, and no job has finished here since the conversation started or was last compacted. Let them know: "There's nothing to keep yet: no job has finished here since the conversation was last compacted. Ask me again once one works."`);
  grow(b, [typedIn(b, "run the build and publish 1.4.3", 0), ...ranIn(b, "npm run build", "built", 5), ...ranIn(b, "npm publish", "npm error code E403", 10, { isError: true })]);
  assert.equal(run(b, "save this as a skill", {}, withNow(b, "2026-10-20T10:01:00.000Z")).context,
    `${FROM} They typed: "save this as a skill". Trail keeps only a job that worked, and the last one didn't finish cleanly. Let them know: "There's nothing to keep yet: the last job didn't finish cleanly. Ask me again once it works."`);
  // 33 minutes on: a new run.
  grow(b, [typedIn(b, "now please sudo rm the cache and rebuild", 2000), ...ranIn(b, "sudo rm -rf /var/cache/acme", "", 2005), ...ranIn(b, "npm run build", "built", 2010), replyAt("Done, rebuilt.", 2015)]);
  assert.equal(run(b, "save this as a skill", {}, withNow(b, "2026-10-20T10:35:00.000Z")).context,
    `${FROM} They typed: "save this as a skill". Trail can't keep that job as a skill: a step runs sudo: \`sudo rm -rf /var/cache/acme\`. Let them know: "I can't keep that as a skill: a step runs sudo: \`sudo rm -rf /var/cache/acme\`."`);
  assert.equal(stateOf(b).saveRequest, null);
  grow(b, [
    typedIn(b, "can you pull and publish 1.4.3", 4000), ...ranIn(b, "git pull --ff-only origin beta", "Already up to date.", 4005),
    ...ranIn(b, "npm run build", "built", 4010), ...ranIn(b, "npm publish acme-cli-1.4.3.tgz --access public", "+ acme-cli@1.4.3", 4015),
    ...ranIn(b, "npm view acme-cli version", "1.4.3", 4020), replyAt("Published 1.4.3: npm shows it.", 4025),
    // Claude Code wrote the typed line before the hook ran (g5's real-data order).
    typedIn(b, "save this as a skill", 4070),
  ]);
  const ok = run(b, "save this as a skill", {}, withNow(b, "2026-10-20T11:07:51.000Z"));
  const st = stateOf(b);
  const runId = st.runs.find((r) => r.job === "release" && r.stepCalls >= 3)!.id;
  assert.match(ok.context ?? "", new RegExp(`^\\[trail\\] From Trail, the tool this person installed to keep commands that worked as skills\\. They typed: "save this as a skill"\\. The last job here worked, so to keep it as they asked, run: trail skills add [a-z0-9-]+ --run ${runId}\\. Trail checks their words in this session before it keeps anything\\. Then tell them the line it prints\\.$`));
  assert.equal(st.saveRequest?.runId, runId);
  assert.equal(st.saveRequest?.scope, "this repo");
  assert.equal(st.offerUsed, true);
  assert.ok(st.saveRequest?.typed, "the typed line came in this catch-up: g5 takes its offset from the fold");
  assert.deepEqual(st.injected, [], "a save request is not a job ask");
});

test("save this after a run proven only by its || echo fallback (H6, D101 item 5): nothing to keep, and why", () => {
  const b = box("savefallback");
  grow(b, [typedIn(b, "check docker is up", 0), ...ranIn(b, 'docker info --format "{{.ServerVersion}}" || echo "docker not running"', "docker not running", 5), replyAt("Docker isn't running.", 6)]);
  assert.equal(run(b, "save this as a skill", {}, withNow(b, "2026-10-20T10:01:00.000Z")).context,
    `${FROM} They typed: "save this as a skill". Trail keeps only a job that worked, and the last command passed only through its fallback (|| echo, || true or || :), so Trail can't tell it worked. Let them know: "There's nothing to keep yet: the last command only passed through its fallback, so I can't tell it worked. Ask me again once it works."`);
  assert.equal(stateOf(b).saveRequest, null);
});

test("save this after a run that came from a skill: nothing new to keep", () => {
  const b = box("saveskill");
  save(b, webshopRelease());
  run(b, "can you pull and publish 1.4.2");
  grow(b, [typedIn(b, "can you pull and publish 1.4.2", 0), ...ranIn(b, "npm run build", "built", 5), replyAt("Built.", 6)]);
  assert.equal(run(b, "save this as a skill", {}, withNow(b, "2026-10-20T10:01:00.000Z")).context,
    `${FROM} They typed: "save this as a skill". That job already ran from the skill release-npm, so Trail has nothing new to keep. Let them know: "That job already ran from the skill release-npm, so there's nothing new to keep."`);
});

function offerIn(b: Box, extra: Partial<PendingOffer> = {}): void {
  const offer: PendingOffer = {
    offerId: "o-81c2aa", moment: "repeated", runId: "r-1020-3f9a", name: "ship-beta-then-prod", key: `${WEBSHOP}|job:ship`,
    lines: ["Shipped: beta and prod are both at 4e1c9a2 and success.", "Keep the 5 that worked as a skill, just for you in this repo? (yes / show me / no)"],
    channel: "stop", shownAt: "2026-10-20T09:59:00.000Z", showMe: false, yes: null, typedAfter: [], ...extra,
  };
  const path = sessionPath(SID, ".json", b.env);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ skills: emptyState({ pendingOffer: offer, scopeKeys: [WEBSHOP], offerUsed: true, offerUsedBy: "offer" }) }));
}

test("an answer to the pending offer goes through g5: yes, show me and no are answered and nothing else runs", () => {
  for (const [answer, lead, tele] of [
    ["yes", `${FROM} They typed: "yes". Trail offered to keep the last job as a skill, and this is their answer. To keep it as they said, run: trail skills add ship-beta-then-prod --run r-1020-3f9a.`, "yes"],
    ["show me", `${FROM} They typed: "show me". Trail offered to keep the last job as a skill, and they want to see it first. Run trail skills draft r-1020-3f9a --print`, "show"],
    ["no", `${FROM} They typed: "no". Trail offered to keep the last job as a skill, and they said no, so Trail kept nothing. Let them know: "OK, not saved.`, "no"],
  ] as const) {
    const b = shipBox(`answer-${tele}`);
    offerIn(b);
    events.length = 0;
    const out = run(b, answer);
    assert.ok(out.context?.startsWith(lead), `${answer}: ${out.context}`);
    assert.deepEqual(events.filter(([e]) => e === "skill_answer"), [["skill_answer", { answer: tele }]]);
    const st = stateOf(b);
    assert.deepEqual(st.injected, []);
    if (answer === "yes") assert.ok(st.pendingOffer?.yes, "g5 recorded the yes");
  }
});

test("an unrelated message after an offer the agent said: moved on, then the prompt is an ask like any other", () => {
  const b = shipBox("moved");
  offerIn(b);
  events.length = 0;
  const out = run(b, "now ff to prod please");
  assert.ok(out.context?.startsWith(`${FROM} They typed: "now ff to prod please". That isn't an answer to Trail's offer to keep the last job as a skill, so Trail dropped the offer and kept nothing. No need to bring the offer up again.\n[trail] Skill ship-beta-then-prod fits`), out.context);
  assert.deepEqual(events.filter(([e]) => e === "skill_answer"), [["skill_answer", { answer: "none" }]]);
  assert.equal(stateOf(b).pendingOffer, null);
});

test("credit in the prompt hook (D57): a passed check settles the use on the next prompt, failed probes as forms; then one correction", () => {
  const b = box("credit");
  save(b, webshopRelease());
  writeFileSync(join(b.repo, "wip.txt"), "x");
  run(b, "can you pull and publish 1.4.2");
  grow(b, [
    typedIn(b, "can you pull and publish 1.4.2", 0),
    ...ranIn(b, "git pull --ff-only origin main", "Already up to date.", 5),
    ...ranIn(b, "npm run build", "built", 10),
    ...ranIn(b, "npm publish acme-cli-1.4.2.tgz --access public", "+ acme-cli@1.4.2", 15),
    ...ranIn(b, "npm view acme-cli version", "1.4.2", 20),
    replyAt("Published 1.4.2: npm shows it. Used skill release-npm", 25),
    typedIn(b, "now look at the cart page styles", 120),
  ]);
  events.length = 0;
  run(b, "now look at the cart page styles", {}, withNow(b, "2026-10-20T10:02:00.000Z"));
  const uses = readLedger("s-7f3a2c", b.env).filter((l) => l.event === "use");
  assert.equal(uses.length, 1);
  assert.deepEqual(uses[0] && "stepsRan" in uses[0] ? [uses[0].stepsRan, uses[0].check, uses[0].readyFailed] : null, [[1, 2, 6], "passed", ["clean", "on-branch"]]);
  assert.equal(getSkillState("s-7f3a2c", b.env)?.uses, 1);
  assert.deepEqual(events.filter(([e]) => e === "skill_used"), [["skill_used", { outcome: "checked" }]]);
  // The correction window: the prompt that settled it was the first after the use; a correction as the second counts once.
  grow(b, [typedIn(b, "no, that's wrong, it should go to staging not prod", 200)]);
  run(b, "no, that's wrong, it should go to staging not prod", {}, withNow(b, "2026-10-20T10:03:30.000Z"));
  assert.equal(readLedger("s-7f3a2c", b.env).filter((l) => l.event === "corrected").length, 1);
  assert.equal(readLedger("s-7f3a2c", b.env).filter((l) => l.event === "use").length, 1, "settled once");
  // A third prompt is past the window.
  grow(b, [typedIn(b, "no, that's wrong again", 260)]);
  run(b, "no, that's wrong again", {}, withNow(b, "2026-10-20T10:04:30.000Z"));
  assert.equal(readLedger("s-7f3a2c", b.env).filter((l) => l.event === "corrected").length, 1);
});

test("the prompt hook writes no typed text anywhere under the Trail home", () => {
  const b = shipBox("private");
  const secretish = "now ff to prod please zebra-unicorn-42";
  run(b, secretish);
  grow(b, [typedIn(b, secretish, 0)]);
  run(b, "is it live yet zebra-unicorn-42?", {}, withNow(b, "2026-10-20T10:01:00.000Z"));
  const files = (dir: string): string[] => {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  };
  for (const f of files(b.env.TRAIL_HOME!)) assert.ok(!readFileSync(f, "utf8").includes("zebra-unicorn"), f);
});

test("a throw fails open: nothing out, one line in hook-errors.log without the error's words", () => {
  const b = shipBox("throws");
  const boom = () => { throw new Error("now ff to prod please zebra-unicorn-42"); };
  assert.deepEqual(run(b, "now ff to prod please", {}, b.env, deps(b, { gate: boom })), {});
  const log = readFileSync(join(b.env.TRAIL_HOME!, "state", "hook-errors.log"), "utf8");
  assert.match(log, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z prompt Error( \S+)?\n$/);
  assert.ok(!log.includes("zebra"));
});
