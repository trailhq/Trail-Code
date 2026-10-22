/**
 * How much slower this machine is than the one the timing bars were set on,
 * for tests that hold a parse or a hook to a few milliseconds. A shared CI
 * runner can be two or three times slower than a laptop; a regex that
 * backtracks is a thousand times slower. So a bar scaled by this factor still
 * catches the second and no longer fails on the first.
 *
 * The factor is a fixed CPU workload (regex scans and JSON over a few hundred
 * KB, the shape of work the timed code does) timed in this process, best of
 * several runs, against what it took where the bars were set. It is never
 * below 1, capped at 10, and exactly 1 under TRAIL_PERF=1 (the strict run).
 * Not a test file itself.
 */

/** The workload's CPU ms where the bars were set: an Apple M-series laptop on Node 25 (Node 20 there takes about 7). */
const REFERENCE_MS = 5;

let cached: number | null = null;

function cpuMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

function workload(): number {
  const text = "token=abc def-ghi /var/x?key=1 ".repeat(8 * 1024);
  let n = 0;
  for (let i = 0; i < 4; i++) {
    n += (text.match(/[a-z]+=[\w-]+/g) ?? []).length;
    n += JSON.parse(JSON.stringify({ text, n })).text.length;
  }
  return n;
}

/** The workload's best CPU ms here, after a warm-up run. */
export function workloadMs(): number {
  workload();
  let best = Infinity;
  for (let k = 0; k < 7; k++) {
    const t = cpuMs();
    workload();
    best = Math.min(best, cpuMs() - t);
  }
  return best;
}

/** This machine's slowness against the bars' machine: 1 to 10. */
export function slowness(): number {
  if (process.env.TRAIL_PERF === "1") return 1;
  cached ??= Math.min(10, Math.max(1, workloadMs() / REFERENCE_MS));
  return cached;
}
