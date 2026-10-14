import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import { fingerprintPath } from "../src/graph/fingerprint.js";
import { contextDirFor } from "../src/context/node-file.js";
import { ask, skeleton } from "../src/ask/ask.js";
import { MAX_FILE_BYTES } from "../src/ingest/fs.js";
import { tmpRepo } from "./helpers.js";

test("size skips follow the build's source, output and directory selection (#370)", async () => {
  const root = tmpRepo("size-selection");
  try {
    const output = join(root, "keep/output");
    for (const dir of ["keep", "excluded", "keep/output"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "keep/ok.ts"), "export const keep = 1;\n");
    for (const path of ["keep/big.ts", "excluded/big.ts", "keep/big.bin", "keep/output/big.ts"]) {
      writeFileSync(join(root, path), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    }
    const built = await buildGraph(root, { onlyDirs: ["keep"], contextDir: output });
    const expected = [{ path: "keep/big.ts", bytes: MAX_FILE_BYTES + 1, reason: "size" }];
    assert.deepEqual(built.skipped, expected);
    assert.equal(built.files, 1);
    assert.deepEqual(readGraph(wiringPath(output))?.meta.skipped, expected);
    for (const path of ["excluded/new.ts", "keep/new.bin", "keep/output/new.ts"]) {
      writeFileSync(join(root, path), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    }
    assert.equal((await ensureFreshGraph(root, { contextDir: output })).refreshed, false,
      "excluded oversized files must not create freshness drift");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("query refresh notices oversized additions, resize, deletion and cap crossings (#370)", async () => {
  const root = tmpRepo("size-refresh");
  try {
    const big = join(root, "big.ts");
    writeFileSync(join(root, "ok.ts"), "export const keep = 1;\n");
    await buildGraph(root);
    writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    const added = await ensureFreshGraph(root);
    assert.equal(added.refreshed, true, "a new oversized source must update warnings");
    assert.deepEqual(added.drift?.added, ["big.ts"]);
    assert.match(skeleton(root, "big.ts").note ?? "", /skipped big\.ts/);
    assert.match(ask(root, "nonexistentSizeFixtureSymbol").note ?? "", /skipped big\.ts/);
    assert.equal((await ensureFreshGraph(root)).refreshed, false);

    writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 100, 0x61));
    const resized = await ensureFreshGraph(root);
    assert.equal(resized.refreshed, true);
    assert.deepEqual(resized.drift?.changed, ["big.ts"]);
    assert.equal(readGraph(wiringPath(contextDirFor(root)))?.meta.skipped?.[0].bytes, MAX_FILE_BYTES + 100);
    writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 100, 0x62));
    assert.equal((await ensureFreshGraph(root)).refreshed, false,
      "same-size oversized content does not change the skip warning");

    writeFileSync(big, "export function formerlyOversized() { return 1; }\n");
    const shrank = await ensureFreshGraph(root);
    assert.equal(shrank.refreshed, true);
    assert.deepEqual(shrank.drift, { changed: ["big.ts"], added: [], removed: [] });
    assert.equal(readGraph(wiringPath(contextDirFor(root)))?.meta.skipped, undefined);
    assert.ok(skeleton(root, "big.ts").entries.some((e) => e.name === "formerlyOversized"));

    writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    const grew = await ensureFreshGraph(root);
    assert.equal(grew.refreshed, true);
    assert.deepEqual(grew.drift, { changed: ["big.ts"], added: [], removed: [] });
    rmSync(big);
    const deleted = await ensureFreshGraph(root);
    assert.equal(deleted.refreshed, true);
    assert.deepEqual(deleted.drift?.removed, ["big.ts"]);
    assert.equal(readGraph(wiringPath(contextDirFor(root)))?.meta.skipped, undefined);
    assert.doesNotMatch(ask(root, "nonexistentSizeFixtureSymbol").note ?? "", /skipped big\.ts/);
    assert.equal((await ensureFreshGraph(root)).refreshed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fingerprint predating size records refreshes once to learn the omissions (#370)", async () => {
  const root = tmpRepo("size-legacy-fingerprint");
  try {
    writeFileSync(join(root, "ok.ts"), "export const keep = 1;\n");
    writeFileSync(join(root, "big.ts"), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    await buildGraph(root);
    const path = fingerprintPath(contextDirFor(root));
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.skipped;
    writeFileSync(path, JSON.stringify(legacy));
    assert.equal((await ensureFreshGraph(root)).refreshed, true);
    assert.equal((await ensureFreshGraph(root)).refreshed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skeleton prefers an exact skipped path and explains ambiguous basenames (#370)", async () => {
  const root = tmpRepo("size-skeleton-paths");
  try {
    for (const dir of ["a", "b"]) mkdirSync(join(root, dir));
    writeFileSync(join(root, "ok.ts"), "export const keep = 1;\n");
    for (const path of ["a/big.ts", "b/big.ts", "big.ts"]) {
      writeFileSync(join(root, path), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    }
    await buildGraph(root);
    assert.equal(skeleton(root, "big.ts").file, "big.ts");
    assert.equal(skeleton(root, "a/big.ts").file, "a/big.ts");
    assert.equal(skeleton(root, "a\\big.ts").file, "a/big.ts");
    rmSync(join(root, "big.ts"));
    await buildGraph(root);
    const ambiguous = skeleton(root, "big.ts");
    assert.equal(ambiguous.file, "big.ts");
    assert.match(ambiguous.note ?? "", /ambiguous — matches/);
    assert.match(ambiguous.note ?? "", /skipped a\/big\.ts/);
    assert.match(ambiguous.note ?? "", /skipped b\/big\.ts/);
    assert.match(ambiguous.note ?? "", /use a repo-relative path/);
    writeFileSync(join(root, "a/big.ts"), "export function nowIndexed() { return 1; }\n");
    await buildGraph(root);
    assert.match(skeleton(root, "big.ts").note ?? "", /ambiguous — matches/);
    assert.ok(skeleton(root, "a/big.ts").entries.some((e) => e.name === "nowIndexed"));
    writeFileSync(join(root, "big.ts"), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    await buildGraph(root);
    assert.match(skeleton(root, "big.ts").note ?? "", /skipped big\.ts:/);
    writeFileSync(join(root, "big.ts"), "// comments only, no definitions\n");
    await buildGraph(root);
    assert.equal(skeleton(root, "big.ts").note, "no definitions indexed for this file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
