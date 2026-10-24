/**
 * D120 (2): the install record, `<trail home>/state/installed/<checkout hash>.json`:
 * the repo paths `trail init` wrote in one checkout, each with the sha256 of what
 * it wrote (null for a file it deleted). The clean-tree ready probe ignores a
 * dirty path only while it is in this record and still holds those bytes, so any
 * later edit blocks again.
 *
 * A path counts as init's when init changed it and it was clean in git just
 * before (or the last record already had it, unchanged since). A path the person
 * had dirty before init stays theirs, whatever init then wrote into it. Links,
 * FIFOs and files over 1 MB are never recorded or vouched for.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { trailPath, writePrivate } from '../util/private-fs.js';
import { openPlain, readPlain } from './plain-file.js';

const MAX_FILE = 1024 * 1024;
const MAX_PATHS = 200;
const REL = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w.@+-]+(?:\/[\w.@+-]+)*$/;
const SHA = /^[0-9a-f]{64}$/;

/** What a recorded path holds: a sha256, or null for "init deleted it". */
export type InstallFiles = Record<string, string | null>;

export interface InstallSnap {
  checkout: string;
  rels: string[];
  before: Map<string, string | null | false>;
  dirty: Set<string>;
  prior: InstallFiles | null;
}

function real(checkout: string): string {
  try {
    return realpathSync.native(checkout);
  } catch {
    return checkout;
  }
}

export function installRecordPath(checkout: string, env?: NodeJS.ProcessEnv): string {
  const key = createHash('sha256').update(real(checkout)).digest('hex').slice(0, 16);
  return trailPath(env, 'state', 'installed', `${key}.json`);
}

/** The sha256 of a plain file's bytes; null when nothing is there; false for a link, a FIFO, a folder or a big file. */
export function fileSha(path: string): string | null | false {
  try {
    if (!lstatSync(path).isFile()) return false;
  } catch {
    return null;
  }
  let fd = -1;
  try {
    fd = openPlain(path);
    const size = fstatSync(fd).size;
    if (size > MAX_FILE) return false;
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return createHash('sha256').update(buf.subarray(0, off)).digest('hex');
  } catch {
    return false;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** The record for this checkout, or null when there is none or it names another checkout. */
export function readInstallRecord(checkout: string, env?: NodeJS.ProcessEnv): InstallFiles | null {
  let raw: unknown;
  try {
    const text = readPlain(installRecordPath(checkout, env), MAX_FILE);
    if (text === null) return null;
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw as { v?: unknown; checkout?: unknown; files?: unknown };
  if (!r || r.v !== 1 || r.checkout !== real(checkout) || !r.files || typeof r.files !== 'object' || Array.isArray(r.files)) return null;
  const out: InstallFiles = {};
  for (const [rel, sha] of Object.entries(r.files as Record<string, unknown>).slice(0, MAX_PATHS)) {
    if (REL.test(rel) && (sha === null || (typeof sha === 'string' && SHA.test(sha)))) out[rel] = sha;
  }
  return out;
}

/** Whether `rel` is a path init recorded here that still holds what init left (absent, for one it deleted). */
export function initLeftIt(files: InstallFiles | null, checkout: string, rel: string): boolean {
  if (!files || !Object.hasOwn(files, rel) || !REL.test(rel)) return false;
  return fileSha(join(checkout, rel)) === files[rel];
}

/** The paths of `git status --porcelain -z` (a rename's both sides), for the paths asked about. */
function dirtyPaths(checkout: string, rels: string[], env: NodeJS.ProcessEnv): Set<string> | null {
  if (!rels.length) return new Set();
  const r = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...rels], {
    cwd: checkout, encoding: 'utf8', timeout: 10_000, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true,
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const out = new Set<string>();
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    out.add(p.slice(3));
    if (p[0] === 'R' || p[0] === 'C') out.add(parts[++i] ?? '');
  }
  return out;
}

/** Before init writes: what each path holds, which were dirty already, and the last record. */
export function snapInstall(checkout: string, rels: string[], env: NodeJS.ProcessEnv = process.env): InstallSnap {
  const list = [...new Set(rels.filter((r) => REL.test(r)))].slice(0, MAX_PATHS);
  const dirty = dirtyPaths(checkout, list, env);
  const before = new Map(list.map((rel) => [rel, fileSha(join(checkout, rel))] as const));
  // When git can't say, every path counts as dirty: nothing is vouched for that the probe couldn't check either.
  return { checkout, rels: list, before, dirty: dirty ?? new Set(list), prior: readInstallRecord(checkout, env) };
}

/** After init wrote: record the paths it made its own, and return them. */
export function recordInstall(snap: InstallSnap, env: NodeJS.ProcessEnv = process.env): string[] {
  const files: InstallFiles = {};
  for (const rel of snap.rels) {
    const before = snap.before.get(rel);
    const after = fileSha(join(snap.checkout, rel));
    if (before === false || after === false) continue;
    const vouched = !!snap.prior && Object.hasOwn(snap.prior, rel) && snap.prior[rel] === before;
    if (vouched || (before !== after && !snap.dirty.has(rel))) files[rel] = after ?? null;
  }
  // Nothing init wrote, and nothing there before: no record at all.
  const kept = Object.keys(files);
  if (!kept.length && !snap.prior) return kept;
  writePrivate(installRecordPath(snap.checkout, env), `${JSON.stringify({ v: 1, checkout: real(snap.checkout), files }, null, 2)}\n`);
  return kept;
}
