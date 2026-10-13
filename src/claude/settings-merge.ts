import { isGraftEntry } from '../hosts/config-write.js';

type Json = Record<string, any>;

const SL_CMD = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-statusline.cjs"';
/** Stable marker for "this statusLine is Graft's", not the full command string —
 * an older shim path or a GRAFT_DIR wrapper still names this file. */
const GRAFT_STATUSLINE_HELPER = 'graft-statusline.cjs';
const FOOTER = 'graft/[\\w./-]+\\.md';
// Every form graft is actually invoked as. 'graft:*' covers a global install;
// the other two cover a repo working on graft itself (or any consumer running it
// from a checkout), where the binary is not on PATH under that name. A retrieval
// call that raises a permission prompt loses to grep, which never does.
const ALLOW_ENTRIES = [
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
function hookCmd(arg: string, helpers: string = REPO_HELPERS): string {
  return `node "${helpers}/graft-hooks.cjs" ${arg}`;
}
// Claude Code's hooks reference documents `timeout` in SECONDS (default 600),
// not milliseconds — see trailhq/Graft#283. These used to be 10000/8000/15000
// (read as 2h47m/2h13m/4h10m hook budgets instead of the intended 10s/8s/15s).
// `claude/hooks.ts` reads these back out of the installed settings.json at
// runtime (`installedBudgetMs`) and tolerates a pre-fix repo's leftover
// ms-shaped values until its next `graft init` rewrites them here.
function graftBlocks(helpers?: string): Record<string, Json[]> {
  return {
    PostToolUse: [
      { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: hookCmd('post-edit', helpers), timeout: 10 }] },
      // Score the usage mix and sum token savings. A graft retrieval (CLI `graft …`
      // via Bash, or the `graft_*` MCP tools) prints a `[graft] tokens saved ≈ N`
      // footer this hook sums into the session total; the same hook classifies
      // Read/Grep/Glob as source reads vs graft as graft reads, which is what feeds
      // `graft stats` and the `session_summary` graft-vs-grep ratio. Broad matcher,
      // but the handler no-ops instantly unless there is something to record, so an
      // unrelated Bash or a plain Read costs only a stdin read.
      { matcher: 'Bash|mcp__graft__|Read|Grep|Glob', hooks: [{ type: 'command', command: hookCmd('tool-savings', helpers), timeout: 8 }] },
    ],
    // Longer budget than the other hooks: its `graft ask` is a real query, and a
    // query now brings the graph up to date first (graph/refresh.ts) — usually
    // milliseconds, but the first one after an upgrade re-parses the repo once.
    // `hooks.ts` reads this number back out of the installed settings.json at
    // runtime and caps its `graft ask` child just under it, so a repo wired before
    // this bump (8s) keeps a child that fits inside 8s. Changing the number here is
    // therefore safe on its own — but it only reaches an existing repo when someone
    // re-runs `graft init`, since that is the only caller of this function.
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('prompt', helpers), timeout: 15 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('session-start', helpers), timeout: 8 }] }],
    Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop', helpers), timeout: 8 }] }],
  };
}

/** Mirrors `hooks.ts`'s `GRAFT_HOOK_SUBCOMMANDS` — see `subcommandOf` below for
 * why this is duplicated rather than imported. */
const GRAFT_HOOK_SUBCOMMANDS = ['post-edit', 'tool-savings', 'prompt', 'session-start', 'stop'] as const;

/** The graft subcommand a hook command invokes — mirrors `hooks.ts`'s
 * `hookSubcommandOf`; duplicated rather than imported because this module and
 * `claude/hooks.ts` are each meant to build standalone (the hook shim is a
 * single generated file, not a bundle with internal imports).
 *
 * Scans from the end for the last KNOWN subcommand rather than the literal
 * last whitespace token, so a trailing shell redirect on a hand-written
 * command (`... prompt 2>/dev/null`) doesn't get mistaken for the
 * subcommand and silently fail every match below. */
function subcommandOf(command: unknown): string | null {
  if (typeof command !== 'string' || !command.includes('graft-hooks.cjs')) return null;
  const parts = command.trim().split(/\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if ((GRAFT_HOOK_SUBCOMMANDS as readonly string[]).includes(parts[i])) return parts[i];
  }
  return null;
}

// Mirrors `claude/hooks.ts`'s LEGACY_MS_FLOOR: a prior timeout above this is a
// pre-#283 ms-shaped artifact, not a value anyone deliberately chose, so it must
// never be "preserved" as a hand-raise — see `priorTimeoutFor` below.
const LEGACY_MS_FLOOR = 600;

/** A user-raised timeout on graft's OWN prior entry for `subcommand`, if any —
 * only when it's already in the sane (seconds) range. `entries` is the set of
 * prior hook entries `isGraftEntry` recognized as graft's (about to be dropped
 * and replaced by the fresh template), not the foreign ones left untouched.
 *
 * The largest matching prior value wins, not the first: a hand-edited prior
 * settings.json can carry more than one block for the same subcommand (e.g.
 * separate `Write`/`Edit` matchers, both invoking `post-edit`, raised to
 * different timeouts) — `withPriorRaises` below only ever raises, so the
 * generous reading is the correct one; taking the first-found value made an
 * earlier, smaller raise silently mask a later, larger one depending on
 * nothing but the two blocks' order in the file. */
function priorTimeoutFor(entries: Json[], subcommand: string): number | undefined {
  let max: number | undefined;
  for (const e of entries) {
    for (const h of e?.hooks ?? []) {
      if (subcommandOf(h?.command) === subcommand && typeof h.timeout === 'number' && h.timeout <= LEGACY_MS_FLOOR) {
        if (max === undefined || h.timeout > max) max = h.timeout;
      }
    }
  }
  return max;
}

/**
 * The template blocks for one event, with any hand-raised timeout on graft's
 * own prior entry preserved (trailhq/Graft#366 part 2): a deliberate raise
 * (e.g. 10s → 20s) otherwise silently reverts on the next version bump, since
 * the merge below drops and rewrites graft's entries wholesale to stay
 * idempotent. Only ever raises — a template bump can still lift everyone's
 * floor — and a legacy ms-shaped prior value is never eligible (see
 * `priorTimeoutFor`), so this cannot resurrect the #283 bug it sits beside.
 */
function withPriorRaises(blocks: Json[], priorGraftEntries: Json[]): Json[] {
  return blocks.map((block) => ({
    ...block,
    hooks: block.hooks.map((h: Json) => {
      const sub = subcommandOf(h.command);
      const prior = sub ? priorTimeoutFor(priorGraftEntries, sub) : undefined;
      return prior !== undefined && prior > h.timeout ? { ...h, timeout: prior } : h;
    }),
  }));
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
  return /^Bash\((?:graft|npx graft|graft-dev|node dist\/cli\.js)(?::|\))/.test(String(entry));
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
  return typeof command === 'string' && command.includes(GRAFT_STATUSLINE_HELPER);
}

function applyStatusline(
  merged: Json,
  key: 'statusLine' | 'subagentStatusLine',
  warnings: string[],
  wanted: boolean,
  foreignWarning: string,
): void {
  const current = merged[key];
  const ours = isGraftStatusline(current);
  if (!wanted) {
    if (!current || ours) delete merged[key];
    else warnings.push(foreignWarning);
    return;
  }
  if (!current || ours) {
    merged[key] = { type: 'command', command: SL_CMD };
    return;
  }
  warnings.push(foreignWarning);
}

export function mergeGraftSettings(
  existing: Json,
  opts: { statusline?: boolean } = {},
): { merged: Json; warnings: string[] } {
  const merged: Json = { ...(existing ?? {}) };
  const warnings: string[] = [];
  const wanted = statuslineWanted(opts);

  applyStatusline(
    merged, 'statusLine', warnings, wanted,
    'Existing statusLine left untouched (a session allows only one). To use Graft, point it at .claude/helpers/graft-statusline.cjs.',
  );
  applyStatusline(
    merged, 'subagentStatusLine', warnings, wanted,
    'Existing subagentStatusLine left untouched.',
  );

  merged.hooks = { ...(merged.hooks ?? {}) };
  for (const [event, blocks] of Object.entries(graftBlocks())) {
    const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const priorGraft = prior.filter((e: Json) => isGraftEntry(e));
    const foreign = prior.filter((e: Json) => !isGraftEntry(e)); // drop old Graft entries → idempotent
    merged.hooks[event] = [...foreign, ...withPriorRaises(blocks, priorGraft)];
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
    const priorGraft = prior.filter((e: Json) => isGraftEntry(e));
    const foreign = prior.filter((e: Json) => !isGraftEntry(e));
    merged.hooks[event] = [...foreign, ...withPriorRaises(blocks, priorGraft)];
  }
  return { merged };
}
