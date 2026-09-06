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
  // The SBOM endpoint answers 200 on a private repository without GHAS, where the
  // review action then fails; the compare endpoint is what the action calls.
  assert.match(probe.run, /dependency-graph\/compare\/\$\{BASE_SHA\}\.\.\.\$\{HEAD_SHA\}/)
  assert.doesNotMatch(probe.run, /sbom/)
  assert.match(String(probe.env?.BASE_SHA), /github\.event\.pull_request\.base\.sha/)
  assert.match(String(probe.env?.HEAD_SHA), /github\.event\.pull_request\.head\.sha/)
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
  assert.match(
    readFileSync(file, "utf8"),
    /# (__PIPELINE_VERSION__|v\d+\.\d+\.\d+)\n\s*uses: maxbec\/pipeline\/\.github\/workflows\/universal-pipeline\.yaml@\S+\n/,
    "the tag is a comment on the line above the sha, so the line stays under 120 characters",
  )
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

test("no command string crosses the job boundary in plaintext", () => {
  // GitHub scans job outputs and silently drops any it thinks holds a
  // credential — "Skip output 'build-command' since it may contain secret."
  // Nothing fails; the consumer just receives an empty string and falls back to
  // a detected command (maxbec/crewdo#137). Every command output is therefore
  // base64, and every consumer decodes it.
  const text = readFileSync(WORKFLOW, "utf8")
  const plaintext = [...text.matchAll(/needs\.guard\.outputs\.([\w-]*command)\b(?!-b64)/g)].map((m) => m[1])
  assert.deepEqual(plaintext, [], "these outputs must be read as <name>-b64")
  const encoded = new Set([...text.matchAll(/needs\.guard\.outputs\.([\w-]+-b64)\b/g)].map((m) => m[1]))
  const declared = new Set(Object.keys(wf().jobs.guard.outputs))
  for (const name of encoded) assert.ok(declared.has(name), `Guard does not declare ${name}`)
  for (const name of declared) {
    if (name.endsWith("-command")) assert.fail(`Guard still declares the plaintext output ${name}`)
  }
})

test("every encoded command is decoded before it is run", () => {
  const steps = [...wf().jobs.check.steps, ...wf().jobs.deploy.steps]
  const consumers = steps.filter((s) =>
    Object.values(s.env ?? {}).some((v) => /outputs\.[\w-]+-b64/.test(String(v))),
  )
  assert.ok(consumers.length >= 4, "the lint, test and build steps plus the deploy decoder")
  for (const step of consumers) {
    for (const key of Object.keys(step.env ?? {})) {
      if (!key.endsWith("_B64")) continue
      assert.match(String(step.run), /base64 -d/, `${step.name} decodes its commands`)
      assert.ok(String(step.run).includes(`$${key}`), `${step.name} reads ${key}`)
    }
  }
})
