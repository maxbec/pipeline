import assert from "node:assert/strict"
import { test } from "node:test"
import { runStep } from "./helpers.mjs"

const meta = (env) =>
  runStep("deploy", "meta", {
    REPO: "edilio-app/Edilio",
    IMAGE_SUFFIX: "default",
    IMAGE_NAME_OVERRIDE: "",
    VERSION: "1.2.3",
    PRERELEASE: "false",
    EXTRA_BUILD_ARGS: "",
    ...env,
  })

test("the default image is the lowercased repository, a stable release also tags latest", () => {
  const r = meta({})
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.outputs["image-name"], "edilio-app/edilio")
  assert.equal(r.outputs["image-tag"], "1.2.3")
  assert.equal(r.outputs["version-tag"], "latest")
  assert.match(r.outputs["build-args"], /APP_VERSION=1\.2\.3/)
})

test("a named image gets the repository suffix and a prerelease tags dev, never latest", () => {
  const r = meta({ IMAGE_SUFFIX: "cron", VERSION: "1.3.0-beta.2", PRERELEASE: "true" })
  assert.equal(r.outputs["image-name"], "edilio-app/edilio-cron")
  assert.equal(r.outputs["image-tag"], "1.3.0-beta.2")
  assert.equal(r.outputs["version-tag"], "dev")
})

test("an explicit image name wins and extra build args are appended", () => {
  const r = meta({ IMAGE_NAME_OVERRIDE: "maxbec/platzl", EXTRA_BUILD_ARGS: "NODE_ENV=production" })
  assert.equal(r.outputs["image-name"], "maxbec/platzl")
  assert.match(r.outputs["build-args"], /NODE_ENV=production/)
})
