import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function withGraph(
  files: Record<string, string>,
  check: (graph: GraphV1) => void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "graft-ts-paths-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const abs = join(root, ...path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    const result = await buildGraph(root, { graphOnly: true, reuse: false });
    const graph = readGraph(result.graphPath);
    assert.ok(graph, "buildGraph writes a readable graph");
    check(graph);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function callTarget(graph: GraphV1, source: string): string | undefined {
  return graph.edges.find((edge) => edge.relation === "calls" && edge.source === source)?.target;
}

test("buildGraph resolves a wildcard named import through a directory index and records its caller", async () => {
  await withGraph({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@core/*": ["./core/*"] } } }),
    "core/dates/index.ts": "export function addDays(day: number): number { return day + 1; }\n",
    "src/caller.ts": [
      'import { addDays } from "@core/dates";',
      "export function schedule(day: number): number { return addDays(day); }",
    ].join("\n"),
  }, (graph) => {
    assert.ok(graph.edges.some((edge) => edge.relation === "imports" && edge.source === "src/caller.ts" && edge.target === "core/dates/index.ts"));
    assert.equal(callTarget(graph, "src/caller.ts#schedule"), "core/dates/index.ts#addDays");
    assert.ok(graph.edges.some((edge) => edge.relation === "calls" && edge.target === "core/dates/index.ts#addDays"),
      "the incoming calls edge is available to graft callers-style queries");
  });
});

test("exact and prefix-suffix path patterns resolve to their declared files", async () => {
  await withGraph({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: {
      "@exact": ["./src/exact"],
      "@pkg/*-generated": ["./src/*-generated"],
    } } }),
    "src/exact.ts": "export function exactTarget(): number { return 1; }\n",
    "src/middle-generated.ts": "export function suffixTarget(): number { return 2; }\n",
    "src/caller.ts": [
      'import { exactTarget } from "@exact";',
      'import { suffixTarget } from "@pkg/middle-generated";',
      "export function runExact(): number { return exactTarget(); }",
      "export function runSuffix(): number { return suffixTarget(); }",
    ].join("\n"),
  }, (graph) => {
    assert.equal(callTarget(graph, "src/caller.ts#runExact"), "src/exact.ts#exactTarget");
    assert.equal(callTarget(graph, "src/caller.ts#runSuffix"), "src/middle-generated.ts#suffixTarget");
  });
});

test("the longest matching prefix wins for overlapping patterns", async () => {
  await withGraph({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: {
      "@*": ["./short/*"],
      "@core/*": ["./long/*"],
    } } }),
    "short/dates.ts": "export function read(): number { return 1; }\n",
    "long/dates.ts": "export function read(): number { return 2; }\n",
    "src/caller.ts": 'import { read } from "@core/dates"; export function run(): number { return read(); }\n',
  }, (graph) => {
    assert.equal(callTarget(graph, "src/caller.ts#run"), "long/dates.ts#read");
  });
});

test("baseUrl resolves an existing bare path and leaves an unknown package external", async () => {
  await withGraph({
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
    "src/core/dates.ts": "export function schedule(): number { return 1; }\n",
    "src/vendor/react.ts": "export function useState(): number { return 0; }\n",
    "src/caller.ts": [
      'import { schedule } from "core/dates";',
      'import { useState } from "react";',
      "export function local(): number { return schedule(); }",
      "export function external(): number { return useState(); }",
    ].join("\n"),
  }, (graph) => {
    assert.equal(callTarget(graph, "src/caller.ts#local"), "src/core/dates.ts#schedule");
    assert.ok(graph.edges.some((edge) => edge.relation === "imports" && edge.source === "src/caller.ts" && edge.target === "react"));
    assert.equal(callTarget(graph, "src/caller.ts#external"), undefined);
  });
});

test("paths without baseUrl resolve from the config directory", async () => {
  await withGraph({
    "backend/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["./lib/*"] } } }),
    "backend/lib/math.ts": "export function add(): number { return 1; }\n",
    "backend/src/caller.ts": 'import { add } from "@lib/math"; export function run(): number { return add(); }\n',
  }, (graph) => {
    assert.equal(callTarget(graph, "backend/src/caller.ts#run"), "backend/lib/math.ts#add");
  });
});

test("extends chains, arrays, JSONC, inherited baseUrl, and child paths replacement resolve together", async () => {
  await withGraph({
    "configs/base.json": `{
      // Base paths and baseUrl both belong to this config.
      "compilerOptions": { "baseUrl": "../src", "paths": { "@old/*": ["old/*",], }, },
    }`,
    "configs/overlay.json": JSON.stringify({ compilerOptions: { paths: { "@overlay/*": ["overlay/*"] } } }),
    "configs/mid.json": JSON.stringify({ extends: ["./base", "./overlay.json"] }),
    "tsconfig.json": `{
      // A path declared here uses the inherited baseUrl from configs/base.json.
      "extends": "./configs/mid",
      "compilerOptions": { "paths": { "@new/*": ["new/*",], }, },
    }`,
    "src/new/dates.ts": "export function hit(): number { return 3; }\n",
    "src/old/dates.ts": "export function hit(): number { return 1; }\n",
    "src/overlay/dates.ts": "export function hit(): number { return 2; }\n",
    "src/caller.ts": [
      'import { hit as newHit } from "@new/dates";',
      'import { hit as oldHit } from "@old/dates";',
      'import { hit as overlayHit } from "@overlay/dates";',
      "export function run(): number { return newHit() + oldHit() + overlayHit(); }",
    ].join("\n"),
  }, (graph) => {
    assert.equal(callTarget(graph, "src/caller.ts#run"), "src/new/dates.ts#hit");
    assert.ok(graph.edges.some((edge) => edge.relation === "imports" && edge.source === "src/caller.ts" && edge.target === "@old/dates"));
    assert.ok(graph.edges.some((edge) => edge.relation === "imports" && edge.source === "src/caller.ts" && edge.target === "@overlay/dates"));
  });
});

test("nested backend and frontend configs scope the same alias to different targets", async () => {
  await withGraph({
    "backend/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    "frontend/tsconfig.app.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./lib/*"] } } }),
    "backend/src/value.ts": "export function value(): number { return 1; }\n",
    "frontend/lib/value.ts": "export function value(): number { return 2; }\n",
    "backend/handler.ts": 'import { value } from "@/value"; export function run(): number { return value(); }\n',
    "frontend/page.ts": 'import { value } from "@/value"; export function render(): number { return value(); }\n',
  }, (graph) => {
    assert.equal(callTarget(graph, "backend/handler.ts#run"), "backend/src/value.ts#value");
    assert.equal(callTarget(graph, "frontend/page.ts#render"), "frontend/lib/value.ts#value");
  });
});

test("configs in one directory use tsconfig.json first and fall through when its target is absent", async () => {
  await withGraph({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: {
      "@shared/*": ["./standard/*"],
      "@fallback/*": ["./missing/*"],
    } } }),
    "tsconfig.app.json": JSON.stringify({ compilerOptions: { paths: {
      "@shared/*": ["./app/*"],
      "@fallback/*": ["./app/*"],
    } } }),
    "standard/value.ts": "export function shared(): number { return 1; }\n",
    "app/value.ts": "export function fallback(): number { return 2; }\n",
    "src/caller.ts": [
      'import { shared } from "@shared/value";',
      'import { fallback } from "@fallback/value";',
      "export function run(): number { return shared() + fallback(); }",
    ].join("\n"),
  }, (graph) => {
    const targets = graph.edges
      .filter((edge) => edge.relation === "calls" && edge.source === "src/caller.ts#run")
      .map((edge) => edge.target)
      .sort();
    assert.deepEqual(targets, ["app/value.ts#fallback", "standard/value.ts#shared"]);
  });
});

test("the first existing target in a paths list wins in declared order", async () => {
  await withGraph({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: {
      "@tool/*": ["./missing/*", "./src/first/*", "./src/second/*"],
    } } }),
    "src/first/task.ts": "export function run(): number { return 1; }\n",
    "src/second/task.ts": "export function run(): number { return 2; }\n",
    "src/caller.ts": 'import { run as task } from "@tool/task"; export function call(): number { return task(); }\n',
  }, (graph) => {
    assert.equal(callTarget(graph, "src/caller.ts#call"), "src/first/task.ts#run");
  });
});

test("Python imports ignore TS aliases and relative ESM .js imports keep resolving to .ts", async () => {
  await withGraph({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "core": ["./src/core.ts"] } } }),
    "src/core.ts": "export function core(): number { return 1; }\n",
    "src/relative.ts": "export function relative(): number { return 2; }\n",
    "src/caller.ts": [
      'import { relative } from "./relative.js";',
      "export function run(): number { return relative(); }",
    ].join("\n"),
    "py/caller.py": "import core\n\ndef run():\n    return core.value()\n",
  }, (graph) => {
    assert.equal(callTarget(graph, "src/caller.ts#run"), "src/relative.ts#relative");
    assert.ok(graph.edges.some((edge) => edge.relation === "imports" && edge.source === "py/caller.py" && edge.target === "core"));
    assert.ok(!graph.edges.some((edge) => edge.relation === "imports" && edge.source === "py/caller.py" && edge.target === "src/core.ts"));
  });
});

test("an alias whose targets are absent stays external and invents no call edge", async () => {
  await withGraph({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@missing/*": ["./src/absent/*"] } } }),
    "src/caller.ts": 'import { run as missing } from "@missing/task"; export function call(): number { return missing(); }\n',
  }, (graph) => {
    assert.ok(graph.edges.some((edge) => edge.relation === "imports" && edge.source === "src/caller.ts" && edge.target === "@missing/task"));
    assert.equal(callTarget(graph, "src/caller.ts#call"), undefined);
  });
});
