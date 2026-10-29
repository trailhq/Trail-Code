/**
 * The overlap metrics: `overlap_warned` for each warning the agent is given,
 * with whether the branch has an open pull request, and `overlap_acted` when
 * a prompt later in the session names that teammate or branch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlapActed, overlapsShown } from "../src/claude/overlap-telemetry.js";
import { readSession, writeSession } from "../src/claude/state.js";
import { prState, type BranchCache } from "../src/notes/branches.js";
import type { FunctionOverlap } from "../src/notes/edit-overlap.js";
import { queuePath } from "../src/telemetry/queue.js";
import { CI_ENV_VARS } from "../src/telemetry/gate.js";
import { tmpRepo } from "./helpers.js";

// A scratch home with telemetry on, so the queue can be read back.
const HOME = mkdtempSync(join(tmpdir(), "overlap-telemetry-home-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.TRAIL_HOME = join(HOME, ".trail");
process.env.GRAFT_POSTHOG_KEY = "phc_test_key";
for (const k of ["DO_NOT_TRACK", ...CI_ENV_VARS]) delete process.env[k];

function sent(event: string): Record<string, string>[] {
  try {
    return readFileSync(queuePath(HOME), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === event)
      .map((e) => e.properties);
  } catch {
    return [];
  }
}

const cache: BranchCache = { fetchedAt: 0, base: "origin/main", branches: [], open: ["kumar/backoff"] };
const warning = (ref: string, author: string): FunctionOverlap => ({ ref, author, at: 0, file: "src/retry.ts", symbols: [{ id: "src/retry.ts#backoff", label: "backoff()" }], subject: "" });

test("whether a branch has an open pull request, once GitHub has been asked", () => {
  assert.equal(prState(cache, "origin/kumar/backoff"), "open");
  assert.equal(prState(cache, "origin/maya/old-try"), "none");
  assert.equal(prState({ ...cache, open: undefined }, "origin/kumar/backoff"), "unknown");
});

test("each warning is counted with its pull request, and a prompt naming the teammate or branch is acting on it, once", () => {
  const dir = tmpRepo("overlap-telemetry");
  const s = readSession(dir, "s1");
  overlapsShown(s, [warning("origin/kumar/backoff", "Kumar"), warning("origin/maya/old-try", "Maya")], cache);
  writeSession(dir, "s1", s);
  assert.deepEqual(sent("overlap_warned").map((p) => p.pr), ["open", "none"]);
  assert.ok(!JSON.stringify(sent("overlap_warned")).includes("kumar"), "no name travels");

  overlapActed(dir, "s1", "keep going with the retry fix");
  overlapActed(dir, "s1", "is Kumaran around?");
  assert.equal(sent("overlap_acted").length, 0, "a prompt that names neither isn't acting on it");

  overlapActed(dir, "s1", "ok, what is kumar changing there?");
  overlapActed(dir, "s1", "and rebase on maya/old-try");
  overlapActed(dir, "s1", "tell Kumar I'm on it");
  assert.deepEqual(sent("overlap_acted").map((p) => p.pr), ["open", "none"], "once per warning");
});
