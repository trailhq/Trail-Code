/**
 * How long the blocks trail's hooks add under a prompt, an edit or a command
 * are: `full` (the default), or `one-line`. Claude Code shows them in the
 * person's terminal too, and in full, the learnings on a prompt and the blast
 * radius after an edit run 10 to 15 lines each, every time.
 *
 * Kept as `summary` in `~/.trail/settings.json` by `trail summary
 * one-line|full`. TRAIL_SUMMARY overrides it for one shell, or for one repo
 * through the `env` of its `.claude/settings.json`.
 */
import { readJsonSafe, trailPath, withLock, writePrivate } from '../util/private-fs.js';

export type SummaryView = 'full' | 'one-line';

const VIEWS: ReadonlySet<string> = new Set(['full', 'one-line']);

const asView = (v: unknown): SummaryView | null => (typeof v === 'string' && VIEWS.has(v) ? (v as SummaryView) : null);

const settingsPath = (env?: NodeJS.ProcessEnv) => trailPath(env, 'settings.json');

/** The view in force: TRAIL_SUMMARY, else the settings file, else `full`. */
export function summaryView(env: NodeJS.ProcessEnv = process.env): SummaryView {
  return asView(env.TRAIL_SUMMARY) ?? asView(readJsonSafe<Record<string, unknown>>(settingsPath(env))?.summary) ?? 'full';
}

/** The person's `trail summary <view>`: writes `summary`, keeping every other key in the file. */
export function setSummaryView(view: string, env?: NodeJS.ProcessEnv): SummaryView {
  const v = asView(view);
  if (!v) throw new Error(`trail: the summary is full or one-line, not "${view}"`);
  const path = settingsPath(env);
  const done = withLock(path, () => {
    const raw = readJsonSafe<unknown>(path);
    const keep = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    writePrivate(path, `${JSON.stringify({ ...keep, summary: v }, null, 2)}\n`);
  }, 1000);
  if (!done.ok) throw new Error('trail: the settings are busy (another trail command is writing them). Try again.');
  return v;
}
