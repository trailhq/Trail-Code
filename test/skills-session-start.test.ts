/**
 * The SessionStart skills part (design 3.1; J08, J09, J13): the index line,
 * held items said once, the epoch a compaction or a clear starts, and the
 * block a compaction cut short.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptSkills } from "../src/claude/prompt-skills.js";
import { sessionStartSkills, SKILLS_INTRO } from "../src/claude/start-skills.js";
import { readGateFile, sessionPath } from "../src/trace/gate-file.js";
import { saveHeld } from "../src/skills/store.js";
import { skillsGate } from "../src/trace/skill-session.js";
import type { PendingOffer } from "../src/trace/types.js";
import { compactBoundary, compactSummary } from "./trace-fixtures.js";
import { emptyState } from "./trace-run-fixtures.js";
import { releaseSkill, shipSkill, WEBSHOP } from "./skills-recall-fixtures.js";
import { at, box, CWD, deadlineClock, gateFor, grow, payload, ranIn, replyAt, save, SID, startPayload, stateOf, typedIn, withNow, type Box } from "./skills-prompt-fixtures.js";

const start = (b: Box, source: string, extra: Record<string, unknown> = {}, env = b.env) =>
  sessionStartSkills(startPayload(b, source, extra), CWD, env, { gate: gateFor(b) });
const ask = (b: Box, prompt: string, env = b.env) => promptSkills(payload(b, prompt), CWD, env, { gate: gateFor(b), track: () => {}, clock: deadlineClock });
const webshopRelease = () => releaseSkill({ applies: WEBSHOP, trail: "s-7f3a2c" });
const HELD_AT = new Date("2026-10-19T18:00:00.000Z");

/** D101: the plain lines on what Trail keeps, first whenever skills are on (D117 (1): a third names lesson and keep). */
const INTRO = SKILLS_INTRO.join("\n");
const INTRO_LINES = [
  "[trail] Trail, the tool this person installed, keeps commands that worked here as skills, and keeps one only after the person says yes.",
  "[trail] So Trail may ask you to run trail skills add <name> --run <id>, but only after the person typed yes to its offer or asked to save a job; that message quotes what they typed.",
  // Phase 2 (1.8): a change to a skill, the draft a "show me" prints, and the person-only restore by version.
  "[trail] Trail may also ask you to run trail skills lesson [<skill>] --offer <id> after the person typed yes to keeping what it offered, or to run trail keep <numbers> with the numbers they typed after trail init's list. Trail checks their answer in this session before it keeps anything.",
  "[trail] Trail may also ask you to run trail skills update <name> --offer <id> after the person typed yes to a change it showed, or trail skills draft <id> --print to show it first. It checks their answer before it changes a skill. An older version (trail skills restore <name> --version <n>) is theirs to bring back.",
];
const COMPACT_HEAD = "[trail] You were partway through skill ship-beta-then-prod when the conversation was compacted. Its steps (yours, v1, last worked Oct 14):";

test("startup: the index line, this repo's scope, nothing for a subagent or with skills off", () => {
  const b = box("start");
  save(b, shipSkill());
  const out = start(b, "startup");
  assert.equal(out.context, INTRO + "\n" +
    "[trail] Trail skills here: ship-beta-then-prod (push to beta, ff to prod, fast-forward prod) new, asks before the prod push. When the person asks for one of these jobs, its exact steps come in with their message.");
  assert.equal(out.notice, undefined);
  const st = stateOf(b);
  assert.deepEqual([st.epoch, st.scopeKeys], [0, [WEBSHOP]]);
  assert.deepEqual(start(b, "startup", { agent_id: "a-1" }), {});
  const off = box("start-off", { skills: false });
  save(off, shipSkill());
  assert.deepEqual(start(off, "startup"), {});
});

test("D101: with skills on, session start says in plain lines what Trail keeps and when it asks for trail skills add, lesson or keep", () => {
  assert.deepEqual(SKILLS_INTRO, INTRO_LINES);
  const b = box("empty");
  save(b, releaseSkill());   // acme/cli only
  assert.deepEqual(start(b, "startup"), { context: INTRO }, "no skills here and nothing held: only the intro lines");
  for (const source of ["resume", "clear", "compact"]) assert.ok(start(b, source).context?.startsWith(INTRO), source);
  const off = box("empty-off", { skills: false });
  assert.deepEqual(start(off, "startup"), {}, "skills off: nothing");
});

test("held items are said once each, at most 2 a session, as a line the agent says (J08, J09)", () => {
  const b = box("held");
  saveHeld(shipSkill({ trail: "s-0000a1" }, { name: "ship-held-a" }), "no-yes", { host: "claude", job: "ship", repoKey: WEBSHOP }, b.env, HELD_AT);
  saveHeld(shipSkill({ trail: "s-0000a2" }, { name: "ship-held-b" }), "host", { host: "cursor", job: "ship", repoKey: WEBSHOP }, b.env, HELD_AT);
  saveHeld(shipSkill({ trail: "s-0000a3" }, { name: "ship-held-c" }), "no-yes", { host: "claude", job: "ship", repoKey: WEBSHOP }, b.env, HELD_AT);
  const first = (start(b, "startup").context ?? "").split("\n").filter((l) => !SKILLS_INTRO.includes(l));
  assert.equal(first.length, 2);
  assert.ok(first.every((l) => l.startsWith("[trail] From Trail, the tool this person installed to keep commands that worked as skills. Trail held a skill from their last session instead of keeping it, and it can't show them a message in this app itself. So they know, tell them once, at the start of your first reply: \"")), first.join("\n"));
  const said = first.map((l) => l.slice(l.indexOf("\"") + 1, -1)).sort();
  assert.deepEqual(said, [
    "Claude Code started a skill ship-held-a in your last session without your yes, so it wasn't kept. Keep it: trail skills keep ship-held-a",
    "Cursor started a skill ship-held-b in your last session. Trail can't check which steps ran there, so it wasn't kept. Keep it: trail skills keep ship-held-b",
  ]);
  const second = start(b, "resume").context ?? "";
  assert.ok(second.includes("ship-held-c") && !second.includes("ship-held-a"), second);
  assert.deepEqual(start(b, "resume"), { context: INTRO }, "each one once");
});

test("held items: a notice where the host shows it; nothing in a headless session, and they wait for an interactive one", () => {
  const b = box("held-notice");
  saveHeld(shipSkill({ trail: "s-0000a1" }, { name: "ship-held-a" }), "no-yes", { host: "claude", job: "ship", repoKey: WEBSHOP }, b.env, HELD_AT);
  const shows = { ...b.env, TRAIL_HOST_FACTS: JSON.stringify({ startNotice: true }) };
  const out = start(b, "startup", {}, shows);
  assert.equal(out.notice, "trail: Claude Code started a skill ship-held-a in your last session without your yes, so it wasn't kept. Keep it: trail skills keep ship-held-a");
  assert.equal(out.context, INTRO);

  const h = box("held-headless", { entry: "sdk-cli" });
  saveHeld(shipSkill({ trail: "s-0000a1" }, { name: "ship-held-a" }), "no-yes", { host: "claude", job: "ship", repoKey: WEBSHOP }, h.env, HELD_AT);
  assert.deepEqual(start(h, "startup"), { context: INTRO });
  assert.ok(start(h, "startup", {}, { ...h.env, CLAUDE_CODE_ENTRYPOINT: "cli" }).context?.includes("ship-held-a"));
});

test("a folder that is not a checkout: the scope is the checkouts inside it, at most 8", () => {
  const b = box("workspace");
  save(b, shipSkill());
  const ws = join(b.home, "src");
  for (const n of ["web", "api"]) {
    mkdirSync(join(ws, n), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: join(ws, n) });
    execFileSync("git", ["remote", "add", "origin", `git@github.com:acme/${n}.git`], { cwd: join(ws, n) });
  }
  const out = sessionStartSkills(startPayload(b, "startup", { cwd: ws }), ws, b.env, { gate: (i, d, e) => skillsGate(i, d, e) });
  assert.ok(out.context?.startsWith(`${INTRO}\n[trail] Trail skills here: ship-beta-then-prod`), out.context);
  const keys = stateOf(b).scopeKeys;
  assert.deepEqual(keys.slice(1).sort(), ["github.com/acme/api", WEBSHOP, "github.com/acme/web"].sort());
  assert.ok(keys[0]!.startsWith("local/"), keys[0]);
});

/** A ship block, its typed ask and two steps in the transcript; no check yet. */
function midJob(tag: string): Box {
  const b = box(tag);
  save(b, shipSkill());
  ask(b, "now ff to prod please");
  grow(b, [
    typedIn(b, "now ff to prod please", 0),
    ...ranIn(b, "git fetch origin", "", 5),
    ...ranIn(b, "git push git@github.com:acme/webshop.git $(git rev-parse HEAD):refs/heads/beta", "   e591589..4e1c9a2  4e1c9a2 -> beta", 10),
  ]);
  return b;
}

test("compact, SessionStart before the compaction line: one bump, the cut block comes back once (J13)", () => {
  const b = midJob("compact-first");
  const env = withNow(b, "2026-10-20T10:05:00.000Z");
  const out = start(b, "compact", {}, env);
  const lines = (out.context ?? "").split("\n");
  const n = SKILLS_INTRO.length;
  assert.deepEqual(lines.slice(0, n), [...SKILLS_INTRO]);
  assert.ok(lines[n]!.startsWith("[trail] Trail skills here: "));
  assert.equal(lines[n + 1], COMPACT_HEAD);
  assert.ok(out.context!.includes("  5 git push git@github.com:acme/webshop.git $(git rev-parse HEAD):refs/heads/prod"));
  assert.ok(out.context!.length <= 2000 + INTRO.length + 1);
  let st = stateOf(b);
  assert.deepEqual([st.epoch, st.pendingBoundary], [1, true]);
  assert.deepEqual(st.injected.map((i) => [i.cue, i.epoch, i.live]), [["job", 0, false], ["compact", 1, true]]);
  assert.equal(st.runs[0]!.closed, true);
  assert.deepEqual(readGateFile(SID, b.env)?.live.map((l) => l.injId), [st.injected[1]!.injId]);
  // The compaction line arrives: no second bump.
  grow(b, [compactBoundary({ timestamp: at(290) }), compactSummary({ timestamp: at(291) })]);
  const again = ask(b, "now ff to prod please", withNow(b, "2026-10-20T10:06:00.000Z"));
  st = stateOf(b);
  assert.deepEqual([st.epoch, st.pendingBoundary], [1, false]);
  // The cue won't bring it twice in this epoch: the same ask re-arms the compact block.
  assert.equal(again.context, "[trail] Same job as before: start from the steps of skill ship-beta-then-prod above.");
  assert.equal(st.injected.length, 2);
});

test("compact, the fold meets the compaction line first: the fold's bump, the block comes back", () => {
  const b = midJob("compact-fold");
  grow(b, [compactBoundary({ timestamp: at(290) }), compactSummary({ timestamp: at(291) })]);
  const out = start(b, "compact", {}, withNow(b, "2026-10-20T10:05:00.000Z"));
  assert.ok(out.context?.includes(COMPACT_HEAD), out.context);
  const st = stateOf(b);
  assert.deepEqual([st.epoch, st.pendingBoundary], [1, false]);
  assert.deepEqual(st.injected.map((i) => [i.cue, i.epoch, i.live]), [["job", 0, false], ["compact", 1, true]]);
});

test("compact: no block when its check had passed, when its run had ended, or on resume and clear", () => {
  // The check passed before the boundary.
  const passed = box("compact-passed");
  save(passed, webshopRelease());
  ask(passed, "can you pull and publish 1.4.2");
  grow(passed, [
    typedIn(passed, "can you pull and publish 1.4.2", 0), ...ranIn(passed, "npm run build", "built", 5),
    ...ranIn(passed, "npm publish acme-cli-1.4.2.tgz --access public", "+ acme-cli@1.4.2", 10), ...ranIn(passed, "npm view acme-cli version", "1.4.2", 15),
  ]);
  const p = start(passed, "compact", {}, withNow(passed, "2026-10-20T10:05:00.000Z"));
  assert.ok(!(p.context ?? "").includes("partway through"), p.context);
  assert.deepEqual(stateOf(passed).injected.map((i) => i.cue), ["job"]);

  // Another job started after the block: its run ended before the boundary.
  const ended = midJob("compact-ended");
  grow(ended, [typedIn(ended, "now run the tests", 60), ...ranIn(ended, "npm test", "ok", 70)]);
  const e = start(ended, "compact", {}, withNow(ended, "2026-10-20T10:05:00.000Z"));
  assert.ok(!(e.context ?? "").includes("partway through"));

  // The block had ended before the boundary (2 hours on), though no new run had started yet.
  const stale = midJob("compact-stale");
  ask(stale, "ok", withNow(stale, "2026-10-20T12:01:00.000Z"));
  assert.equal(stateOf(stale).injected[0]!.live, false);
  const s2 = start(stale, "compact", {}, withNow(stale, "2026-10-20T12:02:00.000Z"));
  assert.ok(!(s2.context ?? "").includes("partway through"));

  // Resume keeps the epoch and brings nothing back; clear starts a new epoch without a pending boundary.
  const r = midJob("resume");
  start(r, "resume", {}, withNow(r, "2026-10-20T10:05:00.000Z"));
  assert.deepEqual([stateOf(r).epoch, stateOf(r).injected.map((i) => i.live)], [0, [true]]);
  const c = midJob("clear");
  const cl = start(c, "clear", {}, withNow(c, "2026-10-20T10:05:00.000Z"));
  assert.ok(!(cl.context ?? "").includes("partway through"));
  const st = stateOf(c);
  assert.deepEqual([st.epoch, st.pendingBoundary, st.injected[0]!.live], [1, false, false]);
});

test("compact: an offer never shown is dropped, a shown one stays", () => {
  for (const shownAt of [null, "2026-10-20T09:59:00.000Z"]) {
    const b = box(`offer-${shownAt ? "shown" : "unshown"}`);
    const offer: PendingOffer = {
      offerId: "o-81c2aa", moment: "repeated", runId: "r-1020-3f9a", name: "ship-beta-then-prod", key: `${WEBSHOP}|job:ship`,
      lines: ["Keep the 5 that worked as a skill, just for you in this repo? (yes / show me / no)"],
      channel: "post-tool", shownAt, showMe: false, yes: null, typedAfter: [],
    };
    const path = sessionPath(SID, ".json", b.env);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ skills: emptyState({ pendingOffer: offer, scopeKeys: [WEBSHOP] }) }));
    start(b, "compact");
    assert.equal(stateOf(b).pendingOffer?.offerId ?? null, shownAt ? "o-81c2aa" : null);
  }
});

test("compact: the cut block's failed ready probes are said and ride on the new injection; a block too long is the pointer", () => {
  // Step 3 as a one-line wait, so the block has room for the ready line.
  const short = shipSkill({}, { steps: shipSkill().steps.map((st) => (st.n === 3 ? { ...st, cmd: "gh run watch --exit-status", wait: false } : st)) });
  const b = box("compact-probes");
  save(b, short);
  ask(b, "now ff to prod please");
  grow(b, [typedIn(b, "now ff to prod please", 0), ...ranIn(b, "git fetch origin", "", 5)]);
  writeFileSync(join(b.repo, "wip.txt"), "x");
  const out = start(b, "compact", {}, withNow(b, "2026-10-20T10:20:00.000Z"));
  assert.ok(out.context?.includes(`${COMPACT_HEAD}\n  ready: Uncommitted changes here. Tell the person; don't commit or stash for them.\n`), out.context);
  assert.deepEqual((stateOf(b).injected[1] as { readyFailed?: string[] }).readyFailed, ["git status --porcelain"]);

  const long = midJob("compact-long");
  writeFileSync(join(long.repo, "wip.txt"), "x");
  const lo = start(long, "compact", {}, withNow(long, "2026-10-20T10:20:00.000Z"));
  assert.ok(lo.context?.endsWith("\n[trail] Skill ship-beta-then-prod fits this ask, but its steps are too long to show here. Run trail skills show ship-beta-then-prod and start from them."), lo.context);
  assert.deepEqual((stateOf(long).injected[1] as { readyFailed?: string[] }).readyFailed, ["git status --porcelain"]);
});

test("a reply in the transcript does not change anything SessionStart decides", () => {
  const b = midJob("reply");
  grow(b, [replyAt("Pushed to beta; waiting for its checks.", 15)]);
  assert.ok(start(b, "compact", {}, withNow(b, "2026-10-20T10:05:00.000Z")).context?.includes(COMPACT_HEAD));
});
