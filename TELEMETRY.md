# Telemetry

graft collects a small set of **anonymous** usage events so we can tell whether
the thing works: how many repos get past a build, whether an agent reaches for
graft or falls back to grep, which commands earn their place, and what breaks in
the wild.

This document is the complete, authoritative contract: **if an event or property
is not listed here, graft does not send it.** The implementation lives in
[`src/telemetry/contract.ts`](src/telemetry/contract.ts) and enforces this list
as a hard allowlist — unknown events and unknown properties are dropped before
anything is written, let alone sent. The code and this file are kept in
lockstep, and because the repo is open source you can verify that yourself.

Nothing is ever sent from a command you run. Events are appended to a local file
and a detached background process posts them at most once a day, so no `graft
ask` ever waits on the network.

The one exception is the `install` event below, which the npm postinstall hook
records and hands to that same detached process immediately — an install that
never runs a command would otherwise never reach a flush, and "installed and
never used" is a number we need to see. `npm install` itself still waits on
nothing: the child is detached and its output discarded.

## What is sent

Every event carries only these common properties:

| Property | Example | Notes |
| --- | --- | --- |
| `app_version` | `0.12.0` | The graft version that produced the event |
| `os` | `darwin` / `win32` / `linux` | Platform, nothing more |
| `arch` | `arm64` / `x64` | CPU architecture |
| `node_major` | `20` | Major version only |
| `ci` | `false` | Always false — CI never sends (see below) |
| `agent_host` | `claude-code` / `cursor` / `mcp` / `cli` | Which surface graft ran under |
| `repo_id` | a random UUID | See "How it stays anonymous" |

The events:

| Event | Extra properties | When |
| --- | --- | --- |
| `install` | `global` (`true` for `npm i -g`, `false` for a project dependency) | The npm postinstall hook runs — once per machine per version |
| `first_run` | — | Once, the first time a graft command runs on a machine |
| `init_completed` | `agents` (the ids you selected, sorted), `consent` | `graft init` finishes |
| `build_completed` | `files_bucket`, `langs`, `mode` (`fast`/`deep`), `duration_bucket`, `incremental` | A build succeeds |
| `build_failed` | `stage`, `code` — both fixed enums | A build throws |
| `query` | `command`, `surface` (`cli`/`mcp`/`hook`), `hit` (`ask` only) | Any query command |
| `brain_signup_opened` | `mode` (`terminal`/`agent`) | `graft trail push` on a repo with no brain opens your browser to make one |
| `brain_signup_settled` | `outcome` (`linked`/`timed_out`/`bad_callback`/`stopped`, and for an agent-run push `agent_link_opened`/`still_waiting`/`expired`/`unsupported`), `mode` (`terminal`/`agent`), `duration_bucket` | That handoff ends, one way or the other — for an agent-run push, each of its runs |
| `trail_pulled` | `outcome` (`written`/`already_present`/`nothing_accepted`/`skipped`/`error`/`dry_run`), `kinds` (which kinds of context file were written: `claude_md`, `folder_claude_md`, `agents_md`, `cursor_rule`, `skill`), `files_bucket`, `changes_bucket`, `skipped_bucket`, `suggested_bucket` (every change Trail has suggested for the wired agents' files, whatever became of it) | `graft trail pull` (or `graft claude-md pull`) finishes |
| `trail_watch_exit` | `reason` (`suggestions`/`accepted`/`timeout`/`refused`/`no_trail`), `suggested_bucket`, `accepted_bucket`, `duration_bucket` (how long it waited) | `graft trail watch` ends |
| `trail_autopush` | `outcome` (`started`/`skipped`), `reason` when skipped (`disabled`/`no_head`/`head_unchanged`/`throttled`/`spawn_failed`) | A Claude Code or Codex session starts in a repo with a trail attached, and the hook decides whether to refresh it with a background `graft trail push`. Repos without a trail send nothing |
| `session_summary` | `graft_reads_bucket`, `source_reads_bucket`, `saved_tokens_bucket`, `graft_turns_bucket`, `reported_turns_bucket` | Once, after an agent session ends |

Two rules govern every value above, and both are enforced in code rather than by
review:

- **Every number is a bucket.** A build reports `"200-999"` files, never `417`.
  An exact count next to a language set starts to fingerprint a specific repo; a
  bucket does not.
- **Every string is a member of a fixed set.** `command` is one of eight known
  subcommands, `code` is one of eleven known failure codes. A value outside the
  set is dropped, not sent — which is what stops a path, a symbol name, or a
  snippet of an error message from riding along inside a "string property".

An example event, in full:

```json
{
  "event": "build_completed",
  "timestamp": "2026-08-21T09:14:22.417Z",
  "properties": {
    "app_version": "0.12.0", "os": "darwin", "arch": "arm64",
    "node_major": "20", "ci": "false", "agent_host": "claude-code",
    "repo_id": "6f2c1e90-...", "distinct_id": "b1f3a9c2-...",
    "files_bucket": "200-999", "langs": "go,ts", "mode": "deep",
    "duration_bucket": "30s-2m", "incremental": "true",
    "$process_person_profile": false
  }
}
```

Run `graft telemetry debug` to print the exact batch your machine would send. It
sends nothing.

### One thing graft reads locally

Two of those properties — `graft_turns_bucket` and `reported_turns_bucket` — need
to know something the others don't: whether the reply you actually read said what
graft saved. graft computes a saving on every retrieval call, but a turn that
saves 20,000 tokens in silence and a turn that saves nothing look identical in
`saved_tokens_bucket`, and that difference is the whole question.

The agent's own prose lives in one place a hook can reach: the transcript file
your editor writes, named on the Stop hook's stdin. So at the end of a turn that
used graft, graft reads the tail of that file, checks the reply for a "graft saved
~N tokens" line, and increments one of two counters. Nothing out of the file is
stored, and nothing out of it is sent — not the reply, not a fragment of it, not
its length. Two counts of turns cross the wire, as buckets, once per session.

A turn graft cannot check — an editor whose Stop hook names no transcript, an
unreadable file — is counted in neither total, so the ratio always means "of the
turns we could read".

## What is never sent

No source code. No file paths, repo names, organisation names, git remotes, or
branch names. No symbol names, node summaries, or anything out of the graph. No
query strings, prompts, or agent output — graft reads the last reply of a
graft-using turn locally to decide whether it mentioned the saving (see "One
thing graft reads locally"); only the resulting count is sent, never the text. No error messages or stack traces — a
failure contributes a code from a fixed list and nothing else. No environment
variables, API keys, model names, hostnames, usernames, or email addresses.

## How it stays anonymous

- Events go to [PostHog](https://posthog.com) with
  `$process_person_profile: false`, which makes them **anonymous events**: no
  person profile is created and no identity is stored.
- The only identifiers are two **random UUIDs**. `install_id` is minted on first
  run in `~/.graft/telemetry.json`; `repo_id` is minted per checkout in
  `graft/.cache/`. Neither is derived from your machine, your account, or your
  git remote — they are coin flips, written down. A hash of your remote URL
  would at least be something we could guess at and confirm; a random UUID is
  not. Delete `~/.graft/` or `graft/` and you look like someone new.
- IP-based geolocation is used only to derive a country for aggregate stats;
  PostHog does not retain the IP on the event.

## Opting out

Any one of these fully disables telemetry:

1. **Uncheck "anonymous usage stats" in the `graft init` picker.** Takes effect
   immediately and is remembered for this machine.
2. **`graft telemetry disable`** at any time. `graft telemetry status` shows the
   current state, and `graft telemetry enable` turns it back on.
3. **Set [`DO_NOT_TRACK`](https://web.archive.org/web/20251005054121/https://consoledonottrack.com/)** to any value other
   than `0`. Respected unconditionally — it outranks graft's own setting.
4. **Run in CI.** `CI`, `GITHUB_ACTIONS`, `GITLAB_CI` and friends switch it off
   without being asked. A build server is not a user.
5. **Build from source.** The PostHog key is stamped in only at publish time
   (`scripts/stamp-telemetry-key.mjs`); a clone, a fork, or a local
   `npm run build` compiles with an empty key and the telemetry module is inert.
   Forks never send events anywhere.

## Where the events go

Official builds send to `https://events.nanonets.com`, Nanonets' own PostHog
front door, so graft's numbers sit in the same project as the rest of the
product rather than in a separate one. The client posts a single batch to
`/batch/`.

The host is a publish-time setting (`GRAFT_POSTHOG_HOST`) and PostHog itself is
open source and self-hostable, so the endpoint can move without any code change.
