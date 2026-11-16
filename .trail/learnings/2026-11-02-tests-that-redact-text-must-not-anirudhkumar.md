---
title: "Tests that redact text must not put the temp folder's path in that text, because CI's random folder names can look like keys"
author: Anirudhkumar-nanonets
date: 2026-11-02
branch: feat/share-session
cost: { minutes: 19, tokens: 171559 }
id: l-2630a536
scope: repo
status: active
src: agent
touches:
  - test/share-session.test.ts
  - src/notes/secrets.ts
  - scripts/run-tests.mjs
  - src/cloud/share-session.ts
---

## Decided
Fixture text that goes through the secret check or redaction uses a fixed, made-up folder (like `/work/web`) instead of the real temp folder. The real temp folder is still fine for where files live on disk; only the words inside the text must be fixed.

## Tried and ruled out
Reproducing with plain `/tmp`: 0 flags in 400 runs, because the paths stay under 40 characters. The flake only shows up with the test runner's nested temp folder.

## Watch out
The test runner gives each run its own temp folder, `/tmp/trail-test-run-XXXXXX`, so a scratch path has two random 6-character parts and is over 40 characters long. When one part has 3 or more capitals (`wRSnEe`), the path no longer counts as a path, and with a mixed part like `aB3cD9` the whole path is called "a long secret-looking string". On 2 Nov 2026 this turned a share-session preview test's 4 redactions into 5 on Linux CI only, at random.

In the code: `looksLikePath` and the long-random-string loop in `secretReason` (src/notes/secrets.ts); TMPDIR set in scripts/run-tests.mjs; fixed by `fakeSession` in test/share-session.test.ts using `cwd = "/work/web"`. Reproduce with `TMPDIR=$(mktemp -d /tmp/trail-test-run-XXXXXX)`.
