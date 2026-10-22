/**
 * `init` registers the hooks in the repo and in ~/.claude, and Claude Code runs
 * both. One copy answers each event, or every prompt gets its learnings twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalCopyCovers } from "../src/claude/hook-layers.js";
import { hooksShim } from "../src/claude/shim-template.js";

/** A home with ~/.claude hooks for `events`, calling a shim with `shim` as its bytes. */
function homeWith(events: string[], shim = hooksShim()): { home: string; globalShim: string } {
  const home = mkdtempSync(join(tmpdir(), "hook-layers-"));
  const helpers = join(home, ".claude", "helpers");
  mkdirSync(helpers, { recursive: true });
  const globalShim = join(helpers, "graft-hooks.cjs");
  writeFileSync(globalShim, shim);
  const hooks = Object.fromEntries(
    events.map((e) => [e, [{ hooks: [{ type: "command", command: `node "${globalShim.replace(/\\/g, "/")}" ${e}` }] }]]),
  );
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks }));
  return { home, globalShim };
}

const repoShim = join(tmpdir(), "some-repo", ".claude", "helpers", "trail-hooks.cjs");

test("the repo's copy stands down for an event the ~/.claude copy answers", () => {
  const { home } = homeWith(["session-start", "prompt"]);
  assert.equal(globalCopyCovers("session-start", repoShim, home), true);
  assert.equal(globalCopyCovers("prompt", repoShim, home), true);
  assert.equal(globalCopyCovers("stop", repoShim, home), false, "an event only the repo registers still runs there");
});

test("the ~/.claude copy itself always runs", () => {
  const { home, globalShim } = homeWith(["session-start"]);
  assert.equal(globalCopyCovers("session-start", globalShim, home), false);
});

test("a ~/.claude shim an older graft wrote doesn't count: it can't find trail", () => {
  const { home } = homeWith(["session-start"], "const pkg = require.resolve('@nanonets/graft/package.json');");
  assert.equal(globalCopyCovers("session-start", repoShim, home), false);
});

test("Cursor's and Codex's shims never stand down for Claude's hooks", () => {
  const { home } = homeWith(["session-start"]);
  assert.equal(globalCopyCovers("session-start", join(tmpdir(), "some-repo", ".cursor", "hooks", "graft-hooks.cjs"), home), false);
  assert.equal(globalCopyCovers("session-start", join(home, ".codex", "graft-hooks.cjs"), home), false);
});

test("no ~/.claude settings, or none of ours: the repo's copy runs", () => {
  const home = mkdtempSync(join(tmpdir(), "hook-layers-empty-"));
  assert.equal(globalCopyCovers("session-start", repoShim, home), false);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "echo hi" }] }] } }));
  assert.equal(globalCopyCovers("session-start", repoShim, home), false);
  assert.equal(globalCopyCovers("session-start", undefined, home), false);
});
