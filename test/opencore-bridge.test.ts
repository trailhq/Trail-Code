/**
 * PROTOTYPE (todo #12): a learning as trail-opencore evidence, and recalled
 * blocks back to the learning they came from. No network: fetch is faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { learningEvidence, learningPath, learningSourceId, opencoreTarget, recallLearnings, repoPrincipal, retainLearnings } from "../src/cloud/opencore.js";
import type { UploadedLearning } from "../src/cloud/workspace.js";

const LEARNING: UploadedLearning = {
  path: ".trail/learnings/2026-10-14-retry-cap-anirudh.md",
  ref: "",
  title: "Retry cap for the HTTP client",
  author: "Anirudh",
  date: "2026-10-14",
  touches: ["client/client.go"],
  body: "## Decided\n- Keep defaultRetryMax = 4.\n\n## Tried and ruled out\n- Exponential backoff with jitter.\n",
  hash: "h",
};

test("off unless both the URL and the token are set", () => {
  assert.equal(opencoreTarget({}), null);
  assert.equal(opencoreTarget({ TRAIL_OPENCORE_URL: "http://x" }), null);
  assert.deepEqual(opencoreTarget({ TRAIL_OPENCORE_URL: "http://x/", TRAIL_OPENCORE_TOKEN: "t" }), { url: "http://x", token: "t" });
});

test("a learning is one evidence, one item per section, granted to its repo", () => {
  const e = learningEvidence("github.com/acme/retry", LEARNING);
  assert.equal(e.source_id, "trail-code:github.com/acme/retry:.trail/learnings/2026-10-14-retry-cap-anirudh.md");
  assert.equal(e.kind, "document");
  assert.deepEqual(e.grants, ["repo:github_com_acme_retry"]);
  assert.deepEqual(e.items.map((i) => i.id), ["0-decided", "1-tried-and-ruled-out"]);
  assert.equal(e.items[0]!.speaker, "Anirudh");
  assert.equal(e.items[0]!.occurred_at, "2026-10-14T00:00:00Z");
  assert.match(e.items[0]!.text, /^Retry cap for the HTTP client\nDecided: - Keep defaultRetryMax = 4\.\nTouches: client\/client\.go$/);
  assert.match(e.items[1]!.text, /^Retry cap for the HTTP client\nTried and ruled out: /);
});

test("principals stay inside the agents platform's header charset", () => {
  assert.match(repoPrincipal("github.com/Acme/my.repo"), /^[A-Za-z0-9:_-]+$/);
});

test("source ids round-trip to the learning's path", () => {
  const id = learningSourceId("github.com/acme/retry", LEARNING.path);
  assert.deepEqual(learningPath(id), { repo: "github.com/acme/retry", path: LEARNING.path });
  assert.equal(learningPath("agents:correction:1"), null);
});

function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown]>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const handler = routes[`${init?.method ?? "GET"} ${path}`];
    const [status, data] = handler ? handler(init?.body ? JSON.parse(String(init.body)) : undefined) : [404, { detail: "no route" }];
    return new Response(JSON.stringify(data), { status });
  }) as typeof fetch;
}

test("retain counts new, reused and edited learnings without throwing", async () => {
  const seen: string[] = [];
  const f = fakeFetch({
    "POST /retain": (b) => {
      const id = (b as { source_id: string }).source_id;
      seen.push(id);
      if (id.endsWith("edited.md")) return [409, { detail: "idempotency conflict" }];
      if (id.endsWith("old.md")) return [202, { reused: true, job_id: "j0" }];
      return [202, { reused: false, job_id: "j1", state: "accepted" }];
    },
  });
  const ls = ["new.md", "old.md", "edited.md"].map((n) => ({ ...LEARNING, path: `.trail/learnings/${n}` }));
  const r = await retainLearnings({ url: "http://oc", token: "t" }, "github.com/acme/retry", ls, f);
  assert.equal(seen.length, 3);
  assert.deepEqual({ retained: r.retained, reused: r.reused, conflicts: r.conflicts }, { retained: 1, reused: 1, conflicts: [".trail/learnings/edited.md"] });
  assert.deepEqual(r.jobs, ["j1", "j0"]);
});

test("recall maps blocks back to learnings, once each, and asks for no model", async () => {
  let asked: Record<string, unknown> = {};
  const quote = "Retry cap for the HTTP client\nTried and ruled out: - Exponential backoff with jitter.";
  const f = fakeFetch({
    "POST /recall": (b) => {
      asked = b as Record<string, unknown>;
      return [200, {
        status: "ok",
        blocks: [
          { id: "n1", kind: "chunk", sources: [{ evidence_id: "e1", speaker: "Anirudh", occurred_at: "2026-10-14 00:00:00+00:00", quote }] },
          { id: "n2", kind: "chunk", sources: [{ evidence_id: "e1", speaker: "Anirudh", occurred_at: "2026-10-14 00:00:00+00:00", quote }] },
          { id: "n3", kind: "chunk", sources: [{ evidence_id: "e2", speaker: "agents", occurred_at: "None", quote: "x" }] },
        ],
        candidates: [{ id: "n1", relevance_score: 0.43 }],
      }];
    },
    "GET /history/e1": () => [200, [{ kind: "chunk", text: "…" }, { kind: "evidence", text: learningSourceId("github.com/acme/retry", LEARNING.path) }]],
    "GET /history/e2": () => [200, [{ kind: "evidence", text: "agents:correction:9" }]],
  });
  const r = await recallLearnings({ url: "http://oc", token: "t" }, "why not backoff?", {}, f);
  assert.equal(asked.answerability, false);
  assert.equal(asked.verify_answer, false);
  assert.equal(r.hits.length, 1);
  assert.deepEqual(r.hits[0], {
    repo: "github.com/acme/retry",
    path: LEARNING.path,
    title: "Retry cap for the HTTP client",
    author: "Anirudh",
    date: "2026-10-14",
    quote: "Tried and ruled out: - Exponential backoff with jitter.",
    score: 0.43,
  });
});
