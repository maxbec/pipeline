#!/bin/bash
# runner-cache-prune — weekly bound on the caches the homelab runners keep on
# their work volumes. Run as root on the Docker host (unraid).
#
# Deployed copy: /boot/config/plugins/user.scripts/scripts/runner-cache-prune/script
# Scheduled via: /boot/config/plugins/dynamix/runner-cache-prune.cron
#   30 4 * * 0 bash /boot/config/plugins/user.scripts/scripts/runner-cache-prune/script >> /var/log/runner-cache-prune.log 2>&1
#
# Per runner, and only while it runs no job:
#   1. tool-native garbage collection (npm cache verify, pnpm store prune),
#      where the tools are there — it drops what nothing references any more;
#   2. a size cap on every cache: one that is still over its cap is deleted
#      whole and refills on the next job. That is what bounds the volume —
#      none of these caches can evict by age or size on its own;
#   3. the tool cache keeps the newest TOOL_KEEP versions of each tool;
#   4. buildx local caches: a scope nothing has written for
#      BUILDX_MAX_AGE_DAYS goes, and so does one over its cap (`type=local`
#      with `mode=max` never deletes a blob);
#   5. on a runner with its own Docker daemon: stopped containers, dangling
#      images, unused volumes and the build cache; every unused image once
#      /var/lib/docker is over its cap.
#
# DRY_RUN=1 prints what it would do and changes nothing.
set -uo pipefail

RUNNERS=${RUNNERS:-"gh-runner-navigaite-homelab gh-runner-navigaite-homelab-2 gh-runner-edilio-homelab"}
DRY_RUN=${DRY_RUN:-0}
WAIT_IDLE_MIN=${WAIT_IDLE_MIN:-30}
CAP_NPM_MB=${CAP_NPM_MB:-6000}        # /_work/.npm
CAP_PNPM_MB=${CAP_PNPM_MB:-6000}      # /_work/.pnpm-store
CAP_XDG_MB=${CAP_XDG_MB:-4000}        # each directory under /_work/.cache (trunk, Cypress, pip, …)
CAP_BUILDX_MB=${CAP_BUILDX_MB:-10000} # each scope under /_work/.buildx-cache
CAP_DOCKER_MB=${CAP_DOCKER_MB:-15000} # /var/lib/docker of an in-container daemon
TOOL_KEEP=${TOOL_KEEP:-4}
BUILDX_MAX_AGE_DAYS=${BUILDX_MAX_AGE_DAYS:-14}
BUILD_CACHE_MAX=${BUILD_CACHE_MAX:-5GB}

log() { echo "$(date '+%F %T') $*"; }
size_mb() { du -sxm "$1" 2>/dev/null | cut -f1; }
# Runner.Worker exists only while a job runs; the idle runner is Runner.Listener alone.
busy() { docker top "$1" 2>/dev/null | grep -q 'Runner\.Worker'; }
mount_source() { docker inspect "$1" --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" 2>/dev/null; }

# Rename, then delete: a job that starts meanwhile finds a cold cache, never half of one.
wipe() { # wipe <dir> <reason>
  log "  delete $1 ($2)"
  [[ $DRY_RUN == 1 ]] && return 0
  local trash="$1.prune.$$"
  mv "$1" "$trash" && rm -rf "$trash"
}

cap() { # cap <dir> <limit in MB>
  [[ -d $1 ]] || return 0
  local mb
  mb=$(size_mb "$1")
  log "  $1: ${mb:-?} MB, cap $2 MB"
  [[ -n $mb ]] && ((mb > $2)) && wipe "$1" "over its cap"
  return 0
}

native_gc() { # native_gc <container>
  [[ $DRY_RUN == 1 ]] && { log "  would run npm cache verify and pnpm store prune"; return 0; }
  docker exec "$1" sh -c '
    node_bin=$(ls -d /_work/_tool/node/*/x64/bin 2>/dev/null | sort -V | tail -1)
    [ -n "$node_bin" ] || { echo "  no Node in the tool cache yet, skipping npm and pnpm"; exit 0; }
    PATH="$node_bin:/root/setup-pnpm/node_modules/.bin:$PATH"
    export PATH
    [ -d "$npm_config_cache" ] && npm cache verify 2>&1 | sed "s/^/  npm: /"
    if command -v pnpm >/dev/null 2>&1 && [ -d /_work/.pnpm-store ]; then
      cd /_work && pnpm store prune 2>&1 | tail -n 2 | sed "s/^/  pnpm: /"
    else
      echo "  no pnpm in the runner (none until a pnpm job has run in this container), store left to its cap"
    fi' || log "  tool-native collection failed; the caps below still apply"
}

prune_tools() { # prune_tools <tool cache>
  local tool old
  for tool in "$1"/*/; do
    [[ -d $tool ]] || continue
    # shellcheck disable=SC2012 # version directories carry no odd characters
    ls -1dt "$tool"*/ 2>/dev/null | tail -n +$((TOOL_KEEP + 1)) | while read -r old; do
      wipe "${old%/}" "older than the $TOOL_KEEP newest of $(basename "$tool")"
    done
  done
}

prune_buildx() { # prune_buildx <buildx cache root>
  local index scope
  [[ -d $1 ]] || return 0
  # A scope is a directory with an index.json: the root itself when the build
  # sets no cache scope, one subdirectory per scope otherwise.
  find "$1" -maxdepth 2 -name index.json 2>/dev/null | while read -r index; do
    scope=$(dirname "$index")
    if [[ -z $(find "$index" -mtime "-$BUILDX_MAX_AGE_DAYS") ]]; then
      wipe "$scope" "not written for $BUILDX_MAX_AGE_DAYS days"
    else
      cap "$scope" "$CAP_BUILDX_MB"
    fi
  done
}

prune_docker() { # prune_docker <container>: the runner's own daemon, if it runs one
  local root mb all=""
  docker exec "$1" docker info >/dev/null 2>&1 || return 0
  root=$(mount_source "$1" /var/lib/docker)
  if [[ -n $root ]]; then
    mb=$(size_mb "$root")
    log "  /var/lib/docker: ${mb:-?} MB, cap $CAP_DOCKER_MB MB"
    [[ -n $mb ]] && ((mb > CAP_DOCKER_MB)) && all="-a"
  fi
  [[ $DRY_RUN == 1 ]] && { log "  would prune containers, images ${all:-(dangling)}, volumes, build cache"; return 0; }
  docker exec "$1" docker container prune -f --filter until=24h | tail -n 1
  # shellcheck disable=SC2086 # $all is "-a" or nothing
  docker exec "$1" docker image prune -f $all | tail -n 1
  docker exec "$1" docker volume prune -af | tail -n 1
  docker exec "$1" docker builder prune -af --max-used-space "$BUILD_CACHE_MAX" | tail -n 1
}

for runner in $RUNNERS; do
  data=$(mount_source "$runner" /_work)
  if [[ -z $data || ! -d $data ]]; then
    log "$runner: no work volume found, skipped"
    continue
  fi
  waited=0
  while busy "$runner" && ((waited < WAIT_IDLE_MIN)); do
    sleep 60
    waited=$((waited + 1))
  done
  if busy "$runner"; then
    log "$runner: still running a job after $WAIT_IDLE_MIN minutes, skipped this week"
    continue
  fi
  log "$runner: $(size_mb "$data") MB on $data"
  native_gc "$runner"
  cap "$data/.npm" "$CAP_NPM_MB"
  cap "$data/.pnpm-store" "$CAP_PNPM_MB"
  for dir in "$data"/.cache/*/; do
    cap "${dir%/}" "$CAP_XDG_MB"
  done
  prune_tools "$data/_tool"
  prune_buildx "$data/.buildx-cache"
  prune_docker "$runner"
  log "$runner: $(size_mb "$data") MB after"
done
