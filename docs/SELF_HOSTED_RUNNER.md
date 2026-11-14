# Self-Hosted Runner (homelab)

The private repositories of `navigaite` and `edilio-app` run Check and Deploy on
runners on the Mainz homelab (unraid) instead of GitHub-hosted minutes. This
page describes the runners as they are, how a repository reaches them, and how
their caches are kept and bounded.

> **Public repos never use these runners.** A fork PR can run arbitrary code,
> and untrusted code must not execute on the homelab. Public repos stay on
> GitHub-hosted `ubuntu-latest`, which is free for them anyway. Never register
> a self-hosted runner for a public repository.

## What runs today

Read from `docker inspect` on unraid on 2026-11-14. The three org runners are
plain `docker run` containers — no compose file, no Portainer stack — from
`myoung34/github-runner:ubuntu-noble`, as root, with `EPHEMERAL=true`
(one job per runner process; the container restarts itself afterwards) and
`DISABLE_AUTO_UPDATE=true`:

| Container | Runner | Registered at | Labels | Docker inside | Memory / CPUs |
| --- | --- | --- | --- | --- | --- |
| `gh-runner-navigaite-homelab` | `mainz-homelab-navigaite` | org `navigaite`, group `homelab` | `self-hosted, mainz-homelab, linux, x64` | none | 3 GiB / 2, pinned to 16–17 |
| `gh-runner-navigaite-homelab-2` | `mainz-homelab-navigaite-2` | same | same | none | 3 GiB / 2, pinned to 16–17 |
| `gh-runner-edilio-homelab` | `mainz-homelab-edilio` | org `edilio-app`, group `Default` | the same plus `docker` | its own daemon (`privileged`, `START_DOCKER_SERVICE=true`) | 6 GiB / 4, pinned to 12–15 |

The limits are part of each container (`--memory`, `--cpus`, `--cpuset-cpus`).
Inside, `nproc` reports the pinned cores, because `cpuset` is honoured where a
bare `--cpus` quota is not (see the operating notes).

The edilio runner is privileged because its tests start service containers and
its Deploy builds images; both need a Docker daemon, and it runs its own inside
the container. **No runner mounts `/var/run/docker.sock`, and none should:**
with the host's socket the service containers would bind on the production
host and fight it for ports. Never put a runner on a production host either —
a privileged in-container daemon is root there.

`jq` comes with the image and must stay: the pipeline's steps depend on it.

Repo-scoped runners live beside these three and are not described here:
`crewsy-runner` and `crewsy-runner-2` (compose file
`/mnt/user/appdata/crewsy-runner/docker-compose.yml`, see crewsy's
`docs/ci-runner.md`), and one each for `maxbec/platzl-finder` and
`navigaite/maimaldrei-mietkatalog` (a Portainer stack). unraid has no memory
left for another one.

### The hardened shape that was never deployed

[`self-hosted-runner/docker-compose.yml`](./self-hosted-runner/docker-compose.yml)
is a design from July 2026: image pinned by digest, `no-new-privileges`, no
in-container Docker, a rootless BuildKit sidecar for image builds, one compose
stack. It was not rolled out, and the live runners differ from it in three
ways: the image is a moving tag, not a digest; they are `docker run`
containers; and the edilio runner is privileged. Treat the file as a target to
move towards, not as a description — and do not `docker compose up` it next to
the live containers: it would register a second runner under the same name.

## Wiring a repo to the runner

Runners are matched by label. Check and Deploy run on `runner.labels` from the
repository's `.github/pipeline.yaml`:

```yaml
runner:
  labels: [self-hosted, mainz-homelab]
```

Without that key they run on the variable `PIPELINE_RUNNER` (a JSON array,
`["self-hosted","mainz-homelab"]` in both homelab orgs; on a Free org it has to
be set per repository), and on `ubuntu-latest` when neither is set. Guard
always runs on `ubuntu-latest`.

> **Gotcha — do not set self-hosted labels on a repo with no matching runner.**
> Jobs pinned to `self-hosted` labels queue **forever** if no runner is
> registered or authorized for that repo. Public repos keep the default.

## Repos that build container images

Only a repository with `deploy.provider: docker-ghcr` builds an image, in
Deploy. That needs a Docker daemon on the runner: the edilio runner has one,
the two navigaite runners have none. A navigaite repository that builds images
runs Deploy on a GitHub-hosted runner or on a repo-scoped runner of its own
with a daemon inside.

On a self-hosted runner the buildx layer cache defaults to
`deploy.docker.cache_backend: local`, a directory on the work volume, instead
of uploading every layer to GitHub.

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
back. It refuses while a job runs. It copies `~/.npm` and `~/.cache` from the
old layer onto the volume when they are not there yet — except trunk's cache,
which cannot be moved: its Python linters are venvs whose scripts name the old
path in their shebang, and a copied cache fails every lint that needs checkov,
yamllint or semgrep with `execve failed: No such file or directory` (seen in
`<workspace>/.trunk/out/*.yaml`; four red Checks on 2026-11-13). If trunk ever
reports "tools failed to run" on a runner, delete `/_work/.cache/trunk` while
the runner is idle; the next lint rebuilds it in about 80 s.

```bash
ssh unraid 'bash -s -- gh-runner-navigaite-homelab' < docs/self-hosted-runner/recreate-runner.sh
```

**The caches are bounded** by
[`self-hosted-runner/runner-cache-prune.sh`](./self-hosted-runner/runner-cache-prune.sh),
deployed as the User Script `runner-cache-prune` on unraid and run weekly
(Sunday 04:30, `/boot/config/plugins/dynamix/runner-cache-prune.cron`, log in
`/var/log/runner-cache-prune.log`). Per idle runner it runs `npm cache verify`,
then enforces a size cap on each cache — 6 GB npm,
6 GB pnpm store, 4 GB per directory under `.cache`, 10 GB per buildx scope —
by deleting a cache that is over it; it refills on the next job. None of
these tools evicts by size on its own, so the cap is the bound. It also keeps
the four newest versions of each tool, drops a buildx scope nothing has
written for 14 days, removes the workspace of a repository no job has
touched for 30 days, and prunes the edilio runner's own daemon. `DRY_RUN=1`
prints and changes nothing.

Do not add `pnpm store prune` to it. pnpm keeps a package only while some
`node_modules` hard-links to it, and on these btrfs volumes it clones
(reflinks) packages instead, so every file has a link count of one and the
whole store counts as unused: tried on the edilio runner on 2026-11-14, it
removed all 3,389 packages.

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
