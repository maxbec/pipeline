"""Reads the file runs.sh writes. Shared by agg.py and perpr.py.

A job that no runner took costs nothing and says nothing about duration, so
`load` drops every skipped job and every job of zero seconds or less.
"""

from __future__ import annotations

import csv
import math

COLUMNS = [
    "run_id",
    "workflow",
    "event",
    "branch",
    "run_conclusion",
    "pr",
    "run_created",
    "job",
    "conclusion",
    "seconds",
    "labels",
    "runner_group",
    "attempt",
]
HOSTED = "GitHub-hosted"
SELF_HOSTED = "self-hosted"
KINDS = [HOSTED, SELF_HOSTED]


def minutes(seconds: int) -> int:
    """What GitHub bills for a job: its duration rounded up to a whole minute."""
    return max(1, math.ceil(seconds / 60))


def kind(row: dict) -> str:
    """Whose machine ran the job. Only GitHub-hosted minutes are billed."""
    labels = row["labels"].split(",")
    if "self-hosted" in labels:
        return SELF_HOSTED
    if row["runner_group"] == "GitHub Actions":
        return HOSTED
    # A self-hosted runner registered without the default labels, or a file
    # from before the runner_group column: GitHub's own labels decide.
    if any(label.startswith(("ubuntu-", "windows-", "macos-")) for label in labels):
        return HOSTED
    return SELF_HOSTED


def load(path: str, created: str | None = None, since: str | None = None) -> list[dict]:
    """The jobs that ran, each with `seconds` as a number and `kind` set.

    `created` keeps the runs whose creation time starts with it (`2026-11-15`,
    `2026-11-15T14`); `since` keeps the runs created at or after it. Both
    compare the UTC timestamp as text.
    """
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)
        header = next(reader, None)
        if header != COLUMNS:
            raise SystemExit(f"{path}: not a file from runs.sh (the header line is missing or different)")
        rows = [dict(zip(COLUMNS, line)) for line in reader if len(line) == len(COLUMNS)]
    jobs = []
    for row in rows:
        if created and not row["run_created"].startswith(created):
            continue
        if since and row["run_created"] < since:
            continue
        try:
            row["seconds"] = int(row["seconds"])
        except ValueError:
            continue
        if row["conclusion"] == "skipped" or row["seconds"] <= 0:
            continue
        row["kind"] = kind(row)
        jobs.append(row)
    return jobs
