/**
 * `graft trail pull`: one command for both things a trail hands this repo.
 *
 * First the rules, refreshed into graft's own blocks in the agent files (what
 * `graft trail pull` always did). Then every change accepted in Trail, for every
 * context file the picked agents read — the root CLAUDE.md (what `graft
 * claude-md pull` did, and still does, as an alias of this), and then AGENTS.md,
 * folder CLAUDE.md files, Cursor rules and skills when Trail serves them.
 *
 * Files for agents that were not picked are neither listed nor written.
 */
import { isAbsolute, relative } from "node:path";
import { connectBrain, type ConnectResult } from "./connect.js";
import { fetchAcceptedChanges, markApplied } from "./claude-md.js";
import {
  changeSummary,
  fetchContextFiles,
  kindForPath,
  markContextFilesApplied,
  planContextFile,
  readByWired,
  readersOf,
  writePlannedFile,
  type ContextFile,
  type FilePlan,
} from "./context-files.js";
import type { BrainLink } from "./link.js";
import { reviewUrl } from "./signup.js";
import { fetchRepoState, type RepoState, type Suggestions } from "./watch.js";
import { CONTEXT_FILE_KINDS, countBucket, type TrailPullOutcome } from "../telemetry/contract.js";
import { track } from "../telemetry/track.js";

export interface PullOptions {
  home: string;
  /** The agents this repo is wired for; empty means no choice was recorded. */
  wired: string[];
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
}

/** Repo-relative, forward slashes, for printing. */
function show(repo: string, path: string): string {
  const rel = isAbsolute(path) ? relative(repo, path) : path;
  return rel.split("\\").join("/");
}

/** The rules line: how many, and which files they are in. */
export function rulesLine(repo: string, res: ConnectResult): string | null {
  if (res.warning) return `⚠ ${res.warning}`;
  if (res.ruleCount === 0) return "· the trail has no rules yet — run graft trail push to read this repo into it";
  const n = res.ruleCount.toLocaleString("en-US");
  const where = res.writes.map((w) => show(repo, w.path)).join(", ");
  const rules = `${n} rule${res.ruleCount === 1 ? "" : "s"}`;
  if (!where) return `✓ ${rules} pulled · no instruction file to write them into — graft ask still carries them`;
  if (res.writes.every((w) => w.action === "unchanged")) return `✓ rules already current · ${n} in ${where}`;
  return `✓ ${rules} refreshed in ${where}`;
}

/** `a, b and c`. */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Trail's suggestions, cut to the files the wired agents read: how many, and
 * whose files they are (`the files claude and cursor read`).
 *
 * Every suggestion Trail has made, whatever became of it — the counts it sends
 * do not say which are still waiting for review and which were dismissed.
 */
export function suggestedFor(s: Suggestions | undefined, wired: string[]): { count: number; whose: string } {
  if (!s) return { count: 0, whose: "" };
  let count = 0;
  const kinds = new Set<string>();
  if (s.claudeMd > 0 && readByWired("claude_md", wired)) {
    count += s.claudeMd;
    kinds.add("claude_md");
  }
  if (s.files) {
    for (const f of s.files) {
      if (f.changes <= 0 || !readByWired(f.kind, wired)) continue;
      count += f.changes;
      kinds.add(f.kind);
    }
  } else if (s.contextFiles > 0) {
    // No per-file list from this Trail, so no way to cut it to the wired agents'
    // files: the count is Trail's total.
    count += s.contextFiles;
    for (const k of ["agents_md", "folder_claude_md", "cursor_rule", "skill"]) kinds.add(k);
  }
  const readers = wired.length
    ? wired.filter((w) => [...kinds].some((k) => readersOf(k, [w]).length > 0))
    : [];
  return { count, whose: readers.length ? `the files ${joinAnd(readers)} read` : "this repo's context files" };
}

/**
 * The suggestions line after a build:
 * `● 18 suggestions for the files claude, agents and cursor read`. Null when
 * there are none to mention.
 */
export function suggestionsLine(s: Suggestions | undefined, wired: string[], again: boolean): string | null {
  const { count, whose } = suggestedFor(s, wired);
  if (count === 0) return null;
  return `● ${count.toLocaleString("en-US")} ${again ? "new " : ""}suggestion${count === 1 ? "" : "s"} for ${whose}`;
}

/**
 * What a pull says about the suggestions it did not write:
 * `● 20 suggested so far for the files claude read, 2 of them accepted`.
 *
 * This is what lets an agent watching the trail say "there are suggestions
 * waiting for you" before anything has been accepted. "So far", because the
 * build keeps adding them after the push returns. Null when Trail sent no
 * counts, or counts that cannot hold what was accepted.
 */
export function suggestedLine(suggested: { count: number; whose: string }, accepted: number): string | null {
  if (suggested.count === 0 || suggested.count < accepted) return null;
  const taken = accepted === 0 ? "none accepted yet" : `${accepted.toLocaleString("en-US")} of them accepted`;
  return `● ${suggested.count.toLocaleString("en-US")} suggested so far for ${suggested.whose}, ${taken}`;
}

/** Everything the pull will write, file by file, with where each change came from. */
export interface Planned {
  plan: FilePlan;
  source: "claude-md" | "context-files";
  kind: string;
}

/** What Trail holds for this checkout right now, planned against the files on disk. */
export interface Gathered {
  /** Every file with an accepted change for the wired agents, planned. */
  planned: Planned[];
  /** Accepted changes Trail still lists for the wired agents' files, whatever
   *  the plan makes of them. */
  accepted: number;
  /** What Trail has suggested for those files, or null when the counts could
   *  not be read (a failed request, as opposed to a Trail that sends none). */
  suggested: { count: number; whose: string } | null;
  /** Each request that failed, in the order the pull reports them. `status` is
   *  the HTTP status when Trail answered, absent when it could not be reached —
   *  the difference between a revoked token and a blip. */
  errors: Array<{ message: string; status?: number }>;
}

/**
 * Read everything Trail has accepted for this repo and plan it against disk,
 * without writing a byte or telling Trail anything.
 *
 * The one read both `graft trail pull` and `graft trail watch` (and the
 * session-start hook's quick look) are built on, so a watcher that says "3
 * accepted changes are ready" is counting exactly what the pull will write. The
 * three requests go out together: the hook gives this three seconds, and three
 * in a row would spend them.
 *
 * `repoState` is for a caller that started the counts request earlier, as the
 * pull does, so it runs beside the rules refresh rather than after it.
 */
export async function gatherPull(
  repo: string,
  link: BrainLink,
  wired: string[],
  fetchImpl: typeof fetch = fetch,
  repoState: Promise<RepoState | null> = fetchRepoState(link, fetchImpl),
): Promise<Gathered> {
  const [md, ctx, state] = await Promise.all([fetchAcceptedChanges(link, fetchImpl), fetchContextFiles(link, fetchImpl), repoState]);
  const planned: Planned[] = [];
  const errors: Gathered["errors"] = [];
  let accepted = 0;

  // The root CLAUDE.md first, then every other context file: the order the
  // pull has always listed them in.
  if ("error" in md) {
    if (!md.unsupported) errors.push({ message: md.error, ...(md.status ? { status: md.status } : {}) });
  } else if (md.changes.length > 0) {
    const file: ContextFile = { kind: kindForPath(md.path || "CLAUDE.md"), path: md.path || "CLAUDE.md", changes: md.changes };
    if (readByWired(file.kind, wired)) {
      accepted += file.changes.length;
      planned.push({ plan: planContextFile(repo, file), source: "claude-md", kind: file.kind });
    }
  }

  if ("error" in ctx) {
    errors.push({ message: ctx.error, ...(ctx.status ? { status: ctx.status } : {}) });
  } else if (!("unsupported" in ctx)) {
    for (const file of ctx.files) {
      if (file.changes.length === 0 || !readByWired(file.kind, wired)) continue;
      accepted += file.changes.length;
      planned.push({ plan: planContextFile(repo, file), source: "context-files", kind: file.kind });
    }
  }

  return { planned, accepted, suggested: state ? suggestedFor(state.suggestions, wired) : null, errors };
}

/**
 * The `trail_pulled` event for one pull. Only the outcome, which kinds of file
 * were written, and bucketed counts leave the machine — see TELEMETRY.md.
 */
function trackPull(repo: string, home: string | undefined, outcome: TrailPullOutcome, planned: Planned[] = [], suggested = 0): void {
  const wrote = planned.filter((p) => p.plan.status && p.plan.written.length > 0);
  const kinds = [...new Set(wrote.map((p) => p.kind))]
    .filter((k) => (CONTEXT_FILE_KINDS as readonly string[]).includes(k))
    .sort()
    .join(",");
  track(
    "trail_pulled",
    {
      outcome,
      kinds,
      files_bucket: countBucket(wrote.length),
      changes_bucket: countBucket(wrote.reduce((n, p) => n + p.plan.written.length, 0)),
      skipped_bucket: countBucket(planned.reduce((n, p) => n + p.plan.skipped.length, 0)),
      suggested_bucket: countBucket(suggested),
    },
    { repo, home },
  );
}

/**
 * Run the pull. Returns the exit code; every line goes through `write`.
 */
export async function runTrailPull(repo: string, link: BrainLink, opts: PullOptions): Promise<number> {
  const write = opts.write ?? ((l: string) => console.error(l));
  const fetchImpl = opts.fetchImpl ?? fetch;
  let code = 0;
  // Read beside everything else: it only adds a line, and a Trail that cannot
  // answer it costs the pull nothing.
  const repoState = fetchRepoState(link, fetchImpl);

  // 1. The rules. Skipped on a dry run, which writes nothing at all.
  if (!opts.dryRun) {
    const res = await connectBrain(repo, link, {
      home: opts.home,
      ids: opts.wired.length > 0 ? opts.wired : undefined,
      fetchImpl,
    });
    const line = rulesLine(repo, res);
    if (line) write(line);
    if (res.warning) code = 1;
  }

  // 2. Accepted changes: the root CLAUDE.md, then every other context file.
  const { planned, accepted, suggested: counted, errors } = await gatherPull(repo, link, opts.wired, fetchImpl, repoState);
  for (const e of errors) {
    write(`✗ ${e.message}`);
    code = 1;
  }

  const suggested = counted ?? { count: 0, whose: "" };
  const waiting = suggestedLine(suggested, accepted);

  if (accepted === 0) {
    if (code === 0) {
      if (waiting) {
        write(waiting);
        write(`  review: ${reviewUrl(link.brainId)}`);
      } else {
        write("· nothing accepted in Trail yet — review:");
        write(`  ${reviewUrl(link.brainId)}`);
      }
    }
    trackPull(repo, opts.home, code === 0 ? "nothing_accepted" : "error", [], suggested.count);
    return code;
  }

  const writing = planned.filter((p) => p.plan.status);
  const changes = writing.reduce((n, p) => n + p.plan.written.length, 0);
  if (writing.length > 0) {
    write(`✓ ${opts.dryRun ? "would write" : "wrote"} ${changes} accepted change${changes === 1 ? "" : "s"}`);
    const width = Math.max(30, ...writing.map((p) => p.plan.path.length)) + 2;
    for (const { plan } of writing) {
      const summary = changeSummary(plan.written);
      write(`  ${plan.status} ${summary ? plan.path.padEnd(width) : plan.path}${summary}`.trimEnd());
    }
  } else if (planned.some((p) => p.plan.present.length > 0)) {
    write("✓ every accepted change is already in these files");
  }

  for (const { plan } of planned) {
    for (const s of plan.skipped) {
      const what = s.change.kind === "edit" || s.change.kind === "add" ? `${changeSummary([s.change])} in ${plan.path}` : plan.path;
      write(`⚠ skipped ${what} — ${s.why}; edit it in Trail, then pull again`);
      code = 1;
    }
  }

  if (waiting) {
    write(waiting);
    write(`  review: ${reviewUrl(link.brainId)}`);
  }

  if (opts.dryRun) {
    write("· dry run — nothing written, and Trail was not told");
    trackPull(repo, opts.home, "dry_run", planned, suggested.count);
    return code;
  }

  for (const { plan } of writing) {
    try {
      writePlannedFile(repo, plan);
    } catch (e) {
      write(`✗ could not write ${plan.path}: ${e instanceof Error ? e.message : e}`);
      // Nothing from a file that was not written is reported as applied.
      plan.written = [];
      plan.present = [];
      code = 1;
    }
  }

  // Written now or already there: either way Trail should stop listing it.
  const done = (source: Planned["source"]) =>
    planned.filter((p) => p.source === source).flatMap((p) => [...p.plan.written, ...p.plan.present].map((c) => c.id));
  const told = (await markApplied(link, done("claude-md"), fetchImpl)) && (await markContextFilesApplied(link, done("context-files"), fetchImpl));
  if (!told) write("⚠ could not tell Trail which changes were written; it may still list them");
  if (writing.length > 0) write("· review with git diff, then commit");
  const anyWritten = planned.some((p) => p.plan.status && p.plan.written.length > 0);
  const anyPresent = planned.some((p) => p.plan.present.length > 0);
  const anySkipped = planned.some((p) => p.plan.skipped.length > 0);
  const outcome: TrailPullOutcome = anyWritten
    ? "written"
    : anyPresent
      ? "already_present"
      : anySkipped
        ? "skipped"
        : "error";
  trackPull(repo, opts.home, outcome, planned, suggested.count);
  return code;
}
