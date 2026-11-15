// scripts/ci-minutes: runs.sh against a fake `gh` on PATH (it applies the
// script's own --jq filter with the real jq), and the two readers against the
// file it wrote. What they must get right is what the bill depends on: a job
// counts once per attempt, rounded up to a whole minute; a job no runner took
// counts for nothing; hosted and self-hosted minutes are never added up.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ROOT, scratch } from "./helpers.mjs"

const DIR = join(ROOT, "scripts/ci-minutes")
const COLUMNS = [
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

// `gh api --paginate -X GET <path> -f k=v -F k=v --jq <filter>`: the path picks
// the fixture file, the filter runs over it, the call is logged.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "api" ]] || { echo "fake gh: unexpected $*" >&2; exit 2; }
shift
endpoint="" filter=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --paginate) shift ;;
    -X) shift 2 ;;
    -f | -F) echo "field $2" >> "$FIXTURE/calls"; shift 2 ;;
    --jq) filter=$2; shift 2 ;;
    *) endpoint=$1; shift ;;
  esac
done
echo "endpoint $endpoint" >> "$FIXTURE/calls"
file="$FIXTURE/$(echo "$endpoint" | tr '/' '_').json"
[[ -f "$file" ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
jq -r "$filter" "$file"
`

const at = (time) => `2026-11-15T${time}Z`
function job(runId, name, conclusion, seconds, over = {}) {
  const start = Date.parse(at("10:00:00"))
  return {
    run_id: runId,
    workflow_name: "Pipeline",
    head_branch: "feat/x",
    name,
    conclusion,
    started_at: at("10:00:00"),
    completed_at: new Date(start + seconds * 1000).toISOString().replace(".000Z", "Z"),
    labels: ["ubuntu-latest"],
    runner_group_name: "GitHub Actions",
    run_attempt: 1,
    ...over,
  }
}
const run = (id, event, conclusion, pr, created = at("09:59:00")) => ({
  id,
  event,
  conclusion,
  created_at: created,
  pull_requests: pr ? [{ number: pr }] : [],
})

const RUNS = [
  run(1, "pull_request", "failure", 12),
  run(2, "push", "success", null),
  run(3, "pull_request", null, 13),
  run(4, "workflow_run", "success", null, "2026-11-14T23:00:00Z"),
]
const JOBS = {
  1: [
    job(1, "pipeline / Guard", "success", 9),
    job(1, "pipeline / Check", "failure", 601),
    job(1, "pipeline / Check", "failure", 598, { run_attempt: 2 }),
    job(1, "pipeline / Deploy", "skipped", 0, { runner_group_name: null }),
  ],
  2: [
    job(2, "pipeline / Guard", "success", 5, { head_branch: "dev", labels: ["ubuntu-slim"] }),
    job(2, "pipeline / Check", "success", 60, { head_branch: "dev", labels: ["self-hosted", "rack"], runner_group_name: "Default" }),
  ],
  3: [
    // A name and a branch that would break a filter built by pasting them into it.
    job(3, 'pipeline / Check "$(touch pwned)"', "cancelled", 61, { head_branch: "feat/it's-`id`" }),
    // Queued and never started.
    { ...job(3, "pipeline / Check", "cancelled", 0), started_at: null, completed_at: null },
  ],
  4: [job(4, "train / Train", "success", 24, { workflow_name: "Train", head_branch: "dev" })],
}

function fixture({ runs = RUNS, jobs = JOBS } = {}) {
  const dir = scratch("ci-minutes-")
  mkdirSync(join(dir, "bin"))
  writeFileSync(join(dir, "bin/gh"), FAKE_GH)
  chmodSync(join(dir, "bin/gh"), 0o755)
  writeFileSync(join(dir, "repos_acme_widgets_actions_runs.json"), JSON.stringify({ workflow_runs: runs }))
  for (const [id, list] of Object.entries(jobs)) {
    writeFileSync(join(dir, `repos_acme_widgets_actions_runs_${id}_jobs.json`), JSON.stringify({ jobs: list }))
  }
  return dir
}

function runsSh(dir, ...args) {
  return spawnSync("bash", [join(DIR, "runs.sh"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FIXTURE: dir },
  })
}
// No __pycache__ beside the scripts: the tests run in the checkout.
const python = (script, ...args) =>
  spawnSync("python3", [join(DIR, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  })
const rows = (tsv) =>
  tsv
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"))

/** The file runs.sh writes for the fixture above. */
function collected() {
  const dir = fixture()
  const out = runsSh(dir, "acme/widgets", "2026-11-14")
  assert.equal(out.status, 0, out.stderr)
  const file = join(dir, "jobs.tsv")
  writeFileSync(file, out.stdout)
  return { dir, file, out }
}

test("runs.sh writes one line per job and attempt, with the run's fields beside the job's", () => {
  const { dir, out } = collected()
  const [header, ...lines] = rows(out.stdout)
  assert.deepEqual(header, COLUMNS)
  for (const line of lines) assert.equal(line.length, COLUMNS.length, line.join("|"))
  assert.equal(lines.length, 8, "every job that has a start and an end; the one never started is not a line")
  assert.deepEqual(lines[1], [
    "1",
    "Pipeline",
    "pull_request",
    "feat/x",
    "failure",
    "12",
    at("09:59:00"),
    "pipeline / Check",
    "failure",
    "601",
    "ubuntu-latest",
    "GitHub Actions",
    "1",
  ])
  assert.equal(lines[2][12], "2", "the rerun is a line of its own")
  assert.deepEqual(lines[3].slice(7), ["pipeline / Deploy", "skipped", "0", "ubuntu-latest", "", "1"], "kept in the file")
  assert.deepEqual(lines[5].slice(2, 6), ["push", "dev", "success", "-"], "no pull request is a dash, never an empty field")
  assert.deepEqual(lines[5].slice(10, 12), ["self-hosted,rack", "Default"])
  assert.deepEqual(lines[6].slice(2, 6), ["pull_request", "feat/it's-`id`", "-", "13"], "a run still going has no conclusion")
  assert.equal(lines[6][7], 'pipeline / Check "$(touch pwned)"')
  assert.equal(existsSync(join(dir, "pwned")), false, "a job's name is data, never a command")
  assert.match(out.stderr, /4 runs of acme\/widgets/)
  const calls = readFileSync(join(dir, "calls"), "utf8")
  assert.match(calls, /^field created=>=2026-11-14$/m)
  assert.match(calls, /^field filter=all$/m, "every attempt's jobs, not only the latest")
})

test("runs.sh takes a last day, and refuses anything that is not a repository and a day", () => {
  const dir = fixture()
  assert.equal(runsSh(dir, "acme/widgets", "2026-11-01", "2026-11-07").status, 0)
  assert.match(readFileSync(join(dir, "calls"), "utf8"), /^field created=2026-11-01\.\.2026-11-07$/m)
  for (const args of [[], ["acme/widgets"], ["acme", "2026-11-01"], ["acme/widgets", "yesterday"], ["acme/widgets", "2026-11-01", "x"]]) {
    const out = runsSh(dir, ...args)
    assert.equal(out.status, 2, args.join(" "))
    assert.match(out.stderr, /^usage: runs\.sh/)
    assert.equal(out.stdout, "")
  }
})

test("runs.sh stops at the API's 1,000 runs instead of writing a window with a hole in it", () => {
  const many = Array.from({ length: 1000 }, (_, i) => run(i + 1, "push", "success", null))
  const out = runsSh(fixture({ runs: many, jobs: {} }), "acme/widgets", "2026-11-01")
  assert.equal(out.status, 1)
  assert.match(out.stderr, /1,000 runs/)
  assert.equal(out.stdout, "")
})

test("runs.sh fails when a run's jobs cannot be read, after writing the others", () => {
  const { 2: _gone, ...rest } = JOBS
  const out = runsSh(fixture({ jobs: rest }), "acme/widgets", "2026-11-14")
  assert.equal(out.status, 1)
  assert.match(out.stderr, /jobs of run 2 could not be read/)
  assert.match(out.stderr, /1 of 4 runs are missing/)
  assert.equal(rows(out.stdout).length, 1 + 6)
})

test("agg.py rounds each job up on its own, drops what no runner took, and keeps hosted and self-hosted apart", () => {
  const { file } = collected()
  const out = python("agg.py", file)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /^7 jobs ran$/m, "the skipped Deploy is not one of them")
  // 9s, 601s, 598s, 5s, 61s, 24s: 1 + 11 + 10 + 1 + 2 + 1.
  assert.match(out.stdout, /^# GitHub-hosted: 6 jobs, 26 minutes rounded up per job, 22 minutes of run time$/m)
  assert.match(out.stdout, /^# self-hosted: 1 jobs, 1 minutes rounded up per job, 1 minutes of run time$/m)
  assert.ok(out.stdout.indexOf("# GitHub-hosted") < out.stdout.indexOf("# self-hosted"))
  assert.match(out.stdout, /^ {4}25 min {5}5 jobs {2}avg {4}259s {2}ubuntu-latest$/m)
  assert.match(out.stdout, /^ {5}1 min {5}1 jobs {2}avg {6}5s {2}ubuntu-slim$/m, "the small runner has a price of its own")
  assert.match(out.stdout, /^ {4}21 min {5}2 jobs .* Pipeline \| pull_request \| pipeline \/ Check$/m, "both attempts are billed")
  assert.doesNotMatch(out.stdout, /Deploy/)

  const day = python("agg.py", file, "2026-11-14")
  assert.match(day.stdout, /^1 jobs ran in runs created 2026-11-14\*$/m)
  assert.match(day.stdout, /Train \| workflow_run \| train \/ Train/)
})

test("perpr.py counts the Check per pull request branch, and what the red ones and the reruns cost", () => {
  const { file } = collected()
  const out = python("perpr.py", file)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /^3 `pipeline \/ Check` jobs ran$/m, "the job by its exact name")
  assert.match(out.stdout, /^# GitHub-hosted: 2 jobs, 21 minutes$/m)
  assert.match(out.stdout, /^pull request branches 1, jobs 2; per branch: median 2, mean 2\.0, max 2$/m)
  assert.match(out.stdout, /^pull request jobs over 120s: 2, 21 minutes; shorter \(reused\): 0$/m)
  assert.match(out.stdout, /^failed or cancelled on a pull request: 2 jobs, 21 minutes$/m)
  assert.match(out.stdout, /^reruns on a pull request \(attempt 2 and later\): 1 jobs, 10 minutes$/m)
  assert.match(out.stdout, /^# self-hosted: 1 jobs, 1 minutes$/m)
  assert.match(out.stdout, /^push jobs 1: over 120s 0, 0 minutes; shorter \(reused\): 1$/m)

  const since = python("perpr.py", file, "2026-11-16")
  assert.match(since.stdout, /^0 `pipeline \/ Check` jobs ran in runs created since 2026-11-16$/m)
  const other = python("perpr.py", file, "--job", "pipeline / Guard", "--full-seconds", "6")
  assert.match(other.stdout, /^pull request jobs over 6s: 1, 1 minutes; shorter \(reused\): 0$/m)
})

test("the readers refuse a file that is not from runs.sh, and say how they are called", () => {
  const dir = scratch("ci-minutes-")
  const file = join(dir, "old.tsv")
  writeFileSync(file, "1\tTrain\tworkflow_run\tdev\tskipped\t2026-11-15T15:34:40Z\ttrain / Train\tskipped\t-1\tubuntu-latest\t1\n")
  for (const script of ["agg.py", "perpr.py"]) {
    const out = python(script, file)
    assert.notEqual(out.status, 0, script)
    assert.match(out.stderr, /not a file from runs\.sh/, script)
  }
  const usage = python("agg.py")
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /usage: agg\.py <jobs\.tsv>/)
  assert.match(python("perpr.py", "--help").stdout, /usage: perpr\.py <jobs\.tsv>/)
})
