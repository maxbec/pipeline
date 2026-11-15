#!/usr/bin/env python3
"""Where a repository's Actions minutes went.

usage: agg.py <jobs.tsv> [<created>]

<jobs.tsv> is the file runs.sh writes. <created> keeps the runs created on that
day or in that hour, as a prefix of the UTC timestamp: 2026-11, 2026-11-15,
2026-11-15T14.

Minutes are counted the way GitHub bills them: every job on its own, rounded up
to a whole minute. Skipped and zero-second jobs are left out. GitHub-hosted and
self-hosted runners are reported one after the other, because only the first
are billed; within the hosted ones the runner label matters too, since a
minute on `ubuntu-slim` costs less than one on `ubuntu-latest`.
"""

from __future__ import annotations

import collections
import re
import sys

from jobs import KINDS, load, minutes


def branch_class(branch: str) -> str:
    """`dev`, `main`, or the branch's prefix: `feat/*`, `release/*`."""
    if branch in ("dev", "main") or "/" not in branch:
        return branch
    return re.sub(r"/.*", "/*", branch)


def table(jobs: list[dict], title: str, key, limit: int = 25) -> None:
    groups: dict = collections.defaultdict(lambda: [0, 0, 0])
    for job in jobs:
        group = groups[key(job)]
        group[0] += 1
        group[1] += minutes(job["seconds"])
        group[2] += job["seconds"]
    print(f"\n## {title}")
    for name, (count, billed, seconds) in sorted(groups.items(), key=lambda item: -item[1][1])[:limit]:
        label = name if isinstance(name, str) else " | ".join(name)
        print(f"{billed:6d} min {count:5d} jobs  avg {seconds / count:6.0f}s  {label}")


def report(title: str, jobs: list[dict]) -> None:
    billed = sum(minutes(job["seconds"]) for job in jobs)
    raw = round(sum(job["seconds"] for job in jobs) / 60)
    print(f"\n# {title}: {len(jobs)} jobs, {billed} minutes rounded up per job, {raw} minutes of run time")
    table(jobs, "runner label", lambda job: job["labels"])
    table(jobs, "workflow | event | job", lambda job: (job["workflow"], job["event"], job["job"]))
    table(jobs, "workflow | event | job | conclusion", lambda job: (job["workflow"], job["event"], job["job"], job["conclusion"]))
    table(jobs, "event | branch class", lambda job: (job["event"], branch_class(job["branch"])))
    table(jobs, "event | branch", lambda job: (job["event"], job["branch"]), 15)
    checks = sorted(job["seconds"] for job in jobs if job["job"].endswith("Check"))
    if checks:
        n = len(checks)
        print(
            f"\nCheck jobs {n}: p10 {checks[n // 10]}s, median {checks[n // 2]}s, "
            f"p90 {checks[n * 9 // 10]}s, max {checks[-1]}s, under a minute {sum(1 for s in checks if s < 60)}"
        )


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3) or argv[1] in ("-h", "--help"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    jobs = load(argv[1], created=argv[2] if len(argv) == 3 else None)
    print(f"{len(jobs)} jobs ran" + (f" in runs created {argv[2]}*" if len(argv) == 3 else ""))
    for name in KINDS:
        mine = [job for job in jobs if job["kind"] == name]
        if mine:
            report(name, mine)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
