/**
 * The review screen's keys (design 4.7), in raw mode on the person's own
 * terminal. It never keeps anything itself: it resolves with how the person
 * left it, the numbers ticked, and where each item applies.
 *
 * ↑↓ (or k/j) move · space ticks · s opens the item in place (a skill's
 * draft, a guardrail's text, a preference's lines with their dates, read
 * now and shown, never stored) and esc or s closes it · w flips this repo
 * and every repo (no-timeout stays every repo) · r adds a preference to the
 * repo (anything else: later) · enter keeps the ticked · n keeps nothing ·
 * esc, q and Ctrl-C decide later. A closed stdin is esc.
 */
import { draftText, monthDay } from '../skills/compile-words.js';
import type { CompiledSkill } from '../skills/types.js';
import type { RunSheet } from '../trace/types.js';
import { WALLS } from '../trace/walls.js';
import { lineAt } from '../skills/receipts.js';
import { prefText } from './prefs.js';
import { typedAt } from './replay-runs.js';
import { INIT_COPY, screenLines, type ScreenFacts } from './review-screen.js';
import type { InitItem } from './types.js';

export interface ScreenAnswer {
  how: 'enter' | 'n' | 'esc';
  ticked: number[];
  scopes: Record<number, { applies: string; scope: 'personal' | 'repo' }>;
}

interface State { items: InitItem[]; cursor: number; open: number | null; openLines: string[]; note: string }

/** A skill's draft as 1a shows it, headed for a run from the past. */
export function initDraft(c: CompiledSkill): string[] {
  const sheet = { startedAt: c.source.at, endedAt: c.source.at, checked: true } as unknown as RunSheet;
  const lines = draftText(c, sheet).split('\n');
  return [`${c.name} · copied from a run that worked on ${monthDay(c.source.at)}`, ...lines.slice(1)];
}

/** What `s` shows for an item, read now (the person's lines through their pointers, checked by sha). */
export function detailLines(item: InitItem, env: NodeJS.ProcessEnv): string[] {
  if (item.kind === 'skill' && item.skill) return initDraft({ ...item.skill.compiled, name: item.title || item.skill.compiled.name });
  if (item.kind === 'guardrail') return [WALLS.find((w) => w.cls === item.guardrail?.cls)?.guardrail?.text ?? ''];
  if (item.kind === 'preference') {
    const out: string[] = [];
    for (const ref of item.pref?.refs ?? []) {
      const text = typedAt(ref, env);
      if (!text) continue;
      let day = '';
      try {
        const at = (JSON.parse(lineAt(ref.t, ref.o) ?? 'null') as { timestamp?: unknown } | null)?.timestamp;
        day = typeof at === 'string' ? monthDay(at) : '';
      } catch { /* no date */ }
      out.push(`${day ? `${day}: ` : ''}"${prefText(text).slice(0, 120).replace(/"/g, "'")}"`);
    }
    return out.length ? out : ["Trail couldn't read these lines again just now."];
  }
  return item.detail ?? [];
}

/** `quit`: Ctrl-C or q, which always leave; `esc` closes an open draft first. */
type Key = 'up' | 'down' | 'space' | 's' | 'w' | 'r' | 'enter' | 'n' | 'esc' | 'quit' | 'other';

/** The keys in one chunk of input, in order. */
export function keysOf(chunk: string): Key[] {
  const out: Key[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i]!;
    if (c === '\x1b') {
      if (chunk[i + 1] === '[' || chunk[i + 1] === 'O') {
        const k = chunk[i + 2];
        out.push(k === 'A' ? 'up' : k === 'B' ? 'down' : 'other');
        i += 2;
      } else out.push('esc');
    } else if (c === '\x03' || c === 'q' || c === 'Q') out.push('quit');
    else if (c === '\r' || c === '\n') out.push('enter');
    else if (c === ' ') out.push('space');
    else if (c === 'k') out.push('up');
    else if (c === 'j') out.push('down');
    else if (c === 's' || c === 'S') out.push('s');
    else if (c === 'w' || c === 'W') out.push('w');
    else if (c === 'r' || c === 'R') out.push('r');
    else if (c === 'n' || c === 'N') out.push('n');
    else out.push('other');
  }
  return out;
}

/** One key: the new state, or how the screen ends. */
function press(st: State, key: Key, repoKey: string, env: NodeJS.ProcessEnv): ScreenAnswer['how'] | null {
  const item = st.items[st.cursor];
  st.note = '';
  switch (key) {
    case 'up': st.cursor = Math.max(0, st.cursor - 1); st.open = null; return null;
    case 'down': st.cursor = Math.min(st.items.length - 1, st.cursor + 1); st.open = null; return null;
    case 'space': if (item) item.ticked = !item.ticked; return null;
    case 's':
      if (st.open === st.cursor) st.open = null;
      else if (item) {
        st.open = st.cursor;
        st.openLines = detailLines(item, env);
      }
      return null;
    case 'w':
      if (!item || item.kind === 'review' || item.kind === 'session' || item.kind === 'claude' || item.kind === 'claudeai') return null;
      if (item.kind === 'guardrail' && item.guardrail?.check === 'no-timeout') {
        st.note = INIT_COPY.wNoTimeout!;
        return null;
      }
      item.applies = item.applies === 'every repo' ? repoKey : 'every repo';
      if (item.applies === 'every repo') item.scope = 'personal';
      return null;
    case 'r':
      if (!item) return null;
      if (item.kind !== 'preference' && item.kind !== 'claudeai') {
        st.note = INIT_COPY.rLater!;
        return null;
      }
      item.scope = item.scope === 'repo' ? 'personal' : 'repo';
      if (item.scope === 'repo') item.applies = repoKey;
      return null;
    case 'enter': return 'enter';
    case 'n': return 'n';
    case 'esc':
      if (st.open !== null) {
        st.open = null;
        return null;
      }
      return 'esc';
    case 'quit': return 'esc';
    default: return null;
  }
}

/** Raw-mode keys (4.7). Resolves on enter, n, esc, q or Ctrl-C. Never keeps anything itself. */
export function runScreen(items: InitItem[], facts: ScreenFacts, io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream },
  opts: { repoKey: string; env?: NodeJS.ProcessEnv }): Promise<ScreenAnswer> {
  const env = opts.env ?? process.env;
  const st: State = { items: items.map((i) => ({ ...i })), cursor: 0, open: null, openLines: [], note: '' };
  const { stdin, stdout } = io;
  const draw = () => {
    const lines = screenLines(st.items, { cursor: st.cursor, open: st.open, openLines: st.openLines, note: st.note }, facts);
    stdout.write(`\x1b[2J\x1b[H${lines.join('\n')}\n`);
  };
  const answer = (how: ScreenAnswer['how']): ScreenAnswer => ({
    how,
    ticked: st.items.filter((i) => i.ticked).map((i) => i.n),
    scopes: Object.fromEntries(st.items.map((i) => [i.n, { applies: i.applies, scope: i.scope }])),
  });
  return new Promise((resolve) => {
    const wasRaw = (stdin as { isRaw?: boolean }).isRaw === true;
    let done = false;
    /** Raw mode back as it was, on every way out: a key, a closed or broken stdin, a throw, the process ending. */
    const restore = () => {
      try { stdin.setRawMode?.(wasRaw); } catch { /* not a TTY any more */ }
    };
    const finish = (how: ScreenAnswer['how']) => {
      if (done) return;
      done = true;
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('close', onEnd);
      stdin.off('error', onEnd);
      process.off('exit', restore);
      restore();
      try { stdin.pause(); } catch { /* gone */ }
      resolve(answer(how));
    };
    const onData = (b: Buffer | string) => {
      try {
        for (const k of keysOf(typeof b === 'string' ? b : b.toString('utf8'))) {
          const how = press(st, k, opts.repoKey, env);
          if (how) return finish(how);
        }
        draw();
      } catch {
        // A key that can't be shown never leaves the terminal raw or init waiting: it decides later (b6 review).
        finish('esc');
      }
    };
    const onEnd = () => finish('esc');
    process.on('exit', restore);
    try { stdin.setRawMode?.(true); } catch { /* drawn anyway */ }
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('close', onEnd);
    stdin.on('error', onEnd);
    stdin.resume();
    try {
      draw();
    } catch {
      finish('esc');
    }
  });
}
