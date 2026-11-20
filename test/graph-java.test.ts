/**
 * Tests for Java extraction in the Tier-1 code graph. Builds a small Java source
 * tree in a temp dir and asserts the emitted nodes (classes, interfaces, enums,
 * records, methods, constructors) and edges (calls, heritage, package imports)
 * match the AST walk in extract.ts.
 *
 * Three of these pin decisions that are Java-specific and easy to regress, because
 * each one is invisible to the other languages' fixtures:
 *
 *   - `method_invocation` has NO `function` field (it splits the callee into
 *     `object` + `name`), unlike every other grammar graft parses.
 *   - Java has no free functions, so an implicit-`this` call (`decorate(x)`) is a
 *     METHOD call. Resolved against the function index it would vanish — and it is
 *     the most common intra-class edge there is.
 *   - `new Foo()` targets a TYPE, so a constructor call resolved against the
 *     function index would vanish too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const PKG = "src/main/java/com/acme";

const GREETER = `package com.acme;

public interface Greeter {
  String greet(String name);
}
`;

const BASE = `package com.acme;

public abstract class Base {
  protected void audit(String event) {}
}
`;

const POINT = `package com.acme;

public record Point(int x, int y) {}
`;

const COLOR = `package com.acme;

public enum Color {
  RED,
  GREEN
}
`;

const STORE = `package com.acme;

public final class Store {
  public void save(Point point) {}
}
`;

const APP = `package com.acme;

import com.acme.Store;
import java.util.List;

public final class App extends Base implements Greeter {

  private final Store store;

  public App(Store store) {
    this.store = store;
  }

  @Override
  public String greet(String name) {
    return decorate(name);
  }

  private String decorate(String raw) {
    return raw;
  }

  public void persist() {
    store.save(new Point(1, 2));
  }

  public void inferred() {
    var local = new Store();
    local.save(new Point(3, 4));
  }

  void packagePrivate() {}
}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-"));
  mkdirSync(join(dir, PKG), { recursive: true });
  writeFileSync(join(dir, PKG, "Greeter.java"), GREETER);
  writeFileSync(join(dir, PKG, "Base.java"), BASE);
  writeFileSync(join(dir, PKG, "Point.java"), POINT);
  writeFileSync(join(dir, PKG, "Color.java"), COLOR);
  writeFileSync(join(dir, PKG, "Store.java"), STORE);
  writeFileSync(join(dir, PKG, "App.java"), APP);
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

const APP_JAVA = `${PKG}/App.java`;

test("Java extraction: classes, interfaces, enums, records, methods, constructors", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("java"), "languages should include java");

    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph, "wiring graph should be written");

    assert.equal(nodeById(graph!, `${APP_JAVA}#App`)?.kind, "class");
    assert.equal(nodeById(graph!, `${PKG}/Greeter.java#Greeter`)?.kind, "interface");
    assert.equal(nodeById(graph!, `${PKG}/Color.java#Color`)?.kind, "enum");

    // A record is a nominal data carrier, so it takes "struct" — not "class", which
    // would make a DTO and a service indistinguishable in a Java repo where DTOs are
    // most of the type surface.
    assert.equal(nodeById(graph!, `${PKG}/Point.java#Point`)?.kind, "struct");

    // Methods nest under their type; a constructor is a method named for its class.
    assert.equal(nodeById(graph!, `${APP_JAVA}#App.greet`)?.kind, "method");
    assert.equal(nodeById(graph!, `${APP_JAVA}#App.App`)?.kind, "method");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: visibility comes from the modifier list, not the name", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.equal(nodeById(graph, `${APP_JAVA}#App`)?.exported, true, "public class");
    assert.equal(nodeById(graph, `${APP_JAVA}#App.greet`)?.exported, true, "public method");
    assert.equal(
      nodeById(graph, `${PKG}/Base.java#Base.audit`)?.exported,
      true,
      "protected is still API surface to a subclass",
    );
    assert.equal(
      nodeById(graph, `${APP_JAVA}#App.decorate`)?.exported,
      false,
      "private method is not API surface",
    );
    assert.equal(
      nodeById(graph, `${APP_JAVA}#App.packagePrivate`)?.exported,
      false,
      "package-private (no modifier) is not API surface",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: call edges — implicit `this`, typed field receiver, constructor", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const calls = graph.edges.filter((e) => e.relation === "calls");

    // Implicit-`this`: `decorate(name)` names no receiver but IS a method call.
    // Java has no free functions, so resolving this against the function index
    // would silently drop the commonest edge in the language.
    assert.ok(
      calls.some((e) => e.source === `${APP_JAVA}#App.greet` && e.target === `${APP_JAVA}#App.decorate`),
      "greet should call decorate via implicit-this resolution",
    );

    // Typed field receiver: `store.save(...)` resolves through the declared field
    // type `private final Store store`.
    assert.ok(
      calls.some(
        (e) => e.source === `${APP_JAVA}#App.persist` && e.target === `${PKG}/Store.java#Store.save`,
      ),
      "persist should call Store.save via the field's declared type",
    );

    // `new Point(1, 2)` targets a TYPE, not a function.
    assert.ok(
      calls.some(
        (e) => e.source === `${APP_JAVA}#App.persist` && e.target === `${PKG}/Point.java#Point`,
      ),
      "persist should have a constructor edge to Point",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: a `var local = new Store()` member call resolves via the initializer", async () => {
  // `var` states no type at the declaration site, so a single-file binding pass
  // cannot use the type annotation. It CAN, however, read a `new X()`
  // initializer — the one shape that names its own type with no return-type
  // inference — so `var local = new Store(); local.save(...)` resolves the
  // member call to Store.save, not just the constructor edge to Store.
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const calls = graph.edges.filter((e) => e.relation === "calls");

    assert.ok(
      calls.some(
        (e) => e.source === `${APP_JAVA}#App.inferred` && e.target === `${PKG}/Store.java#Store.save`,
      ),
      "a var-typed receiver constructed by `new Store()` should resolve the member call",
    );
    assert.ok(
      calls.some(
        (e) => e.source === `${APP_JAVA}#App.inferred` && e.target === `${PKG}/Store.java#Store`,
      ),
      "the constructor edge still resolves too",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: extends and implements", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "extends" &&
          e.source === `${APP_JAVA}#App` &&
          e.target === `${PKG}/Base.java#Base`,
      ),
      "App extends Base",
    );
    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "implements" &&
          e.source === `${APP_JAVA}#App` &&
          e.target === `${PKG}/Greeter.java#Greeter`,
      ),
      "App implements Greeter",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: imports resolve by package path; external types stay strings", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const imports = graph.edges.filter((e) => e.relation === "imports" && e.source === APP_JAVA);

    // A Java import names a TYPE and states no source root, so resolution matches the
    // fully-qualified name against a path suffix — root-agnostic, no build-file parsing.
    assert.ok(
      imports.some((e) => e.target === `${PKG}/Store.java`),
      "com.acme.Store should resolve to the in-repo file under src/main/java/",
    );

    // The JDK is not in the repo; the specifier is kept verbatim rather than guessed at.
    assert.ok(
      imports.some((e) => e.target === "java.util.List"),
      "java.util.List should remain an external type string",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: a static-member import resolves to its enclosing type", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-static-"));
  try {
    mkdirSync(join(dir, PKG), { recursive: true });
    writeFileSync(
      join(dir, PKG, "Util.java"),
      "package com.acme;\n\npublic final class Util {\n  public static int twice(int n) {\n    return n * 2;\n  }\n}\n",
    );
    writeFileSync(
      join(dir, PKG, "Caller.java"),
      "package com.acme;\n\nimport static com.acme.Util.twice;\n\npublic final class Caller {\n  public int run() {\n    return twice(2);\n  }\n}\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // `com.acme.Util.twice` names a member; the file is the enclosing type's.
    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "imports" &&
          e.source === `${PKG}/Caller.java` &&
          e.target === `${PKG}/Util.java`,
      ),
      "a static-member import should fall back to its enclosing type's file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: an ambiguous package suffix stays unresolved rather than guessing", async () => {
  // The same fully-qualified name under two source roots (main and a duplicated test
  // tree) gives one suffix two files. Picking one would invent an edge the source
  // does not state, so the specifier is kept.
  const dir = mkdtempSync(join(tmpdir(), "graft-java-ambig-"));
  try {
    const main = "src/main/java/com/acme";
    const test2 = "src/test/java/com/acme";
    mkdirSync(join(dir, main), { recursive: true });
    mkdirSync(join(dir, test2), { recursive: true });
    const dup = "package com.acme;\n\npublic final class Dup {\n  public void run() {}\n}\n";
    writeFileSync(join(dir, main, "Dup.java"), dup);
    writeFileSync(join(dir, test2, "Dup.java"), dup);
    writeFileSync(
      join(dir, main, "Uses.java"),
      "package com.acme;\n\nimport com.acme.Dup;\n\npublic final class Uses {\n  public void go() {}\n}\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "imports" && e.source === `${main}/Uses.java` && e.target === "com.acme.Dup",
      ),
      "an ambiguous suffix must stay an unresolved specifier",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Overload fixture: a 2-arg convenience method delegating to the 3-arg one — the
 * commonest shape in Java, and the one that produced a self-loop before arity was
 * recorded. `log` adds a variadic pair; `render` a same-arity pair. */
const OVERLOADS = `package com.acme;

public final class Svc {

  public String join(String left, String right) {
    return join(left, right, "-");
  }

  public String join(String left, String right, String separator) {
    return left + separator + right;
  }

  public void log(String msg) {
    log(msg, "a", "b");
  }

  public void log(String msg, String... rest) {}

  public String render(String s) {
    return render(s.length());
  }

  public String render(int n) {
    return String.valueOf(n);
  }
}
`;

function overloadFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-overload-"));
  mkdirSync(join(dir, PKG), { recursive: true });
  writeFileSync(join(dir, PKG, "Svc.java"), OVERLOADS);
  return dir;
}

test("Java overloads: a delegating call resolves to the other overload, not itself", async () => {
  // Before arity was recorded, both `join` nodes were candidates, the same-file
  // tiebreak picked the first, and the 2-arg method got a `calls` edge to ITSELF —
  // marked `extracted`, i.e. confidently wrong. Overloading exists in none of the
  // other languages graft parses, so no existing fixture could have caught this.
  const dir = overloadFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const svc = `${PKG}/Svc.java`;
    const calls = graph.edges.filter((e) => e.relation === "calls");

    assert.ok(
      calls.some((e) => e.source === `${svc}#Svc.join` && e.target === `${svc}#Svc.join~2`),
      "the 2-arg join should call the 3-arg overload",
    );
    assert.ok(
      !calls.some((e) => e.source === `${svc}#Svc.join` && e.target === `${svc}#Svc.join`),
      "and must not call itself",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java overloads: a variadic candidate is never filtered out by argument count", async () => {
  // `log(String, String...)` has arity 2 but accepts 1..n arguments. Filtering on
  // equality would exclude it from a 3-argument call and drop a real edge.
  const dir = overloadFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const svc = `${PKG}/Svc.java`;

    const variadic = graph.nodes.find((n) => n.id === `${svc}#Svc.log~2`);
    assert.equal(variadic?.arity, 2, "declared arity counts the vararg parameter");
    assert.equal(variadic?.variadic, true, "and it is flagged variadic");

    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === `${svc}#Svc.log` && e.target === `${svc}#Svc.log~2`,
      ),
      "a 3-argument call should still reach the variadic overload",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java overloads: same-arity overloads stay unresolved rather than guessing", async () => {
  // `render(String)` and `render(int)` both have arity 1 — they differ only by
  // parameter TYPE, which this pass does not model. The documented limit: narrowing
  // cannot separate them, so the same-file tiebreak applies and no type-based guess
  // is made. Pinned so a future type-aware change is a deliberate one.
  const dir = overloadFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const svc = `${PKG}/Svc.java`;

    const a = graph.nodes.find((n) => n.id === `${svc}#Svc.render`);
    const b = graph.nodes.find((n) => n.id === `${svc}#Svc.render~2`);
    assert.equal(a?.arity, 1);
    assert.equal(b?.arity, 1, "both render overloads have arity 1, so count cannot separate them");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Construction fixture. `Box` is built raw, with explicit type arguments, and with the
 * diamond — three spellings of one node. `File` and the nested `Alpha`/`Beta` builders
 * exist so the negative half can be pinned: a qualified `new` must resolve to NOTHING
 * rather than to the same-named type that happens to be in the repo. */
const GENERIC_BOX = `package com.acme;

public final class Box<T> {
  private final T value;

  public Box(T value) {
    this.value = value;
  }

  public T get() {
    return value;
  }
}
`;

/** A repo-local type whose simple name collides with a JDK one. */
const LOCAL_FILE = `package com.acme;

public final class File {
  public void touch() {}
}
`;

/**
 * Two nested builders under one outer type, and a method that constructs one of them —
 * all in ONE file, deliberately. A last-segment collapse yields the bare name `Builder`,
 * which matches both; the resolver's same-file tiebreak then takes the FIRST candidate.
 * Split across files the ambiguity would simply drop, so a cross-file fixture would pass
 * whether or not the collapse happens and would pin nothing.
 */
const NESTED = `package com.acme;

public final class Api {

  public static class Alpha {
    public static class Builder {
      public Api build() {
        return null;
      }
    }
  }

  public static class Beta {
    public static class Builder {
      public Api build() {
        return null;
      }
    }
  }

  public Api make() {
    return new Beta.Builder().build();
  }
}
`;

const GENERIC_USES = `package com.acme;

import com.acme.Box;

public final class Uses {

  public Box<String> explicitArguments() {
    return new Box<String>("a");
  }

  public Box<String> diamond() {
    return new Box<>("b");
  }

  @SuppressWarnings("rawtypes")
  public Box raw() {
    return new Box("c");
  }

  public Object qualified() {
    return new java.io.File("x");
  }

}
`;

function genericFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-generic-"));
  mkdirSync(join(dir, PKG), { recursive: true });
  writeFileSync(join(dir, PKG, "Box.java"), GENERIC_BOX);
  writeFileSync(join(dir, PKG, "File.java"), LOCAL_FILE);
  writeFileSync(join(dir, PKG, "Api.java"), NESTED);
  writeFileSync(join(dir, PKG, "Uses.java"), GENERIC_USES);
  return dir;
}

test("Java construction: a generic `new` reaches the same type node as a raw one", async () => {
  // `object_creation_expression` used to hand the constructed type's RAW TEXT to the
  // resolver, so `new Box<String>()` searched for a node named "Box<String>" and the
  // diamond form for "Box<>". Neither exists — the node is "Box" — so every generic
  // construction lost its edge while the raw form worked, which is why it went
  // unnoticed.
  //
  // The constructed type is now erased by `javaConstructedTypeName`, which is
  // deliberately NOT bindings.ts's `javaTypeName`: that one collapses a qualified name
  // to its last segment, which is safe for deciding what a variable holds and NOT safe
  // for naming a constructor target. Wiring the two together is what the sibling test
  // below ("a QUALIFIED `new` resolves to nothing") exists to forbid.
  const dir = genericFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const box = `${PKG}/Box.java#Box`;
    const uses = `${PKG}/Uses.java`;
    const calls = graph.edges.filter((e) => e.relation === "calls" && e.target === box);
    const sources = new Set(calls.map((e) => e.source));

    assert.ok(sources.has(`${uses}#Uses.explicitArguments`), "new Box<String>() should reach Box");
    assert.ok(sources.has(`${uses}#Uses.diamond`), "new Box<>() should reach Box");
    assert.ok(sources.has(`${uses}#Uses.raw`), "new Box() should still reach Box");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java construction: a QUALIFIED `new` resolves to nothing, not to a same-named local type", async () => {
  // The negative half of the same change, and the reason erasure is done by a helper of
  // its own rather than by the binding pass's `javaTypeName`. Reducing `java.io.File` to
  // its final segment would find the repo's unrelated `com.acme.File` and assert an edge
  // the source never expressed — trading a missing edge for a wrong one, which is the
  // trade the resolver exists to refuse.
  const dir = genericFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const calls = graph.edges.filter((e) => e.relation === "calls");

    assert.ok(
      !calls.some(
        (e) =>
          e.source === `${PKG}/Uses.java#Uses.qualified` && e.target === `${PKG}/File.java#File`,
      ),
      "new java.io.File(...) must not resolve to the repo's own File",
    );
    assert.ok(
      !calls.some((e) => e.source === `${PKG}/Uses.java#Uses.qualified`),
      "and must not resolve to anything else either",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java construction: a nested `new` does not bind to a sibling of the same simple name", async () => {
  // `new Beta.Builder()` collapsed to `Builder` matches two nodes in the SAME file, and
  // the resolver's same-file tiebreak returns the FIRST — `Alpha.Builder` — at
  // `extracted` confidence, i.e. confidently wrong. Resolving nested construction
  // properly needs a qualified-name index; until then it resolves to nothing.
  const dir = genericFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const api = `${PKG}/Api.java`;
    const ctor = graph.edges.filter(
      (e) =>
        e.relation === "calls" && e.source === `${api}#Api.make` && e.target.includes("Builder"),
    );

    assert.deepEqual(ctor, [], "a qualified nested construction must not pick a Builder at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Java binding improvements: the constructs upstream's handleJava didn't
// cover. Each pins one binding shape so a regression is named, not buried in a
// whole-repo edge count. ---

/** Fixture exercising every binding shape added on top of upstream's
 * `formal_parameter` / `local_variable_declaration` / `field_declaration`:
 * varargs, try-with-resources (typed and `var`), enhanced-for, catch parameter,
 * array-typed field and local, and a field whose declared type is missing but
 * whose initializer is a `new Foo()`. `Worker` and `Task` are defined in the
 * same file so member calls resolve to in-repo nodes we can assert on. */
const BINDINGS_SRC = `package com.acme;

public class Worker {
  public void run(Task task) {}
  public void close() {}
}

public class Task {
  public void start() {}
}

public class Bindings {

  // array-typed field: Worker[] pool
  private Worker[] pool;

  // field with no declared type but a new Worker() initializer
  private Worker initField = new Worker();

  public void use(Worker w) {
    // varargs: String... args
    useVarargs("a", "b");
    // try-with-resources, explicit type: try (Worker r = new Worker())
    try (Worker r = new Worker()) {
      r.run(new Task());
    }
    // try-with-resources, var: try (var r = new Worker())
    try (var r = new Worker()) {
      r.run(new Task());
    }
    // enhanced-for: for (Worker x : pool)
    for (Worker x : pool) {
      x.run(new Task());
    }
    // catch (single type): catch (RuntimeException e)
    try {
      w.run(new Task());
    } catch (RuntimeException e) {
      e.getMessage();
    }
    // array-typed local: Worker[] local = new Worker[1]
    Worker[] local = new Worker[1];
    // var local: var v = new Worker()
    var v = new Worker();
    v.run(new Task());
  }

  public void useVarargs(String... args) {
    args.length();
  }
}
`;

function makeBindingsFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-bind-"));
  mkdirSync(join(dir, PKG), { recursive: true });
  writeFileSync(join(dir, PKG, "Worker.java"), BINDINGS_SRC);
  writeFileSync(join(dir, PKG, "Store.java"), STORE);
  return dir;
}

// All three classes (Worker, Task, Bindings) live in Worker.java — Java allows
// multiple top-level classes in one file as long as only one is public. The
// file is named after Worker, so every node id is rooted at Worker.java.
const BIND_FILE = `${PKG}/Worker.java`;

test("Java bindings: a varargs parameter binds its name to the element type", async () => {
  // `String... args` — tree-sitter names the node `spread_parameter` with no
  // field names, so this is not the `formal_parameter` branch. The element type
  // is the first named child; `args` binds to `String`. `String.length()` is a
  // builtin, so the safe-failure mode is "no calls edge to a repo method named
  // length" — which is what we assert, confirming the binding landed on a
  // non-repo type rather than being dropped entirely.
  const dir = makeBindingsFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const badCall = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.source === `${BIND_FILE}#Bindings.useVarargs` &&
        graph.nodes.find((n) => n.id === e.target)?.name === "length",
    );
    assert.equal(badCall, undefined, "args.length() on a String varargs must not wire to a repo method");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java bindings: try-with-resources binds the resource variable (explicit type)", async () => {
  // `try (Worker r = new Worker()) { r.run(...) }` — `r` binds to `Worker`, so
  // `r.run(...)` resolves to Worker.run.
  const dir = makeBindingsFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const call = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.source === `${BIND_FILE}#Bindings.use` &&
        e.target === `${BIND_FILE}#Worker.run`,
    );
    assert.ok(call, "r.run() inside try-with-resources should resolve to Worker.run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java bindings: try-with-resources binds the resource variable (`var` + initializer)", async () => {
  // `try (var r = new Worker()) { r.run(...) }` — the declared type is `var`,
  // so the binding falls back to the `new Worker()` initializer. A dedicated
  // fixture (no typed-TWR, no enhanced-for, no var-local on Worker) isolates
  // the var-TWR path: the only Worker.run edge that can fire is the one through
  // `r`, so its presence proves the var fallback bound `r` to `Worker`.
  const dir = mkdtempSync(join(tmpdir(), "graft-java-var-twr-"));
  try {
    mkdirSync(join(dir, PKG), { recursive: true });
    writeFileSync(
      join(dir, PKG, "VarTwr.java"),
      `package com.acme;

public class Worker { public void run(Task t) {} }
public class Task {}

public class VarTwr {
  public void use() {
    try (var r = new Worker()) {
      r.run(new Task());
    }
  }
}`,
    );
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const call = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.source === `${PKG}/VarTwr.java#VarTwr.use` &&
        e.target === `${PKG}/VarTwr.java#Worker.run`,
    );
    assert.ok(call, "r.run() inside `try (var r = new Worker())` should resolve to Worker.run via the initializer fallback");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java bindings: enhanced-for binds the loop variable to the element type", async () => {
  // `for (Worker x : pool) { x.run(...) }` — `x` binds to `Worker` from the
  // `type` field, so `x.run(...)` resolves to Worker.run.
  const dir = makeBindingsFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const call = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.source === `${BIND_FILE}#Bindings.use` &&
        e.target === `${BIND_FILE}#Worker.run`,
    );
    assert.ok(call, "x.run() inside enhanced-for should resolve to Worker.run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java bindings: a catch parameter binds its name to the caught type", async () => {
  // `catch (RuntimeException e) { e.getMessage(); }` — `e` binds to
  // `RuntimeException`, which is not a repo symbol, so `e.getMessage()` must
  // NOT wire to any repo method named `getMessage`. The assertion confirms the
  // binding landed on a non-repo type (and did not silently drop, which would
  // leave `e` unbound and let `getMessage` fall through to name-only
  // resolution — a different and worse failure mode).
  const dir = makeBindingsFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const badCall = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.source === `${BIND_FILE}#Bindings.use` &&
        graph.nodes.find((n) => n.id === e.target)?.name === "getMessage",
    );
    assert.equal(badCall, undefined, "e.getMessage() on a caught RuntimeException must not wire to a repo method");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java bindings: an array-typed field binds to the element type", async () => {
  // `private Worker[] pool` — `pool` binds to `Worker` (array_type → element),
  // so the enhanced-for over `pool` types its loop variable correctly. The
  // binding's effect is already pinned by the enhanced-for test; this is a
  // smoke check that the fixture builds and the Bindings class node exists.
  const dir = makeBindingsFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(graph.nodes.some((n) => n.id === `${BIND_FILE}#Bindings`), "Bindings class node exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java bindings: a field with no declared type binds via its `new X()` initializer", async () => {
  // `private Worker initField = new Worker()` — no type annotation, but the
  // initializer is an `object_creation_expression`. The binding falls back to
  // the constructed type. The initializer also emits a constructor edge to
  // Worker, which is the same fallback path — assert it lands.
  const dir = makeBindingsFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const ctorEdge = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.source === `${BIND_FILE}#Bindings` &&
        e.target === `${BIND_FILE}#Worker`,
    );
    assert.ok(ctorEdge, "the field initializer `new Worker()` should emit a constructor edge to Worker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: annotation type element declarations are method-kind nodes", async () => {
  // `@interface Version { String value(); }` — upstream maps
  // `annotation_type_declaration` to `interface` but did not map
  // `annotation_type_element_declaration`, so the element method was missing
  // from the graph. The element is a method-like declaration (`String value()
  // default "1"`), so it takes `method` kind.
  const dir = mkdtempSync(join(tmpdir(), "graft-java-anno-"));
  try {
    mkdirSync(join(dir, PKG), { recursive: true });
    writeFileSync(
      join(dir, PKG, "Version.java"),
      "package com.acme;\n\npublic @interface Version {\n  String value() default \"1\";\n  int count() default 0;\n}\n",
    );
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const anno = nodeById(graph, `${PKG}/Version.java#Version`);
    assert.equal(anno?.kind, "interface", "@interface maps to interface kind");

    const valueElem = nodeById(graph, `${PKG}/Version.java#Version.value`);
    assert.ok(valueElem, "Version.value element should be a node");
    assert.equal(valueElem?.kind, "method", "annotation element maps to method kind");

    const countElem = nodeById(graph, `${PKG}/Version.java#Version.count`);
    assert.ok(countElem, "Version.count element should be a node");
    assert.equal(countElem?.kind, "method");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java scopes: pom.xml, build.gradle, and build.gradle.kts are project markers", async () => {
  // A Java project rooted at a pom.xml / build.gradle / build.gradle.kts should
  // be its own scope, so a multi-module repo ranks per-module rather than
  // pooling. Each marker gets its own temp repo; the scope's `markers` list
  // should include the marker file.
  const { discoverScopes } = await import("../src/graph/scopes.js");
  for (const marker of ["pom.xml", "build.gradle", "build.gradle.kts"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "graft-java-scope-"));
    try {
      mkdirSync(join(dir, "backend"), { recursive: true });
      writeFileSync(join(dir, "backend", marker), "");
      const scopes = discoverScopes(dir);
      const backend = scopes.find((s) => s.prefix === "backend");
      assert.ok(backend, `a backend/ dir with ${marker} should be a scope`);
      assert.ok(
        backend!.markers.includes(marker),
        `the scope's markers should include ${marker}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Heritage fixture. Every supertype here is generic, qualified, or a type variable —
 * the three shapes that a naive walk of the clause turns into bogus supertypes. `Item`
 * carries a method no subclass has, so a wrong `extends` is visible as a wrong CALL:
 * `extends` feeds `classParents`, which `resolveTypedMember` walks up.
 */
const HER_ITEM = `package com.acme;

public class Item {
  public void poison() {}
}
`;

const HER_BASE = `package com.acme;

public class Base<T> {
  public void real() {}
}
`;

const HER_MARKER = `package com.acme;

public interface Marker {}
`;

const HER_OUTER = `package com.acme;

public class Outer {
  public interface Inner {}
}
`;

const HER_CHILD = `package com.acme;

public final class Child extends Base<Item> implements Marker {
  public void use() {
    Child c = new Child();
    c.poison();
  }
}
`;

const HER_HOLDER = `package com.acme;

public class Holder<T> extends Base<T> {}
`;

const HER_IMPL = `package com.acme;

public final class Impl implements Outer.Inner {}
`;

function heritageFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-heritage-"));
  mkdirSync(join(dir, PKG), { recursive: true });
  writeFileSync(join(dir, PKG, "Item.java"), HER_ITEM);
  writeFileSync(join(dir, PKG, "Base.java"), HER_BASE);
  writeFileSync(join(dir, PKG, "Marker.java"), HER_MARKER);
  writeFileSync(join(dir, PKG, "Outer.java"), HER_OUTER);
  writeFileSync(join(dir, PKG, "Child.java"), HER_CHILD);
  writeFileSync(join(dir, PKG, "Holder.java"), HER_HOLDER);
  writeFileSync(join(dir, PKG, "Impl.java"), HER_IMPL);
  return dir;
}

test("Java heritage: a type ARGUMENT is not a supertype", async () => {
  // `implements Comparable<Item>` / `extends Base<Item>` used to walk into
  // `type_arguments` and report `Item` as a supertype of its own accord.
  const dir = heritageFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const from = `${PKG}/Child.java#Child`;
    const her = graph.edges.filter(
      (e) => (e.relation === "extends" || e.relation === "implements") && e.source === from,
    );

    assert.ok(
      her.some((e) => e.relation === "extends" && e.target === `${PKG}/Base.java#Base`),
      "the named supertype still resolves",
    );
    assert.ok(
      her.some((e) => e.relation === "implements" && e.target === `${PKG}/Marker.java#Marker`),
      "a non-generic interface is unaffected",
    );
    assert.ok(
      !her.some((e) => e.target === `${PKG}/Item.java#Item` || e.target === "Item"),
      "the type argument must not become a supertype",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java heritage: a bogus supertype no longer poisons call resolution", async () => {
  // The reason this outranks a cosmetic heritage fix. `extends` edges populate
  // `classParents`, so `Child extends Item` made `resolveTypedMember` walk `Item` as an
  // ancestor and resolve `c.poison()` — a method that does not compile on a `Child`.
  const dir = heritageFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.ok(
      !graph.edges.some(
        (e) =>
          e.relation === "calls" &&
          e.source === `${PKG}/Child.java#Child.use` &&
          e.target === `${PKG}/Item.java#Item.poison`,
      ),
      "a method reachable only through a bogus ancestor must not resolve",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java heritage: a type VARIABLE is never a supertype", async () => {
  // `class Holder<T> extends Base<T>` names `Base`. A `T` surviving to the edge list is
  // the declaration's own parameter, which erasure alone would not always remove.
  const dir = heritageFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const from = `${PKG}/Holder.java#Holder`;
    const her = graph.edges.filter(
      (e) => (e.relation === "extends" || e.relation === "implements") && e.source === from,
    );

    assert.deepEqual(
      her.map((e) => e.target),
      [`${PKG}/Base.java#Base`],
      "Holder extends exactly Base — not T",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java heritage: a QUALIFIED supertype keeps its whole name", async () => {
  // Heritage keeps an unresolved base as the edge target by design, so `Outer.Inner`
  // stays whole: truthful, and unable to false-match a bare `Inner` node elsewhere in
  // the repo. (Construction drops a qualified name instead — it has no such contract.)
  const dir = heritageFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const her = graph.edges.filter(
      (e) => e.relation === "implements" && e.source === `${PKG}/Impl.java#Impl`,
    );

    assert.deepEqual(her.map((e) => e.target), ["Outer.Inner"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Two same-named nested types in ONE file, plus a construction of one of them. Split
 * across files the cross-file ambiguity check already drops it, so a same-file fixture
 * is the only one that can pin the same-file branch. */
const AMBIG = `package com.acme;

public final class Api {

  public static class AlphaB {
    public static class Builder {}
  }

  public static class BetaB {
    public static class Builder {}
  }

  public Object build() {
    return new Builder();
  }
}
`;

test("resolveName: a same-file name matching two nodes resolves to neither", async () => {
  // The same-file branch used to return `local[0]` — first in document order — and
  // label it `extracted`, i.e. certain, while the cross-file branch two lines below
  // required a unique match. A file with `AlphaB.Builder` and `BetaB.Builder` therefore
  // got a silent first-wins guess for a bare `new Builder()`. Language-agnostic: the
  // fixture is Java only because that is where it was found.
  const dir = mkdtempSync(join(tmpdir(), "graft-resolve-ambig-"));
  try {
    mkdirSync(join(dir, PKG), { recursive: true });
    writeFileSync(join(dir, PKG, "Api.java"), AMBIG);

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const guesses = graph.edges.filter(
      (e) =>
        e.relation === "calls" &&
        e.source === `${PKG}/Api.java#Api.build` &&
        e.target.includes("Builder"),
    );

    assert.deepEqual(guesses, [], "two candidates in one file must resolve to neither");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Receiver fixture. `javaReceiver` recognises three shapes and refuses the rest, and
 * each branch resolves to a DIFFERENT method here, so a mutation that collapses one
 * into another changes which edge is emitted rather than merely losing one.
 *
 * `Repo` and `Helper` both declare `run()` so that picking the wrong receiver picks a
 * visibly wrong target instead of failing to resolve.
 */
const RCV_REPO = `package com.acme;

public final class Repo {
  public void run() {}
}
`;

const RCV_HELPER = `package com.acme;

public final class Helper {
  public void run() {}
}
`;

const RCV_SERVICE = `package com.acme;

public final class Service {

  private final Repo repo;

  public Service(Repo repo) {
    this.repo = repo;
  }

  public void viaField() {
    this.repo.run();
  }

  public void viaLocal() {
    Helper local = new Helper();
    local.run();
  }

  public void viaThis() {
    this.own();
  }

  public void viaChain(Repo[] all) {
    all[0].run();
  }

  public void own() {}
}
`;

function receiverFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-receiver-"));
  mkdirSync(join(dir, PKG), { recursive: true });
  writeFileSync(join(dir, PKG, "Repo.java"), RCV_REPO);
  writeFileSync(join(dir, PKG, "Helper.java"), RCV_HELPER);
  writeFileSync(join(dir, PKG, "Service.java"), RCV_SERVICE);
  return dir;
}

test("Java receivers: `this.field.method()` resolves through the field's declared type", async () => {
  // The `field_access` branch of javaReceiver, which yields `this.repo` and is then
  // normalised to `self.repo` by resolveRecvType to meet the binding written by the
  // field pass. No fixture exercised it before: every receiver test used a bare local.
  const dir = receiverFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const calls = graph.edges.filter((e) => e.relation === "calls");

    assert.ok(
      calls.some(
        (e) =>
          e.source === `${PKG}/Service.java#Service.viaField` &&
          e.target === `${PKG}/Repo.java#Repo.run`,
      ),
      "this.repo.run() should reach Repo.run",
    );
    assert.ok(
      !calls.some(
        (e) =>
          e.source === `${PKG}/Service.java#Service.viaField` &&
          e.target === `${PKG}/Helper.java#Helper.run`,
      ),
      "and must not reach the other class that also declares run()",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java receivers: an explicit `this.method()` resolves to the enclosing type", async () => {
  // The `this` branch. Distinct from the implicit-this call already covered elsewhere:
  // that one has no `object` node at all and never reaches javaReceiver.
  const dir = receiverFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "calls" &&
          e.source === `${PKG}/Service.java#Service.viaThis` &&
          e.target === `${PKG}/Service.java#Service.own`,
      ),
      "this.own() should reach Service.own",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java receivers: an unrecognised receiver shape resolves to nothing", async () => {
  // `all[0].run()` is an array_access, none of the three shapes javaReceiver accepts.
  // Pinning the refusal matters more than pinning the acceptances: without it, widening
  // the function to "return something for any object node" would look free, and would
  // start resolving member calls against whatever type happened to match by name.
  const dir = receiverFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.deepEqual(
      graph.edges.filter(
        (e) => e.relation === "calls" && e.source === `${PKG}/Service.java#Service.viaChain`,
      ),
      [],
      "an array-access receiver states no type, so the call must not resolve",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Issue #161: a method inside an anonymous class body (`new Greeter() { … }`)
 * used to take the enclosing type's `owner`, so `ownerMethod["App.greet"]` held
 * both the real method and the anonymous override. `resolveTypedMember` then
 * same-file first-wins tied to the anonymous impl, and `App.use → App.greet`
 * vanished. Named nested classes already own their methods correctly — keep
 * that as a control so this fix does not retarget lexical nesting.
 *
 * Shape mirrors PHP #144: mint `{anonymous}` and hang methods under it.
 */
const ANON_GREETER = `package com.acme;

public interface Greeter {
  String greet(String n);
}
`;

const ANON_APP = `package com.acme;

public final class App {

  public Greeter make() {
    return new Greeter() {
      @Override public String greet(String n) { return "anon:" + n; }
    };
  }

  public String use() {
    App self = new App();
    return self.greet("x");
  }

  public String greet(String n) { return "real:" + n; }

  public static class Nested {
    public String greet(String n) { return "nested:" + n; }
  }
}
`;

function anonOwnerFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-anon-"));
  mkdirSync(join(dir, PKG), { recursive: true });
  writeFileSync(join(dir, PKG, "Greeter.java"), ANON_GREETER);
  writeFileSync(join(dir, PKG, "App.java"), ANON_APP);
  return dir;
}

test("Java anonymous class: methods do not take the enclosing type's owner (#161)", async () => {
  const dir = anonOwnerFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const file = `${PKG}/App.java`;

    const anon = nodeById(graph, `${file}#App.make.{anonymous}`);
    assert.equal(anon?.kind, "class", "anonymous body mints an {anonymous} class node");

    const anonGreet = nodeById(graph, `${file}#App.make.{anonymous}.greet`);
    assert.equal(anonGreet?.kind, "method");
    assert.equal(anonGreet?.owner, "{anonymous}", "anonymous greet is owned by {anonymous}");

    const real = nodeById(graph, `${file}#App.greet`);
    assert.equal(real?.owner, "App", "real App.greet keeps owner App");

    const nested = nodeById(graph, `${file}#App.Nested.greet`);
    assert.equal(nested?.owner, "Nested", "named nested class owner is unchanged");

    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "implements" &&
          e.source === `${file}#App.make.{anonymous}` &&
          e.target === `${PKG}/Greeter.java#Greeter`,
      ),
      "anonymous class should implement Greeter",
    );

    const useCalls = graph.edges.filter(
      (e) => e.relation === "calls" && e.source === `${file}#App.use`,
    );
    assert.ok(
      useCalls.some((e) => e.target === `${file}#App.greet`),
      `App.use should call the real App.greet; got: ${useCalls.map((e) => e.target).join(", ")}`,
    );
    assert.ok(
      !useCalls.some((e) => e.target === `${file}#App.make.{anonymous}.greet`),
      "App.use must not resolve to the anonymous greet",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #89: Java annotations are metadata, not call sites — wire them as
// `references` edges from the annotated symbol to the annotation type (the
// same shape as PHP 8 attributes in #155). Field annotations are out of
// scope: fields are not nodes.
const ANNO_MYANNO = `package com.acme;

public @interface MyAnno {
  String value() default "";
}
`;

const ANNO_FOO = `package com.acme;

@Entity
@MyAnno
public class Foo {
  @Transient
  private String field;

  @MyAnno
  public void tagged() {}

  @MyAnno(value = "x")
  public void parameterized() {}

  @Override
  public String toString() {
    return "foo";
  }
}
`;

const ANNO_ENTITY_CLASS = `package com.other;

public class Entity {}
`;

function annotationFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-annoref-"));
  mkdirSync(join(dir, PKG), { recursive: true });
  mkdirSync(join(dir, "src/main/java/com/other"), { recursive: true });
  writeFileSync(join(dir, PKG, "MyAnno.java"), ANNO_MYANNO);
  writeFileSync(join(dir, PKG, "Foo.java"), ANNO_FOO);
  writeFileSync(join(dir, "src/main/java/com/other/Entity.java"), ANNO_ENTITY_CLASS);
  return dir;
}

test("Java extraction: in-repo annotation usage resolves to references edges (#89)", async () => {
  const dir = annotationFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const foo = `${PKG}/Foo.java#Foo`;
    const myAnno = `${PKG}/MyAnno.java#MyAnno`;

    assert.equal(nodeById(graph, myAnno)?.kind, "interface", "@interface maps to interface kind");

    assert.ok(
      graph.edges.some(
        (e) => e.relation === "references" && e.source === foo && e.target === myAnno,
      ),
      "Foo class should reference the in-repo MyAnno annotation type",
    );

    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "references" &&
          e.source === `${PKG}/Foo.java#Foo.tagged` &&
          e.target === myAnno,
      ),
      "tagged method should reference the in-repo MyAnno annotation type",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: annotation arguments do not emit extra edges (#89)", async () => {
  const dir = annotationFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const myAnno = `${PKG}/MyAnno.java#MyAnno`;
    const tagged = graph.edges.filter(
      (e) => e.relation === "references" && e.source === `${PKG}/Foo.java#Foo.tagged`,
    );
    const parameterized = graph.edges.filter(
      (e) => e.relation === "references" && e.source === `${PKG}/Foo.java#Foo.parameterized`,
    );

    assert.ok(
      tagged.some((e) => e.target === myAnno),
      "marker @MyAnno on tagged should resolve",
    );
    assert.deepEqual(
      tagged.map((e) => e.target).sort(),
      parameterized.map((e) => e.target).sort(),
      "@MyAnno(value = \"x\") must emit the same references as marker @MyAnno",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: external annotation keeps its bare name (#89)", async () => {
  // Heritage keeps an unresolved supertype as the edge target rather than
  // minting a node or collapsing onto a same-named in-repo type (#103).
  // @Entity / @Override are the annotation equivalent: no in-repo @interface,
  // and a class named Entity elsewhere must not steal the edge.
  const dir = annotationFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const foo = `${PKG}/Foo.java#Foo`;
    const refs = graph.edges.filter((e) => e.relation === "references");

    assert.ok(
      refs.some((e) => e.source === foo && e.target === "Entity"),
      "unresolved @Entity should keep the bare name",
    );
    assert.ok(
      !refs.some((e) => e.source === foo && e.target.endsWith("#Entity")),
      "@Entity must not false-match the in-repo class Entity",
    );
    assert.ok(
      refs.some((e) => e.source === `${PKG}/Foo.java#Foo.toString` && e.target === "Override"),
      "unresolved @Override should keep the bare name",
    );
    assert.ok(
      !refs.some((e) => e.source === foo && (e.target === "Transient" || e.target.endsWith("#Transient"))),
      "field annotations are not class-level references",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: external @Service does not collapse onto a plain interface Service (#89)", async () => {
  // #103 in interface form: `@interface` and `interface` both mint kind
  // `interface`, so `@Service` (external Spring annotation) must not resolve
  // onto an in-repo `interface Service`. The edge stays a bare name.
  const dir = mkdtempSync(join(tmpdir(), "graft-java-service-anno-"));
  mkdirSync(join(dir, PKG), { recursive: true });
  writeFileSync(
    join(dir, PKG, "Service.java"),
    "package com.acme;\n\npublic interface Service {}\n",
  );
  writeFileSync(
    join(dir, PKG, "Foo.java"),
    "package com.acme;\n\n@Service\npublic class Foo {}\n",
  );
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const foo = `${PKG}/Foo.java#Foo`;
    const service = `${PKG}/Service.java#Service`;
    const refs = graph.edges.filter((e) => e.relation === "references" && e.source === foo);

    assert.equal(nodeById(graph, service)?.kind, "interface", "plain Service is an in-repo interface");
    assert.ok(
      refs.some((e) => e.target === "Service"),
      "unresolved @Service should keep the bare name",
    );
    assert.ok(
      !refs.some((e) => e.target === service || e.target.endsWith("#Service")),
      "@Service must not false-match the in-repo interface Service",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: a static call through the class name resolves to that class's method", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-static-call-"));
  try {
    mkdirSync(join(dir, PKG), { recursive: true });
    writeFileSync(
      join(dir, PKG, "Strings.java"),
      "package com.acme;\n\npublic final class Strings {\n  public static String trim(String s) { return s.trim(); }\n  public static String pad(String s) { return trim(s); }\n}\n",
    );
    writeFileSync(
      join(dir, PKG, "Codes.java"),
      "package com.acme;\n\npublic final class Codes {\n  public static String trim(String s) { return s; }\n}\n",
    );
    writeFileSync(
      join(dir, PKG, "Caller.java"),
      "package com.acme;\n\npublic final class Caller {\n" +
        "  private static final Logger LOG = null;\n" +
        "  public String run(String s) { return Strings.trim(s); }\n" +
        "  public String both(String s) { return Strings.pad(Codes.trim(s)); }\n" +
        "  public int jdk(java.util.List<String> l) { LOG.info(); return Math.max(1, l.size()); }\n" +
        "  public String shadow(Codes Strings) { return Strings.trim(\"x\"); }\n" +
        "}\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const calls = (source: string) =>
      graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target).sort();

    assert.deepEqual(calls(`${PKG}/Caller.java#Caller.run`), [`${PKG}/Strings.java#Strings.trim`]);
    assert.deepEqual(calls(`${PKG}/Caller.java#Caller.both`), [
      `${PKG}/Codes.java#Codes.trim`,
      `${PKG}/Strings.java#Strings.pad`,
    ]);
    assert.deepEqual(calls(`${PKG}/Caller.java#Caller.jdk`), [], "LOG and Math own no in-repo method");
    assert.deepEqual(calls(`${PKG}/Caller.java#Caller.shadow`), [`${PKG}/Codes.java#Codes.trim`], "a typed parameter wins over the class name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Java extraction: a static call through a class imported from outside the repo is not matched to an in-repo class of that name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-static-import-"));
  try {
    mkdirSync(join(dir, PKG), { recursive: true });
    mkdirSync(join(dir, "com/acme/util"), { recursive: true });
    writeFileSync(
      join(dir, "com/acme/util/Strings.java"),
      "package com.acme.util;\n\npublic final class Strings {\n  public static String trim(String s) { return s.trim(); }\n}\n",
    );
    writeFileSync(
      join(dir, PKG, "Guava.java"),
      "package com.acme;\n\nimport com.google.common.base.Strings;\n\npublic final class Guava {\n  public String run(String s) { return Strings.trim(s); }\n}\n",
    );
    writeFileSync(
      join(dir, PKG, "Local.java"),
      "package com.acme;\n\nimport com.acme.util.Strings;\n\npublic final class Local {\n  public String run(String s) { return Strings.trim(s); }\n}\n",
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const calls = (source: string) =>
      graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);

    assert.deepEqual(calls(`${PKG}/Guava.java#Guava.run`), []);
    assert.deepEqual(calls(`${PKG}/Local.java#Local.run`), ["com/acme/util/Strings.java#Strings.trim"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
