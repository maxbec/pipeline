import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { test } from "node:test"
import { runStep, scratch } from "./helpers.mjs"

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

/** A clone checked out at a detached commit, as actions/checkout leaves a release. */
function releaseCheckout(branches) {
  const dir = scratch()
  const origin = join(dir, "origin")
  const work = join(dir, "work")
  git(dir, "init", "-q", "-b", branches[0], origin)
  git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "release")
  for (const b of branches.slice(1)) git(origin, "branch", b)
  git(dir, "clone", "-q", origin, work)
  git(work, "checkout", "-q", "--detach")
  return work
}

const deployBranch = (cwd, prerelease) => runStep("deploy", "branch", { CWD: cwd, PRERELEASE: String(prerelease) })

test("a prerelease is deployed from dev, a stable release from main", () => {
  const pre = releaseCheckout(["main", "dev"])
  const r = deployBranch(pre, true)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.outputs.name, "dev")
  assert.equal(git(pre, "rev-parse", "--abbrev-ref", "HEAD"), "dev")

  const stable = releaseCheckout(["main", "dev"])
  assert.equal(deployBranch(stable, false).outputs.name, "main")
  assert.equal(git(stable, "rev-parse", "--abbrev-ref", "HEAD"), "main")
})

test("a prerelease in a repository without dev is deployed from main", () => {
  const work = releaseCheckout(["main"])
  assert.equal(deployBranch(work, true).outputs.name, "main")
})

test("without a matching branch the checkout stays detached and only warns", () => {
  const work = releaseCheckout(["trunk"])
  const r = deployBranch(work, false)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.outputs.name, undefined)
  assert.match(r.stdout, /::warning::/)
  assert.equal(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
})
