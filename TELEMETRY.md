# Telemetry

Trail-code collects a small set of **anonymous** usage events so we can tell whether
the thing works: how many repos get past a build, whether an agent reaches for
Trail-code or falls back to grep, which commands earn their place, and what breaks in
the wild.

This document is the complete, authoritative contract: **if an event or property
is not listed here, Trail-code does not send it.** The implementation lives in
[`src/telemetry/contract.ts`](src/telemetry/contract.ts) and enforces this list
as a hard allowlist: unknown events and unknown properties are dropped before
anything is written, let alone sent. The code and this file are kept in
lockstep, and because the repo is open source you can verify that yourself.

This page covers anonymous usage stats only. A Trail workspace you choose to
connect is separate, and sends more: see
[What stays on your machine](README.md#what-stays-on-your-machine).

Nothing is ever sent from a command you run. Events are appended to a local file
and a detached background process posts them at most once a day, so no `trail
ask` ever waits on the network.

The one exception is the `install` event below, which the npm postinstall hook
records and hands to that same detached process immediately: an install that
never runs a command would otherwise never reach a flush, and "installed and
never used" is a number we need to see. `npm install` itself still waits on
nothing: the child is detached and its output discarded.

## What is sent

Every event carries only these common properties:

| Property | Example | Notes |
| --- | --- | --- |
| `app_version` | `0.12.0` | The Trail-code version that produced the event |
| `os` | `darwin` / `win32` / `linux` | Platform, nothing more |
| `arch` | `arm64` / `x64` | CPU architecture |
| `node_major` | `20` | Major version only |
| `ci` | `false` | Always false: CI never sends (see below) |
| `agent_host` | `claude-code` / `claude-desktop` / `codex` / `cursor` / `copilot` / `mcp` / `cli` | Which surface Trail-code ran under (`claude-desktop` is the Claude desktop app's Code tab) |
| `cli_name` | `trail` / `graft` | Which of the two names started the process (graft is trail's old name) |
| `repo_id` | a random UUID | See "How it stays anonymous" |

The events:

| Event | Extra properties | When |
| --- | --- | --- |
| `install` | `global` (`true` for `npm i -g`, `false` for a project dependency) | The npm postinstall hook runs, once per machine per version |
| `first_run` | none | Once, the first time a `trail` or `graft` command runs on a machine |
| `init_completed` | `agents` (the ids you selected, sorted), `consent` | `trail init` finishes |
| `build_completed` | `files_bucket`, `langs`, `mode` (`fast`/`deep`), `duration_bucket`, `incremental` | A build succeeds |
| `build_failed` | `stage`, `code`, both fixed enums | A build throws |
| `query` | `command`, `surface` (`cli`/`mcp`/`hook`), `hit` (`ask` only), `notes` (`0`/`1`/`2`, how many learnings `ask` showed; only in a repo that keeps learnings) | Any query command |
| `brain_signup_opened` | `mode` (`terminal`/`agent`/`nudge`), and for a nudge `command` (`ask`/`note`/`check`) and `wording` (`share`/`learned`) | A trail command hands the agent a sign-in link to pass on (at most once a session) |
| `brain_signup_settled` | `outcome` (`linked`/`timed_out`/`bad_callback`/`stopped`, and for an agent-run push `agent_link_opened`/`still_waiting`/`expired`/`unsupported`), `mode` (`terminal`/`agent`/`nudge`), `duration_bucket` | That handoff ends, one way or the other: for an agent-run push, each of its runs; for a nudge, each background wait for the sign-in (`linked`/`timed_out`/`expired`/`unsupported`) |
| `note_saved` | `has_cost` (`true`/`false`), `touches_bucket` (how many files the learning is about, bucketed), `scope` (`repo`/`personal`) | `trail note` saves a learning, in the repo's `.trail/` or on this machine. The title, the text and the paths are never sent |
| `repo_seen` | `trail_committed` (`true`/`false`), `learnings_bucket`, `workspace` (`true`/`false`) | Once a day per repo, when a Claude Code session starts in a repo trail runs in. The repo's name and paths are never sent; it's identified only by the random `repo_id` every event carries |
| `learnings_committed` | `added_bucket`, `total_bucket` (learnings committed on `HEAD`, bucketed), `first_look` (`true`/`false`) | A Claude Code session starts in a repo trail runs in and more learnings are committed there than at the last session. Their names and text are never sent |
| `cold_start` | `source` (`sessions`/`reviews`/`memory`/`keep`), `outcome` (`found`/`none_found`/`none_anchored`/`no_sessions`/`no_reviews`/`no_gh`/`no_claude`/`not_signed_in`/`not_installed`/`timed_out`/`refused`/`failed`/`cancelled`/`kept`), `sessions_bucket` (sessions) or `reviews_bucket` (merged PRs with a reviewer's comment; reviews), `offered_bucket`, `filtered_bucket` (review findings left out for naming no code), `picked_bucket` (how many it saved: the ones the person kept), `team_offered_bucket`, `team_picked_bucket` (of those, the ones for `.trail/learnings/`; memory), `offered_skills`, `offered_always_follow`, `offered_learnings` (what the list showed, by kind: `0`/`1`/`2`/`3`/`4`/`5`/`6+`), `kept_skills`, `kept_always_follow`, `kept_learnings` (of those, the ones you kept; `outcome: kept`), `duration_bucket`, `model` | `trail init` reads your past Claude Code sessions in the repo, once, for things you told Claude on more than one day, and the review comments on the repo's last 50 merged PRs, once, for things reviewers flagged on more than one PR, and the notes Claude Code keeps about the repo on this machine (`source: memory`, no model), and offers them to you as learnings. It saves only the ones you keep, on its list or later with `trail keep` (`source: keep`). The reviews are fetched with your own `gh` (`no_gh` when it isn't installed or signed in) and the reading is done by your own Claude Code; your messages, the comments and what it found are never sent to trail |
| `session_summary` | `graft_reads_bucket`, `source_reads_bucket`, `saved_tokens_bucket`, `graft_turns_bucket`, `reported_turns_bucket` | Once, after an agent session ends |
| `skill_offered` | `moment` (`asked`/`repeated`/`repaired`/`correction`/`update`/`drift`/`retire`/`promote`) | Trail offers to keep a skill, a lesson on one, an update, a fix for a skill that needs one (`drift`), retiring a skill the agent mostly didn't follow, or a promotion. The skill, the job and the offer's words are never sent |
| `skill_answer` | `answer` (`yes`/`no`/`show`/`none`/`off`/`retire`) | The person answers an offer: yes, no, show me, moved on without answering (`none`), turned offers off, or retired the skill (`retire`). A withdrawn offer sends nothing |
| `skill_saved` | `from` (`init`/`repeated`/`repaired`/`asked`), `scope` (`personal`/`repo`/`team`) | A skill is saved. Its name, its steps and the commands they came from are never sent |
| `skill_changed` | `op` (`update`/`extend`/`split`/`replace`/`retire`/`adopted`/`restore-version`) | Trail changes a skill it wrote: after your yes it changes a step, adds steps, keeps some steps as their own skill, replaces the steps with ones that just worked, or retires it; it takes a copy you made of its proposal as its own (`adopted`); or you bring back an older version. The skill's name, its steps and the change are never sent |
| `skill_promoted` | `to` (`repo`/`team`) | A skill moves up to the repo or the team. The diff is never sent |
| `team_pull` | `outcome` (`updated`/`unchanged`/`diverged`/`failed`) | Trail pulls a team repo you joined. The team's name, its remote and what came in are never sent |
| `skill_used` | `outcome` (`checked`/`failed`/`unchecked`) | A skill the agent was given ran: its check passed, a step failed, or nothing checked it |
| `skill_value` | `channel` (`context`/`notice`/`list`) | The weekly line of what your skills and guardrails did here is said: by the agent, as a notice, or at the top of `trail skills`. Its numbers and the skill's name are never sent |
| `skill_stale` | `reason` (`failed`/`corrected`/`missing`/`unused`/`unfollowed`) | A skill stops reaching the agent as it is: it failed or was corrected twice in a row, something a step needs is gone, it went unused, or the agent mostly didn't follow it |
| `guardrail` | `class` (`no-timeout`/`prod-after-beta`), `outcome` (`hint`/`ask`/`deny`/`sure-fail`/`avoided`) | A built-in guardrail fires, or the fixed command then works (`avoided`). The command is never sent |
| `wall_hit` | `class` (`timeout-missing`/`zsh-no-match`/`git-https-auth`/`docker-rootless`/`npm-e401-eotp`/`claude-not-logged-in`/`enospc`), `had_lesson` (`true`/`false`) | A failing command matches a known wall, and whether you had kept a lesson for it. The command and its output are never sent |
| `hook_ms` | `event` (`session-start`/`prompt`/`pre-bash`/`pre-edit`/`tool-savings`/`post-bash`/`post-bash-fail`/`post-edit`/`post-edit-sync`/`stop`), `bucket` (`<50ms`/`50-100ms`/`100-300ms`/`300ms-1s`/`1-3s`/`3s+`) | A Claude Code hook finishes: which one, and how long it took, bucketed |

Two rules govern every value above, and both are enforced in code rather than by
review:

- **Every number is a bucket.** A build reports `"200-999"` files, never `417`.
  An exact count next to a language set starts to fingerprint a specific repo; a
  bucket does not.
- **Every string is a member of a fixed set.** `command` is one of eight known
  subcommands, `code` is one of eleven known failure codes. A value outside the
  set is dropped, not sent, which is what stops a path, a symbol name, or a
  snippet of an error message from riding along inside a "string property".
  For the skills events (`skill_offered` through `hook_ms`) the sets are in the
  contract itself, so a skill's name, a command or a prompt passed under an
  allowed key is dropped there, key and all.

An example event, in full:

```json
{
  "event": "build_completed",
  "timestamp": "2026-08-21T09:14:22.417Z",
  "properties": {
    "app_version": "0.12.0", "os": "darwin", "arch": "arm64",
    "node_major": "20", "ci": "false", "agent_host": "claude-code", "cli_name": "trail",
    "repo_id": "6f2c1e90-...", "distinct_id": "b1f3a9c2-...",
    "files_bucket": "200-999", "langs": "go,ts", "mode": "deep",
    "duration_bucket": "30s-2m", "incremental": "true",
    "$process_person_profile": false
  }
}
```

Run `trail telemetry debug` to print the exact batch your machine would send. It
sends nothing.

### One thing Trail-code reads locally

Two of those properties, `graft_turns_bucket` and `reported_turns_bucket`, need
to know something the others don't: whether the reply you actually read said what
Trail-code saved. Trail-code computes a saving on every retrieval call, but a turn that
saves 20,000 tokens in silence and a turn that saves nothing look identical in
`saved_tokens_bucket`, and that difference is the whole question.

The agent's own prose lives in one place a hook can reach: the transcript file
your editor writes, named on the Stop hook's stdin. So at the end of a turn that
used Trail-code, it reads what that file gained since the last turn ended, checks
the reply for a "saved ~N tokens" line, and increments one of two counters.
Nothing out of the file is stored, and nothing out of it is sent: not the reply,
not a fragment of it, not
its length. Two counts of turns cross the wire, as buckets, once per session.

A turn Trail-code cannot check (an editor whose Stop hook names no transcript, an
unreadable file) is counted in neither total, so the ratio always means "of the
turns we could read".

### Learned skills

The skills events are counts of moments, each with one or two values from a
fixed set, and nothing about the skill itself:

- `skill_offered` when Trail offers to keep a run as a skill, with the moment
  (`repeated`: a job that checked out on its 3rd day; `asked`: you asked).
- `skill_answer` with your answer to that offer, or `off` when you run
  `trail skills offers off`. An offer withdrawn before you answer sends nothing.
- `skill_saved` once a skill is kept: by `trail skills add` after your yes or your
  ask, or by `trail skills keep`. Always `personal` for now.
- `skill_used` when a skill the agent was given ran: whether its own check passed.
- `skill_changed` when Trail changes a skill it wrote, after your yes or when you
  run `trail skills restore` with `--version`: only how it changed, never what.
- `skill_value` once a week at most, when the line of what your skills did here
  is said: only where it went, never its numbers.
- `hook_ms` for each Claude Code hook: which one, and its time as a bucket.

Hooks only add these to the local file; the same once-a-day send posts them. A
skill's name, its steps, the commands they came from, your prompts, your answers'
words, repo names and paths never travel: a value outside the fixed set is
dropped before anything is written.

## What is never sent

No source code. No file paths, repo names, organisation names, git remotes, or
branch names. No symbol names, node summaries, or anything out of the graph. No
query strings, prompts, or agent output: Trail-code reads the last reply of a
turn that used it locally to decide whether it mentioned the saving (see "One
thing Trail-code reads locally"); only the resulting count is sent, never the text. No error messages or stack traces: a
failure contributes a code from a fixed list and nothing else. No environment
variables, API keys, model names, hostnames, usernames, or email addresses.

## How it stays anonymous

- Events go to [PostHog](https://posthog.com) with
  `$process_person_profile: false`, which makes them **anonymous events**: no
  person profile is created and no identity is stored.
- The only identifiers are two **random UUIDs**. `install_id` is minted on first
  run in `~/.graft/telemetry.json`; `repo_id` is minted per checkout in
  `graft/.cache/`. Neither is derived from your machine, your account, or your
  git remote: they are coin flips, written down. A hash of your remote URL
  would at least be something we could guess at and confirm; a random UUID is
  not. Delete `~/.graft/` or `graft/` and you look like someone new.
- IP-based geolocation is used only to derive a country for aggregate stats;
  PostHog does not retain the IP on the event.

## Opting out

Any one of these fully disables telemetry:

1. **Uncheck "anonymous usage stats" in the `trail init` picker.** Takes effect
   immediately and is remembered for this machine.
2. **`trail telemetry disable`** at any time. `trail telemetry status` shows the
   current state, and `trail telemetry enable` turns it back on.
3. **Set [`DO_NOT_TRACK`](https://web.archive.org/web/20251005054121/https://consoledonottrack.com/)** to any value other
   than `0`. Respected unconditionally: it outranks Trail-code's own setting.
4. **Run in CI.** `CI`, `GITHUB_ACTIONS`, `GITLAB_CI` and friends switch it off
   without being asked. A build server is not a user.
5. **Build from source.** The PostHog key is stamped in only at publish time
   (`scripts/stamp-telemetry-key.mjs`); a clone, a fork, or a local
   `npm run build` compiles with an empty key and the telemetry module is inert.
   Forks never send events anywhere.

## Where the events go

Official builds send to `https://events.nanonets.com`, Nanonets' own PostHog
front door, so Trail-code's numbers sit in the same project as the rest of the
product rather than in a separate one. The client posts a single batch to
`/batch/`.

The host is a publish-time setting (`GRAFT_POSTHOG_HOST`) and PostHog itself is
open source and self-hostable, so the endpoint can move without any code change.
