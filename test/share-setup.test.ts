/**
 * `trail share-session` sends a person's Claude Code setup beside their
 * sessions. Nothing that can hold a secret leaves as a value: MCP `env` and
 * `headers` and settings `env` go as names, a URL as its origin, and every
 * other string through the same redaction and name-hiding as a session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSetup, setupCounts } from "../src/cloud/share-setup.js";
import { secretReason } from "../src/notes/secrets.js";

// Built in pieces so no scanner reads a real-looking key in this file.
const OPENAI = "sk-" + "proj-" + "Q7x2Lm9Pz4Rt8Vb1Nc6Kw3Hy5Jd0Fs";

let made = 0;
/**
 * A scratch folder with a plain name. mkdtemp's random suffix (`setup-home-Qx9Zk2`)
 * can read as a key to the redaction, which runs before the home folder becomes `~`.
 */
function scratch(kind: string): string {
  const dir = join(tmpdir(), `setup-${kind}-${process.pid}-${++made}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A home folder with a Claude Code setup in it, and one repo the person worked in. */
function fakeHome(): { home: string; repo: string } {
  const home = scratch("home");
  const repo = scratch("repo");
  const put = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  put(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/sse?token=abc123tok", headers: { Authorization: "Bearer very-secret-header" } },
        db: { command: "node", args: [`${home}/mcp/db.js`, `--key=${OPENAI}`], env: { DB_PASSWORD: "hunter2hunter2" } },
      },
      projects: { [repo]: { mcpServers: { local: { command: "npx", args: ["local-mcp"] } } } },
    }),
  );
  put(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: `node ${home}/.claude/hooks/stop.cjs` }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }] },
      permissions: { allow: ["Bash(npm test)"], deny: ["Bash(rm -rf:*)"] },
      enabledPlugins: { "slack@official": true, "figma@official": false },
      env: { SECRET_TOKEN: "abc123secretvalue" },
    }),
  );
  put(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "slack@official": [{}], "figma@official": [{}] } }));
  put(join(home, ".claude", "CLAUDE.md"), "Answer first. Mail maya@acme.test when stuck.\n");
  put(join(home, ".claude", "skills", "deploy", "SKILL.md"), `---\nname: deploy\n---\nRun ${home}/bin/deploy.sh as maya.\n`);
  put(join(home, ".claude", "agents", "reviewer.md"), "Review diffs.\n");
  put(join(home, ".claude", "commands", "ship.md"), "Ship it.\n");
  put(join(home, ".claude", "projects", "-Users-maya-web", "memory", "auth.md"), `AWS login moved to SSO on Oct 2. Old key ${OPENAI} is dead.\n`);
  put(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { trail: { command: "trail", args: ["mcp"] } } }));
  put(join(repo, "CLAUDE.md"), "Use the shared order reader.\n");
  put(join(repo, ".claude", "skills", "migrate", "SKILL.md"), "Never delete migration files.\n");
  return { home, repo };
}

test("collectSetup: MCP servers, settings, plugins, skills, agents, commands, CLAUDE.md files and memory notes", () => {
  const { home, repo } = fakeHome();
  const r = collectSetup({ home, dirs: [repo], who: [home, "maya", "maya@acme.test"] });
  const s = r.setup;
  assert.deepEqual(s.mcp.map((m) => `${m.scope.split(" ")[0]} ${m.name}`).sort(), ["local local", "project trail", "user db", "user linear"]);
  assert.deepEqual(s.plugins, ["figma@official", "slack@official"]);
  assert.deepEqual(s.settings[0]!.plugins, ["slack@official"], "only plugins turned on");
  assert.deepEqual(s.settings[0]!.hooks, { Stop: ["node ~/.claude/hooks/stop.cjs"], PreToolUse: ["Bash → guard"] });
  assert.deepEqual(s.settings[0]!.permissions, { allow: ["Bash(npm test)"], ask: [], deny: ["Bash(rm -rf:*)"] });
  assert.deepEqual(s.files.map((f) => f.kind).sort(), ["agent", "claude-md", "claude-md", "command", "memory", "skill", "skill"]);
  assert.deepEqual(setupCounts(s), { mcp: 4, skills: 2, agents: 1, commands: 1, claudeMd: 2, memory: 1, hooks: 2, plugins: 2 });
});

test("collectSetup: env, headers and URL paths go as names or origins, keys are redacted, and the person's name and home folder come out", () => {
  const { home, repo } = fakeHome();
  const r = collectSetup({ home, dirs: [repo], who: [home, "maya", "maya@acme.test"] });
  const all = JSON.stringify(r.setup);
  for (const secret of ["hunter2hunter2", "very-secret-header", "abc123tok", "abc123secretvalue", OPENAI]) assert.ok(!all.includes(secret), `${secret} doesn't leave`);
  assert.equal(secretReason(all), null);
  const db = r.setup.mcp.find((m) => m.name === "db")!;
  assert.deepEqual(db.env, ["DB_PASSWORD"]);
  assert.equal(db.args[0], "~/mcp/db.js");
  const linear = r.setup.mcp.find((m) => m.name === "linear")!;
  assert.equal(linear.url, "https://mcp.linear.app");
  assert.deepEqual(linear.headers, ["Authorization"]);
  assert.deepEqual(r.setup.settings[0]!.env, ["SECRET_TOKEN"]);
  assert.ok(!all.includes(home), "the home folder becomes ~");
  assert.ok(!/maya/i.test(all), "the person's name and email come out");
  const memory = r.setup.files.find((f) => f.kind === "memory")!;
  assert.match(memory.path, /^~[\\/]\.claude[\\/]projects[\\/]-Users-\[you\]-web[\\/]memory[\\/]auth\.md$/);
  assert.match(memory.content, /AWS login moved to SSO/);
  assert.ok(r.redacted["an API key"]! >= 1);
  assert.ok(r.hidden > 0);
});

test("collectSetup: a home with no Claude Code setup gives an empty one, and a file over the cap is left out", () => {
  const home = mkdtempSync(join(tmpdir(), "setup-empty-"));
  assert.deepEqual(collectSetup({ home, who: [home] }).setup, { kind: "claude-setup", version: 1, mcp: [], settings: [], plugins: [], files: [] });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "x".repeat(600 * 1024));
  const r = collectSetup({ home, who: [home] });
  assert.equal(r.setup.files.length, 0);
  assert.equal(r.leftOut, 1);
});
