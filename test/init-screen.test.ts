/**
 * What `trail init` shows (design 4.7, 4.8): the screen with every line of
 * 4.7 (skills on and off), the relay an agent gets (J02, D101) and the list a
 * person's own script gets without the agent line (B9), the lines after a
 * keep in each case (J09's offers-off form), `--yes`'s line, and pickFive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickFive } from "../src/init/candidates.js";
import { afterKeepLines, numbered, relayLines, screenLines, yesLine } from "../src/init/review-screen.js";
import { KEEP_LINE, RELAY_LINE } from "../src/init/relay.js";
import { escapeRe } from "./escape.js";
import type { InitCandidate } from "../src/init/types.js";
import { factsOf, guardrailCandidate, prefCandidate, skillCandidate, threeItems } from "./init-screen-fixtures.js";

const WORDS = /—|\bnotes?\b|\brules?\b|\bmemory\b|\bremember\b|\bworkflows?\b/i;

test("the screen, skills on: every line of 4.7, the cursor on the first item", () => {
  const lines = screenLines(threeItems(), { cursor: 0, open: null }, factsOf({ model: "claude-sonnet-5-5", calls: 1, tokens: 1840, sentSkills: 1 }));
  assert.deepEqual(lines, [
    "✓ looked back at 23 Claude Code sessions about this repo, typed into on 21 days (Jul 3 to Oct 14) · 15 started in the parent folder",
    "· sent Claude the steps of 1 skill to name it (about 1.8k tokens), none of your messages",
    "",
    "For your Claude only. Your teammates' Claude doesn't get these.",
    "",
    "Skills",
    "› [ ] 1  release-npm (this repo only)",
    "         Publish to npm and check it with npm view.",
    "         Claude worked out how to publish acme-cli to npm from scratch on 21 different days. Your Claude Code how-to release.md describes it.",
    "Always follow",
    "  [ ] 2  no-timeout (every repo)",
    "         Claude won't use the timeout command, which this Mac doesn't have.",
    "         Claude's commands failed with \"timeout: command not found\" on 6 days.",
    "Learnings",
    "  [x] 3  \"explain it simply, one example first\" (every repo)",
    "         You said this on 12 days.",
    "",
    "↑↓ move · space tick · s see more · enter keep ticked · n keep nothing",
    "w every repo or this repo only · r share this learning with your team · esc decide later",
  ]);
  for (const l of lines) assert.doesNotMatch(l, WORDS, l);
});

test("the screen, skills off: no Skills group, and the last line says how to turn them on (R60)", () => {
  const items = threeItems().slice(1).map((i, k) => ({ ...i, n: k + 1 }));
  const lines = screenLines(items, { cursor: 1, open: 1, openLines: ["You said it on Jul 3, Sep 9 and Oct 14."], note: "this Mac has no timeout in any repo, so it stays every repo" }, factsOf({ skills: false, lookBack: { ...factsOf().lookBack, parent: 0, alreadyKept: { here: 2, elsewhere: [] } } }));
  assert.ok(!lines.includes("Skills"));
  assert.equal(lines[0], "✓ looked back at 23 Claude Code sessions about this repo, typed into on 21 days (Jul 3 to Oct 14)");
  assert.equal(lines[1], "· 2 already kept for every repo (they apply here too)");
  assert.ok(lines.includes("› [x] 2  \"explain it simply, one example first\" (every repo)"));
  assert.ok(lines.includes("         You said it on Jul 3, Sep 9 and Oct 14."), "the open item's lines sit under it");
  assert.ok(lines.includes("this Mac has no timeout in any repo, so it stays every repo"));
  assert.equal(lines[lines.length - 1], "skills are off · trail skills on lets init also find repeated jobs and keep their steps");
});

test("the agent's relay (J02): from Trail, RELAY_LINE and KEEP_LINE word for word, never a choice, Trail checks the typed numbers (D101)", () => {
  const items = threeItems();
  const lines = relayLines(items, factsOf({ agent: true }));
  assert.deepEqual(lines, [
    "✓ looked back at 23 Claude Code sessions about this repo, typed into on 21 days (Jul 3 to Oct 14) · 15 started in the parent folder · names are plain: to name them with Claude, run trail init --look-back in your own terminal",
    "[trail] From Trail, the tool this person installed to keep commands that worked as skills. trail init found these in the past sessions of the person you are working with. Only they decide what Trail keeps, so the list is theirs to answer.",
    RELAY_LINE,
    "For your Claude only. Your teammates' Claude doesn't get these.",
    "",
    "1. release-npm (skill, this repo only)",
    "   Claude worked out how to publish acme-cli to npm from scratch on 21 different days.",
    "",
    "2. no-timeout (always-follow learning, every repo)",
    "   Claude won't use the timeout command, which this Mac doesn't have.",
    "   Claude's commands failed with \"timeout: command not found\" on 6 days.",
    "",
    "3. \"explain it simply, one example first\" (learning in your own words, every repo)",
    "   You said this on 12 days.",
    "",
    "Show one in full: trail skills draft init-1 --print",
    KEEP_LINE,
    "Trail checks the numbers the person typed in this session before it keeps anything, so run trail keep only with the numbers they typed.",
  ]);
  const text = lines.join("\n");
  assert.equal(text.match(new RegExp(escapeRe(RELAY_LINE)), "g")?.length, 1, "once");
  assert.doesNotMatch(text, /\b(?:pick|choose|recommend|whatever looks useful)\b(?! for them)/i, "never tells the agent to choose");
  assert.doesNotMatch(text, WORDS);
});

test("the person's own script (no TTY, not an agent) gets the list without the agent line (B9)", () => {
  const lines = relayLines(threeItems(), factsOf({ agent: false }));
  assert.ok(!lines.includes(RELAY_LINE));
  assert.ok(!lines.some((l) => l.startsWith("[trail]")));
  assert.ok(!lines.includes(KEEP_LINE), "trail keep needs an agent session's receipt");
  assert.equal(lines[lines.length - 1], "Pick in a terminal: trail init");
  assert.ok(lines.includes("3. \"explain it simply, one example first\" (learning in your own words, every repo)"));
  assert.ok(lines.includes("   You said this on 12 days."));
});

test("after a keep: kept, not kept, refused, offers on and off (J09), esc and n", () => {
  const [s, g, p] = threeItems();
  assert.deepEqual(afterKeepLines({ kept: [g!, p!], notKept: [s!], refused: [], how: "enter" }, factsOf()), [
    "✓ kept 2, just for you · in ~/.trail, never committed, never uploaded",
    "Not kept: release-npm. Trail won't bring it up again.",
    "skills: on · at most one offer per session, only after a job checks out · stop offers: trail skills offers off · all off: trail skills off",
  ]);
  assert.deepEqual(afterKeepLines({ kept: [{ ...p!, scope: "repo" }], notKept: [], refused: [{ item: s!, why: "changed" }], how: "keep" }, factsOf({ offers: "off", offersOffAt: "2026-10-09T10:00:00.000Z" })), [
    "✓ kept 1 · 0 just for you in ~/.trail, never uploaded · 1 added to this repo's .trail/learnings (commit it to share)",
    "release-npm: its past session changed or is gone, so Trail can't check the steps. It will offer it again after the job checks out.",
    "skill offers are off (you turned them off on Oct 9) · trail skills offers on",
  ]);
  assert.deepEqual(afterKeepLines({ kept: [], notKept: [], refused: [], how: "esc" }, factsOf()), ["kept nothing · they wait until you run trail init again"]);
  assert.deepEqual(afterKeepLines({ kept: [], notKept: [s!, g!, p!], refused: [], how: "n" }, factsOf()), ["kept nothing · Trail won't bring these up again"]);
  assert.deepEqual(afterKeepLines({ kept: [p!], notKept: [], refused: [], how: "enter" }, factsOf({ skills: false })), ["✓ kept 1, just for you · in ~/.trail, never committed, never uploaded"], "no offers line with skills off");
});

test("--yes's line: an agent's keeps nothing; the person's script keeps only their own words", () => {
  const items = threeItems();
  assert.equal(yesLine(items, true), "found 1 skill, 1 always-follow learning and 1 learning. Kept nothing: an agent ran this. The person picks with trail keep <numbers> after seeing the list, or trail init --look-back in their own terminal");
  assert.equal(yesLine([...items, items[2]!], false), "found 1 skill, 1 always-follow learning and 2 learnings. Kept only the learnings in your own words. To pick the rest: trail init --look-back");
});

test("pickFive: skill, guardrail, preference, then the seconds, a review, then by rank; at most 5; numbered by kind", () => {
  const sk = (k: number): InitCandidate => ({ ...skillCandidate(`i-00000000a${k}`), rank: k });
  const gr = (k: number): InitCandidate => ({ ...guardrailCandidate(), id: `i-00000000b${k}`, rank: k });
  const pr = (k: number): InitCandidate => ({ ...prefCandidate(), id: `i-00000000c${k}`, rank: k });
  const picked = pickFive([pr(2), pr(1), sk(3), sk(2), sk(1), gr(1)]);
  assert.deepEqual(picked.map((c) => c.id), ["i-00000000a1", "i-00000000b1", "i-00000000c1", "i-00000000a2", "i-00000000c2"]);
  assert.deepEqual(numbered(picked).map((c) => `${c.n}:${c.id}`), ["1:i-00000000a1", "2:i-00000000a2", "3:i-00000000b1", "4:i-00000000c1", "5:i-00000000c2"]);
});
