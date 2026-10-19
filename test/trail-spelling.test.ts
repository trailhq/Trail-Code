/**
 * Under trail, what the agent reads names commands it can run. A trail-only
 * install has no `graft` binary, so a hint that says `graft ask` costs a failed
 * tool call. Under graft the same text is unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND_ENV } from "../src/brand.js";
import { weakMatchNudge } from "../src/claude/format.js";
import { hasSavingsTally } from "../src/claude/tally.js";
import type { SessionState } from "../src/claude/state.js";
import { savingsTurnNudge } from "../src/context/savings.js";
import { zeroHitNote } from "../src/search/grep-cli.js";
import type { GrepResult } from "../src/search/grep.js";

/** A graft command a trail-only machine can't run. */
const GRAFT_COMMAND = /\bgraft (ask|build|grep|callers|skeleton|map|blast|telemetry)\b|\[graft\]|graft saved/;

function under<T>(name: "trail" | "graft", fn: () => T): T {
  const saved = process.env[BRAND_ENV];
  process.env[BRAND_ENV] = name;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[BRAND_ENV];
    else process.env[BRAND_ENV] = saved;
  }
}

const grepMiss = { pattern: "x", filesSearched: 3, truncated: { files: 1 } } as unknown as GrepResult;

test("hints the agent reads name trail's commands under trail", () => {
  const lines = under("trail", () => [
    weakMatchNudge({ nudges: 0 } as SessionState, 0.1)!,
    savingsTurnNudge(1200),
    zeroHitNote(grepMiss),
  ]);
  for (const line of lines) {
    assert.doesNotMatch(line, GRAFT_COMMAND, line);
    assert.match(line, /trail/, line);
  }
});

test("under graft the same hints keep graft's words", () => {
  assert.match(under("graft", () => weakMatchNudge({ nudges: 0 } as SessionState, 0.1)!), /^\[graft\] .*`graft ask "<your task>" --source`/);
  assert.match(under("graft", () => savingsTurnNudge(1200)), /🌱 graft saved/);
});

test("a trail tally counts as telling the user what was saved", () => {
  assert.equal(hasSavingsTally("🌱 trail saved ~12k tokens (~$0.04) this turn, 3 calls"), true);
  assert.equal(hasSavingsTally("🌱 graft saved ~12k tokens this turn"), true);
  assert.equal(hasSavingsTally("trail is a good name"), false);
});
