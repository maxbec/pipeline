import assert from "node:assert/strict"
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
  assert.deepEqual(doc.on.schedule, [{ cron: "*/30 * * * *" }])
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
