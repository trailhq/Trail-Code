/**
 * The one command a user runs to attach a brain: parse the handoff value,
 * store the link, pull the rules, write them into the agent files.
 */
import {
  readLink,
  writeLink,
  fetchRules,
  writeRulesCache,
  readRulesCache,
  type BrainLink,
  type BrainRule,
} from './link.js';
import { writeBrainSections, type BrainWrite } from './wire.js';
import { basename } from 'node:path';

/**
 * Parse the `--trail` value.
 *
 * The onboarding page hands over one string so there is one thing to copy. Two
 * accepted shapes:
 *
 *   `<brainId>:<token>`  — the normal case, both halves in one paste
 *   `<brainId>`          — with the token in `GRAFT_BRAIN_TOKEN`, for CI, where
 *                          a secret must not appear in a command line
 *
 * A bare token with no brain id is rejected rather than guessed: pointing the
 * wrong brain at a repo would write another team's rules into it.
 */
export function parseBrainArg(value: string): BrainLink | { error: string } {
  const raw = value.trim();
  if (!raw) return { error: 'empty --trail value' };
  const cut = raw.indexOf(':');
  if (cut > 0) {
    const brainId = raw.slice(0, cut).trim();
    const token = raw.slice(cut + 1).trim();
    if (!brainId || !token) return { error: 'expected --trail <brainId>:<token>' };
    return { brainId, token };
  }
  const envToken = process.env.GRAFT_BRAIN_TOKEN;
  if (!envToken) {
    return {
      error:
        'expected --trail <brainId>:<token>, or a bare brain id with the token in GRAFT_BRAIN_TOKEN',
    };
  }
  return { brainId: raw, token: envToken };
}

/** What connecting a brain did, for the caller to print. */
export interface ConnectResult {
  linked: boolean;
  ruleCount: number;
  writes: BrainWrite[];
  /** Set when the rules could not be fetched; the link is still stored. */
  warning?: string;
}

/**
 * Store the link, pull the rules once, and write them into the agent files.
 *
 * The link is stored even when the pull fails. That is deliberate: a token
 * typed correctly against a brain that is momentarily unreachable should not
 * have to be pasted again — `graft trail pull` retries, and `ask` degrades to
 * the code-only answer meanwhile.
 */
export async function connectBrain(
  repo: string,
  link: BrainLink,
  opts: { home: string; ids?: string[]; fetchImpl?: typeof fetch } = { home: '' },
): Promise<ConnectResult> {
  writeLink(repo, link);
  const rules = await fetchRules(link, opts.fetchImpl ?? fetch);
  if (rules === null) {
    return {
      linked: true,
      ruleCount: 0,
      writes: [],
      warning:
        'could not reach the brain to pull its rules — the link is saved; run `graft trail pull` to retry',
    };
  }
  writeRulesCache(repo, { brainId: link.brainId, fetchedAt: Date.now(), rules });
  const writes = writeBrainSections(repo, opts.home, rules, basename(repo), opts.ids);
  return { linked: true, ruleCount: rules.length, writes };
}

/**
 * Re-pull the rules for an already-linked repo and rewrite the agent files.
 * Returns null when the repo has no brain linked.
 */
export async function pullBrain(
  repo: string,
  opts: { home: string; ids?: string[]; fetchImpl?: typeof fetch },
): Promise<ConnectResult | null> {
  const link = readLink(repo);
  if (!link) return null;
  return connectBrain(repo, link, opts);
}

/** The linked brain and its cached rule set, for `graft trail status`. */
export function brainStatus(repo: string): {
  link: BrainLink | null;
  rules: BrainRule[];
  fetchedAt: number | null;
} {
  const link = readLink(repo);
  const cache = readRulesCache(repo);
  return { link, rules: cache?.rules ?? [], fetchedAt: cache?.fetchedAt ?? null };
}
