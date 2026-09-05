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

runner:
  labels: [] # default: vars.PIPELINE_RUNNER if set on the repository or org, else ubuntu-latest

security:
  enable: true
  trufflehog: true # verified secrets in the commit range; the pinned binary, no Docker needed
  dependency_review: true # public repositories only; a private one without GHAS gets a notice
  fail_on_secrets: true
  fail_on_vulnerabilities: false # true fails on moderate+, false warns

lint:
  enable: true
  command: '' # default: `trunk check` when .trunk/trunk.yaml exists, else `<pm> run lint` if the script exists

test:
  enable: true
  command: '' # default: `<pm> test` if the script exists; python: `pytest` when tests/ exists

build:
  enable: true
  command: '' # default: `<pm> run build` if the script exists. Multi-line commands are fine.
  artifact_path: '' # optional: uploaded as build-<sha> for 7 days

deploy:
  provider: none # none | vercel | cloudflare-workers | docker-ghcr | npm
  vercel:
    scope: '' # team slug
    build_command: ''
  cloudflare:
    config: wrangler.toml
    build_command: ''
  docker:
    cache_backend: gha
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
```

## What each job reads

| job | reads | runs on |
|---|---|---|
| Guard | everything above; on pull requests also the PR title and branches | ubuntu-latest |
| Check | `security`, `lint`, `test`, `build`, `runtime`, `stack` | `runner.labels` |
| Deploy | `deploy`, `runtime`, `stack` | `runner.labels` |

## Deploy semantics

Deploy runs only when a GitHub release is **published** (Flaiky publishes it
after the Release PR merges). A prerelease deploys the `preview` environment,
a stable release deploys `production`. Pushes never deploy.

| provider | preview (prerelease) | production (stable) |
|---|---|---|
| `vercel` | `vercel deploy` preview target | `vercel deploy --prod` |
| `cloudflare-workers` | `wrangler deploy --env preview` | `wrangler deploy` |
| `docker-ghcr` | pushes `:<version>` and `:dev` | pushes `:<version>` and `:latest`, then the Render hook if enabled |
| `npm` | `npm publish --tag next` | `npm publish` |

Deploys read secrets from Infisical's `preview` or `production` environment
(`vars.INFISICAL_PREVIEW_ENV_SLUG` / `vars.INFISICAL_PROD_ENV_SLUG` override
the slugs). Builds in Check always read `preview` — CI never sees production
credentials.

## Repository variables and secrets

Variables (`vars.*`): `PIPELINE_RUNNER` (JSON array of labels),
`INFISICAL_IDENTITY_ID` (OIDC), `INFISICAL_PROJECT_SLUG`, `INFISICAL_ENV_SLUG`,
`INFISICAL_DOMAIN`, `INFISICAL_SECRET_PATH`. In a Free org, org-level values are
invisible to private repositories: set them per repository.

Secrets are forwarded by the caller, all optional: `CF_ACCESS_CLIENT_ID`,
`CF_ACCESS_CLIENT_SECRET`, `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`,
`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `RENDER_DEPLOY_HOOK`, `NPM_TOKEN` (only without npm
trusted publishing).
