#!/bin/bash
# Self-test for runner-cache-prune.sh: runs it against a throwaway volume full
# of fake caches and checks what is left. Touches no runner.
#
#   ssh unraid 'bash -s' < docs/self-hosted-runner/prune-selftest.sh
#
# It creates one idle container (the runner image with `sleep` as its
# entrypoint: no token, no registration) and one volume, and removes both on
# exit. SCRIPT picks the prune script to test; the default is the deployed one.
# The exit code is the number of failed checks.
#
# Not covered: the runner's own Docker daemon (prune_docker needs one) and
# `npm cache verify`.
set -uo pipefail
NAME=prune-selftest
VOL=prune-selftest-work
SCRIPT=${SCRIPT:-/boot/config/plugins/user.scripts/scripts/runner-cache-prune/script}
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
  echo "cleanup: container left=$(docker ps -a --format '{{.Names}}' | grep -c "^$NAME$") volume left=$(docker volume ls -q | grep -c "^$VOL$")"
}
trap cleanup EXIT

docker volume create "$VOL" >/dev/null || exit 90
docker run -d --name "$NAME" --entrypoint sleep --memory 256m -v "$VOL:/_work" \
  myoung34/github-runner:ubuntu-noble infinity >/dev/null || exit 91
D=$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")
[[ -d $D ]] || exit 92

blob() { mkdir -p "$(dirname "$1")" && head -c "$2" /dev/urandom >"$1"; }
age() { find "$1" -depth -exec touch -d "$2" {} +; }

blob "$D/.npm/_cacache/big" 30M
blob "$D/.pnpm-store/v10/f" 2M
blob "$D/.cache/trunk/big" 30M
blob "$D/.cache/pip/f" 1M
for v in 18.0.0 20.0.0 22.0.0; do mkdir -p "$D/_tool/node/$v/x64/bin"; done
age "$D/_tool/node/18.0.0" '30 days ago'
age "$D/_tool/node/20.0.0" '10 days ago'
mkdir -p "$D/_tool/Python/3.11.0/x64" "$D/_tool/Python/3.12.0/x64"
age "$D/_tool/Python/3.11.0" '30 days ago'
blob "$D/.buildx-cache/old-scope/index.json" 1k
blob "$D/.buildx-cache/old-scope/blobs/b" 1M
age "$D/.buildx-cache/old-scope" '20 days ago'
blob "$D/.buildx-cache/big-scope/index.json" 1k
blob "$D/.buildx-cache/big-scope/blobs/b" 30M
blob "$D/.buildx-cache/ok-scope/index.json" 1k
blob "$D/stale-repo/stale-repo/f" 1M
age "$D/stale-repo" '40 days ago'
blob "$D/fresh-repo/fresh-repo/f" 1M
blob "$D/halfstale/halfstale/old/f" 1M
age "$D/halfstale" '40 days ago'
touch "$D/halfstale/halfstale" # the last job changed the inner directory only
blob "$D/_temp/f" 1M
blob "$D/_actions/f" 1M
age "$D/_temp" '90 days ago'
age "$D/_actions" '90 days ago'

GONE=".npm .cache/trunk _tool/node/18.0.0 .buildx-cache/old-scope .buildx-cache/big-scope stale-repo"
KEPT=".pnpm-store/v10/f .cache/pip/f _tool/node/20.0.0 _tool/node/22.0.0 _tool/Python/3.11.0 _tool/Python/3.12.0 .buildx-cache/ok-scope/index.json fresh-repo/fresh-repo/f halfstale/halfstale/old/f _temp/f _actions/f"
fail=0
check() { # check <phase> <expect: there|gone> <paths>
  local p
  for p in $3; do
    if [[ $2 == there && -e $D/$p ]] || [[ $2 == gone && ! -e $D/$p ]]; then
      echo "ok   [$1] $p $2"
    else
      echo "FAIL [$1] $p should be $2"
      fail=$((fail + 1))
    fi
  done
}
run() { # run <DRY_RUN>
  RUNNERS=$NAME DRY_RUN=$1 WAIT_IDLE_MIN=0 TOOL_KEEP=2 \
    CAP_NPM_MB=10 CAP_PNPM_MB=10 CAP_XDG_MB=10 CAP_BUILDX_MB=10 bash "$SCRIPT" 2>&1 | sed 's/^/    /'
  echo "    script rc=${PIPESTATUS[0]}"
}

echo "== dry run"
run 1
check dry there "$GONE $KEPT"
echo "== real run"
run 0
check real gone "$GONE"
check real there "$KEPT"
left=$(find "$D" -name '*.prune.*' | wc -l)
echo "trash directories left: $left"
fail=$((fail + left))
echo "failures: $fail"
exit "$fail"
