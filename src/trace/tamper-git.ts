/**
 * Which folders a git command writes, for the tamper check (D59e): `git -C ~/.trail commit`, `--git-dir`,
 * a shell already sitting in Trail's home, a clone into it. Commands that only read (status, log, diff, the
 * list forms of branch, tag, remote, config and stash) write nothing. Pure: words in, folders out.
 */

/** git commands that only read the repository they run in (push and fetch leave its files as they are). */
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'describe', 'blame',
  'annotate', 'grep', 'shortlog', 'show-ref', 'for-each-ref', 'rev-list', 'merge-base', 'name-rev', 'whatchanged', 'version', 'help', 'var',
  'check-ignore', 'check-attr', 'count-objects', 'verify-commit', 'verify-tag', 'cherry', 'range-diff', 'diff-tree', 'diff-files', 'diff-index',
  'show-branch', 'fetch', 'push']);
/** git's own options that take the next word. */
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
const BRANCH_WRITE = /^(?:-[a-zA-Z]*[dDmMcCfu]|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|no-track|create-reflog))(?:=|$)/;
const BRANCH_LIST = /^(?:-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format)(?:=|$)/;
const CONFIG_READ = /^(?:-l|--(?:get|get-all|get-regexp|get-urlmatch|list|get-color|get-colorbool))$/;
const CONFIG_WRITE = /^(?:-e|--(?:unset|unset-all|add|replace-all|remove-section|rename-section|edit))$/;

/** Whether `git <sub> <args>` changes the repository it runs in; the list forms of branch, tag, remote, config and stash read. */
function gitSubWrites(sub: string, args: string[]): boolean {
  if (GIT_READS.has(sub)) return false;
  const pos = args.filter((a) => !a.startsWith('-'));
  const first = args[0] ?? '';
  switch (sub) {
    case 'branch': return args.some((a) => BRANCH_WRITE.test(a)) || (pos.length > 0 && !args.some((a) => BRANCH_LIST.test(a)));
    case 'tag': return !(args.length === 0 || args.includes('-l') || args.includes('--list')) || args.some((a) => /^(?:-[a-zA-Z]*d|--delete)$/.test(a));
    case 'remote': return !(args.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(first));
    case 'config':
      if (args.includes('--global') || args.includes('--system')) return false; // not this repository's files
      return args.some((a) => CONFIG_WRITE.test(a)) || (!args.some((a) => CONFIG_READ.test(a)) && pos.length >= 2);
    case 'stash': return !['list', 'show'].includes(first);
    case 'worktree': return first !== 'list';
    case 'reflog': case 'notes': case 'submodule': return !(args.length === 0 || first.startsWith('-') || ['show', 'list', 'status', 'summary'].includes(first));
    case 'archive': return args.some((a) => a === '-o' || a.startsWith('--output'));
    default: return true;
  }
}

/**
 * The folders a git command changes (D59e): the folder its `-C` chain names (or the shell's), its `--git-dir`
 * and `--work-tree`, and the folder a clone or init makes. Empty when the command only reads. `pathOf` turns a
 * word into an absolute path from a folder (null when only the shell could know it).
 */
export function gitWriteTargets(w: string[], folder: string | null, pathOf: (word: string, from: string | null) => string | null): Array<string | null> {
  let dir = folder;
  const dirs: Array<string | null> = [];
  let i = 1;
  for (; i < w.length; i++) {
    const a = w[i]!;
    if (!a.startsWith('-')) break;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const value = eq > 0 ? a.slice(eq + 1) : GIT_VALUE.has(a) ? w[++i] : undefined;
    if (value === undefined) continue;
    if (name === '-C') dir = pathOf(value, dir);
    else if (name === '--git-dir' || name === '--work-tree') dirs.push(pathOf(value, dir));
  }
  const sub = w[i];
  if (sub === undefined) return [];
  const args = w.slice(i + 1);
  if (!gitSubWrites(sub, args)) return [];
  dirs.push(dir);
  if (sub === 'clone' || sub === 'init') {
    const target = args.filter((a) => !a.startsWith('-'))[sub === 'clone' ? 1 : 0];
    if (target !== undefined) dirs.push(pathOf(target, dir));
  }
  return dirs;
}
