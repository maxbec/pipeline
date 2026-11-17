import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"
import { ROOT, runStep, yaml } from "./helpers.mjs"

const TRUNK_UPGRADE = join(ROOT, ".github/workflows/trunk-upgrade.yaml")
const CALLER = join(ROOT, ".github/workflows/trunk-upgrade-scheduled.yaml")

const steps = () => yaml(TRUNK_UPGRADE).jobs.upgrade.steps
const resolve = (env) => runStep("upgrade", "token", env, TRUNK_UPGRADE)

test("an App token that cannot be created does not end the run", () => {
  const all = steps()
  const mint = all.find((s) => s.id === "app-token")
  assert.match(String(mint.uses), /^actions\/create-github-app-token@[0-9a-f]{40}$/)
  assert.equal(mint.if, "steps.check-app.outputs.available == 'true'", "only where both secrets are set")
  // A deleted App answers "Integration not found", one that is no longer
  // installed "Not Found". Neither is a reason for a red weekly run.
  assert.equal(mint["continue-on-error"], true)
  const token = all.find((s) => s.id === "token")
  assert.ok(all.indexOf(mint) < all.indexOf(token), "the token is resolved after the attempt")
  assert.equal(token.env.APP_CONFIGURED, "${{ steps.check-app.outputs.available }}")
  assert.equal(token.env.APP_TOKEN, "${{ steps.app-token.outputs.token }}")
})

test("with an App token the run uses it", () => {
  const res = resolve({ APP_TOKEN: "app-token", APP_CONFIGURED: "true", FALLBACK: "job-token" })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(res.outputs, { value: "app-token", using: "app" })
  assert.doesNotMatch(res.stdout, /::(warning|notice)::/)
})

test("secrets of an App that is gone fall back to GITHUB_TOKEN with a warning", () => {
  const res = resolve({ APP_TOKEN: "", APP_CONFIGURED: "true", FALLBACK: "job-token" })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(res.outputs, { value: "job-token", using: "github-token" })
  assert.match(res.stdout, /^::warning::/m)
  assert.match(res.stdout, /WORKFLOW_APP_ID/)
  assert.match(res.stdout, /deleted or is not installed/)
  assert.doesNotMatch(res.stdout, /job-token/, "the token is never printed")
})

test("without the secrets the fallback is a notice, as it was", () => {
  const res = resolve({ APP_TOKEN: "", APP_CONFIGURED: "false", FALLBACK: "job-token" })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(res.outputs, { value: "job-token", using: "github-token" })
  assert.match(res.stdout, /^::notice::WORKFLOW_APP_ID not set/m)
  assert.doesNotMatch(res.stdout, /::warning::/)
})

test("auto-merge is armed only for a pull request the App opened", () => {
  const arm = steps().find((s) => s.name === "Enable auto-merge")
  assert.match(String(arm.if), /steps\.token\.outputs\.using == 'app'/)
})

test("this repository's weekly run calls the Trunk Upgrade of its own tree", () => {
  // A tag such as @v3 would run a version from before the fix, for good.
  const job = yaml(CALLER).jobs.upgrade
  assert.equal(job.uses, "./.github/workflows/trunk-upgrade.yaml")
  assert.equal(job.secrets, "inherit")
  assert.deepEqual(job.permissions, { contents: "write", "pull-requests": "write" })
})
