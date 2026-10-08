import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ROOT, WORKFLOW, yaml } from "./helpers.mjs"

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
