/**
 * Offline, deterministic test doubles so the pipeline runs with no keys, no
 * Ollama, and no network — the same "bring your own components" seam the engine
 * exposes via EngineConfig.summarizer / .synthesizer.
 *
 * Also the shared scratch-dir and child-process helpers. Those live here rather
 * than being hand-rolled per file because both carry a platform trap that is
 * invisible until CI runs on Windows: see {@link tmpRepo} and {@link homeEnv}.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Summarizer, Synthesizer, SynthNode, SynthLink, FileSummary } from "../src/index.js";

/**
 * A fresh scratch directory, canonicalized.
 *
 * The canonicalization is the point. On Windows `tmpdir()` hands back the 8.3 short
 * form (`C:\Users\RUNNER~1\AppData\Local\Temp`), while anything that resolves the
 * path for itself — a child process, `git` writing a worktree's `.git` pointer —
 * reports the long form (`C:\Users\runneradmin\…`). Compare the two and an
 * assertion fails on a difference that isn't real. On macOS the same call unwraps
 * `/var` → `/private/var`, which is why it's worth doing everywhere.
 *
 * `.native` specifically: plain `realpathSync` is JS-level and resolves symlinks
 * without expanding a Windows short name, so it does *not* fix the case above.
 * `.native` goes through the OS (`GetFinalPathNameByHandle`) and does.
 */
export function tmpRepo(tag: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `graft-${tag}-`)));
}

/**
 * Child-process env that points `os.homedir()` at a scratch directory, so a test
 * can never touch the real `~/.codex`.
 *
 * Both variables, because `homedir()` reads a different one per platform: `HOME`
 * on posix, `USERPROFILE` on Windows. Setting only `HOME` leaves a Windows child
 * pointed at the real profile — the test then exercises whatever agents happen to
 * be installed on the runner instead of the fixture it built.
 */
export function homeEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

/**
 * Why a test can't inject a failure by removing permission — or null when it can.
 *
 * On Windows the mode bits map onto the read-only *attribute*: it does block writes
 * to a file (so `chmod 0o400` to fail a write still works there), but nothing blocks
 * reads, and a mode set on a *directory* is ignored outright. Node exposes no
 * portable way to deny access, so a test that depends on denial says so by name
 * rather than passing vacuously. Root has the same problem for the same reason,
 * which is why both live behind one call.
 */
export function chmodDenialUnavailable(): string | null {
  if (process.platform === "win32") {
    return "chmod does not deny access on Windows — the mode maps onto the read-only attribute";
  }
  if (process.getuid?.() === 0) return "running as root, which reads and writes regardless of mode";
  return null;
}

export interface CliRun extends SpawnSyncReturns<string> {
  /** status/signal/stdout/stderr in one string, for assertion messages. */
  describe(): string;
}

/**
 * Run the real CLI through tsx and return the full result — stdout, stderr, exit
 * status — rather than throwing on failure.
 *
 * `execFileSync` throws and buries stderr in the exception, which is how four
 * `init` tests came to fail on Windows with nothing to go on but "did not match".
 * The `timeout` matters just as much: a child that blocks on stdin used to burn
 * the runner's patience silently, so it fails fast and says so instead.
 */
export function runCli(args: string[], opts: { home?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): CliRun {
  const res = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    env: opts.env ?? (opts.home ? homeEnv(opts.home) : process.env),
  }) as CliRun;
  res.describe = () =>
    [
      `graft ${args.join(" ")}`,
      `  status: ${res.status}${res.signal ? ` (signal ${res.signal})` : ""}`,
      `  stdout: ${JSON.stringify(res.stdout ?? "")}`,
      `  stderr: ${JSON.stringify(res.stderr ?? "")}`,
    ].join("\n");
  return res;
}

/** Summarizer that passes the source through unchanged, so tests control the text. */
export class PassthroughSummarizer implements Summarizer {
  async summarize(code: string): Promise<string> {
    return code;
  }
}

/**
 * Synthesizer driven by simple markup so tests fully control the graph shape:
 *   - `[[Node Name]]` → a node grounded in the file it appears in
 *   - `[[A]] ==relation==> [[B]]` → an edge A→B
 * Nodes are merged by name across the provided files (union of source files).
 */
export class BracketSynthesizer implements Synthesizer {
  async synthesize(files: FileSummary[]): Promise<SynthNode[]> {
    const byName = new Map<string, { sources: Set<string>; links: Map<string, SynthLink> }>();
    const ensure = (name: string) => {
      let e = byName.get(name);
      if (!e) {
        e = { sources: new Set(), links: new Map() };
        byName.set(name, e);
      }
      return e;
    };
    for (const f of files) {
      for (const m of f.summary.matchAll(/\[\[([^\]]+)\]\]/g)) {
        ensure(m[1].trim()).sources.add(f.path);
      }
      for (const m of f.summary.matchAll(/\[\[([^\]]+)\]\]\s*==([a-z_]+)==>\s*\[\[([^\]]+)\]\]/g)) {
        const [, from, relation, to] = m;
        ensure(to.trim()).sources.add(f.path);
        ensure(from.trim()).links.set(`${to}|${relation}`, { to: to.trim(), relation });
      }
    }
    return [...byName].map(([name, e]) => ({
      name,
      type: "concept",
      summary: `${name} summary`,
      sources: [...e.sources],
      links: [...e.links.values()],
    }));
  }
}

export function fakeProviders() {
  return { summarizer: new PassthroughSummarizer(), synthesizer: new BracketSynthesizer() };
}
