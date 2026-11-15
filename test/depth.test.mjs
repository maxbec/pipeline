// The two depths of Check. A repository that sets test.pr_command (fast mode)
// runs lint, that command and build on pull requests and pushes, and lint,
// test.command and build where a release depends on it. Everything here is
// off for a repository without a pr_command: its Checks are full, as before.
import assert from "node:assert/strict"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { runStep, scratch } from "./helpers.mjs"

const b64 = (s) => Buffer.from(s).toString("base64")

const depth = (env) => {
  const r = runStep("guard", "depth", env)
  assert.equal(r.status, 0, r.stderr)
  return r.outputs.depth
}

test("the depth table: fast for pull requests and pushes, full where a release depends on it", () => {
  const fast = { FAST_MODE: "true" }
  const table = [
    [{ EVENT_NAME: "pull_request", HEAD_REF: "feat/x" }, "fast"],
    [{ EVENT_NAME: "pull_request", HEAD_REF: "fix/hotfix/x" }, "fast"], // only a head that starts with hotfix/
    [{ EVENT_NAME: "pull_request", HEAD_REF: "dev" }, "fast"],
    [{ EVENT_NAME: "pull_request", HEAD_REF: "promote/main" }, "fast"],
    [{ EVENT_NAME: "pull_request", HEAD_REF: "backmerge/v1.2.3" }, "fast"],
    [{ EVENT_NAME: "push" }, "fast"],
    [{ EVENT_NAME: "pull_request", HEAD_REF: "hotfix/login" }, "full"],
    [{ EVENT_NAME: "workflow_dispatch" }, "full"],
    [{ EVENT_NAME: "schedule" }, "full"],
    // A Release PR that Guard cannot show to be its base plus a version is
    // checked itself, and a release never stands on a fast Check.
    [{ EVENT_NAME: "pull_request", HEAD_REF: "release/dev" }, "full"],
    [{ EVENT_NAME: "pull_request", HEAD_REF: "release/main" }, "full"],
  ]
  for (const [env, want] of table) assert.equal(depth({ ...fast, ...env }), want, JSON.stringify(env))
})

test("only the two events named are ever fast", () => {
  for (const event of ["release", "merge_group", "pull_request_target", "repository_dispatch", ""]) {
    assert.equal(depth({ FAST_MODE: "true", EVENT_NAME: event, HEAD_REF: "feat/x" }), "full", event || "(no event)")
  }
})

test("without test.pr_command every run is full, whatever the event", () => {
  for (const mode of [{ FAST_MODE: "false" }, { FAST_MODE: "" }, {}]) {
    for (const env of [
      { EVENT_NAME: "pull_request", HEAD_REF: "feat/x" },
      { EVENT_NAME: "pull_request", HEAD_REF: "release/dev" },
      { EVENT_NAME: "pull_request", HEAD_REF: "hotfix/x" },
      { EVENT_NAME: "push" },
      { EVENT_NAME: "workflow_dispatch" },
      { EVENT_NAME: "schedule" },
    ]) {
      assert.equal(depth({ ...mode, ...env }), "full", JSON.stringify({ ...mode, ...env }))
    }
  }
})

const marker = (env) => {
  const r = runStep("guard", "marker", env)
  assert.equal(r.status, 0, r.stderr)
  return r.outputs.name
}

test("the marker is named for the depth: the full name after a full Check, the fast name after a fast one", () => {
  assert.equal(marker({ DEPTH: "full", FAST_MODE: "true", RELEASE_RULE: "" }), "pipeline-checked-tree")
  assert.equal(marker({ DEPTH: "fast", FAST_MODE: "true", RELEASE_RULE: "" }), "pipeline-fast-tree")
  // A promotion that stood down for the push run of the Release it promotes.
  assert.equal(marker({ DEPTH: "fast", FAST_MODE: "true", RELEASE_RULE: "true" }), "pipeline-fast-tree")
  // A Release PR that ran the Check itself, or found a full marker of its own tree.
  assert.equal(marker({ DEPTH: "full", FAST_MODE: "true", RELEASE_RULE: "false" }), "pipeline-checked-tree")
})

test("a Release PR that stood on its base's full marker leaves the fast name for its own tree", () => {
  // Its tree is the base's plus a version. Guard checks that anew every time;
  // a full marker would let a later run take it on trust.
  assert.equal(marker({ DEPTH: "full", FAST_MODE: "true", RELEASE_RULE: "true" }), "pipeline-fast-tree")
})

test("without test.pr_command the marker keeps the one name it always had", () => {
  for (const rule of ["", "true", "false"]) {
    for (const mode of ["false", ""]) {
      assert.equal(marker({ DEPTH: "full", FAST_MODE: mode, RELEASE_RULE: rule }), "pipeline-checked-tree", `${mode}/${rule}`)
    }
  }
})

test("a depth Guard did not name is never marked as full", () => {
  assert.equal(marker({ DEPTH: "", FAST_MODE: "true" }), "pipeline-fast-tree")
  assert.equal(marker({ FAST_MODE: "false" }), "pipeline-fast-tree")
})

// --- Check: which test command runs ----------------------------------------

function runTests(env) {
  const r = runStep("check", "test", { STACK: "none", PM: "npm", CI: "true", ...env })
  return { status: r.status, out: r.stdout.trim(), err: r.stderr }
}
const commands = { TEST_COMMAND_B64: b64("echo ran the full suite"), TEST_PR_COMMAND_B64: b64("echo ran the fast suite") }

test("a fast Check runs test.pr_command, a full Check test.command", () => {
  assert.deepEqual(runTests({ ...commands, PIPELINE_DEPTH: "fast" }), { status: 0, out: "ran the fast suite", err: "" })
  assert.deepEqual(runTests({ ...commands, PIPELINE_DEPTH: "full" }), { status: 0, out: "ran the full suite", err: "" })
})

test("a depth that is unset or unknown runs test.command", () => {
  assert.equal(runTests({ ...commands }).out, "ran the full suite")
  assert.equal(runTests({ ...commands, PIPELINE_DEPTH: "" }).out, "ran the full suite")
  assert.equal(runTests({ ...commands, PIPELINE_DEPTH: "FAST" }).out, "ran the full suite")
})

test("a fast Check without a pr_command falls back to test.command, then to detection", () => {
  assert.equal(runTests({ TEST_COMMAND_B64: b64("echo ran the full suite"), TEST_PR_COMMAND_B64: "", PIPELINE_DEPTH: "fast" }).out, "ran the full suite")
  const none = runTests({ TEST_COMMAND_B64: "", TEST_PR_COMMAND_B64: "", PIPELINE_DEPTH: "fast" })
  assert.equal(none.status, 0)
  assert.match(none.out, /::notice::No test command configured and none detected; skipped\./)
})

test("the test command sees PIPELINE_DEPTH, and a failing one fails the step", () => {
  const seen = { TEST_COMMAND_B64: b64('echo "depth=$PIPELINE_DEPTH"'), TEST_PR_COMMAND_B64: b64('echo "depth=$PIPELINE_DEPTH"') }
  assert.equal(runTests({ ...seen, PIPELINE_DEPTH: "fast" }).out, "depth=fast")
  assert.equal(runTests({ ...seen, PIPELINE_DEPTH: "full" }).out, "depth=full")
  assert.equal(runTests({ ...commands, TEST_PR_COMMAND_B64: b64("false | true"), PIPELINE_DEPTH: "fast" }).status, 1, "pipefail, like test.command")
})

// --- Check: a Release PR whose base tip has not passed the full Check -------

test("an unverified Release PR fails at once and names the command that runs the full Check", () => {
  const dir = scratch()
  const summary = join(dir, "summary")
  writeFileSync(summary, "")
  const r = runStep("check", "unverified", {
    NOTE: "dev at bbbbbbb (tree aaaaaaa) has not passed the full Check",
    BASE_REF: "dev",
    REPO: "o/r",
    GITHUB_STEP_SUMMARY: summary,
  })
  assert.equal(r.status, 1, "the Check is red")
  assert.match(r.stdout, /^::error::Not fully verified: dev at bbbbbbb \(tree aaaaaaa\) has not passed the full Check\./m)
  assert.match(r.stdout, /gh workflow run ci\.yaml --ref dev -R o\/r/)
  assert.match(r.stdout, /re-run all jobs/, "re-running the failed job alone repeats Guard's old answer")
  assert.match(readFileSync(summary, "utf8"), /gh workflow run ci\.yaml --ref dev -R o\/r/)
})

// --- Check: after a green full run, the Release PR is re-run ---------------

const SHA = "a".repeat(40)
// A fake `gh` for the three calls the step makes: the open pull requests into
// the branch, the newest runs of a head, and the re-run itself.
function fakeGh({ pulls = [], runs = [], fail = [] }) {
  const dir = scratch("gh-")
  writeFileSync(join(dir, "pulls.json"), JSON.stringify(pulls))
  writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: runs }))
  const failing = (what) => (fail.includes(what) ? "exit 1" : "true")
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
path="$2"
echo "$*" >> "${dir}/calls"
case "$path" in
  */pulls\\?*) ${failing("pulls")}; jq -r "$4" "${dir}/pulls.json" ;;
  */actions/runs/*/rerun) ${failing("rerun")} ;;
  */actions/runs\\?*) ${failing("runs")}; jq -r "$4" "${dir}/runs.json" ;;
  *) echo "unexpected gh api $path" >&2; exit 2 ;;
esac
`,
  )
  chmodSync(join(dir, "gh"), 0o755)
  return dir
}
const releasePr = (over = {}) => ({ number: 12, head: { ref: "release/dev", sha: SHA, repo: { full_name: "o/r" } }, ...over })
const prRun = (id, conclusion, path = ".github/workflows/ci.yaml") => ({ id, conclusion, path })

function rerun(gh, env = {}) {
  const dir = fakeGh(gh)
  const r = runStep("check", "rerun", {
    PATH: `${dir}:${process.env.PATH}`,
    GH_TOKEN: "t",
    REPO: "o/r",
    BRANCH: "dev",
    REF_TYPE: "branch",
    ...env,
  })
  assert.equal(r.status, 0, `the step never fails the Check: ${r.stdout}${r.stderr}`)
  r.calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : []
  r.reran = r.calls.filter((c) => c.includes("/rerun"))
  return r
}

test("a green full run re-runs the failed Pipeline run of the Release PR onto its branch", () => {
  const r = rerun({ pulls: [releasePr()], runs: [prRun(77, "failure"), prRun(70, "failure")] })
  assert.deepEqual(r.reran, ["api repos/o/r/actions/runs/77/rerun --method POST"], "the newest run, whole: Guard has to look again")
  assert.match(r.stdout, /::notice::Re-running run 77 of Release PR #12: dev has now passed the full Check\./)
  assert.ok(r.calls[0].startsWith("api repos/o/r/pulls?state=open&base=dev&per_page=100"), "only pull requests into this branch")
  assert.ok(r.calls[1].startsWith(`api repos/o/r/actions/runs?head_sha=${SHA}&event=pull_request&per_page=20`))
})

test("only an open Release PR from this repository whose newest pipeline run failed is re-run", () => {
  const cases = {
    "a feature PR": { pulls: [releasePr({ head: { ref: "feat/x", sha: SHA, repo: { full_name: "o/r" } } })], runs: [prRun(77, "failure")] },
    "a promotion": { pulls: [releasePr({ head: { ref: "promote/main", sha: SHA, repo: { full_name: "o/r" } } })], runs: [prRun(77, "failure")] },
    "a fork's release/ branch": { pulls: [releasePr({ head: { ref: "release/dev", sha: SHA, repo: { full_name: "fork/r" } } })], runs: [prRun(77, "failure")] },
    "a head whose repository is gone": { pulls: [releasePr({ head: { ref: "release/dev", sha: SHA, repo: null } })], runs: [prRun(77, "failure")] },
    "no pull request at all": { pulls: [], runs: [prRun(77, "failure")] },
    "the newest run is green": { pulls: [releasePr()], runs: [prRun(78, "success"), prRun(77, "failure")] },
    "the newest run is still going": { pulls: [releasePr()], runs: [prRun(78, null), prRun(77, "failure")] },
    "the newest run was cancelled": { pulls: [releasePr()], runs: [prRun(78, "cancelled")] },
    "the failed run is another workflow's": { pulls: [releasePr()], runs: [prRun(77, "failure", ".github/workflows/other.yaml")] },
    "the head has no run": { pulls: [releasePr()], runs: [] },
  }
  for (const [why, gh] of Object.entries(cases)) assert.deepEqual(rerun(gh).reran, [], why)
})

test("every Release PR onto the branch is looked at", () => {
  const other = "b".repeat(40)
  const r = rerun({
    pulls: [releasePr(), releasePr({ number: 13, head: { ref: "release/other", sha: other, repo: { full_name: "o/r" } } })],
    runs: [prRun(77, "failure")],
  })
  assert.equal(r.reran.length, 2)
  assert.ok(r.calls.some((c) => c.includes(`head_sha=${other}`)))
})

test("a token that may not re-run, read runs or list pull requests ends in a notice, never a red Check", () => {
  const noWrite = rerun({ pulls: [releasePr()], runs: [prRun(77, "failure")], fail: ["rerun"] })
  assert.match(noWrite.stdout, /::notice::.*needs actions: write from the caller.*Release PR #12.*gh run rerun 77 -R o\/r/)
  const noRead = rerun({ pulls: [releasePr()], runs: [prRun(77, "failure")], fail: ["runs"] })
  assert.match(noRead.stdout, /::notice::.*may not read workflow runs.*Release PR #12/)
  assert.deepEqual(noRead.reran, [])
  const noPulls = rerun({ pulls: [releasePr()], fail: ["pulls"] })
  assert.match(noPulls.stdout, /::notice::Could not list the pull requests into dev/)
  assert.deepEqual(noPulls.reran, [])
})

test("a run on a tag, or without a branch, re-runs nothing and asks nothing", () => {
  assert.deepEqual(rerun({ pulls: [releasePr()], runs: [prRun(77, "failure")] }, { REF_TYPE: "tag", BRANCH: "v1.0.0" }).calls, [])
  assert.deepEqual(rerun({ pulls: [releasePr()], runs: [prRun(77, "failure")] }, { BRANCH: "" }).calls, [])
})

test("the branch name is encoded into the query", () => {
  const r = rerun({ pulls: [] }, { BRANCH: "release train&x" })
  assert.ok(r.calls[0].startsWith("api repos/o/r/pulls?state=open&base=release%20train%26x&per_page=100"), r.calls[0])
})
