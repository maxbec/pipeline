# Self-Hosted Runner (homelab)

Navigaite runs a self-hosted GitHub Actions runner on the Mainz homelab (Unraid)
so that the org's **private-repo** CI does not consume the board-set **$20/month**
GitHub Actions spending cap. This guide is the hardened, safe way to operate it.

> **Public repos never use this runner.** `navigaite/.github` and
> `navigaite/nvgt-trunk-plugin` are public; fork PRs can run arbitrary code.
> Untrusted code must not execute on the homelab. Public repos stay on
> GitHub-hosted `ubuntu-latest` (which is free for public repos anyway).

A ready-to-deploy Compose stack lives next to this file:
[`self-hosted-runner/docker-compose.yml`](./self-hosted-runner/docker-compose.yml).

## Why hardening was required

The legacy `gh-actions-runner` stack ran `myoung34/github-runner:latest` with:

| Legacy setting | Risk | Fix |
| --- | --- | --- |
| `privileged: true` + in-container Docker-in-Docker | Container escape → host root on the homelab | Drop `privileged`; disable in-container Docker; use rootless BuildKit only where image builds are needed |
| `image: ...:latest` | Unpinned — a compromised/moved tag silently changes what runs | Pin by digest (`@sha256:…`) |
| Repo-scoped, one container per repo | Doesn't scale to the fleet; each needs its own PAT | One **org-level runner group** (`homelab`) for all private repos |
| `docker` label advertised | Misleads jobs into scheduling Docker work on a daemonless runner | Fleet labels: `self-hosted, mainz-homelab, linux, x64` |

`jq` is baked into the myoung34 image and is intentionally kept — the pipeline's
Node lint/test/build steps depend on it (a missing `jq` silently no-ops those
steps to a false success; see the NAV-22 audit).

## Topology

Two ways to register, selected by Docker Compose profile in the stack file:

- **Option A — org runner group (preferred).** One runner group named `homelab`
  at the org level, access **limited to private repos**, serving every private
  navigaite repo. Requires an `ACCESS_TOKEN` (PAT) with **`admin:org`**.
  → `docker compose --profile org up -d`
- **Option B — repo-scoped (interim).** One container per opted-in private repo,
  registered with a `repo`-scope PAT. Mirrors the legacy topology, hardened.
  Use only until `admin:org` is available. → `docker compose --profile repo up -d`

### Prerequisite: `admin:org` for Option A

Creating an org runner group and reading Actions billing needs `admin:org`, which
the CTO `gh` token does **not** currently carry (`gist, read:org, repo, workflow`).
Grant it interactively:

```bash
gh auth refresh -s admin:org
```

or provision a scoped PAT (`admin:org`) in the runner's secret store as
`RUNNER_ORG_TOKEN`. This is a board/human step (interactive OAuth).

## Wiring a repo to the runner

Runners are matched by label. In a repo's `.github/pipeline.yaml`:

```yaml
runner:
  labels: [self-hosted, mainz-homelab, linux, x64]
```

This routes the `static-checks`, `verify` and `deploy-docker` jobs to the
homelab runner; it defaults to `ubuntu-latest` when omitted.

> **Gotcha — do not set self-hosted labels on a repo with no matching runner.**
> Jobs pinned to `self-hosted` labels queue **forever** if no runner is
> registered/authorized for that repo. Only add `runner.labels` after the repo
> is served by the org group (or has its own repo-scoped runner). Public repos
> keep the default (`ubuntu-latest`).

## Repos that build container images

Most of the fleet (Node/Vercel apps, npm libraries, the WP theme) build **no**
container image in CI, so the default runner runs with Docker disabled. Only a
repo whose `pipeline.yaml` sets `deployment.provider: docker` (the `deploy-docker`
job) needs to build images. Give those a **rootless BuildKit** sidecar
(`--profile docker` in the stack) and point the build at it — never re-enable
privileged dind.

## Caches on the work volume

The three org runners on unraid (`gh-runner-navigaite-homelab`,
`gh-runner-navigaite-homelab-2`, `gh-runner-edilio-homelab`) are plain
`docker run` containers, each with one named volume at `/_work`. Everything a
job caches lives on that volume, so it survives a recreate and an image update,
not only the restart an ephemeral runner does after every job:

| Cache | Where | Set by |
| --- | --- | --- |
| Node, Python (`RUNNER_TOOL_CACHE`) | `/_work/_tool` | `AGENT_TOOLSDIRECTORY` |
| npm | `/_work/.npm` | `npm_config_cache` |
| trunk, Cypress, pip, uv, pnpm metadata | `/_work/.cache` | `XDG_CACHE_HOME` |
| puppeteer | `/_work/.cache/puppeteer` | `PUPPETEER_CACHE_DIR` |
| pnpm store | `/_work/.pnpm-store` | pnpm itself: the store goes to the root of the filesystem the project is on |
| buildx layer cache | `/_work/.buildx-cache` | `deploy.docker.cache_backend: local`, the default on a self-hosted runner |
| Docker daemon of a privileged runner | volume `gh-runner-edilio-docker` at `/var/lib/docker` | a second mount |

Until 2026-11-13 the first four and the daemon's data sat in the container's
writable layer: about 12 GB per navigaite runner that nothing pruned and every
recreate threw away.

**One volume per runner, nothing shared.** The npm cache and the pnpm store
would tolerate two runners writing at once (content-addressed, files renamed
into place), as long as nothing prunes them meanwhile. The tool cache would
not — the setup actions unpack a version in place — nor would a buildx
`type=local` cache, whose `index.json` the last writer wins, and a
`/var/lib/docker` belongs to exactly one daemon. Whether trunk's cache is safe
for two containers is not documented, so it is not shared either.

**Recreating a runner** goes through
[`self-hosted-runner/recreate-runner.sh`](./self-hosted-runner/recreate-runner.sh),
on the Docker host. It reads image, registration env, token, volume and the
memory / CPU limits from the existing container (so limits set with
`docker update` survive), adds the variables above, and keeps the old
container, stopped, as `<name>-prev` until `--cleanup`; `--rollback` puts it
back. It refuses while a job runs.

```bash
ssh unraid 'bash -s -- gh-runner-navigaite-homelab' < docs/self-hosted-runner/recreate-runner.sh
```

**The caches are bounded** by
[`self-hosted-runner/runner-cache-prune.sh`](./self-hosted-runner/runner-cache-prune.sh),
deployed as the User Script `runner-cache-prune` on unraid and run weekly
(Sunday 04:30, `/boot/config/plugins/dynamix/runner-cache-prune.cron`, log in
`/var/log/runner-cache-prune.log`). Per idle runner it runs `npm cache verify`
and `pnpm store prune`, then enforces a size cap on each cache — 6 GB npm,
6 GB pnpm store, 4 GB per directory under `.cache`, 10 GB per buildx scope —
by deleting a cache that is over it; it refills on the next job. None of
these tools evicts by size on its own, so the cap is the bound. It also keeps
the four newest versions of each tool, drops a buildx scope nothing has
written for 14 days, and prunes the edilio runner's own daemon. `DRY_RUN=1`
prints and changes nothing.

Measured on 2026-11-13 with a Check of navigaite/maimaldrei-dispoplaner on an
otherwise idle runner: install 22 s and trunk lint 10 s with the caches in the
layer, 25 s and 10 s with them on the volume — the move costs nothing per job.
What it buys is that a recreate no longer starts cold (an empty tool cache
alone is a 56 s Node download on the homelab uplink) and that the disk stops
growing: the first `npm cache verify` took a four-month-old npm cache from
7.9 GB to 3.1 GB.

## Operating notes

- Runners are `EPHEMERAL` — a fresh runner process per job. The work volume and
  the caches on it are not fresh; see above.
- Recreate containers only when idle; an ephemeral runner mid-job will finish and
  deregister on its own.
- Keep the digest current deliberately (Dependabot/renovate on this file or a
  scheduled bump), not via `:latest`.
- A CPU limit (`cpus:` in compose) is a quota, not a set of cores. Inside the
  container `nproc` and Node's `os.availableParallelism()` still report every
  core of the host, so test runners and bundlers start one worker per host
  core. On navigaite/crewsy (14 October 2026) Vitest and Metro started 21
  workers on a 5-core quota: the runner hit its memory limit 1.2 million times,
  sat 11 hours in CPU throttling, and 29 % of its Checks failed on E2E
  timeouts. Hand the real count to the tools — the quota is in
  `/sys/fs/cgroup/cpu.max` (crewsy: `scripts/ci/kerne.sh`) — or pin cores with
  `cpuset`, which `nproc` does honour.
- A runner whose work volume keeps the package store between jobs (crewsy's
  keep 2.2 GB of pnpm store under `/_work`) gains nothing from the cache
  restore, and saving it is slow on a homelab uplink (dispoplaner, 2026-11-12:
  20 minutes to upload 0.7 GB of trunk cache and 3.4 GB of npm cache after
  three minutes of work). So `runtime.dependency_cache` defaults to `false`
  when the runner labels contain `self-hosted`, and trunk's cache follows it.
  Set it to `true` only for a runner that gets a fresh volume for every job.
