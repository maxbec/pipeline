# CLAUDE.md — Navigaite Universal CI/CD Pipeline

> Organization-wide reusable GitHub Actions pipeline (`navigaite/.github`), currently at **v2** (version 4.0.2). <!-- x-release-please-version -->

All project-specific guidance for coding agents lives in [AGENTS.md](./AGENTS.md) at the repository root (agent-include directive: `@AGENTS.md`). That file is the single source of truth for:

- What this repo is and how its pipeline is structured
- The **setup Q&A flow** for adding the pipeline to a consumer repo
- **MANDATORY vs OPTIONAL** parts of the caller workflow and `pipeline.yaml`
- Branching profiles (A: `main` only, B: `dev` + `main`)
- CI check naming convention and org-level rulesets
- Secrets per deploy provider
- Commit / versioning / release conventions
- Key design decisions and common tasks

Before taking any action in this repo — or when asked to set up this pipeline elsewhere — read [AGENTS.md](./AGENTS.md) first.
