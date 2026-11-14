import assert from "node:assert/strict"
import { test } from "node:test"
import { mergePolicy, type PolicyInput } from "../src/policy.ts"

const REPO = "acme/widgets"

function pr(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    isDraft: false,
    labels: [],
    headRefName: "feat/endpoint",
    baseRefName: "dev",
    headRepository: REPO,
    baseRepository: REPO,
    authorLogin: "octocat",
    title: "feat: the endpoint",
    commits: [],
    changedFiles: ["src/endpoint.ts"],
    ...over,
  }
}

test("a feature PR into dev of a major repository is considered", () => {
  assert.deepEqual(mergePolicy(pr(), "major"), { action: "consider" })
})

test("a feature PR into main of a small repository is considered", () => {
  assert.deepEqual(mergePolicy(pr({ baseRefName: "main" }), "small"), { action: "consider" })
})

test("a backmerge into dev is considered", () => {
  const backmerge = pr({ headRefName: "backmerge/v1.4.0", title: "chore: backmerge v1.4.0" })
  assert.deepEqual(mergePolicy(backmerge, "major"), { action: "consider" })
})

const skipped: [string, Partial<PolicyInput>, "major" | "small"][] = [
  ["a draft", { isDraft: true }, "major"],
  ["a hold label", { labels: ["hold"] }, "major"],
  ["a fork head", { headRepository: "mallory/widgets" }, "major"],
  ["a head whose repository is gone", { headRepository: null }, "major"],
  ["a Release PR on dev", { headRefName: "release/dev" }, "major"],
  [
    "a Release PR on main of a small repository",
    { headRefName: "release/main", baseRefName: "main" },
    "small",
  ],
  ["a promotion head", { headRefName: "promote/main", baseRefName: "main" }, "major"],
  [
    "a promotion head in a small repository",
    { headRefName: "promote/main", baseRefName: "main" },
    "small",
  ],
  ["dev into main", { headRefName: "dev", baseRefName: "main" }, "major"],
  ["dev into main of a small repository", { headRefName: "dev", baseRefName: "main" }, "small"],
  ["a hotfix", { headRefName: "hotfix/login", baseRefName: "main" }, "major"],
  ["a hotfix in a small repository", { headRefName: "hotfix/login", baseRefName: "main" }, "small"],
  ["any base main of a major repository", { baseRefName: "main" }, "major"],
  ["a base other than dev in a major repository", { baseRefName: "feat/stack" }, "major"],
  ["a base other than main in a small repository", { baseRefName: "dev" }, "small"],
]

for (const [name, over, kind] of skipped) {
  test(`${name} is skipped (${kind})`, () => {
    const result = mergePolicy(pr(over), kind)
    assert.equal(result.action, "skip", JSON.stringify(result))
    assert.ok("reason" in result && result.reason.length > 0)
  })
}

for (const path of [
  ".github/workflows/ci.yaml",
  ".github/workflows/nested/deploy.yml",
  ".github/pipeline.yaml",
]) {
  test(`a PR that changes ${path} needs a human`, () => {
    const result = mergePolicy(pr({ changedFiles: ["src/a.ts", path] }), "major")
    assert.equal(result.action, "needs_human", JSON.stringify(result))
    assert.ok("reason" in result && result.reason.includes(path))
  })
}

test("a file that only looks like the pipeline's is not one", () => {
  const files = [
    ".github/pipeline.yaml.md",
    "docs/.github/workflows/x.yaml",
    ".github/actions/a/action.yaml",
  ]
  assert.deepEqual(mergePolicy(pr({ changedFiles: files }), "major"), { action: "consider" })
})

test("a hold label wins over everything", () => {
  const everything = pr({
    labels: ["needs-human", "hold"],
    isDraft: true,
    headRefName: "release/dev",
    headRepository: "mallory/widgets",
    changedFiles: [".github/workflows/ci.yaml"],
  })
  const result = mergePolicy(everything, "major")
  assert.equal(result.action, "skip")
  assert.match((result as { reason: string }).reason, /hold/)
  // Also over a PR that would otherwise only need a human.
  const workflow = mergePolicy(
    pr({ labels: ["hold"], changedFiles: [".github/pipeline.yaml"] }),
    "major",
  )
  assert.match((workflow as { reason: string }).reason, /hold/)
})

test("a skip wins over needs_human: a draft that changes a workflow gets no label", () => {
  const result = mergePolicy(
    pr({ isDraft: true, changedFiles: [".github/workflows/ci.yaml"] }),
    "major",
  )
  assert.equal(result.action, "skip")
})

const dependabot = (over: Partial<PolicyInput>): PolicyInput =>
  pr({
    authorLogin: "dependabot[bot]",
    headRefName: "dependabot/npm_and_yarn/left-pad-1.3.0",
    ...over,
  })

test("a Dependabot patch or minor bump is considered", () => {
  const byTitle = dependabot({ title: "chore(deps): bump left-pad from 1.2.0 to 1.3.0" })
  assert.deepEqual(mergePolicy(byTitle, "major"), { action: "consider" })
  const byBody = dependabot({
    title: "chore(deps): bump the minor group with 2 updates",
    commits: [
      {
        oid: "a",
        headline: "bump",
        body: "update-type: version-update:semver-minor",
        signed: true,
        signatureState: "VALID",
      },
    ],
  })
  assert.deepEqual(mergePolicy(byBody, "major"), { action: "consider" })
})

test("a Dependabot major bump is skipped", () => {
  const result = mergePolicy(
    dependabot({ title: "chore(deps): bump left-pad from 1.2.0 to 2.0.0" }),
    "major",
  )
  assert.equal(result.action, "skip")
  assert.match((result as { reason: string }).reason, /major/)
})

test("a Dependabot bump that cannot be classified is skipped", () => {
  const result = mergePolicy(
    dependabot({ title: "chore(deps): bump the everything group" }),
    "major",
  )
  assert.equal(result.action, "skip")
})
