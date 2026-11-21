import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/claude/hooks.js';
import { tmpRepo } from './helpers.js';

test('an installed Cursor session gets map orientation in the Cursor response envelope', async (t) => {
  const repo = tmpRepo('cursor-session-start');
  const home = tmpRepo('cursor-session-home');
  mkdirSync(join(repo, 'graft'), { recursive: true });
  writeFileSync(join(repo, 'graft', 'INDEX.md'), '# Cursor fixture map\n');
  const vars = {
    HOME: home,
    USERPROFILE: home,
    TRAIL_HOME: join(home, '.trail'),
    TRAIL_INVOKED_AS: 'graft',
    GRAFT_DIR: 'graft',
    GRAFT_TEST_STDIN: JSON.stringify({ cwd: repo, session_id: 'cursor-session', composer_mode: 'agent' }),
    DO_NOT_TRACK: '1',
  };
  const saved = Object.entries(vars).map(([key, value]) => {
    const old = process.env[key];
    process.env[key] = value;
    return [key, old] as const;
  });
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  const chunks: string[] = [];
  t.mock.method(process.stdout, 'write', (chunk: string) => { chunks.push(chunk); return true; });
  try {
    await main('cursor-session-start');
  } finally {
    t.mock.restoreAll();
    if (projectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = projectDir;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(chunks.length, 1);
  const response = JSON.parse(chunks[0]);
  assert.deepEqual(Object.keys(response), ['additional_context']);
  assert.match(response.additional_context, /Cursor fixture map/);
  assert.ok(!existsSync(join(home, '.claude')));
});
