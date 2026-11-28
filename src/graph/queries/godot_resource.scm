; Index declarations local to a Godot text scene or resource. The grammar exposes quoted
; names as whole tokens. Resource paths are searchable declaration labels.
; Parent paths, inherited nodes, and signal connections require resolution
; outside this query.
((section
  . (identifier) @_section
  (attribute (identifier) @_key (string) @name)) @definition.object
  (#eq? @_section "node")
  (#eq? @_key "name"))

((section
  . (identifier) @_section
  (attribute (identifier) @_key [(string) (integer)] @name)) @definition.variable
  (#eq? @_section "sub_resource")
  (#eq? @_key "id"))

((section
  . (identifier) @_section
  (attribute (identifier) @_key (string) @name)) @definition.variable
  (#eq? @_section "ext_resource")
  (#eq? @_key "path"))

((section
  . (identifier) @_section
  (attribute (identifier) @_key (string) @name)) @definition.variable
  (#eq? @_section "gd_resource")
  (#eq? @_key "type"))
