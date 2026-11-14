#!/usr/bin/env bash
# The central train sweep (.github/workflows/train-sweep.yaml): for every
# repository of the App installation that carries the Train caller, run the
# train's two entry points the way that repository's own schedule would.
#
# THIS SCRIPT RUNS IN A PUBLIC LOG OVER PRIVATE REPOSITORIES. It prints loop
# indexes, counts and exit codes — never a repository name, a pull request
# title or number, a branch name or an error text. Every name is registered
# with ::add-mask:: before its first use, everything a child process prints is
# discarded, and no command is traced. Do not add `set -x`, do not let a
# child's stdout or stderr through, do not put a name into a message.
#
# Environment:
#   GH_TOKEN          installation token for the whole owner (gh reads it)
#   SWEEP_SELF        owner/name of the repository running the sweep; skipped
#   SWEEP_TRAIN_BIN   directory holding release.ts and merge.ts
#   SWEEP_WORK        scratch directory for the clones (created, emptied after)
#   TRAIN_APP_SLUG    passed through to release.ts
#   SWEEP_GIT_BASE    clone URL prefix, default https://github.com (tests)
set -euo pipefail

: "${GH_TOKEN:?}" "${SWEEP_SELF:?}" "${SWEEP_TRAIN_BIN:?}" "${SWEEP_WORK:?}"
GIT_BASE="${SWEEP_GIT_BASE:-https://github.com}"
CALLER=".github/workflows/train.yaml"

# The token reaches git through the environment only: nothing on disk, nothing
# in a URL that an error message could repeat. The children inherit it, so the
# entries' own `git fetch origin` in the clone authenticates the same way.
BASIC=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')
echo "::add-mask::$BASIC"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $BASIC"
export GIT_TERMINAL_PROMPT=0
export GITHUB_TOKEN="$GH_TOKEN"

mkdir -p "$SWEEP_WORK"
trap 'rm -rf "$SWEEP_WORK"' EXIT

# Runs a command with all of its output discarded and prints its exit code.
quiet() {
  local rc=0
  "$@" > /dev/null 2>&1 || rc=$?
  echo "$rc"
}

LISTED='.repositories[] | select(.archived | not) | .full_name'
if ! LIST=$(gh api /installation/repositories --paginate --jq "$LISTED" 2> /dev/null); then
  echo "::error::The installation's repositories could not be listed."
  exit 1
fi

REPOSITORIES=()
while IFS= read -r NAME; do
  [[ -n "$NAME" ]] || continue
  echo "::add-mask::$NAME"
  echo "::add-mask::${NAME#*/}"
  REPOSITORIES+=("$NAME")
done <<< "$LIST"

TOTAL=${#REPOSITORIES[@]}
SWEPT=0
SKIPPED=0
FAILED=0
INDEX=0
echo "Sweep: $TOTAL repositories in the installation."

for NAME in "${REPOSITORIES[@]}"; do
  INDEX=$((INDEX + 1))
  if [[ "$NAME" == "$SWEEP_SELF" ]]; then
    SKIPPED=$((SKIPPED + 1))
    echo "repository $INDEX: skipped (this repository)"
    continue
  fi
  # On the default branch: that is the copy a schedule there would run.
  if [[ "$(quiet gh api "repos/$NAME/contents/$CALLER" --silent)" != "0" ]]; then
    SKIPPED=$((SKIPPED + 1))
    echo "repository $INDEX: skipped (no train caller)"
    continue
  fi
  # The repository's own kill switch. Reading it needs the App's Variables
  # permission; without it the answer is empty and the repository is swept.
  SWITCH=$(gh api "repos/$NAME/actions/variables/TRAIN" --jq '.value' 2> /dev/null || true)
  if [[ "$SWITCH" == "off" ]]; then
    SKIPPED=$((SKIPPED + 1))
    echo "repository $INDEX: skipped (train switched off)"
    continue
  fi

  CLONE="$SWEEP_WORK/$INDEX"
  rm -rf "$CLONE"
  RC_CLONE=$(quiet git clone --quiet "$GIT_BASE/$NAME.git" "$CLONE")
  if [[ "$RC_CLONE" != "0" ]]; then
    FAILED=$((FAILED + 1))
    echo "repository $INDEX: clone=$RC_CLONE"
    rm -rf "$CLONE"
    continue
  fi

  CONFIG='{}'
  if [[ -f "$CLONE/.github/pipeline.yaml" ]]; then
    # An unreadable configuration is a failure, not a release with the defaults.
    if ! CONFIG=$(yq -o=json -I=0 '.release // {}' "$CLONE/.github/pipeline.yaml" 2> /dev/null); then
      FAILED=$((FAILED + 1))
      echo "repository $INDEX: config=1"
      rm -rf "$CLONE"
      continue
    fi
  fi

  RC_RELEASE=$(GITHUB_REPOSITORY="$NAME" TRAIN_CLONE="$CLONE" TRAIN_RELEASE_CONFIG="$CONFIG" \
    quiet node "$SWEEP_TRAIN_BIN/release.ts" --quiet)
  # Merge runs whatever Release did, as in the per-repository workflow.
  RC_MERGE=$(GITHUB_REPOSITORY="$NAME" quiet node "$SWEEP_TRAIN_BIN/merge.ts" --quiet)
  rm -rf "$CLONE"

  SWEPT=$((SWEPT + 1))
  if [[ "$RC_RELEASE" != "0" || "$RC_MERGE" != "0" ]]; then FAILED=$((FAILED + 1)); fi
  echo "repository $INDEX: release=$RC_RELEASE merge=$RC_MERGE"
done

echo "Sweep done: $SWEPT swept, $SKIPPED skipped, $FAILED failed."
if [[ "$FAILED" -gt 0 ]]; then
  echo "::error::$FAILED of $TOTAL repositories failed; the codes are above."
  exit 1
fi
