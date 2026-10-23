/**
 * `graft check --json` read through a pipe, the way post-edit's stale count and
 * any `graft check --json | jq` reads it.
 *
 * A stale graph exits 1. Exiting with `process.exit(1)` straight after
 * `console.log` drops whatever of the JSON is still queued for a pipe, which is
 * everything past the first 64 KiB or so — and `pendingIds` lists every
 * unsummarised node, so any repo of a few thousand symbols built without
 * `--deep` is past that. The reader got truncated JSON, could not parse it, and
 * the statusline showed 0 stale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeEnv, tmpRepo } from "./helpers.js";

function graft(args: string[], home: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "graft.ts"), ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("a stale graph's check --json reaches a pipe whole, with exit status 1", () => {
  const home = mkdtempSync(join(tmpdir(), "graft-check-pipe-"));
  const d = tmpRepo("checkpipe");
  mkdirSync(join(d, "src"), { recursive: true });
  // 12,000 functions over 12 files: the build skips one file that large, and fewer
  // nodes fit the ~200 KB socket buffer spawnSync reads through, hiding the loss.
  const fns = Array.from({ length: 1000 }, (_, i) => `export function fn${i}(): number {\n  return ${i};\n}\n`).join("");
  for (let f = 0; f < 12; f++) writeFileSync(join(d, "src", `m${f}.ts`), fns);
  assert.equal(graft(["build", d], home).status, 0);
  writeFileSync(join(d, "src", "more.ts"), "export function extra(): number {\n  return 1;\n}\n");

  const r = graft(["check", d, "--json"], home);
  assert.equal(r.status, 1, "a stale graph still fails the check");
  const parsed = JSON.parse(r.out); // throws on the truncated output
  assert.ok(r.out.length > 256 * 1024, `the fixture outruns the pipe, or this proves nothing (${r.out.length} bytes)`);
  assert.ok(parsed.graph.added.length > 0, "the new function is reported");
});
