# Changelog

## Unreleased

### Added

- **`graft build --include-dir` can opt a named hidden directory into the
  repo-root walk** (#221). Default is unchanged: `.github`, `.vscode`, `.kb`
  and every other dot-directory stay skipped. Pass `--include-dir .kb` (a
  bare name, same switch as `build/` / `vendor/`) and the walk descends into
  that directory so its nodes land on the same root graph the MCP server and
  hooks already point at. The choice persists in `.graft/config.json`, so a
  later no-flag build still includes it. `.git` is never overridable — the
  CLI rejects `--include-dir .git` with a non-zero exit. Git's ignore rules
  stay authoritative; the flag only lifts graft's own skip.

## 0.19.0

### Added

- **Push a repo's brain from the terminal** (#422): a loopback handoff hands the
  browser a finished brain instead of a half-built one — the push waits for the
  build, then lands the browser on the result.
- **A public repo can be read without installing the App** (#349): access is
  answered on its own, without first reading the repo.

### Fixed

- **The finished push lands in Trail** (#417), not on a local page, and signup
  goes to Trail's own front end rather than the shared agents host.
- **A repo read runs in a child process** so the app keeps answering while it
  works, and the digest finishes sending before the child disconnects.
- **Public reads borrow an installation token** instead of falling back to the
  anonymous rate limit.

## 0.18.0

### Added

- **Trail Brain integration** (#322): graft can build a *brain* from a repo and
  carry its rules into every `ask` — a two-way link, so retrieval is shaped by
  the team context a brain accumulates, not the code graph alone.
- **A brain verifies the checkout before it mines** (#344): graft checks the
  working copy against the repo a brain expects, so rules are never mined from
  the wrong tree.

### Fixed

- **A brain refreshes its rules from upkeep** (#343), so a single empty pull no
  longer leaves it stuck without rules.

## 0.17.0

### Added

- **Claude Code sessions now report the dollar value of what graft saved** (#282),
  not just the token count — the running total on the statusline is priced, so
  the payoff of routing a lookup through the graph instead of reading files whole
  is visible in the terminal.
- **`graft init` also writes the Claude Code wiring into `~`** (#276), so
  worktrees and fresh shells created off the same home keep graft available
  instead of losing the hooks and statusline the moment you leave the repo root.

### Fixed

- The **PR-review GitHub App** keeps its review pages on disk (#278) so posted
  links survive a restart, reviews **merged and closed PRs** via the head ref
  diffed against the merge base (#279, #280) so a merged PR keeps a working graph
  link, and **runs each review in its own process** (#281) so one slow review no
  longer blocks the server.
- **Green main** (#277): the telemetry test clears every CI environment variable
  before asserting, and the CodeQL action pins are realigned.

## 0.16.0

### Added

- **`graft init --no-statusline`** (and `GRAFT_NO_STATUSLINE=1`) skips writing
  Claude Code's `statusLine` / `subagentStatusLine`. A custom bar — in the
  project's `.claude/settings.json` or in `~/.claude/settings.json` — stays in
  front: a project-level field would otherwise hide the user-level one. The
  choice is recorded in the wiring stamp, so a later session refresh cannot
  put Graft's bar back. Graft still recognises its own helper
  (`graft-statusline.cjs`) and will update that command on re-init.

## 0.15.0

### Added

- **Swift gets full-fidelity (depth-tier) extraction**, promoted from the
  breadth tier the same way Kotlin was (#130) — whose swift tags query had no
  call captures at all, so Swift repos indexed symbols with zero wiring.
  `tree-sitter-swift` (native, `^0.7.1` — the first release whose install
  compiles the shipped parser instead of regenerating it, which broke under
  npm's hoisting; a root `overrides` entry pins its `tree-sitter` peer for dev
  installs) parses `.swift`. One `class_declaration` node covers `class` /
  `struct` / `enum` / `actor` / `extension`, told apart by their own keyword:
  class and actor → `class`, struct → `struct`, enum → `enum`, `protocol` →
  `interface`, `typealias` → `type`, top-level `let`/`var` → `variable`. An
  `extension Point` node takes the extended type's own name, so its members
  mint as Point methods and member calls on a Point receiver resolve to them.
  The extension node itself is kind `module`, not a second same-named class —
  otherwise every `Point()` call and `: Point` heritage target would go
  ambiguous and drop. `init` becomes a method named after its type (like a
  Java constructor); `func` is a method inside any type and a function
  elsewhere. Calls resolve via `call_expression` with `navigation_expression`
  / `self` / `super` receivers. A bare lowercase call inside a type body is
  ONE edge carrying both of its readings in Swift's own inner-scope-first
  order: the member reading first (owner-qualified index + the in-repo
  ancestor chain — a stdlib call like `contains` inside `extension Set`
  drops instead of binding to an unrelated type's only same-named method, a
  false positive dogfooding on swift-composable-architecture caught), then
  the free-function reading only when no member exists on the chain — so a
  name defined as both yields the member edge alone, as Swift dispatches it.
  `super.method()` resolves against the declaration's own superclass (the
  first `:` entry, which Swift's grammar puts before any protocol), climbing
  past the current class's override. Overloads disambiguate by declared
  arity vs call-site argument count (Java's exact mechanism — defaults and
  variadics make the arity a minimum); an overload set arity can't split
  (`save(Int)` vs `save(String)`) DROPS rather than taking the same-file
  tiebreak, which would stamp whichever overload appears first `extracted`.
  An initializer call (`Animal(legs: 4)` — an ordinary call node, no `new`)
  falls back to class/struct/enum targets once functions find nothing,
  Python's constructor-fallback shape. The `:` inheritance clause yields `extends`
  edges (bare names — Swift can't say syntactically which specifier is the
  superclass), `import` declarations yield module-path import edges, and
  visibility maps to `exported` as only `private`/`fileprivate` hidden —
  Swift's default `internal` is module-wide, which for a one-module repo is
  the API surface. A Swift bindings collector types receivers from the
  confident, syntax-local clues: typed parameters (`func feed(animal:
  Animal)`, argument labels handled), typed properties, initializer-call
  assignments (`let vet = Vet()` — UpperCamelCase callee, the same convention
  trust as Go's `NewX`), and fields bound both bare and `self.`-prefixed —
  so `vet.check()`, `keeper.wave()`, `self.repo.save()`, and type-member
  calls (`Animal.census()`) all resolve through the owner-qualified method
  index. A receiver with no local clue (a chained call's result) stays
  unresolved rather than guessed.
### Fixed

- **`allowScripts` now names R by the identity npm actually matches on.** The
  entry was `tree-sitter-r@1.3.0`, the alias in `dependencies`, but npm derives
  the identity from the resolved package in the lockfile —
  `@davisvaughan/tree-sitter-r@1.3.0`. The old key matched nothing, so the
  grammar's install script counted as unreviewed and was blocked;
  `npm ci --strict-allow-scripts` failed on it. Harmless in practice only
  because the package ships prebuilds for every supported platform. Note the
  `overrides` key must stay the alias — the two fields key differently.
- **`graft check` no longer reports every container-tier node as `removed`.**
  `checkGraph` branched on the depth and breadth tiers but never on the container
  tier the build uses for `.vue`, so `genericLangOf` returned null, a `generic!`
  assertion threw, and the catch swallowed it as a parse failure — every `.vue`
  node fell through to `removed` on a clean build, and the `graft build` the
  check told you to run had already written them. The check now mirrors the
  build's three-way branch, warms the container grammars alongside the generic
  ones, and treats "no tier claims this file" as an explicit case rather than a
  non-null assertion, so the next tier added fails in the type checker instead of
  silently reporting drift. ([#236](https://github.com/trailhq/Graft/issues/236))

### Added

- **Telemetry can now tell "graft saved tokens" apart from "the user was told".**
  `saved_tokens_bucket` counted what graft *computed* — every
  `[graft] tokens saved ≈ N` footer the PostToolUse accumulator swept up — so a
  turn that saved 20,000 tokens in silence and a turn that saved nothing were the
  same number. `session_summary` now also carries `graft_turns_bucket` and
  `reported_turns_bucket`: of the turns that used graft, how many closed with the
  one-line tally `SKILL.md` and `SAVINGS_TURN_NUDGE` both ask for.

  The agent's own prose lives in one place a hook can reach, so at the end of a
  turn that used graft the Stop hook reads the tail of the host transcript named
  on its stdin and checks the reply for a "graft saved ~N tokens" line. Only a
  count of turns is kept, and only as a bucket — no reply, no fragment, not even a
  length. `TELEMETRY.md` documents the local read in full.

  A turn that can't be checked — a host whose Stop hook names no transcript, an
  unreadable file, a Stop racing the transcript write — is counted in *neither*
  total, so the ratio means "of the turns we could read" rather than deflating to
  zero on every editor but Claude Code. One reply is one turn however often Stop
  fires, guarded by the id of the last reply examined.

- **`scripts/tally-audit.mjs`**, the same ratio offline and at full resolution:
  which turns were silent, whether the number the agent reported matched graft's
  own footers, and whether it named the call count. Run it when the aggregate says
  something surprising. It also flags per-turn savings estimates large enough to be
  artifacts rather than savings.


- **`graft init` converges instead of accumulating, and `graft uninstall` removes
  graft entirely.** `init` wrote the files the selected agents needed and never
  looked at the rest, so a repo wired by an older version — or by the same version
  with different `--agents` — kept that run's files forever, and the session-start
  refresh then kept them *up to date*. `init` now retracts every agent it isn't
  about to write, and `graft uninstall` retracts the lot.

  Only graft's own contribution is touched: inside a shared file just the
  marker-fenced block, inside a config just the `graft` key — foreign MCP servers,
  hooks, statuslines and ignore entries survive byte for byte. A file left holding
  nothing is deleted rather than truncated to an empty shell, and the directories
  that empties are pruned. An unparseable config is reported and left alone.
  `uninstall` is dry-run until `-y`.

  The target list is derived from the same registries `init` writes through, so a
  host added later is retractable for free; only a host *removed* from the registry
  needs a hand-written entry, and `LEGACY_TARGETS` says so. Exclusion is by path as
  well as by host id: three hosts write `AGENTS.md`, and keeping any one of them has
  to spare that block.

### Fixed

- **A stale `[mcp_servers.graft]` is now replaced instead of skipped.** The TOML
  writer returned early the moment the header existed, which froze the launch
  command at whatever the first `init` wrote — a repo wired when graft wasn't on
  `PATH` kept the slow `npx` form forever, and no upgrade could correct it. Codex
  and Grok both went through that path. Foreign tables are untouched either way.

- **`.claude/settings.json` no longer accumulates graft's own entries.** The
  allowlist and `footerLinksRegexes` were append-only, so a renamed invocation form
  stayed in the user's settings beside its replacement with nothing able to remove
  it. Both now drop graft's prior entries before adding the current set, the same
  way the hooks merge already did. Scoped to the forms graft is actually invoked as,
  so a hand-written `Bash(graft-mytool:*)` survives.

- **`graft blast` suggests who to tag.** The comment already named the areas a
  diff changes and the areas it can affect; it now names the people behind them,
  read from git history with no API call and no config file. One `git log` per
  area over that area's own files, weighted towards recent work (120-day
  half-life), with areas the diff only *reaches* counted at 0.6 against a changed
  area's 1.0 — the person whose code your change can break is exactly the
  reviewer the diff alone would never surface. The markdown report gains a `Tag:`
  line under the tests line and a collapsed `Who knows this code` table; the
  exported page gains initials badges on each bubble, a *Who knows this* block in
  the detail panel, and a `people` legend toggle.

  A handle is never guessed: only a GitHub noreply commit address resolves to
  `@mention`, and anyone else is printed as a plain unlinked name, because a
  guessed mention pings a stranger. A repo can fix that for good with a
  `.mailmap` entry, which git applies to the names `blast` reads. Merge commits,
  bots, everyone who authored a commit in the diff range, and — for a local run
  with no `--base` — your own git identity are all excluded. `--no-owners` turns
  the layer off; `--pr-author <who...>` takes logins, names or emails; the
  bundled action gains a `suggest-reviewers` input, defaulting true.

## 0.13.0

### Added

- **Grok (xAI) is a first-class `graft init` host.** Detects `~/.grok` or a
  repo `.grok/` and writes `.grok/skills/graft/SKILL.md` plus a repo-level
  `[mcp_servers.graft]` block in `.grok/config.toml` (Grok's MCP config).
  Select it with `graft init --agents grok`.
- **R language support.** `tree-sitter-r` (`npm:@davisvaughan/tree-sitter-r`;
  the unscoped npm name is a squatted placeholder) parses `.R`/`.r` files.
  Plain functions: every `name <- function(...)` / `name = function(...)` /
  `function(...) -> name` assignment becomes a `function` node (the grammar's
  `function_definition` has no name field, so the name comes from the
  enclosing assignment; right-assign has its own AST shape). Classes — R's
  class systems are library convention, not syntax, so they are recognised by
  call idiom: **R6** (`R6::R6Class(...)` — the class node, `public =`/
  `private =`/`active =` entries as methods, `inherit =` heritage, and `self$`/
  `private$`/`super$` calls resolving to the class or its parent), **S4**
  (`setClass()`/`setMethod()` with `contains =` heritage), **S3**
  (`generic.Class <- function()` only when `generic` is registered locally via
  `UseMethod()` or is one of a small curated base-R set — false negatives over
  false positives), and plain-list mixin bundles (`Foo <- list(public =
  list(...), ...)`) that are spliced across classes instead of inherited. An
  untyped `obj$method()` resolves by bare name to a uniquely-named method
  (ambiguous drops). Visibility: a roxygen `#' @export` tag wins; a roxygen
  block without it means "not exported"; no roxygen falls back to the
  leading-dot convention; R6 `private =` members are unexported.
  `library()`/`require()`/`source()` calls are the import edges. Known gaps:
  S3 generics registered in another file aren't seen (per-file pass); S4
  `signature()` multiple dispatch isn't handled; R6 active bindings are
  ordinary methods.
- **Resumable `graft build --deep`.** The concept phase now checkpoints
  summaries to disk atomically as it runs, so a build interrupted by a session
  or rate limit resumes where it stopped on the next run (content-hash cached,
  no repeated LLM cost) instead of restarting from zero.
- **Kotlin gets full-fidelity (depth-tier) extraction**, and **Lua** and **Nix**
  join the breadth tier. **Dart** now indexes top-level functions and consts.
- **Hermes Agent** is a first-class `graft init` host.
- **Every reported edge quotes the source line** where the call or reference
  happens, in the PR comment, the CLI, and one shared helper.

### Fixed

- **PHP.** Enums with array consts stay in the graph; trait-inherited method
  calls (`$this->traitMethod()`) resolve through the `implements` edge;
  attribute usage is wired as `references` edges; anonymous classes are minted
  as nodes with their `implements` edges.
- **Java.** Generic type arguments (`Base<Item>`) no longer become bogus
  `extends`/`implements` edges or poison call resolution; anonymous-class
  methods no longer take the enclosing type's owner, so calls resolve to the
  real method.
- **Python.** Constructor calls (`Foo()`) resolve to the class instead of being
  dropped.
- **Deep tier.** An empty meaning reply is no longer cached as a permanent
  `pending` state, and per-file failures surface instead of the build exiting
  successfully.
- **`graft ask`.** Distinct files are ranked ahead of one file's sibling spans
  under bounded output, and multi-scope workspaces score comparably across
  scopes.
- **Claude hooks, sync-run, and statusline respect `GRAFT_DIR`**, and the hook
  timeout is also read from user-level settings.
- **Ingest** skips the `_build/` directory (the underscore spelling of a build
  tree).

## 0.12.0

### Added

- **Kotlin moves to full-fidelity extraction.** `.kt` and `.kts` files are now
  parsed by a hand-written tree-sitter extractor — the same tier as TypeScript,
  Python, Go, and Java — instead of the generic breadth grammar, so Kotlin
  symbols, call edges, heritage, and imports resolve with scope awareness. The
  kind mapping now matches tree-sitter-kotlin's real node types (the earlier
  attempt reused Java's, which do not exist in the Kotlin grammar and emitted no
  symbols at all): `class_declaration` is re-read off its own keyword into
  class / interface / enum / annotation, `object` and `companion object` become
  classes, secondary constructors and member functions become methods,
  `typealias` becomes a type, and top-level `val`/`var` become variables.
- **Kotlin edges.** Calls resolve through `call_expression` (member calls via
  `navigation_expression`, with `this`/`super` receivers), the `:` heritage
  clause yields `extends` edges, `import_header` yields import edges, and
  `internal`/`private`/`protected` visibility maps to the exported flag.
### Changed

- **graft now collects anonymous usage stats, and the README no longer says it
  doesn't.** We had no way to tell whether a repo ever got past `graft build`,
  or whether an agent reaches for graft over grep once it has — npm downloads
  answer neither. Six events, all buckets and fixed enums: `first_run`,
  `init_completed`, `build_completed`, `build_failed`, `query`,
  `session_summary`. Never your code, file paths, repo name, symbols, queries,
  prompts, or error messages — [`TELEMETRY.md`](TELEMETRY.md) is the complete
  contract and `src/telemetry/contract.ts` enforces it as a hard allowlist, so
  a property that is not in the document cannot be sent even by accident.

  Identity is two random UUIDs (one per machine, one per checkout), derived from
  nothing; events are anonymous in PostHog with no person profile. Nothing is
  sent from a command you run — events queue locally and a detached process
  posts them at most once a day, so no query ever waits on the network.

  Off if you uncheck the box in `graft init`, run `graft telemetry disable`, set
  `DO_NOT_TRACK`, are in CI, or built from source (the key is stamped in only at
  publish time, so forks never send). `graft telemetry debug` prints the exact
  batch your machine would send, and sends nothing.

## 0.11.0

### Fixed

- **Node 24 no longer aborts breadth-tier builds with `Fatal process out of
  memory: Zone`.** The broader `tree-sitter-wasm` grammar bundle avoids the V8
  Turboshaft failure triggered by the previous bundle. CI now exercises every
  breadth grammar under Node 24 to keep that runtime compatibility pinned
  ([#122]).
- **`npm install -g @nanonets/graft@latest` could silently do nothing.** The
  generated shims (`.claude/helpers/graft-*.cjs`, and Codex's
  `~/.codex/hooks/graft/`) locate the installed package at runtime from four
  candidates, and took the *first* one that existed. The first is the absolute
  `dist/claude` path graft happened to be running from when `graft init` ran, so
  switching Node versions (nvm/volta) or moving the install left that directory
  on disk — still first, still winning — and the upgrade replaced a directory
  the shim never looked at. The upgrade appeared to succeed and changed nothing.
  The shims now read each candidate's `package.json` and load the
  **highest-versioned** one. The `npm root -g` subprocess is still reached only
  when all three cheap candidates miss, so hook latency is unchanged.

### Added

- **The wiring now follows the binary.** `graft init` writes files *into* a repo
  (hooks, shims, skill, rule files) and into `~/.codex`; upgrading the npm
  package replaced the binary and touched none of them, so a repo wired by 0.7
  kept 0.7's prompts and 0.7's hook timeouts indefinitely — and nothing
  agent-facing ever mentions `graft init`, so no agent would think to re-run it.
  `graft init` now records a stamp (version, hosts, flags) in
  `graft/.cache/wiring-stamp.json`; every entry point compares it against the
  running binary and re-runs the writes on a mismatch. Hosts come from the union
  of the stamp and what's on disk, so a rule file that went missing is restored
  rather than dropped from all future refreshes. The init flags are replayed, so
  a repo wired with `--no-global` or `--no-hooks` keeps that choice. The refresh
  never builds the graph (it runs at session start, where a rebuild would stall
  the first turn) and is fail-soft throughout.
- **An upgrade nudge.** A machine-global 24h cache
  (`~/.graft/update-check.json` — one registry request a day per machine, not
  per repo), filled by a detached `graft _update-check` child, feeds a one-line
  "newer version available" notice. Hooks only ever *read* that cache; the CLI
  and the MCP server are the fillers, because a hook that shelled out to
  `npm view` would spend its whole timeout on the network.
- Both run from one shared code path, called at three entry points so no host
  is left out: Claude Code's `SessionStart` hook, the MCP server's `initialize`
  (the only channel that reaches Cursor, which has no hooks — the lines ride in
  `instructions`, since stdout carries protocol messages only), and a CLI
  `preAction` hook for every command except `version`, `upgrade`, `mcp` and
  `_update-check`.

## 0.9.0

### Added

- **`graft build --include-dir <name>`** — an explicit, persisted override for
  `SKIP_DIRS` (repeatable: `--include-dir build --include-dir tools`). Some
  ecosystems keep genuine hand-written source under a directory name graft
  otherwise treats as build output (e.g. a `build/` that isn't generated).
  The override is persisted per repo in Git-ignored `.graft/config.json`: set
  it once and every later no-flag `graft build`, plus the hooks/refresh path
  (which never sees CLI flags at all), include it identically. It lifts only
  graft's own skip list — in a
  Git repository, Git's ignore rules stay authoritative, so a directory that
  is both skip-listed and gitignored needs un-ignoring (or `git add -f`) too,
  the same contract indexing already applies to tracked-but-ignored files.
  Dot-directories are never overridable. Reaches the wiring graph, the Tier-2
  markdown/concept pipeline, Go module discovery, and workspace child builds
  alike, and is validated up front (a bare directory name only — no paths, no
  dot-prefixes).

### Fixed

- **`graft map` no longer promotes unrelated methods into hubs and hotspots.**
  A member call with an unknown receiver could be wired to the repository's
  only method with the same bare name, so built-ins such as `Map.set()` inflated
  an unrelated user-defined `set` method. Member calls now require an
  owner-qualified receiver-type match; unresolved calls are dropped rather
  than guessed ([#35]).

- **Indexing now respects `.gitignore`.** In Git repositories, graft indexes
  tracked files plus untracked files that Git does not ignore, so generated
  output such as `Scripts/bundles/` and `Scripts/transpiled/` is no longer
  parsed merely because its extension is supported. Nested ignore files,
  negations, and global Git excludes follow Git's own rules; non-Git directories
  retain the existing filesystem walk and built-in skip list ([#39]).

- **`graft ask` no longer lets normalization undo test-file de-ranking.** Test
  files were penalized before lexical scores were normalized, but the strongest
  test match was still normalized back to the maximum score. The test prior now
  also applies to the final lexical/graph blend, while test-seeking queries keep
  the existing unpenalized behavior ([#37]).

- **`callers` now includes imported functions used as values.** Named imports that
  are passed, returned, or stored are reported as weaker `references` edges,
  while direct invocations remain `calls` ([#34]).

- **The build banner and repo map now name the language, not its parser.** JavaScript
  files (`.js`, `.mjs`, `.cjs`) use the TypeScript grammar internally, and `.jsx`
  uses the TSX grammar, but reporting those parser names made indexed files look
  absent. Coverage now reports `javascript` and `jsx` alongside the existing
  `typescript`, `tsx`, `python`, and `go` labels ([#36]).

- **README: `init` does not write a `CLAUDE.md` section.** Claude Code receives the
  wholly-owned `.claude/skills/graft/SKILL.md`; existing `CLAUDE.md` content is
  never touched ([#36]).

- **Windows: `graft upgrade` no longer reinstalls over an npx run.** The npx-cache check
  matched `/_npx/` against a path that arrives with the platform separator, so it was
  always false on Windows and `graft upgrade` ran `npm install -g` instead of explaining
  that npx already fetches the latest build on every run.

- **Windows: a git worktree kept the graph it was seeded with, but not the record that
  makes it cheap.** The seed's copy filter dropped every sidecar next to the graph — the
  freshness fingerprint included — so the query right behind the seed found no
  fingerprint, could not diff against the parent checkout, and re-parsed the whole repo.
  It answered correctly the whole time, which is why nothing reported it; the only
  visible trace was a `(? files changed)` note instead of a count.

- **`graft init` printed one path with two separators** on Windows (`~\.codex/`), from a
  `/` concatenated onto an otherwise native display path.

- The `windows-latest` CI leg now **gates** rather than merely reporting. The 21 failures
  it shipped with are resolved: two were the real bugs above, most of the rest were tests
  asserting `/` in paths that are deliberately printed with the native separator or
  pointing a child process at `HOME` (Windows reads `USERPROFILE`), and four are now
  explicit named skips — nothing in Node's `fs` can deny a *read* on Windows, and there
  is no exec bit or `SIGTERM` to test.

- **Windows: path scoping and `map` work again.** graft stores a repo-relative path
  for every indexed file — in node ids, `node.path`, the extract cache, the freshness
  fingerprint — and it was produced with `relative()`, which returns the *platform*
  separator. So on Windows every stored path was `src\gate.ts`, while the query layer
  parses those strings with `/` by hand. Nothing errored; it just matched nothing:

  - `ask --in <path>` reported `nothing indexed under "…"` for **every** prefix,
    making path scoping unusable on the platform ([#33]).
  - `map` saw one path segment instead of several, so it emitted one single-file
    "directory" per file — on a large repo spending its whole token budget describing
    ~16 arbitrary files instead of the repo's shape ([#35]).
  - `callers <file.ts>`-style filename lookups missed.

  Repo-relative paths are now normalized to posix once, where they are created
  (`src/util/paths.ts`), instead of defensively at each consumer. Mac and Linux are
  unaffected — the conversion is the identity there, and existing graphs are
  byte-identical. **On Windows every cache key changes**, so the first `graft build`
  after upgrading re-parses the repo once and `graft check` may report drift until it
  runs. One-time, and `graft/` is a local gitignored cache — nothing to migrate.

  CI now runs a `windows-latest` leg, because this whole class of bug is invisible to
  a posix-only matrix.

### Changed

- **`--in` means the same thing on every command.** `ask --in` matched a segment-aware
  path prefix while `grep --in` and `callers --in` matched a bare substring, so
  `grep --in src` also swept up `lib/mysrc/`. All three now use the prefix rule, and
  all three accept either separator (`--in server\src\gpu` works on Windows). A prefix
  matching nothing indexed is now a loud error on all three rather than — for `grep`
  and `callers` — empty output the caller had to interpret.

  This is stricter: a mid-path fragment like `--in gpu` for `server/src/gpu` no longer
  matches. Pass a real prefix (`--in server/src/gpu`), a full file path
  (`--in src/a.ts`), or use `grep`'s pattern to match on content.

- **Duplicate-named definitions no longer silently collide onto one graph node
  id.** A branch-guarded redeclaration, a reopened class, or any other same-name
  definition within a file used to mint the exact same node id as an earlier
  definition, so the second one silently overwrote the first in every id-keyed
  lookup (`callers`, `ask`, MCP tools). Every definition now mints a unique id
  (`~2`, `~3`, ... on a document-order duplicate), and a qualified query
  (`Class.method`) now matches every duplicate, not just the first.

- **UTF-16LE source is now decoded consistently everywhere graft reads repo
  source.** `graft build`'s parse, `check`'s and `fingerprint`'s drift hashes,
  the context summarizer's input, `ask --source`'s span slicer, and `grep` each
  read files with their own `readFileSync(file, "utf8")` — hashing what the
  parser actually sees wasn't guaranteed, and a UTF-16LE file (the common
  encoding Windows tooling writes) got silently mojibake'd by some readers and
  not others. All of them now share one `readSourceFile`, so a file decodes
  identically no matter which command reads it. UTF-16BE, unsupported by
  Node's built-in decoders, is a clean skip (an empty entry) rather than a
  mojibake read.

- **`graft callers`'s zero-hit note now says when the query name itself is
  ambiguous.** When a symbol name is defined more than once, name resolution
  drops a cross-file call to it rather than guessing which definition it means
  — so a zero-hit result could really mean "something calls this, but the edge
  was dropped for being ambiguous." The note now states how many definitions
  share the name.

[#33]: https://github.com/NanoNets/Graft/issues/33
[#34]: https://github.com/NanoNets/Graft/issues/34
[#35]: https://github.com/NanoNets/Graft/issues/35
[#36]: https://github.com/NanoNets/Graft/issues/36
[#37]: https://github.com/NanoNets/Graft/issues/37
[#39]: https://github.com/NanoNets/Graft/issues/39

## 0.8.2

### Fixed

- **`graft ask` no longer buries source under test files on pytest-style repos.** The
  test-de-rank (`isTestPath`) matched test directories (`tests/`, `spec/`) and suffix
  names (`_test`, `.test`, `.spec`) but missed Python's dominant `test_*.py` filename
  **prefix** and `conftest.py`. On repos whose tests live outside a `tests/`-named
  directory (e.g. a `t/unit/` layout), tests were not de-ranked and swamped `ask`
  results. The prefix and `conftest.py` are now recognized.

## 0.8.1

### Changed

- **Every graft query now refreshes the graph before it answers.** Freshness used to be the
  `Stop` hook's job — it rebuilt once the turn had ended — so every query an agent made
  between its first edit and the end of that turn answered from a graph that no longer
  matched the file it had just changed, and it stayed that way indefinitely if the
  background sync failed. Edits made outside the agent (your editor, a branch switch, a
  stash) set no flag at all, so the statusline read `✓ synced` while the graph was behind.

  `ask`, `grep`, `callers`, `skeleton` and `map` now stat the working tree against the last
  build's fingerprint (~3ms) and rebuild only if something moved. `check` is exempt — it is
  the drift report, and refreshing first would make it always say OK.

  A refresh writes only what a query reads: the wiring graph, the `ask` sidecar, and the
  freshness record. It does **not** rewrite the markdown cards, `INDEX.md`, or your
  `.gitignore` — a query is a read, and those stay the job of an explicit `graft build`
  (which is what the Claude Code `Stop` hook already runs at the end of a turn). So the
  retrieval tools are always current, while the markdown you might `grep` by hand can lag
  an edit until the turn ends.

  The refresh is structural and `$0`: it never calls the LLM, so `graft check` still reports
  concept-node drift and stale summaries until you run `graft build --deep` yourself. A
  refresh that fails answers from the graph on disk rather than failing the query.

  ```bash
  graft ask "..." --no-refresh     # answer from the graph exactly as it is on disk
  GRAFT_NO_REFRESH=1               # same, for every command in the process
  ```

### Added

- **Incremental extraction.** `graft build` memoizes each file's parse under `graft/.cache/`
  and replays the files whose bytes have not moved, so a rebuild costs roughly the files
  that changed: on this repo (124 files) **0.74s cold against 0.18s after one edit**. Output
  is byte-identical to a cold build. The memo is discarded automatically when the extraction
  code or the graft version changes, so a stale parse can't outlive an upgrade. `graft build`
  now reports `parsed: N of M files (K replayed from cache)`, and `graft build --no-reuse`
  forces a cold parse of everything.

  Only the *parse* is skipped — every file is still read and hashed on every build. A stat
  may decide whether a query bothers rebuilding; it may not decide what the rebuild itself
  looks at, or `graft check` (which always re-hashes) could report drift that the `graft
  build` it recommends refuses to repair.

- **`GRAFT_REFRESH=hash`** — confirm every file by hashing its contents instead of trusting
  size and mtime, for tooling that rewrites files while preserving both.

### Fixed

- **A git worktree is no longer blind.** `graft/` is gitignored, so `git worktree add`
  never checks it out — and the graph is the only thing the MCP tools read. Every tool in
  a fresh worktree answered `no matching nodes` / `no graph found` for the whole session,
  and `INDEX.md` and the cards were missing too, so `grep` and the repo map came up empty.

  A query in a worktree now copies the parent checkout's graph and query sidecars in, then
  treats the difference between the two checkouts as ordinary drift. The worktree's `.git`
  is a file naming its parent, so there is nothing to configure; the copy is $0 and
  offline, and the Tier-2 meaning layer survives it (a cold rebuild would have thrown away
  every summary you paid for and re-parsed the repo). `graft build` in a worktree starts
  from the same copy, so it is incremental too — and it is what writes the worktree's
  cards and `INDEX.md`, generated from *this* checkout's code rather than copied from the
  parent's branch. A query still writes only what a query reads.

  Reads the parent, never writes to it. No-ops unless there is genuinely a built parent
  checkout on disk — a fresh clone, CI, or a cloned (rather than worktree'd) cloud session
  behaves exactly as before. `GRAFT_NO_SEED=1` turns it off.

## 0.8.0

### Changed

- **`graft init` now asks which agents to wire, instead of writing files for every
  agent it detects.** Detection keyed off directories in `$HOME`, so anyone who had
  tried several coding CLIs got instruction files and MCP configs for all of them —
  plain `graft init` effectively behaved like `--all-agents`. On a terminal it now
  shows every known agent, which ones were detected, and the exact files each would
  write, and wires only what you select (Claude Code pre-selected).

  **Migration —** `graft init` in CI, a Dockerfile, or any non-interactive shell now
  writes **nothing** and prints the command to run instead. Add `--yes` for the old
  behaviour, or `--agents <ids>` to be explicit:

  ```bash
  graft init --yes                  # wire every detected agent (pre-0.8 default)
  graft init --agents claude        # or name them
  ```

### Added

- **`graft init --dry-run`** — print every path `init` would touch, then exit without
  writing. Out-of-repo writes get their own section.
- **`graft init --no-global`** — skip every write outside the repo. Selecting the
  `agents` host writes to `~/.codex/config.toml`, `~/.codex/hooks.json`, and
  `~/.codex/hooks/graft/`; those are user-level and apply to every repo you open with
  Codex, and previously nothing suppressed the `config.toml` write (`--no-hooks` only
  covered the other two). These are now labelled `machine-wide` in the picker.
- **`graft init --yes`** — wire every detected agent without prompting.

## 0.7.0

### Changed

- **`graft/` is now a local, git-ignored cache, not a committed artifact.** Every
  `graft build` adds `graft/` to the repo's `.gitignore` itself, so the graph is
  regenerated locally (like `node_modules`) rather than shared through git. Commit
  `.claude/` (hooks, skill, statusline, `.mcp.json`) so teammates' agents pick graft
  up; each teammate runs `graft build` for their own graph. `graft check` is now a
  local freshness signal rather than a CI merge gate.

### Removed

- The `bench/` benchmark harness is no longer part of the published repo.

## 0.6.0

Consolidates the structural-traversal surface and wires the MCP server into
Claude Code. **Breaking** — see migration below.

### Breaking

- **Removed `graft callees` and `graft impact`.** Both fold into `graft callers`:
  - `graft callees <symbol>` → `graft callers <symbol> --direction out`
  - `graft impact <symbol> -d N` → `graft callers <symbol> --depth N`
  - `graft callers` with no new flags is unchanged (defaults `--direction in --depth 1`).
- **Removed MCP tools `graft_callees` and `graft_blast_radius`.** The `graft_callers`
  tool now takes optional `direction` (`in`|`out`, default `in`) and `depth`
  (default `1`) parameters covering both:
  - callees → `graft_callers { direction: "out" }`
  - blast radius → `graft_callers { depth: N }` (accepts a file path or symbol,
    same file-seed aggregation the old `graft_blast_radius` did).

  Rationale: a coding-agent tool-selection experiment showed agents never picked
  `graft_blast_radius`/`impact` (they reconstructed it by calling `callers`
  repeatedly) and never picked `callees` (they read the named file instead). One
  well-named command with flags is selected more reliably than three.

### Added

- `graft callers --direction <in|out>` — walk incoming (callers, default) or
  outgoing (callees) edges.
- `graft callers --depth <n>` — walk transitively out to depth N for the full
  blast radius (default 1 = direct edges only). For a file seed at depth >1 the
  walk aggregates over the symbols the file defines.
- `graft init` now registers the graft MCP server in the project's `.mcp.json`
  for Claude Code (previously Claude Code got only hooks + statusline + skill).
  Restart Claude Code to load it. Existing `.mcp.json` servers are preserved.

### Changed

- `graft mcp --help` and docs now list the full tool set
  (`graft_ask`, `graft_callers`, `graft_grep`, `graft_skeleton`, `graft_map`,
  `graft_check`) instead of only three.
- The bundled Claude Code skill and other-agent instructions document the
  consolidated `callers` flags.
