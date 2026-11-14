#!/bin/bash
# recreate-runner.sh — recreate one homelab runner container so that its tool
# caches live on the persistent work volume instead of in the container's
# writable layer. Run as root on the Docker host (unraid).
#
#   recreate-runner.sh <container>             recreate; the old container is kept,
#                                              stopped, as <container>-prev
#   recreate-runner.sh <container> --rollback  remove the new one, put -prev back
#   recreate-runner.sh <container> --cleanup   delete -prev (frees its layer for good)
#
# The runners are plain `docker run` containers, so what a runner *is* exists
# nowhere but in the container itself. This script therefore reads it from the
# running container — image, registration env (token included, never printed),
# work volume, memory / CPU limits (also those set later with `docker update`),
# privileged — and adds only this:
#
#   AGENT_TOOLSDIRECTORY=/_work/_tool      setup-node / setup-python (RUNNER_TOOL_CACHE)
#   npm_config_cache=/_work/.npm           npm
#   XDG_CACHE_HOME=/_work/.cache           trunk, Cypress, pip, uv, pnpm metadata
#   PUPPETEER_CACHE_DIR=/_work/.cache/puppeteer   puppeteer ignores XDG_CACHE_HOME
#   <volume>-docker:/var/lib/docker        privileged runners only: the data of
#                                          the in-container Docker daemon
#
# Each runner has its own work volume, so no cache is shared between runners.
# It never mounts /var/run/docker.sock and never touches EPHEMERAL.
set -euo pipefail

NAME=${1:?usage: recreate-runner.sh <container> [--rollback|--cleanup]}
MODE=${2:-recreate}
PREV="$NAME-prev"

die() { echo "error: $*" >&2; exit 1; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
# Runner.Worker exists only while a job runs; the idle runner is Runner.Listener alone.
busy() { docker top "$1" 2>/dev/null | grep -q 'Runner\.Worker'; }
get() { docker inspect "$NAME" --format "$1"; }

case "$MODE" in
  --rollback)
    exists "$PREV" || die "$PREV does not exist, nothing to roll back to"
    if exists "$NAME"; then
      busy "$NAME" && die "$NAME is running a job; retry when it is idle"
      docker rm -f "$NAME" >/dev/null
    fi
    docker rename "$PREV" "$NAME"
    docker start "$NAME" >/dev/null
    echo "rolled back: $NAME is the previous container again"
    exit 0
    ;;
  --cleanup)
    exists "$PREV" || die "$PREV does not exist"
    docker rm "$PREV" >/dev/null
    echo "removed $PREV"
    exit 0
    ;;
  recreate) ;;
  *) die "unknown option $MODE" ;;
esac

exists "$NAME" || die "no container named $NAME"
exists "$PREV" && die "$PREV still exists; run --cleanup or --rollback first"
busy "$NAME" && die "$NAME is running a job; retry when it is idle"

IMAGE=$(get '{{.Config.Image}}')
VOLUME=$(get '{{range .Mounts}}{{if eq .Destination "/_work"}}{{.Name}}{{end}}{{end}}')
DATA=$(get '{{range .Mounts}}{{if eq .Destination "/_work"}}{{.Source}}{{end}}{{end}}')
[[ -n $VOLUME && -d $DATA ]] || die "$NAME has no named volume at /_work"
MEMORY=$(get '{{.HostConfig.Memory}}')
NANO_CPUS=$(get '{{.HostConfig.NanoCpus}}')
CPUSET=$(get '{{.HostConfig.CpusetCpus}}')
CPU_SHARES=$(get '{{.HostConfig.CpuShares}}')
PRIVILEGED=$(get '{{.HostConfig.Privileged}}')

# The env the container was started with, minus what the image brings itself
# (PATH, LANG, AGENT_TOOLSDIRECTORY, …) and minus the variables set below.
umask 077
ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
get '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -v -x -F -f <(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}') \
  | grep -v -E '^(AGENT_TOOLSDIRECTORY|npm_config_cache|XDG_CACHE_HOME|PUPPETEER_CACHE_DIR)=' \
  | grep . > "$ENV_FILE"
grep -q '^ACCESS_TOKEN=' "$ENV_FILE" || die "no ACCESS_TOKEN in the env of $NAME"
grep -q '^EPHEMERAL=true$' "$ENV_FILE" || die "$NAME is not EPHEMERAL=true; not touching it"

ARGS=(
  --name "$NAME" --restart unless-stopped
  --env-file "$ENV_FILE"
  -e AGENT_TOOLSDIRECTORY=/_work/_tool
  -e npm_config_cache=/_work/.npm
  -e XDG_CACHE_HOME=/_work/.cache
  -e PUPPETEER_CACHE_DIR=/_work/.cache/puppeteer
  -v "$VOLUME:/_work"
  --log-opt max-size=50m --log-opt max-file=2
)
((MEMORY > 0)) && ARGS+=(--memory "$MEMORY" --memory-swap -1)
((NANO_CPUS > 0)) && ARGS+=(--cpus "$(awk "BEGIN { print $NANO_CPUS / 1e9 }")")
[[ -n $CPUSET ]] && ARGS+=(--cpuset-cpus "$CPUSET")
((CPU_SHARES > 0)) && ARGS+=(--cpu-shares "$CPU_SHARES")
if [[ $PRIVILEGED == true ]]; then
  # A privileged runner runs its own Docker daemon (START_DOCKER_SERVICE=true),
  # which wants /run as tmpfs. Its data gets a volume of its own rather than a
  # directory under /_work, where every job and the prune script would walk it.
  ARGS+=(--privileged --tmpfs /run -v "${VOLUME%-work}-docker:/var/lib/docker")
fi

echo "stopping $NAME (an idle ephemeral runner deregisters itself)"
docker stop -t 30 "$NAME" >/dev/null
docker rename "$NAME" "$PREV"

# Seed the volume from the old layer so the first job is not a cold start.
# The tool cache is left to refill: setup-python's builds carry their install
# prefix, and a Node download takes seconds.
seed() { # seed <path in the old container> <path on the volume>; fails when nothing was copied
  [[ ! -e $DATA/$2 ]] || return 1
  docker cp -a "$PREV:$1" "$DATA/$2" 2>/dev/null || return 1
  echo "seeded /_work/$2 from $1"
}
seed /root/.npm .npm || true
if seed /root/.cache .cache; then
  # trunk's cache cannot move: its Python linters (checkov, yamllint, semgrep)
  # are venvs whose scripts start with `#!<old cache path>/…/bin/python`. A
  # copied one fails every lint that needs them with "execve failed: No such
  # file or directory" — four red Checks on 2026-11-13. It rebuilds itself in
  # about 80 s on the first lint.
  rm -rf "$DATA/.cache/trunk"
  echo "dropped the copied trunk cache (not relocatable); the first lint rebuilds it"
fi

if ! docker run -d "${ARGS[@]}" "$IMAGE" >/dev/null; then
  echo "docker run failed; put the old container back with: $0 $NAME --rollback" >&2
  exit 1
fi
echo "recreated $NAME from $IMAGE; previous container kept as $PREV"
echo "when a Check has passed on it: $0 $NAME --cleanup"
