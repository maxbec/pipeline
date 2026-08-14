<p align="center">
  <strong>Universal CI/CD Pipeline</strong><br>
  <em>A modern, configuration-driven GitHub Actions pipeline for any tech stack.</em>
</p>

<p align="center">
  <a href="https://github.com/navigaite/.github/releases/latest"><img src="https://img.shields.io/github/v/release/navigaite/.github?label=version&sort=semver&style=flat-square&color=4f46e5" alt="Latest Release"></a>
  <a href="https://github.com/navigaite/.github/actions/workflows/ci.yaml"><img src="https://img.shields.io/github/actions/workflow/status/navigaite/.github/ci.yaml?branch=main&style=flat-square&label=CI" alt="CI Status"></a>
  <a href="https://github.com/navigaite/.github/actions/workflows/nightly-maintenance.yaml"><img src="https://img.shields.io/github/actions/workflow/status/navigaite/.github/nightly-maintenance.yaml?branch=main&style=flat-square&label=weekly" alt="Weekly Maintenance"></a>
  <a href="https://github.com/navigaite/.github/blob/main/LICENSE"><img src="https://img.shields.io/github/license/navigaite/.github?style=flat-square&color=gray" alt="License"></a>
</p>

---

## Overview

The Universal Pipeline is a **reusable GitHub Actions workflow** that auto-detects your tech stack, runs security scans, lints, tests, builds, deploys, and releases — all from a single YAML config file.

**Current version: `v3.3.0-beta.18`** — consumers pin to `@v2` and always get the latest patch. <!-- x-release-please-version -->

### Highlights

| | |
|:--|:--|
| **Stacks** | Node.js, Python, Flutter (auto-detected) |
| **Deploy** | Vercel, DigitalOcean, Docker (Coolify + Render as standalone composites) |
| **Security** | TruffleHog, dependency review, Trivy, SLSA attestations |
| **Releases** | release-please or semantic-release with conventional commits |
| **Caching** | Dependency caches + automatic **Turborepo** remote cache (v2.6.9+) |
| **Skip-on-docs** | PRs touching only `*.md` / `docs/**` skip test+build+deploy (v2.7.0+) |
| **AI review** | Reusable Claude Code workflow for `@claude` PR reviews + fix commands |
| **Maintenance** | Weekly security audits, cache cleanup, workflow lint |

### What's new in v2.7.0 (2026-04-20)

- **Docs-only PR skip** — test, build and deploy jobs are skipped automatically on pull requests that change only markdown / `docs/**` / `LICENSE*` files ([#116](https://github.com/navigaite/.github/pull/116)). See [AGENTS.md §14](./AGENTS.md).
- **Turborepo cache across runs** (v2.6.9) — `run-tests` and `run-build` restore and save `node_modules/.cache/turbo` automatically ([#114](https://github.com/navigaite/.github/pull/114)).
- **Leaner dependency install** (v2.6.8) — redundant global `pnpm` install dropped from setup ([#112](https://github.com/navigaite/.github/pull/112)).
- **Claude Code reliability** (v2.6.2 – v2.6.7) — app-token minting for bot-triggered runs, Copilot review repost, queueing instead of cancellation.

---

## Quick Start

**1. Add the workflow** to your repo at `.github/workflows/ci.yaml`.

The template is **org-ruleset compliant** — the workflow `name:` and the `Branch Guard` / `Check Gate` job names are required for the ruleset "Protected branches" to match status checks. Do not rename them.

```yaml
name: Navigaite Pipeline

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: write
  pull-requests: write
  deployments: write
  packages: write
  id-token: write
  attestations: write
  security-events: write

jobs:
  branch-guard:
    name: Branch Guard
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - run: echo "Single-branch repo — all PRs target main directly"

  pipeline:
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

**2. Add a config** at `.github/pipeline.yaml`:

```yaml
version: "2.0"

deployment:
  provider: vercel
  environments:
    - name: preview
      trigger: { event: pull_request }
    - name: production
      trigger: { event: push, branch: main }

release:
  enable: true
  type: node
```

**3. Push.** The pipeline handles the rest.

> See [`.github/config/examples/`](.github/config/examples/) for Next.js + Vercel, Python + DigitalOcean, Flutter, and Docker-only configs.

---

## Pipeline Architecture

```
Push / PR
    |
    v
 [Setup] ─── auto-detect stack, parse config
    |
    ├──> [Security] ─── TruffleHog + dependency review
    ├──> [Lint] ─────── Trunk / custom + React Doctor
    └──> [Test] ─────── stack-specific tests + coverage
            |
            v
         [Build] ────── compile + SLSA attestation
            |
            ├──> [Deploy Vercel]
            ├──> [Deploy DigitalOcean]
            ├──> [Deploy Docker] ── multi-image, multi-arch
            └──> [Release] ──────── release-please / semantic-release
                    |
                    v
              [Sync to Dev] ─── auto-merge version changes
```

---

## Supported Stacks & Providers

<table>
<tr><th>Tech Stack</th><th>Package Managers</th><th>Detection</th></tr>
<tr><td><strong>Node.js</strong></td><td>npm, pnpm, yarn</td><td><code>package.json</code></td></tr>
<tr><td><strong>Python</strong></td><td>pip, poetry, pipenv</td><td><code>requirements.txt</code>, <code>pyproject.toml</code></td></tr>
<tr><td><strong>Flutter</strong></td><td>pub, FVM</td><td><code>pubspec.yaml</code></td></tr>
</table>

<table>
<tr><th>Provider</th><th>Preview</th><th>Staging</th><th>Production</th><th>Multi-arch</th></tr>
<tr><td><strong>Vercel</strong></td><td>Yes</td><td>Yes</td><td>Yes</td><td>-</td></tr>
<tr><td><strong>DigitalOcean</strong></td><td>Yes</td><td>Yes</td><td>Yes</td><td>-</td></tr>
<tr><td><strong>Docker</strong></td><td>-</td><td>-</td><td>Yes</td><td>amd64 + arm64</td></tr>
</table>

---

## Release Management

Releases are driven by [conventional commits](https://www.conventionalcommits.org/) and [release-please](https://github.com/googleapis/release-please):

| Commit | Bump | Example |
|--------|------|---------|
| `fix:` | Patch | `fix: resolve login timeout` |
| `feat:` | Minor | `feat: add dark mode` |
| `feat!:` | Major | `feat!: redesign API` |

### This Repo's Release Flow

1. Push to `main` with conventional commits
2. Release-please creates/updates a release PR with changelog
3. Merge the PR to publish a GitHub Release (`v2.x.x`)
4. The `v2` tag is automatically moved to the latest release

### Configure Releases in Your Repo

```yaml
release:
  enable: true
  strategy: release-please   # or semantic-release
  type: node                 # node | python | simple
  sync_to_dev: true
  prerelease_branches:
    - branch: next
      label: beta
```

---

## Configuration Reference

Full pipeline config (`.github/pipeline.yaml`):

```yaml
version: "2.0"

stack: nodejs                   # or auto-detect
runtime:
  node_version: "20"

security: { enable: true, fail_on_secrets: true }
lint:     { enable: true }
test:     { enable: true, coverage: true }
build:    { enable: true }

deployment:
  provider: vercel              # vercel | digitalocean | docker
  environments:
    - name: preview
      trigger: { event: pull_request }
    - name: production
      trigger: { event: push, branch: main }
  docker:
    images:
      - name: api
        dockerfile: Dockerfile.api
        platforms: linux/amd64,linux/arm64
      - name: worker
        dockerfile: Dockerfile.worker

release:
  enable: true
  strategy: release-please
  type: node
  sync_to_dev: true
  sync_target_branch: dev
  auto_promotion_pr: true    # keep a dev → main promotion PR open when dev is ahead
  auto_release_merge: true   # arm auto-merge on the stable release PR on main
```

**One-button release** (repos with a `dev` branch): feature PRs auto-merge into
`dev`; the pipeline keeps a `dev` → `main` promotion PR open and current; the
promotion PR is the only PR a human ever merges. After that merge everything is
automatic — the stable release-please PR on `main` auto-merges once its checks
are green, the GitHub release and tag publish, and the dev manifest reconciles.
See `release.auto_promotion_pr` / `release.auto_release_merge` in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

**Stage `enable:` vs. caller `skip-*` inputs:** the caller workflow can also pass
`skip-security` / `skip-lint` / `skip-test` / `skip-build` / `skip-deploy` as
`workflow_call` inputs. The two only ever combine to disable a stage, never
to re-enable one: `pipeline.yaml`'s `enable: false` always turns a stage off
regardless of the caller inputs, and a caller's `skip-*: true` turns a stage
off even if `pipeline.yaml` says `enable: true`. Setting `skip-*: false` (or
omitting it) never overrides an explicit `enable: false` in the config file.

---

## Security

| Layer | Tool | Purpose |
|-------|------|---------|
| Secrets | TruffleHog | Detect leaked credentials |
| Dependencies | Dependency Review | Vulnerable package detection in PRs |
| Containers | Trivy | Weekly vulnerability scans + SARIF upload |
| Build | SLSA Attestations | Supply chain integrity |
| Code | Shell injection prevention | All actions use `env:` blocks (semgrep compliant) |
| Actions | SHA-pinned versions | Immutable third-party dependencies |
| Permissions | Least privilege | Each job declares only what it needs |

---

## Reusable Actions

14 composite actions live in [`.github/actions/`](.github/actions/). The reusable workflow currently wires Vercel, DigitalOcean, and Docker; `deploy-coolify` and `deploy-render` remain standalone composites for custom jobs.

| Action | Purpose |
|--------|---------|
| `setup-environment` | Stack detection + runtime caching |
| `install-dependencies` | npm / pip / pub installation |
| `run-lint` | Multi-language linting |
| `run-tests` | Test execution with coverage |
| `run-build` | Build + SLSA attestations |
| `security-scan` | TruffleHog + dependency review |
| `release-management` | release-please / semantic-release |
| `sync-branches` | Post-release branch sync |
| `deploy-vercel` | Vercel deployment |
| `deploy-digitalocean` | DigitalOcean App Platform |
| `deploy-docker` | Docker build + multi-registry push |
| `deploy-coolify` | Coolify webhook deployment |
| `deploy-render` | Render deploy hook deployment |
| `build-executable` | PyInstaller cross-platform builds |

---

## Weekly Maintenance

Runs every Monday at **02:00 UTC** via [nightly-maintenance.yaml](.github/workflows/nightly-maintenance.yaml):

- Cleanup workflow runs > 30 days
- Purge caches > 7 days
- Trivy security audit (SARIF upload)
- Workflow lint (actionlint)

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](./docs/GETTING_STARTED.md) | Setup instructions |
| [Configuration](./docs/CONFIGURATION.md) | Full config reference |
| [Branching Strategy](./docs/BRANCHING_STRATEGY.md) | main / dev workflow |
| [Versioning Guide](./docs/VERSIONING_GUIDE.md) | Semver + conventional commits |
| [Auto Sync](./docs/AUTO_SYNC_FEATURE.md) | Post-release branch sync |
| [GitHub Settings](./docs/GITHUB_SETTINGS_GUIDE.md) | Repo configuration |
| [Actions Marketplace](./docs/GITHUB_ACTIONS_MARKETPLACE.md) | Curated action list |

---

## Contributing

1. Create a feature branch from `main`
2. Use [conventional commits](https://www.conventionalcommits.org/)
3. Open a PR — CI validates all actions and workflows
4. Merge to `main` — release-please handles the rest

---

## License

MIT

---

<p align="center"><strong>Navigaite</strong> &mdash; navigate + AI + IT</p>
