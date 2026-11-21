import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { PACKAGE_FOR } from "../src/brand.js";
import { formatUpgradeReport, runUpgrade } from "../src/cli-meta.js";

function fixture(t: TestContext, count = "2") {
  const root = mkdtempSync(join(tmpdir(), "trail-upgrade-"));
  const bunGlobal = join(root, "custom global");
  const bunRoot = join(bunGlobal, "node_modules");
  const npmRoot = join(root, "npm", "node_modules");
  const commands: string[][] = [];
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });

  function install(store: string, name: string, version: string): string {
    const manifest = join(store, name, "package.json");
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ name, version }));
    return pathToFileURL(join(dirname(manifest), "dist", "cli.js")).href;
  }

  function mockProcesses(respond: (command: string, args: string[]) => { status: number; stdout?: string; stderr?: string }) {
    t.mock.method(childProcess, "spawnSync", (command: string, args: string[]) => {
      commands.push([command, ...args]);
      if (command === "bun" && args[0] === "pm") {
        return { status: 0, stdout: `${bunGlobal} node_modules (${count})\n└── ${PACKAGE_FOR.trail}@0.23.0\n` };
      }
      return respond(command, args);
    });
    t.mock.method(childProcess, "execFileSync", (command: string, args: string[]) => {
      commands.push([command, ...args]);
      assert.deepEqual([command, ...args], ["npm", "root", "-g"]);
      return npmRoot;
    });
    syncBuiltinESMExports();
  }

  return { root, bunRoot, npmRoot, commands, install, mockProcesses };
}

const trailLatest = `${PACKAGE_FOR.trail}@latest`;
const graftLatest = `${PACKAGE_FOR.graft}@latest`;

test("upgrades the running Bun global install and reads the version installed on disk", (t) => {
  const { bunRoot, commands, install, mockProcesses } = fixture(t);
  const cli = install(bunRoot, PACKAGE_FOR.trail, "0.23.0");
  mockProcesses((command, args) => {
    if (command !== "bun" || args[0] !== "add") return { status: 1 };
    install(bunRoot, PACKAGE_FOR.trail, "0.24.0");
    return { status: 0 };
  });

  const result = runUpgrade(cli);
  assert.deepEqual(commands, [["bun", "pm", "ls", "-g"], ["bun", "add", "-g", trailLatest]]);
  assert.equal(result.ok, true);
  assert.equal(result.oldVersion, "0.23.0");
  assert.equal(result.newVersion, "0.24.0");
});

test("legacy Bun upgrades install Trail alongside Graft when Trail is published", (t) => {
  const { bunRoot, commands, install, mockProcesses } = fixture(t, "2 installed");
  const cli = install(bunRoot, PACKAGE_FOR.graft, "0.23.0");
  mockProcesses((command, args) => {
    if (command !== "bun") return { status: 1 };
    if (args[0] === "info") return { status: 0, stdout: "0.24.0\n" };
    install(bunRoot, PACKAGE_FOR.graft, "0.24.0");
    install(bunRoot, PACKAGE_FOR.trail, "0.24.0");
    return { status: 0 };
  });

  const result = runUpgrade(cli);
  assert.deepEqual(commands, [
    ["bun", "pm", "ls", "-g"],
    ["bun", "info", trailLatest, "version"],
    ["bun", "add", "-g", graftLatest, trailLatest],
  ]);
  assert.equal(result.newVersion, "0.24.0");
  assert.equal(result.trailVersion, "0.24.0");
});

test("a separate Bun global copy leaves npm in charge of the running npm copy", (t) => {
  const { bunRoot, npmRoot, commands, install, mockProcesses } = fixture(t);
  const cli = install(npmRoot, PACKAGE_FOR.graft, "0.23.0");
  install(bunRoot, PACKAGE_FOR.graft, "0.23.0");
  mockProcesses((command, args) => {
    if (command !== "npm") return { status: 1 };
    if (args[0] === "view") return { status: 0, stdout: "0.24.0\n" };
    install(npmRoot, PACKAGE_FOR.graft, "0.24.0");
    install(npmRoot, PACKAGE_FOR.trail, "0.24.0");
    return { status: 0 };
  });

  const result = runUpgrade(cli);
  assert.deepEqual(commands, [
    ["bun", "pm", "ls", "-g"],
    ["npm", "view", PACKAGE_FOR.trail, "version"],
    ["npm", "install", "-g", graftLatest, trailLatest],
    ["npm", "root", "-g"],
    ["npm", "root", "-g"],
  ]);
  assert.equal(result.newVersion, "0.24.0");
  assert.equal(result.trailVersion, "0.24.0");
});

test("a failed Bun upgrade reports Bun's command and error", (t) => {
  const { bunRoot, commands, install, mockProcesses } = fixture(t);
  const cli = install(bunRoot, PACKAGE_FOR.trail, "0.23.0");
  mockProcesses(() => ({ status: 1, stderr: "error: permission denied\n" }));

  const result = runUpgrade(cli);
  assert.equal(result.ok, false);
  assert.deepEqual(commands, [["bun", "pm", "ls", "-g"], ["bun", "add", "-g", trailLatest]]);
  assert.match(formatUpgradeReport(result), /permission denied[\s\S]*bun add -g @trailhq\/trail-code@latest failed/);
});

test("an npx invocation remains a no-op without probing Bun", (t) => {
  const { root, commands, install, mockProcesses } = fixture(t);
  const cli = install(join(root, "_npx", "hash", "node_modules"), PACKAGE_FOR.trail, "0.23.0");
  mockProcesses(() => ({ status: 1 }));

  assert.deepEqual(runUpgrade(cli), { ran: false, ok: true, oldVersion: "0.23.0" });
  assert.deepEqual(commands, []);
});
