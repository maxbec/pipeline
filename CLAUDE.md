# CLAUDE.md — maxbec/pipeline

The universal pipeline: `Guard`, `Check`, `Deploy` in `.github/workflows/universal-pipeline.yaml`,
provider actions in `.github/actions/`, the caller template in
`.github/workflows/examples/caller.yaml`. Read [AGENTS.md](./AGENTS.md) before
changing anything — it holds the structure, the conventions and the test setup.
Versioning, merging and releases are the release train's: `.github/workflows/train.yaml`
and `train/` in this repo (`train/README.md`). The universal pipeline itself never versions.

@AGENTS.md
