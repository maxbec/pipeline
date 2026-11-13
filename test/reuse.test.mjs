import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runStep, scratch } from "./helpers.mjs"

// A fake `gh` that answers the calls the step makes: the compare of the green
// commit and the head, the push runs of the green commit and, for a promotion,
// the commits it reads trees and parents from. `--jq` is applied with real jq,
// and every path asked for is appended to `calls`.
function fakeGh({ compare, runs, commits = {}, failCompare = false, failRuns = false, failCommits = false }) {
  const dir = scratch("gh-")
  writeFileSync(join(dir, "compare.json"), JSON.stringify(compare))
  writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: runs }))
  for (const [sha, commit] of Object.entries(commits)) writeFileSync(join(dir, `commit-${sha}.json`), JSON.stringify(commit))
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
path="$2"
echo "$path" >> "${dir}/calls"
case "$path" in
  */compare/*) ${failCompare ? "exit 1" : `cat "${dir}/compare.json"`} ;;
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

function reuse({ title = "chore(release): 0.35.0-beta.1", headRepo = "o/r", headRef = "release/dev", baseRef = "dev", ...gh } = {}) {
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
