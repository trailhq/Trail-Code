/**
 * Under trail, a sign in the transcript that the session found something the
 * code won't tell the next person asks the agent to save a learning: the Stop
 * hook blocks the stop with the reason. Each sign once, at most three a
 * session, and a saved learning starts the signs over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { main } from '../src/claude/hooks.js';
import { askAnswer, fileWordRe, noteAsk, noteSignals } from '../src/claude/note-signals.js';
import { ensureRepoHome } from '../src/notes/home.js';

let n = 0;
const uid = () => `u${++n}`;
const prompt = (text: string) => [{ type: 'user', uuid: uid(), message: { role: 'user', content: text } }];
const meta = (text: string) => [{ type: 'user', isMeta: true, uuid: uid(), message: { role: 'user', content: text } }];
const say = (text: string) => [{ type: 'assistant', uuid: uid(), message: { role: 'assistant', content: [{ type: 'text', text }] } }];
function tool(name: string, input: object, out = 'ok', error = false) {
  const id = `tu${++n}`;
  return [
    { type: 'assistant', uuid: uid(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', uuid: uid(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out, is_error: error }] } },
  ];
}
const bash = (command: string, out = 'ok', error = false) => tool('Bash', { command }, out, error);
const REPO = '/work/app';
const edit = (file: string, repo = REPO) => tool('Edit', { file_path: join(repo, file), old_string: 'a', new_string: 'b' });
const jsonl = (...parts: object[][]) => parts.flat().map((e) => JSON.stringify(e)).join('\n');
const kinds = (text: string, repo = REPO) => noteSignals(text, repo).map((s) => s.kind);

test('a check that failed, then passed after an edit to the code, is a sign', () => {
  const fixed = jsonl(prompt('fix the retry bug'), bash('npm test', 'Exit code 1\n2 failed', true), edit('src/retry.ts'), bash('npm test 2>&1 | tail -5', '# fail 0\n# pass 12'));
  const [s] = noteSignals(fixed, REPO);
  assert.equal(s?.kind, 'fixed');
  assert.equal(s?.what, 'npm test failed once, then passed after your change to src/retry.ts.');
  assert.match(noteAsk(s!), /^\[trail\] npm test failed once, then passed after your change to src\/retry\.ts\. If the cause isn't obvious from the diff, save it: `trail note --title "<the decision in plain words a teammate understands, no file names>"`, with the why\. Nothing worth keeping\? Say so and stop\.\nPut files, commands and values in the body under "In the code:"\./);

  const thrice = jsonl(prompt('fix it'), bash('go test ./...', 'x', true), edit('a.go'), bash('go test ./pkg/...', 'x', true), bash('go test -run X ./...', 'x', true), edit('b.go'), bash('go test ./...', 'ok'));
  assert.match(noteSignals(thrice, REPO)[0]!.what, /^go test failed 3 times, then passed after your change to b\.go\.$/);

  const piped = jsonl(prompt('fix it'), bash('go test ./... | tail', 'FAIL\tgithub.com/x/y\t0.2s'), edit('y.go'), bash('go test ./... | tail', 'ok  \tgithub.com/x/y\t0.1s'));
  assert.deepEqual(kinds(piped), ['fixed'], 'a pipe hid the exit code, the output did not');

  assert.deepEqual(kinds(jsonl(prompt('x'), bash('npm test', 'x', true), bash('npm test', 'ok'))), [], 'flaky, not fixed: no edit between');
  assert.deepEqual(kinds(jsonl(prompt('x'), bash('npm test', 'x', true), edit('.claude/settings.json'), bash('npm test', 'ok'))), [], "an edit to trail's files is setup");
  assert.deepEqual(kinds(jsonl(prompt('x'), bash('npm test', 'x', true), tool('Edit', { file_path: '/elsewhere/z.ts' }), bash('npm test', 'ok'))), [], 'an edit outside the repo');
  assert.deepEqual(kinds(jsonl(prompt('x'), bash('npm test', 'x', true), edit('a.ts'), bash('npm run build', 'ok'))), [], 'a different check passing');
});

test('a fix made through the shell (a script that rewrites the file) counts as the edit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'trail-shell-edit-'));
  mkdirSync(join(repo, 'backend', 'internal', 'models'), { recursive: true });
  writeFileSync(join(repo, 'backend', 'internal', 'models', 'app_tool.go'), 'package models\n');
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude', 'settings.json'), '{}');
  // The transcript records the session's folder on each call; the script names the file relative to it.
  const inDir = (cwd: string, parts: object[]) => parts.map((e: any) => (e.type === 'assistant' ? { ...e, cwd } : e));
  const script = "cd internal/models && python3 - <<'E'\np='app_tool.go'\ns=open(p).read()\nopen(p,'w').write(s)\nE";
  const fixed = jsonl(prompt('add it'), bash('go test ./internal/models/', 'FAIL', true), inDir(join(repo, 'backend'), bash(script)), bash('go test ./internal/models/', 'ok'));
  assert.equal(noteSignals(fixed, repo)[0]?.what, 'go test failed once, then passed after your change to backend/internal/models/app_tool.go.');
  const sed = jsonl(prompt('add it'), bash('go test ./...', 'FAIL', true), bash(`sed -i '' 's/a/b/' ${join(repo, 'backend/internal/models/app_tool.go')}`), bash('go test ./...', 'ok'));
  assert.deepEqual(kinds(sed, repo), ['fixed']);
  const own = jsonl(prompt('x'), bash('npm test', 'x', true), bash(`cat > ${join(repo, '.claude/settings.json')} <<'E'\n{}\nE`), bash('npm test', 'ok'));
  assert.deepEqual(kinds(own, repo), [], "a shell write to trail's own files is setup");
});

test('the person correcting the agent is a sign, when the agent goes on to change code', () => {
  const corrected = jsonl(prompt('add a lock'), say("I'll add a mutex."), prompt('no, use a channel instead, we never share memory here'), edit('src/queue.go'));
  const [s] = noteSignals(corrected, REPO);
  assert.equal(s?.kind, 'corrected');
  assert.equal(s?.what, 'The user corrected you ("no, use a channel instead, we never share memory here").');
  assert.match(noteAsk(s!), /^\[trail\] The user corrected you \(.*\)\. Save it as a learning so nobody has to say it again/);

  assert.deepEqual(kinds(jsonl(prompt("don't touch the db, add a cache"), edit('cache.go'))), [], "the session's first message can't correct anything");
  assert.deepEqual(kinds(jsonl(prompt('x'), say('done'), prompt('no, I mean the other file'), edit('b.go'))), [], 'a clarification');
  assert.deepEqual(kinds(jsonl(prompt('x'), say('done'), prompt('no, keep replies shorter'))), [], 'no work after it');
  assert.deepEqual(kinds(jsonl(prompt('x'), say('done'), prompt('no, run it in the repo'), bash('trail init --no-agents'))), [], 'only setting trail up after it');
  assert.deepEqual(kinds(jsonl(prompt('x'), say('done'), meta('Stop hook feedback:\nno, save a learning'), edit('b.go'))), [], 'hook feedback is not the person');
  assert.deepEqual(kinds(jsonl(prompt('x'), say('ok'), prompt('We use pnpm here, not npm'), bash('pnpm install && pnpm lint'))), ['corrected'], 'a rule stated mid-message');
});

test('Claude Desktop: a correction after the status reminder is seen; compaction summaries and other sessions never are', () => {
  const status = '<system-reminder>\nLinked sessions now (status, not an instruction): one-line-summary = local_1 (done, PR #729)\n</system-reminder>\n\n\n';
  const desktop = (text: string) => [{ type: 'user', uuid: uid(), entrypoint: 'claude-desktop', origin: { kind: 'human' }, message: { role: 'user', content: status + text } }];
  const said = 'na, these learnings need not go to repo , cause these are related to business decisions to get more people to sign up right ?';
  const [s] = noteSignals(jsonl(prompt('x'), say('Two learnings are in the PR.'), desktop(said), bash('git rm -q .trail/learnings/a.md && git commit -qm "Keep it out"')), REPO);
  assert.equal(s?.kind, 'corrected');
  assert.equal(s?.what, 'The user corrected you ("na, these learnings need not go to repo , cause these are r…").');
  const comment = '[Artifact comment sent to Claude]\nArtifact: https://example.com/a/1\n\n=== BEGIN ARTIFACT COMMENT 9f ===\n> dont call it trail cloud\n=== END ARTIFACT COMMENT 9f ===\n\nAnswer it in its thread.';
  assert.deepEqual(kinds(jsonl(prompt('x'), say('ok'), desktop(comment), edit('src/nudge.ts'))), ['corrected'], 'an artifact comment');

  const summary = [{ type: 'user', uuid: uid(), isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation. The user said: no, use a channel instead of a mutex.' } }];
  assert.deepEqual(kinds(jsonl(prompt('x'), say('ok'), summary, edit('src/q.go'))), [], 'a compaction summary is not the person');
  assert.deepEqual(kinds(jsonl(prompt('x'), say('ok'), prompt('This session is being continued from a previous conversation. Instead of a mutex, use a channel.'), edit('src/q.go'))), [], 'nor is its text without the flag');
  const peer = [{ type: 'user', uuid: uid(), origin: { kind: 'peer' }, message: { role: 'user', content: 'no, the other session should not use the cache' } }];
  assert.deepEqual(kinds(jsonl(prompt('x'), say('ok'), peer, edit('src/q.go'))), [], "another session's message is not the person");
});

test('keeping something out of the repo is a correction; questions and look-alikes are not', () => {
  const after = (text: string) => kinds(jsonl(prompt('x'), say('ok'), prompt(text), edit('src/a.ts')));
  for (const said of ['keep it out of the repo', "this shouldn't go in the repo", 'not in the repo, keep it personal', 'these need not be committed', 'na, leave it']) {
    assert.deepEqual(after(said), ['corrected'], said);
  }
  for (const said of ['is this not in the repo yet?', 'you need not ask before running the tests', 'nan values break the chart', 'can you put this in the repo?', 'naming is fine']) {
    assert.deepEqual(after(said), [], said);
  }
});

test('the corrected and shipped asks say business reasoning goes in --personal, never the repo', () => {
  for (const kind of ['corrected', 'shipped'] as const) {
    const ask = noteAsk({ kind, key: `${kind}:u`, what: 'x.' });
    assert.match(ask, /Add --personal when it's about how this person likes to work, or about business, growth, sign-up, pricing or competitor reasoning or internal numbers: those never go in the repo, even if you also keep your own copy\./);
  }
});

test('an undone edit is a sign, unless it only undid trail files', () => {
  assert.deepEqual(kinds(jsonl(prompt('x'), edit('src/a.ts'), bash('git restore src/a.ts'))), ['undone']);
  assert.match(noteSignals(jsonl(prompt('x'), bash('git revert abc123')), REPO)[0]!.what, /^You undid a change \(`git revert abc123`\)\.$/);
  assert.deepEqual(kinds(jsonl(prompt('x'), bash('git checkout -- .claude/settings.json'))), []);
  assert.deepEqual(kinds(jsonl(prompt('x'), bash('git restore src/a.ts', 'error: pathspec', true))), [], 'a failed undo undid nothing');
});

test('the person picking one of the options the agent offered is a sign', () => {
  const offered = jsonl(prompt('make retries safe'), say('Two ways:\n1. A mutex around the counter\n2. A channel of tokens\nWhich one?'), prompt('2'), edit('src/retry.go'));
  const [s] = noteSignals(offered, REPO);
  assert.equal(s?.kind, 'chose');
  assert.equal(s?.what, 'The user picked one of your options ("2").');
  assert.deepEqual(kinds(jsonl(prompt('x'), say('Do you want A or B?'), prompt('2'), edit('a.go'))), [], 'no list of options');
  assert.deepEqual(kinds(jsonl(prompt('x'), say('Options:\n1. A\n2. B\nWhich?'), prompt('2'))), [], 'nothing built after');
  const asked = jsonl(prompt('x'), tool('AskUserQuestion', { questions: [] }, 'User has answered your questions: "Lock?"="Channel of tokens"'), edit('a.go'));
  assert.equal(noteSignals(asked, REPO)[0]!.what, 'The user picked one of your options ("\'Lock?\'=\'Channel of tokens\'").');
});

test('committing, pushing or opening a PR for code with no learning is a sign', () => {
  assert.deepEqual(kinds(jsonl(prompt('x'), edit('a.go'), bash('git add a.go && git commit -m fix'))), ['shipped']);
  assert.match(noteSignals(jsonl(prompt('x'), edit('a.go'), bash('gh pr create --fill')), REPO)[0]!.what, /^You opened a PR for this work/);
  assert.deepEqual(kinds(jsonl(prompt('x'), bash('git commit -m "trail setup"'))), [], 'no code edited this session');
  assert.deepEqual(kinds(jsonl(prompt('x'), edit('.trail/learnings/x.md'), bash('git commit -m learning'))), [], 'committing a learning');
  const learned = noteSignals(jsonl(prompt('x'), edit('a.go'), bash('git push')), REPO, () => true);
  assert.deepEqual(learned.map((s) => s.kind), [], "the branch's commits already add a learning");
});

test('writes outside the repo are no code edit: Claude memory after a cd, a PR body in a scratch file', () => {
  const memory = "cd ~/.claude/projects/-work-app/memory && python3 - <<'PY'\np='MEMORY.md'\ns=open(p).read()\nopen(p,'w').write(s)\nPY";
  assert.deepEqual(kinds(jsonl(prompt('x'), bash(memory), bash('git push -q --force-with-lease'))), []);
  const body = 'P=/private/tmp/scratch/pr-body.md && sed -i \'\' \'s/one/two/\' "$P" && gh pr edit 730 --body-file "$P"';
  assert.deepEqual(kinds(jsonl(prompt('x'), bash(body), bash('git push'))), []);
  assert.deepEqual(kinds(jsonl(prompt('x'), tool('Write', { file_path: '/home/me/.claude/memory/x.md' }), bash('git push'))), []);
  // Still a code edit: a write this can't name, from inside the repo.
  assert.deepEqual(kinds(jsonl(prompt('x'), bash("python3 - <<'PY'\nopen(p,'w').write(s)\nPY"), bash('git push'))), ['shipped']);
});

test("the stop after an ask reads whether a learning was saved in answer, in the repo or personal; another hook's block isn't trail's", () => {
  const ask = noteAsk({ kind: 'corrected', key: 'corrected:u', what: 'The user corrected you ("na").' });
  const asked = [prompt('x'), say('ok'), meta(`Stop hook feedback:\n${ask}`)];
  assert.equal(askAnswer(jsonl(...asked, bash('trail note --personal --title "Growth reasoning stays out of the repo" <<\'EOF\'', '✓ saved just for you'))), 'personal');
  assert.equal(askAnswer(jsonl(...asked, bash('trail note --title "x" <<\'EOF\'', '✓ added to this repo'))), 'repo');
  assert.equal(askAnswer(jsonl(...asked, bash('trail note --title "x"', '✗ not saved yet', true))), 'no', 'the gate turned it away');
  assert.equal(askAnswer(jsonl(...asked, say('Nothing worth keeping.'))), 'no');
  assert.equal(askAnswer(jsonl(bash('trail note --title "x"', '✓'), ...asked)), 'no', 'a learning saved before the ask');
  assert.equal(askAnswer(jsonl(...asked, meta('Stop hook feedback:\nlint failed'))), null, "another hook's block");
  assert.equal(askAnswer(jsonl(prompt('x'), say('ok'))), null, 'no ask');
});

test('a turn that read a lot to find its answer is a sign, with no edit needed', () => {
  const big = 'x'.repeat(130_000);
  const read = (file: string, out: string) => tool('Read', { file_path: join(REPO, file) }, out);
  const [s] = noteSignals(jsonl(prompt('where does the retry budget live?'), read('src/retry.ts', big)), REPO);
  assert.equal(s?.kind, 'explored');
  assert.equal(s!.what, 'This turn took about 33k tokens of reading to work out.');
  assert.match(noteAsk(s!), /^\[trail\] This turn took about 33k tokens of reading to work out\. If it found where something lives or why it works the way it does/);
  assert.deepEqual(kinds(jsonl(prompt('why do retries stall?'), tool('Grep', { pattern: 'retry' }, big))), ['explored'], 'search results count');
  assert.deepEqual(kinds(jsonl(prompt('how does auth work?'), bash('trail ask "auth"', '[trail] tokens saved ≈ 31,200\n…'))), ['explored'], "what trail's answers stood in for counts");
  assert.deepEqual(kinds(jsonl(prompt('x'), bash('trail ask "x"', '[trail] learnings saved ≈ 900,000 tokens'))), [], "a reused learning's own line doesn't");
  assert.deepEqual(kinds(jsonl(prompt('x'), read('src/a.ts', 'x'.repeat(40_000)))), [], 'under 30k tokens');
  assert.deepEqual(kinds(jsonl(prompt('x'), read('.trail/learnings/a.md', big))), [], "reading trail's own files");
  assert.deepEqual(kinds(jsonl(prompt('x'), read('src/a.ts', big), prompt('thanks'), say('ok'))), [], 'only the turn that just ended counts');
  assert.deepEqual(kinds(jsonl(prompt('x'), read('src/a.ts', big), bash('trail note --title "x" <<EOF', '✓ saved for your team'))), [], 'a saved learning starts it over');
});

test('a saved learning starts the signs over; one the gate turned away does not; the best sign comes first', () => {
  const fixed = [prompt('x'), bash('npm test', 'x', true), edit('a.ts'), bash('npm test', 'ok')];
  assert.deepEqual(kinds(jsonl(...fixed, bash('trail note --title "x" <<EOF', '✓ saved for your team'))), []);
  assert.deepEqual(kinds(jsonl(...fixed, bash('trail note --title "x" <<EOF', '✗ not saved yet', true))), ['fixed']);
  assert.deepEqual(kinds(jsonl(...fixed, bash('git commit -am fix'))), ['fixed', 'shipped']);
  assert.deepEqual(kinds('not json\n'), []);
});

async function stop(input: object): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  // Only the hook's strings: the test runner's own reports pass through, as the other hook tests do.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? ((out += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.env.GRAFT_TEST_STDIN = JSON.stringify(input);
  try {
    await main('stop');
  } finally {
    process.stdout.write = write;
    delete process.env.GRAFT_TEST_STDIN;
  }
  return out;
}

test('the Stop hook asks once per sign, three times a session at most, and never on the stop after a block', async () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'note-ask-home-'));
  process.env[BRAND_ENV] = 'trail';
  const d = mkdtempSync(join(tmpdir(), 'note-ask-repo-'));
  mkdirSync(join(d, 'graft', '.cache', 'session'), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = d;
  ensureRepoHome(d);
  const t = join(d, 't.jsonl');
  writeFileSync(t, jsonl(prompt('dig'), bash('ls'), bash('cat a'), bash('grep x'), bash('sed -n 1p a')));
  assert.equal(await stop({ session_id: 's1', transcript_path: t }), '', 'tool calls alone are no sign');

  appendFileSync(t, '\n' + jsonl(bash('npm test', 'x', true), edit('src/a.ts', d), bash('npm test', 'ok')));
  assert.equal(await stop({ session_id: 's1', transcript_path: t, stop_hook_active: true }), '', 'not on the stop a block caused');
  const first = JSON.parse(await stop({ session_id: 's1', transcript_path: t }));
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /^\[trail\] npm test failed once, then passed after your change to src\/a\.ts\./);
  assert.equal(await stop({ session_id: 's1', transcript_path: t }), '', 'each sign once');

  appendFileSync(t, '\n' + jsonl(say('done'), prompt('no, keep it in one file'), edit('src/b.ts', d)));
  assert.match(JSON.parse(await stop({ session_id: 's1', transcript_path: t })).reason, /^\[trail\] The user corrected you/);
  appendFileSync(t, '\n' + jsonl(bash('git restore src/b.ts')));
  assert.match(JSON.parse(await stop({ session_id: 's1', transcript_path: t })).reason, /^\[trail\] You undid a change/);
  appendFileSync(t, '\n' + jsonl(bash('git commit -am wip')));
  assert.equal(await stop({ session_id: 's1', transcript_path: t }), '', 'three asks a session at most');
  assert.notEqual(await stop({ session_id: 's2', transcript_path: t }), '', 'a new session is asked again');
});

test('one fail then pass asks once: rerunning the passing check after the answer asks nothing more', async () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'note-ask-home-'));
  process.env[BRAND_ENV] = 'trail';
  const d = mkdtempSync(join(tmpdir(), 'note-ask-repo-'));
  mkdirSync(join(d, 'graft', '.cache', 'session'), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = d;
  ensureRepoHome(d);
  const t = join(d, 't.jsonl');
  writeFileSync(t, jsonl(prompt('fix the retry bug'), bash('npm test', 'x', true), edit('src/a.ts', d), bash('npm test', 'ok')));
  assert.match(JSON.parse(await stop({ session_id: 's3', transcript_path: t })).reason, /^\[trail\] npm test failed once/);
  appendFileSync(t, '\n' + jsonl(say('Nothing worth keeping.')));
  assert.equal(await stop({ session_id: 's3', transcript_path: t, stop_hook_active: true }), '');
  for (const again of ['run the tests again', 'and once more']) {
    appendFileSync(t, '\n' + jsonl(prompt(again), bash('npm test', 'ok'), say('All pass.')));
    assert.equal(await stop({ session_id: 's3', transcript_path: t }), '', `${again}: the same fail and pass, already answered`);
  }
  // A new failure and fix is a new sign.
  appendFileSync(t, '\n' + jsonl(prompt('now the timeout bug'), bash('npm test', 'x', true), edit('src/b.ts', d), bash('npm test', 'ok')));
  assert.match(JSON.parse(await stop({ session_id: 's3', transcript_path: t })).reason, /^\[trail\] npm test failed/);
});

test("a shell edit's file is read whole on Windows too: the drive, backslashes, Git Bash's slashes, a short name", () => {
  const cmd = "sed -i '' 's/4/6/' C:\\Users\\priya\\shop\\src\\client.ts && cat C:/Users/priya/shop/go.mod D:\\RUNNER~1\\shop\\main.go";
  assert.deepEqual(cmd.match(fileWordRe('win32')), ['C:\\Users\\priya\\shop\\src\\client.ts', 'D:\\RUNNER~1\\shop\\main.go']);
  assert.deepEqual("sed -i 's/4/6/' /work/app/src/client.ts".match(fileWordRe('linux')), ['/work/app/src/client.ts']);
  assert.deepEqual("sed -i 's/4/6/' C:/work/app/src/client.ts".match(fileWordRe('win32')), ['C:/work/app/src/client.ts']);
});
