/**
 * The personal skill store (`~/.trail/skills`, design 1.4, 2, spec 5 and 6):
 * saving writes SKILL.md, scripts/ and an empty lessons/ privately and never
 * through a link; listing follows where a skill applies and what the person
 * turned off; names are checked in every place a skill can live; a job is
 * covered by a live skill or an unshown held item; forget and restore move
 * folders to and from `.retired/` and keep what the skill was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILT_IN_NAMES, findSkill, forgetSkill, jobCovered, listAllPersonal, listRepoSkills, listSkills, listTeamSkills, nameTaken,
  newSkillId, personalSkillsDir, readSkill, restoreSkill, saveHeld, savePersonal, type ScopeCtx,
} from "../src/skills/store.js";
import { BUILT_IN_NAMES as COMPILE_NAMES } from "../src/skills/compile.js";
import { renderSkillMd, skillHash } from "../src/skills/skillmd.js";
import { getSkillState, recordCorrected, recordUse, updateSkillState } from "../src/skills/state.js";
import { appendLedger } from "../src/skills/ledger.js";
import type { LedgerUse } from "../src/skills/types.js";
import { readLedger } from "../src/skills/ledger.js";
import { localDate } from "../src/skills/settings.js";
import { box, compiled, SHOP, STOREFRONT, writeSkillFile, type Box } from "./skills-store-fixtures.js";

const POSIX = process.platform !== "win32";
const NOW = new Date("2026-10-28T09:00:00.000Z");
const mode = (p: string) => statSync(p).mode & 0o777;
const ctxOf = (b: Box, repoKeys = [SHOP]): ScopeCtx => ({ repoKeys, checkout: b.checkout, env: b.env });
const save = (b: Box, c = compiled(), from: "asked" | "repeated" = "repeated") =>
  savePersonal(c, { from, runId: c.source.runId, consent: from === "asked" ? "asked" : "offer-yes", stepsVerified: 2, env: b.env, now: NOW });
const names = (refs: Array<{ name: string }>) => refs.map((r) => r.name);

test("BUILT_IN_NAMES is compile's list, re-exported", () => {
  assert.equal(BUILT_IN_NAMES, COMPILE_NAMES);
  for (const n of ["trail", "skills", "keep", "forget", "restore", "add", "on", "off"]) assert.ok(BUILT_IN_NAMES.has(n), n);
});

test("savePersonal writes SKILL.md, scripts/ and an empty lessons/, privately, then a candidate state and a saved line", () => {
  const b = box();
  const c = compiled("release-npm", {}, { helpers: [{ file: "wait-npm.sh", from: "/tmp/x/wait-npm.sh", content: "#!/bin/sh\nnpm view acme-cli version\n" }] });
  const ref = save(b, c);
  const dir = join(b.trail, "skills", "release-npm");
  assert.equal(personalSkillsDir(b.env), join(b.trail, "skills"));
  assert.deepEqual(ref, { id: "s-7f3a2c", name: "release-npm", scope: "personal", applies: SHOP, dir, file: join(dir, "SKILL.md") });
  assert.equal(readFileSync(ref.file, "utf8"), renderSkillMd(c));
  assert.equal(readFileSync(join(dir, "scripts", "wait-npm.sh"), "utf8"), "#!/bin/sh\nnpm view acme-cli version\n");
  assert.deepEqual(readdirSync(join(dir, "lessons")), []);
  assert.deepEqual(readdirSync(dir).sort(), ["SKILL.md", "lessons", "scripts"]);
  if (POSIX) {
    for (const d of [join(b.trail, "skills"), dir, join(dir, "scripts"), join(dir, "lessons")]) assert.equal(mode(d), 0o700, d);
    assert.equal(mode(ref.file), 0o600);
    assert.equal(mode(join(dir, "scripts", "wait-npm.sh")), 0o700);
  }
  assert.deepEqual(getSkillState("s-7f3a2c", b.env), {
    name: "release-npm", scope: "personal", status: "candidate", from: "repeated", runId: "r-1027-3f9a", addedAt: NOW.toISOString(),
    lastWorked: localDate("2026-10-27T10:44:05.000Z"), lastUsedAt: null, lastUsedRepo: null, uses: 0, checkedUses: 0,
    hash: skillHash(renderSkillMd(c)), source: { commands: 9, failed: 1, at: "2026-10-27T10:44:05.000Z" }, lastFails: [], promoteOffers: {},
  });
  assert.deepEqual(readLedger("s-7f3a2c", b.env), [{
    at: NOW.toISOString(), event: "saved", skill: "s-7f3a2c", v: "1", from: "repeated", scope: "personal",
    receipt: { consent: "offer-yes", stepsVerified: 2, stepsTotal: 3 },
  }]);
});

test("savePersonal: a check that is the last step is not counted twice", () => {
  const b = box();
  const c = compiled("go-tests", { job: "tests", check: "go test ./..." }, {
    steps: [{ n: 1, cmd: "go test ./...", gated: null, bg: false, wait: false }], check: "go test ./...", checkIsStep: true,
  });
  save(b, c, "asked");
  const [line] = readLedger("s-7f3a2c", b.env) as Array<{ receipt: { stepsTotal: number; consent: string } }>;
  assert.deepEqual(line!.receipt, { consent: "asked", stepsVerified: 2, stepsTotal: 1 });
});

test("savePersonal never writes into a folder that is already there, a planted link included", () => {
  const b = box();
  save(b);
  assert.throws(() => save(b, compiled("release-npm", { trail: "s-000001" })), /already/);
  const elsewhere = join(b.home, "elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(join(b.trail, "skills"), { recursive: true });
  symlinkSync(elsewhere, join(b.trail, "skills", "deploy-shop"));
  assert.throws(() => save(b, compiled("deploy-shop", { trail: "s-000002" })), /already/);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(getSkillState("s-000002", b.env), null);
});

test("savePersonal refuses a bad name or a helper file name that could leave scripts/", () => {
  const b = box();
  for (const bad of ["../x", "skills", "Release", "a/b", "13"]) assert.throws(() => save(b, compiled(bad, { trail: "s-000003" })), /name/, bad);
  for (const file of ["../evil.sh", "a/b.sh", ".hidden", ""]) {
    assert.throws(() => save(b, compiled("with-helper", { trail: "s-000004" }, { helpers: [{ file, from: "/tmp/x", content: "x" }] })), /helper/, file);
  }
  assert.equal(existsSync(join(b.trail, "skills", "with-helper")), false);
  assert.equal(existsSync(join(b.trail, "evil.sh")), false);
});

test("savePersonal: an id another live skill holds gets a fresh one, in the file and the state alike", () => {
  const b = box();
  save(b);
  const ref = save(b, compiled("ship-storefront", { applies: STOREFRONT, job: "ship" }));
  assert.notEqual(ref.id, "s-7f3a2c");
  assert.match(ref.id, /^s-[0-9a-f]{6}$/);
  assert.match(readFileSync(ref.file, "utf8"), new RegExp(`trail: "${ref.id}"`));
  assert.equal(getSkillState(ref.id, b.env)?.name, "ship-storefront");
  assert.equal(getSkillState("s-7f3a2c", b.env)?.name, "release-npm");
});

test("listSkills: personal skills that apply here or everywhere, links followed, others left out", () => {
  const b = box();
  save(b, compiled("release-npm"));
  save(b, compiled("ship-storefront", { trail: "s-00000a", applies: STOREFRONT, job: "ship" }));
  save(b, compiled("fix-colima", { trail: "s-00000b", applies: "every repo", job: undefined }));
  // A skill folder linked in from elsewhere is listed.
  const src = join(b.home, "dotfiles", "deploy-shop");
  writeSkillFile(src, compiled("deploy-shop", { trail: "s-00000c", applies: "GitHub.com/Acme/Shop", job: "ship" }));
  symlinkSync(src, join(b.trail, "skills", "deploy-shop"));
  // Not Trail's (no metadata.trail), a stray file, and a dot folder are never listed.
  mkdirSync(join(b.trail, "skills", "hand-written"));
  writeFileSync(join(b.trail, "skills", "hand-written", "SKILL.md"), "---\nname: hand-written\ndescription: mine\n---\n# Mine\n");
  writeFileSync(join(b.trail, "skills", "notes.txt"), "x");
  writeSkillFile(join(b.trail, "skills", ".versions"), compiled("versions", { trail: "s-00000d" }));

  assert.deepEqual(names(listSkills(ctxOf(b))), ["deploy-shop", "fix-colima", "release-npm"]);
  assert.deepEqual(names(listSkills(ctxOf(b, [STOREFRONT]))), ["fix-colima", "ship-storefront"]);
  assert.deepEqual(names(listSkills(ctxOf(b, []))), ["fix-colima"]);
  const linked = listSkills(ctxOf(b)).find((r) => r.name === "deploy-shop")!;
  assert.equal(linked.dir, join(b.trail, "skills", "deploy-shop"));
  assert.equal(readSkill(linked)?.meta.trail, "s-00000c");
  assert.deepEqual(names(listAllPersonal(b.env)), ["deploy-shop", "fix-colima", "release-npm", "ship-storefront"]);
});

test("listSkills leaves out skills the person turned off and retired ones; needs-fix stays for the index", () => {
  const b = box();
  save(b, compiled("release-npm"));
  save(b, compiled("deploy-shop", { trail: "s-00000c", job: "ship" }));
  save(b, compiled("lint-shop", { trail: "s-00000e", job: undefined }));
  mkdirSync(b.trail, { recursive: true });
  writeFileSync(join(b.trail, "settings.json"), JSON.stringify({ v: 1, skills: "on", skillsOff: ["deploy-shop"] }));
  updateSkillState("s-00000e", (s) => ({ ...s!, status: "retired" }), b.env);
  updateSkillState("s-7f3a2c", (s) => ({ ...s!, status: "needs-fix" }), b.env);
  assert.deepEqual(names(listSkills(ctxOf(b))), ["release-npm"]);
  assert.equal(findSkill("deploy-shop", ctxOf(b)), null);
  assert.equal(findSkill("release-npm", ctxOf(b))?.id, "s-7f3a2c");
  assert.equal(findSkill("release-npm", ctxOf(b, [STOREFRONT])), null);
  assert.deepEqual(names(listAllPersonal(b.env)), ["deploy-shop", "lint-shop", "release-npm"]);
});

test("repo and team skills are phase 3: their lists are empty in 1a even with skills on disk", () => {
  const b = box();
  writeSkillFile(join(b.checkout, ".agents", "skills", "release-npm"), compiled("release-npm", { scope: "repo" }));
  writeSkillFile(join(b.trail, "teams", "acme", "skills", "ship-storefront"), compiled("ship-storefront", { scope: "team", trail: "s-00000a" }));
  assert.deepEqual(listRepoSkills(b.checkout), []);
  assert.deepEqual(listTeamSkills([SHOP], b.env), []);
  assert.deepEqual(listSkills(ctxOf(b)), []);
});

test("readSkill: the parsed file; nothing for a missing, oversized or non-file SKILL.md", () => {
  const b = box();
  const ref = save(b);
  const parsed = readSkill(ref)!;
  assert.equal(parsed.meta.trail, "s-7f3a2c");
  assert.deepEqual(parsed.steps.map((s) => s.cmd), ["npm run build", "npm publish --access public"]);
  assert.equal(readSkill({ ...ref, file: join(ref.dir, "nope.md") }), null);
  writeFileSync(ref.file, renderSkillMd(compiled()) + "\n".repeat(70 * 1024));
  assert.equal(readSkill(ref), null);
  assert.equal(readSkill({ ...ref, file: ref.dir }), null);
});

test("readSkill: a needs-fix skill changed by hand goes back to what it was", () => {
  const b = box();
  const ref = save(b);
  updateSkillState(ref.id, (s) => ({ ...s!, status: "needs-fix", prevStatus: "active", statusWhy: "step 2 failed on Nov 2 and Nov 4" }), b.env);
  readSkill(ref);
  assert.equal(getSkillState(ref.id, b.env)?.status, "needs-fix");
  writeFileSync(ref.file, readFileSync(ref.file, "utf8").replace("Other packages", "Other npm packages"));
  readSkill(ref);
  assert.equal(getSkillState(ref.id, b.env)?.status, "active");
});

const failedUse = (id: string, at: string, useId = "u-000001"): LedgerUse => ({
  at, event: "use", useId, skill: id, v: "1", host: "claude", cue: "job", repo: SHOP, stepsRan: [1], failedStep: 2, readyFailed: [], check: "none", calls: 2, failed: 1,
});

test("D65: a hand edit made before a skill went needs-fix doesn't bring it back; only an edit after the mark does", () => {
  const b = box();
  const ref = save(b);
  const trailWrote = getSkillState(ref.id, b.env)!.hash;
  updateSkillState(ref.id, (s) => ({ ...s!, status: "active" }), b.env);
  // The person tidied the file while it was active, then it failed twice at step 2.
  writeFileSync(ref.file, readFileSync(ref.file, "utf8").replace("Other packages", "Other npm packages"));
  const before = skillHash(readFileSync(ref.file, "utf8"));
  recordUse(ref.id, failedUse(ref.id, "2026-11-02T10:00:00.000Z"), b.env);
  const marked = recordUse(ref.id, failedUse(ref.id, "2026-11-04T10:00:00.000Z"), b.env)!;
  assert.equal(marked.status, "needs-fix");
  assert.equal(marked.fixHash, before);
  // Every read sees the same (older) edit: it stays needs-fix, read after read.
  for (let i = 0; i < 3; i++) {
    readSkill(ref);
    assert.equal(getSkillState(ref.id, b.env)?.status, "needs-fix", `read ${i}`);
  }
  // An edit after the mark is a fix: back to active, failures forgotten, the hash still the one Trail wrote.
  writeFileSync(ref.file, readFileSync(ref.file, "utf8").replace("Other npm packages", "Other npm packages, or forks"));
  readSkill(ref);
  const back = getSkillState(ref.id, b.env)!;
  assert.deepEqual([back.status, back.lastFails, back.fixHash, back.statusWhy, back.hash], ["active", [], undefined, undefined, trailWrote]);
  // Two more failures mark it again, at the file as it is now; reading it again keeps it marked.
  recordUse(ref.id, failedUse(ref.id, "2026-11-06T10:00:00.000Z"), b.env);
  recordUse(ref.id, failedUse(ref.id, "2026-11-07T10:00:00.000Z"), b.env);
  readSkill(ref);
  assert.equal(getSkillState(ref.id, b.env)?.status, "needs-fix");
});

test("D65: two corrected uses mark the file's hash too", () => {
  const b = box();
  const ref = save(b);
  writeFileSync(ref.file, readFileSync(ref.file, "utf8").replace("Other packages", "Other npm packages"));
  for (const [k, day] of [["u-00000a", "02"], ["u-00000b", "04"]] as const) {
    const u = { ...failedUse(ref.id, `2026-11-${day}T10:00:00.000Z`, k), failedStep: null, stepsRan: [1, 2] };
    appendLedger(ref.id, u, b.env);
    recordUse(ref.id, u, b.env);
    recordCorrected(ref.id, k, b.env, new Date(`2026-11-${day}T10:05:00.000Z`));
  }
  assert.equal(getSkillState(ref.id, b.env)?.status, "needs-fix");
  readSkill(ref);
  assert.equal(getSkillState(ref.id, b.env)?.status, "needs-fix");
});

test("nameTaken: every place a skill or its name can live, and free names", () => {
  const b = box();
  const ctx = ctxOf(b);
  assert.equal(nameTaken("release-npm", ctx), null);
  assert.equal(nameTaken("skills", ctx), "built-in");
  assert.equal(nameTaken("ship", ctx), "host", "Claude Code's own /ship");
  assert.equal(nameTaken("steward", ctx), "host");
  save(b);
  assert.equal(nameTaken("release-npm", ctx), "personal");
  mkdirSync(join(b.trail, "skills", ".retired", "deploy-shop-2026-10-20"), { recursive: true });
  assert.equal(nameTaken("deploy-shop", ctx), "retired");
  assert.equal(nameTaken("deploy", ctx), null);
  saveHeld(compiled("ship-it", { trail: "s-00000f" }), "no-yes", { host: "claude", job: "ship", repoKey: SHOP }, b.env, NOW);
  assert.equal(nameTaken("ship-it", ctx), "held");
  writeSkillFile(join(b.checkout, ".agents", "skills", "repo-release"), compiled("repo-release", { scope: "repo", trail: "s-000010" }));
  assert.equal(nameTaken("repo-release", ctx), "repo");
  mkdirSync(join(b.checkout, ".agents", "skills", "docs-site"), { recursive: true });
  assert.equal(nameTaken("docs-site", ctx), "host");
  mkdirSync(join(b.checkout, ".claude", "skills", "bump-deps"), { recursive: true });
  assert.equal(nameTaken("bump-deps", ctx), "host");
  mkdirSync(join(b.home, ".claude", "skills", "pdf-tools"), { recursive: true });
  assert.equal(nameTaken("pdf-tools", ctx), "host");
  mkdirSync(join(b.home, ".agents", "skills", "slides"), { recursive: true });
  assert.equal(nameTaken("slides", ctx), "host");
  const config = join(b.home, "claude-config");
  mkdirSync(join(config, "skills", "triage"), { recursive: true });
  assert.equal(nameTaken("triage", ctxOf(b)), null);
  assert.equal(nameTaken("triage", { ...ctx, env: { ...b.env, CLAUDE_CONFIG_DIR: config } }), "host");
  mkdirSync(join(b.trail, "teams", "acme", "skills", "team-deploy"), { recursive: true });
  assert.equal(nameTaken("team-deploy", ctx), "team");
  // A dangling link still holds the name.
  symlinkSync(join(b.home, "gone"), join(b.checkout, ".claude", "skills", "gone-skill"));
  assert.equal(nameTaken("gone-skill", ctx), "host");
  // Outside any checkout, the checkout places are skipped.
  assert.equal(nameTaken("bump-deps", { ...ctx, checkout: "" }), null);
  for (const bad of ["../skills", "a/b", ".retired", ""]) assert.notEqual(nameTaken(bad, ctx), null, bad);
});

test("jobCovered: a live skill for the job in scope, or a held item for this repo and job not yet shown", () => {
  const b = box();
  const ctx = ctxOf(b);
  assert.equal(jobCovered("release", ctx), false);
  save(b);
  assert.equal(jobCovered("release", ctx), true);
  assert.equal(jobCovered("ship", ctx), false);
  assert.equal(jobCovered("release", ctxOf(b, [STOREFRONT])), false);
  for (const status of ["active", "needs-fix"] as const) {
    updateSkillState("s-7f3a2c", (s) => ({ ...s!, status }), b.env);
    assert.equal(jobCovered("release", ctx), true, status);
  }
  updateSkillState("s-7f3a2c", (s) => ({ ...s!, status: "retired" }), b.env);
  assert.equal(jobCovered("release", ctx), false);
  // A skill the person turned off still covers its job: the offer would make a second one.
  save(b, compiled("ship-shop", { trail: "s-000011", job: "ship" }));
  writeFileSync(join(b.trail, "settings.json"), JSON.stringify({ v: 1, skills: "on", skillsOff: ["ship-shop"] }));
  assert.equal(jobCovered("ship", ctx), true);
  // Held: this repo and job, not yet shown.
  saveHeld(compiled("tests-held", { trail: "s-000012", job: "tests" }), "no-yes", { host: "claude", job: "tests", repoKey: SHOP }, b.env, NOW);
  assert.equal(jobCovered("tests", ctx), true);
  assert.equal(jobCovered("tests", ctxOf(b, [STOREFRONT])), false);
  saveHeld(compiled("report-held", { trail: "s-000013", job: "report" }), "host", { host: "cursor", job: "report", repoKey: SHOP }, b.env, NOW);
  const held = join(b.trail, "held", "report-held", "held.json");
  writeFileSync(held, JSON.stringify({ ...JSON.parse(readFileSync(held, "utf8")), shownAt: NOW.toISOString() }));
  assert.equal(jobCovered("report", ctx), false);
});

test("forget moves the folder to .retired/<name>-<date> and keeps what it was; twice a day gets its own folder", () => {
  const b = box();
  save(b);
  updateSkillState("s-7f3a2c", (s) => ({ ...s!, status: "active" }), b.env);
  const day = localDate(NOW);
  const out = forgetSkill("release-npm", b.env, NOW);
  assert.deepEqual(out, { ok: true, to: join(b.trail, "skills", ".retired", `release-npm-${day}`) });
  assert.equal(existsSync(join(b.trail, "skills", "release-npm")), false);
  assert.ok(existsSync(join(b.trail, "skills", ".retired", `release-npm-${day}`, "SKILL.md")));
  const s = getSkillState("s-7f3a2c", b.env)!;
  assert.equal(s.status, "retired");
  assert.equal(s.prevStatus, "active");
  assert.deepEqual(readLedger("s-7f3a2c", b.env).at(-1), { at: NOW.toISOString(), event: "status", skill: "s-7f3a2c", from: "active", to: "retired", reason: "forget" });
  assert.deepEqual(listSkills(ctxOf(b)), []);
  assert.deepEqual(forgetSkill("release-npm", b.env, NOW), { ok: false, reason: "unknown" });
  save(b, compiled("release-npm", { trail: "s-000020" }));
  assert.equal(forgetSkill("release-npm", b.env, NOW).ok, true);
  assert.ok(existsSync(join(b.trail, "skills", ".retired", `release-npm-${day}-2`)));
  if (POSIX) assert.equal(mode(join(b.trail, "skills", ".retired")), 0o700);
});

test("restore brings the newest retired copy back with what it was; never onto a taken name", () => {
  const b = box();
  save(b);
  updateSkillState("s-7f3a2c", (s) => ({ ...s!, status: "active" }), b.env);
  forgetSkill("release-npm", b.env, new Date("2026-10-20T09:00:00.000Z"));
  save(b, compiled("release-npm", { trail: "s-000021" }));
  forgetSkill("release-npm", b.env, NOW);
  // Taken meanwhile: refused, nothing moved.
  save(b, compiled("release-npm", { trail: "s-000022" }));
  assert.deepEqual(restoreSkill("release-npm", b.env, NOW), { ok: false, reason: "name-taken" });
  forgetSkill("release-npm", b.env, new Date("2026-10-29T09:00:00.000Z"));
  const back = restoreSkill("release-npm", b.env, new Date("2026-10-30T09:00:00.000Z"));
  assert.equal(back.ok, true);
  assert.equal(back.ok && back.ref.id, "s-000022");
  assert.equal(getSkillState("s-000022", b.env)?.status, "candidate");
  forgetSkill("release-npm", b.env, new Date("2026-10-30T10:00:00.000Z"));
  // Restoring again gives the newest copy: the one just forgotten.
  const again = restoreSkill("release-npm", b.env, new Date("2026-10-30T11:00:00.000Z"));
  assert.equal(again.ok && again.ref.id, "s-000022");
  assert.deepEqual(restoreSkill("deploy-shop", b.env), { ok: false, reason: "unknown" });
  assert.deepEqual(restoreSkill("skills", b.env), { ok: false, reason: "unknown" });
});

test("forget then restore: an active skill comes back active, a needs-fix one comes back needs-fix", () => {
  const b = box();
  save(b);
  updateSkillState("s-7f3a2c", (s) => ({ ...s!, status: "active" }), b.env);
  forgetSkill("release-npm", b.env, NOW);
  const r = restoreSkill("release-npm", b.env, NOW);
  assert.equal(r.ok, true);
  const s = getSkillState("s-7f3a2c", b.env)!;
  assert.equal(s.status, "active");
  assert.equal(s.prevStatus, "active");
  assert.deepEqual(readLedger("s-7f3a2c", b.env).at(-1), { at: NOW.toISOString(), event: "status", skill: "s-7f3a2c", from: "retired", to: "active", reason: "restore" });

  save(b, compiled("deploy-shop", { trail: "s-000030", job: "ship" }));
  updateSkillState("s-000030", (x) => ({ ...x!, status: "needs-fix", prevStatus: "active", statusWhy: "step 2 failed on Nov 2 and Nov 4" }), b.env);
  forgetSkill("deploy-shop", b.env, NOW);
  assert.equal(getSkillState("s-000030", b.env)?.status, "retired");
  restoreSkill("deploy-shop", b.env, NOW);
  const d = getSkillState("s-000030", b.env)!;
  assert.equal(d.status, "needs-fix");
  assert.equal(d.prevStatus, "active");
  assert.equal(d.statusWhy, "step 2 failed on Nov 2 and Nov 4");
});

test("new skill ids are 's-' and 6 hex", () => {
  assert.match(newSkillId(), /^s-[0-9a-f]{6}$/);
  assert.notEqual(newSkillId(), newSkillId());
});
