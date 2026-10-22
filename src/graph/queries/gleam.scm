; Gleam tags for graft's generic breadth tier. Gleam v1 syntax: the pre-1.0
; `external fn` / `external type` declarations are gone, replaced by an
; `@external` attribute that parses as a sibling `attribute` node beside an
; ordinary `function` — so the rules below already cover it.
;
; Qualified calls (`list.map(…)`) are deliberately NOT captured here. The
; grammar gives only the bare label (`map`), and since EVERY stdlib call in
; Gleam is spelled that way, a bare-name edge collides with in-repo names
; constantly. generic.ts's Gleam pass re-reads those calls alongside the file's
; import table, where the qualifier can be tied to the module it names.

(function name: (identifier) @name) @definition.function

(constant name: (identifier) @name) @definition.constant

(type_definition
  (type_name
    name: (type_identifier) @name)) @definition.type

(type_alias
  (type_name
    name: (type_identifier) @name)) @definition.type

; A data constructor IS a function in Gleam — `Busy(since: 0)` applies it and
; `list.map(xs, Some)` passes it as a value. Capturing it keeps a custom type's
; variants findable by name and gives construction sites something to point at.
(data_constructor
  name: (constructor_name) @name) @definition.function

(function_call
  function: (identifier) @name) @reference.call

; Construction, record update and destructuring all name a constructor. The
; first two apply it; the third takes it apart, which is the same dependency on
; the same callable — the breadth tier records all three as call edges, so a
; type that is only ever matched on does not read as unused.
(record
  name: (constructor_name) @name) @reference.call

(record_update
  constructor: (constructor_name) @name) @reference.call

(record_pattern
  name: (constructor_name) @name) @reference.call

; A type annotation is the only thing that ever names a Gleam type outside its
; own declaration, so without this a custom type is an orphan no matter how
; widely it is used. `type_name` (the declaration's own name) is a different node
; and is not matched here; builtins like `Int` resolve to nothing and drop.
(type
  name: (type_identifier) @name) @reference.class
