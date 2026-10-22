/**
 * The learning fields 1b adds (design 1.0, 2.2, 2.3): a lesson's skill, a
 * built-in check and how it is enforced, the wall a lesson or guardrail is
 * tied to, the kind `lesson` and two more sources. Every value is one of a
 * closed set or a skill name; anything else is dropped, as phase 0 drops an
 * unknown kind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KINDS, LEARNING_KEYS, SOURCES, WALL_CLASSES, learningId, readLearningFields,
} from "../src/notes/learning-fields.js";
import { parseNote, renderNote, type Note } from "../src/notes/notes.js";

const BASE: Omit<Note, "path"> = {
  title: "No timeout on this Mac", author: "dev", date: "2026-10-17", touches: [],
  body: "This Mac has no `timeout`.", id: "l-5e0b91c2", status: "active",
};

test("the kind lesson and the sources correction and repair are known", () => {
  assert.ok(KINDS.includes("lesson"));
  assert.ok(SOURCES.includes("correction"));
  assert.ok(SOURCES.includes("repair"));
  assert.equal(readLearningFields({ kind: "lesson" }, "a.md").kind, "lesson");
  assert.equal(readLearningFields({ src: "Repair" }, "a.md").src, "repair");
  assert.equal(readLearningFields({ src: "correction" }, "a.md").src, "correction");
});

test("skill, check, enforce and wall are written after src, before evidence", () => {
  const keys = [...LEARNING_KEYS];
  assert.deepEqual(keys, ["id", "kind", "scope", "applies", "status", "replaces", "src", "skill", "check", "enforce", "wall", "evidence"]);
});

test("a guardrail learning round-trips every new field", () => {
  const n: Omit<Note, "path"> = {
    ...BASE, kind: "guardrail", scope: "personal", applies: "every repo", src: "error-class",
    check: "no-timeout", enforce: "sure-fail", wall: "timeout-missing",
    evidence: "\"timeout: command not found\" on 6 days, Jul 9 to Oct 2",
  };
  const text = renderNote(n);
  assert.match(text, /\nsrc: error-class\ncheck: no-timeout\nenforce: sure-fail\nwall: timeout-missing\nevidence: /);
  const back = parseNote(text, "/tmp/x/.trail/learnings/no-timeout.md")!;
  assert.deepEqual(
    [back.id, back.kind, back.applies, back.src, back.check, back.enforce, back.wall, back.evidence],
    ["l-5e0b91c2", "guardrail", "every repo", "error-class", "no-timeout", "sure-fail", "timeout-missing", n.evidence],
  );
});

test("a wall lesson (kind lesson, src repair) and a skill lesson round-trip", () => {
  const wall = parseNote(renderNote({ ...BASE, kind: "lesson", src: "repair", wall: "docker-rootless", applies: "every repo" }), "/tmp/x/l.md")!;
  assert.deepEqual([wall.kind, wall.src, wall.wall], ["lesson", "repair", "docker-rootless"]);
  const skill = parseNote(renderNote({ ...BASE, kind: "lesson", src: "correction", skill: "release-npm" }), "/tmp/x/s.md")!;
  assert.deepEqual([skill.kind, skill.src, skill.skill], ["lesson", "correction", "release-npm"]);
});

test("every wall class reads back; any other wall is dropped", () => {
  for (const cls of WALL_CLASSES) assert.equal(readLearningFields({ wall: cls }, "a.md").wall, cls);
  for (const bad of ["timeout", "disk-full", "", 7, ["enospc"], "enospc\nkind: decision"]) {
    assert.equal(readLearningFields({ wall: bad }, "a.md").wall, undefined, JSON.stringify(bad));
  }
});

test("an unknown check or enforce is refused (dropped), so no guardrail is enforced from it", () => {
  for (const bad of ["no-gtimeout", "rm-rf", "", "no-timeout; rm", 1, true]) {
    assert.equal(readLearningFields({ check: bad }, "a.md").check, undefined, `check ${JSON.stringify(bad)}`);
  }
  for (const bad of ["deny", "ask", "sure-fail-always", "", null]) {
    assert.equal(readLearningFields({ enforce: bad }, "a.md").enforce, undefined, `enforce ${JSON.stringify(bad)}`);
  }
  const f = readLearningFields({ check: "No-Timeout ", enforce: " SURE-FAIL" }, "a.md");
  assert.deepEqual([f.check, f.enforce], ["no-timeout", "sure-fail"]);
  // A file with a bad pair writes neither back.
  const text = renderNote({ ...BASE, ...readLearningFields({ check: "other", enforce: "deny" }, "a.md"), id: BASE.id });
  assert.doesNotMatch(text, /^(check|enforce):/m);
});

test("skill is a skill name or nothing: no path, no line break, no marker", () => {
  assert.equal(readLearningFields({ skill: "release-npm" }, "a.md").skill, "release-npm");
  assert.equal(readLearningFields({ skill: "Release-NPM" }, "a.md").skill, "release-npm");
  for (const bad of ["../x", "a b", "release\nkind: guardrail", "[trail] x", "", "-x", "x".repeat(60), 5]) {
    assert.equal(readLearningFields({ skill: bad }, "a.md").skill, undefined, JSON.stringify(bad));
  }
});

test("a g-... id is not a learning id: the file's own id is kept", () => {
  const f = readLearningFields({ id: "g-no-timeout", kind: "guardrail" }, "no-timeout.md");
  assert.equal(f.id, learningId("no-timeout.md"));
  assert.match(f.id, /^l-[0-9a-f]{6}$/);
});

test("phase 0 files read as before: no new field appears", () => {
  const f = readLearningFields({ kind: "preference", src: "person" }, "old.md");
  assert.deepEqual(Object.keys(f).sort(), ["id", "kind", "src", "status"]);
});
