; Godot shading language. Shader includes use the same grammar.
(function_definition declarator: (identifier) @name) @definition.function
(struct_definition name: (identifier) @name) @definition.struct
(uniform_declaration declarator: (identifier) @name) @definition.variable
(uniform_declaration
  declarator: (array_declarator declarator: (identifier) @name)) @definition.variable

; Keep the declared type and modifiers in each symbol's body by capturing the
; whole declaration. The generic extractor indexes only the first name in a
; comma-separated varying or constant declaration.
(varying_declaration
  declarator: [(identifier) @name
               (array_declarator declarator: (identifier) @name)]) @definition.variable

(source_file
  (const_declaration
    declarator: (init_declarator
      declarator: [(identifier) @name
                   (array_declarator declarator: (identifier) @name)])) @definition.constant)
(preproc_define name: (identifier) @name) @definition.constant
(preproc_define_func name: (identifier) @name) @definition.constant

; Hints such as hint_range(...) are syntactically call expressions, too.
; Match calls in expression contexts and leave include resolution to Godot.
[
 (argument_list (call_expression function: (identifier) @name) @reference.call)
 (assignment_expression (call_expression function: (identifier) @name) @reference.call)
 (binary_expression (call_expression function: (identifier) @name) @reference.call)
 (comma_expression (call_expression function: (identifier) @name) @reference.call)
 (expression_statement (call_expression function: (identifier) @name) @reference.call)
 (field_expression (call_expression function: (identifier) @name) @reference.call)
 (for_statement (call_expression function: (identifier) @name) @reference.call)
 (init_declarator (call_expression function: (identifier) @name) @reference.call)
 (initializer_list (call_expression function: (identifier) @name) @reference.call)
 (parenthical_expression (call_expression function: (identifier) @name) @reference.call)
 (return_statement (call_expression function: (identifier) @name) @reference.call)
 (subscript_expression (call_expression function: (identifier) @name) @reference.call)
 (ternary_expression (call_expression function: (identifier) @name) @reference.call)
 (unary_expression (call_expression function: (identifier) @name) @reference.call)
 (update_expression (call_expression function: (identifier) @name) @reference.call)
]
