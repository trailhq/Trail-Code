/**
 * A repo trail 0.23.0 set up, in #619's layout (one shared session-start entry
 * in `.claude/settings.json`, every other hook in `~/.claude`), gets this
 * build's hooks after one `trail init` or one session start that refreshes the
 * wiring: PreToolUse and PostToolUseFailure on Bash join the others, every
 * entry fails open with its timeout in seconds, and each event is wired once.
 * Made-up repo and home folders only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { runInit } from "../src/claude/init.js";
import { hooksShim } from "../src/claude/shim-template.js";
import { globalCopyCovers } from "../src/claude/hook-layers.js";
import { runUpkeep } from "../src/upkeep-run.js";
import { stampPath } from "../src/upkeep.js";
import { BRAND_ENV } from "../src/brand.js";

const OURS = /(graft|trail)-hooks\.cjs|\/\.trail\/hook\.cjs/;
/** Our entries per event, as `<matcher>:<arg>`, from one settings file's hooks. */
function ours(hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>> = {}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [event, groups] of Object.entries(hooks))
    for (const g of groups) for (const h of g.hooks) if (OURS.test(h.command)) (out[event] ??= []).push(`${g.matcher ?? ""}:${/" (\S+)/.exec(h.command)?.[1]}`);
  return out;
}
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** What trail 0.23.0's `trail init` left: its shared entry, its ~/.claude hooks and shim, the stamp. */
function v023(tag: string): { repo: string; home: string } {
  const repo = tmpRepo(`upgrade-${tag}`);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const home = tmpRepo(`upgrade-${tag}-home`);
  const helpers = join(home, ".claude", "helpers");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  mkdirSync(join(repo, ".trail", "learnings"), { recursive: true });
  mkdirSync(helpers, { recursive: true });
  writeFileSync(join(repo, ".trail", "hook.cjs"), "// 0.23.0's shim, which looks for @trailhq/trail-code\n");
  writeFileSync(join(helpers, "graft-hooks.cjs"), "// 0.23.0's shim, which looks for @trailhq/trail-code\n");
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR:-.}/.trail/hook.cjs" session-start', timeout: 8000 }] }] } }));
  const cmd = (arg: string) => `node "${helpers}/graft-hooks.cjs" ${arg}`;
  const block = (arg: string, timeout: number, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd(arg), timeout }] });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      PostToolUse: [block("post-edit", 10000, "Write|Edit|MultiEdit"), block("tool-savings", 8000, "Bash|mcp__graft__|mcp__trail__|Read|Grep|Glob")],
      UserPromptSubmit: [block("prompt", 15000)],
      SessionStart: [block("session-start", 8000)],
      Stop: [block("stop", 8000)],
      SessionEnd: [block("session-end", 5000)],
    },
  }));
  mkdirSync(join(stampPath(repo), ".."), { recursive: true });
  writeFileSync(stampPath(repo), JSON.stringify({ version: "0.23.0", hosts: ["claude"], opts: { global: true, mcp: true, hooks: true, statusline: true }, at: "2026-10-15T00:00:00.000Z" }));
  return { repo, home };
}

/** This build's wiring, each event once: the shared file runs session start, ~/.claude everything. */
function assertWired(repo: string, home: string): void {
  const shared = read(join(repo, ".claude", "settings.json")).hooks;
  assert.deepEqual(ours(shared), { SessionStart: [":session-start"] }, "one shared entry");
  assert.deepEqual(shared.SessionStart.at(-1).hooks[0], { type: "command", command: 'node "${CLAUDE_PROJECT_DIR:-.}/.trail/hook.cjs" session-start || exit 0', timeout: 10 });
  const user = read(join(home, ".claude", "settings.json")).hooks;
  assert.deepEqual(ours(user), {
    PostToolUse: ["Write|Edit|MultiEdit:post-edit", "^(Bash|Read|Grep|Glob|Skill)$|^mcp__.+__(graft|trail)_:tool-savings"],
    UserPromptSubmit: [":prompt"],
    PreToolUse: ["Write|Edit|MultiEdit:pre-edit", "Bash:pre-bash"],
    PostToolUseFailure: ["Bash:post-bash-fail"],
    SessionStart: [":session-start"],
    Stop: [":stop"],
    SessionEnd: [":session-end"],
  });
  for (const groups of Object.values(user) as Array<Array<{ hooks: Array<{ command: string; timeout: number }> }>>)
    for (const g of groups) for (const h of g.hooks) {
      assert.match(h.command, / \|\| exit 0$/, h.command);
      assert.ok(h.timeout <= 15, `${h.command}: ${h.timeout} s`);
    }
  assert.equal(readFileSync(join(home, ".claude", "helpers", "graft-hooks.cjs"), "utf8"), hooksShim(), "the ~/.claude shim, with the PreToolUse fast path");
  assert.equal(readFileSync(join(repo, ".trail", "hook.cjs"), "utf8"), hooksShim(), "the shared shim");
  assert.equal(read(join(repo, ".claude", "settings.local.json")).hooks, undefined, "~/.claude carries them: none in the personal file");
  // Claude Code runs both session-start entries: the repo's stands down, so the session starts once.
  assert.equal(globalCopyCovers("session-start", join(repo, ".trail", "hook.cjs"), home, {}), true);
}

test("one trail init over a repo 0.23.0 set up wires every hook the skills need, each once", () => {
  const { repo, home } = v023("init");
  runInit(repo, { build: false, home, brand: "trail" });
  assertWired(repo, home);
  runInit(repo, { build: false, home, brand: "trail" });
  assertWired(repo, home);
});

test("one session start on a newer version refreshes a repo 0.23.0 set up the same way", () => {
  const { repo, home } = v023("start");
  const saved = { home: process.env.HOME, trail: process.env.TRAIL_HOME, profile: process.env.USERPROFILE, brand: process.env[BRAND_ENV] };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TRAIL_HOME = join(home, ".trail");
  process.env[BRAND_ENV] = "trail";
  try {
    const r = runUpkeep(repo, "99.0.0", { background: false, home });
    assert.match(r.lines.join("\n"), /refreshed this repo's agent wiring \(written by 0\.23\.0, now 99\.0\.0\): claude/);
    assertWired(repo, home);
  } finally {
    for (const [k, v] of [["HOME", saved.home], ["TRAIL_HOME", saved.trail], ["USERPROFILE", saved.profile], [BRAND_ENV, saved.brand]] as const)
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
