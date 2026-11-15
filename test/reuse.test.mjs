import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runStep, scratch } from "./helpers.mjs"

// A fake `gh` that answers the calls the step makes: the compare of the green
// commit and the head, the push runs of the green commit and, for a promotion,
// the commits it reads trees and parents from. `--jq` is applied with real jq,
// and every path asked for is appended to `calls`. In fast mode a Release PR
// also asks for the marker artifacts of a tree (`markers`, by artifact name)
// and for each marker's run (`markerRuns`, by run id).
function fakeGh({
  compare,
  runs,
  commits = {},
  markers = {},
  markerRuns = {},
  failCompare = false,
  failRuns = false,
  failCommits = false,
  failArtifacts = false,
}) {
  const dir = scratch("gh-")
  writeFileSync(join(dir, "compare.json"), JSON.stringify(compare))
  writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: runs }))
  writeFileSync(join(dir, "no-artifacts.json"), JSON.stringify({ total_count: 0, artifacts: [] }))
  for (const [name, artifacts] of Object.entries(markers)) {
    writeFileSync(join(dir, `artifacts-${name}.json`), JSON.stringify({ total_count: artifacts.length, artifacts }))
  }
  for (const [id, run] of Object.entries(markerRuns)) writeFileSync(join(dir, `run-${id}.json`), JSON.stringify(run))
  for (const [sha, commit] of Object.entries(commits)) writeFileSync(join(dir, `commit-${sha}.json`), JSON.stringify(commit))
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
path="$2"
echo "$path" >> "${dir}/calls"
case "$path" in
  */compare/*) ${failCompare ? "exit 1" : `cat "${dir}/compare.json"`} ;;
  */actions/artifacts\\?name=*)
    ${failArtifacts ? "exit 1" : "true"}
    name="\${path#*name=}"; name="\${name%%&*}"
    f="${dir}/artifacts-$name.json"; [[ -f "$f" ]] || f="${dir}/no-artifacts.json"
    jq -r "$4" "$f" ;;
  */actions/runs/*) f="${dir}/run-\${path##*/}.json"; [[ -f "$f" ]] || exit 1; jq -r "$4" "$f" ;;
  */actions/runs*) ${failRuns ? "exit 1" : `jq "$4" "${dir}/runs.json"`} ;;
  */git/commits/*) ${failCommits ? "exit 1" : `jq -r "$4" "${dir}/commit-\${path##*/}.json"`} ;;
  *) exit 2 ;;
esac
`,
  )
  chmodSync(join(dir, "gh"), 0o755)
  return dir
}

const patch = (pairs) => `@@ -1,3 +1,3 @@\n ${"{"}\n${pairs.map(([o, n]) => `-${o}\n+${n}`).join("\n")}\n ${"}"}`

const releaseCompare = (files) => ({ status: "ahead", ahead_by: 1, behind_by: 0, files })
const versionBump = { filename: "package.json", status: "modified", patch: patch([['  "version": "0.34.2",', '  "version": "0.35.0-beta.1",']]) }
const changelog = { filename: "CHANGELOG.md", status: "modified", patch: "@@ -1 +1,4 @@\n+## 0.35.0-beta.1\n+\n+- feat: x\n # Changelog" }
const greenRun = { path: ".github/workflows/ci.yaml", conclusion: "success" }

function reuse({ title = "chore(release): 0.35.0-beta.1", headRepo = "o/r", headRef = "release/dev", baseRef = "dev", env = {}, ...gh } = {}) {
  const dir = fakeGh({ compare: releaseCompare([versionBump, changelog]), runs: [greenRun], ...gh })
  const r = runStep("guard", "reuse", {
    PATH: `${dir}:${process.env.PATH}`,
    GH_TOKEN: "t",
    REPO: "o/r",
    PR_TITLE: title,
    PR_HEAD_REPO: headRepo,
    HEAD_REF: headRef,
    BASE_REF: baseRef,
    BASE_SHA: "b".repeat(40),
    HEAD_SHA: HEAD,
    MERGE_SHA: MERGE,
    ...env,
  })
  assert.equal(r.status, 0, `the step never fails the run: ${r.stdout}${r.stderr}`)
  r.calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : []
  return r
}

// A promotion: the head is one commit over the Release it promotes, and
// merging it into the base yields the head's own tree.
const HEAD = "a".repeat(40)
const MERGE = "c".repeat(40)
const RELEASE = "d".repeat(40)
const TREE = "e".repeat(40)
const promotionCommits = {
  [HEAD]: { tree: { sha: TREE }, parents: [{ sha: RELEASE }] },
  [MERGE]: { tree: { sha: TREE }, parents: [{ sha: "b".repeat(40) }, { sha: HEAD }] },
}
const promotion = (over = {}) => reuse({ title: "chore(release): 0.35.0", headRef: "promote/main", baseRef: "main", commits: promotionCommits, ...over })

test("a Release PR over a green base reuses the base's Check", () => {
  const r = reuse()
  assert.equal(r.outputs.reuse, "true")
  assert.equal(r.outputs["base-sha"], "b".repeat(40))
  assert.match(r.outputs.note, /^Lint, test and build passed on dev at bbbbbbb; this head adds only the version/)
})

test("a plain version file and a version = line count as version edits", () => {
  const r = reuse({
    compare: releaseCompare([
      { filename: "VERSION", status: "modified", patch: "@@ -1 +1 @@\n-v0.34.2\n+v0.35.0-beta.1" },
      { filename: "pyproject.toml", status: "modified", patch: patch([['version = "0.34.2"', 'version = "0.35.0-beta.1"']]) },
      changelog,
    ]),
  })
  assert.equal(r.outputs.reuse, "true")
})

test("any change beyond the version runs the full Check", () => {
  const cases = {
    "a dependency range moved to the release version": [
      { filename: "package.json", status: "modified", patch: patch([['    "left-pad": "^1.0.0",', '    "left-pad": "^0.35.0-beta.1",']]) },
    ],
    "a script changed next to the version": [
      { filename: "package.json", status: "modified", patch: patch([['  "version": "0.34.2",', '  "version": "0.35.0-beta.1",'], ['  "test": "a",', '  "test": "b",']]) },
    ],
    "a version other than the title's": [
      { filename: "package.json", status: "modified", patch: patch([['  "version": "0.34.2",', '  "version": "0.36.0",']]) },
    ],
    "an added line": [{ filename: "package.json", status: "modified", patch: "@@ -1 +1,2 @@\n+  \"x\": 1,\n {" }],
    "a new source file": [{ filename: "src/evil.ts", status: "added", patch: "@@ -0,0 +1 @@\n+x" }],
    "a binary without a patch": [{ filename: "logo.png", status: "modified" }],
    "a renamed version file": [{ filename: "package.json", status: "renamed", patch: versionBump.patch }],
  }
  for (const [why, files] of Object.entries(cases)) {
    assert.equal(reuse({ compare: releaseCompare([...files, changelog]) }).outputs.reuse, "false", why)
  }
})

test("a head that is not exactly one commit over the base tip runs the full Check", () => {
  for (const shape of [
    { status: "ahead", ahead_by: 2, behind_by: 0 }, // a forward merge of main, or a person's commit
    { status: "diverged", ahead_by: 1, behind_by: 1 }, // the base moved on; Flaiky rebuilds
  ]) {
    assert.equal(reuse({ compare: { ...shape, files: [versionBump] } }).outputs.reuse, "false", JSON.stringify(shape))
  }
})

test("no green push run on the base tip runs the full Check", () => {
  for (const runs of [
    [],
    [{ path: ".github/workflows/ci.yaml", conclusion: "failure" }],
    [{ path: ".github/workflows/ci.yaml", conclusion: null }],
    [{ path: ".github/workflows/other.yaml", conclusion: "success" }],
  ]) {
    assert.equal(reuse({ runs }).outputs.reuse, "false", JSON.stringify(runs))
  }
})

test("a title that names no release, or a head from a fork, runs the full Check", () => {
  assert.equal(reuse({ title: "feat: x" }).outputs.reuse, "false")
  assert.equal(reuse({ title: "chore(release): backmerge v1.0.0 into dev" }).outputs.reuse, "false")
  assert.equal(reuse({ headRepo: "fork/r" }).outputs.reuse, "false")
})

test("an API that does not answer runs the full Check instead of failing", () => {
  assert.equal(reuse({ failCompare: true }).outputs.reuse, "false")
  assert.equal(reuse({ failRuns: true }).outputs.reuse, "false")
})

test("a promotion reuses the Check of the Release it promotes", () => {
  const stable = { filename: "package.json", status: "modified", patch: patch([['  "version": "0.35.0-beta.1",', '  "version": "0.35.0",']]) }
  const r = promotion({ compare: releaseCompare([stable, changelog]) })
  assert.equal(r.outputs.reuse, "true")
  assert.equal(r.outputs["base-sha"], RELEASE, "the green commit is the promoted Release, not the base tip")
  assert.match(r.outputs.note, /^Lint, test and build passed on the promoted Release at ddddddd; this head adds only the version/)
  assert.ok(r.calls.some((c) => c.includes(`/compare/${RELEASE}...${HEAD}`)), "compared against the Release")
  const runs = r.calls.find((c) => c.includes("/actions/runs"))
  assert.ok(runs.includes(`head_sha=${RELEASE}`) && !runs.includes("branch="), "its push run is on the other branch")
})

test("a Release PR still asks for the push run on its own base branch", () => {
  const runs = reuse().calls.find((c) => c.includes("/actions/runs"))
  assert.ok(runs.includes(`head_sha=${"b".repeat(40)}`) && runs.includes("branch=dev"))
})

test("a promotion into a base with commits of its own runs the full Check", () => {
  const r = promotion({ commits: { ...promotionCommits, [MERGE]: { tree: { sha: "f".repeat(40) }, parents: [] } } })
  assert.equal(r.outputs.reuse, "false")
  assert.match(r.stdout, /does not yield the head's tree/)
})

test("a promotion head that is not one commit over a Release runs the full Check", () => {
  const twoParents = { ...promotionCommits, [HEAD]: { tree: { sha: TREE }, parents: [{ sha: RELEASE }, { sha: "9".repeat(40) }] } }
  assert.equal(promotion({ commits: twoParents }).outputs.reuse, "false")
  assert.equal(promotion({ compare: { status: "ahead", ahead_by: 2, behind_by: 0, files: [versionBump] } }).outputs.reuse, "false")
  assert.equal(promotion({ runs: [] }).outputs.reuse, "false", "the Release it promotes was never green")
  assert.equal(promotion({ failCommits: true }).outputs.reuse, "false", "an API that does not answer")
})

test("a promotion that carries code runs the full Check", () => {
  const code = { filename: "src/index.ts", status: "modified", patch: patch([["  a()", "  b()"]]) }
  assert.equal(promotion({ compare: releaseCompare([versionBump, code]) }).outputs.reuse, "false")
})

test("a diff the compare API may have cut short runs the full Check", () => {
  const many = Array.from({ length: 300 }, () => changelog)
  const r = reuse({ compare: releaseCompare(many) })
  assert.equal(r.outputs.reuse, "false")
  assert.match(r.stdout, /at most 300 files/)
})

// --- fast mode: a Release PR stands on the full Check of its base tip ---------
//
// With test.pr_command set, the base's push run is a fast Check. A release
// must not stand on it: the tree of the base tip needs a full marker.

const BASE = "b".repeat(40)
const BASE_TREE = "7".repeat(40)
const FULL = `pipeline-checked-tree-${BASE_TREE}`
const FAST = `pipeline-fast-tree-${BASE_TREE}`
const baseCommit = { [BASE]: { tree: { sha: BASE_TREE }, parents: [{ sha: "9".repeat(40) }] } }
const artifact = (runId, { expired = false, repo = 1, headRepo = 1 } = {}) => ({
  expired,
  workflow_run: { id: runId, repository_id: repo, head_repository_id: headRepo },
})
const ciRun = { path: ".github/workflows/ci.yaml" }
const fastMode = (over = {}) => reuse({ commits: baseCommit, env: { FAST_MODE: "true" }, ...over })

test("fast mode: a Release PR over a base tip with a full marker reuses that full Check", () => {
  const r = fastMode({ markers: { [FULL]: [artifact(41)] }, markerRuns: { 41: ciRun } })
  assert.equal(r.outputs.reuse, "true")
  assert.equal(r.outputs.unverified, undefined)
  assert.equal(r.outputs["base-sha"], BASE)
  assert.equal(
    r.outputs.note,
    "The full Check passed on dev at bbbbbbb (tree 7777777, run 41); this head adds only the version and the changelog, so that result stands.",
  )
  assert.ok(r.calls.some((c) => c.includes(`/git/commits/${BASE}`)), "the tree is the base tip's")
  assert.ok(r.calls.some((c) => c.includes(`artifacts?name=${FULL}&`)))
  assert.ok(!r.calls.some((c) => c.includes("actions/runs?head_sha=")), "the push run is not what a release stands on")
})

test("fast mode: a green push run alone leaves the Release PR unverified", () => {
  const r = fastMode({ runs: [greenRun] })
  assert.equal(r.outputs.unverified, "true")
  assert.equal(r.outputs.reuse, "false", "unverified is never a reuse")
  assert.equal(r.outputs["unverified-note"], "dev at bbbbbbb (tree 7777777) has not passed the full Check")
  assert.equal(r.outputs.note, undefined)
  assert.equal(r.outputs["base-sha"], undefined)
})

test("fast mode: a fast marker of the base tip does not verify a release", () => {
  const r = fastMode({ markers: { [FAST]: [artifact(41)] }, markerRuns: { 41: ciRun } })
  assert.equal(r.outputs.unverified, "true")
  assert.ok(!r.calls.some((c) => c.includes("pipeline-fast-tree")), "the fast name is never asked for")
})

test("fast mode: only a live full marker from this repository's own pipeline verifies a release", () => {
  const cases = {
    "a fork's pull request uploaded it": { markers: { [FULL]: [artifact(41, { headRepo: 2 })] }, markerRuns: { 41: ciRun } },
    "it expired": { markers: { [FULL]: [artifact(41, { expired: true })] }, markerRuns: { 41: ciRun } },
    "another workflow uploaded it": { markers: { [FULL]: [artifact(41)] }, markerRuns: { 41: { path: ".github/workflows/other.yaml" } } },
    "its run is gone": { markers: { [FULL]: [artifact(41)] }, markerRuns: {} },
    "it carries no run": { markers: { [FULL]: [{ expired: false, workflow_run: null }] } },
    "it marks another tree": { markers: { [`pipeline-checked-tree-${"8".repeat(40)}`]: [artifact(41)] }, markerRuns: { 41: ciRun } },
  }
  for (const [why, gh] of Object.entries(cases)) {
    const r = fastMode(gh)
    assert.equal(r.outputs.unverified, "true", why)
    assert.equal(r.outputs.reuse, "false", why)
  }
  const mixed = fastMode({ markers: { [FULL]: [artifact(40, { headRepo: 2 }), artifact(41)] }, markerRuns: { 40: ciRun, 41: ciRun } })
  assert.equal(mixed.outputs.reuse, "true", "one good marker among bad ones is enough")
})

test("fast mode: an API that does not answer the marker lookup fails closed, as unverified", () => {
  const good = { markers: { [FULL]: [artifact(41)] }, markerRuns: { 41: ciRun } }
  const noTree = fastMode({ ...good, failCommits: true })
  assert.equal(noTree.outputs.unverified, "true")
  assert.match(noTree.outputs["unverified-note"], /the commits API did not answer/)
  const noArtifacts = fastMode({ ...good, failArtifacts: true })
  assert.equal(noArtifacts.outputs.unverified, "true")
  assert.match(noArtifacts.outputs["unverified-note"], /the artifacts API did not answer/)
  const badTree = fastMode({ ...good, commits: { [BASE]: { tree: { sha: "nope" } } } })
  assert.equal(badTree.outputs.unverified, "true")
})

test("fast mode: a Release PR that is more than its base plus a version is checked itself, not unverified", () => {
  const good = { markers: { [FULL]: [artifact(41)] }, markerRuns: { 41: ciRun } }
  const code = { filename: "src/index.ts", status: "modified", patch: patch([["  a()", "  b()"]]) }
  const cases = {
    "it carries code": { compare: releaseCompare([versionBump, code]) },
    "it is two commits over the base": { compare: { status: "ahead", ahead_by: 2, behind_by: 0, files: [versionBump] } },
    "the base moved on": { compare: { status: "diverged", ahead_by: 1, behind_by: 1, files: [versionBump] } },
    "the title names no version": { title: "feat: x" },
    "the head lives in a fork": { headRepo: "fork/r" },
    "the compare API did not answer": { failCompare: true },
  }
  for (const [why, over] of Object.entries(cases)) {
    const r = fastMode({ ...good, ...over })
    // Guard's depth step makes that Check a full one for every release/* head.
    assert.equal(r.outputs.reuse, "false", why)
    assert.equal(r.outputs.unverified, undefined, why)
    assert.ok(!r.calls.some((c) => c.includes("actions/artifacts")), `no marker is asked for: ${why}`)
  }
})

test("fast mode: a promotion is unchanged and stands on the push run of the Release it promotes", () => {
  const stable = { filename: "package.json", status: "modified", patch: patch([['  "version": "0.35.0-beta.1",', '  "version": "0.35.0",']]) }
  const r = promotion({ compare: releaseCompare([stable, changelog]), env: { FAST_MODE: "true" } })
  assert.equal(r.outputs.reuse, "true")
  assert.equal(r.outputs.unverified, undefined)
  assert.equal(r.outputs["base-sha"], RELEASE)
  assert.match(r.outputs.note, /^Lint, test and build passed on the promoted Release at ddddddd; /)
  assert.ok(!r.calls.some((c) => c.includes("actions/artifacts")), "no marker is asked for")
  const never = promotion({ runs: [], env: { FAST_MODE: "true" } })
  assert.equal(never.outputs.reuse, "false")
  assert.equal(never.outputs.unverified, undefined, "a promotion is checked, never unverified")
})

test("without test.pr_command a Release PR stands on its base's green push run, exactly as before", () => {
  for (const env of [{}, { FAST_MODE: "false" }, { FAST_MODE: "" }]) {
    const why = JSON.stringify(env)
    const r = reuse({ env })
    assert.equal(r.outputs.reuse, "true", why)
    assert.deepEqual(Object.keys(r.outputs).sort(), ["base-sha", "note", "reuse"], why)
    assert.equal(
      r.outputs.note,
      "Lint, test and build passed on dev at bbbbbbb; this head adds only the version and the changelog, so that result stands.",
      why,
    )
    assert.equal(r.calls.length, 2, `the compare and the push runs, nothing else: ${why}`)
    assert.ok(r.calls[0].includes("/compare/") && r.calls[1].includes("actions/runs?head_sha="), why)
    const red = reuse({ runs: [], env })
    assert.deepEqual(red.outputs, { reuse: "false" }, why)
  }
})
