import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND_ENV, inBrand } from '../src/brand.js';
import { formatOrientation } from '../src/claude/format.js';

// An INDEX.md written by graft before the rename, still on disk: query-path
// refreshes never rewrite it. The concept list carries the repo's own words.
const GRAFT_ERA_INDEX = [
  '# graft — repo map',
  '',
  'Small markdown nodes summarising this repo. `grep` any term, symbol, or',
  'filename here, or run `graft ask "<task>"`. Each node carries prose plus exact',
  '`file:line`; open a source file only to edit the named span.',
  '',
  'The same graph is queryable as MCP tools (`graft_find_code`, `graft_find_all`,',
  '`graft_trace_calls`, `graft_file_api`, `graft_repo_map`) where a host exposes them, and',
  'as the `graft` CLI everywhere else. Edges — who calls what — live only in the',
  'graph, not in these files: `graft callers <symbol>` is the only way to read them.',
  '',
  '## Concepts',
  '',
  '- [graft](graft.md) — how the orchard app models a graft · src/graft.ts',
  '',
].join('\n');

const repoMap = (out: string) => out.slice(out.indexOf('repo map ('));

test('under trail, a graft-era INDEX.md preamble is injected in trail spelling', () => {
  const saved = process.env[BRAND_ENV];
  process.env[BRAND_ENV] = 'trail';
  try {
    const map = repoMap(formatOrientation(GRAFT_ERA_INDEX, 4000));
    assert.match(map, /# trail — repo map/);
    assert.match(map, /run `trail ask "<task>"`/);
    assert.match(map, /`trail_find_code`, `trail_find_all`/);
    assert.match(map, /`trail callers <symbol>`/);
    assert.doesNotMatch(map, /`graft ask|graft_find_code|`graft callers|`graft` CLI/);
    assert.match(map, /- \[graft\]\(graft\.md\) — how the orchard app models a graft · src\/graft\.ts/, "the repo's own concept list is left alone");
  } finally {
    if (saved === undefined) delete process.env[BRAND_ENV];
    else process.env[BRAND_ENV] = saved;
  }
});

test('under trail, an INDEX.md a trail build wrote is injected unchanged', () => {
  const saved = process.env[BRAND_ENV];
  process.env[BRAND_ENV] = 'trail';
  try {
    const cut = GRAFT_ERA_INDEX.indexOf('\n## ');
    const trailBuilt = inBrand(GRAFT_ERA_INDEX.slice(0, cut)) + GRAFT_ERA_INDEX.slice(cut);
    assert.ok(formatOrientation(trailBuilt, 4000).endsWith(`repo map (graft/INDEX.md):\n${trailBuilt}`));
  } finally {
    if (saved === undefined) delete process.env[BRAND_ENV];
    else process.env[BRAND_ENV] = saved;
  }
});

test('under graft, INDEX.md is injected byte for byte', () => {
  const saved = process.env[BRAND_ENV];
  delete process.env[BRAND_ENV];
  try {
    assert.ok(formatOrientation(GRAFT_ERA_INDEX, 4000).endsWith(`repo map (graft/INDEX.md):\n${GRAFT_ERA_INDEX}`));
  } finally {
    if (saved !== undefined) process.env[BRAND_ENV] = saved;
  }
});
