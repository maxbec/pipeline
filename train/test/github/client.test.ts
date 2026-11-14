import assert from "node:assert/strict"
import { test } from "node:test"
import {
  GitHubClient,
  GitHubGraphQLError,
  GitHubHttpError,
  isTransientGitHubFailure,
} from "../../src/github/client.ts"

function withResponses(responses: Response[]) {
  const seen: Request[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push(new Request(input, init))
    const r = responses.shift()
    if (!r) throw new Error("no response queued")
    return r
  }
  return {
    seen,
    client: new GitHubClient({ tokens: { token: async () => "tok" }, fetch: fetchImpl }),
  }
}

test("rest() sends the API version, auth and a user agent, and parses JSON", async () => {
  const { seen, client } = withResponses([
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { etag: 'W/"abc"', "x-ratelimit-remaining": "4999" },
    }),
  ])
  const res = await client.rest<{ ok: number }>("GET", "/repos/acme/widgets/pulls")
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: 1 })
  assert.equal(res.etag, 'W/"abc"')
  assert.equal(res.rateLimitRemaining, 4999)
  const req = seen[0] as Request
  assert.equal(req.url, "https://api.github.com/repos/acme/widgets/pulls")
  assert.equal(req.headers.get("authorization"), "Bearer tok")
  assert.equal(req.headers.get("x-github-api-version"), "2022-11-28")
  assert.match(req.headers.get("user-agent") ?? "", /pipeline-train/)
})

test("rest() turns an ETag into If-None-Match and reports 304 as notModified", async () => {
  const { seen, client } = withResponses([new Response(null, { status: 304 })])
  const res = await client.rest("GET", "/repos/acme/widgets/pulls", { etag: 'W/"abc"' })
  assert.equal(res.status, 304)
  assert.equal(res.notModified, true)
  assert.equal(res.body, null)
  assert.equal((seen[0] as Request).headers.get("if-none-match"), 'W/"abc"')
})

test("rest() surfaces GitHub's message on an error status", async () => {
  const { client } = withResponses([
    new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
  ])
  await assert.rejects(client.rest("GET", "/nope"), (e: unknown) => {
    assert.ok(e instanceof GitHubHttpError)
    assert.equal(e.status, 404)
    assert.match(e.message, /Not Found/)
    return true
  })
})

test("graphql() posts to /graphql and throws on errors", async () => {
  const { seen, client } = withResponses([
    new Response(JSON.stringify({ data: { viewer: { login: "x" } } }), { status: 200 }),
    new Response(JSON.stringify({ errors: [{ message: "Field nope doesn't exist" }] }), {
      status: 200,
    }),
  ])
  const data = await client.graphql<{ viewer: { login: string } }>("query { viewer { login } }")
  assert.equal(data.viewer.login, "x")
  assert.equal((seen[0] as Request).url, "https://api.github.com/graphql")
  await assert.rejects(client.graphql("query { nope }"), GitHubGraphQLError)
})

/**
 * A caller about to open a dozen reads has to be able to ask what is left of
 * the budget without spending a request on `/rate_limit`. Every REST answer
 * carries it, so the client remembers the last one it saw.
 */
test("the client remembers what the last answer said was left of the rate limit", async () => {
  const reset = Math.floor(Date.parse("2026-09-09T15:00:00.000Z") / 1000)
  const { client } = withResponses([
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(reset) },
    }),
    new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    }),
  ])
  // Read into a local first: `assert/strict`'s `equal` narrows what it is
  // handed, and `client.rateLimit` would stay `null` for the rest of the test.
  const unasked = client.rateLimit
  assert.equal(unasked.remaining, null, "nothing known until it has asked")
  assert.equal(unasked.reset, null)

  await client.rest("GET", "/repos/acme/widgets")
  const seen = client.rateLimit
  assert.equal(seen.remaining, 4999)
  assert.equal(seen.reset?.toISOString(), "2026-09-09T15:00:00.000Z")

  // The answer that says the budget is gone is a 4xx, and it is the one
  // answer a caller most needs recorded — so the headers are read before
  // the throw, not after it.
  await assert.rejects(() => client.rest("GET", "/repos/acme/widgets"), GitHubHttpError)
  assert.equal(client.rateLimit.remaining, 0)
})

test("GitHub out of reach is transient; an answer about the request is not", () => {
  const timeout = Object.assign(new Error("Connect Timeout Error"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  })
  assert.equal(isTransientGitHubFailure(new TypeError("fetch failed", { cause: timeout })), true)
  assert.equal(isTransientGitHubFailure(new TypeError("terminated", { cause: timeout })), true)
  assert.equal(isTransientGitHubFailure(new DOMException("timed out", "TimeoutError")), true)
  const status = (n: number) => new GitHubHttpError("GET", "https://api.github.com/x", n, null)
  for (const n of [502, 503, 504]) assert.equal(isTransientGitHubFailure(status(n)), true, `${n}`)
  for (const n of [500, 422, 409, 404, 403, 401])
    assert.equal(isTransientGitHubFailure(status(n)), false, `${n}`)
  assert.equal(isTransientGitHubFailure(new TypeError("x is not a function")), false)
  assert.equal(isTransientGitHubFailure(new GitHubGraphQLError([{ message: "boom" }])), false)
  assert.equal(isTransientGitHubFailure(null), false)
})
