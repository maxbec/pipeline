import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { GitHubClient } from "../../src/github/client.ts"
import {
  createSignedCommit,
  mergeMethodFor,
  repositoryKindOf,
  resolveReviewThread,
  squashMerge,
  updateBranch,
  verifyCommitSigned,
} from "../../src/github/merge.ts"
import { backmergeHeadFor } from "../../src/release/backmerge.ts"
import { PROMOTION_HEAD, releaseHeadFor } from "../../src/release/sync.ts"

interface Call {
  method: string
  url: string
  body: unknown
  headers: Headers
}

/** A fetch that records every request and answers from a queue. */
function fakeGitHub(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    })
    const next = responses.shift() ?? { status: 500, body: { message: "no response queued" } }
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }
  const client = new GitHubClient({ tokens: { token: async () => "t0k" }, fetch: fetchImpl })
  return { client, calls }
}

const repo = { owner: "acme", name: "widgets" }

test("squashMerge is a squash pinned to the expected head", async () => {
  const { client, calls } = fakeGitHub([{ body: { sha: "abc", merged: true, message: "ok" } }])
  const result = await squashMerge(client, repo, 3, {
    expectedHeadSha: "0a1b2c3",
    title: "build(deps): bump (#3)",
    body: "",
  })
  assert.equal(result.sha, "abc")
  assert.equal(calls[0]?.method, "PUT")
  assert.match(calls[0]?.url ?? "", /\/repos\/acme\/widgets\/pulls\/3\/merge$/)
  assert.deepEqual(calls[0]?.body, {
    merge_method: "squash",
    sha: "0a1b2c3",
    commit_title: "build(deps): bump (#3)",
    commit_message: "",
  })
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer t0k")
})

test("a head that moved (409) or an unmergeable PR (405) is refused, not retried", async () => {
  const { client } = fakeGitHub([{ status: 409, body: { message: "Head branch was modified" } }])
  await assert.rejects(
    squashMerge(client, repo, 3, { expectedHeadSha: "old", title: "t", body: "" }),
    /Head branch was modified/,
  )
})

test("updateBranch pins the expected head and accepts 202", async () => {
  const { client, calls } = fakeGitHub([{ status: 202, body: { message: "Updating", url: "" } }])
  await updateBranch(client, repo, 11, "deadbeef")
  assert.equal(calls[0]?.method, "PUT")
  assert.match(calls[0]?.url ?? "", /\/pulls\/11\/update-branch$/)
  assert.deepEqual(calls[0]?.body, { expected_head_sha: "deadbeef" })
})

test("resolveReviewThread replies in-thread first, then resolves", async () => {
  const { client, calls } = fakeGitHub([
    { body: { data: { addPullRequestReviewThreadReply: { comment: { id: "C1" } } } } },
    { body: { data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } } },
  ])
  await resolveReviewThread(client, "T1", "Fixed in 1a2b3c4.")
  assert.equal(calls.length, 2)
  const first = calls[0]?.body as { query: string; variables: Record<string, unknown> }
  const second = calls[1]?.body as { query: string; variables: Record<string, unknown> }
  assert.match(first.query, /addPullRequestReviewThreadReply/)
  assert.deepEqual(first.variables, { threadId: "T1", body: "Fixed in 1a2b3c4." })
  assert.match(second.query, /resolveReviewThread/)
  assert.deepEqual(second.variables, { threadId: "T1" })
})

test("createSignedCommit goes through createCommitOnBranch with the expected head", async () => {
  const { client, calls } = fakeGitHub([
    {
      body: {
        data: { createCommitOnBranch: { commit: { oid: "c0ffee", url: "https://github.com/x" } } },
      },
    },
  ])
  const commit = await createSignedCommit(client, {
    repo,
    branch: "feat/thing",
    expectedHeadOid: "0a1b2c3",
    message: { headline: "chore: bump", body: "details" },
    additions: [{ path: "a.txt", contents: "hello\n" }],
    deletions: [{ path: "b.txt" }],
  })
  assert.equal(commit.oid, "c0ffee")
  const body = calls[0]?.body as { query: string; variables: { input: Record<string, unknown> } }
  assert.match(body.query, /createCommitOnBranch/)
  assert.deepEqual(body.variables.input, {
    branch: { repositoryNameWithOwner: "acme/widgets", branchName: "feat/thing" },
    expectedHeadOid: "0a1b2c3",
    message: { headline: "chore: bump", body: "details" },
    fileChanges: {
      additions: [{ path: "a.txt", contents: Buffer.from("hello\n").toString("base64") }],
      deletions: [{ path: "b.txt" }],
    },
  })
})

test("the contents-API PUT code path does not exist", () => {
  const dir = join(import.meta.dirname, "..", "..", "src", "github")
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), "utf8")
    assert.doesNotMatch(source, /\/contents\//, `${file} must not touch the contents API`)
  }
})

test("verifyCommitSigned reads the commit's verification block", async () => {
  const { client, calls } = fakeGitHub([
    { body: { sha: "abc", commit: { verification: { verified: true, reason: "valid" } } } },
  ])
  const v = await verifyCommitSigned(client, repo, "abc")
  assert.deepEqual(v, { verified: true, reason: "valid" })
  assert.match(calls[0]?.url ?? "", /\/repos\/acme\/widgets\/commits\/abc$/)
})

test("a promotion and a backmerge merge by merge commit; feature work and a Release PR squash", () => {
  const method = (headRefName: string, baseRefName: string, kind: "major" | "small" = "major") =>
    mergeMethodFor({ headRefName, baseRefName }, kind)
  // The heads the release engine itself opens, by its own names.
  assert.equal(method(PROMOTION_HEAD, "main"), "merge")
  assert.equal(method(backmergeHeadFor("0.12.0"), "dev"), "merge")
  assert.equal(method(releaseHeadFor("dev"), "dev"), "squash")
  // A promotion straight from dev; feature work into dev.
  assert.equal(method("dev", "main"), "merge")
  assert.equal(method("feat/x", "dev"), "squash")
  // dev is not a promotion into anything but main.
  assert.equal(method("dev", "staging"), "squash")
})

test("main of a major repository takes merge commits only; a small repository's main squashes", () => {
  const method = (headRefName: string, kind: "major" | "small") =>
    mergeMethodFor({ headRefName, baseRefName: "main" }, kind)
  // A release that goes into main as a squash makes the next
  // beta list the whole release again.
  assert.equal(method(releaseHeadFor("main"), "major"), "merge", "the hotfix release")
  assert.equal(method("hotfix/y", "major"), "merge")
  assert.equal(method(PROMOTION_HEAD, "major"), "merge")
  assert.equal(method(releaseHeadFor("main"), "small"), "squash", "one version commit")
  assert.equal(method("fix/z", "small"), "squash", "a small repository's only branch")
  assert.equal(method(PROMOTION_HEAD, "small"), "merge", "a promotion is one whatever the kind")
})

test("repositoryKindOf reads dev off GitHub: present is major, a 404 is small", async () => {
  const major = fakeGitHub([{ body: { name: "dev" } }])
  assert.equal(await repositoryKindOf(major.client, repo), "major")
  assert.match(major.calls[0]?.url ?? "", /\/repos\/acme\/widgets\/branches\/dev$/)
  const small = fakeGitHub([{ status: 404, body: { message: "Branch not found" } }])
  assert.equal(await repositoryKindOf(small.client, repo), "small")
})
