; GDScript (Godot). Grammar: tree-sitter-gdscript (wasm bundle).
; .gd only; no scene/resource parsing, autoloads, or editor integration.
; class_name spans its declaration, not the whole script.

(class_name_statement
  name: (name) @name) @definition.class

(class_definition
  name: (name) @name) @definition.class

; Parent anchors distinguish methods/functions; lambdas have no symbol.
; Lambda calls belong to the enclosing definition, or the file.
(class_body
  (function_definition name: (name) @name) @definition.method)
(source
  (function_definition name: (name) @name) @definition.function)
; The bundled grammar uses constructor_definition only for script-level _init;
; inner-class _init is a function_definition, covered by the method pattern.
(source
  (constructor_definition "_init" @name) @definition.function)

; Signals are searchable symbols only. Generic name resolution cannot connect
; emit/connect calls to their signal receiver or interpret emit_signal strings.
(signal_statement
  name: (name) @name) @definition.property

(enum_definition
  name: (name) @name) @definition.enum

; Anonymous enum members are constants in the enclosing scope.
(enum_definition
  !name
  body: (enumerator_list
    (enumerator left: (identifier) @name) @definition.constant))

; Class-level const/var only. A bare `(variable_statement)` would also match
; every local inside a function body — on a real Godot repo that is ~40k nodes
; of noise that buries the symbols an agent is actually looking for.
(source
  (const_statement
    name: (name) @name) @definition.constant)

(class_body
  (const_statement
    name: (name) @name) @definition.constant)

(source
  (variable_statement
    name: (name) @name) @definition.property)

(class_body
  (variable_statement
    name: (name) @name) @definition.property)

; Calls resolve by name, without receiver typing or super dispatch.
; Thing.new() names new; it does not resolve to Thing._init().
; Paths passed to load() and preload() produce no file dependency edges.
(call
  (identifier) @name) @reference.call

(attribute_call
  (identifier) @name) @reference.call

(base_call
  (identifier) @name) @reference.call

; Simple named inheritance with an enclosing definition: inline class_name
; extends and inline/separate inner-class extends. A separate top-level extends
; has no enclosing definition and is dropped by the generic extractor.
; Qualified/path inheritance and type annotations are omitted; external types drop.
(extends_statement (type . (identifier) @name .)) @reference.class
