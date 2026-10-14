/**
 * Kotlin construction as a call edge (#387).
 *
 * The depth tier already extracts `Mailer(host = "smtp")` correctly — it is a
 * `call_expression`, exactly like `helperFn(1)`. What was missing sat one step
 * later: resolution matched a bare Kotlin call against functions only, so every
 * constructor edge died on a name the function index does not hold, and a class
 * reported `no indexed callers` while the free function declared beside it in the
 * same file reported all of them.
 *
 * That gap is not evenly distributed. Kotlin services are classes, wired by
 * constructor injection, so on a DI-heavy backend the classes carry most of the
 * coupling and the free functions carry the least — which is precisely backwards
 * from what the graph could see. Measured on a 717-file Kotlin monorepo: one
 * `callers` query on a helper function returned 51 call sites; the service class
 * its routes and integration test are built around returned none.
 *
 * What these pin:
 *  - the edge itself, and that it lands on the class rather than anything else;
 *  - that it stays a FALLBACK — a real function call resolves first, as before;
 *  - that construction inside a class body (a test method, a DI module) resolves
 *    too, since that is where the real instantiations live;
 *  - the two things it must still refuse: a qualified spelling, and a same-named
 *    class in another language's half of a monorepo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { tmpRepo } from "./helpers.js";
import type { GraphV1 } from "../src/graph/types.js";

/** Build a scratch repo from repo-relative paths, so a fixture can place a Kotlin
 * source tree and a TypeScript one side by side the way a real monorepo does. */
async function buildKotlin(files: Record<string, string>): Promise<GraphV1> {
  const root = tmpRepo("kotlin-");
  for (const [rel, src] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, src);
  }
  await buildGraph(root, { reuse: false });
  const graph = readGraph(wiringPath(join(root, "graft")));
  assert.ok(graph, "graph built");
  return graph!;
}

function callEdges(graph: GraphV1): Array<{ from: string; to: string }> {
  const name = (id: string): string => graph.nodes.find((n) => n.id === id)?.name ?? id;
  return graph.edges
    .filter((e) => e.relation === "calls")
    .map((e) => ({ from: name(e.source), to: name(e.target) }));
}

test("kotlin: a constructed class resolves, and a function call still resolves first", async () => {
  const graph = await buildKotlin({
    "src/main/kotlin/com/example/svc/Mailer.kt": `
package com.example.svc

class Mailer(val host: String) {
    fun send(to: String): Boolean = to.isNotEmpty()
}

fun helperFn(x: Int): Int = x + 1
`,
    "src/main/kotlin/com/example/wire/Wiring.kt": `
package com.example.wire

import com.example.svc.Mailer
import com.example.svc.helperFn

fun buildImported(): Mailer = Mailer(host = "smtp")

fun buildQualified(): com.example.svc.Mailer = com.example.svc.Mailer(host = "smtp")

fun useFunction(): Int = helperFn(1)
`,
  });
  const calls = callEdges(graph);
  assert.ok(
    calls.some((c) => c.from === "buildImported" && c.to === "Mailer"),
    "the constructor call is an edge into the class",
  );
  assert.ok(
    calls.some((c) => c.from === "useFunction" && c.to === "helperFn"),
    "a genuine free-function call still resolves — types are the fallback, not the first try",
  );
  const target = graph.nodes.find((n) => n.name === "Mailer" && n.kind === "class");
  assert.ok(
    graph.edges.some((e) => e.relation === "calls" && e.target === target?.id),
    "the edge lands on the class declaration itself",
  );
  // The qualified spelling stays unresolved, for the reason Java's construction
  // does (#103): `com.example.svc.Mailer` reduced to its last segment would bind
  // `java.io.File(...)` to an unrelated in-repo `File` just as readily. Naming a
  // type through its package needs an import-aware type index, not a longer
  // helper, so the call drops rather than guesses.
  assert.ok(
    !calls.some((c) => c.from === "buildQualified"),
    "a package-qualified construction is dropped, not reduced to its last segment",
  );
});

test("kotlin: construction inside a class body resolves too", async () => {
  // Where the instantiations actually are: a test method, a DI module's lambda.
  // The call's source is the enclosing METHOD, not a top-level function.
  const graph = await buildKotlin({
    "src/main/kotlin/no/example/svc/DunningService.kt": `
package no.example.svc

class EmailService

data class DunningConfig(val days: Int)

class DunningService(val email: EmailService, val config: DunningConfig)
`,
    "src/test/kotlin/no/example/svc/DunningIntegrationTest.kt": `
package no.example.svc

class DunningIntegrationTest {
    fun sendsReminder() {
        val service = DunningService(EmailService(), DunningConfig(days = 14))
        checkNotNull(service)
    }
}
`,
  });
  const from = callEdges(graph)
    .filter((c) => c.from === "sendsReminder")
    .map((c) => c.to)
    .sort();
  assert.deepEqual(from, ["DunningConfig", "DunningService", "EmailService"]);
});

test("kotlin: construction does not reach a same-named class in another language", async () => {
  // The monorepo this came from is Kotlin plus Next.js, and `Report`-shaped names
  // exist on both sides. Kotlin and Java share a classpath, so the family filter
  // cannot simply be "the same extension" — but a TypeScript class is not something
  // Kotlin can construct, and admitting types to the fallback is exactly what would
  // otherwise make that unique cross-repo name look like a confident answer.
  const graph = await buildKotlin({
    "apps/api/src/main/kotlin/no/example/Mailer.kt": `
package no.example

class Mailer(val host: String)
`,
    "apps/web/lib/report.ts": `
export class Report {
  render(): string {
    return "";
  }
}
`,
    "apps/api/src/main/kotlin/no/example/Wiring.kt": `
package no.example

fun wire() {
    Mailer(host = "smtp")
    Report()
}
`,
  });
  const from = callEdges(graph)
    .filter((c) => c.from === "wire")
    .map((c) => c.to);
  assert.deepEqual(from, ["Mailer"], "the Kotlin class resolves; the TypeScript one is unreachable");
});

test("kotlin: a function of the same name wins, because types are only the fallback", async () => {
  // Kotlin allows a function named after a type — the factory idiom the stdlib itself
  // uses (`fun MutableList(…)`). `Panel()` is that function, not the class, and the
  // ordering in resolveEdges is what guarantees it: types are tried only after the
  // function index has found nothing. `Mailer()` in the same file is the other half,
  // and shows the fallback still fires where there is no function to prefer.
  const graph = await buildKotlin({
    "src/main/kotlin/no/acme/svc/Parts.kt": `
package no.acme.svc

class Panel(val tag: String)

fun Panel(): Panel = Panel("default")

class Mailer(val host: String)
`,
    "src/main/kotlin/no/acme/wire/Wire.kt": `
package no.acme.wire

import no.acme.svc.Mailer
import no.acme.svc.Panel

fun wire() {
    Panel()
    Mailer(host = "smtp")
}
`,
  });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const from = graph.edges
    .filter((e) => e.relation === "calls" && byId.get(e.source)?.name === "wire")
    .map((e) => `${byId.get(e.target)?.kind}:${byId.get(e.target)?.name}`)
    .sort();
  assert.deepEqual(from, ["class:Mailer", "function:Panel"]);
});

test("kotlin: a .kts script resolves construction the same way a .kt file does", async () => {
  // Both extensions are the same language to the extractor, and a build/tooling script
  // is often the only place a class is wired up — so the fallback is keyed on the
  // language, not on `.kt`. A script's top-level `val` is itself a node, so the edge
  // hangs off that rather than off the file.
  const graph = await buildKotlin({
    "src/main/kotlin/no/acme/svc/Mailer.kt": `
package no.acme.svc

class Mailer(val host: String)
`,
    "tools/report.main.kts": `
import no.acme.svc.Mailer

val mailer = Mailer(host = "smtp")
`,
  });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.ok(
    graph.edges.some(
      (e) =>
        e.relation === "calls" &&
        byId.get(e.source)?.path === "tools/report.main.kts" &&
        byId.get(e.target)?.name === "Mailer" &&
        byId.get(e.target)?.kind === "class",
    ),
    "a .kts script's construction resolves to the class",
  );
});
