/**
 * graft users moving to trail: once the trail command is on this machine, a
 * repo wired as graft moves to trail the next time a session opens in it, and
 * a teammate who only has graft still gets a working MCP server in a repo
 * that's on trail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { formatWiringRefresh, readStamp, reconcileWiring, runningVersion, writeStamp } from '../src/upkeep.js';
import { runUpkeep, shouldMoveToTrail } from '../src/upkeep-run.js';
import { fitTrailServerToMachine } from '../src/hosts/claude-global.js';
import { BRAND_ENV, repoWiredForTrail } from '../src/brand.js';
import { runInit } from '../src/claude/init.js';
import { tmpRepo } from './helpers.js';

process.env.GRAFT_MCP_NPX = '1';
process.env.TRAIL_NO_FETCH = '1';
delete process.env.GRAFT_NO_TRAIL_SWITCH;

/** A folder holding a `trail` executable, for PATH. */
function binWith(name: string): string {
  const bin = mkdtempSync(join(tmpdir(), `bin-${name}-`));
  writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, name), 0o755);
  return bin;
}

test('the refresh moves a repo when asked to, even when graft itself has not changed version', () => {
  const calls: boolean[] = [];
  const deps = { wired: () => ['claude'], rewrite: (_r: string, _h: string[], _o: unknown, toTrail: boolean) => void calls.push(toTrail) };
  const repo = tmpRepo('move-reconcile');
  reconcileWiring(repo, '1.0.0', deps);
  assert.equal(reconcileWiring(repo, '1.0.0', deps), null, 'same version, no move: nothing to do');
  const moved = reconcileWiring(repo, '1.0.0', { ...deps, toTrail: () => true });
  assert.equal(moved?.switched, true);
  assert.deepEqual(calls, [false, true]);
  assert.match(formatWiringRefresh(moved)!, /graft is now trail, and this repo just moved to it/);
});

test('a graft repo moves to trail once the trail command is installed, and only once', () => {
  const repo = tmpRepo('move-e2e');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const home = mkdtempSync(join(tmpdir(), 'move-home-'));
  const saved = { path: process.env.PATH, home: process.env.HOME, trailHome: process.env.TRAIL_HOME, brand: process.env[BRAND_ENV] };
  process.env.HOME = home;
  process.env.TRAIL_HOME = join(home, '.trail');
  const savedProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    delete process.env[BRAND_ENV];
    runInit(repo, { build: false, global: false });
    assert.ok(existsSync(join(repo, '.claude', 'skills', 'graft', 'SKILL.md')), 'wired as graft');
    // Model a recorded init that included machine-wide wiring.
    writeStamp(repo, runningVersion(), ['claude'], { global: true });
    assert.equal(shouldMoveToTrail(repo), false, 'no trail command yet');
    assert.equal(shouldMoveToTrail(repo, { ...process.env, PATH: binWith('trail'), GRAFT_NO_TRAIL_SWITCH: '1' }), false, 'a machine can opt out');

    process.env.PATH = `${binWith('trail')}${delimiter}${saved.path}`;
    const first = runUpkeep(repo, runningVersion(), { background: false, home });
    assert.match(first.lines.join('\n'), /graft is now trail, and this repo just moved to it/);
    assert.ok(repoWiredForTrail(repo));
    assert.ok(existsSync(join(repo, '.trail', 'hook.cjs')), "trail's shared hook");
    assert.ok(existsSync(join(home, '.claude', 'skills', 'trail', 'SKILL.md')), 'the skill is the person’s own');
    assert.ok(!existsSync(join(repo, '.claude', 'skills')), 'no skill in the repo, under either name');
    assert.ok(existsSync(join(repo, '.trail')), 'the repo has its .trail/');
    assert.deepEqual(readStamp(repo)?.hosts, ['claude'], 'the same hosts as before');

    const second = runUpkeep(repo, runningVersion(), { background: false, home });
    assert.doesNotMatch(second.lines.join('\n'), /just moved/, 'already on trail');
  } finally {
    process.env.PATH = saved.path;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    for (const [k, v] of [['HOME', saved.home], ['TRAIL_HOME', saved.trailHome], [BRAND_ENV, saved.brand]] as const)
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('a teammate with only graft gets a working trail server in a trail repo, until they install trail', () => {
  const home = mkdtempSync(join(tmpdir(), 'fit-home-'));
  const file = join(home, '.claude.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { graft: { command: 'graft', args: ['mcp'] } } }, null, 2));
  const read = () => JSON.parse(readFileSync(file, 'utf8'));

  assert.equal(fitTrailServerToMachine(home, '/w/app', { trail: false, graft: true }).action, 'updated');
  const here = read().projects['/w/app'];
  assert.deepEqual(here.mcpServers.trail, { command: 'graft', args: ['mcp'] }, 'the same name, run by graft');
  assert.deepEqual(here.disabledMcpServers, ['graft'], 'and graft not listed twice');
  assert.equal(fitTrailServerToMachine(home, '/w/app', { trail: false, graft: true }).action, 'unchanged');

  assert.equal(fitTrailServerToMachine(home, '/w/app', { trail: true, graft: true }).action, 'updated');
  assert.equal(read().projects['/w/app'].mcpServers.trail, undefined, 'trail installed: the committed server runs');
  assert.equal(fitTrailServerToMachine(home, '/w/none', { trail: false, graft: false }).action, 'unchanged', 'nothing to run it with');
});

test('moving to trail never reads past sessions in the background: there is no hidden command left to do it', { skip: process.platform === 'win32' ? 'shebang stand-in' : false }, () => {
  const repo = tmpRepo('move-no-past-read');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const home = mkdtempSync(join(tmpdir(), 'move-no-past-read-home-'));
  const projects = join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projects, { recursive: true });
  for (const [id, at] of [['a1', '2026-10-01T10:00:00Z'], ['b2', '2026-10-03T10:00:00Z']])
    writeFileSync(join(projects, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: repo, timestamp: at, message: { role: 'user', content: 'always run the linter before pushing' } }) + '\n');
  const bin = mkdtempSync(join(tmpdir(), 'move-no-past-read-bin-'));
  const asked = join(bin, 'asked');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\n[ "$1" = "--version" ] && { echo 9.9.9; exit 0; }\ntouch "${asked}"\necho '{"is_error":false,"structured_output":{"findings":[]}}'\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'src', 'bin', 'trail.ts'), '_trail-past-read', repo], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, '.trail'), PATH: `${bin}${delimiter}${process.env.PATH}`, DO_NOT_TRACK: '1', TRAIL_NO_FETCH: '1', CLAUDECODE: undefined },
  });
  assert.notEqual(r.status, 0, 'not a command any more');
  assert.ok(!existsSync(asked), 'Claude Code was never asked');
});
