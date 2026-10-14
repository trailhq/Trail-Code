import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_FILE_BYTES } from "../src/ingest/fs.js";
import { tmpRepo } from "./helpers.js";

function cli(args: string[]): string {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, DO_NOT_TRACK: "1", CI: "1" },
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return `${result.stdout}${result.stderr}`;
}

test("build and every query CLI surface explain a source skipped for size (#370)", () => {
  const root = tmpRepo("cli-size");
  try {
    const source = "export function exactlyAtCap() { return 1; }\n//";
    writeFileSync(join(root, "exact.ts"), source + "x".repeat(MAX_FILE_BYTES - Buffer.byteLength(source)));
    writeFileSync(join(root, "big.ts"), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    const built = cli(["build", root]);
    assert.match(built, /skipped big\.ts: 1\.000001 MB > 1 MB cap/);
    assert.match(built, /parsed: 1 of 2 files .*1 skipped: size/);
    assert.doesNotMatch(built, /skipped exact\.ts/);
    assert.match(cli(["skeleton", "exact.ts", root]), /exactlyAtCap/);
    for (const args of [["ask", "nonexistentSizeFixtureSymbol"], ["grep", "nonexistentSizeFixtureSymbol"], ["skeleton", "big.ts"]]) {
      assert.match(cli([...args, root]), /skipped big\.ts: .* > 1 MB cap/);
      const result = JSON.parse(cli([...args, root, "--json"]));
      if (args[0] === "skeleton") assert.match(result.note, /skipped big\.ts/);
      else assert.deepEqual(result.skipped, [{ path: "big.ts", bytes: MAX_FILE_BYTES + 1, reason: "size" }]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
