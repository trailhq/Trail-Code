/**
 * PROTOTYPE, for discussion (trail-code ⇄ trail-opencore, todo #12).
 *
 * A learning in `.trail/learnings/` becomes one piece of evidence in a
 * trail-opencore memory service, and opencore's recall finds learnings for a
 * prompt or a diff by meaning, not only by shared words.
 *
 * Off unless TRAIL_OPENCORE_URL and TRAIL_OPENCORE_TOKEN are set. Nothing
 * here runs on the offline path: `trail check`, `trail ask` and the hooks are
 * unchanged. Only repo learnings are sent (the same set the workspace sync
 * already uploads); personal learnings in ~/.trail never are.
 *
 * Mapping:
 * - `source_id` is `trail-code:<repo key>:<path>`, so a retry is reused, not duplicated.
 * - `kind` is `document`; one item per `## ` section, speaker = author, occurred_at = date.
 * - `grants` is one principal for the repo (`repo:<key>`): whoever can read the repo's
 *   `.trail/` can read its evidence. The token must carry that principal.
 * - Learnings are never edited after they're written, so revision 1 is enough here; an
 *   edited file comes back as a conflict, reported rather than overwritten.
 */
import type { UploadedLearning } from "./workspace.js";

export interface Opencore {
  url: string;
  token: string;
}

type Fetch = typeof fetch;

/** The opencore service to use, or null when none is configured. */
export function opencoreTarget(env: NodeJS.ProcessEnv = process.env): Opencore | null {
  const url = env.TRAIL_OPENCORE_URL?.trim();
  const token = env.TRAIL_OPENCORE_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

const SOURCE_PREFIX = "trail-code:";

export function learningSourceId(repoKey: string, path: string): string {
  return `${SOURCE_PREFIX}${repoKey}:${path}`;
}

/** The path back out of a source id, or null for evidence that isn't a trail-code learning. */
export function learningPath(sourceId: string): { repo: string; path: string } | null {
  if (!sourceId.startsWith(SOURCE_PREFIX)) return null;
  const rest = sourceId.slice(SOURCE_PREFIX.length);
  const at = rest.indexOf(":.trail/");
  return at < 0 ? null : { repo: rest.slice(0, at), path: rest.slice(at + 1) };
}

/**
 * The principal a repo's learnings are granted to. The agents platform's
 * opencore service only accepts `[A-Za-z0-9:_-]`, so `/` and `.` become `_`.
 */
export function repoPrincipal(repoKey: string): string {
  return `repo:${repoKey.replace(/[^A-Za-z0-9:_-]/g, "_")}`;
}

export interface EvidenceItem {
  id: string;
  text: string;
  speaker: string;
  occurred_at?: string;
  sequence: number;
}

export interface Evidence {
  source_id: string;
  revision: number;
  kind: "document";
  grants: string[];
  items: EvidenceItem[];
}

/** A learning's sections: `[heading, text]`, with whatever comes before the first heading as "Summary". */
function sections(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let heading = "Summary";
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) out.push([heading, text]);
  };
  for (const line of body.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[1]!;
      lines = [];
    } else lines.push(line);
  }
  flush();
  return out;
}

function slugOf(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
}

/** One learning as opencore evidence. Each item starts with the title, so a recalled section reads on its own. */
export function learningEvidence(repoKey: string, l: UploadedLearning): Evidence {
  const parts = sections(l.body);
  const occurred = /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? `${l.date}T00:00:00Z` : undefined;
  const touches = l.touches.length ? `\nTouches: ${l.touches.join(", ")}` : "";
  const items = (parts.length ? parts : [["Summary", l.title] as [string, string]]).map(([heading, text], i) => ({
    id: `${i}-${slugOf(heading)}`,
    text: `${l.title}\n${heading}: ${text}${i === 0 ? touches : ""}`,
    speaker: l.author || "unknown",
    ...(occurred ? { occurred_at: occurred } : {}),
    sequence: i,
  }));
  return { source_id: learningSourceId(repoKey, l.path), revision: 1, kind: "document", grants: [repoPrincipal(repoKey)], items };
}

async function call<T>(o: Opencore, method: string, path: string, body?: unknown, fetchImpl: Fetch = fetch): Promise<{ status: number; data: T }> {
  const r = await fetchImpl(`${o.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${o.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, data: data as T };
}

export interface RetainResult {
  retained: number;
  reused: number;
  conflicts: string[];
  failed: Array<{ path: string; status: number; detail: string }>;
  jobs: string[];
}

/** Retain every learning as evidence. Never throws for one learning: its failure is reported. */
export async function retainLearnings(o: Opencore, repoKey: string, learnings: UploadedLearning[], fetchImpl?: Fetch): Promise<RetainResult> {
  const out: RetainResult = { retained: 0, reused: 0, conflicts: [], failed: [], jobs: [] };
  for (const l of learnings) {
    const r = await call<{ job_id?: string; reused?: boolean; detail?: string }>(o, "POST", "/retain", learningEvidence(repoKey, l), fetchImpl);
    if (r.status === 202 || r.status === 200) {
      if (r.data.reused) out.reused++;
      else out.retained++;
      if (r.data.job_id) out.jobs.push(r.data.job_id);
    } else if (r.status === 409) out.conflicts.push(l.path);
    else out.failed.push({ path: l.path, status: r.status, detail: typeof r.data === "string" ? r.data : JSON.stringify(r.data) });
  }
  return out;
}

/** Wait until opencore has indexed the retained evidence, so recall can see it. */
export async function waitForJobs(o: Opencore, jobs: string[], timeoutMs = 120_000, fetchImpl?: Fetch): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (const job of jobs) {
    for (;;) {
      const r = await call<{ stage?: string; status?: string }>(o, "GET", `/operations/${job}`, undefined, fetchImpl);
      // Indexing ends at `source_ready` (stage `extract`): text is searchable; derive is a separate step.
      if (r.status === 200 && (r.data.status === "source_ready" || r.data.stage === "done")) break;
      if (r.status === 200 && r.data.status === "failed") return false;
      if (Date.now() > until) return false;
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  return true;
}

export interface RecalledLearning {
  path: string;
  repo: string;
  title: string;
  author: string;
  date: string;
  /** The recalled section, as stored. */
  quote: string;
  /** opencore's relevance score: cosine similarity without rerank, a cross-encoder logit with it. */
  score: number | null;
}

interface RecallBlock {
  id: string;
  kind: string;
  sources: Array<{ evidence_id: string; speaker: string; occurred_at: string; quote: string }>;
}

interface RecallResponse {
  status: string;
  blocks: RecallBlock[];
  candidates: Array<{ id: string; relevance_score: number | null }>;
}

/**
 * Learnings for a query, best first, one entry per learning. opencore's blocks
 * name their evidence by id only, so each id is looked up once in /history to
 * get its source id (and so the learning's path).
 */
export async function recallLearnings(o: Opencore, query: string, opts: { limit?: number; tokenBudget?: number; rerank?: boolean } = {}, fetchImpl?: Fetch): Promise<{ status: string; hits: RecalledLearning[] }> {
  const r = await call<RecallResponse>(
    o,
    "POST",
    "/recall",
    {
      query,
      token_budget: opts.tokenBudget ?? 2000,
      max_context_blocks: Math.max(1, (opts.limit ?? 3) * 2),
      // No paid model on this path: the same switches the agents platform uses.
      answerability: false,
      verify_answer: false,
      // The local cross-encoder is ~50 ms a query and returned NaN on macOS arm64 (torch 2.14),
      // which opencore can't serialize; cosine similarity is enough for a few hundred learnings.
      rerank: opts.rerank ?? false,
    },
    fetchImpl,
  );
  if (r.status !== 200) return { status: `http_${r.status}`, hits: [] };
  const scores = new Map(r.data.candidates.map((c) => [c.id, c.relevance_score]));
  const sourceIds = new Map<string, string | null>();
  const hits: RecalledLearning[] = [];
  const seen = new Set<string>();
  for (const b of r.data.blocks) {
    const s = b.sources[0];
    if (!s) continue;
    if (!sourceIds.has(s.evidence_id)) {
      const h = await call<Array<{ kind: string; text: string }>>(o, "GET", `/history/${s.evidence_id}`, undefined, fetchImpl);
      const node = h.status === 200 && Array.isArray(h.data) ? h.data.find((n) => n.kind === "evidence") : undefined;
      sourceIds.set(s.evidence_id, node?.text ?? null);
    }
    const where = learningPath(sourceIds.get(s.evidence_id) ?? "");
    if (!where || seen.has(where.path)) continue;
    seen.add(where.path);
    const [title, ...rest] = s.quote.split("\n");
    hits.push({
      ...where,
      title: title ?? "",
      author: s.speaker,
      date: s.occurred_at.slice(0, 10),
      quote: rest.join("\n").trim(),
      score: scores.get(b.id) ?? null,
    });
    if (hits.length >= (opts.limit ?? 3)) break;
  }
  return { status: r.data.status, hits };
}
