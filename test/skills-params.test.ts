/**
 * Parameters in a skill's steps (design 4.5 step 10): the values that change
 * from one run to the next (a version, a commit, a PR, a port, a branch, a
 * date, and a token that differed from the last run of the same job) become
 * `{name}` with a default where one makes sense, so the next run fills them
 * instead of replaying last time's literal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STABLE_BRANCHES, fillParams, findParams, metaToParams, paramsToMeta, resolveParams } from "../src/skills/params.js";

const find = (cmds: string[], prompt = {}, extra: { prior?: string[] | null; check?: string } = {}) => findParams(cmds, { prompt, ...extra });

test("version: one name per value, the v kept, inside a .tgz too", () => {
  const r = find(['git tag v0.22.1 -m "release; notes" && git push origin v0.22.1', "npm publish trailhq-trail-code-0.22.1.tgz --access public"]);
  assert.deepEqual(r.cmds, ['git tag v{version} -m "release; notes" && git push origin v{version}', "npm publish trailhq-trail-code-{version}.tgz --access public"]);
  assert.deepEqual(r.params, [{ name: "version", shape: "version", seen: ["0.22.1"] }]);
  // A pre-release version stops before .tgz.
  assert.equal(find(["npm publish acme-cli-1.4.2-beta.1.tgz"]).cmds[0], "npm publish acme-cli-{version}.tgz");
});

test("version: the one the person typed is {version}, other values {version_2}", () => {
  const r = find(["npm version 1.4.2 && npm publish", "npm view acme-cli@1.4.1 version"], { version: "1.4.2" });
  assert.deepEqual(r.cmds, ["npm version {version} && npm publish", "npm view acme-cli@{version_2} version"]);
  assert.deepEqual(r.params.map((p) => [p.name, p.seen]), [["version", ["1.4.2"]], ["version_2", ["1.4.1"]]]);
  // Without a typed one, the first value seen is {version}.
  assert.deepEqual(find(["npm view acme-cli@1.4.1 version"], { version: "2.0.0" }).cmds, ["npm view acme-cli@{version} version"]);
});

test("version: not an install pin, nvm, node@ / python@ / go@, or an address", () => {
  for (const cmd of [
    "npm i -g acme-cli@1.4.2",
    "npm install acme@1.4.2 --save",
    "pnpm add left-pad@1.3.0",
    "yarn add left-pad@1.3.0",
    "nvm use 20.11.0",
    "npx node@20.11.0 --version",
    "uvx python@3.12.1 -V",
    "go run go@1.22.3",
    "curl -s http://10.1.2.3/status",
    "ping 10.0.0.1",
  ]) assert.deepEqual(find([cmd]).cmds, [cmd], cmd);
  // An install pin stays, a later publish of the same project's version is still a param.
  assert.deepEqual(find(["npm i acme@1.4.2 && npm publish acme-cli-2.0.1.tgz"]).cmds, ["npm i acme@1.4.2 && npm publish acme-cli-{version}.tgz"]);
});

test("sha: before :refs/, after commits/, in merge-base --is-ancestor, as a git argument; every occurrence the same name", () => {
  const r = find([
    "git push git@github.com:acme/storefront.git 4e1c9a2:refs/heads/beta",
    "git merge-base --is-ancestor origin/prod 4e1c9a2",
    "git push git@github.com:acme/storefront.git 4e1c9a2:refs/heads/prod",
  ], {}, { check: "gh api repos/acme/storefront/commits/4e1c9a2/statuses --jq '.[0].state'" });
  assert.deepEqual(r.cmds, [
    "git push git@github.com:acme/storefront.git {sha}:refs/heads/beta",
    "git merge-base --is-ancestor origin/prod {sha}",
    "git push git@github.com:acme/storefront.git {sha}:refs/heads/prod",
  ]);
  assert.equal(r.check, "gh api repos/acme/storefront/commits/{sha}/statuses --jq '.[0].state'");
  assert.deepEqual(r.params, [{ name: "sha", shape: "sha", default: "$(git rev-parse HEAD)", seen: ["4e1c9a2"] }]);
  assert.deepEqual(find(["git reset --hard 9f8e7d6c"]).cmds, ["git reset --hard {sha}"]);
  // Two commits can't both be HEAD: neither gets a default.
  assert.deepEqual(find(["git cherry-pick a1b2c3d e5f6a7b"]).params, [
    { name: "sha", shape: "sha", seen: ["a1b2c3d"] }, { name: "sha_2", shape: "sha", seen: ["e5f6a7b"] },
  ]);
  // Not a sha: all letters, all digits, or outside the places a commit goes.
  for (const cmd of ["git checkout deadbeef", "git show 1234567", "echo abc1234def"]) assert.deepEqual(find([cmd]).cmds, [cmd], cmd);
});

test("pr: gh pr verbs and pull links, no default", () => {
  const r = find(["gh pr checks 12", "gh pr merge #12 --squash", "open https://github.com/acme/shop/pull/12"]);
  assert.deepEqual(r.cmds, ["gh pr checks {pr}", "gh pr merge #{pr} --squash", "open https://github.com/acme/shop/pull/{pr}"]);
  assert.deepEqual(r.params, [{ name: "pr", shape: "pr", seen: ["12"] }]);
  assert.equal(find(["gh api repos/acme/shop/pulls/7/comments"]).cmds[0], "gh api repos/acme/shop/pulls/{pr}/comments");
  // A bare number elsewhere is not the PR.
  assert.equal(find(["gh pr view 12", "gh run list --limit 12"]).cmds[1], "gh run list --limit 12");
});

test("port: host:port, --port, PORT=, and the dev-server forms; default the seen value", () => {
  const r = find(["PORT=3000 npm run dev", "curl -sf localhost:3000/health", "npx next start -p 3000", "lsof -ti:3000"]);
  assert.deepEqual(r.cmds, ["PORT={port} npm run dev", "curl -sf localhost:{port}/health", "npx next start -p {port}", "lsof -ti:{port}"]);
  assert.deepEqual(r.params, [{ name: "port", shape: "port", default: "3000", seen: ["3000"] }]);
  assert.deepEqual(find(["pnpm dev --port 5173 --strictPort"]).cmds, ["pnpm dev --port {port} --strictPort"]);
  assert.deepEqual(find(["python3 -m http.server 8000"]).cmds, ["python3 -m http.server {port}"]);
});

test("branch: refs/heads, checkout -b, push -u; stable branches stay literal", () => {
  const r = find(["git checkout -b fix/retry-loop", "git push -u origin fix/retry-loop", "gh pr create --head fix/retry-loop --fill"]);
  assert.deepEqual(r.cmds, ["git checkout -b {branch}", "git push -u origin {branch}", "gh pr create --head {branch} --fill"]);
  assert.deepEqual(r.params, [{ name: "branch", shape: "branch", default: "fix/retry-loop", seen: ["fix/retry-loop"] }]);
  assert.deepEqual(find(["git push origin 4e1c9a2:refs/heads/feat-x"]).cmds, ["git push origin {sha}:refs/heads/{branch}"]);
  for (const b of ["main", "master", "beta", "prod", "production", "dev", "develop", "staging", "trunk"]) assert.ok(STABLE_BRANCHES.has(b), b);
  assert.deepEqual(find(["git push -u origin main", "git push origin HEAD:refs/heads/beta"]).cmds, ["git push -u origin main", "git push origin HEAD:refs/heads/beta"]);
});

test("date: default today", () => {
  const r = find(["node scripts/report.mjs --since 2026-10-01"]);
  assert.deepEqual(r.cmds, ["node scripts/report.mjs --since {date}"]);
  assert.deepEqual(r.params, [{ name: "date", shape: "date", default: "$(date +%F)", seen: ["2026-10-01"] }]);
});

test("varied: a path segment after internal/ is {pkg}, default this run's value", () => {
  const step = (pkg: string) => `(cd backend && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test -tags integration ./internal/${pkg}/...)`;
  const r = find([step("workflow")], {}, { prior: [step("quickbooks")] });
  assert.deepEqual(r.cmds, [step("{pkg}")]);
  assert.deepEqual(r.params, [{ name: "pkg", shape: "varied", default: "workflow", seen: ["workflow", "quickbooks"] }]);
  // No prior run: nothing varies.
  assert.deepEqual(find([step("workflow")]).cmds, [step("workflow")]);
});

test("varied: the flag before it names it; otherwise arg1, arg2; aligned by program and order", () => {
  const r = find(["npm run build", "node build.mjs --target web", "node scripts/seed.mjs alpha"], {}, {
    prior: ["npm ci", "npm run build", "node build.mjs --target cli", "node scripts/seed.mjs beta"],
  });
  assert.deepEqual(r.cmds, ["npm run build", "node build.mjs --target {target}", "node scripts/seed.mjs {arg1}"]);
  assert.deepEqual(r.params.map((p) => [p.name, p.default, p.seen]), [["target", "web", ["web", "cli"]], ["arg1", "alpha", ["alpha", "beta"]]]);
  // --flag=value keeps the flag in the text.
  assert.deepEqual(find(["node build.mjs --target=web"], {}, { prior: ["node build.mjs --target=cli"] }).cmds, ["node build.mjs --target={target}"]);
});

test("varied: three differing tokens, a different length, or a shape already found: nothing", () => {
  assert.deepEqual(find(["node x.mjs a b c"], {}, { prior: ["node x.mjs d e f"] }).cmds, ["node x.mjs a b c"]);
  assert.deepEqual(find(["node x.mjs a"], {}, { prior: ["node x.mjs a b"] }).cmds, ["node x.mjs a"]);
  const r = find(["npm publish acme-cli-1.4.2.tgz"], {}, { prior: ["npm publish acme-cli-1.4.1.tgz"] });
  assert.deepEqual(r.cmds, ["npm publish acme-cli-{version}.tgz"]);
  assert.deepEqual(r.params.map((p) => p.name), ["version"]);
});

test("fillParams fills what it knows and leaves the rest", () => {
  assert.equal(fillParams("git push origin {sha}:refs/heads/{branch} # {other}", { sha: "4e1c9a2", branch: "fix/x" }), "git push origin 4e1c9a2:refs/heads/fix/x # {other}");
  assert.equal(fillParams("jq '{name: .a}'", { name: "x" }), "jq '{name: .a}'");
});

test("resolveParams: from the ask, then the default, then last seen, with notes", () => {
  const defs = [
    { name: "version", shape: "version" as const, seen: ["0.22.1"] },
    { name: "sha", shape: "sha" as const, default: "$(git rev-parse HEAD)", seen: ["4e1c9a2"] },
    { name: "pkg", shape: "varied" as const, default: "workflow", seen: ["workflow", "quickbooks"] },
    { name: "pr", shape: "pr" as const, seen: [] },
  ];
  assert.deepEqual(resolveParams(defs, { version: "1.4.2" }), {
    values: { version: "1.4.2", sha: "$(git rev-parse HEAD)", pkg: "workflow" },
    notes: ["{version} is 1.4.2, from the ask.", "{pkg} is workflow, as last time; change it if the ask names another."],
  });
  assert.deepEqual(resolveParams(defs, { sha: "9f8e7d6", pr: "12" }), {
    values: { version: "0.22.1", sha: "9f8e7d6", pkg: "workflow", pr: "12" },
    notes: ["{version} is 0.22.1, as last time; change it if the ask names another.", "{sha} is 9f8e7d6, from the ask.", "{pkg} is workflow, as last time; change it if the ask names another.", "{pr} is 12, from the ask."],
  });
});

test("params in metadata and back", () => {
  const defs = [
    { name: "version", shape: "version" as const, seen: ["0.22.1"] },
    { name: "sha", shape: "sha" as const, default: "$(git rev-parse HEAD)", seen: ["4e1c9a2"] },
    { name: "pkg", shape: "varied" as const, default: "workflow", seen: ["workflow"] },
    { name: "version_2", shape: "version" as const, seen: ["1.0.0"] },
    { name: "date", shape: "date" as const, default: "$(date +%F)", seen: [] },
  ];
  const meta = paramsToMeta(defs);
  assert.equal(meta, "version, sha=$(git rev-parse HEAD), pkg=workflow, version_2, date=$(date +%F)");
  assert.deepEqual(metaToParams(meta), [
    { name: "version", shape: "version", seen: [] },
    { name: "sha", shape: "sha", default: "$(git rev-parse HEAD)", seen: [] },
    { name: "pkg", shape: "varied", default: "workflow", seen: [] },
    { name: "version_2", shape: "version", seen: [] },
    { name: "date", shape: "date", default: "$(date +%F)", seen: [] },
  ]);
  assert.deepEqual(metaToParams(undefined), []);
  assert.deepEqual(metaToParams("  "), []);
  // A hand-edited name that isn't a parameter name is dropped.
  assert.deepEqual(metaToParams("ok, bad name=1, 9x").map((p) => p.name), ["ok"]);
});

test("g2 review: a commit, PR or version the run named once more is the same param wherever it stands", () => {
  const sha = "4e1c9a2b8f6e0d1c2b3a4f5e6d7c8b9a0f1e2d3c";
  for (const [cmd, want] of [
    ["git merge 4e1c9a2b", "git merge {sha}"], ["git rebase --onto main 4e1c9a2b", "git rebase --onto main {sha}"],
    ["git worktree add ../hotfix 4e1c9a2b", "git worktree add ../hotfix {sha}"], [`git branch hotfix ${sha}`, "git branch hotfix {sha}"],
    ["git -C backend cherry-pick 4e1c9a2b", "git -C backend cherry-pick {sha}"], [`curl -s https://ci.example.test/build?commit=${sha}`, "curl -s https://ci.example.test/build?commit={sha}"],
  ] as const) assert.equal(find([cmd]).cmds[0], want, cmd);
  for (const verb of ["checkout", "reopen", "comment", "review", "update-branch", "ready"]) assert.equal(find([`gh pr ${verb} 1234`]).cmds[0], `gh pr ${verb} {pr}`, verb);
  // The version a run published, installed again to try it, is the same {version}; a pin of another version stays.
  assert.deepEqual(find(["npm publish trailhq-trail-code-0.22.1.tgz", "npm install -g @trailhq/trail-code@0.22.1"]).cmds,
    ["npm publish trailhq-trail-code-{version}.tgz", "npm install -g @trailhq/trail-code@{version}"]);
  assert.deepEqual(find(["npm i acme@1.4.2 && npm publish acme-cli-2.0.1.tgz"]).cmds, ["npm i acme@1.4.2 && npm publish acme-cli-{version}.tgz"]);
});

test("g2 review: a varied word keeps the shell around it out of the param; a different flag is not a param", () => {
  const step = (f: string) => `(cd backend && gofmt -l internal/${f})`;
  const r = find([step("platformmcp/brain.go")], {}, { prior: [step("workflow/run.go")] });
  assert.deepEqual(r.cmds, ["(cd backend && gofmt -l internal/{pkg}.go)"]);
  assert.deepEqual(r.params.map((p) => [p.name, p.default]), [["pkg", "platformmcp/brain"]]);
  assert.deepEqual(find(["gofmt -l internal/x.go"], {}, { prior: ["gofmt -w internal/x.go"] }).cmds, ["gofmt -l internal/x.go"]);
});
