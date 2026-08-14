# AGENTS.md — Navigaite Universal CI/CD Pipeline

> Organization-wide reusable GitHub Actions pipeline (`navigaite/.github`), currently at **v2** (rolling tag). For the exact released version see `CLAUDE.md` (updated automatically by release-please).

This file is the single source of truth for AI coding agents (Claude, Copilot, Cursor, Codex, etc.) working in this repo **or** setting up this pipeline in a consumer repo. `CLAUDE.md` delegates here via `@AGENTS.md`.

---

## 1. What This Repo Is

This is **not an application** — it is a shared CI/CD infrastructure repo. It provides:

- A **reusable workflow** (`universal-pipeline.yaml`) that any repo in the `navigaite` org calls.
- **14 composite actions** for security, lint, test, build, deploy, and release.
- **Auto-detection** of tech stacks (Node.js, Python, Flutter).
- **Reusable deployment providers** in the universal pipeline (Vercel, DigitalOcean, Docker/GHCR), plus standalone Coolify and Render composite actions for custom jobs.
- **Release automation** via release-please or semantic-release.

Consumer repos integrate by adding a thin caller workflow + a `.github/pipeline.yaml` config.

---

## 2. Repo Structure

```
.github/
  workflows/
    universal-pipeline.yaml    # Core reusable workflow (consumers call this)
    release.yaml               # This repo's own release process
    create-release-pr.yaml     # Reusable: generate release PRs with changelog
    build-executables.yaml     # Reusable: PyInstaller cross-platform builds
    claude-code.yaml           # Reusable: Claude Code AI for PR reviews + @claude
    hmac-cron-post.yaml        # Reusable: HMAC-signed POST to an app cron endpoint
    promote-to-main.yaml       # Reusable: open dev → main promotion PR (Profile B)
    nightly-maintenance.yaml   # Scheduled: cache cleanup, security audits
    ci.yaml                    # CI: validates the composite actions and required check names
  actions/
    setup-environment/         # Stack auto-detection + runtime setup
    install-dependencies/      # Multi-stack dependency installation
    run-lint/                  # Auto-detected linting
    run-tests/                 # Auto-detected test runner
    run-build/                 # Build + optional SLSA attestation
    security-scan/             # TruffleHog + dependency review
    release-management/        # release-please or semantic-release
    sync-branches/             # Auto-sync main -> dev after release
    deploy-vercel/
    deploy-digitalocean/
    deploy-docker/
    deploy-coolify/
    deploy-render/
    build-executable/          # PyInstaller single-platform build
  config/
    examples/                  # Example pipeline.yaml files for consumers
docs/                          # Human-readable guides
```

### Pipeline Flow

```
Setup (stack detect + config parse)
  -> Security (TruffleHog, dependency review)
  -> Lint + Test (parallel)
    -> Build (+ SLSA attestation)
      -> Deploy (Vercel | DigitalOcean | Docker | Coolify | Render)
        -> Release (release-please | semantic-release)
          -> Sync to dev (auto-merge version bumps back)
```

Each stage is independently toggleable via the consumer's `.github/pipeline.yaml`.

---

## 3. Setup Flow for Consuming Agents (Q&A)

**Use this flow when a user asks you to set up the Navigaite pipeline in a new or existing repo.** Ask the user these questions in order. Each answer determines what you generate.

### Q1 — Branching profile (required)

> Will this repo use **Profile A (small: feature → main)** or **Profile B (large: feature → dev → main with prereleases)**?

- **Default to Profile A** unless the user explicitly wants a staging branch, beta versioning, or this is a large product repo (e.g. `edilio`).
- Profile B implies: default branch = `dev`, prerelease versions on `dev`, stable on `main`, merge-commit promotions.

### Q2 — Deployment provider (required)

> Which deploy provider: `vercel`, `digitalocean`, `docker` (GHCR), or `none`?

- Choose `none` if the user deploys via a custom job/webhook — you will add that job next to the `pipeline` job.
- `deploy-coolify` and `deploy-render` exist as standalone composite actions, but are not wired into `universal-pipeline.yaml`.
- Provider determines which secrets the user must configure (see §6).

### Q3 — Release automation (required)

> Enable releases? If yes, use `release-please` (recommended) or `semantic-release`? What `type`: `node`, `python`, or `simple`?

- Most consumers want `release-please` + `node` or `python`.
- Profile B repos need TWO release-please configs (dev=prerelease, main=stable) — see §5.

### Q4 — Stack override (optional)

> Should stack auto-detection be overridden?

- Auto-detection order: `package.json` → Node.js, `requirements.txt|pyproject.toml|setup.py|Pipfile` → Python, `pubspec.yaml` → Flutter.
- Only override if detection picks the wrong stack.

### Q5 — Custom lint/test/build commands (optional)

> Are the default auto-detected commands correct, or does this repo use non-standard tooling (Turbo, Trunk, etc.)?

- Only set `lint.command`, `test.command`, `build.command` if defaults don't work.

### Q6 — Environments per branch (required if deploying)

> Which environments (preview / staging / production) trigger on which events/branches?

- Standard mapping: `preview` on PR, `staging` on push-to-dev, `production` on push-to-main.
- Small repos (Profile A) skip `staging`.

### Q7 — Secrets (required if deploying or releasing)

> Have the provider-specific secrets been added to the repo (Settings → Secrets → Actions)?

- If not, stop and instruct the user to add them before the pipeline will pass. See §6.

---

## 4. MANDATORY vs OPTIONAL — Consumer Integration Checklist

When adding this pipeline to a consumer repo, items below are marked **[MANDATORY]** (required for org ruleset compliance / correctness) or **[OPTIONAL]** (project-specific).

### [MANDATORY] Caller workflow

- **File path**: `.github/workflows/ci.yaml`
- **Workflow `name:`**: exactly `Navigaite Pipeline` — for consistent UI grouping and org-wide convention (ruleset enforcement is on the bare required-check job names below, not on this prefix — see §8)
- **Calling job key**: exactly `pipeline`, with NO explicit `name:` field (this is the YAML job key used by other jobs' `needs:`)
- **Job: `Branch Guard`** (exact name, no emoji) — required status check
- **Job: `Check Gate`** (exact name, no emoji) — required status check
- **Pin**: `@v2` (rolling tag) — do NOT pin to `@main` except for testing unreleased changes
- **`secrets: inherit`** on the pipeline job
- **`permissions:` block** at workflow level covering all enabled stages

Minimal caller template (Profile A — small repo):

```yaml
name: Navigaite Pipeline

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    # ready_for_review required — without it, un-drafting a PR doesn't
    # fire a new run, so draft release-please PRs would never execute CI.
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: write          # releases, tag updates
  pull-requests: write     # PR comments
  id-token: write          # OIDC + SLSA attestation
  deployments: write       # deployment status
  packages: write          # Docker/GHCR
  attestations: write      # SLSA provenance
  security-events: write   # SARIF uploads

jobs:
  branch-guard:
    name: Branch Guard
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - run: echo "Single-branch repo — all PRs target main directly"

  pipeline:
    # Skip draft PRs. release-please opens its release PRs as drafts by
    # default (v2.8.0+) so the full pipeline doesn't run on every merge
    # that updates the release PR's changelog — it only fires when a
    # human marks the release PR ready to publish.
    if: github.event.pull_request.draft != true
    uses: navigaite/.github/.github/workflows/universal-pipeline.yaml@v2
    with:
      config-file: .github/pipeline.yaml
    secrets: inherit

  check-gate:
    name: Check Gate
    if: always()
    needs: [pipeline]
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions:
      # actions: read is required to list this run's jobs for the summary
      # table. The reusable workflow no longer renders it in its own job.
      actions: read
    steps:
      # Best-effort rendering only — never let a summary failure flip the
      # required status check. The gate step below is authoritative.
      - name: Render pipeline summary
        if: always()
        continue-on-error: true
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          RUN_ID: ${{ github.run_id }}
        run: |
          set -uo pipefail
          status_icon() {
            case "$1" in
              success) echo "✅" ;;
              failure) echo "❌" ;;
              skipped) echo "⏭️" ;;
              cancelled) echo "🚫" ;;
              *) echo "❓" ;;
            esac
          }
          {
            echo "## 📊 Pipeline Summary"
            echo ""
            echo "| Stage | Status |"
            echo "| --- | --- |"
            gh api "repos/$REPO/actions/runs/$RUN_ID/jobs?per_page=100" --paginate \
              --jq '.jobs[] | select(.conclusion != null) | "\(.name)\t\(.conclusion)"' \
              | while IFS=$'\t' read -r job conclusion; do
                  echo "| $job | $(status_icon "$conclusion") $conclusion |"
                done
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Evaluate pipeline result
        shell: bash
        env:
          RESULTS: ${{ toJSON(needs.*.result) }}
        run: |
          set -euo pipefail
          command -v jq >/dev/null || { echo "::error::jq not available"; exit 1; }
          echo "Job results: $RESULTS"
          FAILURES=$(echo "$RESULTS" | jq -r 'map(select(. == "failure" or . == "cancelled")) | length')
          if [[ "$FAILURES" -gt 0 ]]; then
            echo "::error::Pipeline failed — ${FAILURES} job(s) failed or were cancelled"
            exit 1
          fi
          echo "All pipeline jobs passed"
```

For **Profile B (large repo with dev + main)** the Branch Guard must enforce:

- Feature PRs must target `dev`, not `main`
- Only `dev` (promotion), `release-please--*`, and `hotfix/*` branches may target `main`
- Block promotion if `dev` has an open release-please PR

See `edilio` or `maimaldrei-mietkatalog` `ci.yaml` for the full implementation.

### [MANDATORY] Pipeline config file

- **File path**: `.github/pipeline.yaml`
- Must declare `version: '2.0'`

### [MANDATORY] Conventional Commits

- Commit messages must follow conventional commits (commitlint is enforced).
- Types: `feat`, `fix`, `chore`, `ci`, `docs`, `test`, `refactor`, `perf`, `build`, `style`, `revert`.
- Breaking: `feat!:` or footer `BREAKING CHANGE:`.

### [MANDATORY] Signed commits

- Org ruleset "Protected branches" requires signed commits on `main` and `dev`.

### [OPTIONAL] Individual pipeline stages

Each of these can be enabled/disabled via `pipeline.yaml`:

- `security:` — TruffleHog + dependency review
- `lint:` — auto-detected linting
- `test:` — auto-detected test runner
- `build:` — build + optional SLSA attestation
- `deployment:` — provider choice (or `none`)
- `release:` — release-please or semantic-release

### [OPTIONAL] Stack / runtime override

Only set `stack:` or `runtime:` when auto-detection is wrong.

### [OPTIONAL] Custom commands

Only set `lint.command`, `test.command`, `build.command` if defaults don't work.

### [OPTIONAL] Infisical integration

Inject build-time secrets from Infisical — configured per-consumer.

### [OPTIONAL] Custom deploy jobs

Set `deployment.provider: none` and add your own job depending on `pipeline`:

```yaml
  deploy-production:
    name: Deploy Production
    needs: [pipeline]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: curl -sf "${{ secrets.RENDER_DEPLOY_HOOK }}"  # project-defined secret
```

### [OPTIONAL] Promotion workflow (Profile B only)

Adds a "Run workflow" button in the repo's Actions tab that opens a `dev → main` promotion PR. Useful for one-click promotion from the UI or `gh workflow run promote.yml -R <repo>` from automation.

`.github/workflows/promote.yml`:

```yaml
name: 📤 Promote dev → main
on:
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

jobs:
  promote:
    uses: navigaite/.github/.github/workflows/promote-to-main.yaml@v2
```

The reusable validates preconditions (no open release-please PR on `dev`, `dev` ahead of `main`, no duplicate promotion PR) before opening. The PR is intentionally not auto-merged — GITHUB_TOKEN merges strip downstream workflow triggers, so the operator merges via the UI (Merge commit).

### [OPTIONAL] HMAC-signed cron jobs

For scheduled HMAC-signed POSTs to an app endpoint (e.g. nightly billing tasks), use the `hmac-cron-post.yaml` reusable instead of hand-rolling the openssl pipeline per cron.

Requires `secrets.CRON_HMAC_KEY` (matches runtime) and `vars.CRON_BASE_URL` (public origin, no trailing slash) on the repo.

`.github/workflows/cron-<name>.yml`:

```yaml
name: 🕒 <Display Name>
on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch: {}
concurrency:
  group: cron-<name>
  cancel-in-progress: false
jobs:
  run:
    uses: navigaite/.github/.github/workflows/hmac-cron-post.yaml@v2
    with:
      endpoint: /api/cron/<name>
    secrets: inherit
```

### [OPTIONAL] Workflow naming convention

Use a single emoji prefix on each workflow `name:` field for visual scanning in the Actions tab. This applies to **all workflow files** in this repo (reusables and callers) and to the **consumer / caller workflows** templated into downstream repos. It is **purely cosmetic** and does **not** affect required check names (those come from job `name:` fields — see §8).

| Prefix | Usage | Example |
| --- | --- | --- |
| `🌙` / `🗓️` | Nightly / weekly scheduled maintenance | `nightly-maintenance.yaml` |
| `🌍` | Translation / localization | reserved |
| `🕒` | Scheduled HMAC cron jobs (callers and the `hmac-cron-post` reusable) | `hmac-cron-post.yaml` |
| `🏷️` | Label sync | reserved |
| `🤖` | Claude / Copilot helpers | `claude-code.yaml`, `claude-code-fix.yaml` |
| `🧰` / `🌲` | Trunk upgrade and other tooling bumps | `trunk-upgrade.yaml`, `trunk-upgrade-scheduled.yaml` |
| `📤` | Promotion / release-orchestration triggers | `promote-to-main.yaml` |

The main pipeline workflow keeps its bare `Navigaite Pipeline` name — that string is part of the required check naming contract.

---

## 5. Pipeline Config Reference (`.github/pipeline.yaml`)

Minimal Profile A config:

```yaml
version: '2.0'

deployment:
  provider: vercel              # [MANDATORY if deploying] vercel|digitalocean|docker|none
  environments:                 # [MANDATORY if deploying]
    - name: preview
      trigger:
        event: pull_request
    - name: production
      trigger:
        event: push
        branch: main

release:
  enable: true                  # [OPTIONAL]
  type: node                    # node|python|simple
```

Profile B config (dev + main with prereleases):

```yaml
release:
  enable: true
  strategy: release-please
  config_file: release-please-config.json            # prerelease on dev
  config_file_stable: release-please-config.main.json # stable on main
  manifest_file: .release-please-manifest.dev.json    # beta stream (dev)
  manifest_file_stable: .release-please-manifest.json # stable stream (main)
  sync_to_dev: true
  prerelease_branches:
    - branch: dev
      label: beta
```

Full reference: `docs/CONFIGURATION.md`. Working examples: `.github/config/examples/`.

---

## 6. Secrets (Per Provider)

Add to repo Settings → Secrets → Actions:

| Provider | Required secrets |
| --- | --- |
| **Vercel** | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` |
| **DigitalOcean** | `DIGITALOCEAN_TOKEN` |
| **Docker / GHCR** | defaults to `GITHUB_TOKEN`; override with `DOCKER_REGISTRY_USERNAME` + `DOCKER_REGISTRY_PASSWORD` |
| **Coolify** | `COOLIFY_URL`, `COOLIFY_TOKEN` |
| **Render** | `RENDER_DEPLOY_HOOK` (per env) |
| **Workflow automation (THIS repo only)** | `WORKFLOW_APP_ID` + `WORKFLOW_APP_PRIVATE_KEY` — **not needed for consumer repos**. Falls back to `GITHUB_TOKEN`. |

---

## 7. Branching & Release Strategy

### Profile A — Small repos (feature → main)

- `main` is the only long-lived branch and the default branch.
- Feature branches squash-merge to `main` via PR.
- release-please produces stable versions (`v1.0.0`, `v1.1.0`).
- No `dev` branch, no prerelease versions.

### Profile B — Large repos (feature → dev → main)

- `dev` is the integration branch and the **default branch** (PRs target `dev` by default).
- `main` is the production branch.
- Feature branches squash-merge to `dev` via PR.
- release-please on `dev` produces beta versions (`v0.4.0-beta.1`).
- Promotion: **merge-commit** PR from `dev → main` (preserves conventional commit history).
- release-please on `main` produces stable versions (`v1.0.0`).
- Pipeline auto-syncs `main` back to `dev` after promotion (`sync_to_dev: true`).
- Branch Guard blocks feature PRs targeting `main`.

### Merge methods

- Feature PRs: **squash** (enforced via repo-level rulesets for large repos).
- release-please PRs: **squash**.
- `dev → main` promotions: **merge commit** (enforced via repo-level ruleset on `main`).

### Promotion preconditions (Profile B only)

1. No open release-please PR on `dev`.
2. All CI checks pass.
3. Merge commit method (enforced by ruleset).

### Repo settings (all repos)

- Default branch: `dev` (Profile B) or `main` (Profile A).
- Squash merge: enabled (title = PR title, body = PR body).
- Merge commit: enabled.
- Rebase: disabled.
- Delete branch on merge: yes.
- Auto-merge: yes.

---

## 8. CI Check Naming Convention

### Required check names (Org Ruleset)

The org-level ruleset "Protected branches" requires exactly two status checks. GitHub matches them on the bare `check_run.name` (the job `name:` field), **not** the workflow-prefixed path shown in the PR UI.

| Ruleset context | Job `name:` | Purpose |
| --- | --- | --- |
| `Check Gate` | `Check Gate` | Aggregator — passes only when all pipeline stages pass |
| `Branch Guard` | `Branch Guard` | Enforces branch targeting rules |

The PR UI displays these as `Navigaite Pipeline / Check Gate` and `Navigaite Pipeline / Branch Guard` — the `Navigaite Pipeline /` prefix is visual grouping only. **Do NOT include the prefix in ruleset configuration** — it will fail to match.

### Resulting check names (PR UI)

- `Navigaite Pipeline / Check Gate` — **required**
- `Navigaite Pipeline / Branch Guard` — **required**
- `Navigaite Pipeline / pipeline / 🧹 Lint` — informational
- `Navigaite Pipeline / pipeline / 🧪 Test` — informational
- `Navigaite Pipeline / pipeline / 🏗️ Build` — informational
- `Navigaite Pipeline / pipeline / 🔧 Setup & Configuration` — informational
- (other pipeline stages as configured)

### Why this convention

1. **No emoji in required check names** — emoji encoding varies and can silently break exact-match.
2. **Single gate check** — adding/removing stages doesn't require updating the org ruleset.
3. **Uniform prefix** — all repos produce `Navigaite Pipeline / ...` checks.
4. **Branch Guard is a top-level job** — outside the reusable workflow, so it always reports regardless of pipeline configuration.

### Do NOT

- Use a different workflow `name:` (e.g., `CI/CD Pipeline`, `CI`, `Build`).
- Add an explicit `name:` to the `pipeline` job (changes the check name prefix).
- Remove the Check Gate or Branch Guard jobs.
- Add individual pipeline stages (Lint, Test, Build) to the org ruleset's required checks.

---

## 9. Org-Level & Repo-Level GitHub Rulesets

### Org rulesets (apply to ALL `navigaite` repos)

**"Protected branches"** — targets `~DEFAULT_BRANCH`, `refs/heads/main`, and `refs/heads/dev`:

- PR required: 1 approval, dismiss stale reviews, resolve conversations.
- Merge methods: squash + merge (repo-level rulesets narrow per branch).
- Required status checks: `Check Gate`, `Branch Guard`.
- Signed commits, no force push, no deletion.
- Copilot code review: auto-review on push.
- Bypass: org admins + `navigaite-workflow-app` bot.

**"Tag protection"** — targets `v*` tags:

- No deletion, no force push, restrict creation.
- Bypass: org admins + `navigaite-workflow-app` bot.

### Repo-level rulesets (Profile B only)

- **"dev: squash only"** — forces squash on `dev`.
- **"main: merge only (promotions)"** — forces merge commits on `main`.

---

## 10. Development Conventions (for THIS repo)

### Commits

Use conventional commits. Bumps driven by release-please:

- `feat:` → minor bump
- `fix:` → patch bump
- `feat!:` or `BREAKING CHANGE:` → major bump
- `chore:`, `ci:`, `docs:`, `test:`, `refactor:`, `perf:` → no bump (hidden unless `docs`/`refactor`/`perf`)

### Versioning

- release-please manages versions via `.release-please-manifest.json` and `.github/release-please-config.json`.
- The `release.yaml` workflow updates rolling `v{MAJOR}` and `latest` tags so consumers pinned to `@v2` get patches automatically.
- **Never manually edit version numbers** — release-please handles it.

---

## 11. Key Design Decisions

1. **Third-party actions are SHA-pinned** — never `@v4` style tags for external actions. Always pin to exact commit SHA with a version comment.
2. **Path traversal protection** — all actions validate `working-directory` inputs to prevent `../` attacks. `ci.yaml` tests this.
3. **Stack auto-detection order**: `package.json` → Node.js, `requirements.txt|pyproject.toml|setup.py|Pipfile` → Python, `pubspec.yaml` → Flutter.
4. **Environment filtering** — the setup job filters deployment environments by matching the current event + branch against each environment's trigger config. Only matching environments proceed to deploy jobs.
5. **Infisical integration** — optional, per-consumer secret injection at build time.
6. **GitHub App for workflow triggers** — `GITHUB_TOKEN` merges don't trigger subsequent workflow runs. This repo uses `WORKFLOW_APP_ID` + `WORKFLOW_APP_PRIVATE_KEY` via `actions/create-github-app-token` so release PR merges trigger the release publish workflow.

---

## 12. Testing Changes

Run `ci.yaml` locally via `act` or on a feature branch. It validates:

- `actionlint` on all workflow definitions.
- Invalid stack rejection for each action.
- Path traversal prevention.

When modifying an action, **also test it against a real consumer repo** before merging.

---

## 13. Common Tasks

### Adding a new deployment provider

1. Create `.github/actions/deploy-{provider}/action.yaml`.
2. Add the deploy job to `universal-pipeline.yaml` (follow existing `deploy-vercel` pattern).
3. Add provider to the setup job's environment filtering logic.
4. Add an example config in `.github/config/examples/`.
5. Document in `docs/CONFIGURATION.md`.

### Modifying pipeline stages

Edit `universal-pipeline.yaml`. Each stage is a separate job with conditional execution based on the setup job's outputs. The `needs` graph enforces ordering.

### Updating a pinned action version

Find the SHA-pinned `uses:` line, update both the SHA and the version comment. Verify the SHA matches the tagged release on the action's repo.

---

## 14. Skipping CI Runs

The pipeline has three ways to avoid burning CI minutes on work that doesn't need full validation.

### Auto-skip on docs-only PRs (v2.7.0+)

When a pull request's changed file list matches only these patterns, the pipeline automatically skips `security`, `lint`, `test`, `build`, and all `deploy-*` jobs:

- `**/*.md`, `**/*.mdx`
- `docs/**`, `**/docs/**`
- `**/LICENSE`, `**/LICENSE.*`

`release` and `sync-to-dev` still run on push events so docs commits land in changelogs as intended.

The classification uses the GitHub PR Files API from the `setup` job, so it works without any extra git fetch. If the API lookup fails, the pipeline falls back to a full run (safe default). Detection only applies to `pull_request` events — `push` events (e.g. merges to `dev`/`main`) always run the full pipeline so deploys aren't silently skipped.

### Native `[skip ci]` in commit messages

GitHub natively skips **all workflow runs** for a push/PR when the head commit message contains any of these markers:

- `[skip ci]`
- `[ci skip]`
- `[no ci]`
- `[skip actions]`
- `[actions skip]`

Use this for commits that genuinely don't need any CI (e.g. `chore: fix typo in trailing comment`). **Caveat:** required status checks won't report, so PRs can't be merged without manually re-running CI first. Safer for push commits on feature branches than for PRs headed to merge.

### Draft PRs

By default, draft PRs still trigger the full pipeline — GitHub's default `pull_request` event includes drafts. Consumer caller workflows that want to skip CI on drafts can add:

```yaml
on:
  pull_request:
    branches: [main, dev]
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  pipeline:
    if: github.event.pull_request.draft == false
    uses: navigaite/.github/.github/workflows/universal-pipeline.yaml@v2
    ...
```

The `ready_for_review` trigger type is required — without it, un-drafting a PR doesn't fire a new workflow run, so the pipeline would never execute. This is a per-consumer opt-in; not all repos want draft skip.

---

## 15. Known Limitations

- **Skipped deploy jobs show `${{ matrix.environment }}`** in the GitHub Actions sidebar. When a matrix job is skipped (e.g. `deploy-vercel` when provider is `none`), the matrix expression is never resolved so GitHub shows it raw. Cosmetic only — jobs are properly skipped and don't affect the pipeline result.

---

## 16. Further Reading

- `docs/GETTING_STARTED.md` — 5-minute consumer quickstart.
- `docs/CONFIGURATION.md` — full `pipeline.yaml` reference.
- `docs/BRANCHING_STRATEGY.md` — Profile A vs B deep dive.
- `docs/VERSIONING_GUIDE.md` — release-please setup.
- `docs/ORG_MAINTENANCE.md` — org ruleset + bootstrap tooling.
- `.github/config/examples/` — working config samples.

<!-- flama-delivery:start -->
## Flama delivery

This repository uses the major delivery profile. Target dev for feature work and main for promotion.
Run deterministic checks only through `./scripts/delivery`.
Never expose secret values; use the approved Infisical identity and paths.
Production requires Max's approval of the exact deployment PR head SHA.
Do not edit centrally generated `.flama` or Flama workflow files by hand.
<!-- flama-delivery:end -->
