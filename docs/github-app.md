# The graft GitHub App

Posts a blast-radius comment on every pull request, and hosts the interactive
graph behind a signed link.

It exists because of one limit that no amount of workflow YAML gets around: **a
`pull_request` job on a fork gets a read-only token**, so it cannot comment, and
`pull_request_target` cannot check out fork code without opting into running it.
An App's installation token belongs to the *base* repository, so a fork PR is
ordinary work. Two things follow for free: the page is served by the App (a
private repo never needs a public `gh-pages`), and installing takes one click
instead of a workflow file per repo.

## What it does per pull request

1. Verifies the webhook signature, queues the job, answers `202` — GitHub gives
   up on a delivery after ten seconds and a review takes longer.
2. Fetches `refs/pull/<n>/merge` and the base branch, shallow — falling back to
   `refs/pull/<n>/head` for a closed or merged pull request, whose merge ref
   GitHub has deleted. The head ref is then diffed against the base branch as it
   stood at the merge, so the radius is still the pull request's own change.
3. Builds the structural graph, computes the radius, renders the comment.
4. Stores the viewer page and links it with a signed URL.
5. Edits its existing comment rather than adding one per push.

Work is superseded per pull request: five pushes in a minute produce one review,
not five, because the first four comments would be overwritten anyway.

## Setting it up

### 1. Register the App

<https://github.com/settings/apps/new> (or your org's settings → Developer
settings → GitHub Apps → New).

| Field | Value |
| --- | --- |
| Webhook URL | `https://<your-host>/webhook` |
| Webhook secret | a long random string — keep it, it is `GRAFT_WEBHOOK_SECRET` |
| Repository permissions | **Contents: Read-only**, **Pull requests: Read & write** |
| Subscribe to events | **Pull request** |
| Where can this be installed | your choice |

Nothing else. Contents-read is what clones the code; pull-requests-write is what
posts the comment. It never needs Actions, Checks, Administration or write
access to code.

Then **Generate a private key** — the download is the only copy — and note the
**App ID**.

### 2. Run it

```bash
docker build -t graft-app .
docker run -p 3000:3000 \
  -e GRAFT_APP_ID=123456 \
  -e GRAFT_APP_PRIVATE_KEY="$(cat graft.private-key.pem)" \
  -e GRAFT_WEBHOOK_SECRET=... \
  -e GRAFT_PUBLIC_URL=https://graft.example.com \
  -v graft-pages:/var/lib/graft/pages \
  graft-app
```

The image needs `git` and nothing else at runtime, runs as non-root, and answers
`/healthz` with its queue depth. Any container host works — Fly, Cloud Run, ECS,
a VM. `GRAFT_PUBLIC_URL` must be the origin GitHub and your reviewers can reach,
because it is what the comment's link is built from.

The process refuses to start if any of those four are missing: a server that
boots without a webhook secret looks healthy and silently rejects every delivery.

The volume is the fifth thing and it is optional — but without it, every link
already posted to a pull request breaks the first time the container is replaced.
The token in a link is derived from the page id rather than stored, so the link
keeps verifying and simply 404s, with nothing in the comment to say why. The image
already points `GRAFT_PAGE_DIR` at `/var/lib/graft/pages` (500 pages of ~50 kB,
so ~25 MB is the ceiling); mount anything durable there and the pages come back
with the process. Set the variable yourself on hosts that are not this image, or
leave it empty to keep the store in memory — it is deliberately not required, as
a server that refuses to boot reviews nothing at all.

### 3. Install it on a repository

App settings → Install App → pick the repos. **Installing requires admin on the
repository** (or org-owner for an org-wide install) — the one thing an App does
not get you around.

## Reading a repository into a Trail brain

The App has a second, optional job: reading one repository's own history so
Trail can mine rules out of it. That is what backs "paste a repo URL" during
brain onboarding, and it lives here because this is the only service holding the
GitHub App credentials and the only one that can build a symbol graph.

`POST /brain/build`, off unless `GRAFT_BRAIN_BUILD_SECRET` is set:

```bash
curl -X POST https://<your-host>/brain/build \
  -H "authorization: Bearer $GRAFT_BRAIN_BUILD_SECRET" \
  -H 'content-type: application/json' \
  -d '{"owner":"acme","repo":"api"}'
```

It resolves the installation for `acme/api` (`GET /repos/{owner}/{repo}/installation`,
App-JWT authed), clones it shallow, builds the graph, and reads:

- **commit subjects and bodies**, `--no-merges --reverse`, up to 1000
- **closed pull requests and their discussion**, most-discussed first, bots dropped
- **exported symbols**, with the body hash that later tells Trail whether a rule
  still describes the code it was mined from

What comes back is a digest of that — **messages, titles, comments, symbol ids
and hashes. No source code.** Two modes:

| Request | Response |
| --- | --- |
| `owner` + `repo` | `202` with the digest, for the caller to ingest itself |
| plus `brainId` + `brainToken` | the digest is POSTed to the brain; `202` with its job id |

The platform uses the first: it already holds the user's session and writes to
the brain directly, so handing this service a workspace key just to have it call
back would mean minting a credential per build for nothing.

`404` with an `error` means the App is not installed on the repository — the
expected answer for "someone pasted a repo we cannot see", not a failure. The
caller turns it into a choice: install the App, or run `graft init --trail`
locally, where the code never leaves the machine.

| Variable | Meaning |
| --- | --- |
| `GRAFT_BRAIN_BUILD_SECRET` | Bearer secret for the route. Unset disables it entirely. |
| `GRAFT_BRAIN_URL` | Platform base URL the digest is posted to, when a `brainToken` is sent. Overrides anything a request supplies, so a caller cannot redirect a repository's history elsewhere. |

## Security

The App clones code written by strangers on every fork PR while holding a token
for the base repository, so:

- **Nothing from the repo is executed** — no `npm install`, no build step, no
  postinstall. The graph comes from tree-sitter reading source text.
- **Git is told not to run anything either**: `core.hooksPath=/dev/null`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, no submodule recursion.
- **The token never lands in the checkout.** It is passed per-invocation as an
  auth header, not baked into a remote URL that `.git/config` and the reflog
  would keep. It is redacted out of error text before anything is logged.
- **Pages are capabilities, not public URLs.** `/p/<id>?t=<hmac>` — an unknown
  page and a bad token are both `404`, so the endpoint cannot be used to
  discover which pull requests exist. Links expire with the page they point at.
- **`/brain/build` sends no source.** Its digest is commit messages, pull-request
  discussion, symbol ids and hashes; the checkout is deleted in a `finally`. The
  route is off until `GRAFT_BRAIN_BUILD_SECRET` is set, and the secret is
  compared in constant time — it is long-lived, unlike a per-payload signature.

## What is not built yet

- **Naming.** Areas fall back to their hub symbol. `--name`'s one cached LLM call
  is not wired in, and sending a private repo's source to a model should be an
  explicit per-installation opt-in, not a default.
- **Persistence.** Pages live in memory, so a deploy drops them; the next push to
  a PR rebuilds its page. A shared store is the fix when there is more than one
  instance.
- **The evidence quotes** in the comment's collapsed list arrive when #180 lands
  (`markdownReport(report, { root })` — additive, one line here).

## Deploying to AWS App Runner

`deploy/apprunner.sh` is the whole deploy: build for x86_64, push to ECR, create
or update the service. Run it again for every new build.

### Once, before the first deploy

```bash
aws sso login                      # or however this account authenticates

# 1. Secrets. The private key is multi-line PEM and survives verbatim.
aws secretsmanager create-secret --name graft/app-id         --secret-string 123456
aws secretsmanager create-secret --name graft/webhook-secret --secret-string "$(openssl rand -hex 32)"
aws secretsmanager create-secret --name graft/private-key    --secret-string file://graft.private-key.pem

# 2. The role App Runner uses to PULL the image from ECR.
aws iam create-role --role-name AppRunnerECRAccessRole --path /service-role/ \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name AppRunnerECRAccessRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess

# 3. The role the RUNNING container uses to read those secrets.
aws iam create-role --role-name graft-app-instance \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"tasks.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam put-role-policy --role-name graft-app-instance --policy-name read-graft-secrets \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"arn:aws:secretsmanager:*:*:secret:graft/*"}]}'
```

Two roles, because App Runner separates them: one is assumed by the *build*
side to pull the image, the other by the *running* task to read configuration.
Giving the second one only `graft/*` keeps this service away from every other
secret in the account.

### Every deploy

```bash
GRAFT_PUBLIC_URL=https://graft.nanonets.ai ./deploy/apprunner.sh
```

Then, once: `associate-custom-domain`, add the CNAMEs it prints to Route 53
(one validates the certificate, one points the domain at the service), and set
the App's webhook URL to `https://graft.nanonets.ai/webhook`.

### Two things the config is deliberate about

- **`--platform linux/amd64`.** App Runner is x86_64 only; an image built on an
  Apple Silicon Mac pushes fine and then fails at runtime with an exec-format
  error, which reads like a broken entrypoint.
- **One instance, pinned.** Viewer pages live in the process, so a second
  instance would 404 links minted by the first. Raising `--max-size` means
  moving `PageStore` to S3 or a database first — the cap is correctness, not
  cost control.
