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
  dependency_cache: true # default: true on a GitHub-hosted runner, false when the runner labels contain self-hosted (its package store outlives the job, and saving the cache uploads gigabytes over the runner's own uplink). Also switches trunk's cache

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
    cache_backend: gha # gha | local | none. Default: gha on a GitHub-hosted runner, local (the runner's work volume, /_work/.buildx-cache) when the runner labels contain self-hosted
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
  version_files: [package.json] # the files that carry the version, non-empty list of paths
  changelog_show_hidden: false # also list chore/ci/test/… entries in the changelog
  release_as: 2.0.0 # force the next version to X.Y.Z; ignored once a tag at or above it exists
```

## What each job reads

| job | reads | runs on |
|---|---|---|
| Guard | everything above; on pull requests also the PR title and branches | ubuntu-latest |
| Check | `security`, `lint`, `test`, `build`, `runtime`, `stack` | `runner.labels` |
| Deploy | `deploy`, `runtime`, `stack` | `runner.labels` |
| Train (second workflow) | `release` | `vars.PIPELINE_RUNNER` in a private repository, else ubuntu-latest |

## `release:`

Every key is optional, and so is the block. Guard validates it on every run, so
a typo fails the pull request that makes it rather than a release weeks later:

| key | type | meaning |
|---|---|---|
| `version_files` | non-empty list of non-empty strings | files whose version the Release PR bumps |
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
pinned to the same commit as its Pipeline caller. One job, `train / Train`,
runs two steps over the whole repository — the event is only a poke:

- **Release** keeps one Release PR per branch up to date, and tags and
  publishes a merged one (which is what starts Deploy).
- **Merge** merges every open pull request the merge rules allow. It runs even
  when Release failed; either failure fails the job.

| trigger | why |
|---|---|
| `workflow_run`: `Pipeline` completed | a green Check on a pull request, or a green push run on `dev` / `main`. Red, cancelled and release runs start nothing |
| `workflow_dispatch` | after resolving review threads or removing a label without a push: `gh workflow run train.yaml` |
| `schedule`, every 30 minutes | what no event reports. The renderer removes this block where the owner's central sweep (`train-sweep.yaml` in this repository) covers the repository |

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
- Secrets **`TRAIN_APP_ID`** and **`TRAIN_APP_PRIVATE_KEY`**: the GitHub App
  the train acts as. Everything it writes goes through that App's installation
  token, scoped to the one repository; the job's own token is `contents: read`.
  Without both secrets every step is skipped and the job ends green, so the
  caller can be rolled out first. **`CLAUDE_CODE_OAUTH_TOKEN`** is declared for
  a later release and unused today.

The train runs on `vars.PIPELINE_RUNNER` in a private repository and always
GitHub-hosted in a public one.

## Repository variables and secrets

Variables (`vars.*`): `PIPELINE_RUNNER` (JSON array of labels) and `TRAIN`
(`off` stops the train, see above). In a Free org,
org-level values are invisible to private repositories: set it per repository.
The `INFISICAL_*` variables are no longer read.

Secrets are forwarded by the caller, all optional: `VERCEL_TOKEN`,
`VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `RENDER_DEPLOY_HOOK`, `NPM_TOKEN` (only without npm
trusted publishing). `CF_ACCESS_*` and `INFISICAL_CLIENT_*` are still declared
but unused, so that a caller rendered for an older release keeps starting; the
next release removes them. The Train caller forwards its own three, see above.
