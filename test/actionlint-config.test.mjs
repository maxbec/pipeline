import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ROOT, yaml } from "./helpers.mjs"

// The weekly maintenance run lints the workflows with actionlint and failed
// for four weeks in a row (2026-10-26 to 2026-11-16) without anyone noticing:
// 21 shellcheck findings in the maintenance workflow itself, `ubuntu-slim`
// unknown to the pinned 1.7.7, and `job.workflow_sha` unknown to every release.

const WORKFLOWS = join(ROOT, ".github/workflows")
const MAINTENANCE = join(WORKFLOWS, "nightly-maintenance.yaml")
const config = yaml(join(ROOT, ".github/actionlint.yaml"))

test("actionlint's config ignores the one message no release can get right, and nothing else", () => {
  assert.deepEqual(Object.keys(config), ["paths"])
  assert.deepEqual(config.paths, {
    ".github/workflows/**/*.yaml": {
      ignore: ['property "workflow_sha" is not defined in object type'],
    },
  })
})

test("the ignored message still has a cause: a workflow reads job.workflow_sha", () => {
  // Without one the entry is dead weight that would hide a real typo later.
  const users = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yaml"))
    .filter((f) => /\$\{\{\s*job\.workflow_sha\s*\}\}/.test(readFileSync(join(WORKFLOWS, f), "utf8")))
  assert.deepEqual(users.sort(), ["train.yaml", "universal-pipeline.yaml"])
})

test("the maintenance run installs a pinned actionlint and verifies its checksum", () => {
  const steps = yaml(MAINTENANCE).jobs["lint-workflows"].steps
  const install = steps.find((s) => s.name === "Install actionlint").run
  assert.match(install, /^\s*ACTIONLINT_VERSION="\d+\.\d+\.\d+"$/m)
  assert.match(install, /^\s*ACTIONLINT_SHA256="[0-9a-f]{64}"$/m)
  const verify = install.indexOf("sha256sum --check --strict")
  assert.ok(verify > 0, "the download is checked against the pinned checksum")
  assert.ok(verify < install.indexOf("tar xzf"), "and before anything is unpacked")
})

test("the maintenance run fails when actionlint reports a finding", () => {
  const steps = yaml(MAINTENANCE).jobs["lint-workflows"].steps
  const run = steps.find((s) => s.name === "Run actionlint").run
  // The summary call may swallow the exit code; the last call must not.
  const calls = run.split("\n").filter((l) => /\bactionlint\b/.test(l) && !l.trim().startsWith("#"))
  assert.match(calls.at(-1), /^\s*actionlint -color\s*$/)
})

test("every workflow passes actionlint, where actionlint is installed", (t) => {
  // Not on the hosted runner's image, so this runs on a developer's machine;
  // the weekly run is the gate. With shellcheck on PATH actionlint also lints
  // the `run:` blocks, as it does in the weekly run.
  const probe = spawnSync("actionlint", ["-version"], { encoding: "utf8" })
  if (probe.error || probe.status !== 0) return t.skip("actionlint is not on PATH")
  const r = spawnSync("actionlint", ["-oneline"], { cwd: ROOT, encoding: "utf8" })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
