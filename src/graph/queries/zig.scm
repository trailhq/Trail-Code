; Zig — breadth-tier tags.scm
;
; Without this query the node-kind walker fallback runs, which:
;   - mints `const Point = struct { … }` as a variable (`variable_declaration`
;     matches `(^|_)(var|…)`)
;   - skips `test_declaration` (no kind after the declaration suffix)
;   - never emits call edges, so `graft callers` is empty
;
; Captures are the shapes confirmed against tree-sitter-wasm's zig grammar:
;   - `fn helper(n: i32) i32 { … }` / `pub fn run` → function_declaration
;   - `const Point = struct { … }` → variable_declaration + struct_declaration
;   - `test "name" { … }` → test_declaration with a string (unnamed `test { }`
;     has no name token and is left untagged)
;   - `helper(n)` / `p.local()` → call_expression
;
; Not captured (drop-not-guess): `const p = Point{ … }` (struct_initializer,
; not a type def), enum/union, unnamed tests.

(function_declaration
  name: (identifier) @name) @definition.function

(variable_declaration
  (identifier) @name
  (struct_declaration)) @definition.struct

(test_declaration
  (string) @name) @definition.function

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (field_expression
    member: (identifier) @name)) @reference.call
