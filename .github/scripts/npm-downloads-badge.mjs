// The README's downloads badge: npm downloads over the last month, summed across
// every name trail has shipped under. Prints a shields.io endpoint JSON to stdout.
//
// shields' own npm badge counts one package, and npm's bulk endpoint refuses scoped
// names, so the sum is made here, once a day, by npm-downloads-badge.yml. On a
// rename, add the new name and keep the old ones: their installs are still trail's.
const PACKAGES = ['@trailhq/trail-code', '@nanonets/graft'];

async function lastMonth(name) {
  const res = await fetch(`https://api.npmjs.org/downloads/point/last-month/${name}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.downloads !== 'number') {
    throw new Error(`${name}: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.downloads;
}

// The short form shields prints on its own npm badges: 7.7k, 94k, 1.2M.
function formatCount(n) {
  for (const [size, unit] of [[1e6, 'M'], [1e3, 'k']]) {
    if (n >= size) {
      const v = n / size;
      return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${unit}`;
    }
  }
  return String(n);
}

const counts = await Promise.all(PACKAGES.map(lastMonth));
PACKAGES.forEach((name, i) => console.error(`${name}: ${counts[i]}`));
const total = counts.reduce((a, b) => a + b, 0);
// npm's stats pipeline has days where every package reads zero. A zero month is
// that, not a real one, so fail and leave the last published badge up.
if (total === 0) throw new Error('npm reported zero downloads for every name');

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  label: 'downloads',
  message: `${formatCount(total)}/month`,
  color: 'brightgreen',
  cacheSeconds: 3600,
})}\n`);
