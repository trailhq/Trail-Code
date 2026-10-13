# Respecting `.graftignore` (and `.cursorignore`, `--ignore-file`)

Design record: how graft keeps files out of its index while they stay tracked
and committed in Git — the semantics of graft's ignore files.

Status: implemented on `feat/graftignore`. The original ask was
"respect `.cursorignore`"; it grew into a small ignore-file system —
graft's own `.graftignore` first-class, `.cursorignore` when the repo is
wired for Cursor, and any additional file via `--ignore-file` — because the
three cases share one engine and one choke point.

## The requirement

A repo may carry files that should never be parsed, indexed, or searchable
through graft (`build`, `check`, `ask`, `grep`, `skeleton`, `callers`, MCP
tools) even though Git tracks and commits them:

- `.cursorignore` — Cursor's exclusion list (gitignore syntax). Graft should
  honor it **when this repo is wired for Cursor**.
- `.graftignore` — graft's own file. Same syntax, always honored when present.
- `--ignore-file <path>` — repeatable; any other file (`.aiderignore`, a
  team-local list, …). Additive over the above; a later file may re-include
  with `!` what an earlier one excluded.

## Why configuration alone cannot do this

Graft's file set **is** Git's file set. In a Git repo, `walkDir`
(`src/ingest/fs.ts`) enumerates via

```
git ls-files --cached --others --exclude-standard -z
```

(and the `--stage` variant for submodule following). Git's ignore rules only
gate *untracked* files. Verified empirically: a tracked file listed in
`.gitignore` is still emitted by `ls-files --cached --others
--exclude-standard`, is still `M` in `git status`, and `git check-ignore`
reports it as **not** ignored. Graft follows that contract deliberately.

Therefore, for the goal "in the repo, but not indexed":

- **Mirroring patterns into `.gitignore` / `.git/info/exclude` / a
  `core.excludesFile` does not work.** Tracked files remain enumerated, so
  graft keeps indexing them.
- **Untracked files are the wrong case entirely**: ignoring them keeps `git
  add .` from tracking them — the opposite of the requirement.

The only exclusion graft had was its hardcoded directory-name list
`SKIP_DIRS` (lifted per-repo by `--include-dir`), which applies to tracked
files too but only for those fixed names. There was no user-supplied pattern
file. Hence: a code change was required.

## Decisions

| Question | Decision |
|---|---|
| When is `.cursorignore` respected? | When the wiring stamp (`graft/.cache/wiring-stamp.json`) records **cursor** as a wired host — i.e. `graft init` wired it in — or when `--ignore-file` points at it. No env/host sniffing: the file set must be a function of the checkout, not of which process (CLI, hook, MCP) triggers the build. |
| `--ignore-file` vs the defaults | Additive and ordered: `.cursorignore` (if applied) → `.graftignore` → each `--ignore-file` in given order. Last matching rule wins, so a later file can negate an earlier one. `--no-graftignore` / `GRAFT_NO_GRAFTIGNORE=1` opts out (and suppresses starter creation). |
| Starter file | An explicit `graft build` creates a comments-only `.graftignore` when the repo has none — self-documenting, git-trackable, team-shareable. The query-path auto-refresh never writes into the source repo. |
| Persistence of `--ignore-file` | Not in `.graft/config.json`. Recorded in the **fingerprint** (the same precedent as `--only-dir`), so the probe and the auto-refresh re-apply it without the flag. |

## Where: one choke point

Every consumer that needs the file set funnels through `walkDir`
(`src/ingest/fs.ts`): `graph/build.ts`, `graph/scopes.ts`,
`graph/source-files.ts`, `context/build.ts`. `graft check` gets its set via
`listSourceFiles`, the drift probe via `listSourceStats`, and the pre-query
auto-rebuild via `buildGraph` — all the same walk. Filtering **inside
`walkDir`** — after Git enumeration, before `remapWalkPaths` — covers build,
check, scopes, the LLM context build, and the pre-query auto-refresh in one
place, and keeps `check` consistent with `build` (otherwise check would
report every excluded file as `removed` on every run).

## What: a gitignore-dialect filter over the final list

`src/ingest/ignore.ts` is the engine, independent of file names:

- `parseIgnoreText` — gitignore's pattern dialect: `#` comments, `!`
  negation, trailing `/` (directory), leading `/` (root-anchored), `*` / `?` /
  `[...]`, `**` spanning segments, bare names at any depth.
- `createMatcher` — the ordered rule stream, **last matching rule wins**.
- `resolveIgnoreSources(root, explicitFiles)` — assembles the sources in the
  fixed order above; missing files are skipped (presence is the opt-in, like
  `.gitignore`).

Two deliberate departures from Git, both required by the feature:

1. **The rules exclude TRACKED files.** That is why the filter runs on the
   enumerated set instead of being a git argument (see above).
2. **Cross-file last-match-wins.** Git evaluates one file's rules per path;
   graft layers several files, so an explicit list can re-include what
   `.graftignore` excluded.

Git's one hard constraint is kept and pinned by tests: once a *directory* is
excluded, its contents cannot be re-included (`build/` + `!build/keep.ts`
stays out, exactly as `git check-ignore` says), while `build/**` leaves the
contents negatable. The matcher was verified case-by-case against real git.

## The consistency contract

The file set a build sees must be the file set the probe, `check`, and the
auto-rebuild see — or every query reports phantom drift, or the rebuild
silently re-includes the excluded files. Ambient sources need no recording:
every walk re-reads `.graftignore` / `.cursorignore` from disk. Only the
ambient-independent `--ignore-file` list does, and it rides in the fingerprint
alongside `--only-dir`:

- `buildGraph` writes it (`writeFingerprint`),
- `probeDrift` reads it back,
- `checkGraph` reads it back,
- the pre-query auto-rebuild (`refresh.ts`) passes it to its `buildGraph`.

A fresh no-flag `graft build` is a fresh intent and re-widens — the same
contract as `--only-dir`.

## Precedence

- `.cursorignore` < `.graftignore` < `--ignore-file` (first to last). Graft's
  own file outranks the borrowed Cursor file; explicit flags outrank both.
- `--include-dir` only lifts `SKIP_DIRS`; an ignore match still excludes
  (an explicit "keep this out" beats a directory inclusion).
- A negation re-admits a file only when it is the last matching rule for that
  path (and the directory constraint above).

## Out of scope (deliberate)

- `--ignore-file` is not persisted in `.graft/config.json` (fingerprint only).
- Nested (subdirectory) ignore files: root-level only. Gitignore-style
  nesting is a cheap follow-up if needed (Cursor itself reads the repo root's
  file).
- Workspace children each resolve a relative `--ignore-file` against their own
  root and skip a file missing in a child — a child is its own repo with its
  own `.graftignore`.
- `graft blast` computes radius from `git diff` + the graph, not from
  `walkDir`; excluded files simply have no nodes, so they do not appear. No
  change needed.

## Verification

- `test/ingest-ignore.test.ts` — parser + matcher units: comments, `!`, `**`,
  leading `/`, trailing `/`, no-slash any-depth, character classes,
  last-match-wins across files, the directory-negation constraint, Windows
  separators, source-order resolution, `GRAFT_NO_GRAFTIGNORE`.
- `test/graph-graftignore.test.ts` — end-to-end through the real CLI: a
  TRACKED file excluded by `.graftignore` (absent from the graph, still clean
  in `git status`, `check` clean, probe clean), negation re-inclusion,
  `GRAFT_NO_GRAFTIGNORE`, a `dir/` rule, `.cursorignore` active only with the
  cursor wiring stamp, and the non-git filesystem walk.
- `test/graph-ignorefiles-fingerprint.test.ts` — the consistency contract:
  the explicit list recorded in the fingerprint, the no-flag probe clean,
  `checkGraph` clean, and the pre-query auto-rebuild re-applying it.
- `test/graph-cli-ignore-file.test.ts` — the flag itself: additive +
  repeatable, missing-path failure, starter creation (and not clobbering an
  existing file), `--no-graftignore`, and the fingerprint/no-flag probe.
