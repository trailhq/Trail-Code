# Vendored breadth grammars

`tree-sitter-luau.wasm` is the precompiled grammar from
[`tree-sitter-luau` 1.2.0](https://github.com/tree-sitter-grammars/tree-sitter-luau),
distributed under the adjacent MIT license.

SHA-256: `f1647052518f2bdfae8e8c0b033ffdeca1193d69d11c78ba20f84c8374fd0fe3`

The artifact is vendored because `tree-sitter-wasm` does not include Luau and
the grammar's npm package installs native dependencies that Graft does not use.
