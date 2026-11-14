import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { untaggedRefusal } from "../../src/provisioning/cli.ts"
import { renderCaller } from "../../src/provisioning/migrate.ts"
import { latestPipelineTag, resolvePipelinePin } from "../../src/provisioning/pin.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { git } from "../workflow/fake-github.ts"

/** A pipeline clone: v5.4.0 and v5.4.1 stable, v5.5.0-beta.1 after them, one untagged commit on top. */
function clone(): { dir: string; sha: Record<string, string> } {
  const dir = scratchDir("train-pin-")
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "Test")
  git(dir, "config", "commit.gpgsign", "false")
  git(dir, "config", "tag.gpgsign", "false")
  const sha: Record<string, string> = {}
  const commit = (name: string, tag?: string) => {
    writeFileSync(join(dir, "file"), name)
    git(dir, "add", "file")
    git(dir, "commit", "-q", "-m", name)
    if (tag) git(dir, "tag", tag)
    sha[name] = git(dir, "rev-parse", "HEAD")
  }
  commit("a", "v5.4.0")
  commit("b", "v5.4.1")
  commit("c", "v5.5.0-beta.1")
  commit("d")
  return { dir, sha }
}

test("the default pin is the newest stable tag; a prerelease does not count", async () => {
  const { dir, sha } = clone()
  assert.equal(await latestPipelineTag(dir), "5.4.1")
  assert.deepEqual(await resolvePipelinePin(dir, undefined), { sha: sha.b, version: "5.4.1" })
})

test("a prerelease tag given as the ref is a tagged pin, rendered with its version", async () => {
  const { dir, sha } = clone()
  const pin = await resolvePipelinePin(dir, "v5.5.0-beta.1")
  assert.deepEqual(pin, { sha: sha.c, version: "5.5.0-beta.1" })
  assert.equal(untaggedRefusal({ apply: true, allowUntagged: false }, pin), null, "accepted on --apply")
  const rendered = renderCaller(
    "jobs:\n  pipeline:\n    # __PIPELINE_VERSION__\n    uses: maxbec/pipeline/.github/workflows/universal-pipeline.yaml@__PIPELINE_SHA__\n",
    pin,
    {},
  )
  assert.ok(rendered.includes(`    # v5.5.0-beta.1\n    uses: maxbec/pipeline/.github/workflows/universal-pipeline.yaml@${sha.c}\n`))
  // The same commit by its sha resolves to the same version.
  assert.deepEqual(await resolvePipelinePin(dir, sha.c), pin)
})

test("a commit with a stable and a prerelease tag shows the tag that was asked for", async () => {
  const { dir, sha } = clone()
  git(dir, "tag", "v5.5.0", "v5.5.0-beta.1")
  assert.equal((await resolvePipelinePin(dir, "v5.5.0-beta.1")).version, "5.5.0-beta.1")
  assert.equal((await resolvePipelinePin(dir, "v5.5.0")).version, "5.5.0")
  assert.equal((await resolvePipelinePin(dir, sha.c)).version, "5.5.0", "by sha, the stable one")
})

test("an untagged sha resolves without a version and is refused on --apply unless allowed", async () => {
  const { dir, sha } = clone()
  const pin = await resolvePipelinePin(dir, sha.d)
  assert.deepEqual(pin, { sha: sha.d, version: null })
  assert.match(untaggedRefusal({ apply: true, allowUntagged: false }, pin) ?? "", /untagged/)
  assert.equal(untaggedRefusal({ apply: true, allowUntagged: true }, pin), null)
  assert.equal(untaggedRefusal({ apply: false, allowUntagged: false }, pin), null, "a dry run may look")
})

test("a ref the clone does not have names the clone and the newest stable tag", async () => {
  const { dir } = clone()
  await assert.rejects(resolvePipelinePin(dir, "v9.0.0"), (error: Error) => {
    assert.match(error.message, /has no v9\.0\.0/)
    assert.match(error.message, /newest stable tag there is v5\.4\.1/)
    return true
  })
})
