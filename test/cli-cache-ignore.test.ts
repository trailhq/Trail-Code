import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { homeEnv, runCli, tmpRepo } from "./helpers.js";

test("build reports whether Git ignores the cache after a failed ignore write", () => {
  const root = tmpRepo("cli-cache-ignore");
  const env = {
    ...homeEnv(root),
    DO_NOT_TRACK: "1",
    GRAFT_NO_GITIGNORE: undefined,
    GIT_CONFIG_GLOBAL: join(root, "empty-git-config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const ignore = join(root, ".gitignore");

  try {
    execFileSync("git", ["init", "-q", "--template="], { cwd: root, env });
    writeFileSync(join(root, "app.js"), "export function hello() { return 1; }\n");
    mkdirSync(ignore); // Make the write fail even if tests run with elevated permissions.

    const unignored = runCli(["build", root, "--no-ignore"], { env, timeoutMs: 20_000 });
    assert.equal(unignored.status, 0, unignored.describe());
    assert.doesNotMatch(unignored.stdout, /is git-ignored/, unignored.describe());
    assert.match(unignored.stderr, /Git did not confirm that it is ignored/, unignored.describe());

    rmdirSync(ignore);
    const ignored = runCli(["build", root, "--no-ignore"], { env, timeoutMs: 20_000 });
    assert.equal(ignored.status, 0, ignored.describe());
    assert.match(ignored.stdout, /is git-ignored/, ignored.describe());
    execFileSync("git", ["check-ignore", "-q", "--", "graft/"], { cwd: root, env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
