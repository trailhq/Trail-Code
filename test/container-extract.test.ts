/**
 * The container tier: files that wrap another language, `.vue` being the case
 * that motivated it, `.svelte` and `.astro` the two that followed.
 *
 * The assertion that matters in every test here is the SPAN. Slicing the script
 * block out is easy; putting its symbols back on the right `.vue` line is where
 * this can go quietly wrong, and a span that is off by one is worse than no
 * indexing at all — graft's whole promise is that its `file:line` is exact, so a
 * plausible-but-wrong line sends the reader somewhere else with full confidence.
 *
 * Every fixture below is written as an array of lines and joined, so the
 * expected line numbers are the array indices + 1 and can be read off the source
 * rather than counted by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  warmContainerGrammars,
  extractContainer,
  containerLangOf,
  containerExtensions,
  isContainerWarm,
} from "../src/graph/container.js";
import { supportedExtensions } from "../src/graph/source-files.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

const VUE = containerLangOf("Any.vue")!;
const SVELTE = containerLangOf("Any.svelte")!;
const ASTRO = containerLangOf("Any.astro")!;

/** Line N of the fixture is `lines[N - 1]` — that is the whole point. */
function sfc(lines: string[]): string {
  return lines.join("\n") + "\n";
}

function spanOf(nodes: { name: string; span: string }[], name: string): string {
  const hit = nodes.find((n) => n.name === name);
  assert.ok(hit, `no node named ${name} (got: ${nodes.map((n) => n.name).join(", ")})`);
  return hit.span;
}

test("container: registry claims .vue and reports it as supported", () => {
  assert.equal(containerLangOf("src/components/Card.vue")?.name, "vue");
  assert.equal(containerLangOf("src/components/Card.VUE")?.name, "vue", "extension match is case-insensitive");
  assert.equal(containerLangOf("src/lib/util.ts"), null);
  assert.ok(containerExtensions().includes(".vue"));
  // Without this, the -e warning added in #100 would call .vue unsupported at
  // the very moment it became supported.
  assert.ok(supportedExtensions().includes(".vue"), ".vue must be in the -e supported set");
});

test("container: spans point at the .vue line, not the script line", async () => {
  await warmContainerGrammars(["vue"]);
  assert.ok(isContainerWarm("vue"), "vue grammar must be available in tree-sitter-wasms");

  const lines = [
    "<template>",                                //  1
    "  <p>{{ title }}</p>",                      //  2
    "</template>",                               //  3
    "",                                          //  4
    '<script setup lang="ts">',                  //  5
    'import { ref } from "vue";',                //  6
    "",                                          //  7
    "const title = ref('hi');",                  //  8
    "",                                          //  9
    "export function shout(what: string) {",     // 10
    "  return what.toUpperCase();",              // 11
    "}",                                         // 12
    "</script>",                                 // 13
  ];

  const { nodes } = extractContainer("Card.vue", sfc(lines), VUE);

  // Line 10 in the file; line 6 inside the script block. Getting 6 here would
  // be the exact failure this tier exists to avoid.
  assert.equal(spanOf(nodes, "shout"), "L10-L12");
});

test("container: a script with nothing above it still lands right", async () => {
  await warmContainerGrammars(["vue"]);

  const lines = [
    '<script setup lang="ts">',        // 1
    "export function first() {}",      // 2
    "</script>",                       // 3
    "",                                // 4
    "<template><b/></template>",       // 5
  ];

  // The offset is 0 here, so this is the case a naive implementation passes and
  // the previous test catches. Kept because it is also the case a fix for the
  // previous test could break.
  assert.equal(spanOf(extractContainer("A.vue", sfc(lines), VUE).nodes, "first"), "L2-L2");
});

test("container: both script blocks are extracted, each with its own offset", async () => {
  await warmContainerGrammars(["vue"]);

  const lines = [
    '<script lang="ts">',                  //  1
    "export function onlyInOptions() {}",  //  2
    "</script>",                           //  3
    "",                                    //  4
    '<script setup lang="ts">',            //  5
    "function onlyInSetup() {}",           //  6
    "</script>",                           //  7
  ];

  const { nodes } = extractContainer("Two.vue", sfc(lines), VUE);
  assert.equal(spanOf(nodes, "onlyInOptions"), "L2-L2");
  assert.equal(spanOf(nodes, "onlyInSetup"), "L6-L6");

  // Whatever the inner extractor does or doesn't emit is its business — the
  // container's job is only to relocate what comes back. A plain `const` is not
  // a symbol in the TypeScript tier, and it must not become one here either.
  assert.equal(nodes.filter((n) => n.kind === "file").length, 1, "exactly one file node");
});

test("container: a name defined in both blocks gets two nodes, not one", async () => {
  await warmContainerGrammars(["vue"]);

  const lines = [
    "<script>",                    // 1
    "function dup() {}",           // 2
    "</script>",                   // 3
    "<script setup>",              // 4
    "function dup() {}",           // 5
    "</script>",                   // 6
  ];

  const { nodes, rawEdges } = extractContainer("Dup.vue", sfc(lines), VUE);
  const dups = nodes.filter((n) => n.name === "dup");

  assert.equal(dups.length, 2, "both definitions survive");
  assert.equal(new Set(dups.map((n) => n.id)).size, 2, "ids are distinct");
  assert.deepEqual(dups.map((n) => n.span).sort(), ["L2-L2", "L5-L5"]);

  // The renamed id must be carried into that block's edges, or the graph points
  // at a node that does not exist.
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of rawEdges) {
    assert.ok(ids.has(e.source), `edge source ${e.source} has no node`);
    if (e.targetId) assert.ok(ids.has(e.targetId), `edge target ${e.targetId} has no node`);
  }
});

test("container: the file node describes the .vue, not the script block", async () => {
  await warmContainerGrammars(["vue"]);

  const lines = [
    "<template>",                     // 1
    "  <p>hola</p>",                  // 2
    "</template>",                    // 3
    "<script setup>",                 // 4
    "const x = 1;",                   // 5
    "</script>",                      // 6
    "<style>.a{color:red}</style>",   // 7
  ];
  const source = sfc(lines);

  const { nodes } = extractContainer("Card.vue", source, VUE);
  const file = nodes[0];

  assert.equal(file.kind, "file");
  assert.equal(file.id, "Card.vue");
  assert.equal(file.span, "L1-L8", "spans the whole SFC, template and style included");
  assert.equal(file.chars, source.length);
  // Depth-tier origin: these symbols carry real bindings and import specifiers,
  // so they must not take resolve.ts's generic guess-by-name path.
  assert.equal(file.origin, "ast");
});

test("container: an SFC with no usable script degrades to a file node", async () => {
  await warmContainerGrammars(["vue"]);

  for (const [label, lines] of [
    ["no script at all", ["<template>", "  <p>static</p>", "</template>"]],
    ["empty script", ["<script></script>", "<template><p/></template>"]],
  ] as const) {
    const { nodes, rawEdges } = extractContainer("Empty.vue", sfc([...lines]), VUE);
    assert.equal(nodes.length, 1, `${label}: file node only`);
    assert.equal(nodes[0].kind, "file");
    assert.equal(rawEdges.length, 0, `${label}: no edges`);
  }
});

test("container: multi-byte characters above the script do not shift the spans", async () => {
  await warmContainerGrammars(["vue"]);

  // Accents and an emoji in the template: if the slice were taken by byte offset
  // against a UTF-16 string, the script would be cut in the wrong place and the
  // symbol would move or vanish.
  const lines = [
    "<template>",                                  // 1
    "  <p>Configuración 🚚 españolísima</p>",      // 2
    "</template>",                                 // 3
    '<script setup lang="ts">',                    // 4
    "export function envío() { return 1; }",       // 5
    "</script>",                                   // 6
  ];

  assert.equal(spanOf(extractContainer("Acc.vue", sfc(lines), VUE).nodes, "envío"), "L5-L5");
});

test("container: a .vue file goes through a real build end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-container-"));
  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(
    join(dir, "src", "helper.ts"),
    "export function greet(name: string) {\n  return `hi ${name}`;\n}\n",
  );
  writeFileSync(
    join(dir, "src", "Card.vue"),
    sfc([
      "<template>",                                   // 1
      "  <p>{{ label }}</p>",                         // 2
      "</template>",                                  // 3
      "",                                             // 4
      '<script setup lang="ts">',                     // 5
      'import { greet } from "./helper";',            // 6
      "",                                             // 7
      "export function label() {",                    // 8
      "  return greet('world');",                     // 9
      "}",                                            // 10
      "</script>",                                    // 11
    ]),
  );

  const outDir = join(dir, "graft");
  await buildGraph(dir, outDir, { reuse: false });
  const graph = readGraph(wiringPath(outDir));

  const label = graph.nodes.find((n) => n.name === "label" && n.path.endsWith("Card.vue"));
  assert.ok(label, "the .vue symbol is in the built graph");
  assert.equal(label.span, "L8-L10");

  // The payoff of routing through the depth tier rather than a generic grammar:
  // the import resolves, so the call from the SFC into a .ts module is a real edge.
  const greet = graph.nodes.find((n) => n.name === "greet");
  assert.ok(greet, "the .ts target is in the graph");
  assert.ok(
    graph.edges.some((e) => e.source === label.id && e.target === greet.id && e.relation === "calls"),
    "the SFC's call into the .ts helper resolved",
  );
});

/**
 * The check has to see every tier the build writes (#236).
 *
 * `checkGraph` re-extracts and diffs against the committed graph, so a tier it
 * cannot extract reads as `removed` — and because the remedy it prints is
 * `graft build`, which wrote those very nodes, the drift can never be cleared.
 * That made `graft check` exit non-zero forever on any repo holding a `.vue`
 * file, which is fatal for the CI drift gate it exists to be.
 *
 * Asserted on a clean build with NOTHING changed in between: the only correct
 * answer there is "in sync", so any drift at all is the bug.
 */
test("container: a clean build of a .vue file checks as in sync", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-container-check-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "Hello.vue"),
    sfc([
      "<template><div @click=\"greet\">{{ msg }}</div></template>",
      '<script setup lang="ts">',
      "const msg = 'hi';",
      "function greet(): void {",
      "  console.log(msg);",
      "}",
      "</script>",
    ]),
  );

  const outDir = join(dir, "graft");
  await buildGraph(dir, outDir, { reuse: false });
  const built = readGraph(wiringPath(outDir));
  assert.ok(
    built.nodes.some((n) => n.path.endsWith("Hello.vue")),
    "precondition: the build extracted the .vue file",
  );

  const check = await checkGraph(dir, { contextDir: outDir });
  assert.deepEqual(check.removed, [], "a tier the build wrote must not read as removed");
  assert.deepEqual(check.added, []);
  assert.deepEqual(check.changed, []);
  assert.equal(check.ok, true, "a clean build checks OK");
});

/*
 * Svelte and Astro. Same tier, same risk, one new wrinkle each — and the wrinkle
 * is exactly what a fixture with known line numbers is for.
 *
 * Svelte: `raw_text` does not start right after the tag's `>` as Vue's does. It
 * starts at the first non-blank character of the NEXT line, so its row is one
 * past the tag's and the slice begins mid-line. Astro: the code lives in two
 * kinds of block — the `---` frontmatter, whose body starts right after the
 * opening fence, and `<script>`, which Astro hoists from anywhere in the markup.
 * Verified beyond these fixtures against sveltejs/kit, huntabyte/shadcn-svelte,
 * withastro/astro and withastro/docs (4,500 files): every extracted symbol has
 * its name on the line its span points to.
 */

test("container: registry claims .svelte and .astro and reports them as supported", () => {
  assert.equal(containerLangOf("src/lib/Button.svelte")?.name, "svelte");
  assert.equal(containerLangOf("src/pages/index.ASTRO")?.name, "astro", "extension match is case-insensitive");
  for (const e of [".svelte", ".astro"]) {
    assert.ok(containerExtensions().includes(e));
    assert.ok(supportedExtensions().includes(e), `${e} must be in the -e supported set`);
  }
});

test("svelte: spans point at the .svelte line even though raw_text starts a line late", async () => {
  await warmContainerGrammars(["svelte"]);
  assert.ok(isContainerWarm("svelte"), "svelte grammar must be available in tree-sitter-wasm");

  // The tag carries attributes AND the script is indented: with Vue's grammar
  // the body would start on line 4 right after the `>`; here it starts on line
  // 5 at column 2. Both must put `shout` on line 9.
  const lines = [
    "<h1>{shout(name)}</h1>",                      //  1
    "",                                            //  2
    "",                                            //  3
    '<script lang="ts">',                          //  4
    '  import { greet } from "./helper";',         //  5
    "  export let name: string = 'world';",        //  6
    "  greet(name);",                              //  7
    "",                                            //  8
    "  export function shout(what: string) {",     //  9
    "    return what.toUpperCase();",              // 10
    "  }",                                         // 11
    "</script>",                                   // 12
    "",                                            // 13
    "<style>h1 { color: red }</style>",            // 14
  ];

  const { nodes } = extractContainer("Card.svelte", sfc(lines), SVELTE);
  assert.equal(spanOf(nodes, "shout"), "L9-L11");
  assert.equal(nodes[0].kind, "file");
  assert.equal(nodes[0].span, "L1-L15", "the file node spans the whole component");
});

test("svelte: <script module> and the instance script are both extracted, each with its own offset", async () => {
  await warmContainerGrammars(["svelte"]);

  const lines = [
    "<script module>",                       //  1
    "  export function fromModule() {}",     //  2
    "</script>",                             //  3
    "",                                      //  4
    "<script>",                              //  5
    "  let { name = 'x' } = $props();",      //  6
    "  let count = $state(0);",              //  7
    "  function bump() { count += 1; }",     //  8
    "</script>",                             //  9
    "",                                      // 10
    "<button onclick={bump}>{name}</button>", // 11
  ];

  const { nodes } = extractContainer("Two.svelte", sfc(lines), SVELTE);
  assert.equal(spanOf(nodes, "fromModule"), "L2-L2");
  // Runes are plain calls to the TypeScript grammar, so a Svelte 5 script is
  // extracted like any other; `bump` is a function declaration and gets a node.
  assert.equal(spanOf(nodes, "bump"), "L8-L8");
  assert.equal(nodes.filter((n) => n.kind === "file").length, 1, "exactly one file node");
});

test("svelte: a component with no script degrades to a file node", async () => {
  await warmContainerGrammars(["svelte"]);
  const { nodes, rawEdges } = extractContainer("Static.svelte", sfc(["<h1>static</h1>", "<style>h1{}</style>"]), SVELTE);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, "file");
  assert.equal(rawEdges.length, 0);
});

test("astro: frontmatter spans point at the .astro line", async () => {
  await warmContainerGrammars(["astro"]);
  assert.ok(isContainerWarm("astro"), "astro grammar must be available in tree-sitter-wasm");

  // The body starts right after the opening `---` (row 0), so line N of the
  // frontmatter is line N + 0 of the file — the naive case, kept because it
  // is the case the next test could break.
  const lines = [
    "---",                                                //  1
    'import Layout from "../layouts/Layout.astro";',      //  2
    'import { greet } from "../lib/helper";',             //  3
    "",                                                   //  4
    "interface Props { title: string }",                  //  5
    "const { title } = Astro.props;",                     //  6
    "",                                                   //  7
    "export function shout(what: string) {",              //  8
    "  return what.toUpperCase();",                       //  9
    "}",                                                  // 10
    "---",                                                // 11
    "",                                                   // 12
    "<Layout title={title}><h1>{shout(greet(title))}</h1></Layout>", // 13
  ];

  const { nodes } = extractContainer("index.astro", sfc(lines), ASTRO);
  assert.equal(spanOf(nodes, "shout"), "L8-L10");
  assert.equal(spanOf(nodes, "Props"), "L5-L5");
});

test("astro: frontmatter and a <script> are both extracted, each with its own offset", async () => {
  await warmContainerGrammars(["astro"]);

  const lines = [
    "---",                                            //  1
    "export function server() { return 1; }",         //  2
    "---",                                            //  3
    "<h1>hi</h1>",                                    //  4
    "<script>",                                       //  5
    '  import { track } from "../lib/track";',        //  6
    "  function client() { track('ready'); }",        //  7
    "  document.addEventListener('load', client);",   //  8
    "</script>",                                      //  9
  ];

  const { nodes } = extractContainer("Both.astro", sfc(lines), ASTRO);
  assert.equal(spanOf(nodes, "server"), "L2-L2");
  assert.equal(spanOf(nodes, "client"), "L7-L7");
  assert.equal(nodes.filter((n) => n.kind === "file").length, 1, "exactly one file node");
});

test("astro: a <script> nested inside the markup is still found", async () => {
  await warmContainerGrammars(["astro"]);

  // Astro hoists a <script> from wherever it sits, and the common shape is a
  // page wrapped in a <Layout> with the script inside it. A top-level-only scan
  // would miss this one — and its import edge — entirely.
  const lines = [
    "---",                                            //  1
    'import Layout from "../layouts/Layout.astro";',  //  2
    "---",                                            //  3
    "<Layout>",                                       //  4
    "  <main><h1>hi</h1></main>",                     //  5
    "  <script>",                                     //  6
    "    function nested() { return 2; }",            //  7
    "    nested();",                                  //  8
    "  </script>",                                    //  9
    "</Layout>",                                      // 10
  ];

  assert.equal(spanOf(extractContainer("Nested.astro", sfc(lines), ASTRO).nodes, "nested"), "L7-L7");
});

test("astro: no frontmatter, or an empty one, degrades to a file node", async () => {
  await warmContainerGrammars(["astro"]);

  for (const [label, lines] of [
    ["no frontmatter", ["<h1>static</h1>"]],
    ["empty frontmatter", ["---", "---", "<h1>static</h1>"]],
    ["empty script", ["<h1>static</h1>", "<script></script>"]],
  ] as const) {
    const { nodes, rawEdges } = extractContainer("Empty.astro", sfc([...lines]), ASTRO);
    assert.equal(nodes.length, 1, `${label}: file node only`);
    assert.equal(nodes[0].kind, "file");
    assert.equal(rawEdges.length, 0, `${label}: no edges`);
  }
});

test("container: .svelte and .astro go through a real build, resolve into .ts, and check as in sync", async () => {
  const cases = [
    {
      file: "Card.svelte",
      lines: [
        "<p>{label()}</p>",                   //  1
        "",                                   //  2
        '<script lang="ts">',                 //  3
        '  import { greet } from "./helper";', //  4
        "",                                   //  5
        "  export function label() {",        //  6
        "    return greet('world');",         //  7
        "  }",                                //  8
        "</script>",                          //  9
      ],
      span: "L6-L8",
    },
    {
      file: "Card.astro",
      lines: [
        "---",                                //  1
        'import { greet } from "./helper";',  //  2
        "",                                   //  3
        "export function label() {",          //  4
        "  return greet('world');",           //  5
        "}",                                  //  6
        "---",                                //  7
        "<p>{label()}</p>",                   //  8
      ],
      span: "L4-L6",
    },
  ];

  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), "graft-container-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "helper.ts"), "export function greet(name: string) {\n  return `hi ${name}`;\n}\n");
    writeFileSync(join(dir, "src", c.file), sfc(c.lines));

    const outDir = join(dir, "graft");
    await buildGraph(dir, outDir, { reuse: false });
    const graph = readGraph(wiringPath(outDir));

    const label = graph.nodes.find((n) => n.name === "label" && n.path.endsWith(c.file));
    assert.ok(label, `${c.file}: the component's symbol is in the built graph`);
    assert.equal(label.span, c.span, `${c.file}: span`);

    // The payoff of routing through the depth tier: the import resolves, so the
    // call from the component into a .ts module is a real edge.
    const greet = graph.nodes.find((n) => n.name === "greet");
    assert.ok(greet, `${c.file}: the .ts target is in the graph`);
    assert.ok(
      graph.edges.some((e) => e.source === label.id && e.target === greet.id && e.relation === "calls"),
      `${c.file}: the component's call into the .ts helper resolved`,
    );

    // And the check must see the tier too (#236): a clean build is in sync.
    const check = await checkGraph(dir, { contextDir: outDir });
    assert.deepEqual(check.removed, [], `${c.file}: a tier the build wrote must not read as removed`);
    assert.deepEqual(check.added, []);
    assert.deepEqual(check.changed, []);
    assert.equal(check.ok, true, `${c.file}: a clean build checks OK`);
  }
});
