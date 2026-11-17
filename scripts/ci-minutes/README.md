# ci-minutes

Where a repository's GitHub Actions minutes go. Three small scripts, bash and
the Python standard library, no install. They need `gh`, logged in.

```sh
scripts/ci-minutes/runs.sh acme/widgets 2026-11-01 > widgets.tsv   # every job since that day
scripts/ci-minutes/agg.py widgets.tsv                              # minutes by workflow, job, event, branch
scripts/ci-minutes/agg.py widgets.tsv 2026-11-15                   # one day only
scripts/ci-minutes/perpr.py widgets.tsv 2026-11-14                 # Checks per pull request, red and rerun minutes
```

`runs.sh` writes one line per job and run attempt; its header comment names the
columns. The runs API lists at most 1,000 runs per query, so for a busy
repository pass a third argument, the last day, and read the month in pieces.

Both readers count a job the way GitHub bills it, rounded up to a whole minute
on its own, and leave out skipped jobs and jobs of zero seconds: no runner took
those. GitHub-hosted and self-hosted jobs are reported one after the other.
Only the hosted ones are billed, and among those the runner label decides the
price, so `agg.py` lists the minutes per label first.

## What the account was billed

The scripts estimate from job times. The figure GitHub charges against the
included minutes comes from the billing usage API:

```sh
gh api "/organizations/<org>/settings/billing/usage?year=2026&month=11" \
  --jq '[.usageItems[] | select(.product == "actions" and .unitType == "Minutes")]
        | group_by(.repositoryName)
        | map({repository: .[0].repositoryName, minutes: (map(.quantity) | add)})
        | sort_by(-.minutes)'
```

- Pass `year` and `month`, and `day` for a single day. Without them the answer
  reaches back over several months.
- Each item is one repository's usage of one `sku` on one day: `Actions Linux`
  for the two-core Linux runner, other names for other runners, and
  `Actions storage` for artifacts and caches, whose `unitType` is
  `GigabyteHours`. Hence the filter on `Minutes`.
- `quantity` is the minutes and `pricePerUnit` the price of one. `grossAmount`
  is their product, `discountAmount` what GitHub took off for the plan's
  included usage, `netAmount` what is left to pay. The sum of `quantity` is
  what to hold against the included minutes.
- An organization needs the token of one of its owners. For a user account the
  path is `/users/<login>/settings/billing/usage` and the token needs the
  `user` scope (`gh auth refresh -s user`).

The scripts' figure is an estimate. Where the two differ, the API is what is
billed.
