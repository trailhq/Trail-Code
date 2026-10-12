/**
 * The push now holds the line instead of handing the prompt back, so what is
 * worth testing is the thing that made holding worthwhile: that a build which
 * dies is reported, and reported at the stage it actually died at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureLines, linesFor, stagesFrom, watchBuild, type RepoState } from '../src/brain/watch.js';
import { brainUrl } from '../src/brain/signup.js';

const row = (over: Partial<RepoState> = {}): RepoState => ({
  status: 'ingesting',
  ruleCount: 0,
  commitCount: 0,
  threadCount: 0,
  ...over,
});

const stateOf = (repo: RepoState | null, id: string) => stagesFrom(repo).stages.find((s) => s.id === id)?.state;

// --- where a failure lands ---------------------------------------------------

// The one that matters. A repo read successfully and then lost in the miner
// must not report itself as unreachable: that sends someone to fix repository
// access for a problem that has nothing to do with access.
test('a build that read the history and then died fails at the miner, not the access check', () => {
  const repo = row({
    status: 'failed',
    commitCount: 412,
    threadCount: 89,
    errorMessage: 'mine repository history: parse response: unexpected end of JSON input',
  });
  assert.equal(stateOf(repo, 'reach'), 'done');
  assert.equal(stateOf(repo, 'read'), 'done');
  assert.equal(stateOf(repo, 'mine'), 'failed');
  assert.match(stagesFrom(repo).error ?? '', /unexpected end of JSON input/);
});

test('a build that never read anything fails at the access check', () => {
  const repo = row({ status: 'failed', errorMessage: 'repo not accessible' });
  assert.equal(stateOf(repo, 'reach'), 'failed');
  assert.equal(stateOf(repo, 'mine'), 'waiting');
});

test('no stage after the failed one is left looking live', () => {
  const view = stagesFrom(row({ status: 'failed', commitCount: 10 }));
  const at = view.stages.findIndex((s) => s.state === 'failed');
  assert.ok(at >= 0);
  for (const s of view.stages.slice(at + 1)) assert.equal(s.state, 'waiting');
});

test('a failure with no message still says something', () => {
  assert.equal(stagesFrom(row({ status: 'failed' })).error, 'the read stopped before it finished');
});

test('done means the rules are in the brain, not just that the row closed', () => {
  assert.equal(stagesFrom(row({ status: 'completed', commitCount: 412, ruleCount: 0 })).done, false);
  assert.equal(stagesFrom(row({ status: 'completed', commitCount: 412, ruleCount: 42 })).done, true);
});

// --- what gets printed -------------------------------------------------------

// This is a log, not a redrawn frame: a line per poll for a stage that is merely
// still running would bury the four that matter under a hundred that do not.
test('only finished stages print, each once, in the past tense', () => {
  const printed = new Set<string>();
  const reading = row({ commitCount: 412, threadCount: 89 });
  const first = linesFor(stagesFrom(reading), printed, reading);
  assert.deepEqual(first, ['  ✓ reached the repository', '  ✓ read its history'], 'reach and read have settled; mine has not');
  assert.deepEqual(linesFor(stagesFrom(reading), printed, reading), [], 'nothing reprints');
  const done = row({ status: 'completed', commitCount: 412, threadCount: 89, ruleCount: 42 });
  const later = linesFor(stagesFrom(done), printed, done);
  assert.deepEqual(later, ['  ✓ mined the first 42 rules'], 'filing is left to the closing line');
});

test('a failure says where it stopped, that nothing was lost, and the server\'s own words', () => {
  const view = stagesFrom(row({ status: 'failed', commitCount: 412, errorMessage: 'parse response: unexpected end of JSON input' }));
  assert.deepEqual(failureLines(view), [
    '✗ the build stopped while mining rules · nothing was lost — run graft trail push again',
    '  parse response: unexpected end of JSON input',
  ]);
});

// --- the watcher ------------------------------------------------------------

/** A fetch that answers with each row in turn, then repeats the last. */
function fetchSeries(rows: (Record<string, unknown> | null)[]): typeof fetch {
  let i = 0;
  return (async () => {
    const repo = rows[Math.min(i++, rows.length - 1)];
    return { ok: true, json: async () => ({ repo }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Like fetchSeries, but each entry is the whole response body, so a test can
 *  carry the in-flight `build` counts the repo row does not have yet. */
function fetchBodies(bodies: Record<string, unknown>[]): typeof fetch {
  let i = 0;
  return (async () => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const LINK = { brainId: '8f2a1c04-0000-0000-0000-000000000000', token: 'gbt_1.sig' };
const NOW = { timeoutMs: 60_000, pollMs: 0, sleep: async () => {} };

test('the watcher holds until the brain is built', async () => {
  const lines: string[] = [];
  const outcome = await watchBuild(LINK, {
    ...NOW,
    write: (l) => lines.push(l),
    fetchImpl: fetchSeries([
      { status: 'pending', rule_count: 0, commit_count: 0, thread_count: 0 },
      { status: 'ingesting', rule_count: 0, commit_count: 412, thread_count: 89 },
      { status: 'completed', rule_count: 42, commit_count: 412, thread_count: 89 },
    ]),
  });
  assert.equal(outcome, 'completed');
  assert.match(lines.join('\n'), /reached the repository/);
  assert.match(lines.join('\n'), /mined the first 42 rules/);
});

test('the watcher reports a failure rather than waiting out the clock', async () => {
  const lines: string[] = [];
  const outcome = await watchBuild(LINK, {
    ...NOW,
    write: (l) => lines.push(l),
    fetchImpl: fetchSeries([
      { status: 'ingesting', rule_count: 0, commit_count: 412, thread_count: 0 },
      { status: 'failed', rule_count: 0, commit_count: 412, thread_count: 0, error_message: 'repo job carries no history to mine' },
    ]),
  });
  assert.equal(outcome, 'failed');
  assert.match(lines.join('\n'), /carries no history to mine/);
});

// A host that is down must not be reported as a build that failed: one is our
// problem and the other is the user's, and they lead to opposite next steps.
test('a build it could never read is unreachable, not failed', async () => {
  const outcome = await watchBuild(LINK, {
    ...NOW,
    timeoutMs: 0,
    write: () => {},
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
  });
  assert.equal(outcome, 'unreachable');
});

test('a build still running when the clock runs out is a timeout, not a failure', async () => {
  const outcome = await watchBuild(LINK, {
    ...NOW,
    timeoutMs: 0,
    write: () => {},
    fetchImpl: fetchSeries([{ status: 'ingesting', rule_count: 0, commit_count: 1, thread_count: 0 }]),
  });
  assert.equal(outcome, 'timed_out');
});

// --- where the browser lands -------------------------------------------------

// /brain/<id> redirects to the graph, and it redirected the moment the row
// existed — minutes before it had any rules. Every terminal signup landed on an
// empty visualisation of a brain that was building perfectly well.
test('the handoff lands on the build screen, never on an empty graph', () => {
  const url = brainUrl('8f2a1c04-0000-0000-0000-000000000000', 'https://app.trailhq.com');
  assert.ok(!url.includes('/brain/'), 'must not go to the brain route, which redirects to the graph');
  assert.match(url, /\/get-started\?step=build&brain=8f2a1c04-0000-0000-0000-000000000000$/);
});

// --- slices: the prompt comes back on the first rules -------------------------

// The history is mined in several calls now. The first returns in about ten
// seconds and the rest keep going for minutes, so holding the terminal to the
// end would be holding it through the part that neither fails nor needs
// watching.
test('mining is finished, for this watcher, as soon as rules are in the graph', () => {
  const midBuild = row({ status: 'ingesting', commitCount: 412, threadCount: 89, ruleCount: 0, foundSoFar: 62, filedSoFar: 12 });
  assert.equal(stateOf(midBuild, 'mine'), 'done');
  assert.equal(stateOf(midBuild, 'file'), 'doing');
  assert.equal(stagesFrom(midBuild).ready, true);
  assert.equal(stagesFrom(midBuild).done, false, 'the job has not finished; only the watching has');
});

// The count grows with every slice that lands, so printing it as a total would
// promise history that has not been read yet.
test('the miner count is printed as a floor, not as a total', () => {
  const view = stagesFrom(row({ status: 'ingesting', commitCount: 412, foundSoFar: 62, filedSoFar: 12 }));
  assert.equal(view.stages.find((s) => s.id === 'mine')?.detail, '62 rules so far');
});

test('nothing placed yet is not ready, however much has been read', () => {
  const view = stagesFrom(row({ status: 'ingesting', commitCount: 412, threadCount: 89, foundSoFar: 0, filedSoFar: 0 }));
  assert.equal(view.ready, false);
  assert.equal(stateOf(row({ status: 'ingesting', commitCount: 412, foundSoFar: 0 }), 'mine'), 'doing');
});

test('the watcher hands the prompt back on the first rules, while the job runs on', async () => {
  const lines: string[] = [];
  const outcome = await watchBuild(LINK, {
    ...NOW,
    write: (l) => lines.push(l),
    fetchImpl: fetchBodies([
      { repo: { status: 'pending', rule_count: 0, commit_count: 0, thread_count: 0 } },
      { repo: { status: 'ingesting', rule_count: 0, commit_count: 412, thread_count: 89 }, build: { found_so_far: 0, filed_so_far: 0 } },
      { repo: { status: 'ingesting', rule_count: 0, commit_count: 412, thread_count: 89 }, build: { found_so_far: 62, filed_so_far: 3 } },
    ]),
  });
  assert.equal(outcome, 'building');
  assert.match(lines.join('\n'), /mined the first 62 rules/);
});

// A graft pointed at a Trail that does not send the in-flight counts must fall
// back to the old behaviour rather than read a missing field as "no rules".
test('an older API with no build counts still waits for the finished row', async () => {
  const outcome = await watchBuild(LINK, {
    ...NOW,
    write: () => {},
    fetchImpl: fetchSeries([
      { status: 'ingesting', rule_count: 0, commit_count: 412, thread_count: 89 },
      { status: 'completed', rule_count: 42, commit_count: 412, thread_count: 89 },
    ]),
  });
  assert.equal(outcome, 'completed');
});
