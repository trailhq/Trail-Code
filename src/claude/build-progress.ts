/**
 * `graft build`, run from `graft init` as one line that redraws in place.
 *
 * `buildGraphIfMissing` hands the child the terminal, which prints a `parsing
 * N/M: path` line and four more after it. That is the right output for someone
 * who ran `graft build`, and five lines of someone else's output in the middle
 * of init. Here the child's output is read instead: its progress becomes the
 * spinner's `1,204 of 1,942 files`, its totals become init's one summary line,
 * and any warning or error it printed is passed on whole.
 */
import { spawn } from "node:child_process";
import { hasGraftIndex } from "../graph/root.js";
import { startSpinner } from "../util/spinner.js";

export interface BuiltGraph {
  nodes: number;
  edges: number;
  files: number;
}

const n = (s: string | undefined) => Number((s ?? "0").replace(/,/g, "")) || 0;

/** The totals out of `graft build`'s stdout, or null when it printed none. */
export function parseBuildSummary(stdout: string): BuiltGraph | null {
  const wiring = /✓ wiring: ([\d,]+) nodes.*?, ([\d,]+) edges/.exec(stdout);
  if (!wiring) return null;
  const parsed = /parsed: [\d,]+ of ([\d,]+) files/.exec(stdout);
  return { nodes: n(wiring[1]), edges: n(wiring[2]), files: n(parsed?.[1]) };
}

/** The last `parsing N/M` in a chunk of the child's stderr. */
export function parseProgress(chunk: string): { index: number; total: number } | null {
  let last: { index: number; total: number } | null = null;
  for (const m of chunk.matchAll(/(?:parsing|summarizing) (\d+)\/(\d+)/g)) last = { index: n(m[1]), total: n(m[2]) };
  return last;
}

/**
 * Build the graph for `dir` unless it has one, showing progress on a spinner.
 *
 * `built: false` with no `failed` means there was nothing to do (`--no-build`,
 * or a graph already there). Warning and error lines the build printed come
 * back in `messages`, for the caller to print in full.
 */
export async function buildGraphWithProgress(
  dir: string,
  opts: { build?: boolean; cliPath?: string },
): Promise<{ built: boolean; graph?: BuiltGraph; failed?: boolean; messages: string[] }> {
  if (opts.build === false || !opts.cliPath || hasGraftIndex(dir)) return { built: false, messages: [] };
  const spinner = startSpinner("building the graph");
  let stdout = "";
  let stderr = "";
  const fmt = (x: number) => x.toLocaleString("en-US");
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, opts.cliPath!, "build", "."], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill(), 300_000);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => {
      stderr += d;
      const p = parseProgress(d);
      if (p) spinner.update(`building the graph · ${fmt(p.index)} of ${fmt(p.total)} files`);
    });
    child.on("error", () => resolve(null));
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  spinner.stop();
  const messages = `${stdout}\n${stderr.replace(/\r[^\n]*/g, "\n")}`
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => /^\s*[⚠✗]/.test(l));
  const graph = parseBuildSummary(stdout) ?? undefined;
  if (code !== 0) return { built: false, failed: true, messages };
  return { built: true, graph, messages };
}
