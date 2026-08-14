#!/usr/bin/env python3
"""Baseline check for a repository with no package manifest.

There is nothing to install or compile here, so the delivery commands check the
things that can actually break: a YAML or JSON file that stops parsing, and a
shell script with a syntax error. For a repository whose whole content is
workflow and action definitions that is the entire surface — a malformed
`action.yaml` fails at use time, in another repository, long after the commit
that broke it.

Uses nothing beyond python3 and bash, because the runner has no linters
installed and a check that cannot run is not a check.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # A missing parser must fail, not silently skip the check.
    print("repo-check: PyYAML is required and is not installed", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent


def tracked() -> list[str]:
    listed = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True, text=True
    )
    return [path for path in listed.stdout.split("\0") if path]


def tolerant_loader():
    """Accept the local tags GitHub Actions and other tools attach to values."""

    class Loader(yaml.SafeLoader):
        pass

    def construct_local(loader, tag_suffix, node):
        if isinstance(node, yaml.ScalarNode):
            return loader.construct_scalar(node)
        if isinstance(node, yaml.SequenceNode):
            return loader.construct_sequence(node)
        return loader.construct_mapping(node)

    Loader.add_multi_constructor("!", construct_local)
    return Loader


def main() -> int:
    failures: list[str] = []
    paths = tracked()

    documents = [p for p in paths if p.endswith((".yaml", ".yml"))]
    objects = [p for p in paths if p.endswith(".json")]
    scripts = [p for p in paths if p.endswith(".sh")]

    # A repository that tracks nothing is not something to certify as buildable.
    if not paths:
        failures.append("no tracked files")
    checked = len(documents) + len(objects) + len(scripts)

    for path in documents:
        try:
            list(yaml.load_all((ROOT / path).read_text(encoding="utf-8"), Loader=tolerant_loader()))
        except yaml.YAMLError as error:
            failures.append(f"{path}: {str(error).splitlines()[0]}")
        except UnicodeDecodeError:
            failures.append(f"{path}: is not valid UTF-8")

    for path in objects:
        try:
            json.loads((ROOT / path).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            failures.append(f"{path}: {error}")

    for path in scripts:
        syntax = subprocess.run(["bash", "-n", str(ROOT / path)], capture_output=True, text=True)
        if syntax.returncode != 0:
            first = (syntax.stderr.strip().splitlines() or ["syntax error"])[0]
            failures.append(f"{path}: {first}")

    # Every tracked file being unparseable-by-omission is the failure mode this
    # guard removes: a repository of nothing but binaries would otherwise pass.
    if not failures and checked == 0:
        readable = [p for p in paths if (ROOT / p).is_file() and (ROOT / p).stat().st_size > 0]
        if not readable:
            failures.append("nothing checkable and no non-empty tracked file")

    for failure in failures:
        print(f"repo-check: {failure}", file=sys.stderr)
    if failures:
        return 1
    print(
        f"repo-check: {len(documents)} YAML, {len(objects)} JSON, "
        f"{len(scripts)} shell scripts, all valid"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
