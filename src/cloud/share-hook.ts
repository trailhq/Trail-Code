/**
 * The one hook `trail share-session`'s keep-sending needs in every folder: a
 * SessionStart entry in the user's `~/.claude/settings.json`, so a session in
 * a repo trail never set up still starts the background send, in the
 * terminal and in Claude Desktop's Code tab alike.
 *
 * It calls trail's user-level shim (`~/.claude/helpers/graft-hooks.cjs`, the
 * one `trail init` installs, which finds the installed package without
 * relying on PATH) with the `share-sync` event, which does only that one
 * thing. Added on the person's yes, taken out by `--stop` and `--delete`, and
 * put back by `trail share-session` if something took it out.
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { hooksShim } from "../claude/shim-template.js";
import { failOpen } from "../claude/settings-merge.js";
import { readJsonObject, writeOwned } from "../hosts/config-write.js";
import { globalHelpersDir } from "../hosts/claude-global.js";
import { toPosixPath } from "../util/paths.js";

/** What marks the entry as this one: the shim, then the event. */
const MARK = '-hooks.cjs" share-sync';

export function settingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

/** `node "<home>/.claude/helpers/graft-hooks.cjs" share-sync || exit 0`, the way trail's other user-level hooks read. */
export function shareSyncCommand(home: string): string {
  return failOpen(`node "${toPosixPath(globalHelpersDir(home))}/graft-hooks.cjs" share-sync`);
}

type Group = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

function ours(g: Group): boolean {
  return (g.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK));
}

/** Whether the entry is in `~/.claude/settings.json`. */
export function hasShareSyncHook(home: string): boolean {
  const loaded = readJsonObject(settingsPath(home));
  if (loaded === "unparseable") return false;
  const groups = loaded.root.hooks?.SessionStart;
  return Array.isArray(groups) && groups.some((g: Group) => ours(g));
}

export type HookResult = "added" | "already" | "removed" | "absent" | "unparseable" | "failed";

/** Add the entry, and the shim it calls when that isn't there yet. Leaves every other setting as it was. */
export function installShareSyncHook(home: string): HookResult {
  const path = settingsPath(home);
  const loaded = readJsonObject(path);
  if (loaded === "unparseable") return "unparseable";
  try {
    if (writeOwned("claude-global-shim", join(globalHelpersDir(home), "graft-hooks.cjs"), hooksShim(), 0o755).action === "skipped-unparseable") return "failed";
    const root = loaded.root;
    const hooks = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? root.hooks : (root.hooks = {});
    const groups: Group[] = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : (hooks.SessionStart = []);
    if (groups.some(ours)) return "already";
    groups.push({ hooks: [{ type: "command", command: shareSyncCommand(home) }] });
    writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
    return "added";
  } catch {
    return "failed";
  }
}

/** Take the entry out, and nothing else. */
export function removeShareSyncHook(home: string): HookResult {
  const path = settingsPath(home);
  const loaded = readJsonObject(path);
  if (loaded === "unparseable") return "unparseable";
  const hooks = loaded.root.hooks;
  const groups = hooks?.SessionStart;
  if (!Array.isArray(groups) || !groups.some(ours)) return "absent";
  try {
    const kept = groups.filter((g: Group) => !ours(g));
    if (kept.length) hooks.SessionStart = kept;
    else delete hooks.SessionStart;
    if (!Object.keys(hooks).length) delete loaded.root.hooks;
    writeFileSync(path, `${JSON.stringify(loaded.root, null, 2)}\n`);
    return "removed";
  } catch {
    return "failed";
  }
}
