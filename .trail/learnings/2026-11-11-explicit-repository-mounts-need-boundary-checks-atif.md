---
title: Explicit repository mounts need boundary checks and retarget detection
author: Atif
date: 2026-11-11
branch: atif_symlink
id: l-467468cd
scope: repo
status: active
src: agent
touches:
  - src/ingest/fs.ts
  - src/graph/fingerprint.ts
  - test/graph-follow-nested-repos.test.ts
---

## Decided
Review of atif_symlink at a18b1bc found two reproducible gaps before merging. Preserve main's independent submodule and nested-repository opt-ins when admitting explicit mounts. Capture physical repository targets during the existing file walk and persist them in the fingerprint. A changed target makes freshness unknown, forcing one rebuild that hashes source bytes and saves the new identity. This avoids trusting identical file stats from a different checkout without adding another enumeration or hashing every file on every query. Keep older fingerprints readable so their saved filters survive the one-time identity-aware rebuild.

## Tried and ruled out
The 37 existing ingest, nested-repo, only-dir and context-only-dir tests all passed, but do not establish these edge cases. A temporary Git fixture with a mode-160000 entry returned no files with followNestedRepos=true and followSubmodules=false; adding that path to includeIgnoredRepos returned the child's source. A second fixture built a linked repo then retargeted the link to another repo with different equal-length source and equal mtimes. Default probeDrift reported clean; GRAFT_REFRESH=hash detected the changed file. Therefore file-list parity and ordinary edit-refresh tests alone are insufficient.

## Watch out
Keep logical mount paths for graph IDs and physical checkout paths for cycle/target identity. Do not replace recursion-stack cycle detection with global realpath deduplication without deciding how multiple mount aliases should behave. The stat shortcut predates this branch; symlink retargeting gives it a new trigger. Explicit mount admission must not change a gitlink into a nested clone: classify first, then apply the independent traversal gate. Record target identity before invoking Git so filesystem fallback also retains it.

In the code: src/ingest/fs.ts explicit entries and followChild; src/graph/fingerprint.ts probeDrift and statUnchanged; test/graph-follow-nested-repos.test.ts. Run the four targeted test files with node --import tsx --test and test-local Git signing disabled.
