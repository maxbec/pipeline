import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runStep, scratch } from "./helpers.mjs"

// A fake `gh` that answers the two calls the step makes: the compare of base
// and head, and the push runs of the base tip. `--jq` is applied with real jq.
function fakeGh({ compare, runs, failCompare = false, failRuns = false }) {
  const dir = scratch("gh-")
  writeFileSync(join(dir, "compare.json"), JSON.stringify(compare))
  writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: runs }))
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
path="$2"
case "$path" in
  */compare/*) ${failCompare ? "exit 1" : `cat "${dir}/compare.json"`} ;;
  */actions/runs*) ${failRuns ? "exit 1" : `jq "$4" "${dir}/runs.json"`} ;;
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

function reuse({ title = "chore(release): 0.35.0-beta.1", headRepo = "o/r", ...gh } = {}) {
  const dir = fakeGh({ compare: releaseCompare([versionBump, changelog]), runs: [greenRun], ...gh })
  const r = runStep("guard", "reuse", {
    PATH: `${dir}:${process.env.PATH}`,
    GH_TOKEN: "t",
    REPO: "o/r",
    PR_TITLE: title,
    PR_HEAD_REPO: headRepo,
    BASE_REF: "dev",
    BASE_SHA: "b".repeat(40),
    HEAD_SHA: "h".repeat(40),
  })
  assert.equal(r.status, 0, `the step never fails the run: ${r.stdout}${r.stderr}`)
  return r
}

test("a Release PR over a green base reuses the base's Check", () => {
  const r = reuse()
  assert.equal(r.outputs.reuse, "true")
  assert.equal(r.outputs["base-sha"], "b".repeat(40))
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
