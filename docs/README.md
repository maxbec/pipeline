# Pipeline — documentation

| Guide | Description |
|-------|-------------|
| [Configuration reference](./CONFIGURATION.md) | Every key of `.github/pipeline.yaml` version 3, and what each job does with it |
| [Self-hosted runner](./SELF_HOSTED_RUNNER.md) | The hardened homelab runner behind `PIPELINE_RUNNER` |
| [Org maintenance](./ORG_MAINTENANCE.md) | Dependabot and Trunk upgrade bootstrap across an org |

The caller every repository carries is `.github/workflows/examples/caller.yaml`.
Versioning, release PRs, tags, release notes and promotion are Flaiky's
(`maxbec/flaiky`), not this repository's.
