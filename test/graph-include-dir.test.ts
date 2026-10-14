/**
 * A5 — `graft build --include-dir <name>` end-to-end through the real CLI.
 *
 * SKIP_DIRS eats real source in some ecosystems (e.g. a build/ directory that
 * genuinely holds hand-written code). This is the explicit, persisted
 * override: no git-awareness (graft's documented no-git invariant), just a
 * per-repo state file that later no-flag builds — and the fingerprint probe,
 * which never sees CLI flags at all — read identically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { probeDrift, isClean } from "../src/graph/fingerprint.js";
import type { GraphV1 } from "../src/graph/types.js";

function repoWithBuildDir(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-include-dir-"));
  mkdirSync(join(d, "build"), { recursive: true });
  writeFileSync(join(d, "build", "util.ts"), "export function fromBuild(): number {\n  return 1;\n}\n");
  writeFileSync(join(d, "main.ts"), "export function main(): number {\n  return 2;\n}\n");
  return d;
}

function repoWithHiddenDir(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-include-hidden-"));
  mkdirSync(join(d, ".kb"), { recursive: true });
  writeFileSync(join(d, ".kb", "engine.ts"), "export function fromKb(): number {\n  return 1;\n}\n");
  mkdirSync(join(d, ".github"), { recursive: true });
  writeFileSync(join(d, ".github", "ci.ts"), "export function fromGithub(): number {\n  return 2;\n}\n");
  writeFileSync(join(d, "main.ts"), "export function main(): number {\n  return 3;\n}\n");
  return d;
}

function runCli(args: string[]): void {
  execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { stdio: "pipe" });
}

/** Like {@link runCli}, but captures a non-zero exit instead of throwing —
 * for the --include-dir validation tests, which expect `graft build` to
 * reject bad input rather than run to completion. */
function runCliCapture(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

function graphOf(d: string): GraphV1 | null {
  return readGraph(wiringPath(join(d, "graft")));
}

test("A5: build/ is absent by default, present with --include-dir build, persists across a no-flag rebuild, and the fingerprint probe agrees (no drift loop)", () => {
  const d = repoWithBuildDir();

  runCli(["build", d]);
  const cold = graphOf(d);
  assert.ok(cold, "expected a built graph.json");
  assert.ok(!cold!.nodes.some((n) => n.path.startsWith("build/")), "build/ must be absent by default (SKIP_DIRS)");
  assert.ok(cold!.nodes.some((n) => n.id === "main.ts#main"), "sanity: the non-skipped file is indexed");

  runCli(["build", d, "--include-dir", "build"]);
  const withFlag = graphOf(d);
  assert.ok(withFlag);
  assert.ok(
    withFlag!.nodes.some((n) => n.id === "build/util.ts#fromBuild"),
    "build/ must be included this run, with the flag",
  );

  // No flag this time — the persisted state must still include it.
  runCli(["build", d]);
  const persisted = graphOf(d);
  assert.ok(persisted);
  assert.ok(
    persisted!.nodes.some((n) => n.id === "build/util.ts#fromBuild"),
    "a follow-up NO-FLAG rebuild must still include build/ (state-persisted)",
  );

  // The fingerprint probe (the fast path `ensureFreshGraph`/hooks use, which
  // never sees CLI flags) must read the same persisted include set — so it
  // recognizes build/util.ts as already-tracked, not perpetually "added".
  const drift = probeDrift(d, join(d, "graft"));
  assert.ok(drift, "expected a fingerprint to probe against");
  assert.ok(isClean(drift!), `probe must report clean, got ${JSON.stringify(drift)}`);
});

test("A5: deleting the generated graft cache does not delete the persisted include-dir setting", () => {
  const d = repoWithBuildDir();
  try {
    runCli(["build", d, "--include-dir", "build"]);
    rmSync(join(d, "graft"), { recursive: true, force: true });

    runCli(["build", d]);
    const rebuilt = graphOf(d);
    assert.ok(rebuilt?.nodes.some((n) => n.id === "build/util.ts#fromBuild"));
    assert.equal(existsSync(join(d, ".graft", "config.json")), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("A5: custom --dir builds keep repository config outside both output directories", () => {
  const d = repoWithBuildDir();
  const out = mkdtempSync(join(tmpdir(), "graft-include-dir-output-"));
  try {
    writeFileSync(join(d, "graft"), "a regular file that must not receive config\n");
    runCli(["--dir", out, "build", d, "--include-dir", "build"]);

    const graph = readGraph(wiringPath(out));
    assert.ok(graph?.nodes.some((n) => n.id === "build/util.ts#fromBuild"));
    assert.equal(existsSync(join(d, ".graft", "config.json")), true);
    assert.equal(existsSync(join(d, "graft", ".cache", "config.json")), false);
    assert.equal(existsSync(join(out, ".cache", "config.json")), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

// --include-dir takes bare directory NAMES, never paths. Named hidden
// directories (.kb) are the same opt-in as SKIP_DIRS names; .git is never
// overridable. Without validation, a value like "foo/bar" would silently
// persist and then just never match any real directory name walkDir compares
// against (shouldSkipDir compares against a single path segment).

test("A5: --include-dir rejects .git", () => {
  const d = repoWithBuildDir();
  try {
    const r = runCliCapture(["build", d, "--include-dir", ".git"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /--include-dir/);
    assert.match(r.stderr, /\.git/);
    assert.equal(existsSync(join(d, ".graft", "config.json")), false, "must not persist an invalid value");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("A5: .kb/ is absent by default, present with --include-dir .kb, persists across a no-flag rebuild; .github stays skipped", () => {
  const d = repoWithHiddenDir();
  try {
    runCli(["build", d]);
    const cold = graphOf(d);
    assert.ok(cold, "expected a built graph.json");
    assert.ok(!cold!.nodes.some((n) => n.path.startsWith(".kb/")), ".kb/ must be absent by default");
    assert.ok(!cold!.nodes.some((n) => n.path.startsWith(".github/")), ".github/ must be absent by default");
    assert.ok(cold!.nodes.some((n) => n.id === "main.ts#main"), "sanity: the non-skipped file is indexed");

    runCli(["build", d, "--include-dir", ".kb"]);
    const withFlag = graphOf(d);
    assert.ok(withFlag);
    assert.ok(
      withFlag!.nodes.some((n) => n.id === ".kb/engine.ts#fromKb"),
      ".kb/ must be included this run, with the flag, on the same root graph",
    );
    assert.ok(
      withFlag!.nodes.some((n) => n.id === "main.ts#main"),
      "the root file stays on the same graph as .kb/",
    );
    assert.ok(
      !withFlag!.nodes.some((n) => n.path.startsWith(".github/")),
      "including .kb must not pull in .github",
    );

    runCli(["build", d]);
    const persisted = graphOf(d);
    assert.ok(persisted);
    assert.ok(
      persisted!.nodes.some((n) => n.id === ".kb/engine.ts#fromKb"),
      "a follow-up NO-FLAG rebuild must still include .kb/ (state-persisted)",
    );
    assert.ok(
      !persisted!.nodes.some((n) => n.path.startsWith(".github/")),
      "persisted .kb must not start indexing .github",
    );

    const drift = probeDrift(d, join(d, "graft"));
    assert.ok(drift, "expected a fingerprint to probe against");
    assert.ok(isClean(drift!), `probe must report clean, got ${JSON.stringify(drift)}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("A5: --include-dir rejects a value containing a path separator", () => {
  const d = repoWithBuildDir();
  try {
    const r = runCliCapture(["build", d, "--include-dir", "foo/bar"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /--include-dir/);
    assert.match(r.stderr, /foo\/bar/);
    assert.equal(existsSync(join(d, ".graft", "config.json")), false, "must not persist an invalid value");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("A5: --include-dir rejects a value containing a backslash", () => {
  const d = repoWithBuildDir();
  try {
    const r = runCliCapture(["build", d, "--include-dir", "foo\\bar"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /--include-dir/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("A5: a later valid --include-dir still works (validation isn't over-eager)", () => {
  const d = repoWithBuildDir();
  try {
    runCli(["build", d, "--include-dir", "build"]);
    const g = graphOf(d);
    assert.ok(g && g.nodes.some((n) => n.id === "build/util.ts#fromBuild"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
