/**
 * `~/.trail/state/skills.json` (design 2.2): what changes per person about
 * each skill. Uses and checked uses, candidate to active on the first checked
 * use, needs-fix after two uses in a row that failed at the same step or were
 * corrected (spec 13), back to what it was after a hand edit; ledger status
 * lines for every change.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import {
  getSkillState, handEdited, lastUsedIn, readSkillsState, recordCorrected, recordUse, skillsStatePath, updateSkillState,
} from "../src/skills/state.js";
import { appendLedger, readLedger } from "../src/skills/ledger.js";
import { localDate } from "../src/skills/settings.js";
import type { LedgerUse, SkillState } from "../src/skills/types.js";
import { withLock } from "../src/util/private-fs.js";

const POSIX = process.platform !== "win32";
const ID = "s-4c91e0";

function sandbox(): { env: NodeJS.ProcessEnv; trail: string } {
  const home = tmpRepo("skstate");
  const trail = join(home, "trail-home");
  return { env: { HOME: home, TRAIL_HOME: trail }, trail };
}

function entry(extra: Partial<SkillState> = {}): SkillState {
  return {
    name: "ship-beta-then-prod", scope: "personal", status: "candidate", from: "repeated", runId: "r-1027-3f9a",
    addedAt: "2026-10-27T11:02:13.000Z", lastWorked: "2026-10-27", lastUsedAt: null, lastUsedRepo: null, uses: 0, checkedUses: 0,
    hash: "sha256:aaaa", source: { commands: 17, failed: 3, at: "2026-10-27T10:44:05.000Z" }, lastFails: [], promoteOffers: {}, ...extra,
  };
}

function seed(env: NodeJS.ProcessEnv, s: SkillState = entry(), id = ID): void {
  updateSkillState(id, () => s, env);
}

function use(extra: Partial<LedgerUse> = {}): LedgerUse {
  return {
    at: "2026-10-29T09:41:02.000Z", event: "use", useId: "u-1a2b3c", skill: ID, v: "1", host: "claude", cue: "job",
    repo: "github.com/acme/storefront", stepsRan: [1, 2, 3, 4, 5], failedStep: null, readyFailed: [], check: "passed", calls: 6, failed: 0, ...extra,
  };
}

const statusLines = (env: NodeJS.ProcessEnv, id = ID) => readLedger(id, env).filter((l) => l.event === "status");

test("the state file: its path, defaults when missing or broken, entries read back", () => {
  const { env, trail } = sandbox();
  assert.equal(skillsStatePath(env), join(trail, "state", "skills.json"));
  assert.deepEqual(readSkillsState(env), { v: 1, skills: {} });
  mkdirSync(join(trail, "state"), { recursive: true });
  for (const bad of ["{nope", "[]", "null", '{"v":1,"skills":[]}', '{"v":1,"skills":3}']) {
    writeFileSync(skillsStatePath(env), bad);
    assert.deepEqual(readSkillsState(env), { v: 1, skills: {} }, bad);
  }
  writeFileSync(skillsStatePath(env), JSON.stringify({ v: 1, skills: { [ID]: entry(), "s-bad001": "x", "s-bad002": { name: 3 } } }));
  assert.deepEqual(Object.keys(readSkillsState(env).skills), [ID]);
  assert.deepEqual(getSkillState(ID, env), entry());
  assert.equal(getSkillState("s-ffffff", env), null);
});

test("an entry missing newer fields reads with their defaults", () => {
  const { env, trail } = sandbox();
  mkdirSync(join(trail, "state"), { recursive: true });
  const old = { name: "x-skill", scope: "personal", status: "active", from: "asked", addedAt: "2026-10-01T00:00:00.000Z", hash: "sha256:1" };
  writeFileSync(skillsStatePath(env), JSON.stringify({ v: 1, skills: { [ID]: old } }));
  const s = getSkillState(ID, env)!;
  assert.equal(s.uses, 0);
  assert.equal(s.checkedUses, 0);
  assert.deepEqual(s.lastFails, []);
  assert.deepEqual(s.promoteOffers, {});
  assert.equal(s.runId, null);
  assert.equal(s.lastWorked, null);
});

test("updateSkillState: create, change, delete; keys a later version adds are kept; 0600 in 0700", () => {
  const { env, trail } = sandbox();
  mkdirSync(join(trail, "state"), { recursive: true });
  writeFileSync(skillsStatePath(env), JSON.stringify({ v: 1, later: { x: 1 }, skills: { [ID]: { ...entry(), laterField: "kept" } } }));
  const next = updateSkillState(ID, (s) => ({ ...s!, uses: 4 }), env);
  assert.equal(next?.uses, 4);
  const raw = JSON.parse(readFileSync(skillsStatePath(env), "utf8"));
  assert.deepEqual(raw.later, { x: 1 });
  assert.equal(raw.skills[ID].laterField, "kept");
  assert.equal(raw.skills[ID].uses, 4);
  if (POSIX) {
    assert.equal(statSync(skillsStatePath(env)).mode & 0o777, 0o600);
    assert.equal(statSync(join(trail, "state")).mode & 0o777, 0o700);
  }
  assert.equal(updateSkillState(ID, () => undefined, env), undefined);
  assert.equal(getSkillState(ID, env), null);
  // Deleting what isn't there writes nothing new.
  assert.equal(updateSkillState("s-000000", () => undefined, env), undefined);
});

test("updateSkillState gives up on a held lock and does not run fn", () => {
  const { env } = sandbox();
  seed(env);
  let ran = false;
  const outer = withLock(skillsStatePath(env), () => updateSkillState(ID, (s) => { ran = true; return { ...s!, uses: 9 }; }, env));
  assert.equal(outer.ok, true);
  assert.equal(outer.ok && outer.value, undefined);
  assert.equal(ran, false);
  assert.equal(getSkillState(ID, env)?.uses, 0);
});

/**
 * Windows answers an open of a file another process is deleting with EPERM (or EBUSY). `refuse` makes the
 * first `times` opens of `lock` throw `code`, the way a lock being let go does; every other open is real.
 */
function refuseLockOpen(lock: string, code: string, times = Infinity): () => number {
  let refused = 0;
  const real = fs.openSync;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === lock && refused < times) {
      refused += 1;
      throw Object.assign(new Error(`${code}: operation not permitted, open '${lock}'`), { code, syscall: "open", path: lock });
    }
    return real(...args);
  });
  syncBuiltinESMExports();
  return () => refused;
}
function restoreFs(): void {
  mock.restoreAll();
  syncBuiltinESMExports();
}

for (const code of ["EPERM", "EBUSY"]) {
  test(`a lock being let go (${code} on open, as on Windows) is waited for, not thrown: the use is counted once`, () => {
    const { env } = sandbox();
    seed(env);
    const lock = `${skillsStatePath(env)}.lock`;
    const refused = refuseLockOpen(lock, code, 3);
    let done;
    try {
      done = updateSkillState(ID, (s) => ({ ...s!, uses: s!.uses + 1 }), env);
    } finally {
      restoreFs();
    }
    assert.equal(refused(), 3);
    assert.equal(done?.uses, 1);
    assert.equal(getSkillState(ID, env)?.uses, 1);
    assert.equal(existsSync(lock), false, "the lock is let go");
  });
}

test("a lock held, then refused with EPERM while its holder deletes it, gives up as busy by the deadline: fn never runs", () => {
  const { env } = sandbox();
  seed(env);
  const lock = `${skillsStatePath(env)}.lock`;
  writeFileSync(lock, "4242 held"); // fresh, so not taken over
  // Every other open is refused: the holder is forever mid-delete, and in between the lock is there.
  let n = 0;
  const real = fs.openSync;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === lock && n++ % 2 === 1) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    return real(...args);
  });
  syncBuiltinESMExports();
  let ran = false;
  let r;
  try {
    r = withLock(skillsStatePath(env), () => { ran = true; }, 60);
  } finally {
    restoreFs();
  }
  assert.deepEqual(r, { ok: false });
  assert.equal(ran, false);
  assert.ok(n > 2, `tried ${n} times`);
});

test("EPERM on every open with nothing ever holding the lock is a folder that refuses us: the error is thrown", () => {
  const { env } = sandbox();
  seed(env);
  const lock = `${skillsStatePath(env)}.lock`;
  const refused = refuseLockOpen(lock, "EPERM");
  let ran = false;
  try {
    assert.throws(() => withLock(skillsStatePath(env), () => { ran = true; }, 30), { code: "EPERM" });
  } finally {
    restoreFs();
  }
  assert.equal(ran, false);
  assert.ok(refused() > 1, "retried before giving up");
});

test("recordUse: a passed check makes a candidate active, once, with the use counted and a status line", () => {
  const { env } = sandbox();
  seed(env);
  const s = recordUse(ID, use(), env)!;
  assert.equal(s.status, "active");
  assert.equal(s.uses, 1);
  assert.equal(s.checkedUses, 1);
  assert.equal(s.lastUsedAt, "2026-10-29T09:41:02.000Z");
  assert.equal(s.lastUsedRepo, "github.com/acme/storefront");
  assert.equal(s.lastWorked, localDate("2026-10-29T09:41:02.000Z"));
  assert.deepEqual(s.lastFails, []);
  assert.deepEqual(statusLines(env), [{ at: "2026-10-29T09:41:02.000Z", event: "status", skill: ID, from: "candidate", to: "active", reason: "checked-use" }]);
  const again = recordUse(ID, use({ at: "2026-10-30T09:00:00.000Z" }), env)!;
  assert.equal(again.status, "active");
  assert.equal(again.uses, 2);
  assert.equal(again.checkedUses, 2);
  assert.equal(statusLines(env).length, 1);
});

test("recordUse: a use with no passed check counts as a use, not a checked one, and leaves a candidate a candidate", () => {
  const { env } = sandbox();
  seed(env);
  for (const check of ["failed", "none"] as const) recordUse(ID, use({ check }), env);
  const s = getSkillState(ID, env)!;
  assert.equal(s.status, "candidate");
  assert.equal(s.uses, 2);
  assert.equal(s.checkedUses, 0);
  assert.equal(s.lastWorked, "2026-10-27");
  assert.deepEqual(statusLines(env), []);
});

test("recordUse: two uses in a row failing at the same step mark it needs-fix, with why and what it was", () => {
  const { env } = sandbox();
  seed(env, entry({ status: "active" }));
  recordUse(ID, use({ at: "2026-11-02T10:00:00.000Z", failedStep: 4, check: "none", stepsRan: [1, 2, 3] }), env);
  assert.equal(getSkillState(ID, env)!.status, "active");
  const s = recordUse(ID, use({ at: "2026-11-04T16:02:11.000Z", failedStep: 4, check: "none", stepsRan: [1, 2, 3] }), env)!;
  assert.equal(s.status, "needs-fix");
  assert.equal(s.prevStatus, "active");
  assert.deepEqual(s.lastFails, [{ step: 4, at: "2026-11-02T10:00:00.000Z" }, { step: 4, at: "2026-11-04T16:02:11.000Z" }]);
  assert.equal(s.statusWhy, "step 4 failed on Nov 2 and Nov 4");
  assert.deepEqual(statusLines(env), [{ at: "2026-11-04T16:02:11.000Z", event: "status", skill: ID, from: "active", to: "needs-fix", reason: "failed-twice" }]);
  // Already needs-fix: a third failure changes nothing more.
  recordUse(ID, use({ at: "2026-11-05T10:00:00.000Z", failedStep: 4, check: "none" }), env);
  assert.equal(statusLines(env).length, 1);
  assert.equal(getSkillState(ID, env)!.prevStatus, "active");
});

test("recordUse: different steps, or a clean use between, never make needs-fix", () => {
  const { env } = sandbox();
  seed(env, entry({ status: "active" }));
  recordUse(ID, use({ at: "2026-11-02T10:00:00.000Z", failedStep: 4, check: "none" }), env);
  recordUse(ID, use({ at: "2026-11-03T10:00:00.000Z", failedStep: 2, check: "none" }), env);
  assert.equal(getSkillState(ID, env)!.status, "active");
  assert.deepEqual(getSkillState(ID, env)!.lastFails.map((f) => f.step), [4, 2]);
  recordUse(ID, use({ at: "2026-11-04T10:00:00.000Z" }), env);
  assert.deepEqual(getSkillState(ID, env)!.lastFails, []);
  recordUse(ID, use({ at: "2026-11-05T10:00:00.000Z", failedStep: 2, check: "none" }), env);
  assert.equal(getSkillState(ID, env)!.status, "active");
});

test("recordUse: a failed ready probe never counts against the skill", () => {
  const { env } = sandbox();
  seed(env, entry({ status: "active" }));
  for (const at of ["2026-11-02T10:00:00.000Z", "2026-11-03T10:00:00.000Z"]) {
    recordUse(ID, use({ at, readyFailed: ["git status --porcelain"], check: "none", stepsRan: [] }), env);
  }
  const s = getSkillState(ID, env)!;
  assert.equal(s.status, "active");
  assert.deepEqual(s.lastFails, []);
});

test("recordUse: a candidate can go needs-fix too, and a retired skill only counts the use", () => {
  const { env } = sandbox();
  seed(env);
  recordUse(ID, use({ at: "2026-11-02T10:00:00.000Z", failedStep: 1, check: "none" }), env);
  const s = recordUse(ID, use({ at: "2026-11-03T10:00:00.000Z", failedStep: 1, check: "none" }), env)!;
  assert.equal(s.status, "needs-fix");
  assert.equal(s.prevStatus, "candidate");
  const other = "s-000002";
  seed(env, entry({ status: "retired", prevStatus: "active" }), other);
  const r = recordUse(other, use({ skill: other }), env)!;
  assert.equal(r.status, "retired");
  assert.equal(r.uses, 1);
  assert.deepEqual(statusLines(env, other), []);
});

test("recordUse on a skill with no state does nothing", () => {
  const { env } = sandbox();
  assert.equal(recordUse("s-0a0a0a", use({ skill: "s-0a0a0a" }), env), undefined);
  assert.deepEqual(readSkillsState(env), { v: 1, skills: {} });
});

test("recordCorrected: one line per use; two corrected uses in a row mark it needs-fix", () => {
  const { env } = sandbox();
  seed(env, entry({ status: "active" }));
  recordUse(ID, use({ useId: "u-000001", at: "2026-11-02T10:00:00.000Z" }), env);
  // The use lines are the caller's to write (settleCredit); write them as it does.
  appendLedger(ID, use({ useId: "u-000001", at: "2026-11-02T10:00:00.000Z" }), env);
  recordCorrected(ID, "u-000001", env, new Date("2026-11-02T10:03:00.000Z"));
  recordCorrected(ID, "u-000001", env, new Date("2026-11-02T10:04:00.000Z"));
  assert.equal(readLedger(ID, env).filter((l) => l.event === "corrected").length, 1);
  assert.equal(getSkillState(ID, env)!.status, "active");

  appendLedger(ID, use({ useId: "u-000002", at: "2026-11-04T09:00:00.000Z" }), env);
  recordUse(ID, use({ useId: "u-000002", at: "2026-11-04T09:00:00.000Z" }), env);
  const s = recordCorrected(ID, "u-000002", env, new Date("2026-11-04T09:05:00.000Z"))!;
  assert.equal(s.status, "needs-fix");
  assert.equal(s.prevStatus, "active");
  assert.equal(s.statusWhy, "corrected after its use on Nov 2 and Nov 4");
  assert.deepEqual(statusLines(env).at(-1), { at: "2026-11-04T09:05:00.000Z", event: "status", skill: ID, from: "active", to: "needs-fix", reason: "failed-twice" });
});

test("recordCorrected: a clean use between two corrected ones is not two in a row", () => {
  const { env } = sandbox();
  seed(env, entry({ status: "active" }));
  for (const [i, day] of ["02", "03", "04"].entries()) appendLedger(ID, use({ useId: `u-00000${i}`, at: `2026-11-${day}T10:00:00.000Z` }), env);
  recordCorrected(ID, "u-000000", env, new Date("2026-11-02T10:01:00.000Z"));
  recordCorrected(ID, "u-000002", env, new Date("2026-11-04T10:01:00.000Z"));
  assert.equal(getSkillState(ID, env)!.status, "active");
  assert.equal(recordCorrected(ID, "u-ffffff", env), undefined);
});

test("handEdited: a needs-fix skill whose SKILL.md changed by hand goes back to what it was", () => {
  const { env } = sandbox();
  seed(env, entry({ status: "needs-fix", prevStatus: "active", statusWhy: "step 4 failed on Nov 2 and Nov 4", lastFails: [{ step: 4, at: "a" }, { step: 4, at: "b" }] }));
  assert.equal(handEdited(ID, "sha256:aaaa", env)!.status, "needs-fix");
  const s = handEdited(ID, "sha256:bbbb", env, new Date("2026-11-06T08:00:00.000Z"))!;
  assert.equal(s.status, "active");
  assert.equal(s.hash, "sha256:aaaa", "the hash stays the one Trail wrote");
  assert.deepEqual(s.lastFails, []);
  assert.equal(s.statusWhy, undefined);
  assert.equal(s.prevStatus, undefined);
  assert.deepEqual(statusLines(env), [{ at: "2026-11-06T08:00:00.000Z", event: "status", skill: ID, from: "needs-fix", to: "active", reason: "restore" }]);
  // Not needs-fix: a hand edit is left for phase 2 (the hash stays Trail's).
  const other = "s-000003";
  seed(env, entry({ status: "active" }), other);
  assert.equal(handEdited(other, "sha256:cccc", env)!.hash, "sha256:aaaa");
  // needs-fix with no prevStatus goes back to candidate.
  const third = "s-000004";
  seed(env, entry({ status: "needs-fix" }), third);
  assert.equal(handEdited(third, "sha256:dddd", env)!.status, "candidate");
});

test("lastUsedIn: the skill used most recently in these repos, never a retired one", () => {
  const { env } = sandbox();
  seed(env, entry({ lastUsedAt: "2026-10-29T09:41:02.000Z", lastUsedRepo: "github.com/acme/storefront" }), "s-00000a");
  seed(env, entry({ lastUsedAt: "2026-10-30T09:41:02.000Z", lastUsedRepo: "github.com/acme/storefront" }), "s-00000b");
  seed(env, entry({ lastUsedAt: "2026-10-31T09:41:02.000Z", lastUsedRepo: "github.com/acme/shop" }), "s-00000c");
  seed(env, entry({ status: "retired", lastUsedAt: "2026-11-01T09:41:02.000Z", lastUsedRepo: "github.com/acme/storefront" }), "s-00000d");
  assert.deepEqual(lastUsedIn(["github.com/acme/storefront"], env), { id: "s-00000b", at: "2026-10-30T09:41:02.000Z" });
  assert.deepEqual(lastUsedIn(["github.com/acme/storefront", "github.com/acme/shop"], env), { id: "s-00000c", at: "2026-10-31T09:41:02.000Z" });
  assert.equal(lastUsedIn(["github.com/acme/other"], env), null);
  assert.equal(lastUsedIn([], env), null);
});
