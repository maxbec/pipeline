import assert from "node:assert/strict"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { runStep, scratch } from "./helpers.mjs"

const TREE = "a".repeat(40)
const SHA = "c".repeat(40)

// A fake `gh` for the three calls the step makes: the commit's tree, the
// marker artifacts of that tree, and each marker's run. `--jq` is applied with
// real jq, raw like gh prints it. `artifacts` are the full markers
// (pipeline-checked-tree-<tree>), `fastArtifacts` the fast ones
// (pipeline-fast-tree-<tree>); every path asked for is appended to `calls`.
function fakeGh({ tree = TREE, artifacts = [], fastArtifacts = [], runs = {}, fail = [] }) {
  const dir = scratch("gh-")
  writeFileSync(join(dir, "commit.json"), JSON.stringify({ sha: SHA, tree: { sha: tree } }))
  writeFileSync(join(dir, "artifacts.json"), JSON.stringify({ total_count: artifacts.length, artifacts }))
  writeFileSync(join(dir, "fast-artifacts.json"), JSON.stringify({ total_count: fastArtifacts.length, artifacts: fastArtifacts }))
  for (const [id, run] of Object.entries(runs)) writeFileSync(join(dir, `run-${id}.json`), JSON.stringify(run))
  const failing = (what) => (fail.includes(what) ? "exit 1" : "true")
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
path="$2"
echo "$path" >> "${dir}/calls"
case "$path" in
  */git/commits/*) ${failing("commits")}; jq -r "$4" "${dir}/commit.json" ;;
  */actions/artifacts\\?name=pipeline-checked-tree-${tree}\\&*) ${failing("artifacts")}; jq -r "$4" "${dir}/artifacts.json" ;;
  */actions/artifacts\\?name=pipeline-fast-tree-${tree}\\&*) ${failing("fast-artifacts")}; jq -r "$4" "${dir}/fast-artifacts.json" ;;
  */actions/runs/*) ${failing("runs")}; f="${dir}/run-\${path##*/}.json"; [[ -f "$f" ]] || exit 1; jq -r "$4" "$f" ;;
  *) echo "unexpected gh api $path" >&2; exit 2 ;;
esac
`,
  )
  chmodSync(join(dir, "gh"), 0o755)
  return dir
}

const marker = (runId, { expired = false, repo = 1, headRepo = 1, name = "pipeline-checked-tree" } = {}) => ({
  name: `${name}-${TREE}`,
  expired,
  workflow_run: { id: runId, repository_id: repo, head_repository_id: headRepo },
})
const fastMarker = (runId, over = {}) => marker(runId, { ...over, name: "pipeline-fast-tree" })
const pipelineRun = { path: ".github/workflows/ci.yaml", head_branch: "feat/x", head_sha: "d".repeat(40) }

// `env` carries DEPTH, as Guard's depth step names it. The tests written
// before the depths pass none: a repository without test.pr_command.
function lookup(gh, env = {}) {
  const dir = fakeGh(gh)
  const r = runStep("guard", "tree", { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: "t", REPO: "o/r", SHA, ...env })
  assert.equal(r.status, 0, `the step never fails the run: ${r.stdout}${r.stderr}`)
  r.calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : []
  return r
}
const asked = (r, name) => r.calls.some((c) => c.includes(`artifacts?name=${name}-`))

test("a tree a passing Check marked before is not checked again", () => {
  const r = lookup({ artifacts: [marker(7)], runs: { 7: pipelineRun } })
  assert.equal(r.outputs.reuse, "true")
  assert.equal(r.outputs.tree, TREE)
  assert.equal(
    r.outputs.note,
    "Lint, test and build passed on the identical tree aaaaaaa in run 7 (feat/x at ddddddd), so that result stands.",
  )
})

// Lint, test and build depend on the tree alone; the secret scan reads
// commits. A pull request can end on a tree that passed before with commits
// no marked run ever saw (a secret added, then removed). The result stands,
// and `scan` has Check scan those commits all the same.
const HEAD = "e".repeat(40)
const pr = (gh, env = {}) => lookup(gh, { EVENT_NAME: "pull_request", PR_HEAD_SHA: HEAD, ...env })
const runAt = (sha) => ({ ...pipelineRun, head_sha: sha })

test("a pull request whose commits no marked run saw is reused, and still scanned for secrets", () => {
  const r = pr({ artifacts: [marker(7)], runs: { 7: pipelineRun } })
  assert.equal(r.outputs.reuse, "true")
  assert.equal(r.outputs.scan, "true")
  assert.equal(
    r.outputs.note,
    "Lint, test and build passed on the identical tree aaaaaaa in run 7 (feat/x at ddddddd), so that result stands. No marked run saw the commits of this pull request, so they are still scanned for secrets.",
  )
})

test("a pull request a marked run saw at this very head commit is not scanned again", () => {
  const same = pr({ artifacts: [marker(7)], runs: { 7: runAt(HEAD) } })
  assert.equal(same.outputs.reuse, "true")
  assert.equal(same.outputs.scan, "false")
  assert.equal(same.outputs.note, "Lint, test and build passed on the identical tree aaaaaaa in run 7 (feat/x at eeeeeee), so that result stands.")
  const later = pr({ artifacts: [marker(7), marker(8)], runs: { 7: pipelineRun, 8: runAt(HEAD) } })
  assert.equal(later.outputs.scan, "false", "any marked run at this head will do, not only the first")
  assert.match(later.outputs.note, /^Lint, test and build passed on the identical tree aaaaaaa in run 7 /, "the note names the first run that counts")
  const fast = pr({ artifacts: [marker(7)], fastArtifacts: [fastMarker(9)], runs: { 7: pipelineRun, 9: runAt(HEAD) } }, { DEPTH: "fast" })
  assert.equal(fast.outputs.scan, "false", "a fast marker's run scanned the commits just as well")
})

test("a run that does not count cannot vouch for the commits either", () => {
  const r = pr({ artifacts: [marker(7), marker(8)], runs: { 7: pipelineRun, 8: { ...runAt(HEAD), path: ".github/workflows/other.yaml" } } })
  assert.equal(r.outputs.reuse, "true")
  assert.equal(r.outputs.scan, "true")
})

test("a push stands on the scan of the pull request it merged, and a tree without a marker asks for no scan", () => {
  for (const env of [{}, { EVENT_NAME: "push" }, { EVENT_NAME: "schedule" }, { EVENT_NAME: "workflow_dispatch" }]) {
    const r = lookup({ artifacts: [marker(7)], runs: { 7: pipelineRun } }, env)
    assert.equal(r.outputs.reuse, "true", JSON.stringify(env))
    assert.equal(r.outputs.scan, "false", JSON.stringify(env))
  }
  const none = pr({})
  assert.equal(none.outputs.reuse, "false")
  assert.equal(none.outputs.scan, undefined, "the Check runs whole, scan included")
})

test("a tree without a marker runs the full Check and still names its tree for the marker", () => {
  const r = lookup({})
  assert.equal(r.outputs.reuse, "false")
  assert.equal(r.outputs.tree, TREE, "Check marks the tree once it passes")
  assert.match(r.stdout, /no Check of tree aaaaaaa has passed yet/)
})

test("only a live marker from this repository's own pipeline counts", () => {
  const cases = {
    "a fork's pull request uploaded it": { artifacts: [marker(7, { headRepo: 2 })], runs: { 7: pipelineRun } },
    "it expired": { artifacts: [marker(7, { expired: true })], runs: { 7: pipelineRun } },
    "another workflow uploaded it": { artifacts: [marker(7)], runs: { 7: { ...pipelineRun, path: ".github/workflows/other.yaml" } } },
    "its run is gone": { artifacts: [marker(7)], runs: {} },
    "it carries no run": { artifacts: [{ name: `pipeline-checked-tree-${TREE}`, expired: false, workflow_run: null }] },
  }
  for (const [why, gh] of Object.entries(cases)) {
    assert.equal(lookup(gh).outputs.reuse, "false", why)
  }
})

test("one good marker among bad ones is enough", () => {
  const r = lookup({
    artifacts: [marker(5, { headRepo: 2 }), marker(6), marker(7)],
    runs: { 6: { ...pipelineRun, path: ".github/workflows/other.yaml" }, 7: pipelineRun },
  })
  assert.equal(r.outputs.reuse, "true")
  assert.match(r.outputs.note, /in run 7 /)
})

test("an API that does not answer runs the full Check instead of failing", () => {
  const noCommit = lookup({ artifacts: [marker(7)], runs: { 7: pipelineRun }, fail: ["commits"] })
  assert.equal(noCommit.outputs.reuse, "false")
  assert.equal(noCommit.outputs.tree, undefined, "no tree, no marker")
  for (const what of ["artifacts", "runs"]) {
    const r = lookup({ artifacts: [marker(7)], runs: { 7: pipelineRun }, fail: [what] })
    assert.equal(r.outputs.reuse, "false", what)
    assert.equal(r.outputs.tree, TREE, what)
  }
})

// --- the two depths ----------------------------------------------------------

test("a full Check stands down only for a full marker", () => {
  for (const env of [{ DEPTH: "full" }, { DEPTH: "" }, {}]) {
    const why = JSON.stringify(env)
    const full = lookup({ artifacts: [marker(7)], runs: { 7: pipelineRun } }, env)
    assert.equal(full.outputs.reuse, "true", why)
    const fastOnly = lookup({ fastArtifacts: [fastMarker(8)], runs: { 8: pipelineRun } }, env)
    assert.equal(fastOnly.outputs.reuse, "false", `a fast marker says nothing about the full suite: ${why}`)
    assert.equal(fastOnly.outputs.tree, TREE, why)
    assert.ok(asked(fastOnly, "pipeline-checked-tree") && !asked(fastOnly, "pipeline-fast-tree"), `never even asks for the fast name: ${why}`)
    assert.match(fastOnly.stdout, /^Full Check: no Check of tree aaaaaaa has passed yet$/m, why)
  }
})

test("a fast Check stands down for a fast marker or a full one", () => {
  const fast = lookup({ fastArtifacts: [fastMarker(8)], runs: { 8: pipelineRun } }, { DEPTH: "fast" })
  assert.equal(fast.outputs.reuse, "true")
  assert.equal(
    fast.outputs.note,
    "Lint, the fast tests and build passed on the identical tree aaaaaaa in run 8 (feat/x at ddddddd), so that result stands.",
  )
  const full = lookup({ artifacts: [marker(7)], fastArtifacts: [fastMarker(8)], runs: { 7: pipelineRun, 8: pipelineRun } }, { DEPTH: "fast" })
  assert.equal(full.outputs.reuse, "true")
  assert.match(full.outputs.note, /^Lint, test and build passed .* in run 7 /, "the full marker is asked for first")
  assert.ok(!asked(full, "pipeline-fast-tree"))
  const none = lookup({}, { DEPTH: "fast" })
  assert.equal(none.outputs.reuse, "false")
  assert.equal(none.outputs.tree, TREE)
  assert.ok(asked(none, "pipeline-checked-tree") && asked(none, "pipeline-fast-tree"))
  assert.match(none.stdout, /^Fast Check: no Check of tree aaaaaaa has passed yet$/m)
})

test("a fast marker has to pass the same conditions as a full one", () => {
  const cases = {
    "a fork's pull request uploaded it": { fastArtifacts: [fastMarker(7, { headRepo: 2 })], runs: { 7: pipelineRun } },
    "it expired": { fastArtifacts: [fastMarker(7, { expired: true })], runs: { 7: pipelineRun } },
    "another workflow uploaded it": { fastArtifacts: [fastMarker(7)], runs: { 7: { ...pipelineRun, path: ".github/workflows/other.yaml" } } },
    "its run is gone": { fastArtifacts: [fastMarker(7)], runs: {} },
    "the artifacts API did not answer": { fastArtifacts: [fastMarker(7)], runs: { 7: pipelineRun }, fail: ["fast-artifacts"] },
  }
  for (const [why, gh] of Object.entries(cases)) {
    assert.equal(lookup(gh, { DEPTH: "fast" }).outputs.reuse, "false", why)
  }
})

test("a full marker whose run does not count leaves a fast Check to the fast marker", () => {
  const r = lookup(
    { artifacts: [marker(7, { headRepo: 2 })], fastArtifacts: [fastMarker(8)], runs: { 7: pipelineRun, 8: pipelineRun } },
    { DEPTH: "fast" },
  )
  assert.equal(r.outputs.reuse, "true")
  assert.match(r.outputs.note, /in run 8 /)
})
