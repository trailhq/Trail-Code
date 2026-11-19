/**
 * A missing browser opener must not take the process down (#819). On Linux
 * without xdg-open (WSL, minimal images) spawn fails asynchronously with an
 * 'error' event; unheard, it ends the process, and `viz` lost its server.
 * Linux only: macOS always has `open`, and Windows goes through the shell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const skip = process.platform !== "linux" ? "the opener is xdg-open on Linux only" : false;
const TSX = pathToFileURL(createRequire(join(process.cwd(), "x.js")).resolve("tsx")).href;
const CLI = resolve(process.cwd(), "src/cli.ts");

/** An environment whose PATH has no xdg-open (node runs by its full path). */
function noOpenerEnv(dir: string): NodeJS.ProcessEnv {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const env = { ...process.env, PATH: bin };
  delete env.GRAFT_NO_BROWSER;
  return env;
}

test("openBrowser survives a missing opener", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-opener-"));
  try {
    const browser = pathToFileURL(resolve(process.cwd(), "src/util/browser.ts")).href;
    const script =
      `import { openBrowser } from ${JSON.stringify(browser)};\n` +
      `openBrowser("http://127.0.0.1:1/");\n` +
      `setTimeout(() => console.log("still alive"), 500);\n`;
    const r = spawnSync(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
      cwd: dir,
      env: noOpenerEnv(dir),
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /still alive/);
    assert.doesNotMatch(r.stderr, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("viz keeps serving when the browser opener is missing", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-viz-opener-"));
  const contextDir = join(dir, "graft");
  mkdirSync(contextDir);
  writeFileSync(
    join(contextDir, "alpha.md"),
    `---\nname: Alpha\nslug: alpha\ntype: system\nsources: []\nlinks: []\n---\nbody\n`,
  );
  const child = spawn(process.execPath, ["--import", TSX, CLI, "--dir", contextDir, "viz", dir, "--port", "4851"], {
    cwd: dir,
    env: noOpenerEnv(dir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  try {
    const url = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no URL printed\n${out}\n${err}`)), 30_000);
      child.stdout.on("data", () => {
        const m = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (m) {
          clearTimeout(t);
          res(m[1]!);
        }
      });
      child.on("exit", (code) => rej(new Error(`viz exited (${code}) before serving\n${out}\n${err}`)));
    });
    // The failed spawn reports within milliseconds; give it time to land.
    const early = await Promise.race([exited, new Promise((r) => setTimeout(() => r("running"), 1000))]);
    assert.equal(early, "running", `viz exited early\n${err}`);
    const res = await fetch(`${url}/api/context-graph`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(err, /ENOENT/);
  } finally {
    child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
