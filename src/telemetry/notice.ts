/**
 * The one-time disclosure, and the `graft telemetry` command's output.
 *
 * The notice is the whole reason this design is defensible. Every telemetry
 * backlash in the tools we looked at — the GitHub CLI's silent 2.91.0 rollout,
 * Gatsby's on-by-default addition, the .NET SDK's opt-out that distributors now
 * patch out — was about a tool that started sending without saying so. Homebrew
 * does exactly what is done here and is uncontroversial: print once, in plain
 * language, before anything leaves, and say how to turn it off in the same
 * breath.
 *
 * Once per MACHINE, not per repo: a dev with twelve checkouts should read this
 * one time. `graft init`'s picker is the other disclosure surface, for the users
 * who see it — this catches everyone else.
 */
import { patchState, readState } from './identity.js';
import { explainOff, offReason } from './gate.js';
import { peek } from './queue.js';
import { buildBatch } from './send.js';
import { posthogHost } from './key.js';
import { brand, cmd, inBrand } from '../brand.js';

export const TELEMETRY_DOC_URL = 'https://github.com/trailhq/Trail-Code/blob/main/TELEMETRY.md';

export const NOTICE = [
  '· graft collects anonymous usage stats (no code, no file paths, no queries).',
  `  What exactly: ${TELEMETRY_DOC_URL} — turn it off with \`graft telemetry disable\`.`,
].join('\n');

/**
 * The notice text the first time it is due, then null forever after. Marks it as
 * shown before returning, so two concurrent commands print it at most twice
 * rather than every time.
 */
export function firstRunNotice(home?: string, env?: NodeJS.ProcessEnv): string | null {
  try {
    if (offReason(home, env) !== null) return null; // nothing to disclose if nothing can be sent
    if (readState(home)?.noticeShownAt) return null;
    patchState({ noticeShownAt: new Date().toISOString() }, home);
    return inBrand(NOTICE, brand(env));
  } catch {
    return null;
  }
}

/** `graft telemetry status`. `env` is a test seam, as elsewhere in this module —
 *  a real run must be gated on the real `DO_NOT_TRACK` and CI variables. */
export function formatStatus(home?: string, env?: NodeJS.ProcessEnv): string {
  const reason = offReason(home, env);
  const pending = peek(home).length;
  const lines = [
    reason === null
      ? 'telemetry: on — anonymous, aggregate-only'
      : `telemetry: ${explainOff(reason)}`,
    `  contract:  ${TELEMETRY_DOC_URL}`,
  ];
  if (reason === null || reason === 'disabled') {
    lines.push(`  endpoint:  ${posthogHost()}`);
    lines.push(`  queued:    ${pending} event${pending === 1 ? '' : 's'} waiting for the next daily flush`);
  }
  lines.push(
    reason === 'disabled'
      ? `  enable:    ${cmd('graft telemetry enable')}`
      : `  disable:   ${cmd('graft telemetry disable')}  (or set DO_NOT_TRACK=1)`,
  );
  lines.push(`  inspect:   ${cmd('graft telemetry debug')}   (prints the exact batch, sends nothing)`);
  return lines.join('\n');
}

/**
 * `graft telemetry debug` — Next.js's `NEXT_TELEMETRY_DEBUG` and Astro's
 * `DEBUG=astro:telemetry` in command form. Prints the pending queue and the
 * literal JSON body a flush would POST, and sends nothing. The point is that a
 * user never has to take our word for the contract.
 */
export function formatDebug(home?: string): string {
  const events = peek(home);
  if (events.length === 0) {
    return [
      'telemetry: nothing queued.',
      '  Run a graft command first — events are written locally and flushed once a day.',
    ].join('\n');
  }
  // A literal placeholder, never the key itself. This output is written to be
  // pasted into an issue; the project key is not the user's to share and is not
  // needed to audit what graft sends.
  const body = { api_key: '<omitted — graft\'s own ingestion key>', ...buildBatch(events) };
  return [
    `telemetry: ${events.length} event(s) queued. This is the exact body a flush would POST`,
    `to ${posthogHost()}/batch/ — running this command sends nothing.`,
    '',
    JSON.stringify(body, null, 2),
  ].join('\n');
}
