/**
 * Skills: corrections become takeaways, kept on this machine in ~/.trail, and
 * takeaways fold into a SKILL.md: the repo's own skill in `.claude/skills/`,
 * or one kept in ~/.trail until someone publishes it into the repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirm,
  fold,
  getSkill,
  isConfirmed,
  learn,
  listSkills,
  parseTakeaway,
  publish,
  renderTakeaway,
  skillDirs,
  skillForAgent,
  skillsDirective,
  skillStatus,
} from "../src/skills/skills.js";
import { homeEnv, tmpRepo } from "./helpers.js";

process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-trail-home-"));

const DAY = "2026-10-07";
const ROTATION = "Read rotation with page.Rotation() from internal/pdf/page.go.\nNever pdfcpu: it drops /Rotate on linearized files.";

/** A repo with a hand-written team skill, extra frontmatter and all. */
function repoWithTeamSkill(tag: string): string {
  const repo = tmpRepo(tag);
  mkdirSync(join(repo, ".claude", "skills", "deploys"), { recursive: true });
  writeFileSync(
    join(repo, ".claude", "skills", "deploys", "SKILL.md"),
    "---\nname: deploys\ndescription: How this repo ships\nallowed-tools: Bash(make:*)\n---\n\n# deploys\n\nShip with make ship.\n",
  );
  return repo;
}

test("learn starts a skill in ~/.trail on first use, every takeaway its own file, and the repo untouched", () => {
  const repo = tmpRepo("skills-learn");
  const a = learn(repo, { skill: "PDF coords", text: ROTATION, author: "Sam", date: DAY, description: "Coordinates, boxes and rotation for PDF pages", section: "Rotation" });
  assert.equal(a.created, true);
  assert.equal(a.skill.name, "pdf-coords");
  assert.equal(a.skill.where, "home");
  const home = skillDirs(repo).home;
  assert.ok(home.startsWith(process.env.TRAIL_HOME!), home);
  assert.equal(a.takeaway.path, join(home, "pdf-coords", "takeaways", "2026-10-07-sam-1.md"));
  const b = learn(repo, { skill: "pdf-coords", text: "Boxes are in points, not pixels.", author: "Sam", date: DAY });
  assert.equal(b.created, false);
  assert.equal(b.takeaway.path, join(home, "pdf-coords", "takeaways", "2026-10-07-sam-2.md"));
  const s = getSkill(repo, "pdf-coords")!;
  assert.equal(s.version, 1);
  assert.equal(s.description, "Coordinates, boxes and rotation for PDF pages");
  assert.equal(s.takeaways.length, 2);
  assert.deepEqual(readdirSync(repo), [], "nothing in the repo");
});

test("a takeaway on a skill the repo already has stays on this machine, and folds into the repo's SKILL.md keeping its frontmatter", () => {
  const repo = repoWithTeamSkill("skills-team");
  const r = learn(repo, { skill: "deploys", text: "Run the migration check before make ship.", author: "Priya", date: DAY });
  assert.equal(r.created, false);
  assert.equal(r.skill.where, "repo");
  assert.ok(r.takeaway.path.startsWith(skillDirs(repo).home));
  assert.deepEqual(readdirSync(join(repo, ".claude", "skills", "deploys")), ["SKILL.md"], "the takeaway isn't in the repo");

  const f = fold(repo, "deploys")!;
  assert.equal(f.where, "repo");
  assert.equal(f.file, join(repo, ".claude", "skills", "deploys", "SKILL.md"));
  const md = readFileSync(f.file, "utf8");
  assert.match(md, /^allowed-tools: Bash\(make:\*\)$/m, "the team's own keys survive");
  assert.match(md, /^version: 2$/m);
  assert.match(md, /Ship with make ship\.\n\n## Takeaways\n- Run the migration check before make ship\. \(Priya, Oct 7\)/);
});

test("trail's and graft's own skills never take takeaways", () => {
  const repo = tmpRepo("skills-own");
  mkdirSync(join(repo, ".claude", "skills", "trail"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", "trail", "SKILL.md"), "---\nname: trail\n---\nx\n");
  assert.throws(() => learn(repo, { skill: "trail", text: "x", author: "Sam", date: DAY }), /code map's own skill/);
  assert.deepEqual(listSkills(repo), []);
});

test("a takeaway round-trips through its file", () => {
  const t = { skill: "pdf-coords", taughtBy: "Sam", date: DAY, from: "correction", confirmedBy: ["Lena"], section: "Rotation", foldedIn: 4, text: ROTATION };
  assert.deepEqual(parseTakeaway(renderTakeaway(t), "p.md", "pdf-coords"), { ...t, path: "p.md" });
});

test("only someone other than the teacher can confirm", () => {
  const repo = tmpRepo("skills-confirm");
  learn(repo, { skill: "pdf-coords", text: ROTATION, author: "Sam", date: DAY });
  assert.deepEqual(confirm(repo, "pdf-coords", "Sam"), [], "the teacher can't confirm their own");
  assert.equal(confirm(repo, "pdf-coords", "Lena").length, 1);
  assert.equal(confirm(repo, "pdf-coords", "Lena").length, 0, "confirming twice changes nothing");
  assert.ok(isConfirmed(getSkill(repo, "pdf-coords")!.takeaways[0]!));
});

test("fold writes waiting takeaways under their heading, bumps the version, and keeps the files; --confirmed takes only confirmed ones", () => {
  const repo = tmpRepo("skills-fold");
  learn(repo, { skill: "pdf-coords", text: ROTATION, author: "Sam", date: DAY, section: "Rotation" });
  learn(repo, { skill: "pdf-coords", text: "Boxes are in points.", author: "Priya", date: DAY });
  confirm(repo, "pdf-coords", "Lena", "2026-10-07-sam-1");

  const r = fold(repo, "pdf-coords", { confirmed: true })!;
  assert.equal(r.from, 1);
  assert.equal(r.to, 2);
  assert.equal(r.folded.length, 1);
  assert.equal(r.stillWaiting, 1);
  assert.deepEqual(r.sections, ["Rotation"]);
  const file = join(skillDirs(repo).home, "pdf-coords", "SKILL.md");
  assert.equal(r.file, file);
  const md = readFileSync(file, "utf8");
  assert.match(md, /^version: 2$/m);
  assert.match(md, /## Rotation\n- Read rotation with page\.Rotation\(\) from internal\/pdf\/page\.go\. Never pdfcpu: it drops \/Rotate on linearized files\. \(Sam, Oct 7\)/);
  assert.ok(existsSync(join(skillDirs(repo).home, "pdf-coords", "takeaways", "2026-10-07-sam-1.md")), "history stays");
  assert.equal(getSkill(repo, "pdf-coords")!.takeaways.find((t) => t.taughtBy === "Sam")?.foldedIn, 2);

  // A plain fold takes the rest, under Takeaways since it named no heading.
  const rest = fold(repo, "pdf-coords")!;
  assert.equal(rest.to, 3);
  assert.deepEqual(rest.sections, ["Takeaways"]);
  assert.match(readFileSync(file, "utf8"), /## Takeaways\n- Boxes are in points\. \(Priya, Oct 7\)/);
  assert.equal(fold(repo, "pdf-coords")!.folded.length, 0, "nothing left");
  assert.equal(fold(repo, "nope"), null);
});

test("publish moves a skill from ~/.trail into the repo's .claude/skills/; its takeaways stay and fold into the repo's copy", () => {
  const repo = tmpRepo("skills-publish");
  learn(repo, { skill: "pdf-coords", text: ROTATION, author: "Sam", date: DAY, description: "PDF coordinates" });
  fold(repo, "pdf-coords");
  const p = publish(repo, "pdf-coords");
  assert.deepEqual(p, { ok: true, file: join(repo, ".claude", "skills", "pdf-coords", "SKILL.md") });
  assert.match(readFileSync(join(repo, ".claude", "skills", "pdf-coords", "SKILL.md"), "utf8"), /^version: 2$/m);
  assert.equal(existsSync(join(skillDirs(repo).home, "pdf-coords", "SKILL.md")), false, "one copy, the repo's");
  assert.equal(getSkill(repo, "pdf-coords")!.where, "repo");
  assert.equal(getSkill(repo, "pdf-coords")!.takeaways.length, 1, "the folded takeaway's history stays here");
  assert.deepEqual(publish(repo, "pdf-coords"), { ok: false, reason: "in-repo" });
  assert.deepEqual(publish(repo, "nope"), { ok: false, reason: "unknown" });

  learn(repo, { skill: "pdf-coords", text: "Boxes are in points.", author: "Sam", date: DAY });
  assert.equal(fold(repo, "pdf-coords")!.file, join(repo, ".claude", "skills", "pdf-coords", "SKILL.md"));
});

test("skills says what each one is waiting on, and where it lives", () => {
  const repo = tmpRepo("skills-status");
  learn(repo, { skill: "pdf-coords", text: ROTATION, author: "Sam", date: DAY });
  const s = () => getSkill(repo, "pdf-coords")!;
  assert.equal(skillStatus(s()), "v1 · 1 takeaway waiting to fold · last taught by Sam, Oct 7 · on this machine");
  confirm(repo, "pdf-coords", "Lena");
  assert.equal(skillStatus(s()), "v1 · 1 takeaway waiting to fold (1 confirmed) · last taught by Sam, Oct 7 · on this machine");
  fold(repo, "pdf-coords");
  assert.equal(skillStatus(s()), "v2 · up to date · on this machine");
});

test("what an agent reads: the skill, then the corrections not yet in it, newest first", () => {
  const repo = repoWithTeamSkill("skills-show");
  learn(repo, { skill: "deploys", text: "Older rule.", author: "Sam", date: "2026-10-05" });
  learn(repo, { skill: "deploys", text: "Newer rule.", author: "Priya", date: DAY });
  const text = skillForAgent(getSkill(repo, "deploys")!);
  assert.match(text, /^# deploys \(v1, the team's\)\n\n# deploys\n\nShip with make ship\.\n\n## Corrections since v1/);
  assert.ok(text.indexOf("Newer rule. (Priya, Oct 7)") < text.indexOf("Older rule. (Sam, Oct 5)"));
});

test("a session hears about skills Claude Code can't load by itself, and nothing when there are none", () => {
  const repo = repoWithTeamSkill("skills-directive");
  assert.equal(skillsDirective(repo, "trail skills show"), "", "the team's skill with nothing waiting: Claude Code has it");
  learn(repo, { skill: "pdf-coords", text: ROTATION, author: "Sam", date: DAY });
  learn(repo, { skill: "deploys", text: "Run the migration check first.", author: "Sam", date: DAY });
  const line = skillsDirective(repo, "trail skills show");
  assert.match(line, /deploys \(1 correction newer than its SKILL\.md\)/);
  assert.match(line, /pdf-coords \(on this machine, 1 correction\)/);
  assert.match(line, /run `trail skills show <name>`/);
});

// --- end to end ---

function run(args: string[], home: string, input?: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_HOME: undefined },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("trail learn, skills, show, fold and publish from the command line", () => {
  const home = mkdtempSync(join(tmpdir(), "skills-home-"));
  const d = tmpRepo("skills-cli");
  spawnSync("git", ["init", "-q"], { cwd: d });
  const learnt = run(["learn", "pdf-coords", d, "--author", "Sam", "--section", "Rotation"], home, ROTATION);
  assert.equal(learnt.status, 0, learnt.err);
  assert.match(learnt.out, /^✓ takeaway saved to new skill pdf-coords · taught by Sam$/m);
  assert.match(learnt.out, /kept on this machine, in ~\/\.trail\/repos\/local\/[^/]+\/skills\/pdf-coords$/m);
  assert.equal(existsSync(join(d, ".claude")), false, "nothing in the repo");

  assert.match(run(["skills", d], home).out, /^pdf-coords {2}v1 · 1 takeaway waiting to fold · last taught by Sam, \w{3} \d+ · on this machine$/m);
  assert.match(run(["skills", "show", "pdf-coords", "-C", d], home).out, /## Corrections since v1[^\n]*\n- Read rotation with page\.Rotation\(\)/);
  const folded = run(["skills", "fold", "pdf-coords", "-C", d], home);
  assert.equal(folded.status, 0, folded.err);
  assert.match(folded.out, /✓ pdf-coords v1 → v2 · folded 1 takeaway/);
  assert.match(folded.out, /trail skills publish <skill> moves a skill into the repo's \.claude\/skills\//);
  assert.match(run(["skills", d], home).out, /^pdf-coords {2}v2 · up to date · on this machine$/m);

  const pub = run(["skills", "publish", "pdf-coords", "-C", d], home);
  assert.equal(pub.status, 0, pub.err);
  assert.match(pub.out, /^✓ pdf-coords → \.claude\/skills\/pdf-coords\/SKILL\.md$/m);
  assert.ok(existsSync(join(d, ".claude", "skills", "pdf-coords", "SKILL.md")));
  assert.match(run(["skills", d], home).out, /^pdf-coords {2}v2 · up to date · in the repo$/m);

  const missing = run(["skills", "show", "nope", "-C", d], home);
  assert.equal(missing.status, 1);
  assert.match(missing.err, /no skill called nope · trail skills lists them/);
  const empty = run(["learn", "pdf-coords", d], home, "");
  assert.equal(empty.status, 1);
  assert.match(empty.err, /a takeaway needs its text/);
});
