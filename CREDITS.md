# Credits

## Language support

The graft map's multi-language support was shaped by community contributors who opened
language pull requests. That wave of one-language-at-a-time PRs is exactly what
motivated the generic breadth tier (one tree-sitter grammar + `tags.scm` per
language) that now covers most of them. With gratitude to:

- **@muneebshere** (#38) — Dart & Kotlin. Both are now supported via the breadth tier.
- **@reinhardtb** (#46) — C#.
- **@jhouserizer** (#53) and **@dbianco** (#83) — Java.
- **@qoole** (#59) — Rust; (#58) — PowerShell; (#40) — the tree-sitter 0.25 runtime bump.
- **@williamdes** (#64) — PHP.
- **@edrethardo** (#67) — C/C++ and the "fail loudly on unsupported languages" idea (#66),
  which the breadth tier addresses by routing unknown extensions to a generic
  extractor instead of skipping them.
- **@kapelner** (#69) — C/C++; (#70) — R.
- **@CroissantEdit** (#187) — Lua.
- **@Ansh-Sonkusare** (#159) — Nix.
- **@shovelmn12** (#130) — Kotlin, promoted to full-fidelity depth extraction.
- **@mattstrayer** (#219) — Swift.

If you contributed a language PR and aren't listed here, please open an issue —
the omission is an oversight, not a slight.
