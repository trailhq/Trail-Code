/**
 * What `trail init` shows (design 4.7, 4.8): the review screen's lines, the
 * relay an agent or a script gets, and the lines after a keep. Pure: no
 * file, no clock, no terminal. The keys are review-tty.ts's; what is kept
 * is keep.ts's.
 *
 * Words are 4.7's. The relay keeps phase 0's RELAY_LINE and KEEP_LINE word
 * for word (the keep gate finds the list by them) and, for an agent, opens
 * with who it is from and why, and ends saying Trail checks the person's
 * typed numbers (D101): it never tells the agent to choose.
 */
import { flatLine } from '../notes/flatten.js';
import { directive } from '../skills/directive-words.js';
import { WALLS } from '../trace/walls.js';
import type { ClaudeFailure } from './claude-call.js';
import type { KeepResult } from './keep.js';
import { nameLine } from './name-call.js';
import { DRAFT_LINE, KEEP_LINE, RELAY_LINE } from './relay.js';
import type { InitItem, InitKind, LookBack } from './types.js';
import { onlyRepeats } from '../skills/follow-learnings.js';

export interface ScreenFacts {
  lookBack: LookBack;
  model: string | 'none';
  why: ClaudeFailure | null;
  tokens: number;
  calls: number;
  offers: 'on' | 'off';
  offersOffAt: string | null;
  repoName: string;
  agent: boolean;
  skills: boolean;
  /** How many skills the naming call was sent (its screen line). */
  sentSkills?: number;
  /** Claude Code's own words when the naming call failed. */
  whySaid?: string;
  /** How many PR reviews the review read went through, when it ran (the twice-asked line). */
  reviewsRead?: number;
  /** false when no look-back ran this init (not due, or off) and the screen holds only #662's team rows. */
  lookedBack?: boolean;
}

export const INIT_COPY: Record<string, string> = {
  found: '✓ looked back at {n} Claude Code sessions about this repo, typed into on {d} days ({from} to {to})',
  foundNone: '· no past Claude Code sessions about this repo on this machine yet',
  parent: ' · {p} started in the parent folder',
  plainNames: ' · names are plain: to name them with Claude, run trail init --look-back in your own terminal',
  alreadyKept: '· {a} already kept {where} (they apply here too)',
  nothing: "· nothing came up on two or more days, so there's nothing to keep from your past sessions yet",
  skills: 'Skills',
  guardrails: 'Always follow',
  preferences: 'Learnings',
  reviews: 'From PR reviews',
  team: "Your teammates' Claude doesn't know these yet",
  claudeAi: 'From what Claude.ai knows about you',
  keys1: '↑↓ move · space tick · s see more · enter keep ticked · n keep nothing',
  keys2: 'w every repo or this repo · r add a learning to this repo (committed) · esc decide later',
  skillsOff: 'skills are off · trail skills on lets init also find repeated jobs and keep their steps',
  skillCount: 'Claude worked out how to {job} from scratch on {days} different days.',
  guardCount: 'Hit {words} on {days} days.',
  prefCount: 'You said this on {days} days.',
  reviewCount: 'From PR {prs}.',
  sessionCount: 'From your past Claude sessions here.',
  claudeCount: 'From what your Claude keeps about this repo.',
  claudeAiCount: "Claude.ai knows this; Claude Code doesn't.",
  personal: 'just for you, in this repo',
  everyRepo: 'just for you, in every repo',
  repo: 'added to this repo, committed',
  reviewRepo: 'added to this repo',
  agentLead: 'trail init found these in the past sessions of the person you are working with. Only they decide what Trail keeps, so the list is theirs to answer.',
  agentKeep: "Trail checks the numbers the person typed in this session before it keeps anything, so run trail keep only with the numbers they typed.",
  pickInTerminal: 'Pick in a terminal: trail init',
  handover: 'trail init found {k} items in this person\'s past sessions that they haven\'t answered yet. Only they decide what Trail keeps.',
  kept: '✓ kept {k}, just for you · in ~/.trail, never committed, never uploaded',
  keptMixed: "✓ kept {k} · {j} just for you in ~/.trail, never uploaded · {r} added to this repo's .trail/learnings (commit it to share)",
  notKept: "Not kept: {names}. Trail won't bring {them} up again.",
  refused: "{name}: its past session changed or is gone, so Trail can't check the steps. It will offer it again after the job checks out.",
  offersOn: 'skills: on · at most one offer per session, only after a job checks out · stop offers: trail skills offers off · all off: trail skills off',
  offersOff: 'skill offers are off (you turned them off on {date}) · trail skills offers on',
  afterEsc: 'kept nothing · they wait until you run trail init again',
  afterN: "kept nothing · Trail won't bring these up again",
  wNoTimeout: 'this Mac has no timeout in any repo, so it stays every repo',
  rLater: 'adding skills and always-follow learnings to the repo comes in a later version',
  yesAgent: 'found {found}. Kept nothing: an agent ran this. The person picks with trail keep <numbers> after seeing the list, or trail init --look-back in their own terminal',
  yesScript: 'found {found}. Kept only the learnings in your own words. To pick the rest: trail init --look-back',
  foldHint: 'kept with skill {n}, it goes into that skill as a learning, since a step of it already does this',
  folded: '· {pref} went into {skill} as a learning, since a step of it already does that',
};

/**
 * Part 7: the skill on this screen a preference only repeats a step of (keep.ts folds it in when both are kept), or
 * null. Only a preference just for the person in this repo, as keep.ts folds.
 */
export function foldTarget(item: InitItem, items: InitItem[]): InitItem | null {
  if (item.kind !== 'preference' || item.scope === 'repo' || item.applies === 'every repo' || !item.title) return null;
  return items.find((s) => s.kind === 'skill' && s.skill?.compiled && onlyRepeats(item.title, s.skill.compiled.steps.map((x) => x.cmd))) ?? null;
}

/** `{x}` filled from `v`. */
export function fill(t: string, v: Record<string, string | number>): string {
  return t.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Jul 3' from '2026-07-03'. */
export function dayWords(day: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? '');
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : '';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The repo's own name for the job phrases: the last part of its key. */
export const repoNameOf = (repoKey: string) => repoKey.split('/').filter(Boolean).pop() ?? repoKey;

/** A plain branch name: what a ship item's phrase may carry from its check, nothing else of the command. */
export const BRANCH_NAME = /^[\w][\w./-]{0,59}$/;

/** The branches a ship skill's check names (`refs/heads/<b>`), at most 3: the words of its job phrase. */
export function shipBranchesOf(check: string | null | undefined): string[] {
  return [...new Set([...String(check ?? '').matchAll(/refs\/heads\/([\w./-]+)/g)].map((m) => m[1]!))].filter((b) => BRANCH_NAME.test(b)).slice(0, 3);
}

/** 4.7's job phrases. Release reaches init only with an npm-view check (OFFER_FAMILIES), so it publishes to npm. */
export function jobPhrase(item: Pick<InitItem, 'key' | 'skill'>, repoName: string): string {
  const job = item.key.slice(item.key.lastIndexOf('|job:') + 5);
  switch (job) {
    case 'release': return /\bnpm view\b/.test(item.skill?.compiled?.check ?? 'npm view') ? `publish ${repoName} to npm` : `release ${repoName}`;
    case 'ship': {
      // The compiled check's branches; a handed-over item has only the names the relay wrote down (D112).
      const branches = item.skill?.compiled ? shipBranchesOf(item.skill.compiled.check) : (item.skill as { branches?: string[] } | undefined)?.branches ?? [];
      return branches.length ? `ship ${repoName} to ${branches.join(' and ')}` : `ship ${repoName}`;
    }
    case 'tests': return `run ${repoName}'s tests`;
    case 'pr-green': return "get a PR's checks green";
    case 'run-local': return `run ${repoName} locally`;
    default: return `${job} ${repoName}`;
  }
}

/** Where an item goes, in words. */
export function scopeWords(item: Pick<InitItem, 'kind' | 'scope' | 'applies'>): string {
  if (item.kind === 'review' || item.kind === 'session' || item.kind === 'claude') return INIT_COPY.reviewRepo!;
  if (item.scope === 'repo') return INIT_COPY.repo!;
  return item.applies === 'every repo' ? INIT_COPY.everyRepo! : INIT_COPY.personal!;
}

/** The count sentence, with its full stop. */
export function countSentence(item: InitItem, repoName: string): string {
  const days = item.count.days;
  switch (item.kind) {
    case 'skill': return fill(INIT_COPY.skillCount!, { job: jobPhrase(item, repoName), days });
    case 'guardrail': return fill(INIT_COPY.guardCount!, { words: WALLS.find((w) => w.cls === item.guardrail?.cls)?.words ?? 'this error', days });
    case 'preference': return fill(INIT_COPY.prefCount!, { days });
    case 'claude': return INIT_COPY.claudeCount!;
    case 'claudeai': return INIT_COPY.claudeAiCount!;
    case 'session': return INIT_COPY.sessionCount!;
    default: {
      // #662's source words: the PRs, three at most.
      const prs = item.review?.prs ?? [];
      return fill(INIT_COPY.reviewCount!, { prs: `${prs.slice(0, 3).map((p) => `#${p}`).join(', ')}${prs.length > 3 ? ` +${prs.length - 3}` : ''}` });
    }
  }
}

/** An item's title or sentence as one plain line (b6 review): no escape, bell or break from a person's line, a review's
 *  model text or a description reaches the terminal or the relay, and nothing over 160 characters. */
const plain = (t: string) => flatLine(t, 160);
/** A draft line as one line with its own spacing kept (the steps' columns): no control or invisible character, at
 *  most 400 characters. */
const spaced = (t: string) => Array.from(String(t ?? '').replace(/\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/g, ' ')
  .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\p{Cf}]/gu, '')).slice(0, 400).join('');
const quoted = (item: InitItem) => (item.kind === 'preference' ? `"${plain(item.title).replace(/"/g, "'")}"` : plain(item.title));
const KIND_ORDER: InitKind[] = ['skill', 'guardrail', 'preference', 'review', 'session', 'claude', 'claudeai'];
/** The heading over each kind; #662's team rows, from reviews and from what Claude Code keeps (kind 'claude'), share one. */
const GROUP: Record<InitKind, string> = { skill: 'skills', guardrail: 'guardrails', preference: 'preferences', review: 'team', session: 'team', claude: 'team', claudeai: 'claudeAi' };

/** Items numbered as the screen and the relay show them: by kind, then in pickFive's order within a kind. */
export function numbered<T extends { kind: InitKind }>(picked: T[]): Array<T & { n: number }> {
  const sorted = [...picked].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return sorted.map((x, i) => ({ ...x, n: i + 1 }));
}

function foundLine(facts: ScreenFacts, plain: boolean): string {
  const lb = facts.lookBack;
  if (!lb.sessions.length) return INIT_COPY.foundNone!;
  let line = fill(INIT_COPY.found!, { n: lb.sessions.length, d: lb.days, from: dayWords(lb.from), to: dayWords(lb.to) });
  if (lb.parent) line += fill(INIT_COPY.parent!, { p: lb.parent });
  if (plain) line += INIT_COPY.plainNames!;
  return line;
}

function headLines(items: InitItem[], facts: ScreenFacts, relay: boolean): string[] {
  const out = facts.lookedBack === false ? [] : [foundLine(facts, relay && items.some((i) => i.kind === 'skill'))];
  if (!relay) {
    const plainNames = items.filter((i) => i.kind === 'skill').map((i) => i.plainName);
    const said = nameLine({ names: {}, model: facts.model, why: facts.why, sentItems: facts.sentSkills ?? 0, tokens: facts.tokens, ...(facts.whySaid ? { said: facts.whySaid } : {}) }, plainNames, facts.reviewsRead ?? 0);
    if (said) out.push(said);
  }
  const kept = facts.lookBack.alreadyKept;
  if (kept.here) out.push(fill(INIT_COPY.alreadyKept!, { a: kept.here, where: 'for every repo' }));
  for (const e of kept.elsewhere) out.push(fill(INIT_COPY.alreadyKept!, { a: e.n, where: `in ${e.repo}` }));
  for (const e of facts.lookBack.errors) out.push(`· ${e}`);
  return out;
}

/** The review screen (4.7): header, the items by kind, the open draft under its item, the keys. */
export function screenLines(items: InitItem[], state: { cursor: number; open: number | null; note?: string; openLines?: string[] }, facts: ScreenFacts): string[] {
  const out = headLines(items, facts, false);
  if (!items.length) {
    out.push(INIT_COPY.nothing!);
    return out;
  }
  out.push('');
  let last: string | null = null;
  items.forEach((item, at) => {
    if (GROUP[item.kind] !== last) {
      last = GROUP[item.kind];
      out.push(INIT_COPY[last]!);
    }
    const cur = at === state.cursor ? '›' : ' ';
    const desc = item.description ? ` · ${plain(item.description)}` : '';
    out.push(`${cur} [${item.ticked ? 'x' : ' '}] ${item.n}  ${quoted(item)}${desc}`);
    const ev = item.evidence.map(plain).map((e) => ` ${e.charAt(0).toUpperCase()}${e.slice(1)}.`).join('');
    const into = foldTarget(item, items);
    const fold = into ? ` · ${fill(INIT_COPY.foldHint!, { n: into.n })}` : '';
    out.push(`         ${countSentence(item, facts.repoName)}${ev} · ${scopeWords(item)}${fold}`);
    if (state.open === at) for (const l of state.openLines ?? []) out.push(`         ${spaced(l)}`);
  });
  out.push('');
  if (state.note) out.push(state.note);
  out.push(INIT_COPY.keys1!, INIT_COPY.keys2!);
  if (!facts.skills) out.push(INIT_COPY.skillsOff!);
  return out;
}

/** One relayed item: `{n}. {title} ({kind}) · {count} · {scope}`. */
export function relayItemLine(item: InitItem, repoName: string): string {
  const kind = item.kind === 'preference' ? 'learning, your own words' : item.kind === 'guardrail' ? 'always follow' : item.kind === 'review' ? 'from pull requests' : item.kind === 'session' ? 'from your past sessions' : item.kind === 'claude' ? 'from what your Claude keeps' : item.kind;
  return `${item.n}. ${quoted(item)} (${kind}) · ${countSentence(item, repoName).replace(/\.$/, '')} · ${scopeWords(item)}`;
}

/**
 * The list between the agent's lead and the keep line, the same for the relay and the handover (3.1 step 10), so a
 * list rebuilt from the record reads as the one printed.
 */
export function relayBlock(items: InitItem[], repoName: string, agent: boolean): string[] {
  const list = items.map((i) => relayItemLine(i, repoName));
  const draft = items.some((i) => i.kind === 'skill') ? [DRAFT_LINE.replace('init-1', `init-${items.find((i) => i.kind === 'skill')!.n}`)] : [];
  if (!agent) return [...list, ...draft, INIT_COPY.pickInTerminal!];
  return [directive(null, INIT_COPY.agentLead!), RELAY_LINE, ...list, ...draft, KEEP_LINE, INIT_COPY.agentKeep!];
}

/** 4.8: the found line, then the list (agent: who it is from, RELAY_LINE, the list, draft, KEEP_LINE; a script: no RELAY_LINE). */
export function relayLines(items: InitItem[], facts: ScreenFacts): string[] {
  const out = headLines(items, facts, true);
  if (!items.length) return [...out, INIT_COPY.nothing!];
  return [...out, ...relayBlock(items, facts.repoName, facts.agent)];
}

const counts = (items: Array<Pick<InitItem, 'kind'>>) => {
  const n = (k: InitKind) => items.filter((i) => i.kind === k).length;
  return `${plural(n('skill'), 'skill')}, ${plural(n('guardrail'), 'always-follow learning')} and ${plural(n('preference'), 'learning')}`;
};

/** `--yes`'s line (4.9): an agent's keeps nothing; the person's script keeps only their own words. */
export function yesLine(items: Array<Pick<InitItem, 'kind'>>, agent: boolean): string {
  return fill(agent ? INIT_COPY.yesAgent! : INIT_COPY.yesScript!, { found: counts(items) });
}

/** After a keep (4.7 "After"). `how`: the key that ended the screen, or the path that kept. */
export function afterKeepLines(r: KeepResult & { how?: 'enter' | 'n' | 'esc' | 'keep' | 'yes' }, facts: ScreenFacts): string[] {
  const out: string[] = [];
  const kept = r.kept.length;
  if (r.how === 'esc') return [INIT_COPY.afterEsc!];
  if (!kept && !r.refused.length) return [INIT_COPY.afterN!];
  if (kept) {
    const inRepo = r.kept.filter((i) => i.scope === 'repo' || i.kind === 'review' || i.kind === 'session' || i.kind === 'claude').length;
    out.push(inRepo ? fill(INIT_COPY.keptMixed!, { k: kept, j: kept - inRepo, r: inRepo }) : fill(INIT_COPY.kept!, { k: kept }));
  }
  for (const x of r.refused) out.push(fill(INIT_COPY.refused!, { name: plain(x.item.title) }));
  for (const f of r.folded ?? []) out.push(fill(INIT_COPY.folded!, { pref: quoted(f.item), skill: plain(f.skill) }));
  if (r.notKept.length) out.push(fill(INIT_COPY.notKept!, { names: r.notKept.map((i) => quoted(i)).join(', '), them: r.notKept.length === 1 ? 'it' : 'them' }));
  if (facts.skills) out.push(facts.offers === 'off' ? fill(INIT_COPY.offersOff!, { date: dayWords(facts.offersOffAt) || 'an earlier day' }) : INIT_COPY.offersOn!);
  return out;
}
