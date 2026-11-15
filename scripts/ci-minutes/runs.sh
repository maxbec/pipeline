#!/usr/bin/env bash
# Every job of every workflow run of a repository in a window of days, one
# line per job and run attempt, tab-separated with a header line. agg.py and
# perpr.py read the file.
#
# usage: runs.sh <owner/repo> <since YYYY-MM-DD> [<until YYYY-MM-DD>] > jobs.tsv
#
# Needs gh, logged in with read access to the repository's Actions. One request
# per hundred runs and one per run, so a busy month is a few thousand of the
# 5,000 requests an hour. Progress and warnings go to standard error.
#
# Columns:
#   run_id  workflow  event  branch  run_conclusion  pr  run_created
#   job  conclusion  seconds  labels  runner_group  attempt
#
#   pr            the first pull request the run belongs to, `-` for none
#   seconds       the job's completed_at minus its started_at; 0 or less for a
#                 job no runner took (skipped, or cancelled while queued)
#   labels        the job's `runs-on` labels, comma-separated
#   runner_group  `GitHub Actions` for a GitHub-hosted runner, the group's name
#                 for a self-hosted one, empty when no runner took the job
#   attempt       the run attempt the job belongs to: a rerun bills again
#
# The file keeps skipped and zero-second jobs; the reading scripts drop them.
#
# The runs API answers a query with at most 1,000 runs. At that count the
# script stops: pass <until> and read the window in pieces.
set -euo pipefail

die() {
  echo "runs.sh: $*" >&2
  exit 1
}
usage() {
  echo "usage: runs.sh <owner/repo> <since YYYY-MM-DD> [<until YYYY-MM-DD>] > jobs.tsv" >&2
  exit 2
}

[[ $# -ge 2 && $# -le 3 ]] || usage
repo=$1
since=$2
until=${3:-}
day='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
[[ $repo =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || usage
[[ $since =~ $day ]] || usage
[[ -z $until || $until =~ $day ]] || usage
command -v gh >/dev/null || die "gh is not installed"

if [[ -n $until ]]; then created="$since..$until"; else created=">=$since"; fi

# Run-level fields the jobs API does not repeat. No field is ever empty: `read`
# folds neighbouring tabs into one.
RUNS_JQ='.workflow_runs[]
  | [.id, .event, (.conclusion // "-"), (.pull_requests[0].number // "-"), .created_at]
  | @tsv'
# Everything else comes from the job itself, through @tsv, so a branch or a
# job name never passes through the shell.
JOBS_JQ='.jobs[]
  | select(.started_at != null and .completed_at != null)
  | [.run_id, .workflow_name, (.head_branch // "-"), .name, (.conclusion // "-"),
     ((.completed_at | fromdate) - (.started_at | fromdate)),
     (.labels | join(",")), (.runner_group_name // ""), .run_attempt]
  | @tsv'

runs=$(mktemp)
trap 'rm -f "$runs"' EXIT

gh api --paginate -X GET "repos/$repo/actions/runs" -f "created=$created" -F per_page=100 --jq "$RUNS_JQ" > "$runs" ||
  die "could not list the runs of $repo"
count=$(wc -l < "$runs")
echo "$count runs of $repo, created $created" >&2
[[ $count -lt 1000 ]] || die "the API lists at most 1,000 runs per query; pass <until> and read the window in pieces"

printf 'run_id\tworkflow\tevent\tbranch\trun_conclusion\tpr\trun_created\tjob\tconclusion\tseconds\tlabels\trunner_group\tattempt\n'
unread=0
while IFS=$'\t' read -r id event conclusion pr created_at; do
  if ! gh api --paginate -X GET "repos/$repo/actions/runs/$id/jobs" -f filter=all -F per_page=100 --jq "$JOBS_JQ" |
    RUN_EVENT=$event RUN_CONCLUSION=$conclusion RUN_PR=$pr RUN_CREATED=$created_at awk '
      BEGIN { FS = OFS = "\t" }
      { print $1, $2, ENVIRON["RUN_EVENT"], $3, ENVIRON["RUN_CONCLUSION"], ENVIRON["RUN_PR"], ENVIRON["RUN_CREATED"],
              $4, $5, $6, $7, $8, $9 }'; then
    echo "runs.sh: the jobs of run $id could not be read" >&2
    unread=$((unread + 1))
  fi
done < "$runs"

[[ $unread -eq 0 ]] || die "$unread of $count runs are missing from the output"
