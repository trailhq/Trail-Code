; OCaml — breadth-tier tags.scm
;
; Confirmed against the tree-sitter-wasm `ocaml` grammar AST (not ocaml_interface).
; Without this query the node-kind walker fallback runs: `value_definition`
; matches `(^|_)(val|…)` so `let helper x = …` is minted as kind `variable`,
; and there are no call edges.
;
; Function lets are a `let_binding` with a `parameter` child (`let f x = …`,
; including `let rec`) or a `fun_expression` / `function_expression` body
; (`let f = fun x -> …`). Plain value lets (`let n = 1`) have neither and
; are left untagged.
;
; Calls are `application_expression` with `function: (value_path …)`.
; Infix operators are `infix_expression` and are not tagged.

; `let f x = …` / `let rec f x = …` / `let f ~x = …` / `let f () = …`
(let_binding
  pattern: (value_name) @name
  (parameter)) @definition.function

; `let f = fun x -> …` / `let f = function y -> …`
(let_binding
  pattern: (value_name) @name
  body: [(fun_expression) (function_expression)]) @definition.function

(module_definition
  (module_binding (module_name) @name) @definition.module)

(type_definition
  (type_binding
    name: [
      (type_constructor) @name
      (type_constructor_path (type_constructor) @name)
    ]) @definition.type)

; `helper 2`, `M.inner x` (bare name is the last `value_name`)
(application_expression
  function: (value_path (value_name) @name)) @reference.call
