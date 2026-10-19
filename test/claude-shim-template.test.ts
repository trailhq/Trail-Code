import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// The MCP launch command is resolved from PATH at init time; pin it to the npx
// form so init below never probes the machine's own install.
process.env.GRAFT_MCP_NPX = '1';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { statuslineShim, hooksShim, installHintPath, rememberInstall } from '../src/claude/shim-template.js';
import { claudeDistDir } from '../src/claude/paths.js';
import { runInit } from '../src/claude/init.js';
import { installCursorHooks } from '../src/hosts/cursor-hooks.js';
import { tmpRepo } from './helpers.js';

for (const [name, src] of [['statusline', statuslineShim()], ['hooks', hooksShim()]] as const) {
  test(`${name} shim parses and knows all five candidates (remembered, node_modules, lib, PATH, npm root -g)`, () => {
    const body = src.replace(/^#!.*\n/, ''); // strip shebang for vm
    assert.doesNotThrow(() => new vm.Script(body), 'valid JS');

    // 1. the remembered install, read from the trail home at run time
    assert.match(src, /process\.env\.TRAIL_HOME/);
    assert.match(src, /path\.join\(os\.homedir\(\), '\.trail'\)/);
    assert.match(src, /"install\.json"/);
    // only when it is ours and no one else can write it: it names code we import
    assert.match(src, /st\.uid !== process\.getuid\(\)/);
    assert.match(src, /st\.mode & 0o022/);
    // 2. repo node_modules via require.resolve from the project dir
    // under both names: a teammate with only @trailhq/trail-code installed still gets hooks
    assert.match(src, /const PKGS = \['@trailhq\/trail-code', '@nanonets\/graft', '@trailhq\/trail'\];/);
    assert.match(src, /require\.resolve\(name \+ '\/package\.json', \{ paths: \[base\] \}\)/);
    assert.match(src, /fromPkg\(dir\)/);
    // 3. legacy execPath/../lib guess retained
    assert.match(src, /path\.join\(path\.dirname\(process\.execPath\), '\.\.', 'lib'\)/);
    // 4. the trail/graft command on PATH, followed back to its package
    assert.match(src, /const BINS = process\.platform === 'win32' \? \['trail\.cmd', 'graft\.cmd'\] : \['trail', 'graft'\];/);
    assert.match(src, /pkgAbove\(fs\.realpathSync\(p\)\)/);
    assert.match(src, /\.\.\.onPath\(\)/);
    // 5. npm root -g catch-all, queried on demand (no on-disk cache)
    assert.match(src, /execFileSync\('npm', \['root', '-g'\]/);
    assert.doesNotMatch(src, /tmpdir/); // no predictable temp cache path

    // Highest version wins among the candidates, not first-hit — otherwise the
    // remembered path pins the user to whatever graft wired the repo, forever.
    // Behaviour is exercised for real in claude-shim-resolve.test.ts.
    assert.match(src, /function best\(dirs, name\)/);
    assert.match(src, /'package\.json'/); // versionOf reads each candidate's version

    // Windows-safe dynamic import + best-effort catch
    assert.match(src, /const target = entry\(/);
    assert.match(src, /pathToFileURL\(target\)/);
    assert.match(src, /\.catch\(\(\) => \{/);
  });
}

test('statusline calls main(); hooks passes the event arg', () => {
  assert.match(statuslineShim(), /m\.main\(\)/);
  assert.match(hooksShim(), /m\.main\(process\.argv\[2\]\)/);
});

// The shims are committed (`trail init` says to commit .claude/), so every byte
// of them is published to the repo. They used to carry the absolute dist/claude
// of whoever ran init — `/Users/<name>/.nvm/versions/node/<v>/…` in the repo for
// every teammate to read.
test('a shim names nothing about the machine that wrote it', () => {
  for (const src of [statuslineShim(), hooksShim()]) {
    assert.ok(!src.includes(claudeDistDir()), 'no install path');
    assert.ok(!src.includes(homedir()), 'no home dir');
    assert.ok(!src.includes(process.cwd()), 'no working dir');
    // Any absolute path at all (`'/package.json'` is a package subpath, one segment).
    assert.doesNotMatch(src, /["'](\/[^"'/]+\/|[A-Za-z]:\\)/, 'no absolute path literal');
  }
});

test('the shims init commits are the same bytes on every machine', () => {
  const repo = tmpRepo('shim-committed');
  const home = tmpRepo('shim-committed-home');
  runInit(repo, { build: false, home, global: false, brand: 'trail' });
  installCursorHooks(repo);
  const written = {
    statusline: readFileSync(join(repo, '.trail', 'statusline.cjs'), 'utf8'),
    hooks: readFileSync(join(repo, '.trail', 'hook.cjs'), 'utf8'),
    cursor: readFileSync(join(repo, '.cursor', 'hooks', 'graft-hooks.cjs'), 'utf8'),
  };
  assert.equal(written.statusline, statuslineShim());
  assert.equal(written.hooks, hooksShim());
  assert.equal(written.cursor, hooksShim());
  for (const src of Object.values(written)) {
    for (const p of [claudeDistDir(), home, repo]) assert.ok(!src.includes(p), `names ${p}`);
  }
});

/** A built dist/claude: the dir init runs from once installed. */
function builtDist(root: string): string {
  const dist = join(root, 'pkg', 'dist', 'claude');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'hooks.js'), '');
  return dist;
}

test('rememberInstall keeps the install path in the trail home, outside the repo', () => {
  const root = tmpRepo('remember-trail-home');
  const dist = builtDist(root);
  const trailHome = join(root, 'trail-home');
  rememberInstall(join(root, 'home'), { TRAIL_HOME: trailHome }, dist);
  const file = join(trailHome, 'install.json');
  assert.equal(installHintPath(join(root, 'home'), { TRAIL_HOME: trailHome }), file);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { claudeDist: dist });
});

test('rememberInstall writes ~/.trail when TRAIL_HOME is unset', () => {
  const root = tmpRepo('remember-home');
  const dist = builtDist(root);
  const home = join(root, 'home');
  rememberInstall(home, {}, dist);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.trail', 'install.json'), 'utf8')), { claudeDist: dist });
});

test('rememberInstall skips a dist with nothing a shim could load (running from source)', () => {
  const root = tmpRepo('remember-source');
  const home = join(root, 'home');
  rememberInstall(home, {}, join(root, 'src', 'claude'));
  assert.equal(existsSync(join(home, '.trail', 'install.json')), false);
});
