import assert from "node:assert/strict"
import { test } from "node:test"
import { GitHubClient, GitHubHttpError } from "../../src/github/client.ts"
import {
  MAX_UPDATE_BRANCH_ROUNDS,
  type UpdateBehindMemo,
  updateBehindOnce,
} from "../../src/github/update-behind.ts"

const repo = { owner: "acme", name: "widgets" }

/** A client whose `update-branch` answers with the given status, counting the calls. */
function updating(status: number) {
  const calls: string[] = []
  const client = new GitHubClient({
    tokens: { token: async () => "tok" },
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      calls.push(`${init?.method} ${new URL(url).pathname}`)
      return new Response(JSON.stringify({ message: `status ${status}` }), { status })
    },
  })
  return { client, calls }
}

const pr = { number: 7, headSha: "a".repeat(40) }

test("a fresh head is updated once and remembered with its round", async () => {
  const { client, calls } = updating(202)
  const out = await updateBehindOnce({ client, repo, pr, memo: {} })
  assert.deepEqual(out, {
    kind: "updated",
    memo: { updatedBranchFor: pr.headSha, updateBranchRounds: 1 },
  })
  assert.deepEqual(calls, ["PUT /repos/acme/widgets/pulls/7/update-branch"])
})

test("a head already asked for is not asked for again", async () => {
  const { client, calls } = updating(202)
  const memo: UpdateBehindMemo = { updatedBranchFor: pr.headSha, updateBranchRounds: 1 }
  const out = await updateBehindOnce({ client, repo, pr, memo })
  assert.deepEqual(out, { kind: "already", memo })
  assert.equal(calls.length, 0)
})

test("a base that keeps moving gets three updates, then the helper gives up with a reason", async () => {
  const { client, calls } = updating(202)
  let memo: UpdateBehindMemo = {}
  for (let round = 1; round <= MAX_UPDATE_BRANCH_ROUNDS; round += 1) {
    const head = String(round).repeat(40)
    const out = await updateBehindOnce({ client, repo, pr: { number: 7, headSha: head }, memo })
    assert.equal(out.kind, "updated", `round ${round}`)
    memo = out.memo
    assert.equal(memo.updateBranchRounds, round)
  }
  const out = await updateBehindOnce({
    client,
    repo,
    pr: { number: 7, headSha: "f".repeat(40) },
    memo,
  })
  assert.equal(out.kind, "exhausted")
  assert.match((out as { reason: string }).reason, /3 times/)
  assert.equal(calls.length, MAX_UPDATE_BRANCH_ROUNDS, "no fourth update")
})

test("422 and 409 are a refusal the caller decides about; anything else is thrown for the poller to retry", async () => {
  for (const status of [422, 409]) {
    const { client } = updating(status)
    const out = await updateBehindOnce({ client, repo, pr, memo: {} })
    assert.equal(out.kind, "refused", `status ${status}`)
    assert.match((out as { reason: string }).reason, new RegExp(String(status)))
    assert.deepEqual((out as { memo: UpdateBehindMemo }).memo, {
      updatedBranchFor: pr.headSha,
      updateBranchRounds: 1,
    })
  }
  const { client } = updating(502)
  await assert.rejects(
    updateBehindOnce({ client, repo, pr, memo: {} }),
    (error: unknown) => error instanceof GitHubHttpError && error.status === 502,
  )
})

test("a memo of another shape (an older stage output) counts as no rounds yet", async () => {
  const { client } = updating(202)
  const out = await updateBehindOnce({
    client,
    repo,
    pr,
    memo: { updatedBranchFor: 5, updateBranchRounds: "two" },
  })
  assert.deepEqual(out, {
    kind: "updated",
    memo: { updatedBranchFor: pr.headSha, updateBranchRounds: 1 },
  })
})
