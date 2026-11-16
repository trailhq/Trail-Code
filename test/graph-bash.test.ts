import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { extractGeneric, genericLangOf, isWarm, warmGenericGrammars } from "../src/graph/generic.js";
import { unsupportedExtensions } from "../src/graph/source-files.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

const BASH = `#!/usr/bin/env bash
greet() {
  printf '%s\\n' "hello"
}

function main {
  greet
}
`;

test("Bash extensions load the bundled grammar and extract both function syntaxes", async () => {
  for (const file of ["setup.sh", "library.bash", "SETUP.SH"]) {
    assert.equal(genericLangOf(file)?.name, "bash");
  }
  assert.deepEqual(unsupportedExtensions([".sh", ".bash", "SH"]), []);
  await warmGenericGrammars(["bash"]);
  assert.ok(isWarm("bash"), "the bundled Bash grammar loads");
  const { nodes } = extractGeneric("setup.sh", BASH, "bash");
  assert.deepEqual(
    nodes.filter((node) => node.kind !== "file").map((node) => [node.name, node.kind, node.span]),
    [["greet", "function", "L2-L4"], ["main", "function", "L6-L8"]],
  );
});

test("buildGraph indexes Bash files and checkGraph reports them in sync", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-bash-"));
  try {
    writeFileSync(join(dir, "setup.sh"), BASH);
    writeFileSync(join(dir, "library.bash"), "helper() { echo ok; }\n");
    writeFileSync(join(dir, "extensionless"), BASH);

    const result = await buildGraph(dir, { reuse: false });
    assert.deepEqual(result.languages, ["bash"]);
    assert.deepEqual(result.errors, []);
    const graph = readGraph(wiringPath(result.contextDir));
    assert.ok(graph);
    assert.deepEqual(
      graph.nodes.filter((node) => node.kind === "file").map((node) => node.path).sort(),
      ["library.bash", "setup.sh"],
    );
    assert.deepEqual(
      graph.nodes.filter((node) => node.kind === "function").map((node) => node.name).sort(),
      ["greet", "helper", "main"],
    );
    assert.equal((await checkGraph(dir)).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
