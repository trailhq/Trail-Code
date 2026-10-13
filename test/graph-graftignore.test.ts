/**
 * `.graftignore` end-to-end: a repo's own ignore file excludes TRACKED files
 * from the graph, and `graft check` stays clean (the filter runs on the
 * enumerated set, after git — tracked files are still what makes this
 * different from `.gitignore`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { probeDrift, isClean } from "../src/graph/fingerprint.js";
import type { GraphV1 } from "../src/graph/types.js";

const KEEP = "export function keep(): number {\n  return 1;\n}\n";
const SKIP = "export function skipme(): number {\n  return 2;\n}\n";

function gitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-graftignore-"));
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

function runCli(d: string, args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, d], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) as string;
}

function runCliWithEnv(d: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, d], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }) as string;
}

const graphOf = (d: string): GraphV1 | null => readGraph(wiringPath(join(d, "graft")));

test("a tracked file listed in .graftignore is excluded; check and the drift probe stay clean", () => {
  const d = gitRepo();
  try {
    // Baseline: without any ignore file both files are indexed.
    runCli(d, ["build"]);
    const full = graphOf(d);
    assert.ok(full!.nodes.some((n) => n.id === "skip.ts#skipme"), "skip.ts indexed by default");

    writeFileSync(join(d, ".graftignore"), "skip.ts\n");
    runCli(d, ["build"]);
    const g = graphOf(d);
    assert.ok(g!.nodes.some((n) => n.id === "keep.ts#keep"), "keep.ts is indexed");
    assert.ok(!g!.nodes.some((n) => n.path === "skip.ts"), "skip.ts must be excluded from the graph");
    // The file is still tracked — that is the whole point of an ignore file
    // graft applies, as opposed to .gitignore.
    const status = execFileSync("git", ["status", "--porcelain", "skip.ts"], { cwd: d, encoding: "utf8" });
    assert.equal(status.trim(), "", "skip.ts must remain a clean tracked file");

    // `graft check` diffs the same filtered set, so the exclusion is not drift.
    runCli(d, ["check"]);
    // And the pre-query probe (which never sees CLI flags) agrees too.
    const drift = probeDrift(d, join(d, "graft"));
    assert.ok(drift && isClean(drift), `probe must report clean, got ${JSON.stringify(drift)}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a negation in .graftignore re-includes a file", () => {
  const d = gitRepo();
  try {
    writeFileSync(join(d, ".graftignore"), "*.ts\n!skip.ts\n");
    runCli(d, ["build"]);
    const g = graphOf(d);
    assert.ok(g!.nodes.some((n) => n.id === "skip.ts#skipme"), "negated file must be indexed");
    assert.ok(!g!.nodes.some((n) => n.id === "keep.ts#keep"), "non-negated *.ts must be excluded");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("GRAFT_NO_GRAFTIGNORE=1 turns the file off", () => {
  const d = gitRepo();
  try {
    writeFileSync(join(d, ".graftignore"), "skip.ts\n");
    runCliWithEnv(d, ["build"], { GRAFT_NO_GRAFTIGNORE: "1" });
    assert.ok(graphOf(d)!.nodes.some((n) => n.id === "skip.ts#skipme"), "the file must be indexed with the flag off");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a directory rule excludes the directory and its contents", () => {
  const d = gitRepo();
  try {
    writeFileSync(join(d, "skip.ts"), ""); // no supported extension left
    mkdirSync(join(d, "gen"), { recursive: true });
    writeFileSync(join(d, "gen", "auto.ts"), SKIP);
    writeFileSync(join(d, ".graftignore"), "gen/\n");
    execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
    execFileSync("git", [
      "-c", "user.name=Graft Tests",
      "-c", "user.email=graft-tests@example.invalid",
      "commit", "-qm", "add gen",
    ], { cwd: d, stdio: "ignore" });
    runCli(d, ["build"]);
    const g = graphOf(d);
    assert.ok(!g!.nodes.some((n) => n.path.startsWith("gen/")), "gen/ must be excluded wholesale");
    assert.ok(g!.nodes.some((n) => n.id === "keep.ts#keep"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test(".cursorignore is respected only when Cursor is a wired host", () => {
  const d = gitRepo();
  try {
    writeFileSync(join(d, ".cursorignore"), "skip.ts\n");
    // No wiring stamp: the file is inert.
    runCli(d, ["build"]);
    assert.ok(graphOf(d)!.nodes.some((n) => n.id === "skip.ts#skipme"), "cursor file inert without wiring");

    // Wire cursor into this repo's stamp (what `graft init --agents cursor` records).
    const stamp = join(d, "graft", ".cache", "wiring-stamp.json");
    writeFileSync(stamp, JSON.stringify({ version: "test", hosts: ["cursor"], opts: {}, at: "now" }));
    runCli(d, ["build"]);
    assert.ok(!graphOf(d)!.nodes.some((n) => n.path === "skip.ts"), "cursor file active with wiring");
    assert.ok(existsSync(join(d, ".cursorignore")));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a non-git repo is filtered by the same rules on the filesystem walk", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-graftignore-nogit-"));
  try {
    writeFileSync(join(d, "keep.ts"), KEEP);
    writeFileSync(join(d, "skip.ts"), SKIP);
    writeFileSync(join(d, ".graftignore"), "skip.ts\n");
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "build", d], { stdio: "pipe" });
    const g = graphOf(d);
    assert.ok(g!.nodes.some((n) => n.id === "keep.ts#keep"));
    assert.ok(!g!.nodes.some((n) => n.path === "skip.ts"), "filesystem walk must honor .graftignore too");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
