/**
 * Watching a brain being built, from the terminal.
 *
 * `graft trail push` used to end at "it is being mined into rules now — a few
 * minutes. Watch it finish in your browser." and hand the prompt straight back.
 * That sentence is the last thing this process ever says about the work, and it
 * is said BEFORE the part that actually fails: of the repo brains attempted in
 * production, roughly a third die inside the miner, after the push succeeded.
 * The terminal has already returned by then, so on this side the failure does
 * not exist at all — and on a CI runner or over SSH, where nobody is going to
 * open a browser, it exists nowhere.
 *
 * So the push now holds the line and reports the same four stages the browser
 * shows, off the same row. Ctrl-C detaches without cancelling anything, because
 * the work is server-side and killing a watcher must never look like killing
 * the build.
 *
 * What it holds the line UNTIL changed with slicing. The history is now mined in
 * several calls rather than one, and the first of them returns in about ten
 * seconds; filing all of the rules into the graph takes minutes more. Mining is
 * where the failures are — the thing this watcher exists to report — and filing
 * is long, dull and reliable, so the line is held through the first and handed
 * back before the second. Holding a terminal through five minutes of successful
 * filing buys nobody anything, and on a CI runner it is five minutes of a job
 * sitting idle.
 */
import type { BrainLink } from "./link.js";
import { baseUrlFor } from "./link.js";

/** The stages, in the order they happen. The wording matches Trail's build
 *  screen deliberately: two products describing one process differently is how
 *  a person ends up unsure whether they are looking at the same thing. */
export const STAGES = [
  { id: "reach", label: "reaching the repository" },
  { id: "read", label: "reading its history" },
  { id: "mine", label: "mining the rules" },
  { id: "file", label: "filing them into the brain" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];
export type StageState = "waiting" | "doing" | "done" | "failed";

export interface Stage {
  id: StageId;
  label: string;
  state: StageState;
  /** A count worth printing beside a stage that has produced one. */
  detail?: string;
}

/** The repo row, as the public endpoint returns it. Only the fields the stages
 *  read, so a field added server-side cannot quietly change what is printed. */
export interface RepoState {
  status: string;
  errorMessage?: string;
  ruleCount: number;
  commitCount: number;
  threadCount: number;
  /** Rules in the graph right now, from the job still running. The row's own
   *  `ruleCount` is only written when that job finishes, so mid-build it is
   *  zero however many rules are already there.
   *
   *  Optional because an older Trail does not send it, and a graft pointed at
   *  one must fall back to waiting for the finished row rather than reading a
   *  missing field as "no rules". */
  filedSoFar?: number;
  /** Rules the miner has handed over so far. Grows with every slice of the
   *  history that comes back, so it is a floor and never a total. */
  foundSoFar?: number;
  /** Suggested changes to the repo's context files, when Trail sends them. */
  suggestions?: Suggestions;
}

/**
 * The suggestions Trail has for this repository's context files so far.
 *
 * Counts, because that is all the terminal prints; the changes themselves are
 * reviewed in Trail and written by `graft trail pull`.
 */
export interface Suggestions {
  /** Changes suggested for the root CLAUDE.md. */
  claudeMd: number;
  /** Changes suggested for every other context file, all kinds together. */
  contextFiles: number;
  /** Per file, when Trail lists them — which is what lets the count be cut to
   *  the files the wired agents actually read. */
  files?: Array<{ kind: string; path: string; changes: number }>;
}

export interface BuildView {
  stages: Stage[];
  /**
   * True once rules are in the graph — which is when this watcher has nothing
   * left to report, not when the job ends. The rest of the slices keep mining
   * and filing after the prompt comes back.
   */
  ready: boolean;
  done: boolean;
  /** The server's own words, when it failed. */
  error: string | null;
}

const num = (v: unknown): number => (typeof v === "number" && v > 0 ? v : 0);

/**
 * Which stage the work is in.
 *
 * The rule that matters is where a failure lands. A row that never left
 * `pending` failed at the access check; one that read 412 commits and then died
 * failed in the miner. Reporting both as "could not reach it" would send someone
 * to fix repository access for a problem that has nothing to do with it.
 */
export function stagesFrom(repo: RepoState | null): BuildView {
  const commits = num(repo?.commitCount);
  const threads = num(repo?.threadCount);
  const rules = num(repo?.ruleCount);

  const filedSoFar = num(repo?.filedSoFar);
  const foundSoFar = num(repo?.foundSoFar);

  const reached = !!repo && repo.status !== "pending";
  const readIt = commits > 0 || threads > 0;
  // Rules that exist, whether the job has finished writing its count or not.
  const hasRules = filedSoFar > 0 || rules > 0;
  const filed = rules > 0;
  const failed = repo?.status === "failed";

  const failedAt: StageId | null = !failed ? null : !reached || !readIt ? "reach" : !hasRules ? "mine" : "file";

  const order = STAGES.map((s) => s.id);
  const state = (id: StageId): StageState => {
    if (failedAt === id) return "failed";
    if (failedAt && order.indexOf(id) > order.indexOf(failedAt)) return "waiting";
    switch (id) {
      case "reach":
        return reached ? "done" : "doing";
      case "read":
        return readIt ? "done" : reached ? "doing" : "waiting";
      case "mine":
        // Done on the first slice's rules. The remaining slices are still being
        // mined at this point, behind the prompt this watcher is about to
        // return — which is the whole change.
        return hasRules ? "done" : readIt ? "doing" : "waiting";
      case "file":
        return filed ? "done" : hasRules ? "doing" : readIt ? "waiting" : "waiting";
    }
  };

  const detail = (id: StageId): string | undefined => {
    if (id === "read" && (commits || threads)) {
      return [commits ? `${commits} commits` : null, threads ? `${threads} discussions` : null].filter(Boolean).join(", ");
    }
    // "so far" because the count grows with each slice that lands. Printing it
    // as a total would promise history that has not been read yet.
    if (id === "mine" && foundSoFar) return `${foundSoFar} rules so far`;
    if (id === "file" && rules) return `${rules} rules`;
    if (id === "file" && filedSoFar) return `${filedSoFar} rules so far`;
    return undefined;
  };

  return {
    stages: STAGES.map((s) => ({ id: s.id, label: s.label, state: state(s.id), detail: detail(s.id) })),
    ready: hasRules && !failed,
    done: repo?.status === "completed" && filed,
    error: failed ? (repo?.errorMessage?.trim() || "the read stopped before it finished") : null,
  };
}

/** A count from a field Trail may send as a number or as the list itself. */
const countOf = (v: unknown): number => (Array.isArray(v) ? v.length : num(v));

/** The fields of an expected-repo body the watcher reads, as Trail sends them. */
interface RepoBody {
  repo?: { status?: string; error_message?: string; rule_count?: number; commit_count?: number; thread_count?: number } | null;
  // Absent on an older API, which is why every read of it defaults to zero:
  // a graft that cannot see the in-flight counts falls back to waiting for
  // the finished row, exactly as it did before.
  build?: { found_so_far?: number; filed_so_far?: number } | null;
  claude_md?: { status?: string; quick_ready?: boolean; full_ready?: boolean; changes?: unknown } | null;
  // An object on every SSE frame. On the polled GET it is the `true` that says
  // the routes exist, and the counts ride in `context_files_progress` instead.
  context_files?: { files?: unknown; changes?: unknown } | boolean | null;
  context_files_progress?: { files?: unknown; changes?: unknown } | null;
}

/**
 * The repo state out of an expected-repo body — the polled GET and every SSE
 * `progress` event carry the same shape. Null when there is no repo row.
 */
export function parseRepoBody(body: unknown): RepoState | null {
  const b = (body ?? {}) as RepoBody;
  if (!b.repo || typeof b.repo !== "object") return null;
  const state: RepoState = {
    status: String(b.repo.status ?? ""),
    errorMessage: b.repo.error_message,
    ruleCount: num(b.repo.rule_count),
    commitCount: num(b.repo.commit_count),
    threadCount: num(b.repo.thread_count),
    filedSoFar: num(b.build?.filed_so_far),
    foundSoFar: num(b.build?.found_so_far),
  };
  const cf = b.context_files && typeof b.context_files === "object" ? b.context_files : b.context_files_progress;
  if (b.claude_md || cf) {
    const files = Array.isArray(cf?.files)
      ? (cf!.files as Array<{ kind?: unknown; path?: unknown; changes?: unknown }>)
          .filter((f) => f && typeof f === "object")
          .map((f) => ({ kind: String(f.kind ?? ""), path: String(f.path ?? ""), changes: countOf(f.changes) }))
      : undefined;
    state.suggestions = {
      claudeMd: countOf(b.claude_md?.changes),
      contextFiles: cf?.changes !== undefined ? countOf(cf.changes) : (files ?? []).reduce((n, f) => n + f.changes, 0),
      ...(files ? { files } : {}),
    };
  }
  return state;
}

/**
 * Read the repo row this brain is building.
 *
 * The same endpoint `fetchExpectedRepo` uses, read for its counts rather than
 * its slug. Null on any failure, so a watcher that cannot reach the API prints
 * nothing new rather than inventing a failure the build did not have.
 */
export async function fetchRepoState(link: BrainLink, fetchImpl: typeof fetch = fetch): Promise<RepoState | null> {
  try {
    const res = await fetchImpl(`${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/repo`, {
      headers: { authorization: `Bearer ${link.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return parseRepoBody(await res.json());
  } catch {
    return null;
  }
}

/** Past tense, for the no-TTY log: each line reports a stage that finished. */
const DONE_LABEL: Record<StageId, string> = {
  reach: "reached the repository",
  read: "read its history",
  mine: "mined the rules",
  file: "filed them into the trail",
};

/** What the spinner says while a stage is running. */
export const DOING_LABEL: Record<StageId, string> = {
  reach: "reaching the repository",
  read: "reading its history",
  mine: "mining rules",
  file: "filing the rules",
};

/** The first rules there are, from whichever count the row has. */
export function rulesSoFar(repo: RepoState | null): number {
  return Math.max(num(repo?.ruleCount), num(repo?.filedSoFar), num(repo?.foundSoFar));
}

/**
 * One printable line per stage that has finished since it was last printed.
 *
 * Only for a log with no terminal to redraw — on a TTY the spinner says which
 * stage is running and these lines are never printed. Filing is left out: the
 * watcher hands the prompt back on the first rules, before filing finishes, and
 * the closing line says how many there are.
 */
export function linesFor(view: BuildView, already: Set<string>, repo: RepoState | null = null): string[] {
  const out: string[] = [];
  for (const s of view.stages) {
    if (s.state !== "done" || s.id === "file") continue;
    const key = `${s.id}:${s.state}`;
    if (already.has(key)) continue;
    already.add(key);
    const rules = rulesSoFar(repo);
    const label =
      s.id === "mine" && rules > 0
        ? `mined the first ${rules.toLocaleString("en-US")} rule${rules === 1 ? "" : "s"}`
        : DONE_LABEL[s.id];
    out.push(`  ✓ ${label}`);
  }
  return out;
}

/** The stage the build is in now, for the spinner. */
export function currentStage(view: BuildView): StageId {
  return (view.stages.find((s) => s.state === "doing" || s.state === "failed") ?? view.stages[view.stages.length - 1]!).id;
}

/** The failure line: where it stopped, and that nothing was lost. The server's
 * own words follow on the next line, in full. */
export function failureLines(view: BuildView): string[] {
  const at = view.stages.find((s) => s.state === "failed")?.id ?? "mine";
  const lines = [`✗ the build stopped while ${DOING_LABEL[at]} · nothing was lost — run graft trail push again`];
  if (view.error) lines.push(`  ${view.error}`);
  return lines;
}

export interface WatchOptions {
  /** How long to hold before giving up on a build that is still running. */
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  /** Where the lines go. Injected so the tests do not need a console. */
  write?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Print a line per finished stage. Off on a TTY, where a spinner says it. */
  stageLines?: boolean;
  /** Every state read, with its view — the spinner's feed. */
  onState?: (view: BuildView, repo: RepoState) => void;
  /** Follow `GET /events` instead of polling (the server advertised `events`). */
  events?: boolean;
  /** Silence on the stream for this long counts as a drop. Keep-alives come every 15 s. */
  idleMs?: number;
  /** Stream reconnects before falling back to polling. */
  maxReconnects?: number;
}

/**
 * How the watch ended.
 *
 * `building` is the ordinary success: rules are in the brain and the rest of the
 * history is still being read behind the prompt. `completed` is the same thing
 * after the whole job has finished, which only happens for a repository small
 * enough to be mined in one slice.
 */
export type WatchOutcome = "completed" | "building" | "failed" | "timed_out" | "unreachable";

/**
 * Hold until the brain has rules, reporting each stage as it settles.
 *
 * Returns on the first rules rather than on the finished job: mining is what
 * fails and it is done by then, and filing the rest is minutes of work nobody
 * needs to watch. The caller prints where to see the rest.
 *
 * Live when the server streams events: each change arrives as it happens
 * instead of up to four seconds late. A stream that drops is reopened up to
 * three times, and after that the watcher polls as it always did — so the
 * worst a broken stream costs is the old behaviour.
 *
 * Fifteen minutes by default. That is far more than the mining now takes, and it
 * stays generous on purpose: a watcher that gives up before the build does would
 * report a healthy build as a timeout, which is the exact confusion this is
 * meant to remove. Giving up says so and says the work continues, because it
 * does.
 */
export async function watchBuild(link: BrainLink, opts: WatchOptions = {}): Promise<WatchOutcome> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const pollMs = opts.pollMs ?? 4000;
  const write = opts.write ?? ((l: string) => console.error(l));
  // Not unref'd: between polls this timer is the only thing the process is
  // waiting on, and an unref'd one let it exit mid-watch with nothing printed.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stageLines = opts.stageLines !== false;

  const printed = new Set<string>();
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  // A row we could never read at all, as opposed to one that answered once and
  // then stopped answering: the first is a broken link or a host that is down
  // and is worth saying, the second is a blip the next poll usually covers.
  let everRead = false;

  /** One state read → the outcome it settles, or null to keep watching. */
  const settle = (repo: RepoState | null): WatchOutcome | null => {
    if (!repo) return null;
    everRead = true;
    const view = stagesFrom(repo);
    opts.onState?.(view, repo);
    if (stageLines) for (const line of linesFor(view, printed, repo)) write(line);
    if (view.error) {
      for (const line of failureLines(view)) write(line);
      return "failed";
    }
    if (view.done) return "completed";
    // The ordinary ending now. The job is still filing the rules the miner
    // has handed over, and still mining the older slices of the history, and
    // neither is worth a terminal sitting on it.
    if (view.ready) return "building";
    return null;
  };

  if (opts.events) {
    let drops = 0;
    const maxReconnects = opts.maxReconnects ?? 3;
    while (drops <= maxReconnects && Date.now() < deadline) {
      const r = await streamOnce(link, fetchImpl, settle, deadline, opts.idleMs ?? 45_000);
      if (r.outcome) return r.outcome;
      if (r.end === "unsupported" || r.end === "deadline") break;
      if (r.end === "done") {
        // The build ended without the event saying how: read the row once.
        const final = settle(await fetchRepoState(link, fetchImpl));
        if (final) return final;
        break;
      }
      drops++;
      if (drops <= maxReconnects) await sleep(Math.min(1000 * drops, 4000));
    }
  }

  for (;;) {
    const outcome = settle(await fetchRepoState(link, fetchImpl));
    if (outcome) return outcome;
    if (Date.now() >= deadline) return everRead ? "timed_out" : "unreachable";
    await sleep(pollMs);
  }
}

/** One server-sent event. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * An incremental text/event-stream parser: feed it chunks as they arrive,
 * get back the events they completed. Comments (`: ping`) are dropped; a
 * missing `event:` field means `message`, per the spec.
 */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const nl = this.buf.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      const sep = this.buf.startsWith("\r\n", nl) ? 2 : 1;
      // A lone \r at the very end may be the first half of \r\n: wait for more.
      if (this.buf[nl] === "\r" && sep === 1 && nl === this.buf.length - 1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + sep);
      if (line === "") {
        if (this.data.length > 0) out.push({ event: this.event || "message", data: this.data.join("\n") });
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
      // id and retry are not used: a reconnect starts from a fresh `progress`.
    }
    return out;
  }
}

type StreamEnd = "done" | "dropped" | "unsupported" | "deadline";

/**
 * One connection to `GET /events`. Resolves with the outcome when an event
 * settled the watch, or with how the stream ended when none did.
 */
async function streamOnce(
  link: BrainLink,
  fetchImpl: typeof fetch,
  settle: (repo: RepoState | null) => WatchOutcome | null,
  deadline: number,
  idleMs: number,
): Promise<{ outcome?: WatchOutcome; end?: StreamEnd }> {
  const ctl = new AbortController();
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/events`, {
      headers: { authorization: `Bearer ${link.token}`, accept: "text/event-stream", "cache-control": "no-cache" },
      signal: ctl.signal,
    });
  } catch {
    return { end: "dropped" };
  }
  // A server without the route, or one that answered with something other
  // than a stream: polling is the answer, not three more tries.
  if (res.status === 404 || res.status === 405 || res.status === 501) return { end: "unsupported" };
  if (!res.ok) return { end: "dropped" };
  const type = res.headers?.get?.("content-type") ?? "text/event-stream";
  if (!res.body || !/event-stream/i.test(type)) return { end: "unsupported" };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return { end: "deadline" };
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<"idle">((r) => {
        // Not unref'd: while the stream is quiet this timer is what the
        // process is waiting on, and it is cleared the moment a chunk lands.
        timer = setTimeout(() => r("idle"), Math.min(idleMs, left));
      });
      const got = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
      if (got === "idle") return { end: Date.now() >= deadline ? "deadline" : "dropped" };
      if (got.done) return { end: "dropped" };
      for (const ev of parser.push(decoder.decode(got.value, { stream: true }))) {
        let payload: unknown = null;
        try {
          payload = ev.data ? JSON.parse(ev.data) : null;
        } catch {
          payload = null;
        }
        if (ev.event === "progress" || ev.event === "message") {
          const outcome = settle(parseRepoBody(payload));
          if (outcome) return { outcome };
        } else if (ev.event === "done") {
          const outcome = settle(parseRepoBody(payload));
          if (outcome) return { outcome };
          return { end: "done" };
        }
      }
    }
  } catch {
    return { end: "dropped" };
  } finally {
    ctl.abort();
    try {
      reader.releaseLock();
    } catch {
      /* already released by the abort */
    }
  }
}
