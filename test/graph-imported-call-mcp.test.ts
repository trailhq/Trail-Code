import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { callTool } from "../src/mcp/tools.js";

// #330, through the tool an agent actually calls.
//
// The unit tests beside this file check extraction and resolution separately.
// This runs the pair end to end on real source files and a cold `graft build`:
// file-type dispatch, extraction, module resolution, graph persistence, and the
// `graft_trace_calls` handler's own rendering. Suggested by @0xSamuraiDev while
// validating this branch.
//
// Each repo carries a collision module exporting the SAME name and arity as the
// imported one. That is the half that made #330 hard to see: with only one
// candidate, a resolver that ignores the import specifier still lands on the
// right symbol by luck.

const EXTS = ["js", "ts", "tsx"] as const;

const SOURCES: Record<(typeof EXTS)[number], { util: string; collision: string; caller: string }> = {
  js: {
    util: "export function withinLimit(n) {\n  return n < 10;\n}\n",
    collision: "export function withinLimit(n) {\n  return n < 99;\n}\n",
    caller:
      "import { withinLimit as ok } from './util.js';\n\nexport function checkout(n) {\n  return ok(n);\n}\n",
  },
  ts: {
    util: "export function withinLimit(n: number): boolean {\n  return n < 10;\n}\n",
    collision: "export function withinLimit(n: number): boolean {\n  return n < 99;\n}\n",
    caller:
      "import { withinLimit as ok } from './util';\n\nexport function checkout(n: number): boolean {\n  return ok(n);\n}\n",
  },
  tsx: {
    util: "export function withinLimit(n: number): boolean {\n  return n < 10;\n}\n",
    collision: "export function withinLimit(n: number): boolean {\n  return n < 99;\n}\n",
    caller:
      "import { withinLimit as ok } from './util';\n\nexport function Checkout(n: number) {\n  return <p>{ok(n) ? 'ok' : 'no'}</p>;\n}\n",
  },
};

function builtAliasRepo(ext: (typeof EXTS)[number]): { dir: string; imported: string; collision: string } {
  const dir = mkdtempSync(join(tmpdir(), `graft-imported-call-${ext}-`));
  mkdirSync(join(dir, "src"), { recursive: true });
  const utilExt = ext === "tsx" ? "ts" : ext;
  const src = SOURCES[ext];
  writeFileSync(join(dir, "src", `util.${utilExt}`), src.util);
  writeFileSync(join(dir, "src", `elsewhere.${utilExt}`), src.collision);
  writeFileSync(join(dir, "src", `checkout.${ext}`), src.caller);
  execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "build", dir], { stdio: "pipe" });
  return { dir, imported: `src/util.${utilExt}`, collision: `src/elsewhere.${utilExt}` };
}

for (const ext of EXTS) {
  test(`graft_trace_calls names the caller through an aliased named import (.${ext})`, async () => {
    const { dir, imported, collision } = builtAliasRepo(ext);
    const caller = ext === "tsx" ? "Checkout" : "checkout";

    const found = await callTool(dir, "graft_trace_calls", { symbol: "withinLimit", in: imported });
    assert.equal(found.isError, false, found.text);
    assert.match(found.text, new RegExp(caller), found.text);

    // The same-named export in the unrelated module must not collect the edge.
    const unrelated = await callTool(dir, "graft_trace_calls", { symbol: "withinLimit", in: collision });
    assert.equal(unrelated.isError, false, unrelated.text);
    assert.doesNotMatch(unrelated.text, new RegExp(caller), unrelated.text);
  });
}
