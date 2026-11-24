/**
 * Root guard for the pre-query freshness check (#438).
 *
 * `graft ask` without its repo-root positional anchors the refresh on the cwd.
 * When that root is unrelated to the graph's home, the drift probe reads "every
 * file changed" and the rebuild writes an empty graph over a valid one — with
 * the per-file cards surviving to mask the damage. These tests pin the pure
 * decision layer: the fingerprint records the build's root, the guard refuses to
 * rebuild across roots, and a seeded worktree re-homes its copied fingerprint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  fingerprintPath,
  graphRootGuardNote,
  readFingerprint,
  restampFingerprintRoot,
  sameGraphRoot,
  writeFingerprint,
} from "../src/graph/fingerprint.js";

test("a graph that never recorded a root is not treated as foreign", () => {
  assert.equal(sameGraphRoot(undefined, "/repo"), true);
  assert.equal(graphRootGuardNote(undefined, "/repo"), null);
});

test("the same root matches through trailing slashes and dot segments", () => {
  assert.equal(sameGraphRoot("/repo", "/repo"), true);
  assert.equal(sameGraphRoot("/repo", "/repo/"), true);
  assert.equal(sameGraphRoot("/repo", "/repo/./"), true);
  assert.equal(sameGraphRoot("/repo", "/repo/sub/.."), true);
});

/** The note shows the resolved cwd, which on Windows carries a drive letter
 * and backslashes — the actionable form is the platform-native one. */
const win = process.platform === "win32";

test("a different root is a mismatch and the note names the root to pass", () => {
  assert.equal(sameGraphRoot("/repo-a", "/repo-b"), false);
  const note = graphRootGuardNote("/repo-a", "/repo-b");
  assert.ok(note, "a mismatch must produce a note");
  assert.match(note, /graph was built for \/repo-a/);
  assert.match(note, win ? /not [A-Za-z]:\\repo-b/ : /not \/repo-b/);
  // actionable: the note contains the corrected invocation
  assert.match(note, /graft ask <query> \/repo-a/);
});

test("a mismatch note is normalized through resolve, not raw string equality", () => {
  const note = graphRootGuardNote("/repo-a", "/repo-a/../repo-b");
  assert.ok(note);
  assert.match(note, win ? /not [A-Za-z]:\\repo-b/ : /not .*\/repo-b/);
});

test("writeFingerprint records the root and readFingerprint returns it", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-fp-root-"));
  try {
    const outDir = join(dir, "graft");
    writeFingerprint(outDir, {}, undefined, undefined, resolve(dir));
    const fp = readFingerprint(outDir);
    assert.ok(fp, "the sidecar should be readable");
    assert.equal(fp!.root, resolve(dir));
    assert.equal(sameGraphRoot(fp!.root, dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pre-#438 fingerprint without a root reads as current-format-null via version", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-fp-old-"));
  try {
    const outDir = join(dir, "graft");
    // Simulate the v1 sidecar this change invalidates: no `root` field.
    writeFingerprint(outDir, {}, undefined, undefined, resolve(dir));
    const path = fingerprintPath(outDir);
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.version = 1;
    delete record.root;
    writeFileSync(path, JSON.stringify(record));
    assert.equal(readFingerprint(outDir), null, "a v1 sidecar must force one honest rebuild");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restampFingerprintRoot re-homes a seeded worktree's copied sidecar", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-fp-restamp-"));
  try {
    const outDir = join(dir, "graft");
    writeFingerprint(outDir, {}, undefined, undefined, resolve("/main/checkout"));
    assert.equal(readFingerprint(outDir)!.root, resolve("/main/checkout"));

    restampFingerprintRoot(outDir, resolve("/worktree"));
    const fp = readFingerprint(outDir)!;
    assert.equal(fp.root, resolve("/worktree"));
    assert.equal(sameGraphRoot(fp.root, "/worktree"), true, "the worktree now owns its guard");
    assert.equal(sameGraphRoot(fp.root, "/main/checkout"), false, "and the parent no longer matches");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restampFingerprintRoot is a no-op on a missing cache dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-fp-nocache-"));
  try {
    assert.doesNotThrow(() => restampFingerprintRoot(join(dir, "graft"), "/repo"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A second name for the same directory must not read as a move.
 *
 * macOS symlinks `/tmp` to `/private/tmp`, so a graph built through one name and
 * queried through the other is the same graph. Comparing lexically would refuse
 * to refresh it on every query from then on, which is the failure this guards
 * against. Skipped where the platform refuses to create the link at all (Windows
 * without developer mode), since the decision is otherwise covered above. */
test("a symlinked name for the same directory is not a foreign root", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-fp-link-"));
  const link = join(dir, "link");
  try {
    try {
      // "junction" needs no elevation on Windows; the default "dir" type does.
      symlinkSync(dir, link, win ? "junction" : "dir");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
      return;
    }
    assert.equal(sameGraphRoot(dir, link), true, "one directory, two names");
    assert.equal(graphRootGuardNote(dir, link), null, "so the refresh must not be refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
