import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve, sep } from 'node:path';
import {
  formatVersionReport,
  formatUpgradeReport,
  resolvePackageJsonPath,
  readCurrentVersion,
  isRunningViaNpx,
  parseNpmError,
  clearNpmLeftover,
  noSudoFix,
} from '../src/cli-meta.js';

// --- formatVersionReport: pure formatting, injected npm-view results (no network) ---

test('formatVersionReport: up to date', () => {
  const out = formatVersionReport('0.4.4', { ok: true, version: '0.4.4' });
  assert.equal(out, 'graft 0.4.4\nlatest on npm: 0.4.4 ✓ up to date');
});

test('formatVersionReport: newer version available', () => {
  const out = formatVersionReport('0.4.4', { ok: true, version: '0.4.5' });
  assert.equal(out, 'graft 0.4.4\nlatest on npm: 0.4.5, run graft upgrade');
});

test('formatVersionReport: offline / unreachable', () => {
  const out = formatVersionReport('0.4.4', { ok: false });
  assert.equal(out, 'graft 0.4.4\nlatest: unreachable (offline?)');
});

// --- formatUpgradeReport: pure formatting, injected upgrade results (no network, no spawn) ---

test('formatUpgradeReport: npx no-op suggests a permanent install', () => {
  const out = formatUpgradeReport({ ran: false, ok: true, oldVersion: '0.4.4' });
  assert.match(out, /npx/);
  assert.match(out, /npm install -g @nanonets\/graft/);
});

test('formatUpgradeReport: successful upgrade shows old -> new', () => {
  const out = formatUpgradeReport({ ran: true, ok: true, oldVersion: '0.4.4', newVersion: '0.4.5' });
  assert.equal(out, 'graft 0.4.4 → 0.4.5');
});

test('formatUpgradeReport: failed install surfaces the error', () => {
  const out = formatUpgradeReport({ ran: true, ok: false, oldVersion: '0.4.4', errorMessage: 'ENOENT' });
  assert.match(out, /failed/);
  assert.match(out, /ENOENT/);
});

// --- resolvePackageJsonPath / readCurrentVersion: real filesystem, no network ---

test('resolvePackageJsonPath finds package.json one level above a dist/cli.js-shaped module path', () => {
  const fakeDistCli = pathToFileURL(resolve(process.cwd(), 'dist/cli.js')).href;
  const found = resolvePackageJsonPath(fakeDistCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('resolvePackageJsonPath finds package.json one level above a src/cli.ts-shaped module path', () => {
  const fakeSrcCli = pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href;
  const found = resolvePackageJsonPath(fakeSrcCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('readCurrentVersion reads the real package.json version', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const v = readCurrentVersion(pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href);
  assert.equal(v, pkg.version);
});

// --- isRunningViaNpx: pure path heuristic ---
//
// Built with `join` rather than a `/`-separated literal so the path carries the
// platform separator: `fileURLToPath` hands back `…\_npx\…` on Windows, where the
// original `includes("/_npx/")` was always false and `graft upgrade` would have run
// `npm install -g` on top of an npx invocation. On posix this is the identity case.

test('isRunningViaNpx detects an npx cache path', () => {
  const npxPath = pathToFileURL(
    join(sep, 'Users', 'x', '.npm', '_npx', 'abc123', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  assert.equal(isRunningViaNpx(npxPath), true);
});

test('isRunningViaNpx is false for a regular global install', () => {
  const globalPath = pathToFileURL(
    join(sep, 'usr', 'local', 'lib', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  assert.equal(isRunningViaNpx(globalPath), false);
});

// --- npm failures `upgrade` recovers from: parsed from npm's own error block ---

const ENOTEMPTY = `npm error code ENOTEMPTY
npm error syscall rename
npm error path /Users/a/.nvm/versions/node/v22.21.1/lib/node_modules/@trailhq/trail-code
npm error dest /Users/a/.nvm/versions/node/v22.21.1/lib/node_modules/@trailhq/.trail-code-HDYWMwwn
npm error errno -66`;

test('parseNpmError reads the code, path and rename dest, old `npm ERR!` lines too', () => {
  assert.deepEqual(parseNpmError(ENOTEMPTY), {
    code: 'ENOTEMPTY',
    path: '/Users/a/.nvm/versions/node/v22.21.1/lib/node_modules/@trailhq/trail-code',
    dest: '/Users/a/.nvm/versions/node/v22.21.1/lib/node_modules/@trailhq/.trail-code-HDYWMwwn',
  });
  // The indented `path: '…'` inside npm's stack dump is not the path line.
  const eacces = "npm ERR! code EACCES\nnpm ERR! path /usr/local/lib/node_modules/@trailhq/trail-code\nnpm ERR!   path: '/elsewhere'\n";
  assert.equal(parseNpmError(eacces)?.path, '/usr/local/lib/node_modules/@trailhq/trail-code');
  assert.equal(parseNpmError('npm warn deprecated something'), null);
});

test('clearNpmLeftover removes the moved-aside folder an interrupted install left, and nothing else', () => {
  const scope = mkdtempSync(join(tmpdir(), 'trail-npm-')) + sep + '@trailhq';
  const left = join(scope, '.trail-code-HDYWMwwn');
  mkdirSync(join(left, 'dist'), { recursive: true });
  const said = clearNpmLeftover({ code: 'ENOTEMPTY', path: join(scope, 'trail-code'), dest: left });
  assert.match(said ?? '', /left by an npm install that was stopped midway/);
  assert.equal(existsSync(left), false);
  // A dest that isn't npm's dot-named sibling of the package is left alone.
  const other = join(scope, 'elsewhere');
  mkdirSync(join(other, 'x'), { recursive: true });
  assert.equal(clearNpmLeftover({ code: 'ENOTEMPTY', path: join(scope, 'trail-code'), dest: other }), null);
  assert.equal(existsSync(other), true);
});

test('clearNpmLeftover removes a bin link into another copy of trail, never someone else\'s command', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'trail-bin-'));
  const build = join(dir, 'trail-demo', 'build', 'trail', 'dist', 'bin');
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'trail.js'), '');
  const ours = join(dir, 'trail');
  symlinkSync(join(build, 'trail.js'), ours);
  assert.match(clearNpmLeftover({ code: 'EEXIST', path: ours }) ?? '', /a link to another copy of trail/);
  assert.equal(existsSync(ours), false);

  const dangling = join(dir, 'graft');
  symlinkSync(join(dir, 'gone', 'cli.js'), dangling);
  assert.ok(clearNpmLeftover({ code: 'EEXIST', path: dangling }));

  const theirs = join(dir, 'trail-other');
  writeFileSync(join(dir, 'other-tool.js'), '');
  symlinkSync(join(dir, 'other-tool.js'), theirs);
  assert.equal(clearNpmLeftover({ code: 'EEXIST', path: theirs }), null);
  const file = join(dir, 'plain');
  writeFileSync(file, '');
  assert.equal(clearNpmLeftover({ code: 'EEXIST', path: file }), null);
  assert.ok(lstatSync(theirs).isSymbolicLink() && existsSync(file));
});

test('noSudoFix: a home-folder npm prefix, with the PATH line for the shell in use', () => {
  const zsh = noSudoFix('/usr/local/lib/node_modules/@trailhq/trail-code', ['@trailhq/trail-code'], '/bin/zsh', 'darwin');
  assert.match(zsh, /^npm needs sudo to write to \/usr\/local\/lib\/node_modules\/@trailhq\/trail-code\./);
  assert.match(zsh, /npm config set prefix ~\/\.npm-global/);
  assert.match(zsh, />> ~\/\.zshrc/);
  assert.match(zsh, /npm i -g @trailhq\/trail-code$/);
  assert.match(noSudoFix('/x', ['p'], '/bin/bash', 'darwin'), />> ~\/\.bash_profile/);
  assert.match(noSudoFix('/x', ['p'], '/bin/bash', 'linux'), />> ~\/\.bashrc/);
  assert.match(noSudoFix('/x', ['p'], '/usr/bin/fish', 'linux'), /fish_add_path ~\/\.npm-global\/bin/);
});

test('formatUpgradeReport: a recognised failure shows the plain fix, not npm\'s error block', () => {
  const out = formatUpgradeReport({ ran: true, ok: false, oldVersion: '0.4.4', fix: 'npm needs sudo to write to /x.', npmError: ENOTEMPTY });
  assert.equal(out, "✗ graft wasn't upgraded: npm needs sudo to write to /x.");
});

test('formatUpgradeReport: an unrecognised failure keeps npm\'s own error above the failed line', () => {
  const out = formatUpgradeReport({ ran: true, ok: false, oldVersion: '0.4.4', npmError: 'npm error code E404\n' });
  assert.equal(out, 'npm error code E404\n✗ npm install -g @nanonets/graft@latest failed');
});
