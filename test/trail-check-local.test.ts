/**
 * `trail check` on this machine: the deterministic half of Trail's check,
 * ported from the Go service. The fixtures and expectations are the Go
 * tests' (trail_check_test.go), less the ones about the model and approved
 * brain rules, which only the server has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addedText,
  checkLocally,
  inHunk,
  judgeTrailCheck,
  normTerm,
  parseTrailDiff,
  selectTrailCheckCandidates,
  splitIdentifier,
  trailCheckFiles,
  trailDiffTerms,
  trailLineNumbers,
  trailNumbers,
  trailSentences,
  trailTerms,
  type Candidate,
} from "../src/check/local-check.js";
import type { CheckFinding } from "../src/check/types.js";
import type { Note } from "../src/notes/notes.js";
import type { Skill } from "../src/skills/skills.js";

const NOW = new Date("2026-10-07T12:00:00Z");

function note(n: Partial<Note> & { path: string }): Note {
  return { title: "", author: "", date: "", touches: [], body: "", ...n };
}

function skill(s: Partial<Skill> & { name: string }, takeaways: Array<{ text: string; folded?: boolean }> = []): Skill {
  return {
    description: "",
    version: 0,
    body: "",
    where: "repo",
    file: `/repo/.claude/skills/${s.name}/SKILL.md`,
    ...s,
    takeaways: takeaways.map((t, i) => ({
      path: `/home/.trail/skills/${s.name}/takeaways/${i}.md`,
      skill: s.name,
      taughtBy: "Sam",
      date: "2026-10-01",
      from: "correction",
      confirmedBy: [],
      foldedIn: t.folded ? 2 : undefined,
      text: t.text,
    })),
  };
}

const TEST_DIFF = [
  "diff --git a/internal/ocr/client.go b/internal/ocr/client.go",
  "index 1111111..2222222 100644",
  "--- a/internal/ocr/client.go",
  "+++ b/internal/ocr/client.go",
  "@@ -85,4 +85,6 @@ func (c *Client) Call(ctx context.Context) error {",
  " \tbackoff := time.Second",
  "-\tmaxRetries := 3",
  "+\tmaxRetries := 5",
  "+\t// retries the OCR call without jitter",
  "++++ not a header, an added line starting with three pluses",
  " \tfor i := 0; i < maxRetries; i++ {",
  " \t\tif err := c.do(ctx); err == nil {",
  "diff --git a/internal/ocr/bbox.go b/internal/ocr/bbox.go",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/internal/ocr/bbox.go",
  "@@ -0,0 +1,2 @@",
  "+package ocr",
  "+func NormalizeBox(page Page) Box { return rotate(page.Rotation()) }",
  "diff --git a/internal/old.go b/internal/old.go",
  "deleted file mode 100644",
  "--- a/internal/old.go",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-package internal",
  "",
].join("\n");

/** The CLI's own example: a branch raises the OCR retries from 3 to 5, and a note on that file says the team settled on three. */
const RETRIES_DIFF = [
  "diff --git a/internal/ocr/client.go b/internal/ocr/client.go",
  "--- a/internal/ocr/client.go",
  "+++ b/internal/ocr/client.go",
  "@@ -1,3 +1,3 @@",
  " package ocr",
  " ",
  "-const retries = 3",
  "+const retries = 5",
  "",
].join("\n");

function retriesNote(): Note {
  return note({
    path: "notes/2026-10-03-webhook-retries-lena.md",
    title: "Webhook retries trip the OCR rate limit",
    author: "Lena",
    date: "2026-10-03",
    touches: ["internal/ocr/client.go"],
    body: "## Decided\nThree retries with jitter.\n\n## Watch out\nThe OCR service locks you out for 60s on the fourth call in a second.",
  });
}

/** Go's trailRulesFindings: files and terms from the diff alone, then the rules. */
function rulesFindings(diff: string, notes: Note[], skills: Skill[] = []): CheckFinding[] {
  return checkLocally({ diff, files: [], notes, skills, now: NOW }).findings;
}

test("parses a unified diff by its hunk counts", () => {
  const files = parseTrailDiff(TEST_DIFF);
  assert.equal(files.length, 3);

  const client = files[0]!;
  assert.equal(client.path, "internal/ocr/client.go");
  assert.deepEqual(client.hunks, [{ start: 85, len: 6 }]);
  assert.deepEqual(addedText(client), [
    "\tmaxRetries := 5",
    "\t// retries the OCR call without jitter",
    "+++ not a header, an added line starting with three pluses",
  ]);
  // Context line 85, then the added lines at 86-88.
  assert.deepEqual(
    client.lines.filter((l) => l.op === "+").map((l) => l.new),
    [86, 87, 88],
  );
  assert.ok(inHunk(client, 88));
  assert.ok(!inHunk(client, 91));

  assert.equal(files[1]!.path, "internal/ocr/bbox.go");
  assert.deepEqual(files[1]!.hunks, [{ start: 1, len: 2 }]);
  assert.equal(files[2]!.path, "internal/old.go", "a deleted file keeps its old path");
});

test("the changed files are the listed ones, then the diff's, once each", () => {
  assert.deepEqual(trailCheckFiles(["./internal/ocr/client.go", "internal/extra.go", ""], parseTrailDiff(TEST_DIFF)), [
    "internal/ocr/client.go",
    "internal/extra.go",
    "internal/ocr/bbox.go",
    "internal/old.go",
  ]);
});

test("diff terms put identifiers first, most frequent first, without keywords", () => {
  assert.deepEqual(trailDiffTerms(["maxRetries := 5", "retries := maxRetries", "return err"], 10), ["retries", "maxretries", "max"]);
});

test("terms split identifiers and fold plurals", () => {
  assert.deepEqual(trailTerms("NormalizeBox max_retries the webhook 42 a"), ["normalizebox", "normalize", "box", "max", "retries", "webhook"]);
  assert.deepEqual(
    splitIdentifier("HTTPServer").map((p) => p.toLowerCase()),
    ["http", "server"],
  );
  assert.equal(normTerm("retries"), "retry");
  assert.equal(normTerm("rounding"), "round");
  assert.equal(normTerm("class"), "class");
});

/** The knowledge a check of TEST_DIFF can see, with the text scores the Go fixture gives. */
function fixture() {
  const notes = [
    { note: note({ path: "wording.md", title: "OCR retries and jitter", author: "Ana", date: "2026-10-06", body: "Retries need jitter on the OCR client." }), textScore: 0.9 },
    {
      note: note({
        path: "exact.md",
        title: "Webhook retries trip the OCR rate limit",
        author: "Lena",
        date: "2026-10-03",
        touches: ["internal/ocr/client.go#Call"],
        body: "The OCR service locks you out for 60s on the 4th call in a second. She settled on 3 retries with jitter.",
      }),
      textScore: 0.1,
    },
    { note: note({ path: "dir.md", title: "OCR page cache", author: "Sam", date: "2026-10-01", touches: ["internal/ocr/cache.go"] }), textScore: 0 },
    { note: note({ path: "weak.md", title: "Unrelated", author: "Mei", date: "2026-10-01", body: "Mentions jitter once." }), textScore: 0.05 },
  ];
  const skills = [
    { skill: skill({ name: "pdf-coords", version: 4, description: "Coordinates for PDF pages", body: "Box math lives in internal/ocr/bbox.go." }), textScore: 0 },
    {
      skill: skill({ name: "retries", version: 1, description: "How we retry", body: "Retries back off." }, [{ text: "Always add jitter to OCR retries." }]),
      textScore: 0.3,
    },
    { skill: skill({ name: "unmatched", body: "Nothing here." }), textScore: 0 },
    { skill: skill({ name: "folded", body: "Release notes." }, [{ text: "jitter retries ocr", folded: true }]), textScore: 0.2 },
  ];
  return { notes, skills };
}

function labels(cands: Candidate[]): string[] {
  return cands.map((c) => (c.kind === "note" ? `note:${c.note.path}` : `skill:${c.skill.name}`));
}

test("candidates: files touched beat wording, then skills", () => {
  const { notes, skills } = fixture();
  const got = selectTrailCheckCandidates(["internal/ocr/client.go", "internal/ocr/bbox.go"], ["retries", "jitter", "ocr"], notes, skills, NOW);
  assert.deepEqual(labels(got), [
    // Touching a changed file beats any wording; a shared folder beats wording
    // too; a note matched on one term only is left out.
    "note:exact.md",
    "note:wording.md",
    "note:dir.md",
    // A skill naming a changed path first; one sharing the diff's words next;
    // a folded takeaway does not count.
    "skill:pdf-coords",
    "skill:retries",
  ]);
});

test("candidates are capped at 25, skills at 6", () => {
  const notes = Array.from({ length: 40 }, (_, i) => ({ note: note({ path: `n${i}.md`, touches: ["internal/ocr/client.go"] }), textScore: 0 }));
  const skills = Array.from({ length: 10 }, (_, i) => ({ skill: skill({ name: `s${i}`, body: "See internal/ocr/client.go." }), textScore: 0 }));
  const got = selectTrailCheckCandidates(["internal/ocr/client.go"], [], notes, skills, NOW);
  assert.equal(got.length, 25);
  assert.equal(got.filter((c) => c.kind === "skill").length, 6);
});

test("nothing on record for the diff: counts only, no findings", () => {
  const notes = [note({ path: "notes/b.md", title: "Billing", author: "Mei", touches: ["internal/billing/invoice.go"], body: "## Decided\nInvoices round to cents." })];
  const skills = [skill({ name: "release", body: "Tag the release on Fridays." })];
  assert.deepEqual(checkLocally({ diff: TEST_DIFF, files: [], notes, skills, asker: "Sam", now: NOW }), {
    files: 3,
    notes: 1,
    skills: 1,
    findings: [],
  });
  assert.deepEqual(checkLocally({ diff: "", files: [], notes, skills }), { files: 0, notes: 1, skills: 1, findings: [] });
});

test("a value changed against a note's number is a conflict on its line", () => {
  const res = checkLocally({ diff: RETRIES_DIFF, files: ["internal/ocr/client.go"], notes: [retriesNote()], skills: [], asker: "Sam", now: NOW });
  assert.equal(res.files, 1);
  assert.equal(res.notes, 1);
  assert.equal(res.skills, 0);
  assert.deepEqual(res.findings, [
    {
      file: "internal/ocr/client.go",
      line: 3,
      verdict: "conflict",
      summary: "changes retries from 3 to 5",
      source: {
        kind: "note",
        title: "Webhook retries trip the OCR rate limit",
        author: "Lena",
        date: "2026-10-03",
        path: "notes/2026-10-03-webhook-retries-lena.md",
        quote: "Three retries with jitter.",
      },
    },
  ]);
});

test("value changes: warned about, decided on, and numbers about something else", () => {
  const n = (body: string) => [note({ path: "notes/n.md", title: "OCR client", author: "Lena", touches: ["internal/ocr/client.go#Call"], body })];

  // Setting the value a note warned about is a conflict, with its line.
  let got = rulesFindings(RETRIES_DIFF, n("## Watch out\n- 5 retries got us locked out for a minute."));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.verdict, "conflict");
  assert.equal(got[0]!.line, 3);
  assert.equal(got[0]!.summary, "sets retries to 5, which Lena's learning warned about");
  assert.equal(got[0]!.source.quote, "5 retries got us locked out for a minute.");

  // Moving to the decided value follows it, without a line.
  got = rulesFindings(RETRIES_DIFF, n("## Decided\nWe raised it to five retries."));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.verdict, "follows");
  assert.equal(got[0]!.line, undefined);

  // A number about something else on the line is not a conflict: the sentence
  // has to be about what changed.
  assert.deepEqual(rulesFindings(RETRIES_DIFF, n("## Decided\nThe page cache holds three pages.")), []);

  // Context sections and notes on other code say nothing.
  assert.deepEqual(rulesFindings(RETRIES_DIFF, n("## Context\nThree retries, historically.")), []);
  const other = note({ path: "notes/o.md", title: "Billing", author: "Mei", touches: ["internal/billing/invoice.go"], body: "## Decided\nThree retries with jitter." });
  assert.deepEqual(rulesFindings(RETRIES_DIFF, [other]), []);
});

test("an approach a note ruled out, back in the added lines, is a conflict", () => {
  const diff = [
    "diff --git a/internal/cache/store.go b/internal/cache/store.go",
    "--- a/internal/cache/store.go",
    "+++ b/internal/cache/store.go",
    "@@ -10,2 +10,4 @@ type Store struct {",
    " \titems map[string]Item",
    "+\t// one lock for every key",
    "+\tglobalMutex sync.Mutex",
    " }",
    "",
  ].join("\n");
  const notes = [
    note({
      path: "notes/c.md",
      title: "Cache contention",
      author: "Arun",
      date: "2026-10-01",
      touches: ["internal/cache/store.go"],
      body: "## Decided\nShard the cache by key.\n\n## Tried and ruled out\n- A global mutex around the cache: p99 tripled under load.",
    }),
  ];
  const got = rulesFindings(diff, notes);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.verdict, "conflict");
  assert.equal(got[0]!.line, 12, "the first added line carrying the approach");
  assert.equal(got[0]!.summary, "brings back global mutex, which Arun's learning ruled out");
  assert.equal(got[0]!.source.quote, "A global mutex around the cache: p99 tripled under load.");
});

test("a skill's takeaway the added lines carry is followed", () => {
  const diff = [
    "diff --git a/internal/ocr/bbox.go b/internal/ocr/bbox.go",
    "--- a/internal/ocr/bbox.go",
    "+++ b/internal/ocr/bbox.go",
    "@@ -1,1 +1,2 @@",
    " package ocr",
    "+func NormalizeBox(page Page) Box { return rotate(page.Rotation(), page.Box()) }",
    "",
  ].join("\n");
  const skills = [skill({ name: "pdf-coords", version: 4, body: "Box math lives in internal/ocr/bbox.go." }, [{ text: "Always rotate the box by page.Rotation() first." }])];
  assert.deepEqual(rulesFindings(diff, [], skills), [
    {
      file: "internal/ocr/bbox.go",
      verdict: "follows",
      summary: "follows skill pdf-coords: Always rotate the box by page.Rotation() first",
      source: { kind: "skill", name: "pdf-coords", version: 4, quote: "Always rotate the box by page.Rotation() first." },
    },
  ]);
});

test("sentences and the numbers they state", () => {
  assert.deepEqual(trailSentences("- Three retries with jitter. The OCR service locks you out."), ["Three retries with jitter.", "The OCR service locks you out."]);
  assert.deepEqual(trailSentences("1. Use v1.2 of the API, e.g. the batch one."), ["Use v1.2 of the API, e.g. the batch one."]);
  const nums = trailNumbers("locks you out for 60s on the fourth call; three retries");
  assert.ok(nums.has(60));
  assert.ok(nums.has(4));
  assert.ok(nums.has(3));
  assert.deepEqual(trailLineNumbers("maxRetries2 := 5"), ["5"]);
});

test("no candidates, no findings", () => {
  assert.deepEqual(judgeTrailCheck([], parseTrailDiff(TEST_DIFF)), []);
});

/* -------------------------------------------------------------------------- */
/* the live demo: hashicorp/go-retryablehttp                                  */
/* -------------------------------------------------------------------------- */

const DEMO_NOTE_PATH = "/Users/anirudh/.trail/repos/hashicorp-go-retryablehttp/notes/2026-10-08-keep-the-default-retry-count-at-4-anirudh.md";
const DEMO_DECIDED = "Keep defaultRetryMax = 4: ten retries with the default backoff can hold one Do() call for over an hour.";

function demoNote(): Note {
  return note({
    path: DEMO_NOTE_PATH,
    title: "Keep the default retry count at 4",
    author: "Anirudh",
    date: "2026-10-08",
    touches: ["client.go"],
    body: [
      "## Decided",
      `- ${DEMO_DECIDED}`,
      "",
      "## Tried and ruled out",
      "- Raising the default to 10 for one customer: worst case, a single Do() call blocks for over an hour.",
      "",
      "## Watch out",
      "- RetryWaitMax caps each wait at 30s, not the total: the waits add up with every retry.",
    ].join("\n"),
  });
}

function demoDiff(from: string, to: string): string {
  return [
    "diff --git a/client.go b/client.go",
    "index 1111111..2222222 100644",
    "--- a/client.go",
    "+++ b/client.go",
    "@@ -48,7 +48,7 @@ var (",
    " \t// Default retry configuration",
    " \tdefaultRetryWaitMin = 1 * time.Second",
    " \tdefaultRetryWaitMax = 30 * time.Second",
    `-\tdefaultRetryMax     = ${from}`,
    `+\tdefaultRetryMax     = ${to}`,
    " ",
    " \t// defaultLogger is the logger provided with defaultClient",
    ' \tdefaultLogger = log.New(os.Stderr, "", log.LstdFlags)',
    "",
  ].join("\n");
}

test("demo: raising defaultRetryMax from 4 to 10 conflicts with Anirudh's decision", () => {
  const res = checkLocally({ diff: demoDiff("4", "10"), files: ["client.go"], notes: [demoNote()], skills: [], asker: "Kumar", now: new Date("2026-10-09T10:00:00Z") });
  assert.deepEqual(res, {
    files: 1,
    notes: 1,
    skills: 0,
    findings: [
      {
        file: "client.go",
        line: 51,
        verdict: "conflict",
        summary: "changes defaultRetryMax from 4 to 10",
        source: {
          kind: "note",
          title: "Keep the default retry count at 4",
          author: "Anirudh",
          date: "2026-10-08",
          path: DEMO_NOTE_PATH,
          quote: DEMO_DECIDED,
        },
      },
    ],
  });
});

test("demo: putting defaultRetryMax back to 4 follows the decision, without a line", () => {
  const res = checkLocally({ diff: demoDiff("10", "4"), files: ["client.go"], notes: [demoNote()], skills: [], now: NOW });
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0]!.verdict, "follows");
  assert.equal(res.findings[0]!.line, undefined);
  assert.equal(res.findings[0]!.summary, "sets defaultRetryMax to 4, as Anirudh's learning says");
});
