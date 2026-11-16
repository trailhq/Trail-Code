/**
 * `trail note` turns away a team learning a teammate's Claude wouldn't act on
 * differently (no code named, setting trail up, status, no reason, a repeat),
 * says how to fix it, and saves it with `--anyway`. `--replaces` takes over
 * from an earlier learning without editing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateNote, symbolCandidates, type GateInput } from "../src/notes/note-gate.js";
import { listNotes, noteName, parseNote, type Note } from "../src/notes/notes.js";
import { liveLearnings } from "../src/notes/learning-fields.js";
import { homeEnv, tmpRepo } from "./helpers.js";

process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "gate-trail-home-"));

const GOOD = [
  "## Decided",
  "- Pin `init` and `analyze` to the same version in `.github/workflows/codeql.yml`. Mismatched, analyze fails with \"Loaded a configuration file for version X\".",
  "## Tried and ruled out",
  "- Letting Dependabot bump them one at a time: it broke main for two weeks.",
].join("\n");

const input = (over: Partial<GateInput> = {}): GateInput => ({
  title: "CodeQL init and analyze must share a version",
  body: GOOD,
  personal: false,
  files: [".github/workflows/codeql.yml"],
  namesSymbol: false,
  touches: [".github/workflows/codeql.yml"],
  ...over,
});

function existing(over: Partial<Note> = {}): Note {
  return { path: "/r/.trail/learnings/2026-10-15-codeql-priya.md", id: "l-0a0a0a", title: "CodeQL actions must be pinned together", author: "Priya", date: "2026-10-15", touches: [".github/workflows/codeql.yml"], body: GOOD, scope: "repo", ...over };
}

/** A literal string as a regex: every special character escaped, backslash included. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("a learning that names code, says why and isn't status passes", () => {
  assert.deepEqual(gateNote(input(), []), { problems: [], warnings: [] });
  assert.deepEqual(gateNote(input({ files: [], namesSymbol: true }), []).problems, [], "a symbol in the code counts as naming it");
});

test("each check says what to fix", () => {
  const none = gateNote(input({ files: [], body: "## Decided\n- Retries stay at 4 because the API rate-limits bursts." }), []).problems;
  assert.match(none[0]!, /^It names no file or function in this repo\. Name what it's about/);

  const setup = gateNote(input({ title: "Setting up trail in this repo", files: ["CLAUDE.md"], body: "## Decided\n- Ran trail init because the hooks were missing." }), []).problems;
  assert.match(setup[0]!, /^It reads as a note about setting trail up, not this repo's code/);

  const status = gateNote(input({ body: `${GOOD}\n## Watch out\n- PR #3372 is open and not merged yet.` }), []).problems;
  assert.match(status[0]!, /^"PR #3372 is open and not merged yet\." is status: true today, wrong next week/);

  const why = gateNote(input({ body: "## Decided\n- Pin the CodeQL actions together in `.github/workflows/codeql.yml`." }), []).problems;
  assert.match(why[0]!, /^No line says why\./);

  const twin = gateNote(input(), [existing()]).problems;
  assert.match(twin[0]!, /^It repeats \.trail\/learnings\/2026-10-15-codeql-priya\.md \("CodeQL actions must be pinned together", Priya, Oct 15\)\. If it updates that one, add --replaces 2026-10-15-codeql-priya\.md/);
  assert.deepEqual(gateNote(input({ replaces: "l-0a0a0a" }), [existing()]).problems, [], "unless it replaces that one, by id");
  assert.deepEqual(gateNote(input(), [existing({ touches: ["src/other.ts"], title: "Something else", body: "## Decided\n- Unrelated because reasons." })]).problems, [], "another learning on other files");
});

test("a personal learning is only checked for status and repeats; a long one only warned about", () => {
  assert.deepEqual(gateNote(input({ personal: true, files: [], title: "My editor runs gofmt on save", body: "Format on save is on." }), []).problems, []);
  assert.equal(gateNote(input({ personal: true, files: [], body: "Remember the demo today." }), []).problems.length, 1);
  const long = gateNote(input({ body: `${GOOD}\n${"word ".repeat(260)}` }), []);
  assert.deepEqual(long.problems, []);
  assert.match(long.warnings[0]!, /^long: \d+ words\. Long learnings get skimmed/);
});

test("symbol candidates: backticked first, then code-shaped words", () => {
  assert.deepEqual(symbolCandidates("Rotate in `NormalizeBox` and `Client.Send()`; default_retry_max and parseConfig() too, not `bbox.go`"), ["NormalizeBox", "Send", "default_retry_max", "parseConfig"]);
});

function run(args: string[], home: string, stdin: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    input: stdin,
    encoding: "utf8",
    // No Claude session of the person running the tests: in one, a second save adds to the first (session-learning.ts).
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_HOME: undefined, CLAUDE_CODE_SESSION_ID: undefined },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function repo(): string {
  const d = tmpRepo("gate-e2e");
  mkdirSync(join(d, "internal", "ocr"), { recursive: true });
  writeFileSync(join(d, "internal", "ocr", "bbox.go"), "package ocr\n\nfunc NormalizeBox(x float64, rotate int) float64 {\n\treturn x\n}\n");
  writeFileSync(join(d, "token.txt"), "not code, never committed\n");
  spawnSync("git", ["init", "-q"], { cwd: d });
  spawnSync("git", ["config", "user.name", "Priya Raman"], { cwd: d });
  spawnSync("git", ["config", "user.email", "p@example.com"], { cwd: d });
  spawnSync("git", ["add", "internal"], { cwd: d });
  spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: d });
  return d;
}

const BBOX = "## Decided\n- Rotate each box in `NormalizeBox` by its page's `/Rotate` before scaling, because rotated pages come back mirrored.\n";

test("trail note refuses with the fix, saves with --anyway, and takes over with --replaces", () => {
  const home = mkdtempSync(join(tmpdir(), "gate-home-"));
  const d = repo();
  const refused = run(["note", d, "--title", "Finished the bbox work"], home, "## Decided\n- Done, PR is open.\n");
  assert.equal(refused.status, 1);
  assert.match(refused.err, /^✗ not saved yet:\n {2}· It names no file or function in this repo/m);
  assert.match(refused.err, /is status: true today/);
  assert.match(refused.err, /^Fix it and run trail note again, or add --anyway if a check is wrong\.$/m);
  assert.throws(() => readdirSync(join(d, ".trail", "learnings")), "nothing written");

  const saved = run(["note", d, "--title", "Rotated PDFs need per-page rotation in NormalizeBox", "--touches", "internal/ocr/bbox.go,token.txt"], home, BBOX);
  assert.equal(saved.status, 0, saved.err);
  const [first] = readdirSync(join(d, ".trail", "learnings"));
  assert.deepEqual(parseNote(readFileSync(join(d, ".trail", "learnings", first!), "utf8"), "x")?.touches, ["internal/ocr/bbox.go"], "an untracked file lying around is never a touch");

  const twin = run(["note", d, "--title", "Rotated PDFs need per-page rotation", "--touches", "internal/ocr/bbox.go"], home, BBOX);
  assert.equal(twin.status, 1);
  assert.match(twin.err, new RegExp(`add --replaces ${escapeRe(first!)}`));

  const missing = run(["note", d, "--title", "x", "--replaces", "nope.md"], home, BBOX);
  assert.equal(missing.status, 1);
  assert.match(missing.err, /--replaces: no learning named nope\.md here/);

  const replacing = run(["note", d, "--title", "Rotated PDFs need per-page rotation, mirrored too", "--touches", "internal/ocr/bbox.go", "--replaces", first!], home, `${BBOX}- Mirror after rotating, otherwise 270° pages flip.\n`);
  assert.equal(replacing.status, 0, replacing.err);
  assert.match(replacing.out, new RegExp(`· takes over from ${escapeRe(first!)}, which stays as the record`));
  const files = readdirSync(join(d, ".trail", "learnings"));
  assert.equal(files.length, 2, "the old learning stays");
  const read = (f: string) => parseNote(readFileSync(join(d, ".trail", "learnings", f), "utf8"), f)!;
  const newer = files.find((f) => f !== first)!;
  assert.equal(read(newer).replaces, read(first!).id, "replaces: holds the old learning's id, not its file name");
  const listed = liveLearnings(listNotes(d, { branches: false })).map((n) => n.title);
  assert.deepEqual(listed, ["Rotated PDFs need per-page rotation, mirrored too"], "and the new one is read instead");

  const anyway = run(["note", d, "--title", "Sprint notes", "--anyway"], home, "Ship it today.\n");
  assert.equal(anyway.status, 0, anyway.err);
});

test("a learning's file name is right from a Windows path and a branch ref", () => {
  assert.equal(noteName({ path: "D:\\a\\repo\\.trail\\learnings\\2026-10-21-x.md" } as Note), "2026-10-21-x.md");
  assert.equal(noteName({ path: "origin/feat/y:.trail/learnings/2026-10-21-y.md" } as Note), "2026-10-21-y.md");
});
