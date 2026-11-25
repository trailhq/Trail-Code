/**
 * #323 at the process boundary: a depth-tier grammar that will not load must cost
 * its own language, not the whole CLI.
 *
 * The reported machine is a Windows box with no C toolchain, where
 * `tree-sitter-kotlin` — which ships no prebuilds at all — cannot be built at
 * install time and throws from `require()`. Because extract.ts imported all nine
 * grammars at the top of the module, that killed every command, `--version` and
 * `--help` included, with a `node-gyp-build` stack trace that never says "graft".
 *
 * `break-grammar-preload.cjs` stands in for the missing build so this runs
 * anywhere — including on a runner that HAS a compiler, which is exactly why CI
 * never caught the original.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRepo } from "./helpers.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";

const PRELOAD = fileURLToPath(new URL("./break-grammar-preload.cjs", import.meta.url));

/** graft, run with `pkg` made unloadable. Cwd is the repo root, as it is under `npm test`. */
function graft(args: string[], pkg: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--require", PRELOAD, "--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, GRAFT_TEST_BREAK_GRAMMAR: pkg, DO_NOT_TRACK: "1" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const KOTLIN = `package demo

class Repo(private val name: String) {
    fun describe(): String = "repo $name"
}
`;

test("#323: a grammar that will not load no longer stops the CLI from starting", () => {
  const r = graft(["--version"], "tree-sitter-kotlin");
  assert.equal(r.status, 0, `--version should survive an unloadable grammar\n${r.stderr}`);
  assert.match(r.stdout, /\d+\.\d+\.\d+/);
  // A command that parses nothing has no reason to mention the grammar at all.
  assert.doesNotMatch(r.stderr, /tree-sitter-kotlin/);
});

test("#323: the other languages still index, and the affected one says so once", () => {
  const dir = tmpRepo("grammar-unavailable");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export function greet(): string {\n  return \"hi\";\n}\n");
  // Two, so "once per language" is a claim the test can actually fail on.
  writeFileSync(join(dir, "src", "Repo.kt"), KOTLIN);
  writeFileSync(join(dir, "src", "Other.kt"), KOTLIN.replace("Repo", "Other"));

  const r = graft(["build", dir], "tree-sitter-kotlin");
  assert.equal(r.status, 0, `build should not die with one grammar down\n${r.stderr}`);
  assert.equal(
    r.stderr.match(/tree-sitter-kotlin failed to load/g)?.length,
    1,
    `warned exactly once, whatever the file count\n${r.stderr}`,
  );

  const g = readGraph(wiringPath(contextDirFor(dir)));
  assert.ok(g, "graph built");
  assert.ok(
    g!.nodes.some((n) => n.name === "greet"),
    "TypeScript is indexed as usual — one dead grammar is not nine",
  );
});

test("#323: Kotlin falls back to the breadth tier instead of going unindexed", () => {
  const dir = tmpRepo("grammar-fallback");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "Repo.kt"), KOTLIN);

  const r = graft(["build", dir], "tree-sitter-kotlin");
  assert.equal(r.status, 0, `build should not die with one grammar down\n${r.stderr}`);

  const g = readGraph(wiringPath(contextDirFor(dir)));
  assert.ok(g, "graph built");
  const kt = g!.nodes.filter((n) => n.path.endsWith(".kt") && n.kind !== "file");
  assert.ok(kt.length > 0, "Kotlin is still indexed, at signature depth");
  assert.ok(kt.every((n) => n.origin === "generic"), `…through the breadth tier (${kt.map((n) => n.origin).join(", ")})`);
  assert.ok(kt.some((n) => n.name === "Repo"), `the class is there (got ${kt.map((n) => n.name).join(", ")})`);
});
