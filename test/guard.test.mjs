import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runStep, scratch } from "./helpers.mjs"

const pr = (over = {}) => ({
  EVENT_NAME: "pull_request",
  PR_BASE: "dev",
  PR_HEAD: "feat/x",
  PR_TITLE: "feat(api): add the thing",
  PR_HEAD_REPO: "maxbec/demo",
  BASE_REPO: "maxbec/demo",
  DEV_EXISTS: "true",
  ...over,
})

const guard = (env) => runStep("guard", "rules", env)

test("a conventional feature PR into dev passes", () => {
  assert.equal(guard(pr()).status, 0)
})

test("a non-conventional title is rejected, because versions are derived from it", () => {
  for (const title of ["Update readme", "Feat: caps type", "feat add colon", "fix(): empty scope", "WIP"]) {
    const r = guard(pr({ PR_TITLE: title }))
    assert.equal(r.status, 1, `title ${JSON.stringify(title)} must fail`)
    assert.match(r.stdout + r.stderr, /::error::/)
  }
})

test("every conventional type, an optional scope and a breaking bang are accepted", () => {
  for (const title of [
    "fix: a",
    "perf(db): b",
    "refactor!: c",
    "docs(readme): d",
    "test: e",
    "build(deps): bump the routine-updates group with 6 updates",
    "ci(pipeline): f",
    "chore(release): 5.0.0",
    "chore(release): backmerge v5.0.0 into dev",
    "revert: g",
    "style: h",
    "feat(api)!: i",
  ]) {
    assert.equal(guard(pr({ PR_TITLE: title })).status, 0, `title ${JSON.stringify(title)} must pass`)
  }
})

test("main accepts only dev, promote/*, hotfix/* and release/* heads when dev exists", () => {
  for (const head of ["dev", "promote/slim-pipeline", "hotfix/urgent", "release/main"]) {
    assert.equal(guard(pr({ PR_BASE: "main", PR_HEAD: head, PR_TITLE: "chore(release): 1.0.0" })).status, 0, head)
  }
  for (const head of ["feat/x", "fix/y", "release-please--branches--main"]) {
    assert.equal(guard(pr({ PR_BASE: "main", PR_HEAD: head })).status, 1, head)
  }
})

test("a small repository (no dev) takes feature branches straight into main", () => {
  assert.equal(guard(pr({ PR_BASE: "main", PR_HEAD: "feat/x", DEV_EXISTS: "false" })).status, 0)
})

test("fork PRs never target main", () => {
  const r = guard(pr({ PR_BASE: "main", PR_HEAD: "dev", PR_HEAD_REPO: "someone/demo" }))
  assert.equal(r.status, 1)
  assert.match(r.stdout, /fork/i)
})

test("push and release events are not pull requests and pass through", () => {
  assert.equal(guard({ EVENT_NAME: "push" }).status, 0)
  assert.equal(guard({ EVENT_NAME: "release" }).status, 0)
})

test("the dev probe believes the branch name, not the status code", () => {
  // GET /branches/dev answered 200 with name "main" on navigaite/nvgt-trunk-plugin
  // (no dev branch), so the first fleet run refused a feature PR into main there.
  const dir = scratch("gh-")
  writeFileSync(join(dir, "gh"), '#!/usr/bin/env bash\n[[ "${FAKE_GH_EXIT:-0}" == 0 ]] || exit "$FAKE_GH_EXIT"\necho "$FAKE_GH_NAME"\n')
  chmodSync(join(dir, "gh"), 0o755)
  const probe = (env) =>
    runStep("guard", "dev", { PATH: `${dir}:${process.env.PATH}`, REPO: "o/r", GH_TOKEN: "t", ...env })
  assert.equal(probe({ FAKE_GH_NAME: "dev" }).outputs.exists, "true")
  assert.equal(probe({ FAKE_GH_NAME: "main" }).outputs.exists, "false", "200 with another name is not a dev branch")
  assert.equal(probe({ FAKE_GH_NAME: "", FAKE_GH_EXIT: "1" }).outputs.exists, "false")
})
