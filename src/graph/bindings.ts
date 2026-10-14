/**
 * Receiver-type binding pass: a pre-order walk over a parsed file that answers,
 * for every local variable / parameter / class field / `self`|`this` attribute,
 * "what type is this?" — so a later member-call site (`app.include_router()`)
 * can look up `app`'s bound type instead of resolving on the bare method name
 * alone. Pure and dependency-only: no LLM, no network, no mutation of the AST.
 *
 * Only `import type` from extract.ts (never a value) — extract.ts imports
 * `collectBindings` from here, so a value import back would be a cycle.
 */
import type Parser from "tree-sitter";
import type { Language, WalkCtx } from "./extract.js";

/** Variable/field → bare type name, keyed by scope. Scope keys mirror
 * extract.ts's own scope stack (`scope.join(".")`, `""` at module level) so a
 * lookup from extract.ts's walk finds exactly what was bound in the same
 * lexical position. */
export class FileBindings {
  private map = new Map<string, string>();

  set(scopePath: string, name: string, type: string): void {
    this.map.set(`${scopePath}|${name}`, type);
  }

  /** Innermost-first: for scope ["a","b"] name "x", tries `a.b|x`, `a|x`, `|x`. */
  lookup(scope: string[], name: string): string | null {
    for (let i = scope.length; i >= 0; i--) {
      const hit = this.map.get(`${scope.slice(0, i).join(".")}|${name}`);
      if (hit) return hit;
    }
    return null;
  }
}

const FN_VALUE_TYPES = new Set(["arrow_function", "function", "function_expression", "generator_function"]);

// Duplicated from extract.ts's own CS_METHOD_TYPES/CS_TYPE_KINDS (keys only) —
// same no-value-import-of-extract rule as goReceiverTypeOf below. `defName` also
// handles `property_declaration`/`local_function_statement`, which extract.ts
// recognizes individually rather than through either set.
const CS_METHOD_TYPES = new Set(["method_declaration", "constructor_declaration", "destructor_declaration"]);
const CS_TYPE_NODE_TYPES = new Set([
  "class_declaration",
  "struct_declaration",
  "interface_declaration",
  "record_declaration",
  "enum_declaration",
  "delegate_declaration",
]);

/** Resolve a C# type-reference node to a bare type name. Duplicated from
 * extract.ts's own `csTypeName` (same no-value-import-of-extract rule). */
function csTypeNameOf(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
    case "predefined_type":
      return node.text;
    case "generic_name":
      return node.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
    case "qualified_name": {
      const name = node.childForFieldName("name");
      return name ? csTypeNameOf(name) : null;
    }
    case "nullable_type":
      return csTypeNameOf(node.namedChildren[0]);
    default:
      return null;
  }
}

/** The interface name qualifying an explicit interface implementation
 * (`void IFoo.Bar() {}` → `"IFoo"`), else null. Duplicated from extract.ts's own
 * `csExplicitInterface`. */
function csExplicitInterfaceOf(node: Parser.SyntaxNode): string | null {
  const spec = node.namedChildren.find((c) => c.type === "explicit_interface_specifier");
  return csTypeNameOf(spec?.namedChildren[0]);
}

/** Definition-node types that push a new scope segment, mirroring extract.ts's
 * `describe()` closely enough to keep the two scope stacks in lockstep — but
 * duplicated here (not imported) to keep bindings.ts free of a value import on
 * extract.ts. Returns the def's scope segment (bare name, except a Go method
 * which is receiver-qualified — `Receiver.method` — exactly like extract.ts's
 * `idName`, so a binding recorded inside a Go method body is stored under the
 * same scope key extract.ts's walk will look it up with), or null if `node`
 * isn't a definition. */
export function defName(node: Parser.SyntaxNode, lang: Language): string | null {
  if (lang === "java") {
    return JAVA_DEF_TYPES.has(node.type) ? (node.childForFieldName("name")?.text ?? null) : null;
  }
  if (lang === "go") {
    if (node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const recv = goReceiverTypeOf(node);
      return recv ? `${recv}.${name}` : name;
    }
    if (node.type === "function_declaration" || node.type === "type_spec") {
      return node.childForFieldName("name")?.text ?? null;
    }
    return null;
  }
  if (lang === "r") return rDefName(node);
  if (lang === "swift") return swiftDefName(node);
  if (lang === "csharp") {
    if (CS_METHOD_TYPES.has(node.type) || node.type === "property_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const iface = csExplicitInterfaceOf(node);
      return iface ? `${iface}.${name}` : name;
    }
    if (CS_TYPE_NODE_TYPES.has(node.type) || node.type === "local_function_statement") {
      return node.childForFieldName("name")?.text ?? null;
    }
    return null;
  }
  if (lang === "php") {
    const phpDefTypes = new Set([
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
      "enum_declaration",
      "method_declaration",
      "function_definition",
    ]);
    if (phpDefTypes.has(node.type)) return node.childForFieldName("name")?.text ?? null;
    // Closures push a scope segment in extract.ts too — mirror it so a typed
    // parameter bound inside a closure is keyed under the same scope path.
    if (node.type === "anonymous_function" || node.type === "arrow_function") return phpClosureName(node);
    // Anonymous classes likewise mint an `{anonymous}` scope segment (#144).
    if (node.type === "anonymous_class") return "{anonymous}";
    return null;
  }
  const defTypes =
    lang === "python"
      ? new Set(["class_definition", "function_definition"])
      : new Set([
          "class_declaration",
          "abstract_class_declaration",
          "function_declaration",
          "generator_function_declaration",
          "method_definition",
          "interface_declaration",
          "type_alias_declaration",
          "enum_declaration",
        ]);
  if (defTypes.has(node.type)) return node.childForFieldName("name")?.text ?? null;
  if ((lang === "typescript" || lang === "tsx") && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && FN_VALUE_TYPES.has(value.type)) return node.childForFieldName("name")?.text ?? null;
  }
  return null;
}

/** The scope segment a Swift definition pushes, mirroring extract.ts's
 * `describeSwift` (duplicated, not imported, per this file's
 * no-value-import-of-extract rule): types and extensions push the type's name
 * (an extension is named after the type it extends), functions their own name,
 * and an `init` the enclosing type's name — extract.ts names initializers after
 * their type, so the two scope stacks stay in lockstep inside an init body.
 * Typealias and top-level properties DO mint nodes in extract.ts but are
 * deliberately absent here: neither has a body a binding could be set in (a
 * property initializer's closure is the one vanishing exception, mis-keying
 * only bindings set inside itself). */
function swiftDefName(node: Parser.SyntaxNode): string | null {
  if (node.type === "class_declaration") {
    if (node.children.some((c) => c.type === "extension")) {
      const ut = node.namedChildren.find((c) => c.type === "user_type");
      const ids = ut?.namedChildren.filter((c) => c.type === "type_identifier") ?? [];
      return ids.at(-1)?.text ?? null;
    }
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  }
  if (node.type === "protocol_declaration") {
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  }
  if (node.type === "function_declaration" || node.type === "protocol_function_declaration") {
    return node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
  }
  if (node.type === "init_declaration") {
    const owner = node.parent?.parent; // class_body / protocol_body → the declaration
    return owner ? swiftDefName(owner) : null;
  }
  return null;
}

const R_ASSIGN_OPS = new Set(["<-", "<<-", "="]);
const R_RIGHT_ASSIGN_OPS = new Set(["->", "->>"]);

/**
 * The bare name a `binary_operator` (left-assign) or `function_definition`
 * (right-assign) node defines, for R's two plain-function assignment shapes —
 * this file's own `defName` uses it directly. extract.ts's `describeR`
 * duplicates the same op-filtering check rather than importing this (same
 * reasoning as the Go receiver helpers below: bindings.ts can't take a value
 * import back on extract.ts), and additionally needs to distinguish an S3
 * `generic.Class` method and R6/S4 class/method shapes this function doesn't
 * know about — bindings.ts has no equivalent need since no `handleR` binding
 * collector exists yet (R6/S4/S3 don't get a member/receiver-type table in
 * this pass; `self`/`private` resolve directly via `ctx.enclosingClass`
 * instead, needing no lookup). See `describeR`'s doc comment for why
 * right-assign's AST shape needs its own branch rather than mirroring
 * left-assign's (empirically, not assumed — `->`'s low precedence means it's
 * absorbed into the function's own `body` field, not an outer wrapper).
 * Null if `node` isn't one of these two shapes.
 */
export function rDefName(node: Parser.SyntaxNode): string | null {
  if (node.type === "binary_operator") {
    const op = node.childForFieldName("operator")?.text;
    if (!op || !R_ASSIGN_OPS.has(op)) return null;
    const lhs = node.childForFieldName("lhs");
    const rhs = node.childForFieldName("rhs");
    return lhs?.type === "identifier" && rhs?.type === "function_definition" ? lhs.text : null;
  }
  if (node.type === "function_definition") {
    const body = node.childForFieldName("body");
    if (body?.type !== "binary_operator") return null;
    const op = body.childForFieldName("operator")?.text;
    if (!op || !R_RIGHT_ASSIGN_OPS.has(op)) return null;
    const rhs = body.childForFieldName("rhs");
    return rhs?.type === "identifier" ? rhs.text : null;
  }
  return null;
}

/** The receiver parameter's own variable name for a Go method (`func (w *Worker) …`
 * → `w`). Null if it can't be read. */
export function goReceiverVarOf(node: Parser.SyntaxNode): string | null {
  const recv = node.childForFieldName("receiver");
  const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
  return param?.childForFieldName("name")?.text ?? null;
}

/** The receiver's base type name for a Go method, unwrapping a pointer receiver
 * (`func (w *Worker) …` → `Worker`). Mirrors extract.ts's own `goReceiverType`
 * (duplicated, not imported, per this file's no-value-import-of-extract rule).
 * Null if it can't be read. */
function goReceiverTypeOf(node: Parser.SyntaxNode): string | null {
  const recv = node.childForFieldName("receiver");
  const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
  let type = param?.childForFieldName("type");
  if (type?.type === "pointer_type") type = type.namedChildren.at(-1) ?? null;
  return type?.type === "type_identifier" ? type.text : null;
}

/** Resolves a call site's receiver text (from `calleeName`) to a bound type
 * name, given the enclosing walk state. `self`/`cls`/`this`/the Go receiver
 * var resolve directly to the enclosing class; `super` — R6's `super$` and
 * Swift's `super.` alike — resolves to the PARENT class instead
 * (`ctx.rSuperClass`, not `ctx.enclosingClass` — a super call must climb past
 * the current class's own same-named override, not find it); anything else is
 * a bindings-map lookup, normalizing `this.` to `self.` since both are stored
 * the same way. */
export function resolveRecvType(
  receiver: string | undefined,
  ctx: Pick<WalkCtx, "scope" | "enclosingClass" | "goReceiverVar" | "lang" | "bindings" | "rSuperClass">,
): string | undefined {
  if (!receiver) return undefined;
  if (receiver === "self" || receiver === "cls" || receiver === "this") return ctx.enclosingClass ?? undefined;
  if (receiver === "super") return ctx.rSuperClass ?? undefined;
  if (receiver.startsWith("self.") || receiver.startsWith("this.")) {
    return (
      ctx.bindings.lookup(ctx.scope, receiver) ??
      ctx.bindings.lookup(ctx.scope, receiver.replace(/^this\./, "self.")) ??
      undefined
    );
  }
  // PHP static call `Foo::bar()`: the scope operand is a class name, so it *is*
  // the receiver type. (Member calls pass a `$var` receiver, filtered by the `$`.)
  if (ctx.lang === "php" && !receiver.startsWith("$")) return receiver;
  return (
    (ctx.lang === "go" && receiver === ctx.goReceiverVar ? ctx.enclosingClass : undefined) ??
    ctx.bindings.lookup(ctx.scope, receiver) ??
    // Swift type-member call `Animal.staticThing()`: an uppercase receiver with no
    // local binding is the type itself (Swift naming: types are UpperCamelCase,
    // values lowerCamelCase — and a shadowing binding was already tried above).
    (ctx.lang === "swift" && /^[A-Z]/.test(receiver) ? receiver : undefined) ??
    undefined
  );
}

function isClassNode(node: Parser.SyntaxNode, lang: Language): boolean {
  if (lang === "python") return node.type === "class_definition";
  if (lang === "java") return JAVA_TYPE_DECLS.has(node.type);
  if (lang === "typescript" || lang === "tsx") {
    return node.type === "class_declaration" || node.type === "abstract_class_declaration";
  }
  if (lang === "csharp") {
    // Interfaces included too: C# has no implicit-`this` field access to bind for
    // one, but default interface methods can still call sibling members bare.
    return (
      node.type === "class_declaration" ||
      node.type === "struct_declaration" ||
      node.type === "record_declaration" ||
      node.type === "interface_declaration"
    );
  }
  // Swift: class_declaration covers class/struct/enum/actor/extension — all can
  // hold members whose `self.field` bindings live at the type's scope.
  if (lang === "swift") {
    return node.type === "class_declaration" || node.type === "protocol_declaration";
  }
  return false;
}

/** Java declarations that push a scope segment — mirrors extract.ts's JAVA_KINDS. */
const JAVA_DEF_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
  "annotation_type_element_declaration",
  "method_declaration",
  "constructor_declaration",
]);

/** The subset of the above that owns `this.field` bindings. */
const JAVA_TYPE_DECLS: ReadonlySet<string> = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);

/** Pass 1 over a parsed file: collect variable->type bindings. Pure. */
export function collectBindings(root: Parser.SyntaxNode, lang: Language): FileBindings {
  const bindings = new FileBindings();
  const aliases = new Map<string, string>();
  collectAliases(root, lang, aliases);
  visit(root, lang, [], null, bindings, aliases);
  return bindings;
}

/** Import aliases (`... as F`) can be declared anywhere relative to their use
 * textually, so this scans the whole tree once, ahead of the scope-aware walk. */
function collectAliases(node: Parser.SyntaxNode, lang: Language, aliases: Map<string, string>): void {
  if (lang === "python" && node.type === "aliased_import") {
    const nameNode = node.childForFieldName("name");
    const aliasNode = node.childForFieldName("alias");
    if (nameNode && aliasNode) {
      const orig = nameNode.type === "dotted_name" ? (nameNode.namedChildren.at(-1)?.text ?? nameNode.text) : nameNode.text;
      aliases.set(aliasNode.text, orig);
    }
  } else if ((lang === "typescript" || lang === "tsx") && node.type === "import_specifier") {
    const nameNode = node.childForFieldName("name");
    const aliasNode = node.childForFieldName("alias");
    if (nameNode && aliasNode) aliases.set(aliasNode.text, nameNode.text);
  }
  for (const child of node.namedChildren) collectAliases(child, lang, aliases);
}

/** `scope`/`classScope` mirror extract.ts's walk: `scope` is the enclosing
 * definition-name stack; `classScope` is the nearest enclosing class's scope
 * path (distinct from `scope` once we're inside one of its methods) — that's
 * where `self.attr`/`this.attr` bindings live. */
function visit(
  node: Parser.SyntaxNode,
  lang: Language,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
): void {
  if (lang === "python") handlePy(node, scope, classScope, bindings, aliases);
  else if (lang === "go") handleGo(node, scope, bindings);
  // R Phase 1 has no classes, so there's no member/receiver-type binding to
  // collect yet (see extract.ts's calleeName R branch) — no handleR needed.
  else if (lang === "r") void 0;
  else if (lang === "java") handleJava(node, scope, classScope, bindings);
  else if (lang === "swift") handleSwift(node, scope, classScope, bindings);
  else if (lang === "php") handlePhp(node, scope, bindings);
  else if (lang === "csharp") handleCSharp(node, scope, classScope, bindings);
  else handleTs(node, scope, classScope, bindings, aliases);

  const name = defName(node, lang);
  let childScope = scope;
  let childClassScope = classScope;
  if (name !== null) {
    childScope = [...scope, name];
    if (isClassNode(node, lang)) childClassScope = childScope.join(".");
  }
  for (const child of node.namedChildren) visit(child, lang, childScope, childClassScope, bindings, aliases);
}

/** Resolves a bare type name through `aliases` — every annotation path must
 * consult it, so an aliased import (`import Foo as Bar`) still binds to the
 * original name callers actually search for. See the "aliases already
 * resolved" contract above. */
function resolveAlias(name: string, aliases: Map<string, string>): string {
  return aliases.get(name) ?? name;
}

function pyTypeName(node: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (!node) return null;
  if (node.type === "identifier") return resolveAlias(node.text, aliases);
  if (node.type === "type") {
    const inner = node.namedChildren[0];
    return inner?.type === "identifier" ? resolveAlias(inner.text, aliases) : null;
  }
  return null;
}

function callTypeName(node: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (node?.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "identifier") return null;
  return aliases.get(fn.text) ?? fn.text;
}

/** Swift variable->type bindings from the confident, syntax-local clues:
 * a typed parameter (`func feed(animal: Animal)`, `init(keeper k: Keeper)` —
 * the LAST simple_identifier before the `:` is the local name, the first may be
 * an external argument label), a typed property (`var d: Doctor`), and an
 * initializer-call assignment (`let vet = Vet()` — an initializer call is an
 * ordinary call whose callee is the type's own UpperCamelCase name; Swift's
 * naming convention makes the case split reliable, the same way Go's `NewX`
 * convention is trusted in handleGo). A property directly inside a type body is
 * a field: bound at the type's scope, both bare (`repo.save()`) and
 * `self.`-prefixed (`self.repo.save()`), like Java's fields. */
function handleSwift(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
): void {
  const scopePath = scope.join(".");
  if (node.type === "parameter") {
    const ids = node.namedChildren.filter((c) => c.type === "simple_identifier");
    const name = ids.at(-1)?.text;
    const type = swiftTypeName(
      node.namedChildren.find((c) => c.type === "user_type" || c.type === "optional_type"),
    );
    if (name && type) bindings.set(scopePath, name, type);
    return;
  }
  if (node.type !== "property_declaration") return;
  const name = node.namedChildren
    .find((c) => c.type === "pattern")
    ?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
  if (!name) return;
  const annotated = node.namedChildren
    .find((c) => c.type === "type_annotation")
    ?.namedChildren.find((c) => c.type === "user_type" || c.type === "optional_type");
  const type =
    swiftTypeName(annotated) ??
    swiftCtorTypeName(node.namedChildren.find((c) => c.type === "call_expression"));
  if (!type) return;
  const isField = node.parent?.type === "class_body" || node.parent?.type === "protocol_body";
  const target = isField ? (classScope ?? scopePath) : scopePath;
  bindings.set(target, name, type);
  if (isField) bindings.set(target, `self.${name}`, type);
}

/** A Swift type node's bare name: a `user_type`'s LAST type_identifier (so a
 * module-qualified `Foundation.Date` binds as `Date`, generic arguments live in
 * nested nodes and never leak in), unwrapping one level of optional (`Animal?`).
 * Collections, tuples, and function types bind nothing — no single confident
 * receiver type to name. */
function swiftTypeName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "optional_type") {
    return swiftTypeName(node.namedChildren.find((c) => c.type === "user_type"));
  }
  if (node.type !== "user_type") return null;
  const ids = node.namedChildren.filter((c) => c.type === "type_identifier");
  return ids.at(-1)?.text ?? null;
}

/** The type constructed by an initializer call (`Vet()` → `Vet`), or null when
 * the callee isn't a bare UpperCamelCase name — a lowercase callee is an
 * ordinary function whose return type a single-file pass cannot know. */
function swiftCtorTypeName(call: Parser.SyntaxNode | null | undefined): string | null {
  if (call?.type !== "call_expression") return null;
  const fn = call.namedChildren[0];
  if (fn?.type !== "simple_identifier") return null;
  return /^[A-Z]/.test(fn.text) ? fn.text : null;
}

/** PHP variable->type bindings from the two confident, syntax-local clues:
 * a type-hinted parameter (`function f(Foo $x)`) and a `new` assignment
 * (`$x = new Foo()`). Keyed by the `$var` text (with the `$`) so a
 * `$var->method()` call site resolves through resolveRecvType's bindings
 * lookup, exactly like Python's annotated params and Go's receiver. */
function handlePhp(node: Parser.SyntaxNode, scope: string[], bindings: FileBindings): void {
  if (node.type === "simple_parameter") {
    const type = phpTypeName(node.childForFieldName("type"));
    const name = node.childForFieldName("name");
    if (type && name?.type === "variable_name") bindings.set(scope.join("."), name.text, type);
    return;
  }
  if (node.type === "assignment_expression") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (left?.type === "variable_name" && right?.type === "object_creation_expression") {
      const type = phpNewType(right);
      if (type) bindings.set(scope.join("."), left.text, type);
    }
  }
}

/** Closure name, duplicated from extract.ts's `phpClosureName` (this file must
 * not value-import extract.ts) so the two scope stacks agree on the segment a
 * closure pushes. The right-hand-side check compares node `.id` rather than
 * `===` on wrappers for the same reason as extract.ts: wrapper identity is not
 * stable across traversals, so `===` can spuriously fall through to `{closure}`
 * and desync this scope segment from the one extract.ts mints. */
function phpClosureName(node: Parser.SyntaxNode): string {
  const parent = node.parent;
  if (parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id) {
    const left = parent.childForFieldName("left");
    if (left?.type === "variable_name") return left.text.replace(/^\$/, "");
  }
  return "{closure}";
}

/** A PHP type hint's class name: unwrap `?T` (optional_type) and `named_type`,
 * de-qualify a namespaced name to its trailing segment. Null for primitives,
 * unions, and intersections (no single confident class to bind). */
function phpTypeName(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "named_type" || node.type === "optional_type") {
    return phpTypeName(node.namedChildren[0] ?? null);
  }
  if (node.type === "name") return node.text;
  if (node.type === "qualified_name") return node.text.replace(/^.*\\/, "");
  return null;
}

/** The class name of a `new Foo()` / `new App\Foo()`, de-qualified. */
function phpNewType(node: Parser.SyntaxNode): string | null {
  const cls = node.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
  return cls ? cls.text.replace(/^.*\\/, "") : null;
}

function handlePy(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
): void {
  const scopePath = scope.join(".");
  if (node.type === "typed_parameter") {
    const nameNode = node.namedChildren.find((c) => c.type === "identifier");
    const typeName = pyTypeName(node.childForFieldName("type"), aliases);
    if (nameNode && typeName) bindings.set(scopePath, nameNode.text, typeName);
    return;
  }
  if (node.type !== "assignment") return;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left) return;
  if (left.type === "identifier") {
    const typeField = node.childForFieldName("type");
    const typeName = typeField ? pyTypeName(typeField, aliases) : callTypeName(right, aliases);
    if (typeName) bindings.set(scopePath, left.text, typeName);
  } else if (left.type === "attribute") {
    const obj = left.childForFieldName("object");
    const attr = left.childForFieldName("attribute");
    if (obj?.type === "identifier" && (obj.text === "self" || obj.text === "cls") && attr) {
      const typeName = callTypeName(right, aliases);
      if (typeName) bindings.set(classScope ?? scopePath, `self.${attr.text}`, typeName);
    }
  }
}

function tsAnnotationTypeName(
  typeAnn: Parser.SyntaxNode | null | undefined,
  aliases: Map<string, string>,
): string | null {
  if (!typeAnn || typeAnn.type !== "type_annotation") return null;
  const t = typeAnn.namedChildren[0];
  return t?.type === "type_identifier" ? resolveAlias(t.text, aliases) : null;
}

function tsNewTypeName(value: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (value?.type !== "new_expression") return null;
  const ctor = value.childForFieldName("constructor");
  if (ctor?.type !== "identifier") return null;
  return aliases.get(ctor.text) ?? ctor.text;
}

function handleTs(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
): void {
  const scopePath = scope.join(".");
  if (node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && FN_VALUE_TYPES.has(value.type)) return; // a function def, not a type binding
    const name = node.childForFieldName("name");
    if (name?.type !== "identifier") return;
    const typeName = tsNewTypeName(value, aliases) ?? tsAnnotationTypeName(node.childForFieldName("type"), aliases);
    if (typeName) bindings.set(scopePath, name.text, typeName);
  } else if (node.type === "public_field_definition") {
    const name = node.childForFieldName("name");
    if (!name) return;
    const typeName =
      tsAnnotationTypeName(node.childForFieldName("type"), aliases) ??
      tsNewTypeName(node.childForFieldName("value"), aliases);
    if (typeName) bindings.set(classScope ?? scopePath, `this.${name.text}`, typeName);
  } else if (node.type === "required_parameter") {
    const pattern = node.childForFieldName("pattern");
    if (pattern?.type !== "identifier") return;
    const typeName = tsAnnotationTypeName(node.childForFieldName("type"), aliases);
    if (!typeName) return;
    bindings.set(scopePath, pattern.text, typeName);
    // A parameter PROPERTY (`constructor(private readonly svc: Svc){}`) is a parameter
    // AND a class field, so `this.svc` must resolve to its type — the default DI idiom
    // in NestJS/Angular. The plain-parameter binding above keys on the bare name and at
    // the constructor scope, which `this.svc.method()` call sites never reach; without
    // the field-style binding here their recvType is undefined and the call edge is
    // dropped (#76). Detected by the modifier child a plain parameter never carries.
    const isParamProperty = node.children.some(
      (c) => c.type === "accessibility_modifier" || c.type === "readonly" || c.type === "override_modifier",
    );
    if (isParamProperty) bindings.set(classScope ?? scopePath, `this.${pattern.text}`, typeName);
  }
}

/**
 * Java bindings: locals, parameters, and fields.
 *
 * Java looks like the easy case — it is statically typed, so a declaration states
 * its own type with no inference needed. In practice modern Java leans on `var`,
 * which carries no type at the declaration site. Upstream's documented limit was
 * that a `var` local's member calls stay unresolved; this pass recovers them by
 * falling back to a `new X()` initializer when the declared type is absent or
 * `var`, covering locals, fields, and try-with-resources the same way.
 *
 * Varargs (`String... xs`), try-with-resources (`try (Foo f = ...)`),
 * enhanced-for (`for (Foo x : xs)`), and catch parameters (`catch (E e)`) also
 * bind their names, so a member call on any of them resolves through the bound
 * type rather than falling back to name-only resolution.
 *
 * Fields are recorded twice: bare (`repo.save()`) and `self.`-prefixed
 * (`this.repo.save()`), since resolveRecvType normalizes `this.` to `self.`.
 */
function handleJava(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
): void {
  const scopePath = scope.join(".");

  // formal_parameter: `Foo bar` in method/constructor signatures
  if (node.type === "formal_parameter") {
    const type = javaTypeName(node.childForFieldName("type"));
    const name = node.childForFieldName("name");
    if (type && name?.type === "identifier") bindings.set(scopePath, name.text, type);
    return;
  }

  // spread_parameter (varargs): `Foo... args` — tree-sitter gives this a distinct
  // node type with no field names; the type is the first named child and the name
  // lives inside a `variable_declarator`.
  if (node.type === "spread_parameter") {
    const typeNode = node.namedChildren.find((c) => c.type !== "variable_declarator");
    const name = node.namedChildren.find((c) => c.type === "variable_declarator")?.childForFieldName("name");
    const type = javaTypeName(typeNode);
    if (type && name?.type === "identifier") bindings.set(scopePath, name.text, type);
    return;
  }

  // resource (try-with-resources): `try (Foo f = new Foo())` — the `resource` node
  // has `type`, `name`, and `value` fields, binding like a local. `var f = new Foo()`
  // falls back to the constructed type.
  if (node.type === "resource") {
    const name = node.childForFieldName("name");
    const type = javaTypeName(node.childForFieldName("type")) ?? javaNewTypeName(node.childForFieldName("value"));
    if (type && name?.type === "identifier") bindings.set(scopePath, name.text, type);
    return;
  }

  // enhanced_for_statement: `for (Foo f : items)` — the loop variable `f` is typed
  // by the `type` field; bind it under the lexical scope so `f.method()` inside the
  // loop body resolves.
  if (node.type === "enhanced_for_statement") {
    const name = node.childForFieldName("name");
    const type = javaTypeName(node.childForFieldName("type"));
    if (type && name?.type === "identifier") bindings.set(scopePath, name.text, type);
    return;
  }

  // catch_formal_parameter: `catch (Exception e)` — tree-sitter gives this a
  // distinct node type (not `formal_parameter`); the type lives in a `catch_type`
  // child (which holds one `type_identifier`, or several for multi-catch
  // `IOException | BizException` — bind the first).
  if (node.type === "catch_formal_parameter") {
    const name = node.childForFieldName("name");
    const catchType = node.namedChildren.find((c) => c.type === "catch_type");
    const typeNode = catchType?.namedChildren.find(
      (c) => c.type === "type_identifier" || c.type === "scoped_type_identifier" || c.type === "identifier",
    );
    const type = javaTypeName(typeNode);
    if (type && name?.type === "identifier") bindings.set(scopePath, name.text, type);
    return;
  }

  if (node.type !== "local_variable_declaration" && node.type !== "field_declaration") return;

  const isField = node.type === "field_declaration";
  const target = isField ? (classScope ?? scopePath) : scopePath;

  for (const d of node.namedChildren) {
    if (d.type !== "variable_declarator") continue;
    const name = d.childForFieldName("name");
    if (name?.type !== "identifier") continue;
    // Declared type first; fall back to a `new X()` initializer when the type is
    // absent or `var` (upstream's documented limit) — recovers the common
    // `var x = new Foo()` shape without guessing at call-return inference.
    const type = javaTypeName(node.childForFieldName("type")) ?? javaNewTypeName(d.childForFieldName("value"));
    if (!type) continue;
    bindings.set(target, name.text, type);
    if (isField) bindings.set(target, `self.${name.text}`, type);
  }
}

/** A Java type node's bare name. `var` is the inferred-local keyword and states no
 * type, so it binds nothing. A generic binds to its erasure (`List<Order>` → `List`),
 * a qualified type to its final segment (`java.util.List` → `List`), and an array
 * to its element type (`Foo[]` → `Foo`). */
function javaTypeName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "type_identifier") return node.text === "var" ? null : node.text;
  if (node.type === "generic_type") {
    const base = node.namedChildren[0];
    return base ? javaTypeName(base) : null;
  }
  if (node.type === "scoped_type_identifier") {
    return node.namedChildren.at(-1)?.text ?? null;
  }
  if (node.type === "array_type") {
    const el = node.childForFieldName("element") ?? node.namedChildren.find((c) => c.type !== "dimensions");
    return el ? javaTypeName(el) : null;
  }
  return null;
}

/** The type constructed by a `new X(...)` expression, or null when the value is
 * not an `object_creation_expression` (or the constructed type isn't a bare
 * `type_identifier`/`scoped_type_identifier`/`generic_type`). Used as the
 * fallback for a `var`-typed or untyped local/field/resource whose initializer
 * is a construction — the one shape a single-file pass can infer with no
 * return-type analysis. */
function javaNewTypeName(value: Parser.SyntaxNode | null | undefined): string | null {
  if (value?.type !== "object_creation_expression") return null;
  return javaTypeName(value.childForFieldName("type"));
}

function handleGo(node: Parser.SyntaxNode, scope: string[], bindings: FileBindings): void {
  const scopePath = scope.join(".");
  if (node.type === "var_spec") {
    const name = node.childForFieldName("name");
    let type = node.childForFieldName("type");
    if (type?.type === "pointer_type") type = type.namedChildren.at(-1) ?? null;
    if (name?.type === "identifier" && type?.type === "type_identifier") {
      bindings.set(scopePath, name.text, type.text);
    }
    return;
  }
  if (node.type !== "short_var_declaration") return;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left || !right) return;
  const names = left.namedChildren;
  const exprs = right.namedChildren;
  for (let i = 0; i < names.length; i++) {
    const nameNode = names[i];
    let expr = exprs[i];
    if (!nameNode || nameNode.type !== "identifier" || !expr) continue;
    if (expr.type === "unary_expression") {
      expr = expr.namedChildren.find((c) => c.type === "composite_literal") ?? expr;
    }
    let typeName: string | null = null;
    if (expr.type === "composite_literal") {
      const t = expr.childForFieldName("type");
      typeName = t?.type === "type_identifier" ? t.text : null;
    } else if (expr.type === "call_expression") {
      const fn = expr.childForFieldName("function");
      // Go convention: NewX(...) binds to X.
      if (fn?.type === "identifier" && /^New[A-Z]/.test(fn.text)) typeName = fn.text.slice(3);
    }
    if (typeName) bindings.set(scopePath, nameNode.text, typeName);
  }
}

/** C# binds every declared-type site it can read cheaply: fields, properties,
 * parameters, and locals (explicit type, or `var` with a `new T()` initializer).
 * Fields/properties are set under both the bare name and a `this.`-prefixed name —
 * C# needs no `this.` to reach its own members, so a bare receiver (`_foo.Bar()`)
 * must resolve too, not just an explicit `this._foo.Bar()` (which resolveRecvType
 * already checks the `this.`-prefixed key for, same as TS/Python). */
function handleCSharp(node: Parser.SyntaxNode, scope: string[], classScope: string | null, bindings: FileBindings): void {
  const scopePath = scope.join(".");
  if (node.type === "field_declaration") {
    const varDecl = node.namedChildren.find((c) => c.type === "variable_declaration");
    const typeName = csTypeNameOf(varDecl?.childForFieldName("type"));
    if (!typeName || !varDecl) return;
    const target = classScope ?? scopePath;
    for (const decl of varDecl.namedChildren.filter((c) => c.type === "variable_declarator")) {
      const name = decl.childForFieldName("name")?.text;
      if (!name) continue;
      bindings.set(target, name, typeName);
      bindings.set(target, `this.${name}`, typeName);
    }
    return;
  }
  if (node.type === "property_declaration") {
    const typeName = csTypeNameOf(node.childForFieldName("type"));
    const name = node.childForFieldName("name")?.text;
    if (!typeName || !name) return;
    const target = classScope ?? scopePath;
    bindings.set(target, name, typeName);
    bindings.set(target, `this.${name}`, typeName);
    return;
  }
  if (node.type === "parameter") {
    const typeName = csTypeNameOf(node.childForFieldName("type"));
    const name = node.childForFieldName("name")?.text;
    if (typeName && name) bindings.set(scopePath, name, typeName);
    return;
  }
  if (node.type !== "local_declaration_statement") return;
  const varDecl = node.namedChildren.find((c) => c.type === "variable_declaration");
  if (!varDecl) return;
  const typeNode = varDecl.childForFieldName("type");
  for (const decl of varDecl.namedChildren.filter((c) => c.type === "variable_declarator")) {
    const nameField = decl.childForFieldName("name");
    const name = nameField?.text;
    if (!name) continue;
    let typeName: string | null = null;
    if (typeNode && typeNode.type !== "implicit_type") {
      typeName = csTypeNameOf(typeNode);
    } else {
      // `var x = new Foo();` — infer from the initializer's constructed type.
      const init = decl.namedChildren.find((c) => c !== nameField);
      if (init?.type === "object_creation_expression") typeName = csTypeNameOf(init.childForFieldName("type"));
    }
    if (typeName) bindings.set(scopePath, name, typeName);
  }
}
