---
title: Use the bundled Godot grammars for symbol indexing
author: Mihai Plaiasu
date: 2026-11-28
branch: feat/godot-indexing
id: l-1f676a99
scope: repo
status: active
src: agent
touches:
  - src/graph/generic.ts
  - src/graph/queries/gdshader.scm
  - src/graph/queries/godot_resource.scm
---

## Decided

Use the bundled Godot grammars and tag queries to add searchable symbols through the generic extractor. Godot shader calls use ordinary name resolution. Scene and resource queries expose declarations and paths as searchable labels.

## Tried and ruled out

The GLSL grammar produced parse errors on Godot uniform hints. The dedicated shader grammar parsed the fixture, and a custom query captured declarations while excluding hint expressions from call edges.

A scene-link prototype needed project-root discovery and lookup across scene sections and scripts. That changed shared graph behavior, so the contribution keeps scene and resource coverage at the symbol level.

## Watch out

Keep whole shader declarations as the definition span so type and qualifier edits affect the symbol's body hash. The generic extractor deduplicates definitions by start offset, so it indexes the first name in a comma-separated varying or constant declaration. Cross-file shader calls resolve by name without following shader includes.

The bundled scene grammar can recover from unsupported syntax in property values. A clean graph check alone does not establish that every scene property parsed. Resource paths in declaration labels do not create dependency edges.

In the code: tree-sitter-wasm@2.0.4 supplies gdshader and godot_resource. See src/graph/queries/gdshader.scm, src/graph/queries/godot_resource.scm, and test/graph-godot-formats.test.ts.
