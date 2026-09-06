# Org-wide Maintenance Automation

This repo bootstraps three kinds of automatic upkeep into every `navigaite` org repo:

1. **Dependabot** for the `github-actions` ecosystem (third-party action version bumps).
2. **`trunk upgrade`** on a weekly schedule, staggered per repo, auto-merging after CI.
3. ~~Claude Code caller~~ — retired 2026-09: Flaiky's Issue Worker and review stages replaced the `@claude` workflows; the reusable `claude-code.yaml` no longer exists.

It does **not** manage bumps of the reusable pipeline itself — consumers pin `maxbec/pipeline/...@<sha>`, and `provisioning/migrate-repos.ts` in `maxbec/flaiky` repins the whole fleet after a release.

## Architecture

| Piece                                          | Location                                                     | Role                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Reusable `trunk-upgrade.yaml`                  | `.github/workflows/trunk-upgrade.yaml` (this repo)           | Runs `trunk upgrade`, opens a PR, enables auto-merge via the workflow App. |
| Trunk Upgrade caller                           | `.github/workflows/trunk-upgrade-scheduled.yaml` (every repo) | Scheduled caller with a staggered cron; delegates to the reusable workflow at `@v2`. Distinct filename so it coexists with the reusable in this repo. |
| Dependabot config                              | `.github/dependabot.yml` (each consumer repo)                | Weekly grouped github-actions updates. Ignores `navigaite/.github/*`. **Skipped if a bespoke `dependabot.yml` (no `Managed by navigaite/.github bootstrap` header) already exists** — bootstrap will not overwrite hand-maintained configs that may include npm/pip/etc. |
| Reusable `claude-code.yaml`                    | `.github/workflows/claude-code.yaml` (this repo)             | Runs the `claude-code-action` with diagnostics + permissive bot filter.    |
| Claude Code caller                             | `.github/workflows/claude-code-fix.yaml` (every repo)        | Thin caller that defines triggers + gating and delegates execution to the reusable workflow at `@v2`. Distinct filename so the caller can coexist with the reusable inside this repo too. |
| Bootstrap script                               | `scripts/bootstrap-maintenance.sh` (this repo)               | Pushes the three caller files into every org repo via PRs. Deletes legacy caller-style `trunk-upgrade.yaml` and `claude-code.yaml` (preserves reusable definitions). Idempotent. |

## Why this shape

- **Rolling `@v2` over SHA pinning.** Pinning `navigaite/.github` to a SHA via Dependabot would create a PR on every pipeline patch across all 20 repos. The rolling tag already solves this without noise.
- **Pull-based, not push-based.** Each repo owns its own schedule and `trunk upgrade` run. A central cron iterating all repos would be brittle and harder to debug.
- **Staggered crons.** The bootstrap script deterministically hashes the repo name to a weekday + hour + minute window (Mon–Fri, 04:00–10:00 UTC) to spread PR creation across the week.
- **App-owned auto-merge.** PRs auto-merge via `navigaite-workflow-app` after `Check Gate` passes. No human approval needed for routine linter bumps.
- **Idempotent bootstrap.** Re-running the script is safe — it compares desired files against remote and opens a PR only when they differ.

## Running the bootstrap

```bash
# Dry run (default)
scripts/bootstrap-maintenance.sh

# Apply across the whole org
scripts/bootstrap-maintenance.sh --apply

# Just two repos
scripts/bootstrap-maintenance.sh --apply --only edilio,nvgt-github
```

Requires `gh` authenticated as an org admin (or a token generated from the workflow App with repo write) and `jq`.

## What consumers see

On merge of the bootstrap PR, the consumer repo gets:

- **Weekly Monday morning Dependabot PR** grouping all `github-actions` bumps. Review + merge manually.
- **Weekly `trunk upgrade` PR** on the repo's assigned day. Auto-merges after CI.

Neither touches `.release-please-manifest.json`, `package.json`, or anything outside `.github/`.

## Troubleshooting

- **Trunk upgrade PRs stuck unmerged.** Check that the repo has `WORKFLOW_APP_ID` + `WORKFLOW_APP_PRIVATE_KEY` inherited from the org (they should be, for all Navigaite repos). Without them the workflow falls back to `GITHUB_TOKEN` and cannot enable auto-merge.
- **Dependabot PRs for `navigaite/.github/*`.** Check the `ignore:` block in `.github/dependabot.yml`. The template excludes it explicitly.
- **PR storm from the scheduled runs.** Staggering is across 140 slots (5 days × 7 hours × 4 quarter-hours). With ~20 repos, a few collisions are normal; since each PR lands in its own repo there's no actual conflict — at most a reviewer sees two trunk-upgrade PRs open at once. Not worth fixing.
