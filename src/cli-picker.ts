/**
 * `graft init`'s agent picker and `--dry-run` plan printer.
 *
 * Split three ways so the logic is testable without a TTY: `renderPicker` and
 * `reducePicker` are pure, `runPicker` is the only part that touches stdin.
 */
import { relative, dirname, sep } from 'node:path';
import type { HostPlan, PlannedWrite } from './hosts/plan.js';

const indigo = (s: string) => `\x1b[38;2;84;111;255m${s}\x1b[0m`;
const muted = (s: string) => `\x1b[38;5;244m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[38;5;179m${s}\x1b[0m`;

/** `/Users/me/.codex/x` → `~/.codex/x`, for display only. */
export function tilde(path: string, home: string): string {
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Deepest directory containing every given path. */
function commonDir(paths: string[]): string {
  const split = paths.map((p) => dirname(p).split(sep));
  const first = split[0] ?? [];
  let i = 0;
  while (i < first.length && split.every((s) => s[i] === first[i])) i++;
  return first.slice(0, i).join(sep);
}

/**
 * One-line summary of what selecting a host writes: repo-relative paths, then
 * a count for anything landing outside the repo — those are the writes users
 * can't see in `git status`, so they get named explicitly.
 */
export function describeWrites(
  writes: PlannedWrite[],
  repo: string,
  home: string,
  maxShown = 3,
): string {
  const repoPaths = writes.filter((w) => w.scope === 'repo').map((w) => relative(repo, w.path));
  const globals = writes.filter((w) => w.scope === 'global');
  const parts: string[] = [];
  if (repoPaths.length > 0) {
    parts.push(
      repoPaths.length <= maxShown
        ? repoPaths.join(', ')
        : `${repoPaths.slice(0, maxShown).join(', ')} +${repoPaths.length - maxShown} more`,
    );
  }
  if (globals.length > 0) {
    const where = tilde(commonDir(globals.map((w) => w.path)), home);
    // `sep`, not a literal `/`: every other path on this line is native, so a
    // hardcoded slash produced `~\.codex/` — one path, both separators.
    parts.push(`+ ${globals.length} in ${where}${sep} (machine-wide)`);
  }
  if (!writes.some((w) => w.kind === 'mcp')) parts.push('no MCP');
  return parts.join(' · ');
}

/**
 * The picker's and init's one-line summary: at most two repo entries, a folder
 * written into several times shown once as `folder/` when something else sits
 * beside it, then the count of writes outside the repo. `.claude/, .mcp.json ·
 * + 3 in ~/` rather than five paths nobody reads.
 */
export function compactWrites(writes: PlannedWrite[], repo: string, home: string, maxShown = 2): string {
  const repoPaths = writes.filter((w) => w.scope === 'repo').map((w) => relative(repo, w.path));
  const tops = new Map<string, string[]>();
  for (const p of repoPaths) {
    const top = p.split(sep)[0] ?? p;
    const list = tops.get(top) ?? [];
    list.push(p);
    tops.set(top, list);
  }
  const entries: string[] = [];
  if (tops.size >= 2) {
    for (const [top, paths] of tops) entries.push(paths.length >= 2 ? `${top}${sep}` : paths[0]!);
  } else {
    entries.push(...repoPaths);
  }
  const parts: string[] = [];
  if (entries.length > 0) {
    parts.push(
      entries.length <= maxShown
        ? entries.join(', ')
        : `${entries.slice(0, maxShown).join(', ')} +${entries.length - maxShown} more`,
    );
  }
  const globals = writes.filter((w) => w.scope === 'global');
  if (globals.length > 0) {
    const where = tilde(commonDir(globals.map((w) => w.path)), home);
    parts.push(`+ ${globals.length} in ${where}${where.endsWith(sep) ? '' : sep}`);
  }
  return parts.join(' · ');
}

export interface PickerRow {
  id: string;
  detected: boolean;
  summary: string;
  /** True when selecting this host writes outside the repo. */
  hasGlobal: boolean;
  /** Display name. Differs from the id only for setting rows, whose id is an
   *  internal marker the user should never see. */
  label: string;
  /** `host` rows wire an agent; `setting` rows are choices that write no files.
   *  They render below a rule, and `a` (toggle all) leaves them alone — that key
   *  means "every agent", not "flip my privacy choice too". */
  kind: 'host' | 'setting';
}

/**
 * The id of the telemetry consent row.
 *
 * The picker is where a user is already deciding what graft may touch, which
 * makes it the honest place to also ask whether they mind anonymous usage stats
 * — the same move munder-difflin makes with a pre-checked box in onboarding, and
 * the reason this is a disclosed default rather than a silent one. It is only
 * offered when telemetry could actually run: showing it in a fork, in CI, or
 * under DO_NOT_TRACK would be theatre.
 */
export const TELEMETRY_ROW_ID = '__telemetry';

export interface PickerState {
  rows: PickerRow[];
  /** Index into {@link visibleRows}, not into `rows`. */
  cursor: number;
  checked: ReadonlySet<string>;
  done: boolean;
  aborted: boolean;
  /** Agents graft cannot find on this machine are folded into one line until `m`. */
  showHidden?: boolean;
}

/** The rows on screen: undetected agents only once `m` has unfolded them. */
export function visibleRows(state: PickerState): PickerRow[] {
  return state.rows.filter((r) => r.kind === 'setting' || r.detected || state.showHidden);
}

/**
 * Claude Code starts checked — it's the deep integration — everything else off.
 *
 * `offerTelemetry` appends the consent row, checked. Default false so every
 * existing caller (and every test) sees exactly the host rows it always did.
 */
export function initialPickerState(
  plan: HostPlan[],
  repo: string,
  home: string,
  opts: { offerTelemetry?: boolean } = {},
): PickerState {
  const rows: PickerRow[] = plan.map((p) => ({
    id: p.id,
    label: p.id,
    kind: 'host' as const,
    detected: p.detected,
    summary: compactWrites(p.writes, repo, home),
    hasGlobal: p.writes.some((w) => w.scope === 'global'),
  }));
  const checked = new Set(plan.some((p) => p.id === 'claude') ? ['claude'] : []);
  if (opts.offerTelemetry) {
    rows.push({
      id: TELEMETRY_ROW_ID,
      label: 'anonymous usage stats',
      kind: 'setting',
      detected: true,
      summary: 'no code, no file paths, no queries',
      hasGlobal: false,
    });
    checked.add(TELEMETRY_ROW_ID);
  }
  return { rows, cursor: 0, checked, done: false, aborted: false };
}

export type PickerKey = 'up' | 'down' | 'space' | 'all' | 'more' | 'enter' | 'abort';

export const KEY_UP = '\x1b[A';
export const KEY_DOWN = '\x1b[B';
export const KEY_ESC = '\x1b';
export const KEY_CTRL_C = '\x03';

/** A single keypress → the key we act on, or null to ignore. */
export function keyOf(chunk: string): PickerKey | null {
  switch (chunk) {
    case KEY_UP: case 'k': return 'up';
    case KEY_DOWN: case 'j': return 'down';
    case ' ': return 'space';
    case 'a': return 'all';
    case 'm': return 'more';
    case '\r': case '\n': return 'enter';
    case KEY_ESC: case KEY_CTRL_C: case 'q': return 'abort';
    default: return null;
  }
}

/**
 * Split a raw stdin chunk into keypresses. A terminal is free to batch bytes —
 * held keys, pasted input, or a pty replaying a script all arrive as one chunk —
 * so a chunk is a sequence, never a single key. CSI sequences (ESC '[' final)
 * are consumed whole so an arrow key never reads as a bare ESC (i.e. abort).
 */
export function keysOf(chunk: string): PickerKey[] {
  const keys: PickerKey[] = [];
  let i = 0;
  while (i < chunk.length) {
    let token: string;
    if (chunk[i] === KEY_ESC && chunk[i + 1] === '[') {
      // ESC '[' then optional parameter bytes, then one final byte @-~.
      let j = i + 2;
      while (j < chunk.length && !/[@-~]/.test(chunk[j])) j++;
      token = chunk.slice(i, Math.min(j + 1, chunk.length));
    } else {
      token = chunk[i];
    }
    i += token.length;
    const key = keyOf(token);
    if (key !== null) keys.push(key);
  }
  return keys;
}

export function reducePicker(state: PickerState, key: PickerKey): PickerState {
  const visible = visibleRows(state);
  const n = visible.length;
  switch (key) {
    case 'up':
      return { ...state, cursor: (state.cursor - 1 + n) % n };
    case 'down':
      return { ...state, cursor: (state.cursor + 1) % n };
    case 'space': {
      const next = new Set(state.checked);
      const id = visible[state.cursor]!.id;
      if (next.has(id)) next.delete(id); else next.add(id);
      return { ...state, checked: next };
    }
    case 'all': {
      // The agents on screen only: `a` must never select one the user cannot
      // see. And agents only — a user who pressed it to select every agent has
      // not thereby said anything about usage stats, so whatever they chose on
      // that row survives untouched.
      const hosts = visible.filter((r) => r.kind === 'host');
      const allOn = hosts.every((r) => state.checked.has(r.id));
      const next = new Set(state.checked);
      for (const r of hosts) {
        if (allOn) next.delete(r.id);
        else next.add(r.id);
      }
      return { ...state, checked: next };
    }
    case 'more': {
      if (!state.rows.some((r) => r.kind === 'host' && !r.detected)) return state;
      // Keep the cursor on the row it was on, wherever that row lands.
      const at = visible[state.cursor]?.id;
      const toggled = { ...state, showHidden: !state.showHidden };
      const after = visibleRows(toggled);
      // Folding away the row under the cursor puts the cursor back at the top.
      const idx = after.findIndex((r) => r.id === at);
      // Anything the fold hides is unchecked, so nothing invisible gets wired.
      const checked = new Set(state.checked);
      if (!toggled.showHidden) for (const r of state.rows) if (r.kind === 'host' && !r.detected) checked.delete(r.id);
      return { ...toggled, cursor: idx >= 0 ? idx : 0, checked };
    }
    case 'enter':
      return { ...state, done: true };
    case 'abort':
      return { ...state, aborted: true };
  }
}

export function renderPicker(state: PickerState, tty = true, opts: { title?: string | null } = {}): string {
  const dim = tty ? muted : (s: string) => s;
  const hot = tty ? indigo : (s: string) => s;
  const warn = tty ? amber : (s: string) => s;

  const visible = visibleRows(state);
  const hidden = state.rows.filter((r) => r.kind === 'host' && !r.detected);
  // Pad on the plain label so the summary column lines up regardless of which
  // rows carry the '(not detected)' tag or the cursor's colour codes.
  const label = (r: PickerRow) => `${r.label}${r.detected || r.kind === 'setting' ? '' : ' (not detected)'}`;
  const width = Math.max(...visible.filter((r) => r.kind === 'host').map((r) => label(r).length), 12);
  const title = opts.title === undefined ? 'graft init — pick the agents your team uses:' : opts.title;
  const lines = title ? [title, ''] : [];
  let ruled = false;
  const foldLine = () => {
    if (hidden.length === 0) return;
    lines.push(
      dim(
        state.showHidden
          ? `      m to fold the ${hidden.length} not detected`
          : `      + ${hidden.length} not detected (${hidden.map((r) => r.label).join(', ')}) · m to show`,
      ),
    );
  };
  for (const [i, row] of visible.entries()) {
    // One rule between the agents and the settings, so the consent row reads as
    // a separate question rather than as another thing being installed.
    if (row.kind === 'setting' && !ruled) {
      foldLine();
      lines.push(dim(`  ${'─'.repeat(40)}`));
      ruled = true;
    }
    const here = i === state.cursor;
    const box = state.checked.has(row.id) ? '[x]' : '[ ]';
    const gap = ' '.repeat(Math.max(0, width - label(row).length));
    const name = here ? hot(row.label) : row.label;
    const tag = row.detected || row.kind === 'setting' ? '' : dim(' (not detected)');
    const summary = row.hasGlobal ? warn(row.summary) : dim(row.summary);
    lines.push(`${here ? '›' : ' '} ${box} ${name}${tag}${gap}   ${summary}`);
  }
  if (!ruled) foldLine();
  const keys = ['↑↓ move', 'space toggle', 'a all', ...(hidden.length ? ['m more'] : []), 'enter confirm', 'esc cancel'];
  lines.push('', dim(keys.join(' · ')));
  return lines.join('\n');
}

/** Ids in plan order, so output ordering never depends on toggle order. */
export function pickedIds(state: PickerState): string[] {
  return state.rows.filter((r) => state.checked.has(r.id)).map((r) => r.id);
}

/** Just the agents, with the setting rows filtered out — what init wires. */
export function pickedHostIds(state: PickerState): string[] {
  return state.rows.filter((r) => r.kind === 'host' && state.checked.has(r.id)).map((r) => r.id);
}

/** The consent answer, or undefined when the row was never offered (a fork, CI,
 *  DO_NOT_TRACK) — undefined means "don't change what's stored". */
export function pickedTelemetry(state: PickerState): boolean | undefined {
  if (!state.rows.some((r) => r.id === TELEMETRY_ROW_ID)) return undefined;
  return state.checked.has(TELEMETRY_ROW_ID);
}

/**
 * Drive the picker on a real terminal. Resolves the chosen agents plus the
 * consent answer, or null if the user cancelled — in which case the caller must
 * write nothing, telemetry setting included.
 */
export interface Picked {
  /** Agent ids to wire. */
  hosts: string[];
  /** The consent answer, or undefined when the row was not offered. */
  telemetry?: boolean;
}

export async function runPicker(
  plan: HostPlan[],
  repo: string,
  home: string,
  opts: { offerTelemetry?: boolean; title?: string | null } = {},
): Promise<Picked | null> {
  let state = initialPickerState(plan, repo, home, opts);
  const out = process.stderr;
  const stdin = process.stdin;

  let lastLines = 0;
  const draw = () => {
    if (lastLines > 0) out.write(`\x1b[${lastLines}A\x1b[0J`);
    const text = renderPicker(state, true, { title: opts.title });
    out.write(`${text}\n`);
    lastLines = text.split('\n').length;
  };

  const wasRaw = Boolean(stdin.isRaw);
  stdin.setRawMode?.(true);
  stdin.resume();
  draw();

  try {
    return await new Promise<Picked | null>((resolve) => {
      // Both listeners come off together: a leftover 'end' would otherwise fire
      // after a confirmed pick and redraw the picker over init's own output.
      const finish = (onData: (b: Buffer) => void) => {
        stdin.off('data', onData);
        stdin.off('end', onEnd);
        // Erased, not redrawn: the choice is reported by what init prints next,
        // and an interactive widget left in the scrollback is noise.
        if (lastLines > 0) out.write(`\x1b[${lastLines}A\x1b[0J`);
        lastLines = 0;
        resolve(state.aborted ? null : { hosts: pickedHostIds(state), telemetry: pickedTelemetry(state) });
      };
      const onData = (buf: Buffer) => {
        const keys = keysOf(buf.toString('utf8'));
        if (keys.length === 0) return;
        for (const key of keys) {
          state = reducePicker(state, key);
          if (state.done || state.aborted) {
            finish(onData);
            return;
          }
        }
        draw();
      };
      // A closed stdin (piped input that ran out) must not hang the prompt.
      const onEnd = () => { state = { ...state, aborted: true }; finish(onData); };
      stdin.on('data', onData);
      stdin.on('end', onEnd);
    });
  } finally {
    stdin.setRawMode?.(wasRaw);
    stdin.pause();
  }
}

/**
 * Shown when there's no TTY to prompt on and no flag saying what to wire.
 * Writing nothing is deliberate: a scripted run shouldn't get files for every
 * agent the machine happens to have installed.
 */
export function formatNonInteractiveHelp(detectedIds: string[]): string {
  const list = detectedIds.length > 0 ? detectedIds.join(", ") : "none";
  const examples: [string, string][] = [
    ...(detectedIds.length > 0
      ? ([
          [`graft init --agents ${detectedIds.join(" ")}`, "wire these"],
          ["graft init --yes", "same, without spelling them out"],
        ] as [string, string][])
      : []),
    ["graft init --agents claude", "Claude Code only"],
    ["graft init --dry-run", "list every file first"],
  ];
  const width = Math.max(...examples.map(([cmd]) => cmd.length));
  return [
    "graft init: no TTY to prompt on, and no --agents/--yes given — nothing written.",
    `detected: ${list}`,
    "",
    ...examples.map(([cmd, note]) => `  ${cmd.padEnd(width)}   # ${note}`),
  ].join("\n");
}

/**
 * `--dry-run` output: every path init would touch, repo writes first, then a
 * separate section for anything outside the repo.
 */
export function formatPlan(
  plan: HostPlan[],
  ids: string[],
  repo: string,
  home: string,
  tty = Boolean(process.stderr.isTTY),
): string {
  const dim = tty ? muted : (s: string) => s;
  const warn = tty ? amber : (s: string) => s;
  const writes = plan.filter((p) => ids.includes(p.id)).flatMap((p) => p.writes);
  if (writes.length === 0) return 'would write — nothing (no agents selected)';

  const pad = (rows: PlannedWrite[], f: (p: string) => string) => {
    const w = Math.max(...rows.map((r) => f(r.path).length));
    return rows.map((r) => `  ${f(r.path).padEnd(w)}  ${dim(r.what)}`);
  };

  const lines: string[] = [];
  const repoWrites = writes.filter((w) => w.scope === 'repo');
  if (repoWrites.length > 0) {
    lines.push('would write — this repo:', ...pad(repoWrites, (p) => relative(repo, p)));
  }
  const globalWrites = writes.filter((w) => w.scope === 'global');
  if (globalWrites.length > 0) {
    if (lines.length) lines.push('');
    lines.push(
      warn('would write — your machine, affects ALL repos:'),
      ...pad(globalWrites, (p) => tilde(p, home)),
      '',
      dim('suppress the out-of-repo writes with --no-global'),
    );
  }
  lines.push('', dim('nothing was written (--dry-run)'));
  return lines.join('\n');
}
