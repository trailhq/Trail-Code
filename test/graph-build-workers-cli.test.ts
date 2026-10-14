/**
 * `graft build --workers` / `GRAFT_PARSE_WORKERS` through the real CLI: a value
 * that is neither `auto` nor a non-negative integer is rejected up front (as
 * `--concurrency` is), and a workspace build, which does not use the pool, says
 * so instead of silently ignoring the request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildGraph } from "../src/graph/build.js";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-workers-cli-"));
  writeFileSync(join(d, "main.ts"), "export function main(): number {\n  return 2;\n}\n");
  return d;
}

function runCliCapture(args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number } {
  const base = { ...process.env };
  delete base.GRAFT_PARSE_WORKERS;
  // spawnSync, not execFileSync: a successful run's stderr carries the warnings.
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...base, ...env },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

for (const bad of ["abc", "-2", "4abc"]) {
  test(`--workers rejects "${bad}" and exits 1 before building`, () => {
    const d = repo();
    try {
      const r = runCliCapture(["build", d, "--workers", bad]);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.ok(r.stderr.includes(`✗ --workers must be a non-negative integer or "auto", got "${bad}"`), r.stderr);
      assert.equal(existsSync(join(d, "graft")), false, "nothing was built");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
}

test("GRAFT_PARSE_WORKERS with an invalid value is rejected the same way", () => {
  const d = repo();
  try {
    const r = runCliCapture(["build", d], { GRAFT_PARSE_WORKERS: "4abc" });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stderr.includes(`✗ GRAFT_PARSE_WORKERS must be a non-negative integer or "auto", got "4abc"`), r.stderr);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("--workers 0 and --workers auto are accepted", () => {
  const d = repo();
  try {
    for (const ok of ["0", "auto"]) {
      const r = runCliCapture(["build", d, "--workers", ok]);
      assert.equal(r.status, 0, `--workers ${ok}: ${r.stderr}`);
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a workspace build warns once that --workers is ignored", () => {
  const parent = mkdtempSync(join(tmpdir(), "graft-workers-ws-"));
  try {
    for (const child of ["repoA", "repoB"]) {
      mkdirSync(join(parent, child, ".git"), { recursive: true });
      writeFileSync(join(parent, child, "main.ts"), "export function main(): number {\n  return 2;\n}\n");
    }
    const r = runCliCapture(["build", parent, "--workers", "2"]);
    assert.equal(r.status, 0, r.stderr);
    const warnings = r.stderr.split("\n").filter((l) => l.includes("--workers") && l.includes("workspace"));
    assert.equal(warnings.length, 1, r.stderr);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("buildGraph clamps an explicit worker count to the cores and the file count", async () => {
  const d = repo();
  try {
    const r = await buildGraph(d, { reuse: false, parseWorkers: 500 });
    assert.equal(r.files, 1);
    assert.equal(r.parseWorkers, Math.min(1, availableParallelism()), "one file never forks more than one child");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
