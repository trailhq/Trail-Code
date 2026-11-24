/**
 * Compile: from a run sheet to a SKILL.md (design 4.5). Deterministic and
 * model-free: every step is a command that ran and worked, cleaned the same
 * way every time (output filters, trailing echoes, leading sleeps and macOS
 * `timeout` gone; folders named; home paths as $HOME; polls folded into one
 * wait; values that change become {params}), and any step Trail can't keep
 * safely refuses the whole skill, with the reason in plain words.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_COMMAND_NAMES, BUILT_IN_NAMES, NAME_RE, compileRun, draftText, proposeName, refusalWords, type CompileOpts, type CompileResult } from "../src/skills/compile.js";
import { renderSkillMd } from "../src/skills/skillmd.js";
import { skillProblems } from "../src/skills/validate.js";
import { callKind } from "../src/trace/checks.js";
import { redactSecrets } from "../src/trace/redact.js";
import { isMultiLine } from "../src/trace/shell.js";
import type { CheckHit, JobClass, RunCall, RunSheet } from "../src/trace/types.js";
import type { CompiledSkill } from "../src/skills/types.js";

const HOME = "/home/dev";
const ROOT = "/home/dev/src/storefront";
const KEY = "github.com/acme/storefront";

let seq = 0;
/** A Bash call as the fold would store it (4.1): redacted, kind from the command, multiLine, truncated. */
function call(raw: string, o: Partial<RunCall> & { job?: JobClass | null } = {}): RunCall {
  seq++;
  const { job = null, ...rest } = o;
  const red = redactSecrets(raw);
  const at = new Date(Date.UTC(2026, 9, 27, 10, 31, 40) + seq * 20_000).toISOString();
  return {
    id: `toolu_${String(seq).padStart(3, "0")}`, at, cmd: red.cmd, ...(red.secret ? { secret: red.secret } : {}),
    key: KEY, cwd: "", bg: false, failed: false, isError: false,
    ...(raw.length > 2000 ? { truncated: true } : {}), ...(isMultiLine(raw) ? { multiLine: true } : {}),
    kind: callKind(raw, job), src: { use: seq * 1000, result: seq * 1000 + 400 },
    ...rest,
  };
}
const passed = (family: CheckHit["family"], facts: CheckHit["facts"] = {}): CheckHit => ({ family, passed: true, facts });

function sheet(calls: RunCall[], o: Partial<RunSheet> = {}): RunSheet {
  return {
    v: 1, id: "r-1027-3f9a", session: "e76b4ca7f1a0", repoKey: KEY, branch: "beta", host: "claude", tier: "A", epoch: 1,
    startedAt: "2026-10-27T10:31:40Z", endedAt: "2026-10-27T10:44:05Z", job: null, jobWords: [], sharedWords: [], promptParams: {},
    calls, checkIndex: null, checked: false, end: "done",
    counts: { commands: calls.length, failed: calls.filter((c) => c.failed).length, toolCalls: calls.length + 2, edits: 0 },
    helpers: [], skillId: null, ...o,
  };
}
const OPTS: CompileOpts = { repoRoot: ROOT, home: HOME, platform: "darwin", moment: "asked", applies: KEY, taken: () => false };
const compile = (s: RunSheet, o: Partial<CompileOpts> = {}) => compileRun(s, { ...OPTS, ...o });
function ok(r: CompileResult): CompiledSkill {
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  return r.skill;
}
const steps = (r: CompileResult) => ok(r).steps.map((s) => s.cmd);
function refused(r: CompileResult, reason: string): string {
  assert.equal(r.ok, false, "should refuse");
  if (r.ok) return "";
  assert.equal(r.reason, reason, r.detail);
  return r.detail;
}

// ---------------------------------------------------------------- the 4.5 examples table, row by row

test("4.5: an output filter and its 2>&1 go; a sha becomes {sha}", () => {
  assert.deepEqual(steps(compile(sheet([call("git push origin 4e1c9a2:refs/heads/beta 2>&1 | tail -5")]))), ["git push origin {sha}:refs/heads/beta"]);
});

test("4.5: a step in a sub-folder names it; env prefixes stay; the home path is $HOME; a varied package is {pkg}", () => {
  const go = (pkg: string) => call(`cd backend && DOCKER_HOST=unix:///home/dev/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test -tags integration ./internal/${pkg}/... 2>&1 | tail -40`, { cwd: "backend", job: "tests", check: passed("tests") });
  const want = (pkg: string) => `(cd backend && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test -tags integration ./internal/${pkg}/...)`;
  const s = sheet([go("workflow")], { job: "tests", checkIndex: 0, checked: true });
  assert.deepEqual(steps(compile(s)), [want("workflow")]);
  const prior = sheet([go("quickbooks")], { id: "r-1020-0001", job: "tests", checkIndex: 0, checked: true });
  const c = ok(compile(s, { prior }));
  assert.deepEqual(c.steps.map((x) => x.cmd), [want("{pkg}")]);
  assert.deepEqual(c.params, [{ name: "pkg", shape: "varied", default: "workflow", seen: ["workflow", "quickbooks"] }]);
  assert.equal(c.checkIsStep, true);
  assert.equal(c.check, want("{pkg}"));
  assert.equal(c.meta.params, "pkg=workflow");
});

test("4.5: a bare cd is left out (plumbing); the next call's folder comes from its entry cwd", () => {
  const c = ok(compile(sheet([call("cd backend"), call("go test ./...", { cwd: "backend" })])));
  assert.deepEqual(c.steps.map((s) => s.cmd), ["(cd backend && go test ./...)"]);
  assert.equal(c.leftOut.plumbing, 1);
});

test("4.5: a heredoc that writes a file, or a commit, is work: left out and counted, never a multi-line refusal", () => {
  const c = ok(compile(sheet([
    call("cat > x.sh <<'EOF' 2>&1 | tail -3\necho a; echo b | wc\nEOF"),
    call("git commit -F - <<'EOF'\nfix: retry the upload\nEOF"),
    call("npm run build"),
  ])));
  assert.deepEqual(c.steps.map((s) => s.cmd), ["npm run build"]);
  assert.equal(c.leftOut.work, 2);
});

test("4.5: a background server keeps no & and says (in the background)", () => {
  for (const c of [call("npm run dev &"), call("npm run dev", { bg: true })]) {
    const s = ok(compile(sheet([{ ...c, bg: true }])));
    assert.deepEqual(s.steps.map((x) => [x.cmd, x.bg]), [["npm run dev", true]]);
    assert.match(renderSkillMd(s), /^1\. `npm run dev` \(in the background\)$/m);
  }
});

test("4.5: timeout goes on macOS only", () => {
  assert.deepEqual(steps(compile(sheet([call("timeout 300 npm test")]))), ["npm test"]);
  assert.deepEqual(steps(compile(sheet([call("timeout 300 npm test")]), { platform: "linux" })), ["timeout 300 npm test"]);
});

test("4.5: a leading sleep then a look is left out", () => {
  const c = ok(compile(sheet([call("sleep 30; gh run list --limit 1"), call("npm run build")])));
  assert.deepEqual(c.steps.map((s) => s.cmd), ["npm run build"]);
  assert.equal(c.leftOut.lookOnly, 1);
});

test("4.5: a ; inside quotes is one segment; the version is {version}", () => {
  assert.deepEqual(steps(compile(sheet([call('git tag v0.22.1 -m "release; notes" && git push origin v0.22.1')]))), ['git tag v{version} -m "release; notes" && git push origin v{version}']);
});

test("4.5: a publish through script is gated; keystrokes fed to its prompt refuse the skill (D101)", () => {
  const c = ok(compile(sheet([call("script -q /dev/null npm publish trailhq-trail-code-0.22.1.tgz --access public")])));
  assert.deepEqual(c.steps.map((s) => [s.cmd, s.gated]), [["script -q /dev/null npm publish trailhq-trail-code-{version}.tgz --access public", "publish"]]);
  assert.equal(c.meta["confirm-before"], c.steps[0]!.cmd);
  assert.match(refused(compile(sheet([call("(sleep 8; printf '\\n'; sleep 280) | script -q /dev/null npm publish trailhq-trail-code-0.22.1.tgz --access public")])), "answers-prompt"), /script -q \/dev\/null npm publish/);
});

test("4.5: a helper script run from a scratch folder is copied into the skill; a gated line in it gates the step", () => {
  // Off Windows, /tmp itself: the run's random temp folder name can read as a secret (see skills-risk-escapes).
  const dir = join(mkdtempSync(process.platform === "win32" ? join(tmpdir(), "g2-helper-") : "/tmp/g2-helper-"), "scratchpad");
  mkdirSync(dir, { recursive: true });
  const helper = join(dir, "npm-pty.mjs");
  const content = "#!/usr/bin/env node\n// npm publish behind a pty, so npm opens the browser itself\nimport { spawn } from 'node:child_process';\nspawn('npm', process.argv.slice(2), { stdio: 'inherit' });\n";
  writeFileSync(helper, content);
  try {
    const s = sheet([call(`node ${helper} publish`)], { job: "release", helpers: [helper] });
    const c = ok(compile(s));
    assert.equal(c.name, "release-npm");
    assert.deepEqual(c.steps.map((x) => [x.cmd, x.gated]), [["node $HOME/.trail/skills/release-npm/scripts/npm-pty.mjs publish", "publish"]]);
    assert.deepEqual(c.helpers, [{ file: "npm-pty.mjs", from: helper, content }]);
    // Gone by the time the skill is saved: refused, not saved with a dead path.
    rmSync(helper);
    assert.match(refused(compile(s), "helper-missing"), /npm-pty\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("4.5: an absolute path inside the repo becomes repo-relative", () => {
  assert.deepEqual(
    steps(compile(sheet([call("/home/dev/src/trail-code/scripts/release.sh 0.22.1")]), { repoRoot: "/home/dev/src/trail-code" })),
    ["./scripts/release.sh {version}"],
  );
});

test("4.5: a named secret runs from its variable; an unnamed one refuses", () => {
  const token = `npm_${"a1B2".repeat(9)}`;
  const c = ok(compile(sheet([call(`NPM_TOKEN=${token} npm publish`)])));
  assert.deepEqual(c.steps.map((s) => [s.cmd, s.gated]), [["NPM_TOKEN=${NPM_TOKEN:?set NPM_TOKEN} npm publish", "publish"]]);
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ4eXoifQ", "c2lnbmF0dXJlLXZhbHVlMTIz"].join(".");
  refused(compile(sheet([call(`curl -H "Authorization: Bearer ${jwt}" https://api.example.test/x`)])), "secret");
});

test("4.5: a step that reads a credential file is never saved", () => {
  const cmd = "TOKEN=$(python3 -c \"import json;print(json.load(open('$HOME/Library/Application Support/com.vercel.cli/auth.json'))['token'])\")";
  const r = compile(sheet([call("npm run build"), call(cmd, { kind: "step" })]));
  const detail = refused(r, "never-save");
  assert.match(refusalWords("never-save", detail), /^a step reads a credential file: `TOKEN=\$\(python3/);
});

test("4.5: a pr-green run saved on request is judgement", () => {
  const r = compile(sheet([call("gh pr checks 12"), call("git push origin fix/lint")], { job: "pr-green" }));
  assert.equal(refusalWords("judgement", refused(r, "judgement")), "getting checks green takes judgement each time, so Trail doesn't keep it as fixed steps");
  refused(compile(sheet([call("gh pr list")], { job: "sweep" })), "judgement");
});

// ---------------------------------------------------------------- one test per refusal

test("refusals: multi-line, truncated, outside-repo, step-too-long, scratch-path", () => {
  // A shell heredoc runs commands no one can read (an interpreter's is a look or work: see skills-compile-d58.test.ts).
  refused(compile(sheet([call("bash <<'EOF'\nmake dist\nEOF")])), "multi-line");
  // A long call from an old sheet, kept whole and marked (g3 now keeps its pieces, D58 c).
  refused(compile(sheet([call(`node -e "${"x".repeat(2100)}"`, { kind: "step" })])), "truncated");
  refused(compile(sheet([call("npm run build", { cwd: null })])), "outside-repo");
  assert.match(refused(compile(sheet([call(`node scripts/run.mjs ${"--flag ".repeat(50)}`)])), "step-too-long"), /node scripts\/run\.mjs/);
  assert.match(refused(compile(sheet([call("node build.mjs --out /tmp/x/out.json")])), "scratch-path"), /\/tmp\/x\/out\.json/);
  // A scratch script the run didn't record as a helper is a scratch path too.
  refused(compile(sheet([call("bash /private/tmp/x/scratchpad/go.sh")])), "scratch-path");
  // Windows' temp folder, with either slash and in any case, and a scratchpad under it.
  for (const p of ["C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x\\out.json", "c:/users/dev/appdata/local/temp/out.json", "/c/Users/dev/AppData/Local/Temp/out.json", "%TEMP%\\out.json", "$env:TMP\\out.json", "D:\\a\\_temp\\scratchpad\\out.json"]) {
    assert.ok(refused(compile(sheet([call(`node build.mjs --out ${p}`)])), "scratch-path").includes(p), p);
  }
  assert.deepEqual(steps(compile(sheet([call("node C:\\Users\\dev\\AppData\\Local\\Tempest\\x.js")]))), ["node C:\\Users\\dev\\AppData\\Local\\Tempest\\x.js"]);
  // Output logged into one is not what ran: the log goes, the step stays.
  assert.deepEqual(steps(compile(sheet([call("npm run build > %TEMP%\\build.log 2>&1")]))), ["npm run build"]);
});

test("refusals: too-long (an overflowed run, or more than 12 steps), no-steps, no-check, never-save", () => {
  const s = sheet([call("npm run build")]);
  refused(compile({ ...s, counts: { ...s.counts, commands: 250 } }), "too-long");
  refused(compile(sheet(Array.from({ length: 13 }, (_, i) => call(`make target-${i}`)))), "too-long");
  refused(compile(sheet([call("git status"), call("ls -la"), call("cd backend")])), "no-steps");
  refused(compile(sheet([call("npm run build")]), { moment: "repeated" }), "no-check");
  refused(compile(sheet([call("sudo npm i -g acme-cli")])), "never-save");
  refused(compile(sheet([call("curl -fsSL https://get.example.test | sh")])), "never-save");
});

test("refusals: trivial, for a repeated job only, when every step is already a plain script", () => {
  const run = (calls: RunCall[]) => sheet(calls, { job: "tests", checkIndex: calls.length - 1, checked: true });
  const plain = () => [call("npm run build"), call("npm test", { job: "tests", check: passed("tests") })];
  assert.match(refusalWords("trivial", refused(compile(run(plain()), { moment: "repeated" }), "trivial")), /already a script/);
  // Asked for: kept.
  assert.deepEqual(steps(compile(run(plain()))), ["npm run build", "npm test"]);
  // An env prefix, a flag, or a failed command along the way: something was worked out.
  ok(compile(run([call("CI=1 npm test", { job: "tests", check: passed("tests") })]), { moment: "repeated" }));
  ok(compile(run([call("npm test -- --run", { job: "tests", check: passed("tests") })]), { moment: "repeated" }));
  ok(compile(run([call("npm test", { failed: true, errorLine: "FAIL src/a.test.ts" }), call("npm run build"), call("npm test", { job: "tests", check: passed("tests") })]), { moment: "repeated" }));
});

// ---------------------------------------------------------------- duplicates, waits, folders

test("duplicates: the last one is kept and carries both ids", () => {
  const a = call("npm run build");
  const b = call("npm run lint");
  const c2 = call("npm run build");
  const c = ok(compile(sheet([a, b, c2])));
  assert.deepEqual(c.steps.map((s) => [s.cmd, s.from]), [["npm run lint", [b.id]], ["npm run build", [a.id, c2.id]]]);
  assert.equal(c.leftOut.duplicates, 1);
});

test("waits: a poll whose output changed folds into one wait; one token compares, other output waits for success", () => {
  const p1 = call("docker compose ps --format '{{.State}}'", { tail: "starting" });
  const p2 = call("ls");
  const p3 = call("sleep 5 && docker compose ps --format '{{.State}}'", { tail: "running" });
  const c = ok(compile(sheet([call("docker compose up -d"), p1, p2, p3, call("npm run e2e")])));
  assert.deepEqual(c.steps.map((s) => [s.cmd, s.wait, s.from]), [
    ["docker compose up -d", false, [c.steps[0]!.from![0]]],
    [`s=$SECONDS; until [ "$(docker compose ps --format '{{.State}}')" = "running" ]; do [ $((SECONDS-s)) -ge 300 ] && echo "not ready after 5 min" && break; sleep 10; done`, true, [p3.id]],
    ["npm run e2e", false, [c.steps[2]!.from![0]]],
  ]);
  assert.match(renderSkillMd(c), /^2\. `s=\$SECONDS; .*done` \(a wait: run it in the background if it may take over 2 minutes\)$/m);
  const q = ok(compile(sheet([
    call("curl -s localhost:3000/health", { tail: "{\"ok\":false,\"db\":\"down\"}" }),
    call("sleep 2; curl -s localhost:3000/health", { tail: "{\"ok\":true,\"db\":\"up\"}" }),
  ])));
  assert.deepEqual(q.steps.map((s) => s.cmd), ['s=$SECONDS; until curl -s localhost:{port}/health >/dev/null 2>&1; do [ $((SECONDS-s)) -ge 300 ] && echo "not ready after 5 min" && break; sleep 10; done']);
  // A step run twice with no sleep around it is a repeat, not a poll (a build's timings differ every run).
  const twice = ok(compile(sheet([call("npm run build", { tail: "built in 2.1s" }), call("npm run build", { tail: "built in 1.9s" })])));
  assert.deepEqual(twice.steps.map((s) => [s.cmd, s.wait]), [["npm run build", false]]);
  assert.equal(twice.leftOut.duplicates, 1);
});

test("waits: in a sub-folder the wait names it; a failed-then-passed run of the same step is a retry, not a wait; plain looks never wait", () => {
  const w = ok(compile(sheet([
    call("kubectl rollout status deploy/api", { cwd: "ops", tail: "Waiting for rollout", job: "ship" }),
    call("kubectl rollout status deploy/api", { cwd: "ops", tail: "deployment \"api\" successfully rolled out", job: "ship" }),
    call("make smoke", { cwd: "ops" }),
  ], { job: "ship" })));
  assert.equal(w.steps[0]!.cmd, 's=$SECONDS; until (cd ops && kubectl rollout status deploy/api) >/dev/null 2>&1; do [ $((SECONDS-s)) -ge 300 ] && echo "not ready after 5 min" && break; sleep 10; done');
  const retry = ok(compile(sheet([call("npm run build", { failed: true, errorLine: "error TS2304: Cannot find name 'x'." }), call("npm run build")])));
  assert.deepEqual(retry.steps.map((s) => [s.cmd, s.wait]), [["npm run build", false]]);
  assert.deepEqual(retry.ifFails, [], "a plain retry of the same command teaches nothing");
  assert.equal(retry.leftOut.failed, 1);
  const looks = ok(compile(sheet([call("git status", { tail: "clean" }), call("git status", { tail: "modified: a.ts" }), call("npm run build")])));
  assert.deepEqual(looks.steps.map((s) => s.cmd), ["npm run build"]);
});

test("waits: polls whose last one is the check fold into the check, the earlier ones left out", () => {
  const v1 = call("npm view acme-cli version", { tail: "1.4.1", job: "release" });
  const pub = call("npm publish acme-cli-1.4.2.tgz --access public", { job: "release" });
  const v2 = call("npm view acme-cli version", { tail: "1.4.1", job: "release" });
  const v3 = call("npm view acme-cli version", { tail: "1.4.2", job: "release", check: passed("npm-view", { version: "1.4.2", pkg: "acme-cli" }) });
  const c = ok(compile(sheet([v1, pub, v2, v3], { job: "release", branch: "main", checkIndex: 3, checked: true, promptParams: { version: "1.4.2" } }), { moment: "repeated" }));
  assert.deepEqual(c.steps.map((s) => [s.cmd, s.gated]), [["npm publish acme-cli-{version}.tgz --access public", "publish"]]);
  assert.equal(c.check, "npm view acme-cli version");
  assert.equal(c.checkShows, "{version}");
  assert.equal(c.checkIsStep, false);
  assert.equal(c.leftOut.lookOnly, 3);
  assert.equal(c.meta.ready, "git status --porcelain ; git rev-parse --abbrev-ref HEAD = main");
  assert.equal(c.name, "release-npm");
  assert.equal(c.title, "Release storefront to npm");
});

// ---------------------------------------------------------------- ready, check first, needs, If it fails

test("ready: git status and on-branch for ship and release on a stable branch; probes the run ran; at most 3", () => {
  const ship = (branch: string | null, job: JobClass | null = "ship") => ok(compile(sheet([call("git push origin beta")], { job, branch })));
  assert.equal(ship("beta").meta.ready, "git status --porcelain ; git rev-parse --abbrev-ref HEAD = beta");
  assert.equal(ship("fix/retry").meta.ready, "git status --porcelain");
  assert.equal(ship(null).meta.ready, "git status --porcelain");
  assert.equal(ship("main", "tests").meta.ready, undefined);
  const c = ok(compile(sheet([
    call("command -v colima"),
    call("test -S /home/dev/.colima/default/docker.sock"),
    call("git rev-parse --verify origin/prod"),
    call("git status --porcelain"),
    call("go test ./...", { job: "tests", check: passed("tests") }),
  ], { job: "tests", checkIndex: 4, checked: true })));
  assert.equal(c.meta.ready, "git status --porcelain ; command -v colima ; test -S $HOME/.colima/default/docker.sock");
  assert.deepEqual(c.steps.map((s) => s.cmd), ["go test ./..."]);
  assert.equal(c.meta.needs, "go");
});

test("check first: sign-in checks that ran ok go to the agent, not the steps; one that failed first gets an If it fails line", () => {
  const c = ok(compile(sheet([
    call("npm whoami", { failed: true, errorLine: "npm error code E401" }),
    call("npm whoami"),
    call("gh auth status"),
    call("docker info"),
    call("npm publish acme-cli-1.4.2.tgz --access public", { failed: true, errorLine: "npm error code EOTP" }),
    call("script -q /dev/null npm publish acme-cli-1.4.2.tgz --access public"),
  ], { job: "release", branch: "main" })));
  assert.equal(c.meta["check-first"], "npm whoami ; gh auth status");
  assert.deepEqual(c.steps.map((s) => s.n), [1]);
  assert.deepEqual(c.ifFails, [
    "`npm whoami` said you're not signed in: sign in first (the person may need to do this part).",
    "`npm publish` said \"npm error code EOTP\": what worked was step 1.",
  ]);
  assert.equal(c.meta.needs, "npm");
});

test("If it fails: at most 4 lines, values as {params}, no home path, no line for a plain retry", () => {
  const fails = Array.from({ length: 6 }, (_, i) => call(`git push https://example.test/acme/r${i}.git 4e1c9a2:refs/heads/beta`, { failed: true, errorLine: `fatal: unable to access /home/dev/src/storefront r${i} at 4e1c9a2` }));
  const c = ok(compile(sheet([...fails, call("git push git@github.com:acme/storefront.git 4e1c9a2:refs/heads/beta")])));
  assert.equal(c.ifFails.length, 4);
  assert.equal(c.ifFails[0], "`git push` said \"fatal: unable to access . r0 at {sha}\": what worked was step 1.");
  for (const line of c.ifFails) assert.doesNotMatch(line, /\/home\/dev|4e1c9a2/);
});

// ---------------------------------------------------------------- names and words

test("names per job, a taken name gets -<repo> then -2, and an agent's name is used when it is valid and free", () => {
  // A tests skill is named from what the person asked for (the job words of their asks), never the runner's name.
  const tests = (cmd: string, jobWords: string[] = ["tests"]) => ok(compile(sheet([call(cmd, { job: "tests", check: passed("tests") })], { job: "tests", jobWords, checkIndex: 0, checked: true })));
  assert.equal(tests("go test -tags integration ./...", ["integration", "tests"]).name, "integration-tests");
  assert.equal(tests("npx playwright test tests/e2e", ["e2e"]).name, "e2e-tests");
  assert.equal(tests("go test -tags integration ./...").name, "run-tests", "the person said only \"the tests\"");
  const go = tests("go test ./...");
  assert.equal(go.name, "run-tests");
  assert.equal(go.title, "Run storefront's tests");
  assert.equal(go.meta.asks, "run the tests");
  assert.equal(go.meta["status-asks"], "did the tests pass");
  assert.equal(go.description, "Runs storefront's tests, from the steps that worked on Oct 27. Use when asked to run the tests.");
  const py = tests("python3 -m pytest tests/ -q");
  assert.deepEqual([py.name, py.meta.asks], ["run-tests", "run the tests"]);
  assert.doesNotMatch(py.description, /pytest/, "never the program's name");
  const report = ok(compile(sheet([call("psql -h localhost -c 'select count(*) from users'", { job: "report", check: passed("query") })], { job: "report", jobWords: ["new", "users"], checkIndex: 0, checked: true })));
  assert.deepEqual([report.name, report.title, report.meta.asks, report.checkShows], ["new-users-report", "New users report for storefront", "any new users, new users, how many users", "rows come back"]);
  const local = ok(compile(sheet([call("npm run dev", { bg: true })], { job: "run-local" })));
  assert.deepEqual([local.name, local.title, local.dontUse], ["run-locally", "Run storefront locally", "Jobs other than this one."]);
  // With no job, a check that is a step names the skill, not whatever ran first (g2 review: a tests run titled "Run gofmt").
  const checked = ok(compile(sheet([call("gofmt -l ."), call("go test -tags integration ./internal/...", { check: passed("tests") })], { checkIndex: 1, checked: true })));
  assert.deepEqual([checked.name, checked.title], ["go-test", "Run go test in storefront"]);
  const none = ok(compile(sheet([call("go vet ./...")], { sharedWords: ["vet", "backend"] })));
  // D71 b: the run's own words are never asks; with no save request words, none.
  assert.deepEqual([none.name, none.title, none.meta.asks], ["go-vet", "Run go vet in storefront", ""]);
  const one = ok(compile(sheet([call("git push origin HEAD:refs/heads/prod")], { job: "ship" })));
  assert.deepEqual([one.name, one.title], ["ship-prod", "Ship storefront to prod"]);

  const taken = new Set(["run-tests"]);
  assert.equal(proposeName(sheet([], { job: "tests" }), go.steps, (n) => taken.has(n)), "run-tests-storefront");
  taken.add("run-tests-storefront");
  assert.equal(proposeName(sheet([], { job: "tests" }), go.steps, (n) => taken.has(n)), "run-tests-2");
  const named = (name: string) => ok(compile(sheet([call("go test ./...", { job: "tests", check: passed("tests") })], { job: "tests", checkIndex: 0, checked: true }), { name })).name;
  assert.equal(named("backend-checks"), "backend-checks");
  assert.equal(named("13"), "run-tests");
  assert.equal(named("trail"), "run-tests");
  assert.equal(named("Bad_Name"), "run-tests");
  assert.equal(named("ends-"), "run-tests");
  assert.equal(named("ship"), "run-tests", "Claude Code's own /ship");
});

test("a skill never takes Claude Code's own command names: a ship run with no branch is ship-<repo>, not ship", () => {
  for (const n of ["ship", "steward", "loop", "schedule", "simplify", "code-review", "security-review", "plan"]) assert.ok(AGENT_COMMAND_NAMES.has(n), n);
  assert.equal(proposeName(sheet([], { job: "ship" }), [], () => false), "ship-storefront");
  const taken = new Set(["ship-storefront"]);
  assert.equal(proposeName(sheet([], { job: "ship" }), [], (n) => taken.has(n)), "ship-2");
});

test("NAME_RE needs a letter, so the digits of trail skills keep 1 3 can never be a name", () => {
  for (const n of ["13", "1-3", "-ab", "a", "A-b", `a${"b".repeat(48)}`]) assert.equal(NAME_RE.test(n), false, n);
  for (const n of ["a1", "ship-beta", "2fa-login", `a${"b".repeat(47)}`]) assert.equal(NAME_RE.test(n), true, n);
  for (const n of ["trail", "graft", "skills", "keep", "add", "help", "manual"]) assert.ok(BUILT_IN_NAMES.has(n), n);
});

// ---------------------------------------------------------------- the ship run of design 2.1 and 2.4, end to end

function shipRun(): RunSheet {
  seq = 0;
  const ship = { job: "ship" as JobClass };
  const state = (tail: string, check?: CheckHit) => call("gh api repos/acme/storefront/commits/4e1c9a2/statuses --jq '.[0].state'", { ...ship, tail, ...(check ? { check } : {}) });
  const calls = [
    call("git status", ship),
    call("gh auth status", ship),
    call("git fetch origin", ship),
    call("git push origin 4e1c9a2:refs/heads/beta 2>&1 | tail -5", { ...ship, failed: true, isError: true, errorLine: "fatal: Authentication failed for 'https://github.com/acme/storefront.git/'" }),
    call("git push git@github.com:acme/storefront.git 4e1c9a2:refs/heads/beta", ship),
    state("pending"),
    state("success", passed("deploy", { sha: "4e1c9a2", state: "success" })),
    call("git log --oneline -3", ship),
    call("git merge-base --is-ancestor origin/prod 4e1c9a2 && echo ok", ship),
    call("git push https://github.com/acme/storefront.git 4e1c9a2:refs/heads/prod", { ...ship, failed: true, isError: true, errorLine: "remote: Permission to acme/storefront.git denied." }),
    call("git push git@github.com:acme/storefront.git 4e1c9a2:refs/heads/prod", ship),
    call("vercel ls", { ...ship, failed: true, isError: true, errorLine: "Error: this folder isn't linked to a project" }),
    call("cat notes.md", ship),
    call('echo "deploy log" > deploy.txt', ship),
    call("ls", ship),
    call("git status --porcelain", ship),
    state("success", passed("deploy", { sha: "4e1c9a2", state: "success" })),
  ];
  return sheet(calls, { job: "ship", jobWords: ["push", "beta", "ff", "prod"], checkIndex: 16, checked: true });
}

const SHIP_MD = `---
name: ship-beta-then-prod
description: "Ships storefront to beta, then fast-forwards prod, from the steps that worked on Oct 27. Use when asked to push to beta, ff to prod, fast-forward prod, promote to prod, deploy to prod, update prod or ship it."
metadata:
  trail: "s-4c91e0"
  scope: "personal"
  applies: "github.com/acme/storefront"
  job: "ship"
  asks: "push to beta, ff to prod, fast-forward prod, promote to prod, deploy to prod, update prod, ship it"
  status-asks: "is it live, is prod updated, did it deploy"
  params: "sha=$(git rev-parse HEAD)"
  needs: "git, gh"
  ready: "git status --porcelain ; git rev-parse --abbrev-ref HEAD = beta"
  check-first: "gh auth status"
  confirm-before: "git push git@github.com:acme/storefront.git {sha}:refs/heads/prod"
  check: "gh api repos/acme/storefront/commits/{sha}/statuses --jq '.[0].state'"
  check-shows: "success"
  version: "1"
---
# Ship storefront: beta, then prod

## Run
1. \`git fetch origin\`
2. \`git push git@github.com:acme/storefront.git {sha}:refs/heads/beta\`
3. \`s=$SECONDS; until [ "$(gh api repos/acme/storefront/commits/{sha}/statuses --jq '.[0].state')" = "success" ]; do [ $((SECONDS-s)) -ge 300 ] && echo "not ready after 5 min" && break; sleep 10; done\` (a wait: run it in the background if it may take over 2 minutes)
4. \`git merge-base --is-ancestor origin/prod {sha}\`
5. Can't be undone (Claude Code asks the person first): \`git push git@github.com:acme/storefront.git {sha}:refs/heads/prod\`

## Check it worked
\`gh api repos/acme/storefront/commits/{sha}/statuses --jq '.[0].state'\` shows \`success\`.

## If it fails
- \`git push\` said "fatal: Authentication failed for 'https://github.com/acme/storefront.git/'": what worked was step 2.
- \`git push\` said "remote: Permission to acme/storefront.git denied.": what worked was step 5.

## Don't use for
Pushes to other branches, or other repos.
`;

test("the ship run of design 2.4 compiles to the 2.1 skill (moment 2)", () => {
  const s = shipRun();
  const c = ok(compile(s, { moment: "repeated", id: "s-4c91e0" }));
  const text = renderSkillMd(c);
  assert.equal(text, SHIP_MD);
  assert.deepEqual(skillProblems(text, c.name), []);
  assert.deepEqual(c.steps.map((x) => x.from), [["toolu_003"], ["toolu_005"], ["toolu_007"], ["toolu_009"], ["toolu_011"]]);
  assert.deepEqual(c.leftOut, { failed: 3, lookOnly: 8, duplicates: 0, plumbing: 0, work: 1 });
  assert.deepEqual(c.source, { runId: "r-1027-3f9a", commands: 17, failed: 3, at: "2026-10-27T10:44:05Z" });
  assert.equal(c.checkIsStep, false);
  assert.deepEqual(c.params, [{ name: "sha", shape: "sha", default: "$(git rev-parse HEAD)", seen: ["4e1c9a2"] }]);
  // No literal sha anywhere in the file.
  assert.doesNotMatch(text, /4e1c9a2/);
});

test("compile is deterministic: the same sheet gives the same bytes, id included", () => {
  const a = ok(compile(shipRun(), { moment: "repeated" }));
  const b = ok(compile(shipRun(), { moment: "repeated" }));
  assert.equal(renderSkillMd(a), renderSkillMd(b));
  assert.match(a.meta.trail, /^s-[0-9a-f]{6}$/);
});

test("draftText: the show-me print", () => {
  const s = shipRun();
  const c = ok(compile(s, { moment: "repeated" }));
  assert.equal(draftText(c, s), [
    "ship-beta-then-prod · copied from the run that just worked (Oct 27, 10:31 to 10:44)",
    "  check first  gh auth status",
    "  ready        no uncommitted changes (git status --porcelain)",
    "  ready        on beta (git rev-parse --abbrev-ref HEAD)",
    "  1  git fetch origin",
    "  2  git push git@github.com:acme/storefront.git {sha}:refs/heads/beta",
    "  3  wait up to 5 min until gh api repos/acme/storefront/commits/{sha}/statuses --jq '.[0].state' shows success",
    "  4  git merge-base --is-ancestor origin/prod {sha}",
    "  ■  can't be undone: Claude Code asks you once, right before step 5",
    "  5  git push git@github.com:acme/storefront.git {sha}:refs/heads/prod",
    "  check  gh api repos/acme/storefront/commits/{sha}/statuses --jq '.[0].state' shows success",
    "  {sha}  from what you type, or git rev-parse HEAD; it was 4e1c9a2 this time",
    "  left out  12 commands: 3 that failed, 8 that only looked around, 1 that changed files",
    "  just for you, in this repo · nothing is shared or uploaded",
  ].join("\n"));
  const two = ok(compile(sheet([call("npm run build"), call("npm publish a-1.0.0.tgz"), call("npm publish b-1.0.0.tgz")], { job: "release", branch: "main" }), { applies: "every repo" }));
  const d = draftText(two, sheet([], { checked: false }));
  assert.match(d, /^release-npm · copied from the run that just ran \(Oct 27, 10:31 to 10:44\)$/m);
  assert.match(d, /^  ■  can't be undone: Claude Code asks you once, right before step 2 \(it covers 2 and 3\)$/m);
  assert.match(d, /^  check  none: no check ran in the run this came from$/m);
  assert.match(d, /^  just for you, in every repo · nothing is shared or uploaded$/m);
});

test("refusalWords: every reason in plain words, no em dashes", () => {
  const reasons = ["no-steps", "too-long", "step-too-long", "multi-line", "never-save", "secret", "scratch-path", "outside-repo", "truncated", "no-check", "trivial", "helper-missing", "judgement", "answers-prompt"] as const;
  for (const r of reasons) {
    const words = refusalWords(r, r === "judgement" ? "sweep" : "runs something: `x`");
    assert.ok(words.length > 10, r);
    assert.doesNotMatch(words, /—/, r);
  }
});
