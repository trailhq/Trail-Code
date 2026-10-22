#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// The same code ships as @trailhq/trail and as @nanonets/graft, its old name;
// either one answers, and the newer wins.
const PKGS = ['@trailhq/trail', '@nanonets/graft'];
const BINS = process.platform === 'win32' ? ['trail.cmd', 'graft.cmd'] : ['trail', 'graft'];

// The dist/claude dir this machine's last init ran from, kept in the trail home
// rather than in this committed file. Only a file we own and no one else can
// write: it names code we import.
function remembered() {
  try {
    const home = process.env.TRAIL_HOME ? path.resolve(process.env.TRAIL_HOME) : path.join(os.homedir(), '.trail');
    const file = path.join(home, "install.json");
    const st = fs.statSync(file);
    if (process.getuid && (st.uid !== process.getuid() || (st.mode & 0o022))) return null;
    const d = JSON.parse(fs.readFileSync(file, 'utf8')).claudeDist;
    return typeof d === 'string' && path.isAbsolute(d) ? d : null;
  } catch { return null; }
}

// The dist/claude dir of each package resolved from a base whose node_modules is searched.
function fromPkg(base) {
  return PKGS.map((name) => {
    try {
      const pkg = require.resolve(name + '/package.json', { paths: [base] });
      return path.join(path.dirname(pkg), 'dist', 'claude');
    } catch { return null; }
  });
}

// The dist/claude dir of the package a file belongs to: the nearest package.json
// above it that names one of PKGS.
function pkgAbove(file) {
  for (let d = path.dirname(file), i = 0; i < 6; d = path.dirname(d), i++) {
    try {
      if (PKGS.includes(JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name)) return path.join(d, 'dist', 'claude');
    } catch { /* not this one */ }
  }
  return null;
}

// The package behind each trail/graft command on PATH: the bin is a link into
// the package (dist/cli.js in older releases, dist/bin/<name>.js now), and a
// Windows .cmd sits beside the node_modules that holds it.
function onPath() {
  const out = [];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    for (const bin of BINS) {
      const p = path.join(d, bin);
      if (!fs.existsSync(p)) continue;
      try { out.push(pkgAbove(fs.realpathSync(p))); } catch { /* dangling link */ }
      out.push(...fromPkg(d));
    }
  }
  return out;
}

// The global node_modules dir per npm (handles Homebrew/Windows/volta). Queried on demand.
function globalRoot() {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim();
    return root || null;
  } catch { return null; /* npm unavailable */ }
}

// The version of the package a dist/claude dir belongs to, or null if unreadable.
function versionOf(distClaude) {
  try {
    return JSON.parse(fs.readFileSync(path.join(distClaude, '..', '..', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

// Numeric-dotted compare of the release part; an unreadable version loses to any known one.
function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const p = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = p(a), pb = p(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// The highest-versioned dir in `dirs` that actually contains `name`, or null.
function best(dirs, name) {
  let bestDir = null, bestVer = null;
  for (const d of dirs) {
    if (!d || !fs.existsSync(path.join(d, name))) continue;
    const v = versionOf(d);
    if (bestDir === null || newer(v, bestVer)) { bestDir = d; bestVer = v; }
  }
  return bestDir;
}

function entry(name) {
  // Cheap candidates first, and only shell out to npm when every one of them misses.
  const cheap = [remembered(), ...fromPkg(dir), ...fromPkg(path.join(path.dirname(process.execPath), '..', 'lib')), ...onPath()];
  const hit = best(cheap, name);
  if (hit) return path.join(hit, name);
  const gr = globalRoot();
  const global = gr && best(PKGS.map((p) => path.join(gr, ...p.split('/'), 'dist', 'claude')), name);
  if (global) return path.join(global, name);
  return path.join(dir, 'dist', 'claude', name); // last-ditch; import will no-op if absent
}

import(pathToFileURL(entry("statusline.js")).href).then((m) => m.main()).catch(() => { /* graft unavailable — no-op */ });
