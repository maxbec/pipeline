import assert from "node:assert/strict"
import { test } from "node:test"
import { createSignedCommit } from "../../src/github/merge.ts"
import { updatePullRequest } from "../../src/github/releases.ts"
import { inspectPrevious, readPrevious } from "../../src/release/previous.ts"
import {
  PROMOTION_HEAD,
  type SyncOutput,
  type SyncResult,
  syncReleasePr,
} from "../../src/release/sync.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { type World, world } from "../helpers/world.ts"
import { git } from "../workflow/fake-github.ts"

const home = scratchDir("train-previous-")

function sync(
  w: World,
  branch: string,
  previous: SyncOutput | null,
  releaseAs: string | null = null,
): Promise<SyncResult> {
  return syncReleasePr({
    client: w.gh.client,
    repository: w.repository,
    branch,
    releaseAs,
    previous,
    now: () => new Date("2026-09-06T12:00:00Z"),
  })
}

function pr(result: SyncResult): SyncOutput {
  assert.equal(result.kind, "pr", JSON.stringify(result))
  return (result as Extract<SyncResult, { kind: "pr" }>).output
}

/** What `syncReleasePr` reads of a `previous`, `releaseAs` aside (the entry supplies that one). */
function consumed(o: SyncOutput) {
  return {
    prNumber: o.prNumber,
    head: o.head,
    headSha: o.headSha,
    sourceSha: o.sourceSha,
    version: o.version,
    target: o.target,
    mergedMain: o.mergedMain ?? null,
  }
}

test("no Release PR, no previous", async () => {
  const w = world(home, "none")
  const read = await inspectPrevious(w.gh.client, w.repo, "dev")
  assert.equal(read.previous, null)
  assert.match(read.reason, /no Release PR/)
})

test("round trip: what the sync produced is read back from GitHub alone", async () => {
  const w = world(home, "round-trip")
  w.land("feat: the endpoint (#1)")
  const produced = pr(await sync(w, "dev", null))

  // Whatever the PR says about itself is not where this comes from.
  const pull = w.gh.pulls.get(produced.prNumber)
  if (pull) {
    pull.title = "chore(release): 0.0.1"
    pull.body = "target: 0.0.1"
  }
  const previous = await readPrevious(w.gh.client, w.repo, "dev")
  assert.ok(previous)
  assert.deepEqual(consumed(previous), consumed(produced))
  assert.equal(previous.base, "dev")
  assert.equal(previous.prerelease, true)
  assert.equal(previous.mode, "branch")
  assert.equal(previous.mergeMethod, "squash")

  // And the sync takes it for its own: nothing moved, nothing is rebuilt.
  const again = await sync(w, "dev", previous)
  assert.equal(again.kind, "pr")
  assert.equal((again as { changed: boolean }).changed, false)
  assert.equal(w.gh.commits.length, 1)
})

test("round trip of a promotion whose head carries a forward merge of main", async () => {
  const w = world(home, "forward")
  const mainTip = w.land("docs: a note only main has", "main")
  const released = w.land("feat: the endpoint (#1)")
  git(w.gh.origin, "tag", "v1.3.0-beta.1", released)
  const produced = pr(await sync(w, "main", null))
  assert.equal(produced.head, PROMOTION_HEAD)
  assert.equal(produced.mergedMain, mainTip, "the rig really took the forward-merge path")

  const previous = await readPrevious(w.gh.client, w.repo, "main")
  assert.ok(previous)
  assert.deepEqual(consumed(previous), consumed(produced))
  assert.equal(previous.sourceSha, released, "dev's release, not the merge of main into it")
  assert.equal(previous.mode, "promotion")
  assert.equal(previous.mergeMethod, "merge")

  const again = await sync(w, "main", previous)
  assert.equal((again as { changed?: boolean }).changed, false, JSON.stringify(again))
})

test("a hotfix release of a major repository reads back as one", async () => {
  const w = world(home, "hotfix")
  w.land("fix: production is down (#7)", "main")
  const produced = pr(await sync(w, "main", null))
  assert.equal(produced.mode, "hotfix")
  const previous = await readPrevious(w.gh.client, w.repo, "main")
  assert.ok(previous)
  assert.deepEqual(consumed(previous), consumed(produced))
  assert.equal(previous.mode, "hotfix")
  assert.equal(previous.mergeMethod, "merge")
})

test("a head commit nobody verified is no previous, and the reason says so", async () => {
  const w = world(home, "unsigned")
  w.land("feat: the endpoint (#1)")
  const produced = pr(await sync(w, "dev", null))
  // Somebody with write access pushes a look-alike onto the head.
  w.branch(produced.head, "dev", undefined, "chore(release): 9.0.0-beta.1")
  const read = await inspectPrevious(w.gh.client, w.repo, "dev")
  assert.equal(read.previous, null)
  assert.match(read.reason, /not verified/)
})

test("a verified head commit that is not the train's version commit is no previous", async () => {
  const w = world(home, "foreign")
  w.land("feat: the endpoint (#1)")
  const produced = pr(await sync(w, "dev", null))
  await createSignedCommit(w.gh.client, {
    repo: w.repo,
    branch: produced.head,
    expectedHeadOid: produced.headSha,
    message: { headline: "fix: a typo in the changelog" },
    additions: [{ path: "CHANGELOG.md", contents: "# Changelog\n" }],
  })
  const read = await inspectPrevious(w.gh.client, w.repo, "dev")
  assert.equal(read.previous, null)
  assert.match(read.reason, /fix: a typo in the changelog/)
})

test("the target never shrinks across runs that know nothing but GitHub", async () => {
  const w = world(home, "grows")
  w.land("feat: the endpoint (#1)")
  const first = pr(await sync(w, "dev", null, "2.0.0-beta.1"))
  assert.equal(first.target, "2.0.0")

  // The override is gone from the config; a fix lands. Derived alone this is 1.3.0.
  w.land("fix: the empty case (#2)")
  const previous = await readPrevious(w.gh.client, w.repo, "dev")
  assert.equal(previous?.target, "2.0.0")
  const second = await sync(w, "dev", previous)
  assert.equal((second as { changed: boolean }).changed, true, "the base moved")
  assert.equal(pr(second).target, "2.0.0")
  assert.equal(pr(second).version, "2.0.0-beta.1")
  assert.equal(pr(second).prNumber, first.prNumber, "the same Release PR")

  // A third run, again from GitHub alone.
  w.land("feat: another endpoint (#3)")
  const third = pr(await sync(w, "dev", await readPrevious(w.gh.client, w.repo, "dev")))
  assert.equal(third.target, "2.0.0")
})

test("a Release PR a person closed stays closed: the read hands the sync what the state file did", async () => {
  const w = world(home, "closed")
  w.land("feat: the endpoint (#1)")
  const produced = pr(await sync(w, "dev", null))
  await updatePullRequest(w.gh.client, w.repo, produced.prNumber, { state: "closed" })

  const previous = await readPrevious(w.gh.client, w.repo, "dev")
  assert.ok(previous, "closed, unmerged, head intact")
  assert.deepEqual(consumed(previous), consumed(produced))
  w.land("fix: the empty case (#2)")
  const result = await sync(w, "dev", previous)
  assert.equal(result.kind, "closed", JSON.stringify(result))
  assert.equal(w.gh.pulls.size, 1, "no second Release PR")
  assert.equal(w.gh.pulls.get(produced.prNumber)?.state, "closed")

  // Reopened by that person: an open Release PR again, and the sync takes it up.
  await updatePullRequest(w.gh.client, w.repo, produced.prNumber, { state: "open" })
  const reopened = await sync(w, "dev", await readPrevious(w.gh.client, w.repo, "dev"))
  assert.equal(pr(reopened).prNumber, produced.prNumber)
  assert.equal(pr(reopened).version, "1.3.0-beta.1")
})

test("a closed Release PR is no decision once its head is not the one it was closed with", async () => {
  const w = world(home, "closed-moved")
  w.land("feat: the endpoint (#1)")
  const produced = pr(await sync(w, "dev", null))
  await updatePullRequest(w.gh.client, w.repo, produced.prNumber, { state: "closed" })

  // The title no longer carries the version of the head.
  const pull = w.gh.pulls.get(produced.prNumber)
  if (pull) pull.title = "chore(release): 1.4.0-beta.1"
  assert.match((await inspectPrevious(w.gh.client, w.repo, "dev")).reason, /title/)
  if (pull) pull.title = "chore(release): 1.3.0-beta.1"
  assert.ok(await readPrevious(w.gh.client, w.repo, "dev"))

  // The head branch is gone (a withdrawn Release PR).
  git(w.gh.origin, "update-ref", "-d", `refs/heads/${produced.head}`)
  const read = await inspectPrevious(w.gh.client, w.repo, "dev")
  assert.equal(read.previous, null)
  assert.match(read.reason, /head/)
})

test("a merged Release PR is not a previous: the next cycle starts fresh", async () => {
  const w = world(home, "merged")
  w.land("feat: the endpoint (#1)")
  const produced = pr(await sync(w, "dev", null))
  await w.button(produced.prNumber, "squash")
  const read = await inspectPrevious(w.gh.client, w.repo, "dev")
  assert.equal(read.previous, null)
  assert.match(read.reason, /merged/)
})
