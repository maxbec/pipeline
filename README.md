# Pipeline

The one reusable GitHub Actions workflow every repository in the `navigaite`,
`edilio-app` and `maxbec` accounts calls. Three jobs, one config file, pinned by
commit.

| job | when | what |
|---|---|---|
| **Guard** | every run | reads `.github/pipeline.yaml`; on a pull request enforces the branch rules and a conventional title |
| **Check** | pull requests and pushes to `dev` / `main` | secret scan, dependency review, lint, test, build in one job on the configured runner. `pipeline / Check` is the single required status check |
| **Deploy** | a **published release** only | prerelease → `preview`, stable → `production`; Vercel, Cloudflare Workers, Docker to GHCR (plus an optional Render hook), npm |

Nothing here versions, tags or writes release notes: [Flaiky](https://github.com/maxbec/flaiky)
keeps the Release PR, merges it on approval, tags, publishes the GitHub release
and thereby triggers Deploy (ADR 0003 / 0004 there).

## Adopting it

Two files, both written by `provisioning/migrate-repos.ts` in `maxbec/flaiky`:

1. `.github/workflows/ci.yaml` — a copy of [`examples/caller.yaml`](.github/workflows/examples/caller.yaml)
   with the SHA and version filled in. The job id `pipeline` is what makes the
   check-run `pipeline / Check`.
2. `.github/pipeline.yaml` — version 3, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Callers pin `universal-pipeline.yaml@<40-char sha>`, with the tag as a `# vX.Y.Z`
comment on the line above (an inline comment pushes the line past yamllint's
120 characters once the tag has a prerelease suffix). Inside the called
workflow `github.workflow_sha` is that same commit, so Deploy checks this
repository out at it and runs the provider actions from `.github/actions/` —
no moving major tags anywhere.

Two things that cost days to learn: `secrets: inherit` drops org secrets across
the owner boundary, so the caller forwards each secret by name; and a repository
that restricts Actions must allow `maxbec/pipeline/*` or the run dies with a
silent `startup_failure`.

## Developing it

```sh
npm test                    # pulls each run: block out of the YAML by step id and executes it
actionlint                  # workflow syntax and expressions
```

Feature branches off `dev`, squash into `dev`, `dev` → `main` by promotion.
This repository runs the pipeline from its own tree (`ci.yaml` uses
`./.github/workflows/universal-pipeline.yaml`), so a pull request here is checked
by the workflow it changes. Conventional PR titles are mandatory: Guard rejects
anything else, and Flaiky derives the next version from them.
