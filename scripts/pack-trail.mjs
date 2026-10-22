/**
 * Lays out the `@trailhq/trail-code` package from this repo's build, in build/trail/.
 *
 * trail and graft are one program under two names, published as two packages
 * from the same `dist/`:
 *
 *   @trailhq/trail-code  bin: trail  →  dist/bin/trail.js
 *   @nanonets/graft  bin: graft  →  dist/bin/graft.js   (this repo's package.json)
 *
 * Each package ships exactly one command, so installing both never clashes on
 * a bin name, and `graft upgrade` installs both. @nanonets/graft stays a full
 * package rather than a pointer: the hook shims committed in thousands of repos
 * resolve `@nanonets/graft/dist/claude/*` by path, and 78% of active installs
 * are on versions older than the one that knows about trail.
 *
 * Usage, after `npm run build` (and the telemetry key stamp, when publishing):
 *   node scripts/pack-trail.mjs
 *   npm publish build/trail --access public
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build', 'trail');

if (!existsSync(join(root, 'dist', 'bin', 'trail.js'))) {
  console.error('✗ dist/bin/trail.js not found — run `npm run build` first');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const trail = {
  ...pkg,
  name: '@trailhq/trail-code',
  description:
    "Your team's shared memory for coding agents: a code map on your machine, and the learnings, decisions and skills your whole team shares. Formerly graft.",
  keywords: [...new Set(['trail', ...(pkg.keywords ?? [])])],
  bin: { trail: 'dist/bin/trail.js' },
  // Built already; nothing to compile in the published tree.
  scripts: { postinstall: pkg.scripts.postinstall },
};
delete trail.devDependencies;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of pkg.files) {
  const from = join(root, f);
  if (existsSync(from)) cpSync(from, join(out, f), { recursive: true });
}
writeFileSync(join(out, 'package.json'), JSON.stringify(trail, null, 2) + '\n');
console.log(`✓ ${trail.name}@${trail.version} laid out in ${out}`);
console.log('  publish it with: npm publish build/trail --access public');
