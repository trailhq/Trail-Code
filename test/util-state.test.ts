/**
 * Persisted local build configuration.
 *
 * Explicit directory and submodule choices must survive later no-flag builds
 * and the hooks/refresh path, which never sees CLI flags. These tests pin the
 * round-trip and merge contracts independently of the CLI wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfigPath,
  cacheDir,
  patchBuildConfig,
  readBuildConfig,
  readFollowSubmodules,
  readIncludeDirs,
  resolveContextDir,
  writeBuildConfig,
} from "../src/util/state.js";

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "graft-buildconfig-"));
}

test("readBuildConfig returns null when nothing was ever persisted", () => {
  const d = fresh();
  assert.equal(readBuildConfig(d), null);
  assert.equal(readIncludeDirs(d), undefined, "no persisted config -> today's default (no includes)");
  assert.equal(readFollowSubmodules(d), false, "no persisted config -> historical submodule boundary");
});

test("writeBuildConfig + readBuildConfig round-trip includeDirs", () => {
  const d = fresh();
  writeBuildConfig(d, { includeDirs: ["build", "vendor"] });
  assert.deepEqual(readBuildConfig(d), { includeDirs: ["build", "vendor"] });
  assert.equal(buildConfigPath(d), join(d, ".graft", "config.json"));
  assert.equal(existsSync(join(d, "graft", ".cache", "config.json")), false);
  assert.match(readFileSync(join(d, ".gitignore"), "utf8"), /^\/\.graft\/$/m);
});

test("readIncludeDirs turns a persisted list into a Set; an empty persisted list reads as undefined (default behavior)", () => {
  const d = fresh();
  writeBuildConfig(d, { includeDirs: ["build"] });
  assert.deepEqual(readIncludeDirs(d), new Set(["build"]));

  writeBuildConfig(d, { includeDirs: [] });
  assert.equal(readIncludeDirs(d), undefined, "an empty list must read exactly like no list at all");
});

test("followSubmodules round-trips true and explicit false", () => {
  const d = fresh();
  writeBuildConfig(d, { followSubmodules: true });
  assert.equal(readFollowSubmodules(d), true);

  writeBuildConfig(d, { followSubmodules: false });
  assert.deepEqual(readBuildConfig(d), { followSubmodules: false });
  assert.equal(readFollowSubmodules(d), false);
});

test("patchBuildConfig preserves unrelated persisted build choices", () => {
  const d = fresh();
  writeBuildConfig(d, { includeDirs: ["build"] });
  patchBuildConfig(d, { followSubmodules: true });
  assert.deepEqual(readBuildConfig(d), {
    includeDirs: ["build"],
    followSubmodules: true,
  });

  patchBuildConfig(d, { includeDirs: ["vendor"] });
  assert.deepEqual(readBuildConfig(d), {
    includeDirs: ["vendor"],
    followSubmodules: true,
  });

  patchBuildConfig(d, { followSubmodules: false });
  assert.deepEqual(readBuildConfig(d), {
    includeDirs: ["vendor"],
    followSubmodules: false,
  });
});

// ── resolveContextDir / GRAFT_DIR ──────────────────────────────────────────
//
// Everything in this module keyed only by a project dir (stats cache, sync
// lock, session state, the upkeep stamp) resolves its `graft/` subpath
// through resolveContextDir, so hooks/sync-run/statusline honor GRAFT_DIR
// the same way a direct `--dir` CLI call already does via contextDirFor.

function withGraftDir<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.GRAFT_DIR;
  if (value === undefined) delete process.env.GRAFT_DIR; else process.env.GRAFT_DIR = value;
  try { return fn(); }
  finally { if (prev === undefined) delete process.env.GRAFT_DIR; else process.env.GRAFT_DIR = prev; }
}

test("resolveContextDir defaults to <projectDir>/graft when GRAFT_DIR is unset", () => {
  const d = fresh();
  withGraftDir(undefined, () => {
    assert.equal(resolveContextDir(d), join(d, "graft"));
    assert.equal(cacheDir(d), join(d, "graft", ".cache"));
  });
});

test("resolveContextDir resolves a relative GRAFT_DIR against projectDir", () => {
  const d = fresh();
  withGraftDir(".repo-docs/graft", () => {
    assert.equal(resolveContextDir(d), join(d, ".repo-docs", "graft"));
    assert.equal(cacheDir(d), join(d, ".repo-docs", "graft", ".cache"));
  });
});

test("resolveContextDir takes an absolute GRAFT_DIR verbatim", () => {
  const d = fresh();
  const abs = join(tmpdir(), "graft-context-elsewhere");
  withGraftDir(abs, () => {
    assert.equal(resolveContextDir(d), abs);
    assert.equal(cacheDir(d), join(abs, ".cache"));
  });
});

// ── a `graft/` that belongs to something else ──────────────────────────────
//
// `graft` is a project name, not a reserved word. A checkout of a tool called
// graft sitting in someone's repo root used to be resolved as this repo's
// context dir, and every hook write then landed inside it: `.cache/stats.json`,
// `.cache/.sync.lock`, a `.cache/session/` tree. The resolution now adopts the
// default name only when it is free or already a context dir.

/** A directory that is plainly not a context dir: a source checkout's own files. */
function writeForeignDir(d: string): string {
  const foreign = join(d, "graft");
  mkdirSync(join(foreign, "src"), { recursive: true });
  writeFileSync(join(foreign, "package.json"), JSON.stringify({ name: "graft" }));
  writeFileSync(join(foreign, "src", "cli.ts"), "export const cli = 1;\n");
  return foreign;
}

test("resolveContextDir does not adopt an existing `graft/` that is not a context dir", () => {
  const d = fresh();
  const foreign = writeForeignDir(d);
  withGraftDir(undefined, () => {
    const resolved = resolveContextDir(d);
    assert.notEqual(resolved, foreign, "an unrelated directory named graft is never adopted");
    assert.equal(resolved, join(d, "graft-context"));
    // The load-bearing consequence: nothing is written into the foreign tree.
    // cacheDir/patchStats/acquireLock all hang off this answer.
    assert.equal(cacheDir(d), join(d, "graft-context", ".cache"));
  });
});

test("resolveContextDir still adopts `graft/` once it holds a context marker", () => {
  const d = fresh();
  const built = join(d, "graft");
  mkdirSync(join(built, ".graph"), { recursive: true });
  writeFileSync(join(built, ".graph", "wiring.json"), JSON.stringify({ meta: {}, nodes: [], edges: [] }));
  withGraftDir(undefined, () => {
    assert.equal(resolveContextDir(d), built, "a built repo keeps the name it was built under");
    assert.equal(cacheDir(d), join(built, ".cache"));
  });
});

test("resolveContextDir adopts `graft/` holding a workspace parent's children index", () => {
  const d = fresh();
  // A workspace parent is indexed by workspace.json, not a wiring graph — both
  // are markers, or a workspace's own context dir would be written aside.
  mkdirSync(join(d, "graft"), { recursive: true });
  writeFileSync(join(d, "graft", "workspace.json"), JSON.stringify({ version: 1, children: ["a", "b"] }));
  withGraftDir(undefined, () => {
    assert.equal(resolveContextDir(d), join(d, "graft"));
  });
});

test("resolution is monotone: a context dir holding only graft's own cache is still ours", () => {
  const d = fresh();
  mkdirSync(join(d, "graft"), { recursive: true });
  writeFileSync(join(d, "graft", "package.json"), JSON.stringify({ name: "graft" }));
  withGraftDir(undefined, () => {
    // Before graft has written anything, the foreign files win the name.
    assert.equal(resolveContextDir(d), join(d, "graft-context"));
    // Now graft creates its cache — which is the first thing any hook write
    // makes. The answer must not move: a resolution that changed under a live
    // writer would send the second read of a stats file to a different
    // directory than the first write, losing the write.
    mkdirSync(join(d, "graft", ".cache"), { recursive: true });
    assert.equal(resolveContextDir(d), join(d, "graft"), "graft's own cache is a marker, so the name sticks");
    assert.equal(resolveContextDir(d), join(d, "graft"), "and stays put on every later call");
  });
});

test("an explicit GRAFT_DIR is never second-guessed, occupied or not", () => {
  const d = fresh();
  writeForeignDir(d);
  withGraftDir("graft", () => {
    assert.equal(resolveContextDir(d), join(d, "graft"), "naming a directory is a decision, not a suggestion");
  });
});
