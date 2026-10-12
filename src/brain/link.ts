/**
 * The link between a repo's graft graph and a Trail brain.
 *
 * A brain holds the rules mined out of this repository's history — what the
 * team decided and why, which the code graph cannot see. Graft holds the code
 * and can say which symbols an answer touches. This module is the join: the
 * token identifying the brain, and the rules cached beside it so `ask` never
 * waits on the network.
 *
 * The link lives in the per-repo, git-ignored `.graft/config.json`, next to the
 * other persisted build choices. Not in `~/.graft/`: a brain belongs to one
 * repository, and two checkouts of different repos on one machine must not
 * share one.
 */
import { readBuildConfig, patchBuildConfig, cacheDir, readJson, writeJsonAtomic } from '../util/state.js';
import { join } from 'node:path';
import { ensureGitignored, LINK_NOTE } from '../context/node-file.js';
import { BUILD_CONFIG_DIR } from '../util/state.js';

/** Default API host. Overridden by GRAFT_BRAIN_URL, for staging and self-hosted. */
const DEFAULT_BRAIN_BASE_URL = 'https://agents.nanonets.com';

/** How long a cached rule set is served before upkeep refreshes it. */
export const RULES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * The TTL used while the cache holds NO rules.
 *
 * A brain is connected during onboarding while it is still being mined, so the
 * first pull legitimately returns nothing. Six hours of that is the difference
 * between the feature working and the user concluding it does not: they wired
 * graft up, got an empty rulebook, and nothing would go back for the real one
 * until tomorrow. Two minutes costs one cheap request per session until the
 * rules land, and then the normal TTL takes over.
 */
export const EMPTY_RULES_TTL_MS = 2 * 60 * 1000;

/** One rule from the brain, anchored to a symbol in this repo. */
export interface BrainRule {
  ruleId: string;
  /** A graft node id: `<path>#<QualifiedName>`. */
  symbol: string;
  /** The symbol's body hash when the rule was mined; '' when unrecorded. */
  fingerprint: string;
  rule: string;
  /** Deep link to the commit or pull request that established it. */
  sourceUrl?: string;
}

/** The cached rule set, as stored under the repo's graft cache. */
export interface RulesCache {
  brainId: string;
  fetchedAt: number;
  rules: BrainRule[];
  /** When a refresh was last ATTEMPTED, successful or not. Separate from
   * `fetchedAt`, which records when rules last actually arrived: without the
   * distinction, a brain that is still building would be re-checked on every
   * single command, because its `fetchedAt` never advances. */
  checkedAt?: number;
}

/** The persisted brain link. */
export interface BrainLink {
  brainId: string;
  /** Workspace API key (`nn...`). Stored in the git-ignored `.graft/`. */
  token: string;
  /** Set only when the user pointed graft at a non-default host. */
  baseUrl?: string;
}

/**
 * The link for repo `dir`, or null when it has none.
 *
 * `GRAFT_BRAIN_TOKEN` / `GRAFT_BRAIN_ID` override the stored pair, so CI can
 * attach a brain without writing to the checkout.
 */
export function readLink(dir: string): BrainLink | null {
  const envToken = process.env.GRAFT_BRAIN_TOKEN;
  const envBrain = process.env.GRAFT_BRAIN_ID;
  if (envToken && envBrain) {
    return { brainId: envBrain, token: envToken, baseUrl: process.env.GRAFT_BRAIN_URL };
  }
  const stored = readBuildConfig(dir)?.brain;
  if (!stored?.brainId || !stored?.token) return null;
  return stored;
}

/** Persist the link for repo `dir`, merging into any existing build config.
 *
 * The write is what creates `.graft/config.json`, and that file holds the read
 * token — which is exactly why this is also where it gets ignored. The comment
 * on {@link BrainLink} has claimed `.graft/` was "git-ignored" since the day it
 * was written, and nothing ever made it true: `ensureGitignored` only ever ran
 * for the graph cache. Every repository anyone ran `graft trail connect` in was
 * therefore one `git add -A` away from publishing a credential. */
export function writeLink(dir: string, link: BrainLink): void {
  patchBuildConfig(dir, { brain: link });
  ensureGitignored(dir, join(dir, BUILD_CONFIG_DIR), LINK_NOTE);
}

/** Forget the link for repo `dir`. Leaves the cached rules for `uninstall` to remove. */
export function clearLink(dir: string): void {
  patchBuildConfig(dir, { brain: undefined });
}

/** Where the rule cache lives: beside the graph, since it is derived data. */
export function rulesCachePath(dir: string): string {
  return join(cacheDir(dir), 'brain-rules.json');
}

export function readRulesCache(dir: string): RulesCache | null {
  return readJson<RulesCache>(rulesCachePath(dir));
}

export function writeRulesCache(dir: string, cache: RulesCache): void {
  writeJsonAtomic(rulesCachePath(dir), cache, true);
}

/**
 * Whether a cached set is old enough to refetch.
 *
 * Keyed off the last ATTEMPT, not the last success, and with a much shorter
 * window while the cache is empty — see EMPTY_RULES_TTL_MS for why that case
 * is the one that matters.
 */
export function cacheIsStale(cache: RulesCache | null, now = Date.now()): boolean {
  if (!cache) return true;
  const ttl = cache.rules.length === 0 ? EMPTY_RULES_TTL_MS : RULES_TTL_MS;
  return now - (cache.checkedAt ?? cache.fetchedAt) > ttl;
}

/** Record that a refresh was attempted, without claiming rules arrived. */
export function markRulesChecked(dir: string, now = Date.now()): void {
  const cache = readRulesCache(dir);
  if (!cache) return;
  writeRulesCache(dir, { ...cache, checkedAt: now });
}

/**
 * The base URL for a link, honouring the env override first so a misconfigured
 * stored value can always be corrected without editing a file.
 */
export function baseUrlFor(link: BrainLink): string {
  return (process.env.GRAFT_BRAIN_URL || link.baseUrl || DEFAULT_BRAIN_BASE_URL).replace(/\/+$/, '');
}

/** The API host before there is a link to read one from: signing up. */
export function apiBaseUrl(): string {
  return (process.env.GRAFT_BRAIN_URL || DEFAULT_BRAIN_BASE_URL).replace(/\/+$/, '');
}

/** A sign-up an agent-run push started and has not collected yet. */
export interface PendingSignup {
  /** The state in the link, which is what claims the trail. */
  state: string;
  /** The repository the link was for, so a changed remote starts over. */
  repo: string;
  createdAt: number;
}

/** The sign-up waiting on repo `dir`, or null when there is none or it is too
 * old to claim, or it was for a different repository. */
export function readPendingSignup(dir: string, repo: string, maxAgeMs: number, now = Date.now()): PendingSignup | null {
  const p = readBuildConfig(dir)?.pendingSignup;
  if (!p?.state || p.repo !== repo || !(now - p.createdAt < maxAgeMs)) return null;
  return p;
}

/** Save the sign-up an agent-run push just started. Git-ignored like the link,
 * because the state claims a read token. */
export function writePendingSignup(dir: string, pending: PendingSignup): void {
  patchBuildConfig(dir, { pendingSignup: pending });
  ensureGitignored(dir, join(dir, BUILD_CONFIG_DIR), LINK_NOTE);
}

export function clearPendingSignup(dir: string): void {
  patchBuildConfig(dir, { pendingSignup: undefined });
}

/** Timeout for one rules fetch. Short: `ask` must never block on this. */
const FETCH_TIMEOUT_MS = 5000;

interface AnchorsResponse {
  anchors?: Array<{
    rule_id?: string;
    symbol?: string;
    fingerprint?: string;
    rule?: string;
    source_url?: string;
  }>;
}

/**
 * Fetch the brain's symbol-anchored rules.
 *
 * Returns null on any failure — an unreachable brain, a revoked token, a
 * malformed body. Never throws: `ask` degrades to the code-only answer it gave
 * before a brain was attached, which is the whole reason the cache exists.
 */
export async function fetchRules(
  link: BrainLink,
  fetchImpl: typeof fetch = fetch,
): Promise<BrainRule[] | null> {
  // The PUBLIC, token-authenticated route: graft runs on a laptop with no
  // session, and the token it holds is scoped to this one brain rather than the
  // workspace. The protected route is for the app itself.
  const url = `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/rules/anchors`;
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${link.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as AnchorsResponse;
    if (!Array.isArray(body.anchors)) return null;
    const out: BrainRule[] = [];
    for (const a of body.anchors) {
      if (!a?.symbol || !a?.rule) continue;
      out.push({
        ruleId: String(a.rule_id ?? ''),
        symbol: a.symbol,
        fingerprint: String(a.fingerprint ?? ''),
        rule: a.rule,
        sourceUrl: a.source_url || undefined,
      });
    }
    return out;
  } catch {
    return null;
  }
}
