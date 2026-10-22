/**
 * Owner-only files and folders for what Trail keeps for upload (D85): a
 * folder given as private that is a link is left alone, since a chmod would
 * follow it and tighten what it points to, maybe a folder that isn't
 * Trail's; a real folder is tightened through a handle that refuses a link.
 * Made-up folders under the system temp dir only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPrivateFile, ensurePrivateDir, writePrivateFile } from "../src/util/private-file.js";

/** A folder outside the home at 0755, and a link to it inside the home. */
function linkedFolder(t: { after(fn: () => void): void }): { target: string; link: string } {
  const home = mkdtempSync(join(tmpdir(), "private-link-home-"));
  const target = mkdtempSync(join(tmpdir(), "private-link-target-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  chmodSync(target, 0o755);
  const link = join(home, "outbox");
  symlinkSync(target, link);
  return { target, link };
}

test("a link given as a private folder is left alone: its target keeps its mode", (t) => {
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  const { target, link } = linkedFolder(t);
  ensurePrivateDir(link);
  assert.equal(statSync(target).mode & 0o777, 0o755, "the folder the link points to is not tightened");
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
});

test("writing a private file into a linked folder does not tighten the link's target", (t) => {
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  const { target, link } = linkedFolder(t);
  appendPrivateFile(join(link, "a.jsonl"), '{"n":1}\n');
  writePrivateFile(join(link, "b.json"), "{}");
  assert.equal(statSync(target).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(target, "a.jsonl"), "utf8"), '{"n":1}\n');
  assert.equal(statSync(join(target, "b.json")).mode & 0o777, 0o600, "the file itself is still owner-only");
});

test("a real folder at 0755 is tightened to 0700, and a missing one is made at 0700", (t) => {
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  const dir = mkdtempSync(join(tmpdir(), "private-real-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o755);
  ensurePrivateDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  writePrivateFile(join(dir, "new", "c.json"), "{}");
  assert.equal(statSync(join(dir, "new")).mode & 0o777, 0o700);
});
