import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { runStep, scratch } from "./helpers.mjs"

const TREE = "a".repeat(40)
const SHA = "c".repeat(40)

// A fake `gh` for the three calls the step makes: the commit's tree, the
// marker artifacts of that tree, and each marker's run. `--jq` is applied with
// real jq, raw like gh prints it.
function fakeGh({ tree = TREE, artifacts = [], runs = {}, fail = [] }) {
  const dir = scratch("gh-")
  writeFileSync(join(dir, "commit.json"), JSON.stringify({ sha: SHA, tree: { sha: tree } }))
  writeFileSync(join(dir, "artifacts.json"), JSON.stringify({ total_count: artifacts.length, artifacts }))
  for (const [id, run] of Object.entries(runs)) writeFileSync(join(dir, `run-${id}.json`), JSON.stringify(run))
  const failing = (what) => (fail.includes(what) ? "exit 1" : "true")
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
path="$2"
case "$path" in
  */git/commits/*) ${failing("commits")}; jq -r "$4" "${dir}/commit.json" ;;
  */actions/artifacts\\?name=pipeline-checked-tree-${tree}\\&*) ${failing("artifacts")}; jq -r "$4" "${dir}/artifacts.json" ;;
  */actions/runs/*) ${failing("runs")}; f="${dir}/run-\${path##*/}.json"; [[ -f "$f" ]] || exit 1; jq -r "$4" "$f" ;;
  *) echo "unexpected gh api $path" >&2; exit 2 ;;
esac
`,
  )
  chmodSync(join(dir, "gh"), 0o755)
  return dir
}

const marker = (runId, { expired = false, repo = 1, headRepo = 1 } = {}) => ({
  name: `pipeline-checked-tree-${TREE}`,
  expired,
  workflow_run: { id: runId, repository_id: repo, head_repository_id: headRepo },
})
const pipelineRun = { path: ".github/workflows/ci.yaml", head_branch: "feat/x", head_sha: "d".repeat(40) }

function lookup(gh) {
  const dir = fakeGh(gh)
  const r = runStep("guard", "tree", { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: "t", REPO: "o/r", SHA })
  assert.equal(r.status, 0, `the step never fails the run: ${r.stdout}${r.stderr}`)
  return r
}

test("a tree a passing Check marked before is not checked again", () => {
  const r = lookup({ artifacts: [marker(7)], runs: { 7: pipelineRun } })
  assert.equal(r.outputs.reuse, "true")
  assert.equal(r.outputs.tree, TREE)
  assert.equal(
    r.outputs.note,
    "Lint, test and build passed on the identical tree aaaaaaa in run 7 (feat/x at ddddddd), so that result stands.",
  )
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
