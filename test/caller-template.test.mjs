import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ROOT } from "./helpers.mjs"

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
