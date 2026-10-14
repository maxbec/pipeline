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
  const doc = wf()
  const check = doc.jobs.check
  assert.ok([].concat(check.needs).includes("guard"))
  // check-runner is the configured runner unless Guard reuses the base's Check.
  assert.match(String(check["runs-on"]), /needs\.guard\.outputs\.check-runner/)
  assert.match(doc.jobs.guard.outputs["check-runner"], /\|\| steps\.config\.outputs\.runner \}\}$/)
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

test("test artifacts are uploaded right after a failed Test step, never on success", () => {
  // navigaite/crewsy keeps Playwright traces with `retain-on-failure`; without
  // this step a flake could only be read from the job log.
  const doc = wf()
  assert.equal(doc.jobs.guard.outputs["test-artifact-path"], "${{ steps.config.outputs.test-artifact-path }}")
  const steps = doc.jobs.check.steps
  const testIndex = steps.findIndex((s) => s.name === "Test")
  assert.equal(steps[testIndex].id, "test", "the upload step reads the Test step's outcome by id")
  const upload = steps[testIndex + 1]
  assert.equal(upload.name, "Upload test artifacts", "directly after Test, before Infisical and Build")
  assert.match(String(upload.if), /^failure\(\) && /, "runs only after a failure, never on a green job")
  assert.match(String(upload.if), /steps\.test\.outcome == 'failure'/, "a failed lint or install does not count")
  assert.match(String(upload.if), /needs\.guard\.outputs\.test-artifact-path != ''/)
  const build = steps.find((s) => s.name === "Upload build artifact")
  assert.equal(upload.uses, build.uses, "same upload-artifact pin as the build artifact")
  assert.match(String(upload.with.path), /needs\.guard\.outputs\.test-artifact-path/)
  assert.match(String(upload.with.name), /github\.run_attempt/, "v4 artifacts are immutable; a re-run must not 409")
  assert.equal(upload.with["if-no-files-found"], "ignore")
  assert.equal(upload.with["retention-days"], 7)
})

test("a reused Check runs nothing but its notice and the tree marker, on a hosted runner", () => {
  // Guard sets `reuse` for a tree that passed before, or for a Release PR whose
  // tree is the green base tip plus the version and the changelog. A step that
  // forgot the gate would run on the runner with no checkout or no toolchain
  // and turn the check red. Only the marker runs either way: it needs neither.
  const doc = yaml(WORKFLOW)
  const check = doc.jobs.check
  assert.equal(check.env.REUSE, "${{ needs.guard.outputs.reuse }}")
  assert.equal(check["runs-on"], "${{ fromJSON(needs.guard.outputs.check-runner) }}")
  assert.equal(
    doc.jobs.guard.outputs["check-runner"],
    "${{ (steps.tree.outputs.reuse == 'true' || steps.reuse.outputs.reuse == 'true') && '[\"ubuntu-latest\"]' || steps.config.outputs.runner }}",
  )
  assert.equal(doc.jobs.guard.outputs.reuse, "${{ steps.tree.outputs.reuse == 'true' || steps.reuse.outputs.reuse == 'true' }}")
  const [notice, ...rest] = check.steps
  assert.equal(notice.if, "env.REUSE == 'true'")
  assert.match(notice.env.NOTE, /needs\.guard\.outputs\.reuse-note/)
  const marker = rest.splice(-2)
  assert.deepEqual(marker.map((s) => s.name), ["Write the tree marker", "Mark the checked tree"])
  for (const step of rest) {
    const cond = String(step.if ?? "")
    assert.ok(
      cond.startsWith("env.REUSE != 'true'") || /steps\.test\.outcome == 'failure'/.test(cond),
      `step "${step.name}" runs on a reused Check: if: ${cond || "(none)"}`,
    )
  }
})

test("Node is set up before pnpm, and pnpm caches its own store", () => {
  // pnpm/action-setup v6 bootstraps pnpm with `npm ci`, taking npm from PATH. The homelab
  // runner images carried Node 18 and no npm (2026-10-11), so setup-node has to come first,
  // and its `cache: pnpm` (which needs pnpm on PATH) gives way to the action's own `cache`.
  for (const job of ["check", "deploy"]) {
    const steps = wf().jobs[job].steps
    const node = steps.findIndex((s) => String(s.uses ?? "").startsWith("actions/setup-node@"))
    const pnpm = steps.flatMap((s, i) => (String(s.uses ?? "").startsWith("pnpm/action-setup@") ? [i] : []))
    assert.equal(pnpm.length, 2, `${job}: one pnpm step for a packageManager pin, one for the latest`)
    for (const i of pnpm) {
      assert.ok(node < i, `${job}: "${steps[i].name}" runs before setup-node`)
      assert.match(steps[i].uses, /@[0-9a-f]{40}$/, `${job}: SHA-pinned`)
      assert.match(readFileSync(WORKFLOW, "utf8"), new RegExp(`${steps[i].uses} # v6\\.\\d+\\.\\d+\\n`), "a v6 release")
      assert.equal(steps[i].with.cache, "${{ needs.guard.outputs.cache == 'pnpm' }}")
    }
    const [pinned, latest] = pnpm.map((i) => steps[i])
    assert.equal(pinned.with.version, undefined, `${job}: version next to packageManager throws`)
    assert.equal(latest.with.version, "${{ needs.guard.outputs.pnpm-version }}")
    assert.equal(
      steps[node].with.cache,
      "${{ needs.guard.outputs.cache != 'pnpm' && needs.guard.outputs.cache || '' }}",
      `${job}: setup-node caches npm and yarn only`,
    )
  }
})

test("a passing Check marks its tree last, under the name Guard looks up", () => {
  const doc = wf()
  const steps = doc.jobs.check.steps
  const [write, upload] = steps.slice(-2)
  assert.equal(doc.jobs.guard.outputs.tree, "${{ steps.tree.outputs.tree }}")
  for (const step of [write, upload]) {
    // No status function: a failed step above skips both, so a marker means every step passed.
    assert.equal(step.if, "needs.guard.outputs.tree != ''", `${step.name}`)
  }
  assert.match(write.run, /\$RUNNER_TEMP\/checked-tree\.json/)
  const build = steps.find((s) => s.name === "Upload build artifact")
  assert.equal(upload.uses, build.uses, "same upload-artifact pin as the build artifact")
  assert.equal(upload.with.name, "pipeline-checked-tree-${{ needs.guard.outputs.tree }}")
  assert.equal(upload.with.path, "${{ runner.temp }}/checked-tree.json")
  assert.equal(upload.with.overwrite, true, "a re-run of a green run finds its own first attempt's marker")
  const lookup = doc.jobs.guard.steps.find((s) => s.id === "tree")
  assert.match(lookup.run, /name=pipeline-checked-tree-\$tree/, "Guard searches the name Check writes")
  const release = doc.jobs.guard.steps.find((s) => s.id === "reuse")
  assert.ok(
    doc.jobs.guard.steps.indexOf(lookup) < doc.jobs.guard.steps.indexOf(release),
    "the tree lookup runs first; the Release PR rule only when it found nothing",
  )
  assert.match(release.if, /steps\.tree\.outputs\.reuse != 'true'/)
})
