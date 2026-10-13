/**
 * `graft build --ignore-file` + the starter `.graftignore`, through the real CLI.
 *
 * The flag is additive over the repo's own ignore files, repeatable, not
 * persisted (fingerprint only), and must refuse to run against a path that
 * does not exist — a typo that silently ignored nothing is the worst failure
 * mode for a filter. The starter is created only by an explicit build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { probeDrift, isClean } from "../src/graph/fingerprint.js";
import type { GraphV1 } from "../src/graph/types.js";

const KEEP = "export function keep(): number {\n  return 1;\n}\n";
const SKIP = "export function skipme(): number {\n  return 2;\n}\n";

function gitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-cli-ignore-"));
  writeFileSync(join(d, "keep.ts"), KEEP);
  writeFileSync(join(d, "skip.ts"), SKIP);
  execFileSync("git", ["init", "-q"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  execFileSync("git", [
    "-c", "user.name=Graft Tests",
    "-c", "user.email=graft-tests@example.invalid",
    "commit", "-qm", "initial",
  ], { cwd: d, stdio: "ignore" });
  return d;
}

function runCli(d: string, args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, d], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

const graphOf = (d: string): GraphV1 | null => readGraph(wiringPath(join(d, "graft")));

test("--ignore-file excludes its listed files, additively with .graftignore", () => {
  const d = gitRepo();
  try {
    writeFileSync(join(d, "skip.ts"), SKIP);
    writeFileSync(join(d, "extra.ignore"), "keep.ts\n");
    runCli(d, ["build", "--ignore-file", "extra.ignore"]);
    const g = graphOf(d);
    assert.ok(g!.nodes.some((n) => n.id === "skip.ts#skipme"), "skip.ts is not listed in extra.ignore");
    assert.ok(!g!.nodes.some((n) => n.id === "keep.ts#keep"), "keep.ts is listed in extra.ignore");

    // A second file re-includes with a negation, additively over the first.
    writeFileSync(join(d, "re.include"), "!keep.ts\n");
    runCli(d, ["build", "--ignore-file", "extra.ignore", "--ignore-file", "re.include"]);
    const g2 = graphOf(d);
    assert.ok(g2!.nodes.some((n) => n.id === "keep.ts#keep"), "the later negation re-includes keep.ts");
    assert.ok(g2!.nodes.some((n) => n.id === "skip.ts#skipme"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("--ignore-file with a missing path exits non-zero and names it", () => {
  const d = gitRepo();
  try {
    const r = runCli(d, ["build", "--ignore-file", "nope.ignore"]);
    assert.notEqual(r.status, 0, `expected failure, got 0\nstdout: ${r.stdout}`);
    assert.match(r.stderr, /nope\.ignore/);
    assert.match(r.stderr, /--ignore-file/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the starter .graftignore is created on a first build, not over an existing one", () => {
  const d = gitRepo();
  try {
    const gi = join(d, ".graftignore");
    assert.equal(existsSync(gi), false, "no .graftignore before the build");
    runCli(d, ["build"]);
    assert.ok(existsSync(gi), "a build must create the starter");
    assert.match(readFileSync(gi, "utf8"), /graft's ignore file/);

    // A second build must not clobber a user-edited file.
    writeFileSync(gi, "skip.ts\n");
    runCli(d, ["build"]);
    assert.equal(readFileSync(gi, "utf8"), "skip.ts\n", "an existing .graftignore must be left alone");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("--no-graftignore skips both creation and reading", () => {
  const d = gitRepo();
  try {
    writeFileSync(join(d, ".graftignore"), "skip.ts\n");
    const gi = join(d, ".graftignore");
    runCli(d, ["build", "--no-graftignore"]);
    assert.ok(graphOf(d)!.nodes.some((n) => n.id === "skip.ts#skipme"), "the existing file must be ignored");
    // And a fresh repo with no file must not have one created.
    const d2 = gitRepo();
    try {
      runCli(d2, ["build", "--no-graftignore"]);
      assert.equal(existsSync(join(d2, ".graftignore")), false, "no starter with the flag");
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("--ignore-file is recorded in the fingerprint, and the no-flag probe stays clean", () => {
  const d = gitRepo();
  try {
    writeFileSync(join(d, "extra.ignore"), "skip.ts\n");
    runCli(d, ["build", "--ignore-file", "extra.ignore"]);
    assert.ok(!graphOf(d)!.nodes.some((n) => n.id === "skip.ts#skipme"));
    // The probe (the hooks/refresh path) never sees the flag, but must still
    // enumerate the filtered set from the fingerprint: no phantom drift.
    const drift = probeDrift(d, join(d, "graft"));
    assert.ok(drift && isClean(drift), `probe must be clean, got ${JSON.stringify(drift)}`);
    // A fresh no-flag build is a fresh intent (the flag is not persisted), so
    // it widens again — the same contract as --only-dir. The exclusion then
    // disappears from the fingerprint with the widening.
    runCli(d, ["build"]);
    assert.ok(graphOf(d)!.nodes.some((n) => n.id === "skip.ts#skipme"), "a no-flag build re-widens, as with --only-dir");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
