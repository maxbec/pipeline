# AGENTS.md — maxbec/pipeline

## 1. What this is

The reusable GitHub Actions workflow every repository across `navigaite`,
`edilio-app` and `maxbec` calls, SHA-pinned. It answers one question — does the
code check out, and does a published release deploy — and nothing else.
Versioning, release PRs, tags, changelogs and promotion are Flaiky's
(`maxbec/flaiky`, ADR 0003/0004/0009 there). Flama is gone.

## 2. Structure

```
.github/workflows/universal-pipeline.yaml   the three jobs; all logic is inline `run:` blocks
.github/workflows/examples/caller.yaml      the caller every repository carries (rendered by Flaiky)
.github/workflows/ci.yaml                   this repo's caller: uses ./.github/workflows/universal-pipeline.yaml
.github/pipeline.yaml                       this repo's own config (tests only)
.github/actions/deploy-{vercel,cloudflare,docker,render}   provider actions used by Deploy
.github/workflows/{trunk-upgrade,nightly-maintenance,hmac-cron-post}.yaml   other reusable workflows consumers call
test/                                       node:test; pulls `run:` blocks out of the YAML by step id and executes them
docs/CONFIGURATION.md                       the v3 config reference
scripts/                                    repo bootstrap and org maintenance helpers
```

## 3. The three jobs

- **Guard** (`ubuntu-latest`, always). Sparse-checks out `.github/pipeline.yaml`
  and the toolchain files, parses them into outputs for the other jobs (step
  id `config`), and on a pull request enforces (step id `rules`): a conventional
  title `type(scope)!: summary`; PRs into `main` only from `dev`, `promote/*`,
  `hotfix/*`, `release/*` when a `dev` branch exists; no fork PRs into `main`.
- **Check** (`needs: guard`, not on release events). On the configured runner:
  TruffleHog binary over the commit range, dependency review (public repos),
  Node/Python setup, install, lint (Trunk when `.trunk/trunk.yaml` exists),
  test, Infisical `preview` secrets, build, optional artifact. One job, so the
  context `pipeline / Check` is the single required status check everywhere.
- **Deploy** (`needs: guard`, only `release: published`, provider ≠ none). A
  matrix over `deploy-targets` (one leg per Docker image, one leg named `app`
  otherwise). Checks out `maxbec/pipeline` at `github.workflow_sha` into
  `.pipeline/` and runs the provider actions from there — the same commit the
  caller pinned, no moving tags. Prerelease → `preview`, stable → `production`.

## 4. Conventions that must hold

1. **Third-party actions are SHA-pinned** with a version comment. Own actions
   are reached through the `.pipeline/` checkout, never through a tag.
2. **A reusable workflow cannot see its own files**, so every script lives inline
   in a `run:` block with a stable step `id` (`config`, `rules`, `meta`). Tests
   extract them by id; keep the ids.
3. **Booleans in the config are read raw** (`bool()` in the config step): jq's
   `//` would turn an explicit `false` into the default.
4. **Exactly three jobs, named `Guard`, `Check`, `Deploy`.** The caller's job id
   is `pipeline`. Renaming any of these changes the required check context in
   every branch protection and ruleset.
5. **CI reads Infisical `preview`, never `production`.** Deploy reads the
   environment it deploys.
6. **No release-please, no Flama, no promotion workflows here.** If a change
   needs a version, Flaiky's release train handles it after merge.
7. Exactly three environments: `development`, `preview`, `production`.

## 5. Testing

```sh
npm test        # node --test "test/**/*.test.mjs" — needs yq and bash on PATH
actionlint      # https://github.com/rhysd/actionlint
```

`test/helpers.mjs` runs a `run:` block under `bash -e` with a scratch
`GITHUB_OUTPUT` and returns the parsed outputs; scratch space is
`test/.scratch/` (not `/tmp`: on the dev host yq is a confined snap). A PR here
is checked by the workflow it changes (`ci.yaml`).

## 6. Common tasks

- **New config key**: add it to the `config` step (output + `outputs:` block),
  a test in `test/parse-config.test.mjs`, and `docs/CONFIGURATION.md`.
- **New provider**: add `.github/actions/deploy-<x>/action.yaml`, a step under
  Deploy guarded by `env.PROVIDER == '<x>'`, the name to the provider `case` in
  the config step, the row in `docs/CONFIGURATION.md`, and the provider to the
  shape test.
- **Bump a pinned action**: change the SHA and the version comment together.
- **Roll out a pipeline change**: merge to `dev`, let Flaiky release it, then
  repin every caller with `provisioning/migrate-repos.ts` in `maxbec/flaiky`.
  A merged fix is live nowhere until callers repin.
