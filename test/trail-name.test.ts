/**
 * `trail` and `graft`: one program under two names.
 *
 * Under graft every command keeps its old name, meaning and output, because
 * agents, hooks and CI already parse it. Under trail the layout changes: the
 * `graft trail …` group moves to the top level, `check` hands its name to the
 * team check, and the freshness check becomes `build --check`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand, cmd, graftNotice, handoverStampPath, noticeStampPath, strandedRepoNotice, tag, trailHandoverLine } from "../src/brand.js";
import { track } from "../src/telemetry/track.js";
import { commandInvokesGraft } from "../src/claude/session-metrics.js";
import { savingsLine, sumSavingsFooters } from "../src/context/savings.js";
import { homeEnv, tmpRepo } from "./helpers.js";

// --- the name itself ---

test("unset means graft: anything that loads cli.js directly was wired by an older graft", () => {
  assert.equal(brand({}), "graft");
  assert.equal(brand({ TRAIL_INVOKED_AS: "trail" }), "trail");
  assert.equal(brand({ TRAIL_INVOKED_AS: "something-else" }), "graft");
  assert.equal(tag({ TRAIL_INVOKED_AS: "trail" }), "[trail]");
  assert.equal(tag({}), "[graft]");
});

test("cmd spells a graft command the way the running name does", () => {
  for (const s of ["graft ask", "graft check", "graft build --deep"]) assert.equal(cmd(s, "graft"), s);
  assert.equal(cmd("graft ask", "trail"), "trail ask");
  assert.equal(cmd("graft build --deep", "trail"), "trail build --deep");
  assert.equal(cmd("graft check", "trail"), "trail build --check");
  assert.equal(cmd("graft stats", "trail"), "trail status");
  // A prefix only matches a whole word: `graft checkout` is not `graft check`.
  assert.equal(cmd("graft checkout", "trail"), "trail checkout");
});

// --- the once-a-day line for people still typing graft ---

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "graft-notice-"));
}

test("a person typing graft sees the new name once a day, with what it ran", () => {
  const home = scratchHome();
  const env = { PATH: "" };
  const now = Date.parse("2026-10-07T10:00:00Z");
  const first = graftNotice({ ran: "graft ask", tty: true, env, home, now });
  assert.equal(
    first,
    "· graft is now trail. this ran trail ask, and graft keeps working (shown once a day)\n" +
      "· run graft upgrade to get the trail command too",
  );
  assert.equal(graftNotice({ ran: "graft ask", tty: true, env, home, now: now + 60_000 }), null, "not twice in a day");
  assert.ok(graftNotice({ ran: "graft ask", tty: true, env, home, now: now + 25 * 3600_000 }), "again the next day");
});

test("the notice names the trail spelling of a renamed command", () => {
  const out = graftNotice({ ran: "graft check", tty: true, env: { PATH: "" }, home: scratchHome() });
  assert.match(out ?? "", /this ran trail build --check,/);
});

test("no upgrade hint once a trail command is on PATH", () => {
  const bin = mkdtempSync(join(tmpdir(), "graft-bin-"));
  const exe = join(bin, process.platform === "win32" ? "trail.cmd" : "trail");
  writeFileSync(exe, "");
  chmodSync(exe, 0o755);
  const out = graftNotice({ ran: "graft grep", tty: true, env: { PATH: bin }, home: scratchHome() });
  assert.equal(out, "· graft is now trail. this ran trail grep, and graft keeps working (shown once a day)");
});

test("agents, pipes, CI and trail itself never see the notice, and it isn't stamped for them", () => {
  const home = scratchHome();
  assert.equal(graftNotice({ ran: "graft ask", tty: false, env: {}, home }), null, "no terminal");
  assert.equal(graftNotice({ ran: "graft ask", tty: true, env: { CLAUDECODE: "1" }, home }), null, "Claude Code");
  assert.equal(graftNotice({ ran: "graft ask", tty: true, env: { CI: "true" }, home }), null, "CI");
  assert.equal(graftNotice({ ran: "graft ask", tty: true, env: { TRAIL_INVOKED_AS: "trail" }, home }), null, "trail");
  assert.equal(graftNotice({ ran: "graft ask", tty: true, env: { GRAFT_NO_RENAME_NOTICE: "1" }, home }), null, "opted out");
  assert.equal(existsSync(noticeStampPath(home)), false, "nothing stamped");
});

// --- a repo whose graft-era hooks can't reach trail ---

/** A repo wired by graft 0.21: a hook shim that looks for @nanonets/graft alone. */
function graftEraRepo(shim = "require.resolve('@nanonets/graft/package.json')"): string {
  const repo = mkdtempSync(join(tmpdir(), "graft-era-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".claude", "helpers"), { recursive: true });
  writeFileSync(join(repo, ".claude", "helpers", "graft-hooks.cjs"), shim);
  return repo;
}

const TRAIL = { TRAIL_INVOKED_AS: "trail", PATH: "" };
const STRANDED =
  "· this repo's agent hooks were set up by an older graft and can't find trail. run trail init here once to move the repo over";

test("trail in a graft-era repo, with no graft to answer its hooks, says how to move the repo", () => {
  const repo = graftEraRepo();
  assert.equal(strandedRepoNotice({ cwd: repo, tty: true, env: TRAIL }), STRANDED);
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  assert.equal(strandedRepoNotice({ cwd: join(repo, "src", "deep"), tty: true, env: TRAIL }), STRANDED, "from a subfolder too");
});

test("no stranded line once something can answer the hooks, or the repo already moved", () => {
  const bin = mkdtempSync(join(tmpdir(), "graft-bin-"));
  const exe = join(bin, process.platform === "win32" ? "graft.cmd" : "graft");
  writeFileSync(exe, "");
  chmodSync(exe, 0o755);
  assert.equal(strandedRepoNotice({ cwd: graftEraRepo(), tty: true, env: { ...TRAIL, PATH: bin } }), null, "graft installed");
  assert.equal(strandedRepoNotice({ cwd: graftEraRepo("const PKGS = ['@trailhq/trail-code', '@nanonets/graft'];"), tty: true, env: TRAIL }), null, "a shim that looks for trail");
  const moved = graftEraRepo();
  writeFileSync(join(moved, ".claude", "helpers", "trail-hooks.cjs"), "");
  assert.equal(strandedRepoNotice({ cwd: moved, tty: true, env: TRAIL }), null, "already on trail");
  assert.equal(strandedRepoNotice({ cwd: tmpRepo(), tty: true, env: TRAIL }), null, "never wired");
});

test("agents, pipes, CI and graft itself never see the stranded line", () => {
  const repo = graftEraRepo();
  assert.equal(strandedRepoNotice({ cwd: repo, tty: false, env: TRAIL }), null, "no terminal");
  assert.equal(strandedRepoNotice({ cwd: repo, tty: true, env: { ...TRAIL, CLAUDECODE: "1" } }), null, "Claude Code");
  assert.equal(strandedRepoNotice({ cwd: repo, tty: true, env: { ...TRAIL, CI: "true" } }), null, "CI");
  assert.equal(strandedRepoNotice({ cwd: repo, tty: true, env: { PATH: "" } }), null, "graft");
});

// --- what parses the output ---

test("the savings footer is read under either name", () => {
  assert.equal(sumSavingsFooters("[graft] tokens saved ≈ 1,200 (80%)\n[trail] tokens saved ≈ 300 (50%)"), 1500);
});

test("a shell command running trail counts as a retrieval, like graft", () => {
  assert.equal(commandInvokesGraft('trail ask "auth" --source'), true);
  assert.equal(commandInvokesGraft("npx -y @trailhq/trail-code grep foo"), true);
  assert.equal(commandInvokesGraft("cd x && trail callers run"), true);
  assert.equal(commandInvokesGraft("node dist/bin/trail.js ask x"), true);
  assert.equal(commandInvokesGraft("graft ask x"), true);
  assert.equal(commandInvokesGraft("mytrail ask x"), false);
  assert.equal(commandInvokesGraft("echo trail"), false);
});

test("every telemetry event says which name ran it", () => {
  process.env.GRAFT_POSTHOG_KEY = "phc_test_key";
  const home = scratchHome();
  const open = { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv;
  const viaTrail = track("first_run", {}, { home, env: { ...open, TRAIL_INVOKED_AS: "trail" } });
  const other = scratchHome();
  const viaGraft = track("first_run", {}, { home: other, env: { HOME: other, USERPROFILE: other } });
  assert.equal(viaTrail?.properties.cli_name, "trail");
  assert.equal(viaGraft?.properties.cli_name, "graft");
});

// --- the two command layouts, end to end ---

function run(name: "trail" | "graft", args: string[], home: string, cwd = process.cwd(), extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", `${name}.ts`), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_CLOUD: undefined, ...extra },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function builtRepo(): string {
  const d = tmpRepo("trailname");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "export function alpha(): number {\n  return beta();\n}\n");
  writeFileSync(join(d, "src", "b.ts"), "export function beta(): number {\n  return 1;\n}\n");
  spawnSync("git", ["init", "-q"], { cwd: d });
  return d;
}

test("trail --help groups the commands, and lists the workspace ones only once signing in is on", () => {
  const home = scratchHome();
  const r = run("trail", ["--help"], home);
  assert.equal(r.status, 0);
  for (const heading of ["Find code", "Team memory:", "Setup:", "CI:"]) assert.ok(r.out.includes(heading), heading);
  for (const c of ["note", "check", "team", "status"]) assert.match(r.out, new RegExp(`^  ${c} `, "m"), c);
  // Still run, just not listed: the brain's rules, corrections on skills, and signing in.
  for (const c of ["viz", "mcp", "stats", "watch", "connect", "trail", "push", "pull", "learn", "skills", "workspace", "login", "logout"])
    assert.doesNotMatch(r.out, new RegExp(`^  ${c} `, "m"), c);
  const on = run("trail", ["--help"], home, process.cwd(), { TRAIL_CLOUD: "1" });
  assert.ok(on.out.includes("Workspace"));
  for (const c of ["workspace", "login", "logout"]) assert.match(on.out, new RegExp(`^  ${c} `, "m"), c);
});

test("graft --help keeps its old flat list, including check, without the trail group", () => {
  const r = run("graft", ["--help"], scratchHome());
  assert.equal(r.status, 0);
  assert.match(r.out, /^Usage: graft /m);
  for (const c of ["check", "stats", "viz"]) assert.match(r.out, new RegExp(`^  ${c} `, "m"), c);
  assert.doesNotMatch(r.out, /^  trail /m);
  assert.ok(!r.out.includes("Workspace ·"));
});

test("the freshness check is graft check under graft and trail build --check under trail", () => {
  const home = scratchHome();
  const d = builtRepo();
  assert.equal(run("graft", ["build", d], home).status, 0);
  const g = run("graft", ["check", d], home);
  assert.equal(g.status, 0, g.err);
  assert.match(g.out, /graph check: OK/);
  assert.match(g.out, /Run `graft build --deep` to summarize them/);
  const t = run("trail", ["build", "--check", d], home);
  assert.equal(t.status, 0, t.err);
  assert.match(t.out, /graph check: OK/);
  assert.match(t.out, /Run `trail build --deep` to summarize them/);
  assert.equal(run("graft", ["build", "--check", d], home).status, 0, "graft build --check works too");
  // Stale: a new function the graph has never seen fails both, the same way.
  writeFileSync(join(d, "src", "c.ts"), "export function gamma(): number {\n  return 2;\n}\n");
  assert.equal(run("graft", ["check", d, "--json"], home).status, 1);
  assert.equal(run("trail", ["build", "--check", d, "--json"], home).status, 1);
});

test("trail check is the team check, not the freshness check", () => {
  // Outside a git repo there is no diff to check; the freshness check is build --check.
  const r = run("trail", ["check", mkdtempSync(join(tmpdir(), "not-git-"))], scratchHome());
  assert.equal(r.status, 1);
  assert.match(r.err, /not a git repository/);
});

test("trail status puts the code map on one screen, and the workspace only once signing in is on", () => {
  const home = scratchHome();
  const d = builtRepo();
  run("trail", ["build", d], home);
  const r = run("trail", ["status", d], home);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^code map {4}✓ \d+ nodes · in sync with the code$/m);
  assert.doesNotMatch(r.out, /^workspace/m);
  const on = run("trail", ["status", d], home, process.cwd(), { TRAIL_CLOUD: "1" });
  assert.match(on.out, /^workspace {3}not connected · Claude offers a link once there are learnings to share$/m);
  const json = JSON.parse(run("trail", ["status", d, "--json"], home).out);
  assert.equal(json.workspace, null);
});

test("trail stats still works under trail", () => {
  const home = scratchHome();
  const d = builtRepo();
  run("trail", ["build", d], home);
  const r = run("trail", ["stats", d], home);
  assert.equal(r.status, 0, r.err);
});

test("the savings footer says [trail] under trail and [graft] under graft", () => {
  const saved = { baselineChars: 40_000, files: 3 } as Parameters<typeof savingsLine>[1];
  const before = process.env.TRAIL_INVOKED_AS;
  try {
    delete process.env.TRAIL_INVOKED_AS;
    assert.match(savingsLine("short pack", saved), /^\[graft\] tokens saved ≈ /);
    process.env.TRAIL_INVOKED_AS = "trail";
    assert.match(savingsLine("short pack", saved), /^\[trail\] tokens saved ≈ /);
  } finally {
    if (before === undefined) delete process.env.TRAIL_INVOKED_AS;
    else process.env.TRAIL_INVOKED_AS = before;
  }
});

// --- MCP: trail's tool names, graft's still answered ---

async function mcpRpc(name: "trail" | "graft", dir: string, messages: object[], expected: number): Promise<any[]> {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", `${name}.ts`), "mcp", dir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DO_NOT_TRACK: "1", TRAIL_INVOKED_AS: undefined },
  });
  const out: any[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) out.push(JSON.parse(line));
    }
  });
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const deadline = Date.now() + 20000;
  while (out.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  return out;
}

test("trail mcp advertises trail_* tools and answers graft_* calls too; graft mcp is unchanged", async () => {
  const d = builtRepo();
  run("graft", ["build", d], scratchHome());
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const call = (id: number, tool: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: { query: "beta" } } });

  const t = await mcpRpc("trail", d, [init, list, call(3, "trail_find_code"), call(4, "graft_find_code")], 4);
  assert.equal(t.find((r) => r.id === 1)?.result.serverInfo.name, "trail");
  assert.match(t.find((r) => r.id === 1)?.result.instructions, /select:mcp__trail__trail_find_code,/);
  const names = t.find((r) => r.id === 2)?.result.tools.map((x: { name: string }) => x.name);
  assert.ok(names.includes("trail_find_code") && !names.some((n: string) => n.startsWith("graft_")), String(names));
  for (const id of [3, 4]) assert.equal(t.find((r) => r.id === id)?.result.isError, false, `call ${id}`);

  const g = await mcpRpc("graft", d, [init, list], 2);
  assert.equal(g.find((r) => r.id === 1)?.result.serverInfo.name, "graft");
  assert.ok(g.find((r) => r.id === 2)?.result.tools.some((x: { name: string }) => x.name === "graft_find_code"));
});

test("both tool vocabularies count as retrievals", async () => {
  const { canonicalToolName } = await import("../src/mcp/tool-names.js");
  const { isGraftMcpTool } = await import("../src/claude/session-metrics.js");
  assert.equal(canonicalToolName("trail_find_code"), "graft_find_code");
  assert.equal(canonicalToolName("graft_ask"), "graft_find_code");
  assert.equal(isGraftMcpTool("mcp__trail__trail_trace_calls"), true);
  assert.equal(isGraftMcpTool("mcp__graft__graft_find_all"), true);
});

// --- the agent's line on a machine with graft and no trail ---

test("on graft without trail, the agent is told once a week how to get trail", () => {
  const home = scratchHome();
  const now = Date.parse("2026-10-14T10:00:00Z");
  const line = trailHandoverLine({ env: { PATH: "" }, home, now });
  assert.match(line ?? "", /graft is now Trail-code/);
  assert.match(line ?? "", /`graft upgrade` adds it and graft keeps working/);
  assert.equal(trailHandoverLine({ env: { PATH: "" }, home, now: now + 3 * 86400_000 }), null, "not again that week");
  assert.ok(trailHandoverLine({ env: { PATH: "" }, home, now: now + 8 * 86400_000 }), "again the next week");
});

test("no handover line once trail is installed, under trail, in CI, or opted out", () => {
  const bin = mkdtempSync(join(tmpdir(), "graft-bin-"));
  const exe = join(bin, process.platform === "win32" ? "trail.cmd" : "trail");
  writeFileSync(exe, "");
  chmodSync(exe, 0o755);
  const home = scratchHome();
  assert.equal(trailHandoverLine({ env: { PATH: bin }, home }), null, "trail on PATH");
  assert.equal(trailHandoverLine({ env: { PATH: "", TRAIL_INVOKED_AS: "trail" }, home }), null, "trail");
  assert.equal(trailHandoverLine({ env: { PATH: "", CI: "true" }, home }), null, "CI");
  assert.equal(trailHandoverLine({ env: { PATH: "", GRAFT_NO_RENAME_NOTICE: "1" }, home }), null, "opted out");
  assert.equal(existsSync(handoverStampPath(home)), false, "nothing stamped");
});
