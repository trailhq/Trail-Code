; Emacs Lisp — the grammar exposes dedicated node types for common defining
; forms. `defun`/`defsubst` and `defvar`/`defconst` use `function_definition`
; and `special_form` nodes with terminal keyword children; `defmacro`,
; `defcustom`, and others are plain `list` forms headed by a `symbol`.

; Definitions

; * defun / defsubst
(function_definition name: (symbol) @name) @definition.function

; * defmacro
(macro_definition name: (symbol) @name) @definition.function

; * defvar / defconst — special_form nodes with terminal keyword children
(special_form "defvar" (symbol) @name) @definition.variable
(special_form "defconst" (symbol) @name) @definition.variable

; * defcustom / defvar-local / defvar-keymap — list forms headed by a symbol
(list
  .
  (symbol) @_kw
  .
  (symbol) @name
  (#any-of? @_kw "defcustom" "defvar-local" "defvar-keymap")) @definition.variable

; * defface
(list
  .
  (symbol) @_kw
  .
  (symbol) @name
  (#eq? @_kw "defface")) @definition.variable

; References

; * function calls — any list headed by a symbol. This over-generates (every
; binding head — a lambda-list parameter, a `let`/`let*` binding name, a bare
; `cond` clause test — is itself a `(list . (symbol) …)` and would otherwise be
; minted as a spurious call), so the three known binding-head shapes below are
; gated off via @reference.call.ignore: same start offset as the call it would
; otherwise produce, so generic.ts drops that match before emitting an edge.
(list . (symbol) @name) @reference.call

; * gate: a defun/defsubst/defmacro lambda-list's own parameter names
(function_definition
  parameters: (list . (symbol) @reference.call.ignore))
(macro_definition
  parameters: (list . (symbol) @reference.call.ignore))

; * gate: let / let* binding names — `(let ((prefix "/usr")) …)` must not read
; as a call to `prefix`
(special_form
  [ "let" "let*" ]
  (list
    (list . (symbol) @reference.call.ignore)))

; * gate: a bare `cond` clause test symbol — `(cond (t …))` must not read as
; a call to `t`
(special_form
  "cond"
  (list . (symbol) @reference.call.ignore))
