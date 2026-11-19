# Configuration reference — `.github/pipeline.yaml` version 3

One file per repository configures the whole pipeline. The caller workflow is
identical everywhere (see `.github/workflows/examples/caller.yaml`); this file
is the only place behaviour differs. Guard reads it once and refuses anything
that is not version 3, so a stale v2 file fails loudly instead of half-working.

```yaml
version: '3' # required

stack: auto # nodejs | python | none | auto
# auto: package.json → nodejs; pyproject.toml or requirements.txt → python; else none.

runtime:
  node_version: '' # default: .nvmrc, then .node-version, then package.json engines.node, then lts/*
  python_version: '3.12'
  dependency_cache: true # default: true on a GitHub-hosted runner, false when the runner labels contain self-hosted (its package store outlives the job, and saving the cache uploads gigabytes over the runner's own uplink). Restored on every run, saved by every run but a pull request's that installed (a push to dev/main, a dispatch, the nightly schedule): a pull request reads its base branch's copy and stores none of its own, and a push that reused its pull request's result installs nothing to save. Also switches trunk's cache
  build_cache: false # true: Check restores ~/.cache/pipeline-build-cache on every run and saves it after Build on every run but a pull request's, so a push to dev/main and the full Check by dispatch or by night (a new entry per run, keyed by OS, Node and lockfile, falling back to the newest older one). The path is exported as PIPELINE_BUILD_CACHE_DIR; point a task runner's cache there (turbo: TURBO_CACHE_DIR). The repository decides what is in it and proves that replaying it is safe. Off whenever dependency_cache is

runner:
  labels: [] # default: vars.PIPELINE_RUNNER if set on the repository or org, else ubuntu-latest

security:
  enable: true
  trufflehog: true # verified secrets in the commit range; the pinned binary, no Docker needed
  dependency_review: true # when the repository's dependency graph is on (public, or private with GHAS); otherwise a notice
  fail_on_secrets: true
  fail_on_vulnerabilities: false # true fails on moderate+, false warns

lint:
  enable: true
  command: '' # default: `trunk check` when .trunk/trunk.yaml exists, else `<pm> run lint` if the script exists

test:
  enable: true
  command: '' # default: `<pm> test` if the script exists; python: `pytest` when tests/ exists
  pr_command: '' # optional: what a fast Check runs instead of `command`. Setting it switches the two depths on, see "Two depths of Check"
  artifact_path: '' # optional: uploaded as test-artifacts-<run>-<attempt> for 7 days, only when the tests fail

build:
  enable: true
  command: '' # default: `<pm> run build` if the script exists. Multi-line commands are fine.
  artifact_path: '' # optional: uploaded as build-<sha> for 7 days

deploy:
  provider: none # none | vercel | cloudflare-workers | docker-ghcr | npm
  vercel:
    scope: '' # team slug
    build_command: ''
    preview_alias: '' # e.g. my-app-dev.vercel.app: pointed at every preview deployment
  cloudflare:
    config: wrangler.toml
    build_command: ''
  docker:
    cache_backend: none # gha | local | none. Default: none on a GitHub-hosted runner (Deploy runs on a release event, whose cache scope is the new tag: the next release cannot read what this one wrote), local (the runner's work volume, /_work/.buildx-cache) when the runner labels contain self-hosted
    images: # one Deploy leg per image
      - name: default # default or app → ghcr.io/<owner>/<repo>; any other name → <repo>-<name>
        dockerfile: Dockerfile
        context: .
        platforms: linux/amd64
        build_args: | # optional; APP_VERSION=<version> is always passed
          NODE_ENV=production
        image_name: '' # explicit override
  render:
    hook: false # fire the RENDER_DEPLOY_HOOK secret after the production Docker deploy

release: # optional; read by the Train workflow, validated by Guard
  version_files: [package.json] # the files that carry the version; [] releases with tag and changelog only
  changelog_show_hidden: false # also list chore/ci/test/… entries in the changelog
  release_as: 2.0.0 # force the next version to X.Y.Z; ignored once a tag at or above it exists
```

## What each job reads

| job | reads | runs on |
|---|---|---|
| Guard | everything above; on pull requests also the PR title and branches | ubuntu-slim (one core, GitHub-hosted) |
| Check | `security`, `lint`, `test`, `build`, `runtime`, `stack` | `runner.labels`; ubuntu-slim when it only reports an earlier result or "not fully verified" |
| Recheck Release PR | nothing but Guard's answers (`test.pr_command` set, depth full) | ubuntu-slim |
| Deploy | `deploy`, `runtime`, `stack` | `runner.labels` |
| Train (second workflow) | `release` | Train, Fix (triage) and Fix (commit): `vars.PIPELINE_RUNNER` in a private repository, else ubuntu-slim. Fix (propose): always ubuntu-latest |

**When GitHub hands out no ubuntu-slim runner**, set the variable
**`PIPELINE_SLIM`** = `off` on the repository (or the organization): every job
the table lists on ubuntu-slim then runs on ubuntu-latest, at three times the
price per minute. Any other value, or none, means ubuntu-slim. The sign is a
Guard that stays queued and is cancelled after 15 minutes with "The job was not
acquired by Runner of type hosted even after multiple attempts" while jobs on
ubuntu-latest start at once (2026-11-17, 45 minutes). Guard is the first job,
so until then no Check runs. Delete the variable when the outage is over, and
re-run what it cancelled:

```sh
gh variable set PIPELINE_SLIM --body off -R <owner/repo>
gh run rerun <run id> --failed -R <owner/repo>
gh variable delete PIPELINE_SLIM -R <owner/repo>
```

The switch chooses between those two hosted labels and names none of its own,
so it cannot point a public repository at a self-hosted runner.

The pipeline has four jobs. Guard runs every time. Check runs on everything but
a release, Deploy only on a published release. The fourth, **Recheck Release
PR**, starts only after a green full Check on a `workflow_dispatch` or a
`schedule` in a repository that sets `test.pr_command`; on a pull request, on a
push and in every other repository it is skipped, so it starts no runner and
costs nothing. What it does is under "Two depths of Check".

## Two depths of Check

Without `test.pr_command` nothing here applies: every Check runs
`test.command`, as it always did.

A repository that sets `test.pr_command` gets two depths. **Fast** runs lint,
the `pr_command` and build. **Full** runs lint, `test.command` and build. The
`pr_command` is whatever the repository can answer for on every pull request:
the unit tests, the tests of the packages a change touches. `test.command`
stays the whole suite.

| run | depth | test command |
|---|---|---|
| pull request, any head but `hotfix/*`, `release/*`, `promote/*` and `dev` into `main` | fast | `test.pr_command` |
| push to `dev` / `main` | fast | `test.pr_command` |
| pull request from `hotfix/*`, or from `dev` into `main` (a promotion opened by hand) | full | `test.command` |
| `workflow_dispatch`, `schedule` | full | `test.command` |
| Release PR (`release/*` head) | none of its own: green only when the tip of its base branch has passed the full Check, otherwise red at once as "not fully verified" | |
| promotion (`promote/*` head) | none of its own when the Release it promotes has passed the full Check: its own tree carries a full marker, or it is one version commit over a tree that does. Otherwise it is checked itself, in full | `test.command` when checked itself |

So **a Release PR is green only when the tip of its base branch has passed the
full Check.** A Release PR that is more than its base tip plus a version (a
commit by hand, a base that moved on) is checked itself, in full. So is a
promotion that cannot stand on the Release it promotes: the base has commits
of its own, or nothing shows that the Release passed the full Check (the push
of a Release to `dev` runs the fast Check, and a promotion does not stand on
that). What goes to production never goes green on the fast suite.

**`PIPELINE_DEPTH`** is `fast` or `full` in the environment of the Lint, Test
and Build steps, for the repository's own scripts (a build that skips an
expensive target on a pull request, say). It is `full` in a repository without
a `pr_command`, and unset under a pin older than the depths: read unset as
`full`.

**Markers.** A passing Check leaves an artifact named after its tree and its
depth: `pipeline-checked-tree-<tree>` after a full Check,
`pipeline-fast-tree-<tree>` after a fast one. The first is the only name
there was before, so older markers count as full. A full run stands down only
for a full marker, a fast run for either. A Release PR that stood on its
base's full marker leaves the fast name for its own tree, and so does a
promotion that stood on the Release it promotes.

**The secret scan reads commits, not the tree.** Lint, test and build depend
on the tree alone, so a marker settles them. A secret added in one commit and
removed in the next leaves the tree where it started. A pull request whose
tree carries a marker is therefore reused in full only when a marked run saw
its very head commit; otherwise Check still checks the pull request out and
scans its commits, and runs nothing else. A push stands on the scan of the
pull request it merged.

**Starting a full run.** The caller listens for `workflow_dispatch`, and where
`test.pr_command` is set also for a nightly `schedule` (`23 2 * * *`, on the
default branch):

```sh
gh workflow run ci.yaml --ref dev -R <owner>/<repo>
```

It runs the full Check on the tip of that branch, or takes seconds when that
tree already carries a full marker. Lint is the one step that is no wider
there: where Trunk lints, such a run checks what the tip commit brought, the
range its push Check linted, and never the whole repository (the Trunk
action's `all` mode would fail on every issue older than Trunk). When it is green, the job **Recheck
Release PR** looks for the open Release PR onto that branch (a `release/*`
head from this repository) and, if the newest Pipeline run of its head
concluded `failure`, re-runs all jobs of that run, so Guard answers again and
the Release PR turns green without anyone clicking. The job runs on
ubuntu-slim with `actions: write` and `pull-requests: read`, checks nothing
out and never fails the run: an API that refuses is a notice that names the
run to re-run by hand. It is a job of its own because Check runs the
repository's code and must not hold `actions: write`. The caller has to grant
`actions: write` for it (the rendered caller does): a called workflow may not
ask for more than its caller grants, and one that does fails to start.

**A red Release PR, "Not fully verified".** The tip of the base branch has no
full marker yet: nobody ran the full Check on it since the last merge, or the
nightly run has not come round. The Check fails within seconds, on the
one-core runner, without running anything, and its error names the command
above. Where the train runs, its Verify job starts that run by itself
([Verify](#verify)); anywhere else, run it. Once it is green, Recheck Release
PR re-runs the Release PR's Pipeline run. By hand, re-run **all jobs** of that
run (`gh run rerun <id>`):
re-running only the failed Check repeats Guard's old answer. The same error
with "the … API did not answer" means Guard could not look; re-running all
jobs is enough.

## `release:`

Every key is optional, and so is the block. Guard validates it on every run, so
a typo fails the pull request that makes it rather than a release weeks later:

| key | type | meaning |
|---|---|---|
| `version_files` | list of non-empty strings | files whose version the Release PR bumps; an empty list means no file carries one, and a release is the tag and the changelog |
| `changelog_show_hidden` | `true` or `false` | include the normally hidden commit types in the changelog |
| `release_as` | string `X.Y.Z` | the next version, overriding the one derived from the PR titles |

An unknown key, a wrong type or a `release_as` that is not three plain numbers
(no `v`, no prerelease suffix; `2.0` alone is a YAML number) is an `::error::`
naming the key. The v2 blocks `deployment:` and `pipeline:` are still refused.

## Deploy semantics

Deploy runs only when a GitHub release is **published** (the train publishes it
after the Release PR merges). A prerelease deploys the `preview` environment,
a stable release deploys `production`. Pushes never deploy.

| provider | preview (prerelease) | production (stable) |
|---|---|---|
| `vercel` | `vercel deploy` preview target | `vercel deploy --prod` |
| `cloudflare-workers` | `wrangler deploy --env preview` | `wrangler deploy` |
| `docker-ghcr` | pushes `:<version>` and `:dev` | pushes `:<version>` and `:latest`, then the Render hook if enabled |
| `npm` | `npm publish --tag next` | `npm publish` |

A Vercel deploy checks the release out on its branch (`dev` for a prerelease,
`main` in a repository without one or for a stable release), so Vercel records
that branch rather than a detached `HEAD`. With `deploy.vercel.preview_alias`
set, every preview deployment is then aliased to that hostname: one URL that
always shows the latest preview.

The pipeline reads nothing from Infisical. Deploy credentials are GitHub
secrets, pushed there by Infisical's Secret Sync (in a Team org as environment
secrets of `preview` / `production`, so each deploy sees only its own). The app
env of a Vercel build comes from `vercel pull`. Check gets no deploy
credential and no app env.

## Train

A second reusable workflow, `.github/workflows/train.yaml`, beside the
pipeline. A repository opts in by carrying the caller
`.github/workflows/examples/train-caller.yaml` as `.github/workflows/train.yaml`,
pinned to the same commit as its Pipeline caller. Its main job, `train / Train`,
runs two steps over the whole repository — the event is only a poke:

- **Release** keeps one Release PR per branch up to date, and tags and
  publishes a merged one (which is what starts Deploy).
- **Merge** merges every open pull request the merge rules allow. It runs even
  when Release failed; either failure fails the job.

| trigger | why |
|---|---|
| `workflow_run`: `Pipeline` completed | a green Check on a pull request, or a green push run on `dev` / `main`. A red pull request run starts the Fix, below, or Verify when it is a Release PR's; cancelled and release runs start nothing |
| `workflow_dispatch` | after resolving review threads or removing a label without a push: `gh workflow run train.yaml` |
| `schedule`, four times a day (`17 */6 * * *`) | what no event reports: every finished Pipeline run starts the train already. The renderer removes this block where the owner's central sweep (`train-sweep.yaml` in this repository) covers the repository |

There is deliberately no `pull_request` trigger: it would run the pull
request's own copy of the caller with the secrets. All three triggers above run
the default branch's copy. For the same reason the Pipeline caller lists
`ready_for_review` among its `pull_request` types — lifting a draft re-runs the
pipeline, and that run's completion is what the train hears.

Controls:

- Label **`hold`** on a pull request: the train leaves it alone.
- Label **`needs-human`**: set by the train on a pull request it will not merge
  itself (one that changes `.github/workflows/**` or `.github/pipeline.yaml`,
  and so could have rewritten its own Check). A person merges it.
- Variable **`TRAIN`** = `off` (repository or organization): the caller's job
  is skipped, no runner starts. Any other value, or none, means on.
- Variable **`TRAIN_VERIFY`** = `off`: the Verify job alone is skipped, see
  [Verify](#verify).
- Secrets **`TRAIN_APP_ID`** and **`TRAIN_APP_PRIVATE_KEY`**: the GitHub App
  the train acts as. Everything it writes goes through that App's installation
  token, scoped to the one repository; the job's own token is `contents: read`.
  Without both secrets every step is skipped and the job ends green, so the
  caller can be rolled out first. **`CLAUDE_CODE_OAUTH_TOKEN`** belongs to the
  Fix, below.

The train runs on `vars.PIPELINE_RUNNER` in a private repository that sets
it; otherwise, and always in a public one, on GitHub's one-core `ubuntu-slim`
(ubuntu-latest while `PIPELINE_SLIM` is `off`, see "What each job reads").

### What becomes a release

The version comes from the conventional titles merged since the last stable
tag: breaking is a major, `feat` a minor, `fix`, `perf` and `revert` a patch
(before 1.0 breaking and `feat` are both a minor). On `dev` of a repository
that has `main` the Release PR carries `<target>-beta.N`, on `main` the stable
`<target>`: the promotion of dev's last beta.

Two rules decide whether there is a Release PR at all:

- **A merge without impact after a release is not a release.** `chore`, `ci`,
  `docs`, `test`, `refactor` and the like wait for the next `feat` or `fix`;
  the train reports `nothing to release on dev since v…`.
- **A release needs its own green `pipeline / Check`.** The Release PR is built
  only over a base tip whose push run passed, and the promotion on `main`
  waits for the Check on the commit of the beta it promotes. No other
  commit's Check counts for it, and none is copied onto it.

**A beta whose own Check is red is replaced, not repaired.** A beta can be cut
while its Check is broken for that very commit: a caller pinned to a broken
pipeline, a test that fails on exactly that tree. A rerun checks the same
commit again, so the promotion would wait for good, while the repair on `dev`
is a `chore(ci)` and by the first rule no release. The train therefore treats
the last beta of `dev` as superseded when `pipeline / Check` on its commit ran
to the end without passing (GitHub's conclusion `failure` or `timed_out`) and
`dev` has commits after it: they become the next beta of the same target
(`1.3.0-beta.1` is followed by `1.3.0-beta.2`), whatever their type. That
Release PR says which beta it replaces, waits for a green `dev` tip like any
other, and is merged by a person; `main` then promotes the new beta on its
own green Check. Until then the promotion reports the red Check together with
this way out.

A beta whose Check is green, still running, being rerun, only skipped (the
release event's run) or cancelled is not superseded, and the first rule
holds. A rerun that turns the old beta green after all makes it promotable
again; a replacement Release PR already open on `dev` then stays open and is
the owner's to merge or close.

**A cancelled Check is not a red one.** It did not run to its end: a person
stopped the run, or GitHub did, and the same commit can pass when the run is
started again. Where a release waits for such a commit, on the tip of `dev`
or on the beta `main` promotes, the train reports `pipeline / Check was
cancelled on … and has to be re-run` and names no replacement, because none
comes. Nothing starts the run again by itself: `gh run rerun <run id>`. Only
the conclusion GitHub reports is read, not what caused it, and one run on the
same commit that did end in `failure` makes the commit red whatever was
cancelled beside it.

`release_as` is no way around a red beta on `dev`: Guard admits only a stable
`X.Y.Z` there, and in a repository that has `dev` the train gives a stable
override to `main` alone.

### Verify

In a repository with two Check depths a Release PR is red, "Not fully
verified", until the tip of its base has passed the full Check, and no merge
starts that Check. `train / Verify` does: it starts the Pipeline on the base
branch, which is a full Check, and Recheck Release PR turns the Release PR
green when that run is.

The job starts on a Release PR's Pipeline run that concluded `failure`, and
on the caller's dispatch and schedule, which pick up what an event missed. It
looks at every open Release PR (head `release/<base>` in this repository) and
reads Guard's answer off the Release PR's own run: the Check job failed in its
step "Not fully verified". Any other Release PR is left alone. Then, for the
tip of the base branch:

| the tip's full Check (a dispatch or the nightly run, whoever started it) | Verify | row |
|---|---|---|
| none | starts one | `started` |
| queued or running | nothing | `running` |
| green | nothing; Recheck re-runs the Release PR | `verified` |
| red | nothing more for this commit, and one comment on the Release PR that names the failed step. A red full Check is a defect on the base, fixed through a pull request; its merge moves the tip, and the new tip is verified again. A flake: re-run the failed job of that run | `failed` |
| ended twice without a verdict (cancelled, timed out) | nothing | `gave_up` |

A merge into the base moves the tip while a full Check may still be running.
The runs this App started for a commit the branch has left behind are
cancelled first: they can no longer turn the Release PR green, and the caller
queues one dispatch behind the other. A run a person started is never
cancelled.

Verify decides no gate. Whether a Release PR is verified stays Guard's answer,
and nothing here makes a Release PR green or lets a release through.

**What it costs.** One full Check per merge into the base, or the part of one
that ran before the next merge, and a minute of the one-core runner per failed
Release PR run. Variable **`TRAIN_VERIFY`** = `off` (repository or
organization) skips the job, no runner starts, and the full Check is started
by hand again: `gh workflow run ci.yaml --ref <base> -R <owner/repo>`.

The App needs the repository permission **Actions: read and write**, as the
Fix does. The job asks for the App's token without naming a permission, as
the Train job does, so an App that holds only Actions: read does not fail it
in a repository where nothing waits. Where a Release PR does wait, GitHub
refuses the dispatch: the row says `refused`, names the permission, and the
job fails until the App has it or `TRAIN_VERIFY` is `off` there.

### Fix

When `pipeline / Check` fails on a pull request, three more jobs of the same
workflow act on it. They start only on a finished Pipeline run of a pull
request that concluded exactly `failure` — never on a dispatch or the
schedule, and not for a cancelled or timed-out run.

1. **Fix (triage)** reads the run and the pull request. It does nothing for a
   fork, a draft, a head that has moved on since the run, a `release/*`,
   `promote/*`, `backmerge/*` or `hotfix/*` head, a Dependabot pull request,
   one labelled `hold` or `needs-human`, or a run whose failed job is Guard
   (a wrong title or target is not something to patch). For the four head
   prefixes the job does not start at all. On the run's first attempt it
   reruns the failed jobs once and stops, unless the step of Check that
   failed is `Lint`, `Lint (trunk)`, `Test` or `Build`: the same commit fails
   those the same way, so they go to the proposal at once.
2. **Fix (propose)**, when the check is still red after its rerun or failed
   in one of those four steps: Claude Code runs headless
   on a checkout of the pull request's head, with the end of the failed job's
   log (300 lines, 40 KB at most). It can read, search and edit files in that
   checkout and nothing else: no shell, no network tool, no MCP server, and
   none of the repository's own Claude Code configuration is loaded. Nothing
   from the pull request is executed — no install, no test, no script. The
   job always runs on a fresh GitHub-hosted VM and holds no token that can
   write.
3. **Fix (commit)** takes the proposed change, never the tree. If the head has
   moved it does nothing. Otherwise the change goes through the guard and is
   committed onto the head as one signed `fix:` commit, or it is refused. Either
   way the diagnosis is posted as a comment. The commit starts the next
   Pipeline run, which is the test of the fix.

**Three attempts** per pull request, counted by the train's own comments. After
the third, or as soon as a proposed change is refused, the pull request gets
the label **`needs-human`** and the Fix leaves it alone
until a person removes the label.

**What a fix may never change.** It may edit only files the pull request
itself already changes, and may not create or delete one. Among those it never
touches:

- anything under `.github/`, `.trunk/` or `.husky/`;
- lockfiles;
- `package.json`, `pyproject.toml`, `tsconfig*.json`, and lint, format and
  test-runner configuration (`biome.json`, `eslint.config.*`, `.eslintrc*`,
  `.prettierrc*`, `prettier*`, `jest.config.*`, `vitest.config.*`,
  `playwright.config.*`, `pytest.ini`, `tox.ini`, `setup.cfg`,
  `.editorconfig`);
- a test file in a way that leaves it with fewer assertion lines or adds a
  skip, `only`, `todo` or expected-failure marker;
- any file in a way that adds a suppression (`@ts-ignore`, `eslint-disable`,
  `# noqa`, `# type: ignore`, `nolint` and the like).

Binary files, files over 200 KB, more than 20 files and content shaped like a
credential are refused as well. The rules are mechanical and refuse some honest
fixes; such a pull request waits for a person. No check, test or ruleset is
ever weakened or switched off to get a pull request green.

**Secrets.** The Fix needs the two App secrets above and
**`CLAUDE_CODE_OAUTH_TOKEN`**, a token from `claude setup-token`. The App needs
`actions: write` (the rerun), `contents: write` (the commit) and
`pull requests: write` and `issues: write` (comment and label). Without the
Claude token a red check gets at most its one rerun and nothing more. Do not set
an `ANTHROPIC_API_KEY` for this workflow: Claude Code would use it instead.

The token is tied to the Claude subscription of whoever created it. Every
proposal is billed to that subscription and draws on the same usage limits as
that person's own sessions; there is no separate quota. A run that hits a rate
limit, or a token that has expired (it lasts one year), does not fail the
workflow: the diagnosis in the comment says that Claude Code did not finish,
and the attempt counts. Because of that tie, set the token on private
repositories only.

## Repository variables and secrets

Variables (`vars.*`): `PIPELINE_RUNNER` (JSON array of labels), `PIPELINE_SLIM`
(`off` moves the one-core jobs to ubuntu-latest), `TRAIN` (`off` stops the
train, see above) and `TRAIN_VERIFY` (`off` stops its Verify job alone). In a Free org,
org-level values are invisible to private repositories: set it per repository.
The `INFISICAL_*` variables are no longer read.

Secrets are forwarded by the caller, all optional: `VERCEL_TOKEN`,
`VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `RENDER_DEPLOY_HOOK`, `NPM_TOKEN` (only without npm
trusted publishing). `CF_ACCESS_*` and `INFISICAL_CLIENT_*` are still declared
but unused, so that a caller rendered for an older release keeps starting; the
next release removes them. The Train caller forwards its own three, see above.
