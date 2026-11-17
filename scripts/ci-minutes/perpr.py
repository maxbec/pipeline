#!/usr/bin/env python3
"""How often a pull request pays for the Check, and what the red ones cost.

usage: perpr.py <jobs.tsv> [<since>] [--job NAME] [--full-seconds N]

<jobs.tsv> is the file runs.sh writes. <since> keeps the runs created at or
after that UTC time, compared as text: 2026-11-14, 2026-11-14T12.

  --job NAME          the job to look at (default: `pipeline / Check`)
  --full-seconds N    a job longer than this ran the checks; a shorter one
                      reused an earlier result (default: 120)

Minutes are each job rounded up to a whole minute, as GitHub bills them.
Skipped and zero-second jobs are left out. GitHub-hosted and self-hosted
runners are reported one after the other. Release and promotion heads
(`release/*`, `promote/*`) are not counted as pull request branches: the train
builds them.
"""

from __future__ import annotations

import argparse
import collections
import statistics
import sys

from jobs import KINDS, load, minutes

TRAIN_HEADS = ("release/", "promote/")


def total(jobs: list[dict]) -> int:
    return sum(minutes(job["seconds"]) for job in jobs)


def counted(values) -> str:
    return ", ".join(f"{key}: {count}" for key, count in sorted(collections.Counter(values).items()))


def report(title: str, jobs: list[dict], full_seconds: int) -> None:
    pulls = [job for job in jobs if job["event"] == "pull_request"]
    pushes = [job for job in jobs if job["event"] == "push"]
    print(f"\n# {title}: {len(jobs)} jobs, {total(jobs)} minutes")

    by_branch: dict = collections.defaultdict(list)
    for job in pulls:
        if not job["branch"].startswith(TRAIN_HEADS):
            by_branch[job["branch"]].append(job)
    per_branch = [len(branch_jobs) for branch_jobs in by_branch.values()]
    if per_branch:
        print(
            f"pull request branches {len(per_branch)}, jobs {sum(per_branch)}; per branch: "
            f"median {statistics.median(per_branch)}, mean {statistics.mean(per_branch):.1f}, max {max(per_branch)}"
        )
        print(f"jobs per branch -> branches: {counted(per_branch)}")

    full = [job for job in pulls if job["seconds"] > full_seconds]
    print(f"pull request jobs over {full_seconds}s: {len(full)}, {total(full)} minutes; shorter (reused): {len(pulls) - len(full)}")
    print(f"pull request jobs by conclusion: {counted(job['conclusion'] for job in pulls) or 'none'}")
    red = [job for job in pulls if job["conclusion"] in ("failure", "cancelled")]
    print(f"failed or cancelled on a pull request: {len(red)} jobs, {total(red)} minutes")
    reruns = [job for job in pulls if job["attempt"] != "1"]
    print(f"reruns on a pull request (attempt 2 and later): {len(reruns)} jobs, {total(reruns)} minutes")

    full_pushes = [job for job in pushes if job["seconds"] > full_seconds]
    print(f"push jobs {len(pushes)}: over {full_seconds}s {len(full_pushes)}, {total(full_pushes)} minutes; shorter (reused): {len(pushes) - len(full_pushes)}")

    by_type: dict = collections.defaultdict(int)
    for job in pulls:
        by_type[job["branch"].split("/")[0]] += minutes(job["seconds"])
    print("pull request minutes by branch type: " + (", ".join(f"{name}: {value}" for name, value in sorted(by_type.items(), key=lambda item: -item[1])) or "none"))

    by_hour: dict = collections.defaultdict(int)
    for job in jobs:
        by_hour[job["run_created"][:13]] += minutes(job["seconds"])
    print("minutes by hour (UTC): " + " ".join(f"{hour}h:{value}" for hour, value in sorted(by_hour.items())))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="perpr.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file")
    parser.add_argument("since", nargs="?")
    parser.add_argument("--job", default="pipeline / Check")
    parser.add_argument("--full-seconds", type=int, default=120)
    args = parser.parse_args(argv[1:])

    jobs = [job for job in load(args.file, since=args.since) if job["job"] == args.job]
    print(f"{len(jobs)} `{args.job}` jobs ran" + (f" in runs created since {args.since}" if args.since else ""))
    for name in KINDS:
        mine = [job for job in jobs if job["kind"] == name]
        if mine:
            report(name, mine, args.full_seconds)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
