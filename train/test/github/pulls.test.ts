import assert from "node:assert/strict"
import { test } from "node:test"
import { GitHubClient } from "../../src/github/client.ts"
import {
  createBranch,
  createPullRequest,
  deleteBranch,
  findOpenPullRequest,
  getBranchSha,
} from "../../src/github/pulls.ts"

interface Call {
  method: string
  url: string
  body: unknown
}

function fakeGitHub(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const next = responses.shift() ?? { status: 500, body: { message: "no response queued" } }
    return new Response(next.status === 204 ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }
  const client = new GitHubClient({ tokens: { token: async () => "t0k" }, fetch: fetchImpl })
  return { client, calls }
}

const repo = { owner: "acme", name: "widgets" }
const pull = (n: number, sha: string, state = "open") => ({
  number: n,
  html_url: `https://github.com/acme/widgets/pull/${n}`,
  state,
  merged: false,
  head: { sha },
})

test("a pull request is looked up by its head before one is created", async () => {
  const { client, calls } = fakeGitHub([{ body: [] }, { body: [pull(9, "abc")] }])
  assert.equal(await findOpenPullRequest(client, repo, "feat/x"), null)
  assert.match(calls[0]?.url ?? "", /\/pulls\?head=acme%3Afeat%2Fx&state=open/)
  const found = await findOpenPullRequest(client, repo, "feat/x")
  assert.deepEqual(found, {
    number: 9,
    headSha: "abc",
    url: "https://github.com/acme/widgets/pull/9",
    state: "open",
    merged: false,
    mergeCommitSha: null,
  })
})

test("creating a pull request sends head, base, title and body", async () => {
  const { client, calls } = fakeGitHub([{ status: 201, body: pull(10, "def") }])
  const pr = await createPullRequest(client, repo, {
    head: "feat/x",
    base: "dev",
    title: "feat: x",
    body: "the plan",
  })
  assert.equal(pr.number, 10)
  assert.equal(calls[0]?.method, "POST")
  assert.deepEqual(calls[0]?.body, {
    head: "feat/x",
    base: "dev",
    title: "feat: x",
    body: "the plan",
  })
})

test("branch refs: a missing branch reads as null, is created at a sha, and deleting twice is a no-op", async () => {
  const { client, calls } = fakeGitHub([
    { status: 404, body: { message: "Not Found" } },
    { status: 201, body: { ref: "refs/heads/feat/x" } },
    { body: { object: { sha: "abc" } } },
    { status: 204, body: {} },
    { status: 422, body: { message: "Reference does not exist" } },
  ])
  assert.equal(await getBranchSha(client, repo, "feat/x"), null)
  await createBranch(client, repo, "feat/x", "abc")
  assert.deepEqual(calls[1]?.body, { ref: "refs/heads/feat/x", sha: "abc" })
  assert.equal(await getBranchSha(client, repo, "feat/x"), "abc")
  assert.equal(await deleteBranch(client, repo, "feat/x"), true)
  assert.equal(calls[3]?.method, "DELETE")
  assert.match(calls[3]?.url ?? "", /\/git\/refs\/heads\/feat%2Fx$/)
  assert.equal(await deleteBranch(client, repo, "feat/x"), false)
})
