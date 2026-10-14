; Julia tags — graft's breadth tier. The tree-sitter-julia grammar ships no
; tags.scm upstream, so this is hand-written against its node vocabulary.
; Definitions name the innermost identifier; `Base.show(...)` and other
; qualified names take the last path segment. No named fields exist on
; call_expression / signature, so patterns anchor on child position.

; Modules
(module_definition
  name: (identifier) @name) @definition.module

; Long-form functions: `function f(x) ... end`, `function Base.show(io, x) ... end`,
; `function f(x::T) where {T} ... end`, `function f end`
(function_definition
  (signature
    (call_expression
      . (identifier) @name))) @definition.function

(function_definition
  (signature
    (call_expression
      . (field_expression
          (identifier) @name .)))) @definition.function

(function_definition
  (signature
    (where_expression
      . (call_expression
          . (identifier) @name)))) @definition.function

(function_definition
  (signature
    (where_expression
      . (call_expression
          . (field_expression
              (identifier) @name .))))) @definition.function

(function_definition
  (signature
    . (identifier) @name)) @definition.function

; Short-form functions: `f(x) = x`, `Base.show(io, x) = ...`, `f(x::T) where {T} = x`.
; The call must be the FIRST child of the assignment (the left-hand side);
; a call on the right-hand side is an ordinary reference.
(assignment
  . (call_expression
      . (identifier) @name)) @definition.function

(assignment
  . (call_expression
      . (field_expression
          (identifier) @name .))) @definition.function

(assignment
  . (where_expression
      . (call_expression
          . (identifier) @name))) @definition.function

(assignment
  . (where_expression
      . (call_expression
          . (field_expression
              (identifier) @name .)))) @definition.function

; Macros: `macro m(ex) ... end`
(macro_definition
  (signature
    (call_expression
      . (identifier) @name))) @definition.function

; Types: `struct S`, `mutable struct S{T} <: Super`, `abstract type A end`,
; `primitive type P 8 end`
(struct_definition
  (type_head
    . (identifier) @name)) @definition.struct

(struct_definition
  (type_head
    . (parametrized_type_expression
        . (identifier) @name))) @definition.struct

(struct_definition
  (type_head
    . (binary_expression
        . (identifier) @name))) @definition.struct

(struct_definition
  (type_head
    . (binary_expression
        . (parametrized_type_expression
            . (identifier) @name)))) @definition.struct

(abstract_definition
  (type_head
    . (identifier) @name)) @definition.type

(abstract_definition
  (type_head
    . (parametrized_type_expression
        . (identifier) @name))) @definition.type

(abstract_definition
  (type_head
    . (binary_expression
        . (identifier) @name))) @definition.type

(abstract_definition
  (type_head
    . (binary_expression
        . (parametrized_type_expression
            . (identifier) @name)))) @definition.type

(primitive_definition
  (type_head
    . (identifier) @name)) @definition.type

; Constants: `const K = 3`
(const_statement
  (assignment
    . (identifier) @name)) @definition.constant

; Calls: `f(x)`, `Mod.f(x)`, broadcast `f.(x)`. A call at a definition's own
; name token is dropped by the extractor (no self-loops).
(call_expression
  . (identifier) @name) @reference.call

(call_expression
  . (field_expression
      (identifier) @name .)) @reference.call

(broadcast_call_expression
  . (identifier) @name) @reference.call

(broadcast_call_expression
  . (field_expression
      (identifier) @name .)) @reference.call

; Supertype in `struct S <: Super` / `abstract type A <: Super` — a structural
; reference, resolved to the type definition when unique.
(type_head
  (binary_expression
    (operator)
    (identifier) @name .)) @reference.class
