/** The per-prompt hint brings in learnings earlier sessions left, each once a session. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { notesForPrompt, type AskJson } from "../src/claude/format.js";
import type { SessionState } from "../src/claude/state.js";

const hit = (title: string, path: string, tokens = 90_000) => ({
  note: { path, title, author: "Anirudh", date: "2026-10-08", touches: ["pkg/cmd/repo/clone/clone.go"], body: "## Decided\nPrint ✓ Cloned OWNER/REPO to DIR, only on a TTY.\n", cost: { minutes: 4, tokens } },
  score: 1,
  shared: [],
});

test("a matching learning reaches the agent with the prompt, once a session, with what it saves", () => {
  const ask = { query: "fork clone message", mode: "lexical", hits: [], notes: [hit("gh repo clone success message", "/n/a.md")] } as AskJson;
  const s = {} as SessionState;
  const first = notesForPrompt(ask, s);
  assert.match(first!, /learnings earlier sessions left on this/);
  assert.match(first!, /close your reply with one short line that credits it/);
  assert.match(first!, /📝 Started from Anirudh's learning · saved ~90k tokens and ~4 min/);
  assert.match(first!, /from Anirudh's learning · Oct 8 · gh repo clone success message/);
  assert.match(first!, /\[(graft|trail)\] learnings saved ≈ 89,\d{3} tokens/, "what it took less reading it, for the savings total");
  assert.match(first!, /Print ✓ Cloned OWNER\/REPO to DIR/);
  assert.equal(notesForPrompt(ask, s), null, "not again in the same session");
  assert.equal(notesForPrompt({ query: "x", mode: "lexical", hits: [] } as AskJson, {} as SessionState), null, "no notes, nothing");
});

test("a learning that took under 80k tokens is credited as a faster PR instead", () => {
  const ask = { query: "fork clone message", mode: "lexical", hits: [], notes: [hit("gh repo clone success message", "/n/a.md", 30_000)] } as AskJson;
  const first = notesForPrompt(ask, {} as SessionState);
  assert.match(first!, /📝 Started from Anirudh's learning · 3x faster to a PR/);
  assert.match(first!, /\[(graft|trail)\] starting from this learning gets you to a PR 3x faster\./);
  assert.doesNotMatch(first!, /tokens and/);
});
