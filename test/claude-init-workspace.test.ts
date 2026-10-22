/**
 * Workspace `init` fan-out + the subdirectory root walk, end to end.
 *
 * The gap both close: with two sibling repos under one parent, `graft init
 * <parent>` wired only the parent. But an agent session opens at a REPO root and
 * reads `.claude/` from its own cwd, so every child was left with no skill, no
 * hooks and no MCP — graft was invisible exactly where the work happens. And a
 * session opened one level deeper (`<child>/src`) found no `graft/` at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli, tmpRepo, homeEnv } from "./helpers.js";

const CLI = resolve(process.cwd(), "src/cli.ts");
// Absolute: these runs have a scratch dir as their cwd, so a bare `--import tsx`
// would resolve against the temp dir and find no such package. As a file:// URL
// because `--import` goes through the ESM loader, and a bare Windows absolute
// path parses as the URL scheme `d:` (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const TSX = pathToFileURL(createRequire(join(process.cwd(), "x.js")).resolve("tsx")).href;

/** A parent holding two git-repo children — the shape `isWorkspaceBuildRoot` detects. */
function workspace(tag: string): string {
  const parent = tmpRepo(tag);
  for (const child of ["assign", "app.nanonets"]) {
    mkdirSync(join(parent, child, ".git"), { recursive: true });
    mkdirSync(join(parent, child, "src"), { recursive: true });
    writeFileSync(join(parent, child, "src", "main.ts"), `export function ${child.replace(/\W/g, "")}Main(): number {\n  return 1;\n}\n`);
  }
  return parent;
}

/** The CLI in a chosen cwd — `runCli` always runs in the project dir, and cwd is the point here. */
function cliIn(cwd: string, args: string[], home: string) {
  return spawnSync(process.execPath, ["--import", TSX, CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: homeEnv(home),
  });
}

test("init at a workspace parent wires every child repo, not just the parent", () => {
  const parent = workspace("init-ws");
  const home = tmpRepo("init-ws-home");

  const r = runCli(["init", parent, "--agents", "claude", "--no-build"], { home });
  assert.equal(r.status, 0, r.describe());

  for (const dir of [parent, join(parent, "assign"), join(parent, "app.nanonets")]) {
    assert.ok(existsSync(join(dir, ".claude", "settings.json")), `${dir} settings.json`);
    assert.ok(existsSync(join(dir, ".claude", "skills", "graft", "SKILL.md")), `${dir} skill`);
    assert.ok(existsSync(join(dir, ".claude", "helpers", "graft-hooks.cjs")), `${dir} hooks shim`);
    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers?.graft, `${dir} .mcp.json registers graft`);
  }
  assert.match(r.stderr, /workspace: wiring/, "must say it fanned out");
});

test("a plain repo is untouched by the fan-out — no child wiring, no workspace claims", () => {
  const repo = tmpRepo("init-plain");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "sub", ".git"), { recursive: true }); // a nested repo, but the parent has its OWN .git
  const home = tmpRepo("init-plain-home");

  const r = runCli(["init", repo, "--agents", "claude", "--no-build"], { home });
  assert.equal(r.status, 0, r.describe());
  assert.ok(existsSync(join(repo, ".claude", "settings.json")));
  assert.ok(!existsSync(join(repo, "sub", ".claude")), "a submodule-shaped child must not be wired");
  assert.doesNotMatch(r.stderr, /workspace: wiring/);
});

test("--dry-run lists the child repos' writes and writes nothing", () => {
  const parent = workspace("init-ws-dry");
  const home = tmpRepo("init-ws-dry-home");

  const r = runCli(["init", parent, "--agents", "claude", "--dry-run"], { home });
  assert.equal(r.status, 0, r.describe());
  assert.match(r.stderr, /assign\/ \(workspace child\)/);
  assert.match(r.stderr, /app\.nanonets\/ \(workspace child\)/);
  assert.ok(!existsSync(join(parent, ".claude")), "--dry-run must not write");
  assert.ok(!existsSync(join(parent, "assign", ".claude")), "--dry-run must not write to children");
});

test("a query from a subdirectory answers from the repo's graph one level up", () => {
  const parent = workspace("walk-e2e");
  const home = tmpRepo("walk-e2e-home");
  const child = join(parent, "assign");

  const built = runCli(["build", child], { home });
  assert.equal(built.status, 0, built.describe());

  const r = cliIn(join(child, "src"), ["map"], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no code map here — answering from/, "the walk must announce itself");
  assert.match(r.stdout + r.stderr, /main\.ts/, "must actually answer from the child's graph");
});

test("a query from the workspace parent still federates across children", () => {
  const parent = workspace("walk-parent");
  const home = tmpRepo("walk-parent-home");

  const built = runCli(["build", parent], { home });
  assert.equal(built.status, 0, built.describe());
  assert.ok(existsSync(join(parent, "graft", "workspace.json")), "parent holds the children index");

  const r = cliIn(parent, ["map"], home);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /no graft\/ here/, "the parent IS a root — no walk");
  assert.match(r.stdout, /assign\//, "federated output labels each child");
});
