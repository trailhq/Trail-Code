/**
 * Part 7 at init: a preference that only repeats a step of a skill the person
 * keeps on the same screen goes into that skill as a lesson, not listed
 * twice. Each kept item keeps its own consent: the fold happens only when the
 * person kept both, and only for a preference just for them in this repo.
 * The schema example's words; made-up repo only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { keepItems } from "../src/init/keep.js";
import { afterKeepLines, foldTarget, screenLines } from "../src/init/review-screen.js";
import { repoPlace } from "../src/notes/home.js";
import { repoNotesDir } from "../src/notes/repo-notes-dir.js";
import { readLessons } from "../src/skills/lessons.js";
import { runBlock } from "../src/skills/runblock.js";
import { recallMarks, stepLearnings } from "../src/skills/follow-learnings.js";
import { compiled } from "./skills-store-fixtures.js";
import { cand } from "./skills-recall-fixtures.js";
import { factsOf, prefCandidate, projectTranscript, skillCandidate, withHome } from "./init-screen-fixtures.js";
import { typed as typedLine } from "./trace-fixtures.js";
import type { InitItem } from "../src/init/types.js";

const PREF = "don't edit _schema.py by hand, run scripts/gen_schema.py";
const NOW = new Date("2026-10-22T10:00:00Z");

function repoIn(home: string, env: NodeJS.ProcessEnv): { dir: string; repoKey: string } {
  const dir = join(home, "syncsvc");
  spawnSync("mkdir", ["-p", dir]);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  // A remote, so the key is short wherever the temp folder is (a local key from a deep TMPDIR is not a folder name).
  spawnSync("git", ["remote", "add", "origin", "git@github.com:acme/syncsvc.git"], { cwd: dir });
  return { dir, repoKey: repoPlace(dir, env).key };
}

const runTests = () => compiled("run-tests", { job: "tests", asks: "run the tests", params: undefined, check: "pytest -q", "check-shows": undefined }, {
  title: "Run the tests", description: "Runs the tests from the steps that worked on Oct 2. Use when asked to run the tests.",
  steps: [
    { n: 1, cmd: "python scripts/gen_schema.py", gated: null, bg: false, wait: false, from: ["toolu_01"] },
    { n: 2, cmd: "pytest -q", gated: null, bg: false, wait: false, from: ["toolu_02"] },
  ],
  check: "pytest -q", checkShows: null, checkIsStep: true, params: [],
});

function items(home: string, repoKey: string, pref: { line?: string; applies?: string } = {}): InitItem[] {
  const { refs } = projectTranscript(home, [typedLine("run the tests"), typedLine(pref.line ?? PREF)]);
  return [
    { ...skillCandidate("i-1f0e2a9c41", runTests()), applies: repoKey, key: `${repoKey}|job:tests`, n: 1, title: "run-tests", description: "" },
    { ...prefCandidate(refs[1]!), applies: pref.applies ?? repoKey, n: 2, title: pref.line ?? PREF, description: "" },
  ];
}

const prefFiles = (env: NodeJS.ProcessEnv, repoKey: string) => [join(env.TRAIL_HOME!, "learnings"), repoNotesDir(repoKey, env)]
  .flatMap((d) => (existsSync(d) ? readdirSync(d) : []));

test("the schema example: kept together, the preference goes into run-tests as a lesson, and the agent hears it once", async () => {
  await withHome("p7-fold", ({ home, env }) => {
    const place = repoIn(home, env);
    const all = items(home, place.repoKey);
    // The screen says so before the keep, on the preference's own line.
    const screen = screenLines(all, { cursor: 0, open: null }, factsOf());
    assert.ok(screen.includes("         Kept with skill 1, it goes into that skill as a learning, since a step of it already does this."), screen.join("\n"));

    const r = keepItems(all, all, "tty", env, NOW, place);
    assert.deepEqual(r.kept.map((i) => i.n), [1, 2]);
    assert.deepEqual(r.folded?.map((f) => [f.item.n, f.skill]), [[2, "run-tests"]]);
    assert.deepEqual(prefFiles(env, place.repoKey), [], "no learning of its own: it is a lesson on the skill");
    const lessons = readLessons(join(env.TRAIL_HOME!, "skills", "run-tests"));
    assert.deepEqual(lessons.map((l) => [l.text, l.at]), [[PREF, "2026-07-03"]]);
    const after = afterKeepLines({ ...r, how: "enter" }, factsOf());
    assert.ok(after.includes(`· "${PREF.replace(/"/g, "'")}" went into run-tests as a learning, since a step of it already does that`), after.join("\n"));

    // What the agent hears when the skill comes back: the lesson, once, and no learning says it again.
    const c = cand(runTests(), { lastWorked: "2026-10-02" });
    c.ref.dir = join(env.TRAIL_HOME!, "skills", "run-tests");
    const marks = recallMarks(c.skill.steps, stepLearnings({ repoKeys: [place.repoKey], checkout: place.dir, env }));
    assert.deepEqual(marks, []);
    const block = runBlock(c, { values: {}, notes: [], probes: [], canAsk: true, header: "job", lastFail: null, gone: [], marks });
    assert.equal(block.split(PREF).length - 1, 1, block);
  });
});

test("each item keeps its own consent: the preference alone is kept as a preference, the skill alone gets no lesson", async () => {
  await withHome("p7-fold-own", ({ home, env }) => {
    const place = repoIn(home, env);
    const all = items(home, place.repoKey);
    const onlyPref = keepItems([all[1]!], all, "tty", env, NOW, place);
    assert.equal(onlyPref.folded, undefined);
    assert.equal(prefFiles(env, place.repoKey).length, 1, "kept as its own learning");
  });
  await withHome("p7-fold-skill", ({ home, env }) => {
    const place = repoIn(home, env);
    const all = items(home, place.repoKey);
    const onlySkill = keepItems([all[0]!], all, "tty", env, NOW, place);
    assert.equal(onlySkill.folded, undefined);
    assert.deepEqual(readLessons(join(env.TRAIL_HOME!, "skills", "run-tests")), []);
  });
});

test("never folded: a preference for every repo, one added to the repo, one that says more than the step, or one against it", async () => {
  await withHome("p7-fold-not", ({ home, env }) => {
    const place = repoIn(home, env);
    const every = items(home, place.repoKey, { applies: "every repo" });
    assert.equal(foldTarget(every[1]!, every), null);
    const repo = items(home, place.repoKey);
    repo[1] = { ...repo[1]!, scope: "repo" };
    assert.equal(foldTarget(repo[1]!, repo), null);
    const more = items(home, place.repoKey, { line: "run scripts/gen_schema.py, then tell me what changed" });
    assert.equal(foldTarget(more[1]!, more), null);
    const against = items(home, place.repoKey, { line: "never run pytest, use make test" });
    assert.equal(foldTarget(against[1]!, against), null);
    // The transcript the items point into holds the last line written: build them again for the keep.
    const again = items(home, place.repoKey, { line: "run scripts/gen_schema.py, then tell me what changed" });
    const r = keepItems(again, again, "tty", env, NOW, place);
    assert.equal(r.folded, undefined);
    assert.equal(prefFiles(env, place.repoKey).length, 1);
  });
});
