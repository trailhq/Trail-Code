/**
 * Kotlin member calls as call edges (#431).
 *
 * A Kotlin service reaches its collaborators through a constructor property
 * (`class Bar(private val foo: FooService)`), a function parameter, a typed or
 * constructed local, an object/companion (`Utils.helper()`), or just its own
 * members (`other()`). None of those had a receiver type or an enclosing owner, so
 * `callers FooService.handle` reported nothing while the Java twin found them all.
 *
 * What these pin: each receiver shape lands on the owning type's method; a bare
 * call to a top-level function still resolves as a function; and a name that is no
 * member of the receiver's type resolves to nothing rather than to a lookalike.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { tmpRepo } from "./helpers.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildKotlin(files: Record<string, string>): Promise<GraphV1> {
  const root = tmpRepo("kotlin-members-");
  for (const [rel, src] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, src);
  }
  await buildGraph(root, { reuse: false });
  return readGraph(wiringPath(join(root, "graft")))!;
}

const calls = (g: GraphV1, source: string) =>
  g.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target).sort();

const FOO_KT = `package app

class FooService {
    fun handle(x: Int): Int = x
    fun audit() {}
}

class Other {
    fun handle(x: Int): Int = x
}

object Utils {
    fun helper(x: Int): Int = x
}

class Registry {
    companion object {
        fun create(): Registry = Registry()
    }
}

fun topLevel() {}
`;

const BAR_KT = `package app

class Bar(private val foo: FooService, val other: Other, plain: FooService) {
    private val made = FooService()
    private val typed: FooService? = null
    private val unknown = build()

    fun viaProperty() { foo.handle(1) }
    fun viaThis() { this.foo.handle(2) }
    fun viaField() { made.audit(); typed?.audit() }
    fun viaParam(p: FooService) { p.handle(3) }
    fun viaLocal() {
        val local = FooService()
        local.handle(4)
        val declared: Other = build()
        declared.handle(5)
    }
    fun viaObject() { Utils.helper(6); Registry.create() }
    fun implicitThis() { sibling(); topLevel() }
    fun sibling() {}
    fun nonMember() { foo.nope(); unknown.handle(7); plain.handle(8) }
}
`;

test("kotlin members: property, parameter, local, object and implicit-this calls resolve to the owner's method", async () => {
  const g = await buildKotlin({ "Foo.kt": FOO_KT, "Bar.kt": BAR_KT });
  assert.deepEqual(calls(g, "Bar.kt#Bar.viaProperty"), ["Foo.kt#FooService.handle"]);
  assert.deepEqual(calls(g, "Bar.kt#Bar.viaThis"), ["Foo.kt#FooService.handle"]);
  assert.deepEqual(calls(g, "Bar.kt#Bar.viaField"), ["Foo.kt#FooService.audit"]);
  assert.deepEqual(calls(g, "Bar.kt#Bar.viaParam"), ["Foo.kt#FooService.handle"]);
  assert.deepEqual(calls(g, "Bar.kt#Bar.viaLocal"), ["Foo.kt#FooService", "Foo.kt#FooService.handle", "Foo.kt#Other.handle"]);
  assert.deepEqual(calls(g, "Bar.kt#Bar.viaObject"), ["Foo.kt#Registry.create", "Foo.kt#Utils.helper"]);
  assert.deepEqual(calls(g, "Bar.kt#Bar.implicitThis"), ["Bar.kt#Bar.sibling", "Foo.kt#topLevel"]);
});

test("kotlin members: an unknown member, an unbound receiver and a plain constructor parameter resolve to nothing", async () => {
  const g = await buildKotlin({ "Foo.kt": FOO_KT, "Bar.kt": BAR_KT });
  assert.deepEqual(calls(g, "Bar.kt#Bar.nonMember"), []);
});

const SHADOW_KT = `package app

class Shadow(private val foo: FooService, private val other: Other) {
    fun lambdaParam(xs: List<Other>) { xs.forEach { foo -> foo.handle(1) } }
    fun untypedLocal() {
        val foo = build()
        foo.handle(2)
    }
    fun forVariable(xs: List<Other>) { for (foo in xs) foo.handle(3) }
    fun destructured(pair: Pair<Other, Other>) {
        val (foo, _) = pair
        foo.handle(4)
    }
    fun opaqueParam(foo: (Int) -> Int) { foo.handle(5) }
    fun typedLambdaParam(xs: List<Other>) { xs.forEach { foo: Other -> foo.handle(6) } }
    fun stillTheField() { foo.handle(7); other.handle(8) }
    fun viaThis(xs: List<Other>) { xs.forEach { foo -> this.foo.handle(9) } }
}
`;

test("kotlin members: a lambda parameter, an untyped local, a loop variable or a destructured name hides the field of that name", async () => {
  const g = await buildKotlin({ "Foo.kt": FOO_KT, "Shadow.kt": SHADOW_KT });
  assert.deepEqual(calls(g, "Shadow.kt#Shadow.lambdaParam"), []);
  assert.deepEqual(calls(g, "Shadow.kt#Shadow.untypedLocal"), []);
  assert.deepEqual(calls(g, "Shadow.kt#Shadow.forVariable"), []);
  assert.deepEqual(calls(g, "Shadow.kt#Shadow.destructured"), []);
  assert.deepEqual(calls(g, "Shadow.kt#Shadow.opaqueParam"), []);
  assert.deepEqual(calls(g, "Shadow.kt#Shadow.typedLambdaParam"), ["Foo.kt#Other.handle"]);
  assert.deepEqual(calls(g, "Shadow.kt#Shadow.stillTheField"), ["Foo.kt#FooService.handle", "Foo.kt#Other.handle"]);
  assert.deepEqual(calls(g, "Shadow.kt#Shadow.viaThis"), ["Foo.kt#FooService.handle"]);
});

test("kotlin members: a bare call inside another object's receiver lambda is not the enclosing class's member", async () => {
  const g = await buildKotlin({
    "Cart.kt": `package app

class Cart {
    fun add(x: Int) {}
    fun viaApply() { mutableListOf<Int>().apply { add(1) } }
    fun viaWith(sb: StringBuilder) { with(sb) { add(2) } }
    fun viaBuilder() = buildList<Int> { add(3) }
    fun viaForEach(xs: List<Int>) { xs.forEach { add(it) } }
}
`,
  });
  assert.deepEqual(calls(g, "Cart.kt#Cart.viaApply"), []);
  assert.deepEqual(calls(g, "Cart.kt#Cart.viaWith"), []);
  assert.deepEqual(calls(g, "Cart.kt#Cart.viaBuilder"), []);
  assert.deepEqual(calls(g, "Cart.kt#Cart.viaForEach"), ["Cart.kt#Cart.add"]);
});

test("kotlin members: this@Outer reaches the outer class, not the inner one", async () => {
  const g = await buildKotlin({
    "Outer.kt": `package app

class Outer {
    fun save() {}
    inner class Inner {
        fun save() {}
        fun viaOuter() { this@Outer.save() }
        fun viaSelf() { this.save() }
    }
}
`,
  });
  assert.deepEqual(calls(g, "Outer.kt#Outer.Inner.viaOuter"), ["Outer.kt#Outer.save"]);
  assert.deepEqual(calls(g, "Outer.kt#Outer.Inner.viaSelf"), ["Outer.kt#Outer.Inner.save"]);
});
