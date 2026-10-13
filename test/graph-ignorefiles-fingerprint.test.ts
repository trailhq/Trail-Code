/**
 * The `--ignore-file` set must survive the build into the fingerprint, and the
 * three places that never see a CLI flag — the drift probe, `graft check`, and
 * the pre-query auto-rebuild — must all re-apply it. Otherwise an explicit
 * ignore file would read as permanent drift on every query and the auto-
 * rebuild would silently re-include the excluded files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { isClean, probeDrift, readFingerprint } from "../src/graph/fingerprint.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const KEEP = "export function keep(): number {\n  return 1;\n}\n";
const SKIP = "export function skipme(): number {\n  return 2;\n}\n";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-ignorefiles-fp-"));
  writeFileSync(join(d, "keep.ts"), KEEP);
  writeFileSync(join(d, "skip.ts"), SKIP);
  writeFileSync(join(d, "extra.ignore"), "skip.ts\nignored*.ts\n");
  return d;
}

const outOf = (d: string): string => join(d, "graft");
const graphOf = (d: string): GraphV1 => readGraph(wiringPath(outOf(d))) as GraphV1;
const hasNode = (d: string, id: string): boolean => graphOf(d).nodes.some((n) => n.id === id);

test("the explicit ignore list is recorded in the fingerprint and the probe re-applies it", async () => {
  const d = repo();
  try {
    await buildGraph(d, { ignoreFiles: ["extra.ignore"] });
    const fp = readFingerprint(outOf(d));
    assert.deepEqual(fp?.ignoreFiles, ["extra.ignore"], "fingerprint must record the explicit list");

    assert.ok(hasNode(d, "keep.ts#keep"));
    assert.ok(!hasNode(d, "skip.ts#skipme"), "skip.ts must be excluded");

    // The probe (which never sees CLI flags) must enumerate the same filtered
    // set: no phantom drift from the excluded file.
    const clean = probeDrift(d, outOf(d));
    assert.ok(clean && isClean(clean), `probe must be clean, got ${JSON.stringify(clean)}`);

    // A brand-new file the ignore set covers must not read as "added" either.
    writeFileSync(join(d, "ignored2.ts"), SKIP);
    const clean2 = probeDrift(d, outOf(d));
    assert.ok(clean2 && isClean(clean2), `new ignored file must not be drift, got ${JSON.stringify(clean2)}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("checkGraph diffs the fingerprint's ignore set (no permanent added/removed drift)", async () => {
  const d = repo();
  try {
    await buildGraph(d, { ignoreFiles: ["extra.ignore"] });
    const r = await checkGraph(d);
    assert.equal(r.missing, false);
    assert.ok(r.ok, `check must be clean, got ${JSON.stringify({ added: r.added, removed: r.removed, changed: r.changed })}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the pre-query auto-rebuild re-applies the fingerprint's ignore set", async () => {
  const d = repo();
  try {
    await buildGraph(d, { ignoreFiles: ["extra.ignore"] });
    assert.ok(!hasNode(d, "skip.ts#skipme"));

    // Edit a non-ignored file: the probe reports drift, the refresh rebuilds,
    // and the rebuild must keep honoring the recorded ignore list.
    writeFileSync(join(d, "keep.ts"), `${KEEP}export const Y = 1;\n`);
    const r = await ensureFreshGraph(d);
    assert.equal(r.refreshed, true, "the refresh must rebuild after the edit");
    assert.ok(hasNode(d, "keep.ts#keep"), "the edited file is still indexed");
    assert.ok(!hasNode(d, "skip.ts#skipme"), "the auto-rebuild must not re-include skip.ts");

    // And it must now be clean again.
    const clean = probeDrift(d, outOf(d));
    assert.ok(clean && isClean(clean), `probe must be clean after refresh, got ${JSON.stringify(clean)}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("no ignoreFiles in the build → none in the fingerprint (absent, not empty)", async () => {
  const d = repo();
  try {
    await buildGraph(d);
    const fp = readFingerprint(outOf(d));
    assert.equal(fp?.ignoreFiles, undefined, "no flag, no record");
    assert.ok(hasNode(d, "skip.ts#skipme"), "everything is indexed by default");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
