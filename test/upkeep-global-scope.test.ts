import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStamp, writeStamp } from '../src/upkeep.js';
import { runUpkeep } from '../src/upkeep-run.js';

test('upkeep in a checkout without an init record keeps machine-wide Claude settings intact', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'trail-upkeep-scope-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const home = join(fixture, 'home');
  const repo = join(fixture, 'repo');
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ['HOME', 'USERPROFILE', 'TRAIL_HOME', 'GRAFT_NO_TRAIL_SWITCH', 'TRAIL_INVOKED_AS']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, '.trail'), GRAFT_NO_TRAIL_SWITCH: '1', TRAIL_INVOKED_AS: 'graft',
  });

  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(repo, '.claude', 'helpers'), { recursive: true });
  const settings = join(home, '.claude', 'settings.json');
  const original = '{"alwaysThinkingEnabled":true}\n';
  writeFileSync(settings, original);
  const shim = join(repo, '.claude', 'helpers', 'graft-hooks.cjs');
  writeFileSync(shim, '// old project shim\n');

  runUpkeep(repo, '1.2.3', { background: false, home });
  assert.equal(readFileSync(settings, 'utf8'), original);
  assert.notEqual(readFileSync(shim, 'utf8'), '// old project shim\n');
  assert.equal(readStamp(repo)?.opts?.global, false);
  assert.ok(existsSync(join(repo, '.claude', 'settings.json')));

  writeStamp(repo, '1.2.3', ['claude'], { global: true });
  runUpkeep(repo, '1.2.4', { background: false, home });
  assert.notEqual(readFileSync(settings, 'utf8'), original, 'an explicit global installation still refreshes');
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).alwaysThinkingEnabled, true);
});
