import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { GitHubClient } from "../../src/github/client.ts"
import { canMerge, getPrState, MAX_PAGES_PER_READ, type MergeVerdict } from "../../src/github/pr.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { type FakeCommit, FakeGitHub, type FakePull, git } from "../workflow/fake-github.ts"

/**
 * `getPrState` over a GitHub that pages: every commit's signature,
 * every check context and every review thread must be read before the
 * verdict says anything, and a PR too big to read says so instead.
 */

const home = scratchDir("train-pr-state-")

function refused(v: MergeVerdict): Extract<MergeVerdict, { ok: false }> {
  assert.equal(v.ok, false)
  return v as Extract<MergeVerdict, { ok: false }>
}

/** A bare origin with `dev` and an identical `feat/x`, and one open pull over it. */
function setup(name: string, patch: Partial<FakePull> = {}) {
  const origin = join(home, `${name}.git`)
  git(home, "init", "-q", "--bare", "-b", "dev", origin)
  const seed = join(home, `${name}-seed`)
  git(home, "clone", "-q", origin, seed)
  writeFileSync(join(seed, "README.md"), "# seed\n")
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "init")
  git(seed, "push", "-q", "origin", "dev", "dev:feat/x")
  const gh = new FakeGitHub({ origin, owner: "acme", name })
  gh.pulls.set(1, {
    number: 1,
    title: "feat: x",
    body: "",
    head: "feat/x",
    base: "dev",
    state: "open",
    merged: false,
    mergeSha: null,
    reviews: [],
    threads: [],
    ...patch,
  })
  return { gh, repo: { owner: "acme", name } }
}

function commitLog(count: number, unsignedAt: number[] = []): FakeCommit[] {
  return Array.from({ length: count }, (_, i) => ({
    oid: `${i.toString(16).padStart(7, "0")}deadbeef000000000000000000000000000`,
    headline: `feat: commit ${i}\n\nbody line`,
    signed: !unsignedAt.includes(i),
  }))
}

function graphqlCalls(gh: FakeGitHub): number {
  return gh.calls.filter((c) => c.path === "/graphql").length
}

test("an unsigned commit on the second page of a 250-commit PR refuses, naming it", async () => {
  const { gh, repo } = setup("commits", { commitLog: commitLog(250, [120]) })
  const state = await getPrState(gh.client, repo, 1)
  assert.equal(state.commits.length, 200, "read to the page the unsigned commit is on, no further")
  assert.equal(state.signed, false)
  assert.equal(graphqlCalls(gh), 2, "the second page decided it; the third buys nothing")
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "unsigned")
  assert.match(verdict.reason, /commit 0000078 /, "the short sha of commit 120")
  assert.match(verdict.reason, /feat: commit 120/, "the first line of its message")
  assert.doesNotMatch(verdict.reason, /body line/)
  assert.match(verdict.reason, /required_signatures/)
})

test("every commit signed across pages is mergeable", async () => {
  const { gh, repo } = setup("commits-ok", { commitLog: commitLog(150) })
  const state = await getPrState(gh.client, repo, 1)
  assert.equal(state.commits.length, 150)
  assert.equal(state.signed, true)
  assert.deepEqual(canMerge(state), { ok: true })
})

test("more commits than the read is bounded to is refused loudly, never guessed", async () => {
  const { gh, repo } = setup("commits-many", { commitLog: commitLog(1001) })
  const state = await getPrState(gh.client, repo, 1)
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "blocked")
  assert.match(verdict.reason, /too many commits to verify/)
  assert.ok(graphqlCalls(gh) <= 12, "the paging stopped at the bound")
})

test("a red check context on the second page of contexts is seen", async () => {
  const contexts = Array.from({ length: 130 }, (_, i) => ({
    name: `Matrix ${i}`,
    status: "COMPLETED",
    conclusion: i === 125 ? "FAILURE" : "SUCCESS",
  }))
  const { gh, repo } = setup("contexts", { contexts })
  const state = await getPrState(gh.client, repo, 1)
  assert.equal(state.checks.length, 131, "the default check plus 130 more")
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "checks_red")
  assert.match(verdict.reason, /Matrix 125/)
})

test("an unresolved review thread on the second page of threads is seen", async () => {
  const threads = Array.from({ length: 160 }, (_, i) => ({
    id: `T${i}`,
    isResolved: i !== 150,
    isOutdated: false,
    path: "a.ts",
    line: 1,
    comments: [],
  }))
  const { gh, repo } = setup("threads", { threads })
  const state = await getPrState(gh.client, repo, 1)
  assert.equal(state.reviewThreads.length, 160)
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "unresolved_threads")
  assert.match(verdict.reason, /1 unresolved/)
})

test("more review threads than the bound is refused loudly", async () => {
  const threads = Array.from({ length: 1001 }, (_, i) => ({
    id: `T${i}`,
    isResolved: true,
    isOutdated: false,
    path: "a.ts",
    line: 1,
    comments: [],
  }))
  const { gh, repo } = setup("threads-many", { threads })
  const verdict = refused(canMerge(await getPrState(gh.client, repo, 1)))
  assert.equal(verdict.code, "blocked")
  assert.match(verdict.reason, /too many review threads to verify/)
})

test("exactly the bound is read; one node more is refused", async () => {
  const { gh, repo } = setup("commits-bound", { commitLog: commitLog(1000) })
  const state = await getPrState(gh.client, repo, 1)
  assert.equal(state.commits.length, 1000, "1000 nodes is the bound, not past it")
  assert.equal(state.truncated.commits, false)
  assert.deepEqual(canMerge(state), { ok: true })
})

test("the drain stops at the first unsigned commit: the verdict is already decided", async () => {
  const { gh, repo } = setup("commits-early", { commitLog: commitLog(1000, [5]) })
  const state = await getPrState(gh.client, repo, 1)
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "unsigned")
  assert.match(verdict.reason, /feat: commit 5/)
  assert.equal(graphqlCalls(gh), 1, "the first page decided it; 9 more pages buy nothing")
  assert.equal(state.truncated.commits, false, "a decided verdict is not a guess")
})

test("one PR read is bounded in requests, whatever its connections do", async () => {
  const contexts = Array.from({ length: 900 }, (_, i) => ({
    name: `Matrix ${i}`,
    status: "COMPLETED",
    conclusion: "SUCCESS",
  }))
  const threads = Array.from({ length: 900 }, (_, i) => ({
    id: `T${i}`,
    isResolved: true,
    isOutdated: false,
    path: "a.ts",
    line: 1,
    comments: [],
  }))
  const { gh, repo } = setup("budget", { commitLog: commitLog(1001), contexts, threads })
  await getPrState(gh.client, repo, 1)
  assert.ok(
    graphqlCalls(gh) <= 1 + MAX_PAGES_PER_READ,
    `one read cost ${graphqlCalls(gh)} requests, over the ${1 + MAX_PAGES_PER_READ} bound`,
  )
})

test("the fake can express a protected base and an unsigned head", async () => {
  const { gh, repo } = setup("base-rule", {
    commitLog: commitLog(2, [1]),
    baseRule: {
      requiredStatusCheckContexts: ["Check Gate"],
      requiresSignatures: true,
    },
  })
  const state = await getPrState(gh.client, repo, 1)
  assert.deepEqual(state.baseRule, {
    requiredStatusCheckContexts: ["Check Gate"],
    requiresSignatures: true,
  })
  assert.equal(state.signed, false, "the head's signature follows the commit log")
  assert.equal(refused(canMerge(state)).code, "unsigned")
})

/**
 * A head that moves between two pages of the same read: page 1's contexts
 * belong to another commit than page 2's, and both would be filed under
 * page 1's `headSha`.
 */
test("a head that moves mid-read is abandoned, not stitched together", async () => {
  const calls: string[] = []
  const contexts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      __typename: "CheckRun",
      name: `Matrix ${i}`,
      status: "COMPLETED",
      conclusion: "SUCCESS",
      isRequired: false,
    }))
  const client = new GitHubClient({
    tokens: { token: async () => "fake" },
    fetch: async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body))
      const first = !String(body.query).includes("PrContextsPage")
      calls.push(first ? "state" : "contexts")
      const oid = first ? "a".repeat(40) : "b".repeat(40)
      const data = first
        ? {
            repository: {
              pullRequest: {
                number: 1,
                title: "feat: x",
                body: "",
                state: "OPEN",
                isDraft: false,
                merged: false,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: null,
                baseRefName: "dev",
                headRefName: "feat/x",
                headRefOid: oid,
                baseRef: { refUpdateRule: null },
                headCommit: {
                  nodes: [
                    {
                      commit: {
                        oid,
                        signature: { isValid: true, state: "VALID" },
                        statusCheckRollup: {
                          state: "SUCCESS",
                          contexts: {
                            totalCount: 200,
                            pageInfo: { hasNextPage: true, endCursor: "100" },
                            nodes: contexts(100),
                          },
                        },
                      },
                    },
                  ],
                },
                commits: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      commit: {
                        oid,
                        messageHeadline: "feat: x",
                        signature: { isValid: true, state: "VALID" },
                      },
                    },
                  ],
                },
                reviewThreads: {
                  totalCount: 0,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          }
        : {
            repository: {
              pullRequest: {
                headCommit: {
                  nodes: [
                    {
                      commit: {
                        oid,
                        statusCheckRollup: {
                          contexts: {
                            totalCount: 200,
                            pageInfo: { hasNextPage: false, endCursor: null },
                            nodes: contexts(100),
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          }
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  await assert.rejects(
    () => getPrState(client, { owner: "acme", name: "widgets" }, 1),
    /head moved/,
    "two heads' contexts must never be filed under one sha",
  )
  assert.ok(calls.length >= 3, "the read restarted once before giving up")
})
