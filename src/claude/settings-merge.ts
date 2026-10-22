import { isGraftEntry } from '../hosts/config-write.js';

type Json = Record<string, any>;

const slCmd = (name: 'graft' | 'trail' = 'graft') => `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/${name}-statusline.cjs"`;
/** trail's status line, from the shim in `.trail/` (see claude/init.ts). */
const TRAIL_SL_CMD = 'node "${CLAUDE_PROJECT_DIR:-.}/.trail/statusline.cjs"';
/** Stable marker for "this statusLine is Graft's", not the full command string —
 * an older shim path or a GRAFT_DIR wrapper still names this file. Either name. */
const STATUSLINE_HELPER = /(graft|trail)-statusline\.cjs|\.trail\/statusline\.cjs/;
const FOOTER = 'graft/[\\w./-]+\\.md';
// Every form graft is actually invoked as. 'graft:*' covers a global install;
// the other two cover a repo working on graft itself (or any consumer running it
// from a checkout), where the binary is not on PATH under that name. A retrieval
// call that raises a permission prompt loses to grep, which never does.
const ALLOW_ENTRIES = [
  'Bash(trail:*)',
  'Bash(graft:*)',
  'Bash(npx graft:*)',
  'Bash(graft-dev:*)',
  'Bash(node dist/cli.js:*)',
];

/** Where the repo-level install's shims sit, relative to whatever project is open. */
const REPO_HELPERS = '${CLAUDE_PROJECT_DIR:-.}/.claude/helpers';

/**
 * `helpers` is the directory holding `graft-hooks.cjs`, and it is a parameter for
 * one reason: the user-level install (see hosts/claude-global.ts) has to name an
 * absolute path. A `${CLAUDE_PROJECT_DIR}` command works only where a previous
 * `graft init` wrote a shim into that project — which is exactly the case the
 * global copy exists to cover, so it cannot reuse the repo form.
 */
function hookCmd(arg: string, helpers: string = REPO_HELPERS, name: 'graft' | 'trail' = 'graft'): string {
  return `node "${helpers}/${name}-hooks.cjs" ${arg}`;
}
/** trail's committed hook, `.trail/hook.cjs`, run for one event. */
export function trailHookCmd(arg: string): string {
  return `node "\${CLAUDE_PROJECT_DIR:-.}/.trail/hook.cjs" ${arg}`;
}
function graftBlocks(helpers?: string, name: 'graft' | 'trail' = 'graft'): Record<string, Json[]> {
  return hookBlocks((arg) => hookCmd(arg, helpers, name));
}
function hookBlocks(hookCmd_: (arg: string) => string): Record<string, Json[]> {
  return {
    PostToolUse: [
      { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: hookCmd_('post-edit'), timeout: 10000 }] },
      // Score the usage mix and sum token savings. A graft retrieval (CLI `graft …`
      // via Bash, or the `graft_*` MCP tools) prints a `[graft] tokens saved ≈ N`
      // footer this hook sums into the session total; the same hook classifies
      // Read/Grep/Glob as source reads vs graft as graft reads, which is what feeds
      // `graft stats` and the `session_summary` graft-vs-grep ratio. Broad matcher,
      // but the handler no-ops instantly unless there is something to record, so an
      // unrelated Bash or a plain Read costs only a stdin read.
      { matcher: 'Bash|mcp__graft__|mcp__trail__|Read|Grep|Glob', hooks: [{ type: 'command', command: hookCmd_('tool-savings'), timeout: 8000 }] },
    ],
    // Longer budget than the other hooks: its `graft ask` is a real query, and a
    // query now brings the graph up to date first (graph/refresh.ts) — usually
    // milliseconds, but the first one after an upgrade re-parses the repo once.
    // `hooks.ts` reads this number back out of the installed settings.json at
    // runtime and caps its `graft ask` child just under it, so a repo wired before
    // this bump (8s) keeps a child that fits inside 8s. Changing the number here is
    // therefore safe on its own — but it only reaches an existing repo when someone
    // re-runs `graft init`, since that is the only caller of this function.
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd_('prompt'), timeout: 15000 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: hookCmd_('session-start'), timeout: 8000 }] }],
    Stop: [{ hooks: [{ type: 'command', command: hookCmd_('stop'), timeout: 8000 }] }],
    // Sends the telemetry queue in a detached child, so closing Claude isn't
    // slowed. Not fired when the terminal is killed; session start sends what's left.
    SessionEnd: [{ hooks: [{ type: 'command', command: hookCmd_('session-end'), timeout: 5000 }] }],
  };
}
/**
 * Is this allowlist entry one graft wrote?
 *
 * Scoped to the forms graft is actually invoked as — NOT any rule mentioning
 * "graft". A user who allowlists their own `Bash(graft-mytool:*)` keeps it; only
 * graft's own set is replaced, which is what lets a renamed entry disappear on
 * upgrade instead of accumulating beside its replacement.
 */
export function isGraftAllowEntry(entry: unknown): boolean {
  return /^Bash\((?:trail|graft|npx graft|graft-dev|node dist\/cli\.js)(?::|\))/.test(String(entry));
}

/** Is this footer regex graft's? It points at the card tree, which is graft's alone. */
export function isGraftFooterRegex(re: unknown): boolean {
  return String(re).includes('graft/');
}

function envNoStatusline(): boolean {
  const v = process.env.GRAFT_NO_STATUSLINE;
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/** True when init should write (or refresh) Graft's Claude Code statusLine. */
export function statuslineWanted(opts: { statusline?: boolean } = {}): boolean {
  return opts.statusline !== false && !envNoStatusline();
}

function isGraftStatusline(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const command = (value as Json).command;
  return typeof command === 'string' && STATUSLINE_HELPER.test(command);
}

function applyStatusline(
  merged: Json,
  key: 'statusLine' | 'subagentStatusLine',
  warnings: string[],
  wanted: boolean,
  foreignWarning: string,
  name: 'graft' | 'trail' = 'graft',
): void {
  const current = merged[key];
  const ours = isGraftStatusline(current);
  if (!wanted) {
    if (!current || ours) delete merged[key];
    else warnings.push(foreignWarning);
    return;
  }
  if (!current || ours) {
    merged[key] = { type: 'command', command: slCmd(name) };
    return;
  }
  warnings.push(foreignWarning);
}

export function mergeGraftSettings(
  existing: Json,
  opts: { statusline?: boolean; name?: 'graft' | 'trail' } = {},
): { merged: Json; warnings: string[] } {
  const merged: Json = { ...(existing ?? {}) };
  const name = opts.name ?? 'graft';
  const warnings: string[] = [];
  const wanted = statuslineWanted(opts);

  applyStatusline(
    merged, 'statusLine', warnings, wanted,
    `Existing statusLine left untouched (a session allows only one). To use ${name === 'trail' ? 'Trail' : 'Graft'}, point it at .claude/helpers/${name}-statusline.cjs.`,
    name,
  );
  applyStatusline(
    merged, 'subagentStatusLine', warnings, wanted,
    'Existing subagentStatusLine left untouched.',
    name,
  );

  merged.hooks = { ...(merged.hooks ?? {}) };
  for (const [event, blocks] of Object.entries(graftBlocks(undefined, name))) {
    const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const foreign = prior.filter((e: Json) => !isGraftEntry(e)); // drop old Graft entries → idempotent
    merged.hooks[event] = [...foreign, ...blocks];
  }

  // Drop graft's own prior regex before re-adding, so a change to FOOTER replaces
  // the old pattern instead of stacking beside it. The user's regexes are kept.
  const priorFooter = Array.isArray(merged.footerLinksRegexes) ? merged.footerLinksRegexes : [];
  merged.footerLinksRegexes = [...priorFooter.filter((r: unknown) => !isGraftFooterRegex(r)), FOOTER];

  // headless/subagent runs hard-deny Bash by default; without an allowlist entry
  // `graft ask`'s own Bash calls (and the skill it installs) can't run out-of-box.
  // Same shape as the hooks merge above: drop graft's prior entries, then add the
  // current set. Append-only left a renamed invocation form in the user's settings
  // forever, with nothing able to remove it.
  merged.permissions = { ...(merged.permissions ?? {}) };
  const priorAllow = Array.isArray(merged.permissions.allow) ? merged.permissions.allow : [];
  merged.permissions.allow = [...priorAllow.filter((e: unknown) => !isGraftAllowEntry(e)), ...ALLOW_ENTRIES];

  return { merged, warnings };
}

/**
 * The hook blocks alone, merged into a settings file, with the shims addressed by
 * absolute path — `~/.claude/settings.json`, where a write reaches every project on
 * the machine (see hosts/claude-global.ts for why that copy has to exist).
 *
 * Hooks only, deliberately. `mergeGraftSettings` also claims the statusline, the
 * footer regex and a Bash allowlist, and each of those is a reasonable thing to
 * accept for a repo you ran `graft init` in and an unreasonable thing to impose on
 * every repo you ever open — a statusline especially, since a session allows exactly
 * one and taking it globally would silently outrank the user's own. The hooks are the
 * piece that has to be global, because they are what a worktree loses.
 *
 * Same idempotent shape as the repo merge: graft's prior entries are dropped before
 * the current set is added, so re-running converges instead of stacking.
 */
export function mergeGraftHooks(existing: Json, helpers: string): { merged: Json } {
  const merged: Json = { ...(existing ?? {}) };
  merged.hooks = { ...(merged.hooks ?? {}) };
  for (const [event, blocks] of Object.entries(graftBlocks(helpers))) {
    const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const foreign = prior.filter((e: Json) => !isGraftEntry(e));
    merged.hooks[event] = [...foreign, ...blocks];
  }
  return { merged };
}

/** Drop every fragment graft or trail wrote from a settings object, keeping the user's. */
function withoutOurs(existing: Json): Json {
  const merged: Json = { ...(existing ?? {}) };
  for (const key of ['statusLine', 'subagentStatusLine'] as const) if (isGraftStatusline(merged[key])) delete merged[key];
  if (merged.hooks && typeof merged.hooks === 'object' && !Array.isArray(merged.hooks)) {
    const hooks: Json = {};
    for (const [event, prior] of Object.entries(merged.hooks)) {
      const kept = Array.isArray(prior) ? prior.filter((e: Json) => !isGraftEntry(e)) : prior;
      if (!Array.isArray(kept) || kept.length) hooks[event] = kept;
    }
    if (Object.keys(hooks).length) merged.hooks = hooks;
    else delete merged.hooks;
  }
  if (Array.isArray(merged.footerLinksRegexes)) {
    const kept = merged.footerLinksRegexes.filter((r: unknown) => !isGraftFooterRegex(r));
    if (kept.length) merged.footerLinksRegexes = kept;
    else delete merged.footerLinksRegexes;
  }
  if (merged.permissions && typeof merged.permissions === 'object' && Array.isArray(merged.permissions.allow)) {
    const allow = merged.permissions.allow.filter((e: unknown) => !isGraftAllowEntry(e));
    const permissions: Json = { ...merged.permissions };
    if (allow.length) permissions.allow = allow;
    else delete permissions.allow;
    if (Object.keys(permissions).length) merged.permissions = permissions;
    else delete merged.permissions;
  }
  return merged;
}

/**
 * trail's part of the committed `.claude/settings.json`: one SessionStart entry
 * running `.trail/hook.cjs`, and nothing else. For a teammate without trail it
 * shows the learnings and offers trail; with trail it hands off to the install.
 * Anything an older init put here (status line, the other hooks, allowlist,
 * footer regex) comes out, so the file a team commits is the same on every machine.
 */
export function mergeTrailShared(existing: Json): Json {
  const merged = withoutOurs(existing);
  merged.hooks = { ...(merged.hooks ?? {}) };
  merged.hooks.SessionStart = [
    ...(Array.isArray(merged.hooks.SessionStart) ? merged.hooks.SessionStart : []),
    { hooks: [{ type: 'command', command: trailHookCmd('session-start'), timeout: 8000 }] },
  ];
  return merged;
}

/**
 * trail's part of `.claude/settings.local.json`, the person's own: the status
 * line, the footer regex and the allowlist, plus, when `~/.claude` doesn't carry
 * them (`--no-global`), the hooks for every event but session start, which the
 * shared file already runs once.
 */
export function mergeTrailLocal(
  existing: Json,
  opts: { statusline?: boolean; hooks?: boolean } = {},
): { merged: Json; warnings: string[] } {
  const merged = withoutOurs(existing);
  const warnings: string[] = [];
  if (statuslineWanted(opts)) {
    for (const key of ['statusLine', 'subagentStatusLine'] as const) {
      if (!merged[key]) merged[key] = { type: 'command', command: TRAIL_SL_CMD };
      else if (key === 'statusLine') warnings.push('Existing statusLine left untouched (a session allows only one). To use Trail, point it at .trail/statusline.cjs.');
    }
  }
  if (opts.hooks) {
    merged.hooks = { ...(merged.hooks ?? {}) };
    for (const [event, blocks] of Object.entries(hookBlocks(trailHookCmd))) {
      if (event === 'SessionStart') continue;
      merged.hooks[event] = [...(Array.isArray(merged.hooks[event]) ? merged.hooks[event] : []), ...blocks];
    }
  }
  merged.footerLinksRegexes = [...(merged.footerLinksRegexes ?? []), FOOTER];
  merged.permissions = { ...(merged.permissions ?? {}) };
  merged.permissions.allow = [...(merged.permissions.allow ?? []), ...ALLOW_ENTRIES];
  return { merged, warnings };
}
