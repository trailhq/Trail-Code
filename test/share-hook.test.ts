/**
 * Keep-sending needs one SessionStart entry in the user's
 * ~/.claude/settings.json, so it runs in every folder. It's added on the
 * person's yes and taken out on stop; everything else in the file stays
 * exactly as it was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasShareSyncHook, installShareSyncHook, removeShareSyncHook, settingsPath, shareSyncCommand } from "../src/cloud/share-hook.js";

function home(settings?: object | string): string {
  const h = mkdtempSync(join(tmpdir(), "hook-home-"));
  if (settings !== undefined) {
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(settingsPath(h), typeof settings === "string" ? settings : JSON.stringify(settings, null, 2));
  }
  return h;
}

const read = (h: string) => JSON.parse(readFileSync(settingsPath(h), "utf8"));

test("installShareSyncHook: one SessionStart entry calling trail's user-level shim with share-sync, and the shim itself", () => {
  const h = home();
  assert.equal(installShareSyncHook(h), "added");
  const s = read(h);
  assert.deepEqual(s.hooks.SessionStart, [{ hooks: [{ type: "command", command: shareSyncCommand(h) }] }]);
  assert.match(shareSyncCommand(h), /^node ".*\/\.claude\/helpers\/graft-hooks\.cjs" share-sync \|\| exit 0$/);
  assert.ok(existsSync(join(h, ".claude", "helpers", "graft-hooks.cjs")), "the shim it calls is there");
  assert.ok(hasShareSyncHook(h));
  assert.equal(installShareSyncHook(h), "already");
  assert.equal(read(h).hooks.SessionStart.length, 1, "never twice");
});

test("installShareSyncHook and removeShareSyncHook leave every other setting and hook as they were", () => {
  const before = {
    model: "opus",
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: 'node "/x/.claude/helpers/graft-hooks.cjs" session-start || exit 0' }] }],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
  };
  const h = home(before);
  assert.equal(installShareSyncHook(h), "added");
  const added = read(h);
  assert.equal(added.model, "opus");
  assert.deepEqual(added.permissions, before.permissions);
  assert.deepEqual(added.hooks.Stop, before.hooks.Stop);
  assert.equal(added.hooks.SessionStart.length, 2, "trail's own session-start entry stays");
  assert.equal(removeShareSyncHook(h), "removed");
  assert.deepEqual(read(h), before);
  assert.equal(removeShareSyncHook(h), "absent");
});

test("removeShareSyncHook: when it was the only hook, the hooks key goes too", () => {
  const h = home({ model: "opus" });
  installShareSyncHook(h);
  removeShareSyncHook(h);
  assert.deepEqual(read(h), { model: "opus" });
});

test("a settings file that isn't valid JSON is left exactly as it is", () => {
  const h = home("{ not json");
  assert.equal(installShareSyncHook(h), "unparseable");
  assert.equal(removeShareSyncHook(h), "unparseable");
  assert.equal(readFileSync(settingsPath(h), "utf8"), "{ not json");
  assert.equal(hasShareSyncHook(h), false);
});
