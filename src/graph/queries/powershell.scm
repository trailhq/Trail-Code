; function and filter statements carry their name in the `function_name` leaf
; token (covers `function`, `filter`, and script-block bodies with a `param`).
(function_statement
  (function_name) @name) @definition.function

; cmdlet and script-function invocations are commands; graft resolves the
; bare-name edges (same-file first, unique-global inferred). Unmatched cmdlet
; names stay unresolved rather than guessed.
(command
  (command_name) @name) @reference.call
