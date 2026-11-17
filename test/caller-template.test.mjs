import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ROOT, scratch, WORKFLOW, yaml } from "./helpers.mjs"

const template = readFileSync(join(ROOT, ".github/workflows/examples/caller.yaml"), "utf8")

test("the rendered caller stays within yamllint's 120 characters, even with a prerelease tag", () => {
  // The first fleet run failed `Lint (trunk)` on every trunk repository: the
  // `uses:` line with a 40-char sha and ` # v5.0.0-beta.1` was 124 characters.
  const rendered = template
    .replaceAll("__PIPELINE_SHA__", "a".repeat(40))
    .replaceAll("__PIPELINE_VERSION__", "v5.0.0-beta.12")
  for (const line of rendered.split("\n")) assert.ok(line.length <= 120, `${line.length} chars: ${line}`)
  const uses = rendered.split("\n").find((l) => /^\s*uses: maxbec\/pipeline\//.test(l))
  assert.match(uses, /@a{40}$/, "the uses line ends with the sha; the tag sits in a comment above it")
  const idx = rendered.split("\n").indexOf(uses)
  assert.match(rendered.split("\n")[idx - 1], /^\s*# v5\.0\.0-beta\.12$/)
})

// yamllint's `quoted-strings: required: only-when-needed`, which the navigaite
// Trunk plugin sets: a value in quotes that reads the same without them is an
// error. The v5.6.0 pin failed `Lint (trunk)` in four navigaite repositories on
// `- cron: '17 */6 * * *'` — the cron it replaced began with `*`, which needs
// the quotes; this one does not.
test("a caller quotes a value only where YAML needs the quotes", () => {
  for (const file of ["caller.yaml", "train-caller.yaml"]) {
    const lines = readFileSync(join(ROOT, ".github/workflows/examples", file), "utf8").split("\n")
    for (const [i, line] of lines.entries()) {
      const quoted = line.match(/^\s*(?:- )?(?:[\w-]+: )?(['"])(.*)\1\s*$/)
      if (!quoted || /^\s*#/.test(line)) continue
      const plain = spawnSync("yq", ["-o=json", "."], { input: `v: ${quoted[2]}\n`, encoding: "utf8" })
      const same = plain.status === 0 && JSON.parse(plain.stdout).v === quoted[2]
      assert.ok(!same, `${file}:${i + 1} quotes a value that needs none: ${line.trim()}`)
    }
  }
})

test("the caller grants every permission a pipeline job asks for", () => {
  // A called job that asks for more than its caller granted fails the whole
  // run at startup, with nothing in the log — the Guard's `actions: read` for
  // the Release PR reuse is the case this was written for.
  const rank = { none: 0, read: 1, write: 2 }
  const granted = yaml(join(ROOT, ".github/workflows/examples/caller.yaml")).jobs.pipeline.permissions
  for (const [name, job] of Object.entries(yaml(WORKFLOW).jobs)) {
    for (const [scope, level] of Object.entries(job.permissions ?? {})) {
      assert.ok(
        (rank[granted[scope]] ?? 0) >= rank[level],
        `job ${name} asks for ${scope}: ${level}, the caller grants ${granted[scope] ?? "nothing"}`,
      )
    }
  }
})

test("the Pipeline caller also runs when a draft is lifted", () => {
  // The train hears about a pull request only through a finished Pipeline run.
  // Without ready_for_review, lifting a draft would start nothing; Guard's
  // same-tree reuse makes the extra run cheap. The first three are the default.
  for (const file of ["examples/caller.yaml", "ci.yaml"]) {
    const doc = yaml(join(ROOT, ".github/workflows", file))
    assert.deepEqual(doc.on.pull_request.types, ["opened", "synchronize", "reopened", "ready_for_review"], file)
    assert.deepEqual(doc.on.pull_request.branches, ["dev", "main"], file)
  }
})

const trainTemplateFile = join(ROOT, ".github/workflows/examples/train-caller.yaml")
const TRAIN = join(ROOT, ".github/workflows/train.yaml")

test("the rendered Train caller stays within 120 characters and pins like the Pipeline caller", () => {
  const rendered = readFileSync(trainTemplateFile, "utf8")
    .replaceAll("__PIPELINE_SHA__", "a".repeat(40))
    .replaceAll("__PIPELINE_VERSION__", "v5.0.0-beta.12")
  const lines = rendered.split("\n")
  for (const line of lines) assert.ok(line.length <= 120, `${line.length} chars: ${line}`)
  const idx = lines.findIndex((l) => /^\s*uses: maxbec\/pipeline\//.test(l))
  assert.match(lines[idx], /^\s*uses: maxbec\/pipeline\/\.github\/workflows\/train\.yaml@a{40}$/)
  assert.match(lines[idx - 1], /^\s*# v5\.0\.0-beta\.12$/)
})

test("the Train caller's schedule sits between two markers and can be cut out", () => {
  const text = readFileSync(trainTemplateFile, "utf8")
  const doc = yaml(trainTemplateFile)
  // The safety net for what no event reports. Every 30 minutes was 48 billed
  // runs a day in each repository, for a net that a finished Pipeline run and
  // a manual dispatch already hold.
  assert.deepEqual(doc.on.schedule, [{ cron: "17 */6 * * *" }])
  const lines = text.split("\n")
  const begin = lines.findIndex((l) => l.trim() === "# __TRAIN_SCHEDULE_BEGIN__")
  const end = lines.findIndex((l) => l.trim() === "# __TRAIN_SCHEDULE_END__")
  assert.ok(begin > 0 && end > begin, "both markers, each on a line of its own, in order")
  assert.equal(text.match(/__TRAIN_SCHEDULE_/g).length, 2, "the markers appear nowhere else")
  // What the renderer does for a repository the central sweep covers.
  const dir = scratch()
  const cut = join(dir, "train.yaml")
  writeFileSync(cut, [...lines.slice(0, begin), ...lines.slice(end + 1)].join("\n"))
  const without = yaml(cut)
  assert.deepEqual(Object.keys(without.on), ["workflow_run", "workflow_dispatch"])
  assert.deepEqual(without.jobs, doc.jobs, "nothing but the schedule goes")
})

test("the Train caller grants every permission the train job asks for, and forwards every secret by name", () => {
  const rank = { none: 0, read: 1, write: 2 }
  const train = yaml(TRAIN)
  for (const file of ["examples/train-caller.yaml", "train-self.yaml"]) {
    const job = yaml(join(ROOT, ".github/workflows", file)).jobs.train
    for (const [name, called] of Object.entries(train.jobs)) {
      for (const [scope, level] of Object.entries(called.permissions ?? {})) {
        assert.ok(
          (rank[job.permissions[scope]] ?? 0) >= rank[level],
          `${file}: job ${name} asks for ${scope}: ${level}, the caller grants ${job.permissions[scope] ?? "nothing"}`,
        )
      }
    }
    // `secrets: inherit` drops organization secrets across the owner boundary.
    assert.equal(typeof job.secrets, "object", `${file}: secrets are a map, not inherit`)
    const declared = Object.keys(train.on.workflow_call.secrets)
    assert.deepEqual(Object.keys(job.secrets), declared, `${file}: exactly the declared secrets`)
    for (const s of declared) assert.equal(job.secrets[s], `\${{ secrets.${s} }}`, `${file}: ${s}`)
  }
})

test("the train caller template has no empty mapping value", () => {
  // yamllint's empty-values rule, on in several repositories, fails the
  // rendered caller on a bare `workflow_dispatch:`.
  const text = readFileSync(new URL("../.github/workflows/examples/train-caller.yaml", import.meta.url), "utf8")
  const bare = text.split("\n").filter((line) => /^\s*[\w-]+:\s*$/.test(line) && /^\s*workflow_dispatch:/.test(line))
  assert.deepEqual(bare, [])
})

// ---- the full Check: on demand everywhere, nightly where there is a fast one --

const callerFile = join(ROOT, ".github/workflows/examples/caller.yaml")
const CONCURRENCY = {
  group: "pipeline-${{ github.event_name }}-${{ github.ref }}",
  "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
}

test("both Pipeline callers can be dispatched and grant actions: write", () => {
  // `gh workflow run ci.yaml --ref dev` is how a full Check is asked for, and a
  // green full run re-runs the Check of the Release PR that waited for it.
  for (const file of ["examples/caller.yaml", "ci.yaml"]) {
    const doc = yaml(join(ROOT, ".github/workflows", file))
    assert.deepEqual(doc.on.workflow_dispatch, {}, `${file}: an explicit empty mapping, for yamllint's empty-values`)
    assert.equal(doc.jobs.pipeline.permissions.actions, "write", file)
    assert.deepEqual(doc.concurrency, CONCURRENCY, `${file}: the concurrency group stays as it was`)
    assert.deepEqual(doc.on.push, { branches: ["dev", "main"] }, file)
    assert.deepEqual(doc.on.release, { types: ["published"] }, file)
  }
})

test("the Pipeline caller's nightly sits between two markers and can be cut out", () => {
  const text = readFileSync(callerFile, "utf8")
  const doc = yaml(callerFile)
  assert.deepEqual(doc.on.schedule, [{ cron: "23 2 * * *" }])
  const lines = text.split("\n")
  const begin = lines.findIndex((l) => l.trim() === "# __NIGHTLY_BEGIN__")
  const end = lines.findIndex((l) => l.trim() === "# __NIGHTLY_END__")
  assert.ok(begin > 0 && end > begin, "both markers, each on a line of its own, in order")
  assert.equal(text.match(/__NIGHTLY_/g).length, 2, "the markers appear nowhere else")
  // What the renderer does for a repository without test.pr_command.
  const dir = scratch()
  const cut = join(dir, "ci.yaml")
  writeFileSync(cut, [...lines.slice(0, begin), ...lines.slice(end + 1)].join("\n"))
  const without = yaml(cut)
  assert.deepEqual(Object.keys(without.on), ["pull_request", "push", "release", "workflow_dispatch"])
  assert.deepEqual(without.jobs, doc.jobs, "nothing but the schedule goes")
  assert.deepEqual(without.concurrency, doc.concurrency)
})

test("this repository's own caller has the nightly exactly when its pipeline.yaml sets test.pr_command", () => {
  const fast = String(yaml(join(ROOT, ".github/pipeline.yaml")).test?.pr_command ?? "").trim() !== ""
  const ci = yaml(join(ROOT, ".github/workflows/ci.yaml"))
  if (fast) assert.deepEqual(ci.on.schedule, [{ cron: "23 2 * * *" }])
  else assert.equal(ci.on.schedule, undefined, "no fast Check here, so every run is the full one already")
})

test("this repository's own Train caller sweeps four times a day; the central sweep keeps its half hour", () => {
  assert.deepEqual(yaml(join(ROOT, ".github/workflows/train-self.yaml")).on.schedule, [{ cron: "17 */6 * * *" }])
  // train-sweep.yaml runs in this public repository only, where minutes are free.
  assert.deepEqual(yaml(join(ROOT, ".github/workflows/train-sweep.yaml")).on.schedule, [{ cron: "*/30 * * * *" }])
})
