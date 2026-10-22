---
title: trail check flags a branch against its own new learning
author: Anirudhkumar-nanonets
date: 2026-10-19
branch: fix/trail-interview-bugs
---

## Decided
- On fix/trail-interview-bugs, `trail check` flagged 3 to 7 "conflicts" (the count changed between runs), all against the "Tried and ruled out" section of the learning that same branch adds. The code does what that learning decided, so the PR says why and ships as is.

## Watch out
- A learning's ruled-out words ("every non-git folder in init", "Sonnet ... trail ask") match the code that implements its decision, so a branch that adds a learning can conflict with itself. Read each flagged line before changing code; judge it against the learning's Decided section.
