import assert from "node:assert/strict"
import { test } from "node:test"
import { parseReleaseConfig } from "../src/config.ts"

const DEFAULTS = { versionFiles: ["package.json"], changelogShowHidden: false, releaseAs: null }

test("no release block is the defaults", () => {
  for (const json of [undefined, "", "  ", "null", "{}"]) {
    assert.deepEqual(parseReleaseConfig(json, []), DEFAULTS, JSON.stringify(json))
  }
})

test("every key is read", () => {
  const json = JSON.stringify({
    version_files: ["package.json", "packages/*/package.json"],
    changelog_show_hidden: true,
    release_as: "2.0.0",
  })
  assert.deepEqual(parseReleaseConfig(json, ["v1.4.0", "v1.5.0-beta.2"]), {
    versionFiles: ["package.json", "packages/*/package.json"],
    changelogShowHidden: true,
    releaseAs: "2.0.0",
  })
})

test("an empty version_files list is kept: a repository that writes its version nowhere", () => {
  assert.deepEqual(parseReleaseConfig('{"version_files":[]}', []).versionFiles, [])
})

test("an explicit false is not the default's doing", () => {
  assert.equal(parseReleaseConfig('{"changelog_show_hidden":false}', []).changelogShowHidden, false)
})

test("release_as is ignored once a tag at or above it exists", () => {
  const json = '{"release_as":"2.0.0"}'
  assert.equal(
    parseReleaseConfig(json, ["v1.9.0", "v2.0.0-beta.3"]).releaseAs,
    "2.0.0",
    "its own betas are below it",
  )
  assert.equal(parseReleaseConfig(json, ["v2.0.0"]).releaseAs, null, "the tag itself")
  assert.equal(
    parseReleaseConfig(json, ["v1.0.0", "v2.1.0-beta.1"]).releaseAs,
    null,
    "a tag above it",
  )
  assert.equal(parseReleaseConfig(json, ["2.0.0"]).releaseAs, null, "a tag without the v")
  assert.equal(
    parseReleaseConfig(json, ["nightly", "v2"]).releaseAs,
    "2.0.0",
    "tags that are no versions do not count",
  )
  const beta = '{"release_as":"2.0.0-beta.1"}'
  assert.equal(parseReleaseConfig(beta, ["v2.0.0-beta.1"]).releaseAs, null)
})

test("an unknown key is an error that names it", () => {
  assert.throws(() => parseReleaseConfig('{"versionFiles":["a"]}', []), /versionFiles/)
})

test("a wrong type is an error that names the key", () => {
  assert.throws(() => parseReleaseConfig('{"version_files":"package.json"}', []), /version_files/)
  assert.throws(() => parseReleaseConfig('{"version_files":["a",1]}', []), /version_files/)
  assert.throws(
    () => parseReleaseConfig('{"changelog_show_hidden":"yes"}', []),
    /changelog_show_hidden/,
  )
  // yq turns an unquoted `2.0` into a number: say so instead of releasing as "2".
  assert.throws(() => parseReleaseConfig('{"release_as":2}', []), /release_as/)
  assert.throws(() => parseReleaseConfig('{"release_as":"next"}', []), /release_as/)
})

test("a release block that is not a mapping, or not JSON, is an error", () => {
  assert.throws(() => parseReleaseConfig('["package.json"]', []), /release/)
  assert.throws(() => parseReleaseConfig("true", []), /release/)
  assert.throws(() => parseReleaseConfig("{version_files", []), /TRAIN_RELEASE_CONFIG/)
})

test("a null value is the default of its key", () => {
  assert.deepEqual(
    parseReleaseConfig('{"version_files":null,"changelog_show_hidden":null,"release_as":null}', []),
    DEFAULTS,
  )
})
