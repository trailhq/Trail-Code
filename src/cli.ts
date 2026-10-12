#!/usr/bin/env node
/**
 * `graft` CLI. Commands: build, ask, check, viz, mcp, callers, skeleton, grep,
 * map, init. Git is the sync: commit graft/ and a clone has the graph. A
 * workspace parent (≥2 git children) federates query commands across children.
 */
import "dotenv/config";
import { Command } from "commander";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Graft } from "./engine.js";
import { resolveConfig, type EngineConfig } from "./ai/providers.js";
import type { ProviderKind } from "./ai/llm/factory.js";
import { formatCheckReport } from "./context/check.js";
import { formatGraphCheckReport } from "./graph/check.js";
import { buildGraphIfMissing, runInit } from "./claude/init.js";
import { statuslineWanted } from "./claude/settings-merge.js";
import { runHostsInit } from "./hosts/init.js";
import { hostIds } from "./hosts/registry.js";
import { parseBrainArg, connectBrain, pullBrain, brainStatus } from "./brain/connect.js";
import { rulesForPointers } from "./brain/attach.js";
import { clearLink, type BrainLink } from "./brain/link.js";
import {
  buildEarlyDigest,
  buildLocalDigest,
  fetchExpectedRepo,
  pickedAgents,
  pushContext,
  pushDigest,
  pushEarlyDigest,
  repoSlugFromGit,
  sameRepo,
  uploadCaps,
} from "./brain/push.js";
import { apiBaseUrl, clearPendingSignup, readLink, readPendingSignup, writeLink, writePendingSignup } from "./brain/link.js";
import { withLegacyNames } from "./legacy-args.js";
import { currentStage, DOING_LABEL, rulesSoFar, watchBuild, type RepoState } from "./brain/watch.js";
import {
  AGENT_WAIT_MS,
  brainUrl,
  newSignupState,
  openBrowser,
  PENDING_SIGNUP_TTL_MS,
  reviewUrl,
  signupUrl,
  startHandoff,
  waitForSignup,
} from "./brain/signup.js";
import { runTrailPull, suggestionsLine } from "./brain/pull.js";
import {
  trackWatchExit,
  WATCH_DEFAULTS,
  watchExitCode,
  watchExitJson,
  watchExitLines,
  watchTrail,
  type WatchTrailResult,
} from "./brain/watch-trail.js";
import { AUTOPUSH_CHILD_ENV, recordTrailPush } from "./brain/autopush.js";
import { startSpinner } from "./util/spinner.js";
import { contextDirFor } from "./context/node-file.js";
import { loadGraphCached } from "./graph/load.js";
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from "./graph/refresh.js";
import { isWorkspaceBuildRoot, readWorkspace } from "./graph/workspace.js";
import { hasGraftIndex, nearestGraftRoot } from "./graph/root.js";
import { unsupportedExtensions, supportedExtensions } from "./graph/source-files.js";
import { discoverWorkspaceChildren } from "./graph/scopes.js";
import {
  runWorkspaceAsk,
  runWorkspaceBuild,
  runWorkspaceCallers,
  runWorkspaceCheck,
  runWorkspaceGrep,
  runWorkspaceMap,
} from "./graph/workspace-cli.js";
import { formatInitEpilogue } from "./cli-epilogue.js";
import { planInit, selectedWrites } from "./hosts/plan.js";
import { planRetract, runRetract, changed, type Retraction } from "./hosts/retract.js";
import { compactWrites, formatNonInteractiveHelp, formatPlan, runPicker } from "./cli-picker.js";
import { buildGraphWithProgress } from "./claude/build-progress.js";
import { homedir } from "node:os";
import { formatUpgradeReport, formatVersionReport, getNpmViewVersion, readCurrentVersion, runUpgrade } from "./cli-meta.js";
import { patchBuildConfig, type BuildConfig } from "./util/state.js";
import { normalizePathPrefix } from "./util/paths.js";
import { latestSession, formatSessionStats, sessionInputRate } from "./claude/session-metrics.js";
import { setInputRate } from "./context/savings.js";
import { formatUpdateNudge, maybeRefreshInBackground, readStamp, readUpdateCache, refreshUpdateCache, wiredHostIds, writeStamp } from "./upkeep.js";
import {
  errorCode,
  filesBucket,
  durationBucket,
  formatDebug,
  formatStatus,
  firstRunNotice,
  isTrackedCommand,
  langsValue,
  offReason,
  maybeFlushInBackground,
  patchState,
  runFlush,
  track,
  trackFirstRunIfNew,
} from "./telemetry/index.js";

const program = new Command();
const currentVersion = readCurrentVersion(import.meta.url);

/**
 * What the `query` telemetry event will say, filled in by the command as it runs
 * and emitted once from the `postAction` hook below.
 *
 * A module-level slot rather than a threaded parameter because the repo root is
 * resolved deep inside each action (`queryRoot`) while the event is emitted
 * centrally — and because a command that calls `process.exit` should simply
 * report nothing, which falls out of never emitting until postAction.
 */
let queryNote: { repo?: string; hit?: "yes" | "no" } = {};

/** Record the repo a query ran against, and pass it straight through so call
 *  sites stay one line. */
function noteQuery(dir: string): string {
  queryNote.repo = dir;
  // Every retrieval command funnels through here, which makes it the one place
  // that can price this session's tokens before a formatter needs the number.
  setInputRate(sessionInputRate(dir));
  return dir;
}

/** Whether a query found anything. Only the commands that have a result count in
 *  hand call this; the property is simply absent for the others. */
function noteHit(found: boolean): void {
  queryNote.hit = found ? "yes" : "no";
}

program
  .name("graft")
  .description("Build a repo's context graph as linked markdown, and keep it in sync with the code.")
  .version(currentVersion, "-v, --version")
  .option("--dir <path>", "context graph directory (default: <repo>/graft)")
  .option("--provider <name>", "LLM wire format: openai | anthropic | litellm | orcarouter (env GRAFT_PROVIDER)")
  .option("--model <id>", "model id for the LLM pass (env GRAFT_MODEL)")
  .option("--api-key <key>", "provider API key (env GRAFT_API_KEY)")
  .option("--base-url <url>", "OpenAI-compatible endpoint URL (env GRAFT_BASE_URL)");

interface GlobalOpts {
  dir?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** Config drawn from the global CLI flags (env + defaults fill the rest). */
function cliConfig(): EngineConfig {
  const o = program.opts<GlobalOpts>();
  return {
    contextDir: o.dir,
    provider: o.provider as ProviderKind | undefined,
    model: o.model,
    apiKey: o.apiKey,
    baseUrl: o.baseUrl,
  };
}

const engineFrom = (): Graft => new Graft(cliConfig());

/**
 * Warn (never fail) when a user's `-e` extension has no parser, so it is never a silent
 * no-op — `graft build -e ".vue"` used to accept it, index nothing, and exit 0. The
 * supported set is listed so `-e` also answers "what is actually supported".
 */
function warnUnsupportedExtensions(exts?: string[]): void {
  if (!exts?.length) return;
  const bad = unsupportedExtensions(exts);
  if (bad.length === 0) return;
  for (const e of bad) {
    const shown = e.trim().startsWith(".") ? e.trim() : `.${e.trim()}`;
    console.error(`⚠ -e "${shown}": no parser registered for this extension — ignoring it.`);
  }
  console.error(`  supported: ${supportedExtensions().join(" ")}`);
}

/** Text for the omitted-`[dir]` case, shared by every query command's help. */
const DIR_ARG = ["[dir]", "repository root (default: nearest ancestor with a graft/ index)"] as const;

/**
 * The root a query runs against: the dir the user named, else the nearest
 * ancestor holding a graft index (`graph/root.ts`) so a shell or agent session
 * in a subdirectory still finds the graph. The walk is announced on stderr —
 * answering from an ancestor's graph must never be silent.
 */
function queryRoot(dir?: string): string {
  if (dir !== undefined) return resolve(dir);
  const { root, levels } = nearestGraftRoot(process.cwd(), program.opts<GlobalOpts>().dir);
  if (levels > 0) console.error(`[graft] no graft/ here — answering from ${root}/graft`);
  return root;
}

/**
 * Bring the graph up to date with the working tree before a query answers from it
 * — the same gate the MCP tools run (see `graph/refresh.ts`). Cheap when nothing
 * moved; a structural, $0 rebuild when it did. The note goes to stderr so `--json`
 * stdout stays machine-readable.
 */
async function refreshBefore(dir: string, opts: { refresh?: boolean }): Promise<void> {
  const globalDir = program.opts<GlobalOpts>().dir;
  const root = resolve(dir);
  const disabled = opts.refresh === false;
  const ws = readWorkspace(root, globalDir);
  const r = ws
    ? await ensureFreshChildren(root, ws.children, { contextDir: globalDir, disabled })
    : await ensureFreshGraph(root, { contextDir: globalDir, disabled });
  const note = refreshNote(r);
  if (note) console.error(note);
}

/** Attached to every query command: `--no-refresh` answers from the graph exactly
 * as it is on disk, no rebuild. */
const NO_REFRESH_FLAG = ["--no-refresh", "skip the freshness check — answer from the graph as-is"] as const;

const VIZ_TABS = ["context", "code", "outline"] as const;
type VizTab = (typeof VIZ_TABS)[number];

/**
 * `--tabs context,code` → the tabs to write into an exported page.
 *
 * An unknown name is a caller mistake worth failing on rather than silently
 * dropping: a page exported with a typo'd tab list would be missing a tab and
 * nothing would say why. Undefined means "all of them", which is the default the
 * exporter already applies.
 */
function parseTabs(raw: string | undefined): VizTab[] | undefined {
  if (raw === undefined) return undefined;
  const want = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const bad = want.filter((t) => !VIZ_TABS.includes(t as VizTab));
  if (bad.length > 0 || want.length === 0) {
    console.error(`✗ --tabs takes a comma-separated subset of ${VIZ_TABS.join(", ")}${bad.length ? ` — got "${bad.join('", "')}"` : ""}`);
    process.exit(1);
  }
  return want as VizTab[];
}

/**
 * Commands that own the upgrade story themselves (`version`, `upgrade`) or must
 * not editorialize on stderr at startup (`mcp` runs its own upkeep at boot, and
 * `_update-check` IS the fetch).
 */
const UPKEEP_SKIP = new Set(["version", "upgrade", "_update-check", "_brain-refresh", "mcp"]);

/**
 * Every other command: top up the cached registry answer in the background and,
 * if a newer graft is out, say so once on stderr. This is what makes the CLI the
 * cache filler for the hooks, which are not allowed to touch the network.
 */
program.hook("preAction", (_parent, action) => {
  if (UPKEEP_SKIP.has(action.name())) return;
  maybeRefreshInBackground();
  const nudge = formatUpdateNudge(currentVersion, readUpdateCache()?.latest);
  if (nudge) console.error(nudge);
  // Telemetry, in the order a user should experience it: disclose first, then
  // record, then (at most once a day, detached) send. Every step is a no-op in a
  // fork, in CI, under DO_NOT_TRACK, or after `graft telemetry disable`.
  const notice = firstRunNotice();
  if (notice) console.error(notice);
  trackFirstRunIfNew();
  maybeFlushInBackground();
});

/**
 * The `query` event, emitted after the command rather than before it, so it can
 * carry what the query actually did. A command that exits early via
 * `process.exit` never reaches here and is simply not counted — under-reporting
 * is the right failure mode for a metric.
 */
program.hook("postAction", (_parent, action) => {
  const name = action.name();
  if (!isTrackedCommand(name)) return;
  track("query", { command: name, surface: "cli", hit: queryNote.hit }, { repo: queryNote.repo });
});

// Hidden from --help: only ever spawned detached by maybeRefreshInBackground.
program
  .command("_brain-refresh", { hidden: true })
  .description("internal: re-pull the attached brain's rules and rewrite the agent files")
  .argument("[dir]", "target repo directory", ".")
  .action(async (dir: string) => {
    // Spawned detached by upkeep, so nothing here is user-visible and nothing
    // may throw: a failure means the cached rules keep serving, which is the
    // correct outcome for a brain that is momentarily unreachable.
    try {
      await pullBrain(resolve(dir), { home: homedir() });
    } catch {
      /* the next session tries again */
    }
  });

program
  .command("_update-check", { hidden: true })
  .description("internal: refresh the cached latest-version answer")
  .action(() => {
    refreshUpdateCache();
  });

// Hidden for the same reason as _update-check: only ever spawned detached, by
// maybeFlushInBackground. Running it by hand is harmless — it drains the queue.
program
  .command("_telemetry-flush", { hidden: true })
  .description("internal: POST the queued anonymous usage events")
  .action(async () => {
    await runFlush();
  });

program
  .command("telemetry")
  .description("Show, inspect, or turn off the anonymous usage stats (see TELEMETRY.md)")
  .argument("[action]", "status (default) | enable | disable | debug", "status")
  .action((action: string) => {
    switch (action) {
      case "status":
        console.log(formatStatus());
        return;
      case "enable":
        patchState({ enabled: true });
        console.log("telemetry: on — anonymous, aggregate-only. `graft telemetry status` for details.");
        return;
      case "disable":
        // Also stamp the notice as shown: someone who has just opted out should
        // not be told about telemetry again the next time they run a command.
        patchState({ enabled: false, noticeShownAt: new Date().toISOString() });
        console.log("telemetry: off. Nothing further will be recorded or sent.");
        return;
      case "debug":
        console.log(formatDebug());
        return;
      default:
        console.error(`✗ unknown action "${action}" — expected status, enable, disable, or debug`);
        process.exit(1);
    }
  });

program
  .command("version")
  .description("Print the installed version and the latest published on npm")
  .action(() => {
    const latest = getNpmViewVersion();
    console.log(formatVersionReport(currentVersion, latest));
  });

program
  .command("upgrade")
  .description("Upgrade the globally installed graft to the latest version on npm")
  .action(() => {
    const result = runUpgrade(import.meta.url);
    console.log(formatUpgradeReport(result));
    if (result.ran && !result.ok) process.exit(1);
  });

program
  .command("build")
  .description(
    "Build graft/ from your code — wiring graph + per-file cards ($0, no key). " +
      "Add --deep for the LLM concept map + per-symbol summaries/crux.",
  )
  .argument("[dir]", "repository root", ".")
  .option("--deep", "run the LLM pass: concept nodes (graft/*.md) + per-symbol summary/crux")
  .option("-e, --extensions <exts...>", 'code extensions to include (e.g. ".ts" ".py"); an extension with no parser is ignored with a warning that lists the supported set')
  .option("-j, --concurrency <n>", "files summarized in parallel during --deep (default 5)")
  .option("--no-reuse", "re-parse every file instead of replaying unchanged ones from the extraction cache")
  .option("--lsp", "add compiler-grade call edges via a language server if one is installed (opt-in, slower; e.g. rust-analyzer, clangd)")
  .option("--allow-partial", "with --deep: exit 0 even when some files' summaries failed (default: a degraded meaning tier exits 1)")
  .option(
    "--follow-submodules",
    "include initialized Git submodules recursively; persisted for later builds and automatic refreshes",
  )
  .option(
    "--no-follow-submodules",
    "exclude Git submodules; persisted for later builds and automatic refreshes (default)",
  )
  .option(
    "--follow-nested-repos",
    "include nested Git clones the index does not track (a multi-repo manifest checkout, or any repo cloned into the tree) " +
      "as ONE graph, so imports across them resolve; persisted for later builds and automatic refreshes",
  )
  .option(
    "--no-follow-nested-repos",
    "exclude untracked nested Git clones; persisted for later builds and automatic refreshes (default)",
  )
  .option(
    "--include-dir <name>",
    "override SKIP_DIRS for this repo's walks — repeatable (e.g. --include-dir build --include-dir tools); " +
      "persisted, so a later build (and the hooks/refresh path) include it without the flag; dot-dirs are never overridable",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--only-dir <path>",
    "only index files under this repo-relative path — repeatable; the wiring walk and the --deep " +
      "concept pass both honor it. Recorded in the graph fingerprint so a later build " +
      "(and the hooks/refresh path) walks the same set; everything outside the list is skipped",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--no-gitignore", "skip writing graft/ into .gitignore (same as GRAFT_NO_GITIGNORE=1)")
  .option("--no-ignore", "skip writing .ignore for ripgrep re-admit (same as GRAFT_NO_IGNORE=1)")
  .action(async (
    dir: string,
    opts: {
      deep?: boolean;
      extensions?: string[];
      concurrency?: string;
      reuse?: boolean;
      lsp?: boolean;
      allowPartial?: boolean;
      includeDir?: string[];
      onlyDir?: string[];
      followSubmodules?: boolean;
      followNestedRepos?: boolean;
      gitignore?: boolean;
      ignore?: boolean;
    },
    command: Command,
  ) => {
    const buildStartedAt = Date.now();
    if (opts.gitignore === false) process.env.GRAFT_NO_GITIGNORE = "1";
    if (opts.ignore === false) process.env.GRAFT_NO_IGNORE = "1";
    const concurrency = opts.concurrency ? Math.max(1, Number(opts.concurrency)) : undefined;
    if (opts.concurrency && !Number.isFinite(concurrency)) {
      console.error(`✗ --concurrency must be a number, got "${opts.concurrency}"`);
      process.exit(1);
    }
    warnUnsupportedExtensions(opts.extensions);
    // Persisted BEFORE the build itself runs, so this invocation's walks (and
    // every later no-flag build / hooks refresh) see it identically — the
    // walkDir call sites read it from state, not from a threaded option.
    const buildConfigPatch: BuildConfig = {};
    if (opts.includeDir && opts.includeDir.length > 0) {
      // --include-dir takes bare SKIP_DIRS-style directory NAMES (shouldSkipDir
      // compares a single path segment), never paths, and dot-dirs are never
      // overridable at all (see the option's own help text) — reject anything
      // else up front instead of silently persisting a value that can never
      // match a real directory name.
      for (const name of opts.includeDir) {
        if (name.startsWith(".")) {
          console.error(`✗ --include-dir "${name}": dot-directories are never overridable`);
          process.exit(1);
        }
        if (name.includes("/") || name.includes("\\")) {
          console.error(`✗ --include-dir "${name}": expected a bare directory name, not a path`);
          process.exit(1);
        }
      }
      buildConfigPatch.includeDirs = opts.includeDir;
    }
    // The whitelist is NOT persisted to `.graft/config.json`: it belongs with the
    // graph (the fingerprint records it at build time), never in the source repo,
    // so a `--only-dir` build leaves no trace under the repo being indexed.
    let onlyDirs: string[] | undefined;
    if (opts.onlyDir && opts.onlyDir.length > 0) {
      // --only-dir takes a repo-relative path prefix, normalized to the same
      // posix, no-`./`, no-trailing-slash form `--in` uses, so the prefix match
      // is exact. A prefix that normalizes to "" (a bare "/" or ".") is rejected:
      // it would mean "match nothing" or "match everything", neither of which is
      // a deliberate whitelist.
      const normalized = opts.onlyDir.map((p) => normalizePathPrefix(p)).filter((p) => p !== "");
      if (normalized.length === 0) {
        console.error("✗ --only-dir: expected a non-empty repo-relative path");
        process.exit(1);
      }
      onlyDirs = normalized;
    }
    const followSubmodulesWasExplicit = command.getOptionValueSource("followSubmodules") === "cli";
    if (followSubmodulesWasExplicit && typeof opts.followSubmodules === "boolean") {
      buildConfigPatch.followSubmodules = opts.followSubmodules;
    }
    const followNestedReposWasExplicit = command.getOptionValueSource("followNestedRepos") === "cli";
    if (followNestedReposWasExplicit && typeof opts.followNestedRepos === "boolean") {
      buildConfigPatch.followNestedRepos = opts.followNestedRepos;
    }
    if (Object.keys(buildConfigPatch).length > 0) {
      patchBuildConfig(resolve(dir), buildConfigPatch);
    }
    const engine = engineFrom();
    const fmt = (o: Record<string, number>) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");

    // --deep needs a key; without one, degrade to the $0 structural build.
    let deep = opts.deep;
    const resolved = resolveConfig(cliConfig());
    if (deep && !resolved.apiKey) {
      deep = false;
      console.error(
        "⚠ no API key set — falling back to the structural build (no LLM summaries).\n" +
          "  Set GRAFT_API_KEY (and GRAFT_PROVIDER / GRAFT_BASE_URL / GRAFT_MODEL for your\n" +
          "  provider) and re-run `graft build --deep` to add concept nodes and summaries.",
      );
    }
    if (deep && resolved.usedLegacyEnv) {
      console.error(
        "⚠ using OPENROUTER_API_KEY (deprecated) — prefer GRAFT_API_KEY + GRAFT_BASE_URL.",
      );
    }

    // Workspace parent: build each child into its OWN graft/ + a workspace index.
    const buildRoot = resolve(dir);
    const buildGlobalDir = program.opts<GlobalOpts>().dir;
    if (isWorkspaceBuildRoot(buildRoot, buildGlobalDir)) {
      await runWorkspaceBuild(buildRoot, {
        deep: !!deep,
        extensions: opts.extensions,
        concurrency,
        childConfig: cliConfig(),
        override: buildGlobalDir,
        includeDirs: opts.includeDir,
        followSubmodules: followSubmodulesWasExplicit ? opts.followSubmodules : undefined,
        followNestedRepos: followNestedReposWasExplicit ? opts.followNestedRepos : undefined,
      });
      return;
    }

    // --deep: concept nodes first, then the wiring graph links cards up to them.
    let conceptErrors: string[] = [];
    let conceptFatal: string | undefined;
    if (deep) {
      const c = await engine.init(dir, {
        extensions: opts.extensions,
        onlyDirs,
        onProgress: ({ phase, index, total, file }) =>
          process.stderr.write(
            `\r${phase === "summarize" ? "reading" : "writing"} concepts ${index + 1}/${total}: ${file.slice(0, 40).padEnd(40)}`,
          ),
      }).catch((err: unknown) => {
        // Only the stage and a code enum; the message stays on this machine.
        track("build_failed", { stage: "summarize", code: errorCode(err) }, { repo: buildRoot });
        throw err;
      });
      process.stderr.write("\n");
      console.log(
        `✓ concepts: ${c.nodes} nodes, ${c.links} links from ${c.files} files (${c.summarized} read, ${c.cached} cached)`,
      );
      for (const e of c.errors) console.error(`✗ ${e}`);
      conceptErrors = c.errors;
      conceptFatal = c.fatal;
    }

    // Wiring graph — always; LLM meaning only with --deep.
    const g = await engine.graph(dir, {
      llm: deep,
      concurrency,
      reuse: opts.reuse,
      lsp: opts.lsp,
      onlyDirs,
      onProgress: ({ phase, index, total, file }) =>
        process.stderr.write(
          `\r${phase === "enrich" ? "summarizing" : "parsing"} ${index + 1}/${total}: ${file.slice(0, 50).padEnd(50)}`,
        ),
    }).catch((err: unknown) => {
      track("build_failed", { stage: "graph", code: errorCode(err) }, { repo: buildRoot });
      throw err;
    });
    process.stderr.write("\n");
    console.log(`✓ wiring: ${g.nodes} nodes (${fmt(g.byKind)}), ${g.edges} edges, ${g.cards} cards [${g.languages.join(", ")}]`);
    console.log(`  parsed: ${g.parsed} of ${g.files} files (${g.reused} replayed from cache)`);
    // Worth one line: this build started from a graph the user never built *here*.
    if (g.seededFrom) console.log(`  seeded: copied a starting graph from ${g.seededFrom} (git worktree)`);
    if (deep) {
      const m = g.meaning;
      console.log(`  meaning: ${m.computed} computed, ${m.cached} cached, ${m.stale} stale, ${m.pending} pending`);
    }
    console.log(`  → ${g.contextDir}`);
    // The activation event. Everything here is a bucket or a fixed label: repo
    // scale rather than a file count, a language set rather than file names.
    track(
      "build_completed",
      {
        files_bucket: filesBucket(g.files),
        langs: langsValue(g.languages),
        mode: deep ? "deep" : "fast",
        duration_bucket: durationBucket(Date.now() - buildStartedAt),
        incremental: String(g.reused > 0),
      },
      { repo: buildRoot },
    );
    for (const e of g.errors) console.error(`✗ ${e}`);

    const rel = relative(process.cwd(), g.contextDir) || "graft";
    if (process.env.GRAFT_NO_GITIGNORE) {
      console.log(`  ${rel}/ is a local cache — add it to your gitignore if you want it untracked.`);
    } else {
      console.log(`  ${rel}/ is git-ignored (added automatically) — a local cache; teammates run \`graft build\` to get their own.`);
    }

    // #127: a --deep run whose LLM calls failed used to print the same success
    // footer and exit 0, so a quota-exhausted build looked identical to a clean
    // one and `graft check` still said "in sync" (it only ever checked Tier-1).
    // The structural graph IS still written and every successful summary is
    // cached, so this is a loud warning about a degraded tier, not a rollback.
    if (deep) {
      const m = g.meaning;
      const failed =
        m.failedFiles > 0 || m.fatal !== undefined || conceptErrors.length > 0 || conceptFatal !== undefined;
      if (failed) {
        const ready = m.computed + m.cached;
        const total = ready + m.stale + m.pending;
        const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
        console.error("");
        console.error(`✗ the deep pass did not complete — the meaning tier is incomplete.`);
        if (conceptFatal) console.error(`  concepts: ${conceptFatal}`);
        if (m.fatal) console.error(`  summaries: ${m.fatal}`);
        if (m.failedFiles > 0) {
          const skipped = m.skippedFiles > 0 ? `, ${m.skippedFiles} never attempted` : "";
          console.error(`  ${m.failedFiles} file(s) failed to summarize${skipped}.`);
        }
        if (conceptErrors.length > 0) console.error(`  ${conceptErrors.length} concept-pass error(s).`);
        console.error(`  meaning coverage: ${ready}/${total} symbols (${pct}%).`);
        console.error(
          "  Nothing computed was lost: re-run `graft build --deep` to resume from what is cached.\n" +
            "  Pass --allow-partial to accept a degraded meaning tier and exit 0.",
        );
        if (!opts.allowPartial) process.exitCode = 1;
      }
    }
  });

program
  .command("ask")
  .description("Query the graft/ graph — returns ranked nodes + exact file:line, routed to prose or wiring ($0, no key)")
  .argument("<query>", "what you want to understand, in plain words")
  .argument(...DIR_ARG)
  .option("-n, --limit <n>", "max results", "8")
  .option("--source", "inline the source at each file:line hit (retriever mode — the pack IS the answer, no need to re-open files)")
  .option("--full", "with --source: inline whole definition spans instead of the default ≤8-line crux excerpts")
  .option("--in <path>", "narrow to nodes under this path prefix, filtered before scoring (segment-aware, like scopeOf)")
  .option("--json", "output the result as JSON")
  .option("--no-graph-rank", "rank by lexical relevance only, without the graph-connectivity re-rank (ablation/eval)")
  .option(...NO_REFRESH_FLAG)
  .action(async (query: string, dirArg: string | undefined, opts: { limit: string; source?: boolean; full?: boolean; in?: string; json?: boolean; refresh?: boolean; graphRank?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const askGlobalDir = program.opts<GlobalOpts>().dir;
    if (readWorkspace(dir, askGlobalDir)) {
      runWorkspaceAsk(dir, askGlobalDir, query, {
        limit: Number(opts.limit), source: opts.source, full: opts.full, in: opts.in, json: opts.json,
      });
      return;
    }
    const engine = engineFrom();
    let r;
    try {
      r = engine.ask(dir, query, { limit: Number(opts.limit), source: opts.source, full: opts.full, in: opts.in, graphRank: opts.graphRank });
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
    noteHit(r.hits.length > 0);
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      const { formatAsk } = await import("./ask/ask.js");
      process.stdout.write(formatAsk(r));
    }
  });

program
  .command("skeleton")
  .description("Signatures-only view of one file from the wiring graph — the cheapest way to see a file's API surface")
  .argument("<file>", "repo-relative path (or unique basename) of the file")
  .argument(...DIR_ARG)
  .option("--json", "output the result as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (file: string, dirArg: string | undefined, opts: { json?: boolean; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { skeleton, formatSkeleton } = await import("./ask/ask.js");
    const globalOpts = program.opts<{ dir?: string }>();
    const r = skeleton(dir, file, { contextDir: globalOpts.dir });
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else process.stdout.write(formatSkeleton(r));
  });

program
  .command("check")
  .description("Fail if graft/ is stale relative to the code (for CI)")
  .argument(...DIR_ARG)
  .option("-e, --extensions <exts...>", "code extensions to include")
  .option("--json", "output the drift as JSON")
  .action(async (dirArg: string | undefined, opts: { extensions?: string[]; json?: boolean }) => {
    warnUnsupportedExtensions(opts.extensions);
    const dir = noteQuery(queryRoot(dirArg));
    const checkGlobalDir = program.opts<GlobalOpts>().dir;
    if (readWorkspace(dir, checkGlobalDir)) {
      await runWorkspaceCheck(dir, checkGlobalDir);
      return;
    }
    const engine = engineFrom();
    const r = engine.check(dir, { extensions: opts.extensions });
    const g = await engine.checkGraph(dir); // graph.json is only judged when it exists

    // A layer that IS present must be in sync; a never-built layer (keyless
    // build skips the markdown layer) is informational, not a failure.
    const bothMissing = r.missing && g.missing;
    const markdownFail = !r.missing && !r.ok;
    const wiringFail = !g.missing && !g.ok;

    if (opts.json) {
      console.log(JSON.stringify({ context: r, graph: g.missing ? null : g }, null, 2));
    } else if (bothMissing) {
      console.log("graft check: NO GRAPH\n\nNo graft/ graph found. Run `graft build` first.");
    } else {
      if (r.missing) {
        console.log(
          "deep layer: not built (run `graft build --deep` for concept nodes) — wiring graph is the source of truth",
        );
      } else {
        console.log(formatCheckReport(r));
      }
      if (!g.missing) console.log("\n" + formatGraphCheckReport(g));
    }

    if (bothMissing || markdownFail || wiringFail) process.exit(1);
  });

program
  .command("stats")
  .description("Show this agent session's graft-vs-source usage mix and tokens saved")
  .argument(...DIR_ARG)
  .option("--json", "output the session stats as JSON")
  .action((dirArg: string | undefined, opts: { json?: boolean }) => {
    // Reads local session JSON only — no graph, no network. This is how a Cursor
    // user (no statusline) sees the numbers the Claude Code bar would show, and it
    // works under DO_NOT_TRACK because it never touches telemetry.
    const dir = queryRoot(dirArg);
    const s = latestSession(dir);
    if (opts.json) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    console.log(formatSessionStats(s));
  });

program
  .command("viz")
  .description("Serve an interactive visualization of the context graph (and graph.json when present)")
  .argument(...DIR_ARG)
  .option("-p, --port <port>", "port to serve on", "4400")
  .option("--no-open", "don't open the browser")
  .option("--export <dir>", "write one self-contained index.html instead of serving (for CI, GitHub Pages, or a build artifact)")
  .option("--title <text>", "subtitle shown beside the repo name in an exported page (e.g. \"PR #151\")")
  .option("--tabs <list>", "tabs the exported page offers, comma separated: context,code,outline (default: all three)")
  .action(async (dirArg: string | undefined, opts: { port: string; open: boolean; export?: string; title?: string; tabs?: string }) => {
    // Flags are checked before the repository is: a typo'd `--tabs` is a mistake
    // in the command the caller just typed, and telling them to go build an index
    // first sends them off to fix the wrong thing.
    const tabs = parseTabs(opts.tabs);
    const dir = noteQuery(queryRoot(dirArg));
    const { existsSync } = await import("node:fs");
    const { resolve, basename } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { contextDirFor } = await import("./context/node-file.js");
    const { startVizServer } = await import("./viz/serve.js");

    const root = resolve(dir);
    const globalOpts = program.opts<{ dir?: string }>();
    const contextDir = contextDirFor(root, globalOpts.dir);
    if (!existsSync(contextDir)) {
      console.error(`✗ no context graph at ${contextDir} — run \`graft build --deep\` first`);
      process.exit(1);
    }
    const viewerDir = fileURLToPath(new URL("./viewer/", import.meta.url)); // prebuilt

    if (opts.export) {
      const { exportViz } = await import("./viz/export.js");
      const out = exportViz({
        contextDir,
        viewerDir,
        outDir: resolve(opts.export),
        repoName: basename(root),
        subtitle: opts.title,
        tabs,
      });
      const kb = Math.round(out.bytes / 1024);
      console.log(
        `graft viz → ${out.file} (${kb} kB, ${out.contextNodes} concept nodes, ${out.codeNodes} code nodes)`,
      );
      return;
    }

    const srv = await startVizServer({
      contextDir,
      viewerDir,
      port: Number(opts.port),
      repoName: basename(root),
    });
    console.log(`graft viz → ${srv.url}  (ctrl-c to stop)`);
    if (opts.open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [srv.url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    }
  });

program
  .command("mcp")
  .description("Serve the graph over MCP (stdio) — exposes graft_find_code, graft_trace_calls, graft_find_all, graft_file_api, graft_repo_map and graft_check_freshness as tools")
  .argument(...DIR_ARG)
  .action(async (dirArg: string | undefined) => {
    const dir = noteQuery(queryRoot(dirArg));
    const { startMcpServer } = await import("./mcp/server.js");
    const globalOpts = program.opts<{ dir?: string }>();
    startMcpServer(dir, globalOpts.dir, currentVersion);
  });

program
  .command("callers")
  .description(
    "Who calls/references a symbol ($0, no LLM). --direction out gives callees (what it calls); --depth N (or all) walks transitively for full blast radius",
  )
  .argument("<symbol>", "bare name, qualified (Class.method), or package-qualified (pkg.Fn)")
  .argument(...DIR_ARG)
  .option("--direction <in|out>", 'edge direction: "in" = callers (default), "out" = callees')
  .option("-d, --depth <n>", 'walk transitively up to N hops for blast radius, or "all" for the full connected closure (default 1)')
  .option("--in <path>", "narrow matches to nodes at or under this path prefix")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(
    async (
      symbol: string,
      dirArg: string | undefined,
      opts: { direction?: string; depth?: string; in?: string; json?: boolean; refresh?: boolean },
    ) => {
      const dir = noteQuery(queryRoot(dirArg));
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      if (!opts.json && readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceCallers(dir, globalOpts.dir, symbol, {
          direction: opts.direction === "out" ? "out" : "in",
          depth: opts.depth
            ? (/^(all|full|max)$/i.test(opts.depth) ? Number.POSITIVE_INFINITY : Number(opts.depth))
            : undefined,
          in: opts.in,
        });
        return;
      }
      const { runCallersCommand } = await import("./graph/traverse-cli.js");
      runCallersCommand(symbol, dir, {
        direction: opts.direction,
        depth: opts.depth,
        in: opts.in,
        json: opts.json,
        globalDir: globalOpts.dir,
      });
    },
  );

program
  .command("blast")
  .description(
    "Blast radius of a diff: what depends on the lines this change touched ($0, no LLM). " +
      "Built for CI — `--format markdown` is a PR comment with a Mermaid diagram.",
  )
  .argument(...DIR_ARG)
  .option("--base <ref>", "diff against this ref's merge base with HEAD (e.g. origin/main); default: the working tree vs HEAD")
  .option("-d, --depth <n>", 'hops to walk over incoming edges, or "all" for the full closure (default 2)')
  .option("--format <fmt>", "text (default) | markdown | mermaid | json")
  .option("--name", "name the affected areas with one cached LLM call (needs GRAFT_API_KEY); without it, areas are named after their hub symbol")
  .option("--export-viz <dir>", "also write the interactive page for this radius (one self-contained index.html — for CI, GitHub Pages, or an artifact)")
  .option("--title <text>", "subtitle beside the repo name on the exported page (e.g. \"PR #171\")")
  .option("--no-owners", "do not suggest who to tag (by default, git history names the people behind each affected area)")
  .option("--pr-author <who...>", "GitHub login, git name or email of the PR author, so they are left out of their own suggestions")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { base?: string; depth?: string; format?: string; name?: boolean; exportViz?: string; title?: string; owners?: boolean; prAuthor?: string[]; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { runBlastCommand } = await import("./blast/blast-cli.js");
    await runBlastCommand(dir, {
      base: opts.base,
      depth: opts.depth,
      format: opts.format,
      name: opts.name,
      exportViz: opts.exportViz,
      title: opts.title,
      owners: opts.owners,
      prAuthor: opts.prAuthor,
      globalDir: program.opts<GlobalOpts>().dir,
    });
  });

program
  .command("grep")
  .description("Regex search over indexed files, hits grouped by enclosing symbol and ranked by coupling ($0, no LLM)")
  .argument("<pattern>", "regex pattern (or literal string with --fixed)")
  .argument(...DIR_ARG)
  .option("-i, --ignore-case", "case-insensitive match")
  .option("--fixed", "treat pattern as a literal string, not a regex")
  .option("--in <path>", "narrow to files at or under this path prefix")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(
    async (
      pattern: string,
      dirArg: string | undefined,
      opts: { ignoreCase?: boolean; fixed?: boolean; in?: string; json?: boolean; refresh?: boolean },
    ) => {
      const dir = noteQuery(queryRoot(dirArg));
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      if (readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceGrep(dir, globalOpts.dir, pattern, {
          ignoreCase: opts.ignoreCase, fixed: opts.fixed, json: opts.json,
        });
        return;
      }
      const { runGrepCommand } = await import("./search/grep-cli.js");
      runGrepCommand(pattern, dir, {
        ignoreCase: opts.ignoreCase,
        fixed: opts.fixed,
        in: opts.in,
        json: opts.json,
        globalDir: globalOpts.dir,
      });
    },
  );

program
  .command("map")
  .description(
    "Token-budgeted repo orientation — directory clusters, per-directory hubs, and global hotspots from the wiring graph ($0, no LLM)",
  )
  .argument(...DIR_ARG)
  .option("--max-dirs <n>", "max directory entries shown, rest counted into dropped (default 16)")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { json?: boolean; maxDirs?: string; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    const root = resolve(dir);
    const globalOpts = program.opts<{ dir?: string }>();
    let maxDirsW: number | undefined;
    if (opts.maxDirs !== undefined) {
      const n = parseInt(opts.maxDirs, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`✗ --max-dirs must be a positive integer, got "${opts.maxDirs}"`);
        process.exit(1);
        return;
      }
      maxDirsW = n;
    }
    await refreshBefore(dir, opts); // after arg validation: a bad flag shouldn't cost a rebuild
    if (!opts.json && readWorkspace(root, globalOpts.dir)) {
      runWorkspaceMap(root, globalOpts.dir, { maxDirs: maxDirsW });
      return;
    }
    const { buildRepoMap, formatRepoMap } = await import("./graph/map.js");
    const contextDir = contextDirFor(root, globalOpts.dir);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
      console.error("✗ no graph — run graft build first");
      process.exit(1);
      return;
    }
    const map = buildRepoMap(graph, { maxDirs: maxDirsW });
    if (opts.json) {
      console.log(JSON.stringify(map, null, 2));
      return;
    }
    process.stdout.write(formatRepoMap(map));
  });

program
  .command("init")
  .description("Wire Graft into the AI coding agents used with this repo (instruction files + MCP server; full hooks + statusline + MCP for Claude Code)")
  .argument("[dir]", "target repo directory", ".")
  .option("--no-build", "skip building the graph (wire files only)")
  .option("--agents <ids...>", `only these agents (${hostIds().join(", ")}, claude)`)
  .option("--all-agents", "write instruction files for every known agent, detected or not")
  .option("--no-agents", "Claude Code wiring only; skip other agents")
  .option("--list-agents", "list known agent ids and exit")
  .option("--no-mcp", "skip MCP server registration for other agents")
  .option("--no-hooks", "skip hook installation for other agents")
  .option("--no-statusline", "skip writing Claude Code statusLine (keep a user-defined one)")
  .option("--dry-run", "print every file init would touch, then exit without writing")
  .option("-y, --yes", "skip the picker and wire every detected agent (the pre-0.8 default)")
  .option("--no-global", "skip writes outside this repo (the ~/.codex/ config + hooks)")
  .option("--trail <handoff>", "attach a Trail: <brainId>:<token> (or a bare id with GRAFT_BRAIN_TOKEN set)")
  .option("--verbose", "print every file written, the graph build's own output and the closing banner")
  .action(async (dir: string, opts: InitOptions) => {
    await runInitCommand(dir, opts);
  });

/** `graft init`'s flags, as commander hands them over. */
interface InitOptions { build?: boolean; agents?: string[]; allAgents?: boolean; listAgents?: boolean; mcp?: boolean; hooks?: boolean; statusline?: boolean; dryRun?: boolean; yes?: boolean; global?: boolean; trail?: string; verbose?: boolean }

/** `a, b and c`. */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Repo-relative with forward slashes, for printing. */
function shown(repo: string, path: string): string {
  return relative(repo, path).split("\\").join("/");
}

/**
 * `graft init`. Also run by `graft trail push` on a repo graft has not been set
 * up in — the Trail pages start people at push, and a trail whose rules no
 * coding agent reads is only half set up. `epilogue: false` leaves out the
 * closing banner when push is going to keep talking.
 */
async function runInitCommand(
  dir: string,
  opts: InitOptions,
  how: { epilogue?: boolean; push?: boolean } = {},
): Promise<{ ids: string[] } | null> {
    if (opts.listAgents) {
      for (const id of [...hostIds(), "claude"]) console.log(id);
      return null;
    }
    // Parsed before anything is written: a mistyped handoff should cost the user
    // an error, not a half-wired repo they have to `graft uninstall` out of.
    let brainLink: BrainLink | undefined;
    if (opts.trail) {
      const parsed = parseBrainArg(opts.trail);
      if ("error" in parsed) {
        console.error(`✗ --trail: ${parsed.error}`);
        process.exitCode = 1;
        return null;
      }
      brainLink = parsed;
    }
    const repo = resolve(dir);
    const explicit = Array.isArray(opts.agents) ? opts.agents : undefined;

    if (explicit) {
      const validIds = [...hostIds(), "claude"];
      const unknown = explicit.filter((id) => !validIds.includes(id));
      if (unknown.length) {
        console.error(`✗ unknown agent id(s): ${unknown.join(", ")} — valid: ${validIds.join(", ")}`);
        process.exit(1);
      }
    }

    // Which agents to wire, decided before anything is written. Explicit flags
    // win; otherwise prompt on a TTY, and on a pipe write nothing rather than
    // guessing (pre-0.8 this silently wired every agent the machine had ever
    // installed — see --yes to get that back).
    const home = homedir();
    const plan = planInit(repo, { home });
    const detectedIds = plan.filter((p) => p.detected).map((p) => p.id);
    const noAgents = (opts as { agents?: unknown }).agents === false;

    let ids: string[];
    // The consent answer from the picker. Undefined everywhere else — a scripted
    // or flag-driven init never asked, so it must not silently answer.
    let consent: boolean | undefined;
    if (explicit) ids = explicit;
    else if (opts.allAgents) ids = plan.map((p) => p.id);
    else if (noAgents) ids = ["claude"];
    else if (opts.yes || opts.dryRun) ids = detectedIds;
    else if (process.stdin.isTTY && process.stderr.isTTY) {
      // Only offer the row when telemetry could actually run. `disabled` still
      // counts: someone who turned it off should be able to turn it back on here.
      const reason = offReason();
      const picked = await runPicker(plan, repo, home, {
        offerTelemetry: reason === null || reason === "disabled",
        // From push, the line above the picker already asks the question.
        ...(how.push ? { title: null } : {}),
      });
      if (picked === null) {
        console.error("· cancelled — nothing written");
        return null;
      }
      ids = picked.hosts;
      consent = picked.telemetry;
    } else {
      console.error(formatNonInteractiveHelp(detectedIds));
      return null;
    }

    // The picker's answer, recorded before anything is wired: a user who
    // unchecked the row must not have this run's init_completed sent.
    if (consent !== undefined) {
      patchState({ enabled: consent, noticeShownAt: new Date().toISOString() });
    }

    // Workspace parent: every child repo gets its OWN wiring too. A session
    // opens at a repo root, not at the parent, and reads `.claude/` from there —
    // wiring only the parent leaves each child with no skill, hooks, or MCP.
    // The parent's own wiring stays (queries there federate across children).
    const children = isWorkspaceBuildRoot(repo, program.opts<GlobalOpts>().dir)
      ? discoverWorkspaceChildren(repo)
      : [];
    // Parent FIRST: its build is the workspace build, which builds every child's
    // graph, so each child's own `buildGraphIfMissing` then finds one and no-ops.
    const targets = [repo, ...children.map((c) => join(repo, c))];

    if (opts.dryRun) {
      console.error(formatPlan(plan, ids, repo, home));
      for (const child of children)
        console.error(`\n— ${child}/ (workspace child)\n` + formatPlan(planInit(join(repo, child), { home }), ids, join(repo, child), home));
      return null;
    }
    if (ids.length === 0) {
      console.error("· no agents selected — nothing written");
      return null;
    }

    const wantClaude = ids.includes("claude");
    const cliPath = fileURLToPath(import.meta.url);

    if (children.length)
      console.error(`· workspace: wiring ${repo} and ${children.length} child repo(s) — ${children.join(", ")}`);

    // Today's output, file by file, behind --verbose. Everything else gets one
    // line per step: the graph, then one per agent.
    const verbose = opts.verbose === true;
    const reports: WireReport[] = [];
    for (const target of targets) {
      if (verbose && target !== repo) console.error(`\n— ${relative(repo, target)}/`);
      reports.push(wireTarget(target, ids, { home, cliPath, plan, opts, wantClaude, quiet: !verbose }));
    }

    // The graph, built once after the wiring: a workspace parent's build is
    // the workspace build, so it covers every child.
    let graphLine: string | null = null;
    let graphNodes = 0;
    if (!verbose) {
      const res = await buildGraphWithProgress(repo, { build: opts.build, cliPath });
      for (const m of res.messages) console.error(m);
      const existing = res.built ? null : loadGraphCached(contextDirFor(repo, children.length ? undefined : program.opts<GlobalOpts>().dir));
      const fmt = (x: number) => x.toLocaleString("en-US");
      if (res.graph) {
        graphNodes = res.graph.nodes;
        graphLine = `✓ graph built · ${fmt(res.graph.nodes)} nodes, ${fmt(res.graph.edges)} edges${res.graph.files ? ` from ${fmt(res.graph.files)} file${res.graph.files === 1 ? "" : "s"}` : ""}`;
      } else if (res.built) {
        graphLine = "✓ graph built";
      } else if (res.failed) {
        graphLine = "⚠ the graph build failed — run graft build to see why";
      } else if (existing) {
        graphNodes = existing.meta.nodeCount;
        graphLine = `✓ graph ready · ${fmt(existing.meta.nodeCount)} nodes, ${fmt(existing.meta.edgeCount)} edges`;
      } else if (hasGraftIndex(repo)) {
        graphLine = "✓ graph ready";
      } else {
        graphLine = "· skipped the graph build — run graft build";
      }
    }

    if (!verbose) {
      // Warnings and removals in full, whatever else is folded.
      const removed = [...new Set(reports.flatMap((r) => r.retracted))];
      for (const id of removed) console.error(`- removed ${id} — agent not selected`);
      for (const w of reports.flatMap((r) => r.warnings)) console.error(w);
      const writesFor = (id: string) =>
        (plan.find((p) => p.id === id)?.writes ?? []).filter((w) => opts.global !== false || w.scope !== "global");
      if (how.push) {
        const built = graphLine?.startsWith("✓ graph built") ? `graph built, ${graphNodes.toLocaleString("en-US")} nodes` : graphLine?.startsWith("✓") ? "graph ready" : null;
        console.error(`✓ wired ${joinAnd(ids)}${built ? ` · ${built}` : ""}`);
        if (graphLine && !graphLine.startsWith("✓")) console.error(graphLine);
      } else {
        if (graphLine) console.error(graphLine);
        const width = Math.max(...ids.map((id) => id.length));
        for (const id of ids) {
          const summary = compactWrites(writesFor(id), repo, home);
          console.error(`✓ ${id.padEnd(width)}   ${summary}`.trimEnd());
        }
      }
    }

    // The brain comes last, after the graph exists: its rules are anchored to
    // symbols, and `graft trail status` can only report how many of them resolve
    // once there is a graph to resolve them against.
    if (brainLink) {
      const res = await connectBrain(repo, brainLink, { home, ids });
      if (verbose) {
        if (res.warning) console.error(`⚠ brain: ${res.warning}`);
        else console.error(`✓ brain: pulled ${res.ruleCount} rule(s) from ${brainLink.brainId}`);
        for (const w of res.writes) console.error(`✓ brain rules: ${w.path} (${w.action})`);
        if (res.ruleCount > 0 && res.writes.length === 0)
          console.error("· no instruction file to write rules into — graft ask still carries them");
      } else if (res.warning) {
        console.error(`⚠ trail: ${res.warning}`);
      } else if (res.ruleCount === 0) {
        console.error("✓ trail connected · no rules yet — graft trail push reads this repo into it");
      } else {
        const where = res.writes.map((w) => shown(repo, w.path)).join(", ");
        const n = `${res.ruleCount.toLocaleString("en-US")} rule${res.ruleCount === 1 ? "" : "s"}`;
        console.error(`✓ trail connected · ${n}${where ? ` in ${where}` : ""}`);
      }
    }

    if (!verbose && how.epilogue !== false) {
      // What there is to commit: the top-level entries the picked agents wrote.
      const tops: string[] = [];
      for (const w of selectedWrites(plan, ids)) {
        if (w.scope !== "repo") continue;
        const parts = shown(repo, w.path).split("/");
        const top = parts.length > 1 ? `${parts[0]}/` : parts[0]!;
        if (!tops.includes(top)) tops.push(top);
      }
      console.error("· restart your agents so a new session picks up graft");
      if (tops.length)
        console.error(`· commit ${tops.slice(0, 4).join(" ")}${tops.length > 4 ? ` +${tops.length - 4} more` : ""} to share it — graft/ stays local and git-ignored`);
    }

    // One epilogue for the whole run. A workspace parent holds no nodes of its
    // own, so the totals come from the children — the graph the user actually got.
    const globalDir = program.opts<GlobalOpts>().dir;
    const graphs = (children.length ? children.map((c) => join(repo, c)) : [repo])
      .map((d) => loadGraphCached(contextDirFor(d, children.length ? undefined : globalDir)))
      .filter((g): g is NonNullable<typeof g> => g !== null);
    if (verbose && how.epilogue !== false) console.error(
      "\n" +
        formatInitEpilogue({
          graphBuilt: graphs.length > 0,
          nodes: graphs.reduce((n, g) => n + g.meta.nodeCount, 0),
          edges: graphs.reduce((n, g) => n + g.meta.edgeCount, 0),
        }),
    );
    // Sorted so `claude,cursor` and `cursor,claude` aggregate as one value.
    track(
      "init_completed",
      { agents: [...ids].sort().join(","), consent: consent === undefined ? "unasked" : String(consent) },
      { repo },
    );
    return { ids };
}

/** What one target's wiring did, for the compact summary to report. */
interface WireReport {
  /** Hosts whose files were removed because they were not selected. */
  retracted: string[];
  /** ⚠ lines, printed in full. */
  warnings: string[];
}

/** One repo's worth of `init` writes — the parent, then each workspace child. */
function wireTarget(
  repo: string,
  ids: string[],
  ctx: {
    home: string;
    cliPath: string;
    plan: ReturnType<typeof planInit>;
    wantClaude: boolean;
    opts: { build?: boolean; mcp?: boolean; hooks?: boolean; global?: boolean; statusline?: boolean };
    /** Collect warnings and removals instead of printing a line per file, and
     *  leave the graph build to the caller (see buildGraphWithProgress). */
    quiet?: boolean;
  },
): WireReport {
    const { home, cliPath, plan, wantClaude } = ctx;
    const quiet = ctx.quiet === true;
    const opts = quiet ? { ...ctx.opts, build: false } : ctx.opts;
    const report: WireReport = { retracted: [], warnings: [] };
    // Every per-file line goes through here; in quiet mode only ⚠ lines survive.
    const say = (line: string) => {
      if (!quiet) console.error(line);
      else if (line.startsWith("⚠")) report.warnings.push(line);
    };
    const wantStatusline = statuslineWanted({ statusline: opts.statusline });

    // Converge, don't just add. init writes the selected hosts; without this it
    // never touches the rest, so a repo wired by an older version (or by the same
    // version with different --agents) keeps that run's files forever — and
    // `reconcileWiring` then keeps them *up to date*, which is worse than stale.
    // Retract every host NOT being written now; `exclude` spares the ones about to
    // be rewritten, and the graph cache is kept (init is one step from using it).
    const retracted = changed(
      runRetract(repo, { home, apply: true, global: opts.global, cache: false, exclude: ids }),
    ).filter((r) => r.action !== "skipped-unparseable");
    for (const r of retracted) say(`- removed ${r.path} (${r.what}) — agent not selected`);
    report.retracted = [...new Set(retracted.map((r) => r.hostId))];

    if (wantClaude) {
      // `global`/`home` are threaded through alongside `statusline`: the claude layer
      // writes under `~/.claude` now (hosts/claude-global.ts), so --no-global has to
      // reach it or the flag would silently mean "no out-of-repo writes, except three".
      const res = runInit(repo, { build: opts.build, cliPath, statusline: wantStatusline, global: opts.global, home });
      say(`✓ wrote ${res.settingsPath}`);
      for (const s of res.shims) say(`✓ wrote ${s}`);
      say(`✓ wrote ${res.skill}`);
      if (res.mcp.action === "skipped-unparseable")
        say(`⚠ .mcp.json: ${res.mcp.path} left unchanged (not valid JSON) — add the graft server manually`);
      else if (res.mcp.action === "unchanged")
        say(`· mcp claude: ${res.mcp.path} (already registered)`);
      else
        say(`✓ mcp claude: ${res.mcp.path} (${res.mcp.action}) — restart Claude Code to load the graft MCP server`);
      say(res.built ? "✓ built the graph (graft build)" : "· skipped graph build");
      if (!wantStatusline) say("· skipped Claude Code statusLine (--no-statusline)");
      for (const w of res.warnings) say(`⚠ ${w}`);
    }

    // `ids` is already resolved, so hosts init is always driven by an explicit
    // list — never by its own detection fallback.
    const others = ids.filter((id) => id !== "claude");
    if (others.length > 0) {
      const r = runHostsInit(repo, {
        agents: others,
        home,
        mcp: opts.mcp,
        hooks: opts.hooks,
        global: opts.global,
      });
      for (const w of r.written) say(`✓ ${w.id}: ${w.path} (${w.action})`);
      for (const m of r.mcp) say(`✓ mcp ${m.id}: ${m.path} (${m.action})`);
      for (const h of r.hooks) say(`✓ hook ${h.id}: ${h.path} (${h.action})`);
      // Only worth saying when there was actually something out-of-repo to skip.
      if (opts.global === false && selectedWrites(plan, ids).some((w) => w.scope === "global"))
        say("· skipped out-of-repo writes (--no-global)");
    }

    // Record WHICH graft wrote this repo's agent files, and under which flags.
    // Every entry point compares this against the running binary and re-writes
    // them on a mismatch, so an `npm i -g` upgrade reaches the hooks/skill/rules
    // too — not just the binary. The flags ride along so a refresh replays the
    // user's choices (notably --no-global) instead of overriding them.
    writeStamp(repo, currentVersion, ids, {
      global: opts.global !== false,
      mcp: opts.mcp !== false,
      hooks: opts.hooks !== false,
      statusline: wantStatusline,
    });

    // Every host's wiring points at graft/, so the graph is built whatever was
    // selected — not only when Claude Code is in the list (runInit does its own).
    if (!wantClaude) {
      if (!quiet)
        say(
          buildGraphIfMissing(repo, { build: opts.build, cliPath })
            ? "✓ built the graph (graft build)"
            : "· skipped graph build",
        );
    }
    return report;
}

/** Group a retraction report by host, so the output reads as "what leaves each agent". */
function formatRetractions(rs: Retraction[], apply: boolean): string {
  const hit = changed(rs);
  if (hit.length === 0) return "· nothing to remove — no graft wiring found here";
  const verb = apply ? "removed" : "would remove";
  const lines: string[] = [];
  const byHost = new Map<string, Retraction[]>();
  for (const r of hit) {
    const k = byHost.get(r.hostId) ?? [];
    k.push(r);
    byHost.set(r.hostId, k);
  }
  for (const [host, items] of byHost) {
    lines.push(`\n${host}:`);
    for (const r of items) {
      const mark =
        r.action === "skipped-unparseable"
          ? "⚠"
          : r.action === "deleted"
            ? "-"
            : "~";
      const note =
        r.action === "skipped-unparseable"
          ? " — not valid JSON, left untouched (remove the graft entry by hand)"
          : r.action === "deleted"
            ? ` (${r.what} — deleted)`
            : ` (${r.what})`;
      const scope = r.scope === "global" ? " [machine-wide]" : "";
      lines.push(`  ${mark} ${verb}: ${r.path}${scope}${note}`);
    }
  }
  return lines.join("\n").replace(/^\n/, "");
}

program
  .command("uninstall")
  .description("Remove every file and config entry graft has written to this repo (the inverse of init)")
  .argument("[dir]", "target repo directory", ".")
  .option("-y, --yes", "actually remove (without this, prints what it would remove and exits)")
  .option("--keep-cache", "keep graft/ and the .gitignore entries — wiring only")
  .option("--no-global", "leave out-of-repo files alone (~/.codex, ~/.gemini)")
  .action((dir: string, opts: { yes?: boolean; keepCache?: boolean; global?: boolean }) => {
    const repo = resolve(dir);
    const home = homedir();
    const common = { home, global: opts.global, cache: opts.keepCache ? false : true };

    if (!opts.yes) {
      console.error(formatRetractions(planRetract(repo, common), false));
      console.error("\nDry run — nothing was touched. Re-run with -y to remove.");
      if (opts.global !== false)
        console.error("Entries marked [machine-wide] affect every project; --no-global skips them.");
      return;
    }
    const done = runRetract(repo, { ...common, apply: true });
    console.error(formatRetractions(done, true));
    const bad = changed(done).filter((r) => r.action === "skipped-unparseable");
    console.error(
      bad.length
        ? `\n⚠ ${bad.length} file(s) could not be parsed and were left as-is — see above.`
        : "\n✓ graft fully removed. `graft init` re-wires from scratch.",
    );
  });

// `graft trail …` still works: see legacy-args.ts.
const brain = program
  .command("trail")
  .description("The Trail attached to this repo: the rules mined from its own history");

/**
 * Get this repo a trail from the terminal, by sending the user through signup
 * in their browser and catching the handoff on loopback.
 *
 * Returns the link, already saved, or null when the user should be left alone —
 * every failure prints its own reason first, because the caller only needs to
 * know whether to carry on. Nothing about the repository has been read or sent
 * by then, and every message says so.
 */
async function signUpForBrain(repo: string, slug: string): Promise<BrainLink | null> {
  // No terminal means an agent is running this, and a loopback listener cannot
  // outlive the command it is waiting in: see signUpWithoutTerminal.
  if (!process.stderr.isTTY) return signUpWithoutTerminal(repo, slug);
  const handoff = await startHandoff();
  const url = signupUrl({ repo: slug, port: handoff.port, state: handoff.state });
  const startedAt = Date.now();

  // Queued before the link is printed rather than after the outcome, because
  // the outcome is the one thing a terminal handoff can lose: a user who reads
  // the URL and walks away kills the process, and only an event already on disk
  // survives that. This is the denominator; `brain_signup_settled` is not.
  track("brain_signup_opened", { mode: "terminal" }, { repo });

  // Printed before the browser opens, and printed whether or not it opens: on a
  // remote shell nothing can open, and on a desktop the window sometimes lands
  // behind the terminal. The URL is the thing that always works.
  console.error(`· ${slug} has no trail yet — opening your browser to make one:`);
  console.error(`  ${url}`);

  openBrowser(url);
  const spinner = startSpinner("waiting for you to finish signing up · Ctrl-C to stop");

  // Ctrl-C while waiting is a person changing their mind, not a crash: say that
  // nothing was sent, and leave with the usual interrupted exit code.
  let onSigint: (() => void) | undefined;
  const stopped = new Promise<"stopped">((resolve) => {
    onSigint = () => resolve("stopped");
    process.once("SIGINT", onSigint);
  });
  const got = await Promise.race([handoff.wait(), stopped]);
  if (onSigint) process.off("SIGINT", onSigint);
  spinner.stop();
  if (got === "stopped") {
    handoff.close();
    console.error("· stopped — nothing was sent; run graft trail push again when you're ready");
    track("brain_signup_settled", { outcome: "stopped", mode: "terminal", duration_bucket: durationBucket(Date.now() - startedAt) }, { repo });
    process.exitCode = 130;
    return null;
  }
  if ("error" in got) {
    console.error(`✗ ${got.error}`);
    // The category, never the sentence: `got.error` names the repo and the link.
    track("brain_signup_settled", { outcome: got.reason, mode: "terminal", duration_bucket: durationBucket(Date.now() - startedAt) }, { repo });
    return null;
  }
  writeLink(repo, got.link);
  console.error(`✓ trail connected · ${slug} — your browser shows it building`);
  track("brain_signup_settled", { outcome: "linked", mode: "terminal", duration_bucket: durationBucket(Date.now() - startedAt) }, { repo });
  return got.link;
}

/**
 * The same sign-up when an agent runs the push, in two runs of one command.
 *
 * An agent shows the person nothing until a command exits, so the first run
 * opens the sign-up page, saves the state in its link and exits at once, with
 * a line telling the agent what to do next. The run after that finds the saved
 * state and asks Trail for the trail it made, for up to AGENT_WAIT_MS, then
 * carries on with the push. Still not signed up by then, it says so and the
 * agent runs it again. Nothing about the repository is read or sent until the
 * trail is linked.
 */
async function signUpWithoutTerminal(repo: string, slug: string): Promise<BrainLink | null> {
  const startedAt = Date.now();
  const settled = (outcome: string) =>
    track("brain_signup_settled", { outcome, mode: "agent", duration_bucket: durationBucket(Date.now() - startedAt) }, { repo });
  const pending = readPendingSignup(repo, slug, PENDING_SIGNUP_TTL_MS);

  if (!pending) {
    const state = newSignupState();
    writePendingSignup(repo, { state, repo: slug, createdAt: Date.now() });
    const url = signupUrl({ repo: slug, state });
    track("brain_signup_opened", { mode: "agent" }, { repo });
    openBrowser(url);
    console.error(`· ${slug} has no trail yet — opened Trail's sign-up page in the browser:`);
    console.error(`  ${url}`);
    console.error("· nothing has been read or sent yet.");
    console.error(
      "· next: ask the user to sign up in the tab that just opened (or at the link above), then run `graft trail push` again straight away — it waits for the sign-up to finish and carries on with the push. Don't wait for them to reply first.",
    );
    settled("agent_link_opened");
    process.exitCode = 1;
    return null;
  }

  const url = signupUrl({ repo: slug, state: pending.state });
  console.error(`· waiting up to ${Math.round(AGENT_WAIT_MS / 1000)} s for the sign-up for ${slug} to finish:`);
  console.error(`  ${url}`);
  const got = await waitForSignup(pending.state, apiBaseUrl());

  if ("link" in got) {
    clearPendingSignup(repo);
    writeLink(repo, got.link);
    console.error(`✓ trail connected · ${slug}`);
    settled("linked");
    return got.link;
  }
  if ("pending" in got) {
    console.error("· not signed up yet — nothing has been read or sent.");
    console.error("· next: run `graft trail push` again to keep waiting. The link above stays valid for about 15 minutes.");
    settled("still_waiting");
    process.exitCode = 1;
    return null;
  }
  clearPendingSignup(repo);
  console.error(`✗ ${got.error}`);
  settled(got.reason);
  process.exitCode = 1;
  return null;
}

brain
  .command("connect")
  .description("Attach a brain to this repo and pull its rules")
  .argument("<handoff>", "<brainId>:<token>, or a bare brain id with GRAFT_BRAIN_TOKEN set")
  .argument("[dir]", "target repo directory", ".")
  .action(async (handoff: string, dir: string) => {
    const parsed = parseBrainArg(handoff);
    if ("error" in parsed) {
      console.error(`✗ ${parsed.error}`);
      process.exitCode = 1;
      return;
    }
    const repo = resolve(dir);
    const res = await connectBrain(repo, parsed, { home: homedir() });
    if (res.warning) {
      console.error(`⚠ ${res.warning}`);
      return;
    }
    if (res.ruleCount === 0) {
      // The normal case on the local route: the brain exists but nothing has
      // read the repo yet. Saying "0 rules" without saying why reads as a
      // failure, and the next step is the whole point.
      console.error("✓ attached this repo to the brain — it has no rules yet");
      console.error("· run `graft trail push` to read this repository into it");
      return;
    }
    console.error(`✓ pulled ${res.ruleCount} rule(s) from ${parsed.brainId}`);
    for (const w of res.writes) console.error(`✓ ${w.path} (${w.action})`);
  });

brain
  .command("pull")
  .description("Refresh the trail's rules and write every change you accepted in Trail into this repo's context files")
  .argument("[dir]", "target repo directory", ".")
  .option("--dry-run", "show what would change without writing anything or telling Trail")
  .action(async (dir: string, opts: { dryRun?: boolean }) => {
    await runTrailPullCommand(dir, opts);
  });

/** `graft trail pull`, and `graft claude-md pull` which is now the same thing. */
async function runTrailPullCommand(dir: string, opts: { dryRun?: boolean }): Promise<void> {
  const repo = resolve(dir);
  const link = readLink(repo);
  if (!link) {
    console.error("✗ this repo has no trail yet — run graft trail push first");
    process.exitCode = 1;
    return;
  }
  const stamp = readStamp(repo);
  const wired = [...new Set([...(stamp?.hosts ?? []), ...wiredHostIds(repo)])];
  const code = await runTrailPull(repo, link, { home: homedir(), wired, dryRun: opts.dryRun });
  if (code !== 0) process.exitCode = code;
}

/** A positive number of seconds or minutes from an option, or null. */
function positiveNumber(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

brain
  .command("watch")
  .description("Wait until Trail has suggestions to review or accepted changes to pull, then say so once")
  .argument("[dir]", "target repo directory", ".")
  .option("--interval <seconds>", "how often to check Trail", String(WATCH_DEFAULTS.intervalMs / 1000))
  .option("--settle <seconds>", "how long the accepted changes must stay the same before they are reported", String(WATCH_DEFAULTS.settleMs / 1000))
  .option("--timeout <minutes>", "give up after this long (exit code 2)", String(WATCH_DEFAULTS.timeoutMs / 60_000))
  .option("--accepted-only", "keep waiting while suggestions are only waiting for review; stop on accepted changes")
  .option("--json", "print the result as JSON")
  .option("--verbose", "print the counts on every check, to stderr")
  .addHelpText(
    "after",
    [
      "",
      "Stops when any of these is true, and prints one block to stdout:",
      "  - there are suggestions and none accepted (unless --accepted-only)   exit 0",
      "  - accepted changes have not changed for --settle seconds              exit 0",
      "  - --timeout minutes have passed                                       exit 2",
      "A failed check is retried on the next one. No trail attached, or a token Trail refuses: exit 1.",
    ].join("\n"),
  )
  .action(
    async (
      dir: string,
      opts: { interval: string; settle: string; timeout: string; acceptedOnly?: boolean; json?: boolean; verbose?: boolean },
    ) => {
      const repo = resolve(dir);
      const interval = positiveNumber(opts.interval);
      const settle = Number(opts.settle);
      const timeout = positiveNumber(opts.timeout);
      if (interval === null || timeout === null || !Number.isFinite(settle) || settle < 0) {
        console.error("✗ --interval and --timeout take a number above zero, --settle a number of seconds (0 or more)");
        process.exitCode = 1;
        return;
      }
      const timeoutMs = timeout * 60_000;
      const finish = (r: WatchTrailResult) => {
        if (opts.json) console.log(JSON.stringify(watchExitJson(r), null, 2));
        else for (const line of watchExitLines(r, timeoutMs)) console.log(line);
        trackWatchExit(repo, r);
        const code = watchExitCode(r);
        if (code !== 0) process.exitCode = code;
      };
      const link = readLink(repo);
      if (!link) {
        finish({ reason: "no_trail", suggested: null, accepted: 0, files: [], reviewUrl: "", waitedMs: 0, everRead: false });
        return;
      }
      const result = await watchTrail(repo, link, {
        wired: pickedAgents(repo),
        intervalMs: interval * 1000,
        settleMs: settle * 1000,
        timeoutMs,
        acceptedOnly: opts.acceptedOnly === true,
        onTick: opts.verbose
          ? (r) => {
              const at = new Date().toTimeString().slice(0, 8);
              if (!r.ok) console.error(`· ${at} ${r.fatal ? "refused" : "retrying next check"}: ${r.error}`);
              else console.error(`· ${at} ${r.snapshot.suggested ?? "?"} suggested, ${r.snapshot.accepted} accepted`);
            }
          : undefined,
      });
      finish(result);
    },
  );

brain
  .command("push")
  .description("Read THIS repo on your machine and build its trail — no GitHub App, works on private repos")
  .argument("[dir]", "target repo directory", ".")
  .option("--no-approve", "leave the mined rules as drafts for review")
  .option("--no-watch", "return as soon as the push is sent, without following the build")
  .option("--verbose", "print each step's counts and every build stage as it finishes")
  .action(async (dir: string, opts: { approve?: boolean; watch?: boolean; verbose?: boolean }) => {
    const repo = resolve(dir);
    const tty = Boolean(process.stderr.isTTY);
    const verbose = opts.verbose === true;
    // Resolved before the link, because an unlinked repo now signs up for a
    // trail and Trail creates that trail FOR a named repository. Without a slug
    // there is nothing to name it after — and the digest builder would fail on
    // the same missing remote a moment later regardless.
    const here = repoSlugFromGit(repo);
    let link = readLink(repo);
    // Set when this run opened the browser, which then sits on Trail's build
    // page: the closing lines point at that tab instead of printing a new link.
    let browserOpen = false;
    if (!link && process.env[AUTOPUSH_CHILD_ENV]) {
      // Started in the background by the session-start hook, which only does so
      // for a repo with a trail. The link has gone since (a disconnect in the
      // same moment): signing up would open a browser nobody asked for, so stop.
      console.error("· background push skipped — this repo no longer has a trail attached");
      return;
    }
    if (!link) {
      if (!here) {
        console.error("✗ this directory has no GitHub origin remote — graft can only push a GitHub repository today");
        process.exitCode = 1;
        return;
      }
      const signedUp = await signUpForBrain(repo, `${here.owner}/${here.name}`);
      if (!signedUp) {
        if (!process.exitCode) process.exitCode = 1;
        return;
      }
      link = signedUp;
      browserOpen = true;
    }
    // What the website said this trail is for. Checked BEFORE any reading, so
    // standing in the wrong checkout costs a message rather than a trail full
    // of another repository's rules — a mistake that is silent afterwards,
    // because the rules look perfectly plausible, just not about your code.
    const expected = await fetchExpectedRepo(link);
    if (expected && here && !sameRepo(expected.slug, `${here.owner}/${here.name}`)) {
      console.error(`✗ this trail is for ${expected.slug}, but you are in ${here.owner}/${here.name}`);
      console.error(`  cd into ${expected.slug} and run this again, or attach a different trail here.`);
      process.exitCode = 1;
      return;
    }
    const ctx = pushContext(repo);
    if (!ctx) {
      console.error("✗ this directory has no GitHub origin remote — graft can only push a GitHub repository today");
      process.exitCode = 1;
      return;
    }
    const firstPush = !expected || expected.ruleCount === 0;

    // The instruction files and the newest pull requests go first, when the
    // trail takes them: its suggestions start from those while the rest of the
    // history is still being read here. In the background, from here on — the
    // picker, the graph build and the full read all happen while it goes, and
    // the full read reuses every GitHub request it made.
    let early: Promise<void> = Promise.resolve();
    if (expected?.earlyUpload) {
      early = (async () => {
        const first = await buildEarlyDigest(repo, { context: ctx });
        if (!first) return;
        const ok = await pushEarlyDigest(link!, first.digest, fetch, { gzip: expected.gzipUpload });
        if (ok && verbose) console.error("· sent the instruction files and the newest pull requests first, so suggestions start now");
      })().catch(() => undefined);
    }

    // A repo graft was never set up in gets `graft init` first. Same picker as
    // init: it is how someone agrees to what gets written, so a
    // non-interactive push only says what to run.
    if (wiredHostIds(repo).length === 0) {
      if (process.stdin.isTTY && tty) {
        console.error("· graft isn't set up here yet — pick the agents your team uses:");
        await runInitCommand(
          repo,
          { build: true, mcp: true, hooks: true, statusline: true, global: true, verbose },
          { epilogue: false, push: !verbose },
        );
      } else {
        console.error("· graft isn't set up here — run graft init so your agents read these rules");
      }
    }

    // The graph is what symbol anchors are resolved against, so a rule mined
    // here can later go stale on its own. Without one the ingest still works;
    // its rules simply govern the repo rather than a symbol in it.
    const graph = loadGraphCached(contextDirFor(repo, program.opts<GlobalOpts>().dir));
    if (!graph) console.error("· no graph yet — run graft build so rules can be anchored to symbols");
    const reading = startSpinner(`reading ${ctx.owner}/${ctx.name} · commits, pull-request discussion and the docs in the tree`);
    const built = await buildLocalDigest(repo, graph, { autoApprove: opts.approve !== false, context: ctx });
    if ("error" in built) {
      reading.stop();
      console.error(`✗ ${built.error}`);
      process.exitCode = 1;
      return;
    }
    const d = built.digest;
    reading.update("sending it to Trail");
    await early;
    const sent = await pushDigest(link, d, fetch, uploadCaps(expected));
    reading.stop();
    if (built.warning) console.error(`⚠ ${built.warning}`);
    if ("error" in sent) {
      console.error(`✗ ${sent.error}`);
      process.exitCode = 1;
      return;
    }
    // What the session-start hook's background refresh compares HEAD against:
    // a push of history Trail already has would mine the same rules again.
    recordTrailPush(repo, ctx.headSha);
    const fmt = (x: number) => x.toLocaleString("en-US");
    const trailLabel = expected?.brainName ? `“${expected.brainName}”` : `${d.owner}/${d.name}`;
    console.error(
      `✓ sent ${fmt(d.commits.length)} commits and ${fmt(d.threads.length)} discussions to ${trailLabel} · no file contents left this machine`,
    );
    if (verbose) console.error(`  ${fmt(d.symbols.length)} symbols, ${fmt(d.sources.length)} stated sources`);

    const buildPage = brainUrl(link.brainId);
    // Held rather than handed back. Everything above this line succeeded even
    // in the runs that end badly: the push lands, and then the miner fails —
    // which is where roughly a third of production's repo trails die. Returning
    // the prompt here is what made that invisible from this side, on CI and
    // over SSH permanently so. `--no-watch` is for a caller that genuinely
    // wants fire-and-forget.
    if (opts.watch === false) {
      console.error("· building now — the rules reach this repo on their own; watch it at");
      console.error(`  ${buildPage}`);
      return;
    }

    const live = tty && !verbose;
    if (!live) console.error("· building the trail");
    const spinner = live ? startSpinner("building the trail · reaching the repository · Ctrl-C detaches") : null;
    let last: RepoState | null = null;
    // Ctrl-C detaches: the work is server-side, and killing a watcher must
    // never look like killing the build.
    const onSigint = () => {
      spinner?.stop();
      console.error("· detached — the build keeps going; watch it at");
      console.error(`  ${buildPage}`);
      process.exit(130);
    };
    process.once("SIGINT", onSigint);
    const outcome = await watchBuild(link, {
      events: expected?.events === true,
      stageLines: !live,
      write: (line) => (spinner ? spinner.print(line) : console.error(line)),
      onState: (view, repoState) => {
        last = repoState;
        spinner?.update(`building the trail · ${DOING_LABEL[currentStage(view)]} · Ctrl-C detaches`);
      },
    });
    process.off("SIGINT", onSigint);
    spinner?.stop();

    const ruleCount = rulesSoFar(last);
    const rules = `${fmt(ruleCount)} rule${ruleCount === 1 ? "" : "s"}`;
    const wired = [...new Set([...(readStamp(repo)?.hosts ?? []), ...wiredHostIds(repo)])];
    const closing = () => {
      const line = suggestionsLine((last as RepoState | null)?.suggestions, wired, !firstPush);
      if (!line) return;
      if (browserOpen) {
        console.error(`${line} — they are in the Trail tab in your browser`);
        console.error(`  ${reviewUrl(link!.brainId)}`);
      } else {
        console.error(line);
        console.error(`  review: ${reviewUrl(link!.brainId)}`);
      }
    };
    if (outcome === "completed") {
      console.error(`✓ trail built · ${rules}, reaching this repo on their own`);
      closing();
      return;
    }
    // The ordinary ending for anything but a small repository. The history is
    // mined in slices, and the prompt comes back on the first of them: mining is
    // the part that fails and it has now succeeded, and the rest is filing,
    // which is minutes of reliable work nobody gains by watching.
    if (outcome === "building") {
      console.error(
        firstPush
          ? `✓ trail has its first ${rules} · they reach this repo on their own`
          : `✓ trail updated · ${rules}, reaching this repo on their own`,
      );
      closing();
      return;
    }
    if (outcome === "failed") {
      // A non-zero exit, unlike every other ending here: this is the one case
      // where the work did not produce a trail, and a CI step that ran the push
      // should hear about it the way it hears about any other failure. The
      // watcher has already printed where it stopped and why.
      process.exitCode = 1;
      return;
    }
    if (outcome === "unreachable") {
      console.error("· lost touch with Trail — the build keeps going; watch it at the link below");
    } else {
      console.error("· still building after 15 minutes — not failed, just long; watch it at the link below");
    }
    console.error(`  ${buildPage}`);
  });

// `graft claude-md pull` is `graft trail pull` now: the CLAUDE.md changes are
// the first half of what that writes. Kept so the old name keeps working, but
// hidden from --help so people only ever see one pull command.
const claudeMd = program
  .command("claude-md", { hidden: true })
  .description("The CLAUDE.md changes this repo's trail suggested (now part of graft trail pull)");

claudeMd
  .command("pull")
  .description("Same as graft trail pull: write every change you accepted in Trail into this repo")
  .argument("[dir]", "target repo directory", ".")
  .option("--dry-run", "show what would change without writing anything or telling Trail")
  .action(async (dir: string, opts: { dryRun?: boolean }) => {
    console.error("· graft claude-md pull is now part of graft trail pull — running that");
    await runTrailPullCommand(dir, opts);
  });

brain
  .command("status")
  .description("Show the attached brain, how many rules are cached, and how many still match the code")
  .argument("[dir]", "target repo directory", ".")
  .option("--json", "machine-readable output")
  .action((dir: string, opts: { json?: boolean }) => {
    const repo = resolve(dir);
    const { link, rules, fetchedAt } = brainStatus(repo);
    // Resolve every cached rule against the CURRENT graph, so the count of stale
    // rules is the real one rather than what was true at pull time. This is the
    // number worth surfacing: it says how far the codebase has drifted from what
    // the team decided.
    const graph = loadGraphCached(contextDirFor(repo, program.opts<GlobalOpts>().dir));
    const applied = rulesForPointers(
      (graph?.nodes ?? []).map((n) => `${n.path}:${n.span}`),
      rules,
      graph,
    );
    if (opts.json) {
      console.log(JSON.stringify({ brainId: link?.brainId ?? null, cached: rules.length, fetchedAt, anchored: applied.length, stale: applied.filter((a) => a.stale).length }, null, 2));
      return;
    }
    if (!link) {
      console.error("· no brain attached — run `graft trail connect <brainId>:<token>`");
      return;
    }
    console.error(`brain ${link.brainId}`);
    console.error(`  ${rules.length} rule(s) cached${fetchedAt ? `, pulled ${new Date(fetchedAt).toISOString()}` : ""}`);
    if (!graph) {
      console.error("  no graph yet — run `graft build` to see which rules still match the code");
      return;
    }
    const stale = applied.filter((a) => a.stale);
    console.error(`  ${applied.length} anchored to symbols in this repo`);
    console.error(
      stale.length
        ? `  ${stale.length} describe code that has changed since:`
        : "  none describe code that has changed since",
    );
    for (const a of stale.slice(0, 10)) console.error(`    - ${a.rule}\n      ${a.pointer}`);
  });

brain
  .command("disconnect")
  .description("Forget the attached brain (its rules stay in the instruction files until the next init)")
  .argument("[dir]", "target repo directory", ".")
  .action((dir: string) => {
    const repo = resolve(dir);
    clearLink(resolve(dir));
    console.error(`✓ detached the brain from ${repo}`);
  });

program.parseAsync(withLegacyNames(process.argv)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
