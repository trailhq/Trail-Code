/**
 * Session notes: one note per session, written by `trail note` into
 * `~/.trail/repos/<repo>/notes/`, read back by `ask` for the next session on
 * the same thing. Never in the repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  costLabel,
  findNotes,
  formatNoteHits,
  listNotes,
  parseNote,
  renderNote,
  sectionLead,
  shortDate,
  slug,
  tokensLabel,
  writeNote,
  type Note,
} from "../src/notes/notes.js";
import { aboutTerms, costFromTranscript, FALLBACK_ACTIVE_MS } from "../src/notes/session-cost.js";
import { ensureRepoHome, repoPlace } from "../src/notes/home.js";
import { homeEnv, tmpRepo } from "./helpers.js";

// Everything this file writes in-process goes to a scratch ~/.trail.
const TRAIL_HOME = mkdtempSync(join(tmpdir(), "notes-trail-home-"));
process.env.TRAIL_HOME = TRAIL_HOME;

const BODY = [
  "## Decided",
  "Rotate each box in `NormalizeBox` by its own page's `/Rotate` before scaling.",
  "",
  "## Tried and ruled out",
  "- Rotating the image before OCR. Works, but doubles latency on long files.",
  "",
  "## Watch out",
  "`/Rotate` can be 270 on a single page inside an otherwise upright file.",
].join("\n");

function note(over: Partial<Note> = {}): Note {
  return {
    path: join(homedir(), ".trail", "repos", "github.com", "acme", "extract", "notes", "2026-10-07-bbox-priya.md"),
    title: "Bbox coordinates are off on rotated PDFs",
    author: "Priya",
    date: "2026-10-07",
    branch: "fix/bbox-rotation",
    cost: { minutes: 12, tokens: 9600 },
    touches: ["internal/ocr/bbox.go#NormalizeBox", "internal/ocr/client.go"],
    body: BODY,
    ...over,
  };
}

// --- the file format ---

test("a note round-trips through its file, frontmatter and all", () => {
  const n = note();
  const text = renderNote(n);
  assert.match(text, /^---\ntitle: Bbox coordinates are off on rotated PDFs\nauthor: Priya\ndate: 2026-10-07\nbranch: fix\/bbox-rotation\ncost: \{ minutes: 12, tokens: 9600 \}\ntouches:\n  - "internal\/ocr\/bbox.go#NormalizeBox"\n  - internal\/ocr\/client.go\n---\n\n## Decided/);
  assert.deepEqual(parseNote(text, n.path), n);
});

test("titles that YAML would misread are quoted, and still come back intact", () => {
  const n = note({ title: "Retries: why #3 fails", touches: [], cost: undefined, branch: undefined });
  assert.equal(parseNote(renderNote(n), n.path)?.title, "Retries: why #3 fails");
});

test("a file without a title isn't a note", () => {
  assert.equal(parseNote("# just markdown\n", "x.md"), null);
  assert.equal(parseNote("---\nauthor: x\n---\nbody", "x.md"), null);
});

test("writeNote names the file by date, title and author, never overwrites, and writes nothing into the repo", () => {
  const repo = tmpRepo("notes-write");
  const a = writeNote(repo, { title: "Bbox coordinates are off on rotated PDFs", body: BODY, author: "Priya", date: "2026-10-07" });
  const b = writeNote(repo, { title: "Bbox coordinates are off on rotated PDFs", body: "again", author: "Priya", date: "2026-10-07" });
  const notes = join(repoPlace(repo).dir, "notes");
  assert.ok(notes.startsWith(join(TRAIL_HOME, "repos", "local") + sep), notes);
  assert.equal(a.path, join(notes, "2026-10-07-bbox-coordinates-are-off-on-rotated-priya.md"));
  assert.equal(b.path, join(notes, "2026-10-07-bbox-coordinates-are-off-on-rotated-priya-2.md"));
  assert.match(readFileSync(a.path, "utf8"), /Rotate each box/);
  assert.equal(listNotes(repo).length, 2);
  assert.deepEqual(readdirSync(repo), [], "the repo itself is untouched");
});

test("ensureRepoHome makes the folder once and writes ~/.trail's README once, keeping someone's edits", () => {
  const repo = tmpRepo("notes-dir");
  assert.equal(ensureRepoHome(repo).created, true);
  assert.ok(existsSync(join(repoPlace(repo).dir, "notes")));
  const readme = join(TRAIL_HOME, "README.md");
  assert.match(readFileSync(readme, "utf8"), /^# ~\/\.trail/);
  writeFileSync(readme, "ours\n");
  assert.equal(ensureRepoHome(repo).created, false);
  assert.equal(readFileSync(readme, "utf8"), "ours\n");
});

test("small formatting helpers", () => {
  assert.equal(slug("Bbox coordinates are off on rotated PDFs!"), "bbox-coordinates-are-off-on-rotated");
  assert.equal(shortDate("2026-10-07"), "Oct 7");
  assert.equal(tokensLabel(9600), "~9.6k tokens");
  assert.equal(tokensLabel(31_200), "~31k tokens");
  assert.equal(tokensLabel(600), "~600 tokens");
  assert.equal(costLabel({ minutes: 12, tokens: 9600 }), "took 12 min and ~9.6k tokens to work out");
  assert.equal(costLabel(undefined), null);
  assert.equal(sectionLead(BODY, "Tried and ruled out"), "Rotating the image before OCR. Works, but doubles latency on long files.");
  assert.equal(sectionLead(BODY, "Missing"), null);
});

// --- finding the notes that bear on a query ---

test("a note shows up for a query that shares its words, or for results in a file it touches", () => {
  const notes = [note(), note({ path: "b.md", title: "Webhook retries back off too fast", body: "## Decided\nUse jitter.", touches: ["internal/hooks/retry.go"] })];
  assert.equal(findNotes(notes, "bbox coordinates rotated pdf")[0]?.note.title, "Bbox coordinates are off on rotated PDFs");
  // Words in common with neither title, but the results land in a file the note touches.
  const byFile = findNotes(notes, "thumbnail crop area", ["internal/ocr/bbox.go"]);
  assert.equal(byFile.length, 1);
  assert.deepEqual(byFile[0]?.shared, ["internal/ocr/bbox.go"]);
});

test("an unrelated note never rides along", () => {
  assert.deepEqual(findNotes([note()], "logging setup for the worker"), []);
  // One stray body word is not enough.
  assert.deepEqual(findNotes([note()], "latency dashboards"), []);
});

test("ask's learnings block names the author, the date, each section's lead and the cost", () => {
  const lines = formatNoteHits([{ note: note(), score: 9, shared: [] }]);
  assert.deepEqual(lines, [
    "from Priya's learning · Oct 7 · Bbox coordinates are off on rotated PDFs",
    "  decided     Rotate each box in `NormalizeBox` by its own page's `/Rotate` before scaling.",
    "  ruled out   Rotating the image before OCR. Works, but doubles latency on long files.",
    "  watch out   `/Rotate` can be 270 on a single page inside an otherwise upright file.",
    "  ~/.trail/repos/github.com/acme/extract/notes/2026-10-07-bbox-priya.md · took 12 min and ~9.6k tokens to work out",
    "",
  ]);
});

// --- what a session cost, from Claude Code's transcript ---

function line(o: object): string {
  return JSON.stringify(o);
}
const at = (min: number) => new Date(Date.parse("2026-10-07T10:00:00Z") + min * 60_000).toISOString();
const usage = (input: number, created: number, output: number, read = 50_000) => ({
  input_tokens: input,
  cache_creation_input_tokens: created,
  cache_read_input_tokens: read,
  output_tokens: output,
});

test("cost counts fresh tokens once per message, and active minutes only", () => {
  const t = [
    line({ type: "user", timestamp: at(0), message: { content: "fix bbox" } }),
    // One message, two content blocks: the usage repeats and must count once.
    line({ type: "assistant", timestamp: at(1), message: { id: "m1", usage: usage(100, 2000, 300), content: [{ type: "text", text: "looking" }] } }),
    line({ type: "assistant", timestamp: at(1), message: { id: "m1", usage: usage(100, 2000, 300), content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "trail ask x" } }] } }),
    // 40 minutes away from the keyboard: not counted.
    line({ type: "assistant", timestamp: at(41), message: { id: "m2", usage: usage(50, 1000, 200), content: [] } }),
  ].join("\n");
  const c = costFromTranscript(t, Date.parse(at(45)));
  assert.equal(c?.tokens, 2400 + 1250);
  assert.equal(c?.minutes, 5, "1 min, then the 40-min gap skipped, then 4 min to now");
});

test("cost starts after the session's last finished note, not the one being written", () => {
  const t = [
    line({ type: "assistant", timestamp: at(0), message: { id: "a", usage: usage(0, 9000, 1000), content: [{ type: "tool_use", id: "n1", name: "Bash", input: { command: "trail note --title first <<'EOF'" } }] } }),
    line({ type: "user", timestamp: at(1), message: { content: [{ type: "tool_result", tool_use_id: "n1", content: "✓ note saved" }] } }),
    line({ type: "assistant", timestamp: at(2), message: { id: "b", usage: usage(10, 400, 90), content: [] } }),
    // The note call in flight now: no result yet, so it is not a boundary.
    line({ type: "assistant", timestamp: at(3), message: { id: "c", usage: usage(0, 0, 100), content: [{ type: "tool_use", id: "n2", name: "Bash", input: { command: "trail note --title second" } }] } }),
  ].join("\n");
  assert.equal(costFromTranscript(t, Date.parse(at(3)))?.tokens, 600);
});

test("the cost carries the files the session edited since its last note, for the repos the note goes to", () => {
  const edit = (id: string, name: string, input: object) =>
    line({ type: "assistant", timestamp: at(1), message: { id, usage: usage(0, 0, 10), content: [{ type: "tool_use", id, name, input }] } });
  const t = [
    edit("e0", "Edit", { file_path: "/src/extract/old.go" }),
    line({ type: "assistant", timestamp: at(1), message: { id: "n", usage: usage(0, 0, 1), content: [{ type: "tool_use", id: "n1", name: "Bash", input: { command: "trail note --title first" } }] } }),
    line({ type: "user", timestamp: at(1), message: { content: [{ type: "tool_result", tool_use_id: "n1", content: "✓" }] } }),
    edit("e1", "Edit", { file_path: "/src/extract/internal/ocr/bbox.go" }),
    edit("e2", "Write", { file_path: "/src/ocr-lib/rotate.py" }),
    edit("e3", "MultiEdit", { file_path: "/src/extract/internal/ocr/bbox.go" }),
    edit("e4", "NotebookEdit", { notebook_path: "/src/extract/notebooks/rotation.ipynb" }),
    edit("e5", "Read", { file_path: "/src/extract/README.md" }),
  ].join("\n");
  assert.deepEqual(costFromTranscript(t, Date.parse(at(2)))?.edited, [
    "/src/extract/internal/ocr/bbox.go",
    "/src/ocr-lib/rotate.py",
    "/src/extract/notebooks/rotation.ipynb",
  ]);
});

test("a note names its work by its files and specific backticked terms, not by phrases", () => {
  const body = "## Decided\n- `dropHtmlComments` in `src/notes/pr-reviews.ts` repeats until stable.\n- Run `trail init` and `publish`, keep `repo_id`, see `git check-ignore`.\n- `main` is fine.";
  assert.deepEqual(aboutTerms(body, ["internal/ocr/bbox.go#NormalizeBox"]), [
    "internal/ocr/bbox.go",
    "bbox.go",
    "dropHtmlComments",
    "src/notes/pr-reviews.ts",
    "repo_id",
  ]);
});

test("a note's cost starts at the turn where its work first came up, not at the session's start", () => {
  const t = [
    // An hour on something else first.
    line({ type: "user", timestamp: at(0), message: { content: "search slack for the release" } }),
    line({ type: "assistant", timestamp: at(5), message: { id: "s", usage: usage(0, 50_000, 1000), content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "slack search release" } }] } }),
    line({ type: "assistant", timestamp: at(9), message: { id: "s2", usage: usage(0, 40_000, 1000), content: [] } }),
    // The turn the learning is about: its prompt counts, then the tool call that names the file.
    line({ type: "user", timestamp: at(10), message: { content: "why is the box rotated?" } }),
    line({ type: "assistant", timestamp: at(11), message: { id: "w", usage: usage(0, 3000, 500), content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/repo/internal/ocr/bbox.go" } }] } }),
    line({ type: "assistant", timestamp: at(14), message: { id: "w2", usage: usage(0, 2000, 500), content: [] } }),
    // The note being saved names everything: it never counts as where the work began.
    line({ type: "assistant", timestamp: at(15), message: { id: "n", usage: usage(0, 0, 100), content: [{ type: "tool_use", id: "n1", name: "Bash", input: { command: "trail note --title x <<'EOF'\nslack bbox.go\nEOF" } }] } }),
  ].join("\n");
  const now = Date.parse(at(15));
  const whole = costFromTranscript(t, now)!;
  const scoped = costFromTranscript(t, now, aboutTerms("see `internal/ocr/bbox.go`"))!;
  assert.equal(whole.tokens, 51_000 + 41_000 + 3500 + 2500 + 100);
  assert.equal(scoped.tokens, 3500 + 2500 + 100);
  assert.equal(scoped.minutes, 5);
  assert.equal(scoped.countedFrom, Date.parse(at(10)));
  assert.equal(scoped.startedAt, Date.parse(at(0)), "the stretch since the last note still starts at the top");
});

test("when nothing in the transcript names the work, only the last 30 active minutes count", () => {
  const t = Array.from({ length: 13 }, (_, i) =>
    line({ type: "assistant", timestamp: at(i * 5), message: { id: `m${i}`, usage: usage(0, 1000, 0), content: [] } }),
  ).join("\n");
  const now = Date.parse(at(60));
  assert.equal(costFromTranscript(t, now)!.minutes, 60);
  const capped = costFromTranscript(t, now, ["nowhere/in/it.go"])!;
  assert.equal(capped.minutes, FALLBACK_ACTIVE_MS / 60_000);
  assert.equal(capped.tokens, 7000, "the entries at 30, 35, …, 60 minutes");
});

test("no transcript entries, no cost", () => {
  assert.equal(costFromTranscript("", Date.now()), null);
  assert.equal(costFromTranscript("not json\n", Date.now()), null);
});

// --- end to end ---

/** Runs from this checkout (so `--import tsx` resolves); the repo goes in `args`. */
function run(name: "trail" | "graft", args: string[], home: string, input?: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", `${name}.ts`), ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_HOME: undefined },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function repoWithCode(): string {
  const d = tmpRepo("notes-e2e");
  mkdirSync(join(d, "internal", "ocr"), { recursive: true });
  writeFileSync(join(d, "internal", "ocr", "bbox.go"), "package ocr\n\nfunc NormalizeBox(x float64, rotate int) float64 {\n\treturn x\n}\n");
  writeFileSync(join(d, "CLAUDE.md"), "# extract\n\nTeam rules.\n");
  spawnSync("git", ["init", "-q"], { cwd: d });
  spawnSync("git", ["config", "user.name", "Priya Raman"], { cwd: d });
  spawnSync("git", ["config", "user.email", "p@example.com"], { cwd: d });
  spawnSync("git", ["add", "-A"], { cwd: d });
  spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: d });
  return d;
}

/** The one folder of notes under a scratch HOME's ~/.trail/repos. */
function notesUnder(home: string): string {
  const local = join(home, ".trail", "repos", "local");
  const [key] = readdirSync(local);
  return join(local, key!, "notes");
}

test("trail init makes the repo's .trail/learnings/ and says to commit it; graft init makes neither", () => {
  const home = mkdtempSync(join(tmpdir(), "notes-home-"));
  const d = repoWithCode();
  const t = run("trail", ["init", d, "--agents", "claude", "--yes", "--no-global"], home);
  assert.equal(t.status, 0, t.err);
  assert.match(t.err, /✓ learnings {2}\.trail\/learnings\/ · sessions that take real digging leave one there, for your whole team/);
  assert.match(t.err, /· commit \.claude\/settings\.json and \.trail\/ once — after that, teammates' Claude reads your learnings even before they install trail/);
  assert.ok(existsSync(join(d, ".trail", "learnings")));
  assert.match(readFileSync(join(d, ".trail", "README.md"), "utf8"), /^# \.trail/);
  assert.equal(readFileSync(join(d, "CLAUDE.md"), "utf8"), "# extract\n\nTeam rules.\n", "the team's CLAUDE.md is untouched");

  const g = repoWithCode();
  const home2 = mkdtempSync(join(tmpdir(), "notes-home-"));
  assert.equal(run("graft", ["init", g, "--agents", "claude", "--yes", "--no-global"], home2).status, 0);
  assert.equal(existsSync(join(home2, ".trail")), false);
  assert.equal(existsSync(join(g, ".trail")), false);
});

test("trail note saves a learning in .trail/learnings/ to commit, ask shows it to the next session, uninstall leaves it", () => {
  const home = mkdtempSync(join(tmpdir(), "notes-home-"));
  const d = repoWithCode();
  run("trail", ["init", d, "--agents", "claude", "--yes", "--no-global"], home);
  // Init's files go in with the setup commit, as they would for a real team.
  spawnSync("git", ["add", "-A"], { cwd: d });
  spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "wire trail"], { cwd: d });
  // A teammate worked on the same file: the case for committing names them.
  writeFileSync(join(d, "internal", "ocr", "bbox.go"), "package ocr\n\nfunc NormalizeBox(x float64, rotate int) float64 {\n\treturn x * 1\n}\n");
  spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Anay Shah", "-c", "user.email=anay@acme.test", "commit", "-qam", "scale"], { cwd: d });
  writeFileSync(join(d, "internal", "ocr", "bbox.go"), "package ocr\n\nfunc NormalizeBox(x float64, rotate int) float64 {\n\treturn -x\n}\n");

  const saved = run("trail", ["note", d, "--title", "Bbox coordinates are off on rotated PDFs", "--minutes", "12", "--tokens", "9600"], home, BODY);
  assert.equal(saved.status, 0, saved.err);
  assert.match(saved.out, /^✓ saved for your team · \.trail\/learnings\/\d{4}-\d{2}-\d{2}-bbox-coordinates-are-off-on-rotated-priya\.md$/m);
  assert.match(saved.out, /· the next session that touches bbox\.go starts from this, and gets to a PR 3x faster/);
  assert.match(
    saved.out,
    /^🌱 Anay works in this part of the codebase\. Commit what you learned and their agents get to a PR 3x faster · git add \.trail\/learnings\/\S+\.md$/m,
  );
  assert.match(
    saved.out,
    /\[trail\] Close your reply with one line, word for word\. If this learning is committed by the end of your turn: 📝 Committed · Anay works in this part of the codebase, and their agents now get to a PR 3x faster\n  If it isn't: 🌱 Anay works in this part of the codebase\. Commit what you learned and their agents get to a PR 3x faster$/m,
    "the closing lines, for the agent's reply",
  );
  const [file] = readdirSync(join(d, ".trail", "learnings")).filter((f) => f.endsWith(".md"));
  const written = parseNote(readFileSync(join(d, ".trail", "learnings", file!), "utf8"), "x");
  assert.equal(written?.author, "Priya");
  assert.deepEqual(written?.touches, ["internal/ocr/bbox.go"], "the changed file, not the wiring init wrote");
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: d, encoding: "utf8" }).stdout;
  assert.equal(status, ` M internal/ocr/bbox.go\n?? .trail/learnings/${file}\n`, "the learning waits to be committed with the change");

  // Asked from either name, and from a subfolder of the repo.
  for (const [name, dir] of [["trail", d], ["graft", d], ["trail", join(d, "internal")]] as const) {
    const ask = run(name, ["ask", "bbox rotated pdf", dir], home);
    assert.equal(ask.status, 0, ask.err);
    assert.match(ask.out, /from Priya's learning · \w{3} \d+ · Bbox coordinates are off on rotated PDFs/);
    assert.match(ask.out, /ruled out {3}Rotating the image before OCR/);
    assert.match(ask.out, /\.trail\/learnings\/\d{4}-\d{2}-\d{2}-bbox/);
    assert.match(ask.out, /\[(trail|graft)\] starting from this learning gets you to a PR 3x faster\./, "what reusing it is worth");
  }
  // Not connected to a workspace: what was searched stays unrecorded, so a later sign-in has nothing old to send.
  assert.equal(existsSync(join(home, ".trail", "outbox.jsonl")), false, "no outbox before connecting");

  const st = run("trail", ["status", d], home);
  assert.equal(st.status, 0, st.err);
  assert.match(st.out, /^learnings {3}1 for the team in \.trail\/learnings\/$/m);
  assert.equal(JSON.parse(run("trail", ["status", d, "--json"], home).out).learnings.repo, 1);

  const un = run("trail", ["uninstall", d, "-y", "--no-global"], home);
  assert.equal(un.status, 0, un.err);
  assert.ok(existsSync(join(d, ".trail", "learnings", file!)), "learnings are the team's, never uninstalled");
});

test("trail note --personal keeps it in ~/.trail, out of the repo", () => {
  const home = mkdtempSync(join(tmpdir(), "notes-home-"));
  const d = repoWithCode();
  const saved = run("trail", ["note", d, "--personal", "--title", "My editor runs gofmt on save"], home, BODY);
  assert.equal(saved.status, 0, saved.err);
  assert.match(saved.out, /^✓ saved just for you · ~\/\.trail\/repos\/local\/[^/]+\/notes\/\d{4}-\d{2}-\d{2}-my-editor-runs-gofmt-on-save-priya\.md$/m);
  assert.match(saved.out, /^· just for you: kept on this machine, out of the repo$/m);
  assert.match(saved.out, /📝 Saved just for you · stays on this machine, out of the repo$/m);
  assert.ok(existsSync(notesUnder(home)));
  assert.equal(existsSync(join(d, ".trail")), false);
});

test("trail note without a body says how to write one", () => {
  const home = mkdtempSync(join(tmpdir(), "notes-home-"));
  const r = run("trail", ["note", repoWithCode(), "--title", "x"], home, "");
  assert.equal(r.status, 1);
  assert.match(r.err, /a learning needs a --title and a body/);
});

// --- what agents read in a repo that uses trail ---

test("the skill speaks trail in a repo wired for it, names the map in .trail/cache/, and teaches learnings", async () => {
  const { skillTemplate } = await import("../src/claude/skill-template.js");
  const graft = skillTemplate("graft");
  const trail = skillTemplate("trail");
  assert.equal(skillTemplate(), graft, "graft is the default, unchanged");
  assert.doesNotMatch(graft, /\.trail\//);
  assert.match(trail, /^name: trail$/m, "it lives in .claude/skills/trail/");
  assert.match(trail, /`trail ask "<question>" --source`/);
  assert.match(trail, /`trail build` \/ `trail build --check`/);
  assert.match(trail, /`\.trail\/cache\/` holds a graph/, "under trail the code map is in .trail/cache/");
  assert.doesNotMatch(trail, /\bgraft (ask|grep|skeleton|callers|map|build|check)\b/);
  assert.match(trail, /trail note --title/);
  assert.match(trail, /It's written to `\.trail\/learnings\/`\. Commit it\n  with the change it came from/);
  assert.match(trail, /- Just for the user, with `--personal`: how this person likes to work/);
  assert.doesNotMatch(trail, /trail learn|trail skills show/, "corrections are learnings too, not takeaways on a skill");
  assert.match(trail, /## If trail isn't installed/);
});

// Claude Code reads only a skill's description up front, so the moments to
// reach for trail have to be named there, and lead the body.
test("the trail skill's description names when to use its commands, and the body leads with them", async () => {
  const { skillTemplate } = await import("../src/claude/skill-template.js");
  const matter = (await import("gray-matter")).default;
  const { data, content } = matter(skillTemplate("trail"));
  assert.equal(data.name, "trail");
  assert.ok(data.description.length <= 1024, "skill descriptions are capped at 1,024 characters");
  assert.match(data.description, /ANY task in this repo/);
  assert.match(data.description, /trail ask before grepping/);
  assert.match(data.description, /When a task took real digging, save a learning with trail note and commit it with the change/);
  assert.match(data.description, /\.trail\/learnings\//, "where the learnings are, for a Claude without trail");
  assert.match(data.description, /npm install -g @trailhq\/trail/, "and how to get the command");
  assert.doesNotMatch(data.description, /graft/, "nothing about the old name or the graft\/ folder");
  const moments = content.indexOf("## When to reach for trail");
  assert.ok(moments >= 0 && moments < content.indexOf("## The tools"), "the moments come before the tool docs");
  assert.match(content, /\*\*When you finish a task that took real digging\*\*/);
  assert.match(data.description, /do the same when the user\s+corrects how something is done here/);
  assert.match(content, /\*\*When the user corrects how something is done here\*\*/);
});

test("the session-start directive mentions learnings only in a repo that keeps them", async () => {
  const { formatOrientation } = await import("../src/claude/format.js");
  assert.doesNotMatch(formatOrientation("# map", 100), /learning/);
  const some = formatOrientation("# map", 100, undefined, 3, true);
  assert.match(some, /This repo has 3 learnings from past sessions/);
  assert.match(some, /📝 Started from Priya's learning · saved ~90k tokens and ~12 min, or · 3x faster to a PR when that's what it prints/, "the closing line, by example");
  assert.match(some, /save a learning for the next session/);
  assert.match(some, /commit it with the change/);
  const none = formatOrientation("# map", 100, undefined, 0, true);
  assert.doesNotMatch(none, /This repo has/);
  assert.match(none, /save a learning for the next session/, "a repo set up for learnings is told to leave one from the first session");
});

test("hooks speak trail only in a repo wired for it, on a machine with trail installed", async () => {
  const { adoptRepoBrand } = await import("../src/brand.js");
  const bin = mkdtempSync(join(tmpdir(), "notes-bin-"));
  writeFileSync(join(bin, process.platform === "win32" ? "trail.cmd" : "trail"), "");
  const withTrail = tmpRepo("brand-repo");
  mkdirSync(join(withTrail, ".claude", "helpers"), { recursive: true });
  writeFileSync(join(withTrail, ".claude", "helpers", "trail-hooks.cjs"), "");
  const plain = tmpRepo("brand-plain");
  assert.equal(adoptRepoBrand(withTrail, { PATH: bin }), "trail");
  assert.equal(adoptRepoBrand(withTrail, { PATH: "" }), "graft", "trail not installed: don't suggest it");
  assert.equal(adoptRepoBrand(plain, { PATH: bin }), "graft");
  assert.equal(adoptRepoBrand(plain, { PATH: bin, TRAIL_INVOKED_AS: "trail" }), "trail", "a name already set is kept");
});

test("Cursor's and Codex's hooks speak trail in a repo whose only trail wiring is theirs", async () => {
  const { adoptRepoBrand } = await import("../src/brand.js");
  const { hostsWiredForTrail } = await import("../src/hosts/registry.js");
  const bin = mkdtempSync(join(tmpdir(), "notes-bin-"));
  writeFileSync(join(bin, process.platform === "win32" ? "trail.cmd" : "trail"), "");
  const cursorOnly = tmpRepo("brand-cursor");
  mkdirSync(join(cursorOnly, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(cursorOnly, ".cursor", "rules", "trail.mdc"), "");
  assert.equal(adoptRepoBrand(cursorOnly, { PATH: bin }, hostsWiredForTrail), "trail");
  assert.equal(adoptRepoBrand(cursorOnly, { PATH: bin }), "graft", "without the hosts check, only .claude counts");
  assert.equal(adoptRepoBrand(tmpRepo("brand-none"), { PATH: bin }, hostsWiredForTrail), "graft");
});

// --- wiring under trail's names ---

test("trail init moves a graft-wired repo to trail's names, and uninstall takes either set out", () => {
  const home = mkdtempSync(join(tmpdir(), "notes-home-"));
  const d = repoWithCode();
  const env = { GRAFT_MCP_NPX: "1" };
  Object.assign(process.env, env);
  try {
    assert.equal(run("graft", ["init", d, "--agents", "claude", "--yes", "--no-global"], home).status, 0);
    assert.ok(existsSync(join(d, ".claude", "helpers", "graft-hooks.cjs")));
    assert.ok(existsSync(join(d, ".claude", "skills", "graft", "SKILL.md")));

    const t = run("trail", ["init", d, "--agents", "claude", "--yes", "--no-global"], home);
    assert.equal(t.status, 0, t.err);
    // Shared: the hook in .trail/ and one SessionStart entry. The old layout is gone.
    for (const f of [".trail/hook.cjs", ".trail/statusline.cjs"]) assert.ok(existsSync(join(d, f)), f);
    for (const f of ["helpers", "skills/graft", "skills/trail"]) assert.equal(existsSync(join(d, ".claude", f)), false, f);
    const settings = JSON.parse(readFileSync(join(d, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(Object.keys(settings.hooks), ["SessionStart"]);
    assert.match(JSON.stringify(settings.hooks.SessionStart), /\/\.trail\/hook\.cjs\\" session-start/);
    for (const k of ["statusLine", "permissions", "footerLinksRegexes"]) assert.equal(settings[k], undefined, k);
    // Personal: status line, allowlist, and under --no-global every other hook, never session start.
    const local = JSON.parse(readFileSync(join(d, ".claude", "settings.local.json"), "utf8"));
    assert.match(local.statusLine.command, /\.trail\/statusline\.cjs/);
    assert.ok(local.permissions.allow.includes("Bash(trail:*)"));
    assert.equal(local.hooks.SessionStart, undefined);
    assert.match(JSON.stringify(local.hooks.UserPromptSubmit), /\.trail\/hook\.cjs\\" prompt/);
    assert.match(JSON.stringify(local.hooks.SessionEnd), /\.trail\/hook\.cjs\\" session-end/);
    // No MCP server for Claude Code: graft's .mcp.json had only graft's, so it goes.
    assert.equal(existsSync(join(d, ".mcp.json")), false);
    // Nothing personal shows in git, and .gitignore is untouched by the setup.
    assert.match(readFileSync(join(d, ".trail", ".gitignore"), "utf8"), /^statusline\.cjs$/m);
    for (const f of [".claude/settings.local.json", ".trail/statusline.cjs"]) assert.equal(spawnSync("git", ["check-ignore", "-q", f], { cwd: d }).status, 0, f);

    // Running it again changes nothing.
    const before = [".claude/settings.json", ".claude/settings.local.json"].map((f) => readFileSync(join(d, f), "utf8"));
    const again = run("trail", ["init", d, "--agents", "claude", "--yes", "--no-global"], home);
    assert.equal(again.status, 0, again.err);
    assert.deepEqual([".claude/settings.json", ".claude/settings.local.json"].map((f) => readFileSync(join(d, f), "utf8")), before);

    const un = run("trail", ["uninstall", d, "-y", "--no-global"], home);
    assert.equal(un.status, 0, un.err);
    for (const f of [".trail/hook.cjs", ".trail/statusline.cjs"]) assert.equal(existsSync(join(d, f)), false, f);
    // Both held only what init wrote, so they go with it.
    for (const f of ["settings.json", "settings.local.json"]) assert.equal(existsSync(join(d, ".claude", f)), false, f);
  } finally {
    delete process.env.GRAFT_MCP_NPX;
  }
});
