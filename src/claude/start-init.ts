/**
 * D87 at session start: every item the person kept on `trail init`'s screen
 * is named once in the next session start in that repo, each with its undo
 * (`trail forget <name>`), so a keep made through the screen (D82's pty
 * limit, O8) is never silent. Skills on or off: the screen keeps
 * preferences and guardrails either way (R60).
 *
 * The person reads it: a `systemMessage` where the host shows a start
 * notice, else one line of context asking the agent to say it once, from
 * Trail (D101). A preference is named by its learning's title (its kept
 * words), never from the init record, which holds no typed words.
 */
import { flatLine } from '../notes/flatten.js';
import { everyRepoLearnings } from '../notes/every-repo.js';
import { HOOK_RECORD_WAIT_MS, readInitRecord, updateInitRecord, type KeptName } from '../init/init-record.js';
import { FROM_TRAIL } from '../skills/directive-words.js';

/** What each kept kind reads as: a learning, one marked always follow, or a skill (notes/units.ts). */
const KIND_WORDS: Record<string, string> = { skill: 'skill', guardrail: 'always-follow learning', preference: 'learning', review: 'learning' };
/**
 * A skill's or guardrail's name, or an id: what `trail forget` takes. The record sits in the Trail home, which an
 * agent can write, so anything else (words, a second command) is never named as an undo (b7 review).
 */
const FORGET_ARG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `release-npm (skill, undo: trail forget release-npm)`. */
function itemWords(k: KeptName, env: NodeJS.ProcessEnv): string {
  // A preference is named by its learning's title (the person's kept words), never by the record.
  let name = k.kind !== 'preference' && FORGET_ARG.test(k.name) ? k.name : '';
  if (!name && k.kind === 'preference') {
    try { name = flatLine(everyRepoLearnings(env).find((n) => n.id === k.id)?.title ?? '', 60); } catch { /* no title */ }
    // D117 (5): not among the every-repo learnings, so kept for this repo (its words stay in that repo's folder).
    name = name ? `"${name}"` : 'your learning for this repo';
  }
  const forget = FORGET_ARG.test(k.forget) ? k.forget : FORGET_ARG.test(k.id) ? k.id : '';
  return `${name || (FORGET_ARG.test(k.id) ? k.id : 'an item')} (${KIND_WORDS[k.kind] ?? 'item'}${forget ? `, undo: trail forget ${forget}` : ''})`;
}

/** The notice's one line for the person, from a record's `notice`. */
export function keptLine(items: KeptName[], env: NodeJS.ProcessEnv): string {
  return `trail: kept from trail init in your terminal: ${items.slice(0, 8).map((k) => itemWords(k, env)).join(' · ')}`;
}

/**
 * The kept notice for this repo, once: its line, and the record's `notice.shownAt` set. `shownAt` is read and set
 * under the record's lock, and only the start that set it gets the line, so two sessions starting together name it
 * once (fix-lab5). Null when there is none, it was named already, the lock stayed busy past the 50 ms wait (a later
 * start names it), or anything fails.
 */
export function keptNotice(repoKey: string, env: NodeJS.ProcessEnv, now: Date): string | null {
  try {
    if (!repoKey) return null;
    // The usual start has nothing to name: no lock taken for it.
    const seen = readInitRecord(repoKey, env).notice;
    if (!seen || seen.shownAt || !seen.items.length) return null;
    let items: KeptName[] | null = null;
    updateInitRecord(repoKey, (r) => {
      if (!r.notice || r.notice.shownAt || !r.notice.items.length) return;
      r.notice.shownAt = now.toISOString();
      items = r.notice.items;
    }, env, HOOK_RECORD_WAIT_MS);
    return items ? keptLine(items, env) : null;
  } catch {
    return null;
  }
}

/** Where the host shows no start notice: from Trail, why the agent says it, the line (as heldContext does). */
export function keptContext(line: string): string {
  return `[trail] ${FROM_TRAIL} The person kept these from trail init's screen in their own terminal, and this app shows them no message from Trail itself. `
    // Double quotes inside become single ones, so the quote can't close early (as directive-words' quoteOf does).
    + `So they know what was kept and how to undo it, tell them once, at the start of your first reply: "${flatLine(line, 600).replace(/^trail: /, '').replace(/["\u201c\u201d]/g, "'")}"`;
}
