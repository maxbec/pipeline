import assert from "node:assert/strict"
import { test } from "node:test"
import {
  findLatestMergedRelease,
  findPendingRelease,
  RELEASED_LABEL,
  ReleaseTagMismatchError,
} from "../../src/release/pending.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { world } from "../helpers/world.ts"
import { git } from "../workflow/fake-github.ts"

const home = scratchDir("train-pending-")

/** A Release PR as the train leaves it, merged with GitHub's button. */
async function merged(
  w: ReturnType<typeof world>,
  opts: { head: string; base: string; version: string; method?: "merge" | "squash" },
): Promise<{ number: number; mergeSha: string }> {
  w.branch(opts.head, opts.base, undefined, `chore(release): ${opts.version}`)
  const number = await w.open(opts.head, opts.base, `chore(release): ${opts.version}`)
  const mergeSha = await w.button(number, opts.method ?? "merge")
  return { number, mergeSha }
}

test("a Release PR merged with the button is found, whatever GitHub called the commit", async () => {
  const w = world(home, "button")
  const { number, mergeSha } = await merged(w, {
    head: "promote/main",
    base: "main",
    version: "1.3.0",
  })
  assert.match(git(w.gh.origin, "log", "-1", "--format=%s", "main"), /^Merge pull request #1$/)

  const pending = await findPendingRelease(w.gh.client, w.repo, "main")
  assert.deepEqual(pending, {
    number,
    version: "1.3.0",
    mergeSha,
    mergedBy: { login: "octocat", type: "User" },
  })
  assert.equal(
    await findPendingRelease(w.gh.client, w.repo, "dev"),
    null,
    "nothing merged into dev",
  )
})

test("a hotfix release of main is found by its own head", async () => {
  const w = world(home, "hotfix-head")
  const { mergeSha } = await merged(w, { head: "release/main", base: "main", version: "1.2.1" })
  assert.equal((await findPendingRelease(w.gh.client, w.repo, "main"))?.mergeSha, mergeSha)
})

test("a branch tip that moved past the merge still finds it", async () => {
  const w = world(home, "moved")
  const { mergeSha } = await merged(w, {
    head: "release/dev",
    base: "dev",
    version: "1.3.0-beta.1",
    method: "squash",
  })
  w.land("fix: the empty case (#2)")
  w.land("docs: the readme (#3)")
  assert.notEqual(w.gh.sha("dev"), mergeSha)

  const pending = await findPendingRelease(w.gh.client, w.repo, "dev")
  assert.equal(pending?.version, "1.3.0-beta.1")
  assert.equal(pending?.mergeSha, mergeSha)
})

test("the merging account is reported as GitHub names it", async () => {
  const w = world(home, "by-bot")
  w.gh.mergeActor = { login: "train-acme[bot]", type: "Bot" }
  await merged(w, { head: "release/dev", base: "dev", version: "1.3.0-beta.1" })
  const pending = await findPendingRelease(w.gh.client, w.repo, "dev")
  assert.deepEqual(pending?.mergedBy, { login: "train-acme[bot]", type: "Bot" })
})

test("a release that already has its tag is not pending", async () => {
  const w = world(home, "tagged")
  const { mergeSha } = await merged(w, {
    head: "release/dev",
    base: "dev",
    version: "1.3.0-beta.1",
  })
  git(w.gh.origin, "tag", "v1.3.0-beta.1", mergeSha)
  assert.equal(await findPendingRelease(w.gh.client, w.repo, "dev"), null)
  const latest = await findLatestMergedRelease(w.gh.client, w.repo, "dev")
  assert.equal(latest?.tagSha, mergeSha, "the entry still learns which release is the last one")
})

test("a tag of that version on another commit is an error that names both", async () => {
  const w = world(home, "mismatch")
  const elsewhere = w.gh.sha("dev") ?? ""
  const { mergeSha } = await merged(w, {
    head: "release/dev",
    base: "dev",
    version: "1.3.0-beta.1",
  })
  git(w.gh.origin, "tag", "v1.3.0-beta.1", elsewhere)
  await assert.rejects(findPendingRelease(w.gh.client, w.repo, "dev"), (error: unknown) => {
    assert.ok(error instanceof ReleaseTagMismatchError)
    assert.match(error.message, /v1\.3\.0-beta\.1/)
    assert.ok(error.message.includes(elsewhere.slice(0, 7)))
    assert.ok(error.message.includes(mergeSha.slice(0, 7)))
    return true
  })
})

test("a release that was published before is not pending, tag or no tag", async () => {
  const w = world(home, "released-label")
  const { number } = await merged(w, { head: "release/dev", base: "dev", version: "1.3.0-beta.1" })
  const pull = w.gh.pulls.get(number)
  if (pull) pull.labels = [RELEASED_LABEL]
  assert.equal(await findPendingRelease(w.gh.client, w.repo, "dev"), null)
})

test("only a merge counts: a closed Release PR, a fork's, another head's and an untitled one do not", async () => {
  const w = world(home, "not-these")
  // Closed without a merge.
  w.branch("release/dev", "dev", undefined, "chore(release): 1.3.0-beta.1")
  const closed = await w.open("release/dev", "dev", "chore(release): 1.3.0-beta.1")
  const pull = w.gh.pulls.get(closed)
  if (pull) pull.state = "closed"
  // Merged feature work that borrowed the title.
  w.branch("feat/impostor", "dev")
  await w.button(await w.open("feat/impostor", "dev", "chore(release): 9.9.9"), "squash")
  assert.equal(await findPendingRelease(w.gh.client, w.repo, "dev"), null)

  // The right head, merged, from a fork of the same branch name.
  const w2 = world(home, "not-these-fork")
  const fork = await merged(w2, { head: "release/dev", base: "dev", version: "1.3.0-beta.1" })
  const forked = w2.gh.pulls.get(fork.number)
  if (forked) forked.headRepo = "mallory/not-these-fork"
  assert.equal(await findPendingRelease(w2.gh.client, w2.repo, "dev"), null)

  // The right head, merged, with a title that names no version.
  const w3 = world(home, "not-these-title")
  w3.branch("release/dev", "dev")
  await w3.button(await w3.open("release/dev", "dev", "chore: tidy the release branch"), "squash")
  assert.equal(await findPendingRelease(w3.gh.client, w3.repo, "dev"), null)
})

test("the newest merged release is the one that counts", async () => {
  const w = world(home, "newest")
  const first = await merged(w, {
    head: "release/dev",
    base: "dev",
    version: "1.3.0-beta.1",
    method: "squash",
  })
  git(w.gh.origin, "tag", "v1.3.0-beta.1", first.mergeSha)
  w.land("fix: the empty case (#2)")
  const second = await merged(w, {
    head: "release/dev",
    base: "dev",
    version: "1.3.0-beta.2",
    method: "squash",
  })
  const pending = await findPendingRelease(w.gh.client, w.repo, "dev")
  assert.equal(pending?.number, second.number)
  assert.equal(pending?.version, "1.3.0-beta.2")
})

test("a merge commit the branch no longer contains is not a release of it", async () => {
  const w = world(home, "rewound")
  const before = w.gh.sha("dev") ?? ""
  await merged(w, { head: "release/dev", base: "dev", version: "1.3.0-beta.1", method: "squash" })
  git(w.gh.origin, "update-ref", "refs/heads/dev", before)
  assert.equal(await findPendingRelease(w.gh.client, w.repo, "dev"), null)
})
