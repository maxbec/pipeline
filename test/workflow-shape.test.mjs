import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ROOT, WORKFLOW, yaml } from "./helpers.mjs"

const wf = () => yaml(WORKFLOW)

test("the universal pipeline is exactly Guard, Check and Deploy", () => {
  const doc = wf()
  assert.ok(doc.on.workflow_call, "reusable workflow")
  assert.deepEqual(Object.keys(doc.jobs), ["guard", "check", "deploy"])
  assert.equal(doc.jobs.guard.name, "Guard")
  assert.equal(doc.jobs.check.name, "Check")
  assert.match(String(doc.jobs.deploy.name), /^Deploy/)
})

test("Check waits for Guard and runs on the configured runner", () => {
  const check = wf().jobs.check
  assert.ok([].concat(check.needs).includes("guard"))
  assert.match(String(check["runs-on"]), /needs\.guard\.outputs\.runner/)
  assert.match(String(check.if), /github\.event_name != 'release'/)
})

test("dependency review runs only when the repository's dependency graph answers", () => {
  const steps = wf().jobs.check.steps
  const probe = steps.find((s) => s.id === "depgraph")
  assert.ok(probe, "a probe step with id depgraph")
  assert.match(probe.run, /dependency-graph\/sbom/)
  const review = steps.find((s) => String(s.uses ?? "").startsWith("actions/dependency-review-action@"))
  assert.match(String(review.if), /steps\.depgraph\.outputs\.available == 'true'/)
  assert.doesNotMatch(String(review.if), /repository\.private/, "visibility is not a proxy for graph availability")
  const notice = steps.find((s) => /Dependency review unavailable/.test(s.name ?? ""))
  assert.match(String(notice.if), /steps\.depgraph\.outputs\.available != 'true'/)
})

test("Deploy fires only on a published release and never on a push", () => {
  const deploy = wf().jobs.deploy
  assert.match(String(deploy.if), /github\.event_name == 'release'/)
  assert.match(String(deploy.if), /github\.event\.action == 'published'/)
  assert.doesNotMatch(String(deploy.if), /push/)
  assert.ok(deploy.environment, "a GitHub environment per deploy")
  assert.match(JSON.stringify(deploy.environment), /prerelease/)
  assert.ok(deploy.permissions["id-token"] === "write", "OIDC")
})

test("every provider from A8 has a step, and no release-please or Flama remains", () => {
  const text = readFileSync(WORKFLOW, "utf8")
  for (const provider of ["vercel", "cloudflare-workers", "docker-ghcr", "npm"]) {
    assert.match(text, new RegExp(`PROVIDER == '${provider}'`), provider)
  }
  assert.doesNotMatch(text, /release-please|flama|Paperclip/i)
  const workflows = readdirSync(join(ROOT, ".github/workflows"))
  for (const name of workflows) {
    assert.doesNotMatch(name, /^(flama-|promote|auto-promote|create-release-pr|release|claude-code)/, name)
  }
  assert.ok(!existsSync(join(ROOT, ".flama")), ".flama gone")
  assert.ok(!existsSync(join(ROOT, ".release-please-manifest.json")), "release-please gone")
  assert.ok(!existsSync(join(ROOT, ".github/actions/release-management")), "release-management action gone")
})

test("the caller template pins by SHA, forwards the secrets and listens for releases", () => {
  const file = join(ROOT, ".github/workflows/examples/caller.yaml")
  const doc = yaml(file)
  assert.ok(doc.on.pull_request && doc.on.push, "PRs and pushes run Check")
  assert.deepEqual(doc.on.release.types, ["published"])
  assert.deepEqual(Object.keys(doc.jobs), ["pipeline"], "one job, so the context is `pipeline / Check`")
  const job = doc.jobs.pipeline
  assert.match(job.uses, /^maxbec\/pipeline\/\.github\/workflows\/universal-pipeline\.yaml@(__PIPELINE_SHA__|[0-9a-f]{40})$/)
  assert.match(readFileSync(file, "utf8"), /universal-pipeline\.yaml@\S+ # (__PIPELINE_VERSION__|v\d+\.\d+\.\d+)/)
  for (const s of [
    "CF_ACCESS_CLIENT_ID",
    "CF_ACCESS_CLIENT_SECRET",
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "VERCEL_TOKEN",
    "VERCEL_ORG_ID",
    "VERCEL_PROJECT_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "RENDER_DEPLOY_HOOK",
  ]) {
    assert.equal(job.secrets[s], `\${{ secrets.${s} }}`, s)
  }
  assert.equal(job.permissions.contents, "read")
  assert.equal(job.permissions["id-token"], "write")
})

test("this repository dogfoods the slim pipeline from its own tree", () => {
  const ci = yaml(join(ROOT, ".github/workflows/ci.yaml"))
  assert.equal(ci.jobs.pipeline.uses, "./.github/workflows/universal-pipeline.yaml")
  assert.deepEqual(Object.keys(ci.jobs), ["pipeline"])
  const config = yaml(join(ROOT, ".github/pipeline.yaml"))
  assert.equal(String(config.version), "3")
  assert.equal(config.deploy.provider, "none")
})
