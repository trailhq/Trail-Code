/**
 * The shim's resolution behaviour, exercised by actually running it.
 *
 * This is the regression test for the "installed graft once, still on the old
 * version" report: the shim used to take the FIRST candidate that existed, and
 * the first candidate is the install path remembered at `graft init` time. So
 * `npm i -g @nanonets/graft@latest` upgraded a directory the shim never looked
 * at, and the user's hooks kept loading whatever version wired the repo. The
 * shim now takes the highest-versioned candidate instead.
 *
 * That path used to be baked into the shim itself, which is committed: it now
 * lives in the trail home, written by `rememberInstall`, and these tests write it
 * the same way so the writer and the shim can't disagree on where or how.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hooksShim, installHintPath, rememberInstall } from '../src/claude/shim-template.js';
import { tmpRepo } from './helpers.js';

/** A fake installed @nanonets/graft whose hooks entry records that it ran. */
function fakeInstall(root: string, name: string, version: string): string {
  const pkg = join(root, name);
  const distClaude = join(pkg, 'dist', 'claude');
  mkdirSync(distClaude, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@nanonets/graft', version }));
  // CJS on purpose: no "type" field, so `import()` hands back module.exports and
  // `m.main(...)` resolves — same shape the real dist has for the shim's call.
  writeFileSync(
    join(distClaude, 'hooks.js'),
    `module.exports.main = () => require('node:fs').writeFileSync(process.env.MARKER, ${JSON.stringify(version)});\n`,
  );
  return distClaude;
}

/**
 * Cuts the candidates this fixture does not control out of the child.
 *
 * The shim probes five places. The remembered dir and the project's
 * `node_modules` are ones a test builds; the rest find whatever
 * `@nanonets/graft` is installed on the machine running the suite:
 *
 *   - `<execDir>/../lib` is the nvm layout, so on any developer box with a
 *     global graft it resolves to the real package. That install is newer than
 *     the fixtures, so `best()` correctly preferred it, loaded the real
 *     `hooks.js` — which writes no marker — and every assertion here read back
 *     `null`. Green on CI, red on a laptop, for a reason that had nothing to do
 *     with the behaviour under test.
 *   - `npm root -g` is the same leak by another route, reached when the cheap
 *     candidates all miss.
 *   - PATH is a third route: the machine's own `trail`/`graft` command leads
 *     back to its package. Dirs holding one are dropped from the child's PATH,
 *     the rest kept, for the `cmd.exe` the next paragraph needs.
 *   - The trail home holds the install a real `trail init` remembered, so the
 *     child gets a fixture one.
 *
 * `process.execPath` is repointed through a `--require` preload rather than by
 * symlinking a real node: `/proc/self/exe` resolves symlinks on Linux, so the
 * filesystem trick would isolate macOS and quietly do nothing on the CI leg
 * that matters. `npm_config_prefix` is what `npm root -g` answers from, so
 * pointing it at an empty fixture dir leaves npm working and finding nothing —
 * safer than emptying `PATH`, which on Windows also hides the `cmd.exe` that
 * `shell: true` needs.
 *
 * Same intent as `homeEnv`: the child sees the fixture, never the runner.
 */
function isolate(root: string, extraPath: string[] = []): { preload: string; env: NodeJS.ProcessEnv } {
  const preload = join(root, 'no-ambient-graft.cjs');
  const execPath = join(root, 'node-prefix', 'bin', 'node');
  writeFileSync(preload, `Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(execPath)}, configurable: true });\n`);
  const prefix = join(root, 'npm-prefix');
  mkdirSync(prefix, { recursive: true });
  const ambient = (d: string) => ['trail', 'graft', 'trail.cmd', 'graft.cmd'].some((b) => existsSync(join(d, b)));
  const path = [...extraPath, ...(process.env.PATH ?? '').split(delimiter).filter((d) => d && !ambient(d))];
  return { preload, env: { npm_config_prefix: prefix, TRAIL_HOME: trailHomeOf(root), PATH: path.join(delimiter) } };
}

function trailHomeOf(root: string): string { return join(root, 'trail-home'); }

/**
 * Runs the shim in `projectDir`, after `rememberInstall` records `remembered`
 * (if given) as this machine's install, with `pathDirs` on PATH. Returns the
 * version of the install that actually got loaded (or null if none did).
 */
function runShim(root: string, projectDir: string, opts: { remembered?: string; pathDirs?: string[] } = {}): string | null {
  const shimPath = join(root, 'graft-hooks.cjs');
  const marker = join(root, 'loaded.txt');
  writeFileSync(shimPath, hooksShim());
  const { preload, env } = isolate(root, opts.pathDirs);
  if (opts.remembered) rememberInstall(join(root, 'home'), env, opts.remembered);
  const res = spawnSync(process.execPath, ['--require', preload, shimPath, 'session-start'], {
    encoding: 'utf8',
    env: { ...process.env, ...env, MARKER: marker, CLAUDE_PROJECT_DIR: projectDir },
  });
  assert.equal(res.status, 0, `shim exited ${res.status}: ${res.stderr}`);
  return existsSync(marker) ? readFileSync(marker, 'utf8') : null;
}

/** An empty project dir: no node_modules for the shim to find. */
function project(root: string): string {
  const p = join(root, 'project');
  mkdirSync(p, { recursive: true });
  return p;
}

test('an upgraded global install wins over the stale remembered one', () => {
  const root = tmpRepo('shim-upgrade');
  const stale = fakeInstall(root, 'old-node-install', '0.9.1');
  fakeInstall(join(root, 'project', 'node_modules', '@nanonets'), 'graft', '0.11.0');
  // The remembered install is the one `graft init` ran from — still on disk (an
  // nvm switch leaves it there), still first in the candidate list, now stale.
  assert.equal(runShim(root, join(root, 'project'), { remembered: stale }), '0.11.0');
});

test('the remembered install still wins when it is the newest', () => {
  const root = tmpRepo('shim-remembered-newest');
  const current = fakeInstall(root, 'current', '0.11.0');
  fakeInstall(join(root, 'project', 'node_modules', '@nanonets'), 'graft', '0.9.1');
  assert.equal(runShim(root, join(root, 'project'), { remembered: current }), '0.11.0');
});

test('a single candidate is used whatever its version', () => {
  const root = tmpRepo('shim-single');
  const only = fakeInstall(root, 'only', '0.9.1');
  assert.equal(runShim(root, project(root), { remembered: only }), '0.9.1');
});

test('an install with an unreadable version loses to a known one', () => {
  const root = tmpRepo('shim-noversion');
  const broken = fakeInstall(root, 'broken', '0.0.0');
  writeFileSync(join(root, 'broken', 'package.json'), 'not json');
  fakeInstall(join(root, 'project', 'node_modules', '@nanonets'), 'graft', '0.9.1');
  assert.equal(runShim(root, join(root, 'project'), { remembered: broken }), '0.9.1');
});

test('no candidate at all exits quietly — a hook must never fail the session', () => {
  const root = tmpRepo('shim-none');
  assert.equal(runShim(root, project(root), { remembered: join(root, 'nowhere') }), null);
});

// Guards the isolation itself. `isolate` repoints the exec dir at the fixture
// rather than disabling that probe, so the nvm-layout candidate must still be
// live — just rooted somewhere the test built. Without this, someone deleting
// the preload would see every assertion above still pass on CI (which has no
// global graft) and the laptop-only failure would come straight back.
test('the exec-dir probe reads the fixture prefix, not the machine install', () => {
  const root = tmpRepo('shim-execdir');
  fakeInstall(join(root, 'node-prefix', 'lib', 'node_modules', '@nanonets'), 'graft', '99.0.0');
  fakeInstall(join(root, 'project', 'node_modules', '@nanonets'), 'graft', '0.9.1');
  assert.equal(runShim(root, join(root, 'project')), '99.0.0');
});

// `npm install -g <folder>` — how ~/trail-demo installs this repo's build/trail —
// links the folder into a global node_modules and the bin into the prefix's bin.
// Here under a prefix that is not node's own (a custom `npm config set prefix`),
// so neither the exec-dir guess nor anything remembered can find it: only the
// command on PATH leads back to the folder. Both bin layouts that ship: trail's
// `dist/bin/trail.js`, and the `dist/cli.js` published @nanonets/graft links.
for (const [bin, target] of [['trail', 'dist/bin/trail.js'], ['graft', 'dist/cli.js']] as const) {
  test(`a local-folder install under a custom prefix is found through \`${bin}\` on PATH (${target})`, {
    skip: process.platform === 'win32' && 'npm links bins with .cmd wrappers on Windows; covered by the next test',
  }, () => {
    const root = tmpRepo(`shim-path-link-${bin}`);
    const folder = join(root, 'build', bin);
    fakeInstall(join(root, 'build'), bin, '0.21.1');
    mkdirSync(join(folder, dirname(target)), { recursive: true });
    writeFileSync(join(folder, target), '');
    const prefix = join(root, 'custom-prefix');
    const linked = join(prefix, 'lib', 'node_modules', bin === 'trail' ? '@trailhq' : '@nanonets', bin);
    mkdirSync(dirname(linked), { recursive: true });
    symlinkSync(folder, linked, 'dir');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    symlinkSync(join(linked, target), join(prefix, 'bin', bin));
    assert.equal(runShim(root, project(root), { pathDirs: [join(prefix, 'bin')] }), '0.21.1');
  });
}

// Windows npm puts `trail.cmd` in %APPDATA%\npm, beside the node_modules that
// holds the package. Both names are written so the layout reads on any OS.
test('a trail command beside the node_modules that holds it (the Windows npm layout)', () => {
  const root = tmpRepo('shim-path-cmd');
  const npmDir = join(root, 'npm');
  fakeInstall(join(npmDir, 'node_modules', '@trailhq'), 'trail', '0.21.1');
  for (const bin of ['trail', 'trail.cmd']) writeFileSync(join(npmDir, bin), '');
  assert.equal(runShim(root, project(root), { pathDirs: [npmDir] }), '0.21.1');
});

test('a remembered install others can write to is ignored', {
  skip: process.platform === 'win32' && 'no uid or mode bits to check on Windows',
}, () => {
  const root = tmpRepo('shim-remembered-writable');
  const only = fakeInstall(root, 'only', '0.9.1');
  const { env } = isolate(root);
  rememberInstall(join(root, 'home'), env, only);
  chmodSync(installHintPath(join(root, 'home'), env), 0o666);
  // Same fixture as 'a single candidate is used', except anyone could have
  // pointed the file at their own code.
  assert.equal(runShim(root, project(root)), null);
});

/** Runs the hooks shim for `event` with no install anywhere, as `name`; returns what it printed. */
function runBare(root: string, projectDir: string, event: string): string {
  const shimPath = join(root, 'trail-hooks.cjs');
  writeFileSync(shimPath, hooksShim());
  const { preload, env } = isolate(root);
  const res = spawnSync(process.execPath, ['--require', preload, shimPath, event], {
    encoding: 'utf8',
    env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: projectDir },
  });
  assert.equal(res.status, 0, `shim exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

/** A repo a teammate set trail up in, cloned by someone without trail: learnings, no install. */
function clonedWithLearnings(root: string, me: string, authors: string[]): string {
  const p = project(root);
  spawnSync('git', ['init', '-q'], { cwd: p });
  spawnSync('git', ['config', 'user.name', me], { cwd: p });
  mkdirSync(join(p, '.trail', 'learnings'), { recursive: true });
  authors.forEach((a, i) =>
    writeFileSync(
      join(p, '.trail', 'learnings', `2026-10-1${i}-retries-${a.toLowerCase()}.md`),
      `---\ntitle: "Retries decision ${i}"\nauthor: ${a}\ndate: 2026-10-1${i}\n---\n\n## Decided\n- Keep 4.\n`,
    ),
  );
  return p;
}

test('without trail anywhere, Claude credits a learning it used, and only then offers to set trail up', () => {
  const root = tmpRepo('shim-offer');
  const repo = clonedWithLearnings(root, 'Kumar S', ['Anirudh']);
  const out = JSON.parse(runBare(root, repo, 'session-start'));
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx: string = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /trail isn't installed on this machine/);
  assert.match(ctx, /- Retries decision 0 \(Anirudh\) · \.trail\/learnings\/2026-10-10-retries-anirudh\.md/);
  assert.match(ctx, /When one of them shapes your reply, end it with one line crediting it: whose learning, what it was about, and what it let you skip/);
  assert.match(ctx, /The first time you credit one in this session, and only then, add once, word for word: "Install trail to get this on every task, plus search and checks\. Want me to set it up\?"/);
  assert.match(ctx, /When no learning shapes your reply, say nothing about trail\./);
  assert.match(ctx, /Only if the user says yes, run "npm install -g @trailhq\/trail-code" and then "trail init --no-agents"/);
  assert.match(ctx, /never edit them/);
});

test('each learning is listed with its author, newest first, so the credit can name them', () => {
  const root = tmpRepo('shim-offer-names');
  const repo = clonedWithLearnings(root, 'Kumar', ['Anirudh', 'Priya', 'Sam']);
  const ctx: string = JSON.parse(runBare(root, repo, 'session-start')).hookSpecificOutput.additionalContext;
  const sam = ctx.indexOf('Retries decision 2 (Sam)');
  const anirudh = ctx.indexOf('Retries decision 0 (Anirudh)');
  assert.ok(sam >= 0 && anirudh > sam, ctx);
});

test('without trail, other events and a repo with no learnings stay silent', () => {
  const root = tmpRepo('shim-offer-quiet');
  const repo = clonedWithLearnings(root, 'Kumar', ['Anirudh']);
  assert.equal(runBare(root, repo, 'prompt'), '');
  assert.equal(runBare(root, repo, 'stop'), '');
  const empty = tmpRepo('shim-offer-empty');
  assert.equal(runBare(empty, project(empty), 'session-start'), '');
});
