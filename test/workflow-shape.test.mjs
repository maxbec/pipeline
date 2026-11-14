import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ROOT, runStep, scratch, WORKFLOW, yaml } from "./helpers.mjs"

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

test("neither the pipeline nor the caller template talks to Infisical", () => {
  const doc = wf()
  for (const [id, job] of Object.entries(doc.jobs)) {
    assert.doesNotMatch(JSON.stringify(job), /infisical|CF_ACCESS/i, `${id} reads GitHub secrets only`)
  }
  assert.equal(doc.jobs.check.permissions["id-token"], undefined, "Check mints no OIDC token")
  // Callers pinned to this release may have been rendered for the one before
  // and still forward these; an undeclared secret is a startup failure.
  const declared = Object.keys(doc.on.workflow_call.secrets)
  for (const s of ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET"]) {
    assert.ok(declared.includes(s), `${s} stays declared for one release`)
  }
  const caller = readFileSync(join(ROOT, ".github/workflows/examples/caller.yaml"), "utf8")
  assert.doesNotMatch(caller, /infisical|CF_ACCESS/i)
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
  assert.equal(upload.name, "Upload test artifacts", "directly after Test, before Build")
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
  assert.equal(upload.with.overwrite, true, "a re-run must not 409 on its earlier attempt's name")
  const lookup = doc.jobs.guard.steps.find((s) => s.id === "tree")
  assert.match(lookup.run, /name=pipeline-checked-tree-\$tree/, "Guard searches the name Check writes")
  const release = doc.jobs.guard.steps.find((s) => s.id === "reuse")
  assert.ok(
    doc.jobs.guard.steps.indexOf(lookup) < doc.jobs.guard.steps.indexOf(release),
    "the tree lookup runs first; the Release PR rule only when it found nothing",
  )
  assert.match(release.if, /steps\.tree\.outputs\.reuse != 'true'/)
})

// --- the Train workflow ---------------------------------------------------

const WORKFLOWS = join(ROOT, ".github/workflows")
const TRAIN = join(WORKFLOWS, "train.yaml")
const TRAIN_FILES = ["train.yaml", "train-self.yaml", "train-sweep.yaml", "examples/train-caller.yaml"]
const READY = "steps.ready.outputs.ready == 'true'"
const trainSteps = () => yaml(TRAIN).jobs.train.steps
const usesStep = (steps, action) => steps.filter((s) => String(s.uses ?? "").startsWith(`${action}@`))

test("the train is a second reusable workflow whose jobs are all read-only", () => {
  const doc = yaml(TRAIN)
  assert.equal(doc.name, "Train")
  assert.deepEqual(Object.keys(doc.on), ["workflow_call"], "workflow_call only")
  assert.deepEqual(doc.permissions, {}, "nothing at the top level")
  assert.deepEqual(Object.keys(doc.jobs), ["train", "fix-triage", "fix-propose", "fix-commit"])
  for (const [id, j] of Object.entries(doc.jobs)) {
    assert.deepEqual(j.permissions, { contents: "read" }, `${id}: the job's own token only reads`)
  }
  const job = doc.jobs.train
  assert.equal(job.name, "Train")
  assert.deepEqual(job.permissions, { contents: "read" }, "everything that writes goes through the App token")
  assert.deepEqual(job.concurrency, { group: "train-${{ github.repository }}", "cancel-in-progress": false })
  assert.equal(job["timeout-minutes"], 15)
  const secrets = doc.on.workflow_call.secrets
  assert.deepEqual(Object.keys(secrets), ["TRAIN_APP_ID", "TRAIN_APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN"])
  for (const [name, s] of Object.entries(secrets)) assert.equal(s.required, false, `${name} is optional`)
  assert.equal(doc.on.workflow_call.inputs, undefined)
})

test("the train runs on a dispatch, a schedule and a green Pipeline run of a pull request or push", () => {
  const cond = String(yaml(TRAIN).jobs.train.if).replace(/\s+/g, " ")
  assert.match(cond, /github\.event_name == 'workflow_dispatch'/)
  assert.match(cond, /github\.event_name == 'schedule'/)
  assert.match(
    cond,
    /\(github\.event_name == 'workflow_run' && github\.event\.workflow_run\.conclusion == 'success' && \(github\.event\.workflow_run\.event == 'pull_request' \|\| github\.event\.workflow_run\.event == 'push'\)\)/,
  )
  assert.doesNotMatch(cond, /'release'|failure|cancelled|always\(\)/, "a deploy run or a red one starts nothing here")
})

test("a public repository's train is always GitHub-hosted", () => {
  // Private and PIPELINE_RUNNER set: the caller's runner. Anything else,
  // including an event that carries no repository.private: hosted.
  assert.equal(
    yaml(TRAIN).jobs.train["runs-on"],
    "${{ fromJSON((github.event.repository.private && vars.PIPELINE_RUNNER) || '[\"ubuntu-latest\"]') }}",
  )
})

test("without the App secrets the train does nothing and ends green", () => {
  const [ready, ...rest] = trainSteps()
  assert.equal(ready.id, "ready")
  assert.equal(ready.if, undefined, "the probe always runs")
  assert.deepEqual(ready.env, {
    APP_ID: "${{ secrets.TRAIN_APP_ID }}",
    APP_PRIVATE_KEY: "${{ secrets.TRAIN_APP_PRIVATE_KEY }}",
  })
  const off = runStep("train", "ready", { APP_ID: "", APP_PRIVATE_KEY: "" }, TRAIN)
  assert.equal(off.status, 0, "not an error")
  assert.equal(off.outputs.ready, "false")
  assert.match(off.stdout, /^::notice::/m)
  assert.equal(runStep("train", "ready", { APP_ID: "1", APP_PRIVATE_KEY: "" }, TRAIN).outputs.ready, "false")
  assert.equal(runStep("train", "ready", { APP_ID: "", APP_PRIVATE_KEY: "k" }, TRAIN).outputs.ready, "false")
  const on = runStep("train", "ready", { APP_ID: "1", APP_PRIVATE_KEY: "k" }, TRAIN)
  assert.equal(on.outputs.ready, "true")
  assert.doesNotMatch(on.stdout + on.stderr, /notice/)
  for (const step of rest) {
    const cond = String(step.if ?? "")
    assert.ok(
      cond === READY || /steps\.release\.outcome != 'skipped'/.test(cond),
      `step "${step.name}" would run without the secrets: if: ${cond || "(none)"}`,
    )
  }
  // Same probe, same gate, in the central sweep.
  const sweep = yaml(join(WORKFLOWS, "train-sweep.yaml")).jobs.sweep.steps
  assert.equal(sweep[0].run, ready.run.replace("the train does nothing here", "nothing is swept"))
  for (const step of sweep.slice(1)) assert.equal(step.if, READY, step.name)
})

test("the App token is minted by a pinned action and reaches this repository only", () => {
  const [mint, ...more] = usesStep(trainSteps(), "actions/create-github-app-token")
  assert.ok(mint && more.length === 0, "exactly one App-token step")
  assert.equal(mint.id, "app-token")
  assert.match(mint.uses, /@[0-9a-f]{40}$/)
  assert.deepEqual(mint.with, {
    "app-id": "${{ secrets.TRAIN_APP_ID }}",
    "private-key": "${{ secrets.TRAIN_APP_PRIVATE_KEY }}",
  })
  // With neither `owner` nor `repositories` the action scopes the token to the current repository.
  const sweepMint = usesStep(yaml(join(WORKFLOWS, "train-sweep.yaml")).jobs.sweep.steps, "actions/create-github-app-token")[0]
  assert.equal(sweepMint.uses, mint.uses, "one pin")
  assert.equal(sweepMint.with.owner, "${{ github.repository_owner }}", "the sweep's token covers the owner")
  assert.equal(sweepMint.with.repositories, undefined)
})

test("every action in the train files is pinned to a commit, with its version beside it", () => {
  const pipeline = readFileSync(WORKFLOW, "utf8")
  for (const file of TRAIN_FILES) {
    const text = readFileSync(join(WORKFLOWS, file), "utf8")
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)]
    assert.ok(uses.length > 0, file)
    for (const [, ref, rest] of uses) {
      if (ref.startsWith("./")) continue
      if (ref.startsWith("maxbec/pipeline/")) {
        assert.match(ref, /@__PIPELINE_SHA__$/, `${file}: ${ref}`)
        continue
      }
      assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${file}: ${ref} is not pinned to a commit`)
      assert.match(rest, /^ # v\d+\.\d+\.\d+$/, `${file}: ${ref} carries no version comment`)
      // checkout and setup-node move together with the pipeline's own pins.
      if (/^actions\/(checkout|setup-node)@/.test(ref)) {
        assert.ok(pipeline.includes(`uses: ${ref}${rest}\n`), `${file}: ${ref} differs from the pipeline's pin`)
      }
    }
  }
})

test("the train checks the repository out whole, with a token git can fetch with", () => {
  const [repo, pipeline, ...more] = usesStep(trainSteps(), "actions/checkout")
  assert.equal(more.length, 0)
  assert.equal(repo.with.repository, undefined, "the caller's repository")
  assert.equal(repo.with["fetch-depth"], 0)
  assert.equal(repo.with["fetch-tags"], true)
  assert.equal(repo.with.token, "${{ steps.app-token.outputs.token }}")
  assert.notEqual(repo.with["persist-credentials"], false, "release.ts runs `git fetch origin` in this clone")
  assert.equal(repo.with.path, undefined, "TRAIN_CLONE is the workspace")
  // The train's code: this repository at the commit the caller pinned.
  assert.deepEqual(pipeline.with, {
    repository: "maxbec/pipeline",
    ref: "${{ job.workflow_sha }}",
    path: ".pipeline",
    "sparse-checkout": "train",
    "persist-credentials": false,
  })
  assert.doesNotMatch(JSON.stringify(yaml(TRAIN).jobs), /github\.workflow_sha/, "that is the caller's commit")
  const deploy = wf().jobs.deploy.steps.find((s) => s.name === "Checkout the pipeline's actions")
  assert.equal(pipeline.with.ref, deploy.with.ref, "as Deploy does")
  assert.equal(pipeline.with.path, deploy.with.path)
})

test("the train's Node can strip types", () => {
  const [node] = usesStep(trainSteps(), "actions/setup-node")
  assert.equal(String(node.with["node-version"]), "24.x")
  assert.equal(node.with["check-latest"], true, "a cached 24.x older than 24.12 must not be picked")
  const engines = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).engines.node
  assert.equal(engines, ">=24.12", "the floor the comment in train.yaml names")
})

test("the release configuration reaches the entry as one line of JSON", () => {
  const read = (config) => {
    const dir = scratch()
    if (config !== null) {
      mkdirSync(join(dir, ".github"), { recursive: true })
      writeFileSync(join(dir, ".github/pipeline.yaml"), config)
    }
    const r = runStep("train", "config", { CWD: dir, CONFIG_FILE: ".github/pipeline.yaml" }, TRAIN)
    assert.equal(r.status, 0, r.stderr)
    return r.outputs.release
  }
  assert.equal(read(null), "{}", "no configuration file")
  assert.equal(read("version: '3'\n"), "{}", "no release block")
  assert.equal(
    read("version: '3'\nrelease:\n  version_files: [package.json, apps/web/package.json]\n  release_as: 2.0.0\n"),
    '{"version_files":["package.json","apps/web/package.json"],"release_as":"2.0.0"}',
  )
  assert.equal(yaml(TRAIN).jobs.train.steps.find((s) => s.id === "config").env.CONFIG_FILE, ".github/pipeline.yaml")
})

test("Release and Merge get the entries' environment, and a failed Release does not skip Merge", () => {
  const steps = trainSteps()
  const [release, merge] = steps.slice(-2)
  assert.deepEqual([release.name, merge.name], ["Release", "Merge"], "the last two steps, in this order")
  assert.equal(release.id, "release")
  assert.equal(release.if, READY)
  assert.equal(release.run.trim(), "node .pipeline/train/bin/release.ts")
  assert.deepEqual(release.env, {
    GITHUB_TOKEN: "${{ steps.app-token.outputs.token }}",
    TRAIN_CLONE: "${{ github.workspace }}",
    TRAIN_RELEASE_CONFIG: "${{ steps.config.outputs.release }}",
    TRAIN_APP_SLUG: "${{ steps.app-token.outputs.app-slug }}",
  })
  assert.equal(merge.run.trim(), "node .pipeline/train/bin/merge.ts")
  assert.deepEqual(merge.env, { GITHUB_TOKEN: "${{ steps.app-token.outputs.token }}" })
  // always(): a red Release still lets Merge run — and still fails the job,
  // because neither step continues on error. Skipped Release (no secrets, or
  // an earlier step failed) skips Merge too.
  assert.match(merge.if, /^always\(\) && steps\.release\.outcome != 'skipped'/)
  for (const step of [release, merge]) assert.equal(step["continue-on-error"], undefined, step.name)
  assert.doesNotMatch(JSON.stringify(steps), /GITHUB_TOKEN":"\$\{\{ (github\.token|secrets\.GITHUB_TOKEN)/, "never the job's own token")
})

test("no expression is interpolated into a script in the train files", () => {
  for (const file of TRAIN_FILES) {
    const doc = yaml(join(WORKFLOWS, file))
    for (const [id, job] of Object.entries(doc.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, `${file} ${id} "${step.name}": pass it through env:`)
      }
    }
  }
})

test("the Train callers listen for a finished Pipeline, a dispatch and a schedule — never a pull request", () => {
  for (const file of ["examples/train-caller.yaml", "train-self.yaml"]) {
    const doc = yaml(join(WORKFLOWS, file))
    assert.equal(doc.name, "Train", file)
    assert.deepEqual(Object.keys(doc.on).sort(), ["schedule", "workflow_dispatch", "workflow_run"], file)
    // A pull_request* trigger would run the pull request's copy of the file with the secrets.
    for (const trigger of Object.keys(doc.on)) assert.doesNotMatch(trigger, /^pull_request/, file)
    assert.deepEqual(doc.on.workflow_run, { workflows: ["Pipeline"], types: ["completed"] }, file)
    assert.deepEqual(doc.on.schedule, [{ cron: "*/30 * * * *" }], file)
    assert.deepEqual(Object.keys(doc.jobs), ["train"], file)
    const job = doc.jobs.train
    assert.equal(job.if, "vars.TRAIN != 'off'", `${file}: the kill switch sits on the job, so no runner starts`)
    assert.deepEqual(job.permissions, { contents: "read" }, file)
  }
  // The workflow the callers wait for is the one the Pipeline callers are named.
  for (const file of ["examples/caller.yaml", "ci.yaml"]) assert.equal(yaml(join(WORKFLOWS, file)).name, "Pipeline")
  assert.match(
    yaml(join(WORKFLOWS, "examples/train-caller.yaml")).jobs.train.uses,
    /^maxbec\/pipeline\/\.github\/workflows\/train\.yaml@__PIPELINE_SHA__$/,
  )
  assert.equal(yaml(join(WORKFLOWS, "train-self.yaml")).jobs.train.uses, "./.github/workflows/train.yaml")
})

test("the central sweep runs only here, on a timer or by hand, GitHub-hosted", () => {
  const doc = yaml(join(WORKFLOWS, "train-sweep.yaml"))
  assert.deepEqual(Object.keys(doc.on).sort(), ["schedule", "workflow_dispatch"])
  assert.deepEqual(doc.on.schedule, [{ cron: "*/30 * * * *" }])
  assert.deepEqual(doc.permissions, {})
  assert.deepEqual(Object.keys(doc.jobs), ["sweep"])
  const job = doc.jobs.sweep
  assert.equal(job.if, "github.repository == 'maxbec/pipeline' && vars.TRAIN != 'off'")
  assert.equal(job["runs-on"], "ubuntu-latest", "public repository: hosted, and free")
  assert.deepEqual(job.permissions, { contents: "read" })
  assert.equal(doc.concurrency["cancel-in-progress"], false)
  const run = job.steps.at(-1)
  assert.equal(run.run.trim(), "bash scripts/train-sweep.sh")
  assert.equal(run.env.GH_TOKEN, "${{ steps.app-token.outputs.token }}")
  assert.equal(run.env.SWEEP_SELF, "${{ github.repository }}")
  assert.ok(existsSync(join(ROOT, "scripts/train-sweep.sh")))
})

// ---- Fix -------------------------------------------------------------------

const FIX_JOBS = ["fix-triage", "fix-propose", "fix-commit"]
const fixJob = (id) => yaml(TRAIN).jobs[id]
const PIPELINE_CHECKOUT = {
  repository: "maxbec/pipeline",
  ref: "${{ job.workflow_sha }}",
  path: ".pipeline",
  "sparse-checkout": "train",
  "persist-credentials": false,
}

test("the Fix is three jobs with read-only tokens, named for what they do", () => {
  assert.deepEqual(
    FIX_JOBS.map((id) => fixJob(id).name),
    ["Fix (triage)", "Fix (propose)", "Fix (commit)"],
  )
  for (const id of FIX_JOBS) {
    const job = fixJob(id)
    assert.deepEqual(job.permissions, { contents: "read" }, id)
    assert.ok(job["timeout-minutes"] <= 20, `${id} has a time limit`)
  }
  assert.equal(fixJob("fix-propose")["timeout-minutes"], 20)
})

test("the Fix starts only on a pull request's Pipeline run that concluded failure", () => {
  const cond = String(fixJob("fix-triage").if).replace(/\s+/g, " ")
  assert.equal(
    cond,
    "github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.event == 'pull_request'",
  )
  // The other two hang on triage's verdict, which only that condition produces.
  const propose = fixJob("fix-propose")
  assert.deepEqual([].concat(propose.needs), ["fix-triage"])
  assert.equal(propose.if, "needs.fix-triage.outputs.action == 'propose'")
  const commit = fixJob("fix-commit")
  assert.deepEqual(commit.needs, ["fix-triage", "fix-propose"])
  assert.equal(commit.if, "always() && needs.fix-triage.outputs.action == 'propose'", "it reports even when propose failed")
  assert.deepEqual(fixJob("fix-triage").outputs, {
    action: "${{ steps.triage.outputs.action }}",
    pr: "${{ steps.triage.outputs.pr }}",
    head_sha: "${{ steps.triage.outputs.head_sha }}",
    attempt: "${{ steps.triage.outputs.attempt }}",
  })
})

test("triage and commit run where the train runs; propose always on a fresh hosted VM", () => {
  const train = yaml(TRAIN).jobs.train["runs-on"]
  assert.equal(fixJob("fix-triage")["runs-on"], train)
  assert.equal(fixJob("fix-commit")["runs-on"], train)
  assert.equal(fixJob("fix-propose")["runs-on"], "ubuntu-latest")
})

test("triage and commit follow the train's pattern: ready gate, scoped App token, the train's code, Node", () => {
  const [trainReady] = trainSteps()
  const trainMint = usesStep(trainSteps(), "actions/create-github-app-token")[0]
  const scopes = {
    "fix-triage": { "permission-actions": "write", "permission-pull-requests": "write", "permission-issues": "write" },
    "fix-commit": { "permission-contents": "write", "permission-pull-requests": "write", "permission-issues": "write" },
  }
  for (const [id, permissions] of Object.entries(scopes)) {
    const steps = fixJob(id).steps
    assert.deepEqual(steps[0], trainReady, `${id}: the same gate as the train`)
    for (const step of steps.slice(1)) {
      // The upload hangs on triage's output, which exists only past the gate.
      if (step.if === "steps.triage.outputs.action == 'propose'") continue
      assert.equal(step.if, READY, `${id} "${step.name}" is skipped without the App secrets`)
    }
    const [mint, ...more] = usesStep(steps, "actions/create-github-app-token")
    assert.ok(mint && more.length === 0, `${id}: exactly one App-token step`)
    assert.equal(mint.uses, trainMint.uses, "one pin")
    assert.deepEqual(mint.with, { ...trainMint.with, ...permissions }, `${id}: the token is scoped`)
    const checkouts = usesStep(steps, "actions/checkout")
    assert.equal(checkouts.length, 1, `${id}: the train's code and nothing else is checked out`)
    assert.deepEqual(checkouts[0].with, PIPELINE_CHECKOUT)
    assert.equal(usesStep(steps, "actions/setup-node").length, 1, id)
  }
})

test("triage hands the run to the entry and uploads its input only for a proposal", () => {
  const steps = fixJob("fix-triage").steps
  const triage = steps.find((s) => s.id === "triage")
  assert.equal(triage.run.trim(), "node .pipeline/train/bin/fix.ts triage")
  assert.deepEqual(triage.env, {
    GITHUB_TOKEN: "${{ steps.app-token.outputs.token }}",
    RUN_ID: "${{ github.event.workflow_run.id }}",
    // The comparison's result, not the secret.
    CLAUDE_AVAILABLE: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}",
    FIX_INPUT_DIR: "${{ runner.temp }}/fix-input",
  })
  const [upload] = usesStep(steps, "actions/upload-artifact")
  assert.equal(upload.if, "steps.triage.outputs.action == 'propose'")
  assert.equal(upload.with.name, "fix-input")
  assert.equal(upload.with.path, triage.env.FIX_INPUT_DIR)
})

test("the propose job never holds a token that can write", () => {
  const job = fixJob("fix-propose")
  const text = JSON.stringify(job)
  assert.doesNotMatch(text, /TRAIN_APP|steps\.app-token|create-github-app-token|GITHUB_TOKEN|github\.token/)
  for (const step of usesStep(job.steps, "actions/checkout")) {
    assert.equal(step.with["persist-credentials"], false, step.name)
    assert.equal(step.with.token, undefined, step.name)
  }
})

test("the propose job executes nothing from the pull request", () => {
  const steps = fixJob("fix-propose").steps
  const index = (pred) => steps.findIndex(pred)
  const tree = index((s) => String(s.uses ?? "").startsWith("actions/checkout@") && !s.with.repository)
  assert.equal(steps[tree].with.ref, "${{ needs.fix-triage.outputs.head_sha }}", "the head triage decided on")

  // The one package-manager call installs the pinned CLI, before the tree exists and away from it.
  const managers = steps.filter((s) => /\b(npm|pnpm|yarn|bun|npx|pip|uv|make)\b/.test(s.run ?? ""))
  assert.deepEqual(managers.map((s) => s.id), ["install"])
  const install = managers[0]
  assert.ok(index((s) => s.id === "install") < tree, "installed before the checkout")
  assert.equal(install["working-directory"], "${{ runner.temp }}")
  assert.match(install.env.CLAUDE_CODE_VERSION, /^\d+\.\d+\.\d+$/, "an exact version")
  assert.match(install.run, /npm install --global --registry=https:\/\/registry\.npmjs\.org\/ "@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}"/)
  for (const step of steps) {
    assert.doesNotMatch(step.run ?? "", /\b(install|ci|test|run|exec|build)\b(?! --global)/, `"${step.name}" runs a package script`)
  }

  // The train's code is checked out after Claude Code ran, into a path emptied first.
  const claude = index((s) => s.id === "claude")
  const clear = index((s) => (s.run ?? "").trim() === "rm -rf -- .pipeline")
  const pipeline = index((s) => String(s.uses ?? "").startsWith("actions/checkout@") && s.with.repository)
  const collect = index((s) => s.id === "collect")
  assert.ok(tree < claude && claude < clear && clear < pipeline && pipeline < collect, "order")
  assert.deepEqual(steps[pipeline].with, PIPELINE_CHECKOUT)
  assert.equal(steps[collect].run.trim(), 'node .pipeline/train/bin/fix.ts collect "$RUNNER_TEMP/claude-output.json"')
  assert.deepEqual(steps[collect].env, {
    BASE_SHA: "${{ needs.fix-triage.outputs.head_sha }}",
    FIX_OUTPUT_DIR: "${{ runner.temp }}/fix-output",
  })
  // Nothing the job adds lands in the tree it compares.
  for (const step of steps) {
    if (/(upload|download)-artifact@/.test(step.uses ?? "")) assert.match(step.with.path, /^\$\{\{ runner\.temp \}\}\//)
  }
})

test("Claude Code runs headless with four tools, no prompt, a turn cap, and the token in that step alone", () => {
  const doc = yaml(TRAIN)
  const all = Object.values(doc.jobs).flatMap((j) => j.steps)
  const holders = all.filter((s) => Object.keys(s.env ?? {}).includes("CLAUDE_CODE_OAUTH_TOKEN"))
  assert.equal(holders.length, 1, "exactly one step has the token in its environment")
  const step = holders[0]
  assert.equal(step.id, "claude")
  assert.ok(
    fixJob("fix-propose").steps.some((s) => s.id === "claude" && "CLAUDE_CODE_OAUTH_TOKEN" in (s.env ?? {})),
    "and that step is in the propose job",
  )
  // Beyond that step the secret is only ever compared with the empty string.
  const mentions = all.flatMap((s) => Object.values({ ...s.env, ...s.with })).filter((v) => String(v).includes("CLAUDE_CODE_OAUTH_TOKEN"))
  assert.deepEqual(mentions.sort(), ["${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}", "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"])

  assert.equal(step.env.ANTHROPIC_API_KEY, "", "a key would win over the subscription token")
  assert.equal(step.env.ANTHROPIC_AUTH_TOKEN, "")
  assert.equal(step["continue-on-error"], true, "a failed run is a diagnosis, not a red job")
  const cmd = step.run.replace(/\\\n\s*/g, " ")
  assert.match(cmd, /timeout 15m claude -p "[^"$]+" /, "print mode, a fixed prompt")
  assert.doesNotMatch(cmd, /--bare|--dangerously-skip-permissions|bypassPermissions|acceptEdits|--add-dir|--mcp-config/)
  for (const flag of [
    "--safe-mode",
    "--setting-sources user",
    '--settings "$RUNNER_TEMP/claude-settings.json"',
    '--tools "Read,Edit,Glob,Grep"',
    '--allowedTools "Edit(/**)"',
    '--disallowedTools "mcp__*"',
    "--permission-mode dontAsk",
    "--max-turns 30",
    "--no-session-persistence",
    "--output-format json",
    '< "$RUNNER_TEMP/fix-input/prompt.txt"',
    '> "$RUNNER_TEMP/claude-output.json"',
  ]) {
    assert.ok(cmd.includes(` ${flag}`), `missing: ${flag}`)
  }
})

test("Claude Code's settings confine the file tools to the checkout and deny everything else", () => {
  const dir = scratch()
  const home = join(dir, "home")
  mkdirSync(home)
  const r = runStep(
    "fix-propose",
    "claude-settings",
    { HOME: home, RUNNER_TEMP: dir, GITHUB_WORKSPACE: "/home/runner/work/widgets/widgets" },
    TRAIN,
  )
  assert.equal(r.status, 0, r.stderr)
  const text = readFileSync(join(dir, "claude-settings.json"), "utf8")
  assert.equal(readFileSync(join(home, ".claude/settings.json"), "utf8"), text, "also the user settings, the one source the run loads")
  const settings = JSON.parse(text)
  assert.equal(settings.disableAllHooks, true)
  const p = settings.permissions
  assert.equal(p.defaultMode, "dontAsk")
  assert.equal(p.blockReadsOutsideWorkingDirectories, true)
  assert.equal(p.blockWritesOutsideWorkingDirectories, true)
  assert.deepEqual(p.allow, ["Edit(//home/runner/work/widgets/widgets/**)"], "no Bash, no bare Read or Edit")
  for (const rule of [
    "Bash",
    "WebFetch",
    "WebSearch",
    "mcp__*",
    "Read(//proc/**)",
    "Read(//etc/**)",
    "Read(//tmp/**)",
    `Read(/${dir}/**)`,
    "Read(~/.claude/**)",
    "Read(~/.config/**)",
    "Read(~/.ssh/**)",
    "Edit(//home/runner/work/widgets/widgets/.git/**)",
    "Edit(//home/runner/work/widgets/widgets/.github/**)",
  ]) {
    assert.ok(p.deny.includes(rule), `not denied: ${rule}`)
  }
})

test("the commit job never checks the repository out and reports even without a proposal", () => {
  const steps = fixJob("fix-commit").steps
  for (const step of usesStep(steps, "actions/checkout")) {
    assert.equal(step.with.repository, "maxbec/pipeline", "only the train's code")
  }
  assert.doesNotMatch(JSON.stringify(steps), /\bgit (clone|fetch|checkout|pull)\b|CLAUDE/)
  const [download] = usesStep(steps, "actions/download-artifact")
  assert.equal(download.with.name, "fix-output")
  assert.equal(download["continue-on-error"], true, "a missing artifact is a failed propose job, not a failed commit job")
  const commit = steps.find((s) => s.id === "commit")
  assert.equal(commit.run.trim(), "node .pipeline/train/bin/fix.ts commit")
  assert.deepEqual(commit.env, {
    GITHUB_TOKEN: "${{ steps.app-token.outputs.token }}",
    PR: "${{ needs.fix-triage.outputs.pr }}",
    HEAD_SHA: "${{ needs.fix-triage.outputs.head_sha }}",
    ATTEMPT: "${{ needs.fix-triage.outputs.attempt }}",
    FIX_OUTPUT_DIR: download.with.path,
  })
  // What propose uploads is what commit downloads.
  const upload = usesStep(fixJob("fix-propose").steps, "actions/upload-artifact")[0]
  assert.equal(upload.with.name, "fix-output")
  assert.equal(upload.with.path, download.with.path)
  assert.equal(upload.if, "always()")
})
