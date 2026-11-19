import assert from "node:assert/strict"
import { test } from "node:test"
import { GitHubClient } from "../src/github/client.ts"
import {
  failedMarker,
  MAX_LOST_RUNS,
  PIPELINE_WORKFLOW,
  runVerify,
  UNVERIFIED_STEP,
  VERIFY_ACTIONS,
  verifyMain,
} from "../src/verify-run.ts"

/**
 * A GitHub that knows only what Verify asks about: open pull requests, branch
 * tips, workflow runs with their jobs, and a pull request's comments. Every
 * write is recorded; a dispatch does not create a run by itself, as on GitHub
 * the run shows up a moment later.
 */

const REPO = { owner: "acme", name: "widgets" }
const BOT = "train-acme[bot]"
const PIPELINE_ID = 7001
const CHECK = "pipeline / Check"
const TIP = "a".repeat(40)
const OLD_TIP = "b".repeat(40)
const RELEASE_HEAD = "c".repeat(40)

interface Run {
  id: number
  name: string
  workflow_id: number
  event: string
  status: string
  conclusion: string | null
  head_sha: string
  head_branch: string
  html_url: string
  triggering_actor: { login: string }
  jobs: { id: number; name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[] }[]
}

interface Pull {
  number: number
  head: { ref: string; sha: string; repo: { full_name: string } }
  base: { ref: string }
  comments: { body: string; user: { login: string; type: string } }[]
}

function failedAt(step: string): Run["jobs"] {
  return [
    { id: 1, name: "pipeline / Guard", conclusion: "success" },
    {
      id: 2,
      name: CHECK,
      conclusion: "failure",
      steps: [
        { name: "Set up job", conclusion: "success" },
        { name: step, conclusion: "failure" },
        { name: "Complete job", conclusion: "success" },
      ],
    },
  ]
}

class World {
  readonly pulls: Pull[] = []
  readonly branches = new Map<string, string>([["dev", TIP]])
  readonly runs: Run[] = []
  readonly writes: { method: string; path: string; body: unknown }[] = []
  /** The status a dispatch is answered with. */
  dispatchStatus = 204
  #nextRun = 100

  readonly client = new GitHubClient({
    tokens: { token: async () => "fake" },
    fetch: (input, init) => this.#fetch(input, init),
  })

  /** A Release PR into `base`, head `release/<base>` in this repository unless told otherwise. */
  releasePull(over: { base?: string; head?: string; fork?: boolean; sha?: string } = {}): Pull {
    const base = over.base ?? "dev"
    const pull: Pull = {
      number: this.pulls.length + 40,
      head: {
        ref: over.head ?? `release/${base}`,
        sha: over.sha ?? RELEASE_HEAD,
        repo: { full_name: over.fork ? "mallory/widgets" : "acme/widgets" },
      },
      base: { ref: base },
      comments: [],
    }
    this.pulls.push(pull)
    return pull
  }

  run(over: Partial<Run> & { head_sha: string }): Run {
    const id = this.#nextRun++
    const run: Run = {
      id,
      name: PIPELINE_WORKFLOW,
      workflow_id: PIPELINE_ID,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "dev",
      html_url: `https://github.com/acme/widgets/actions/runs/${id}`,
      triggering_actor: { login: BOT },
      jobs: [],
      ...over,
    }
    this.runs.push(run)
    return run
  }

  /** The Release PR's own Pipeline run, failed in `step`. */
  releaseRun(pull: Pull, step = UNVERIFIED_STEP, over: Partial<Run> = {}): Run {
    return this.run({
      event: "pull_request",
      conclusion: "failure",
      head_sha: pull.head.sha,
      head_branch: pull.head.ref,
      jobs: failedAt(step),
      ...over,
    })
  }

  /** A Release PR red as "Not fully verified": the state Verify exists for. */
  unverified(base = "dev"): Pull {
    const pull = this.releasePull({ base })
    this.releaseRun(pull)
    return pull
  }

  dispatches(): unknown[] {
    return this.writes.filter((w) => w.path.endsWith("/dispatches")).map((w) => w.body)
  }

  cancels(): number[] {
    return this.writes.filter((w) => w.path.endsWith("/cancel")).map((w) => Number(w.path.split("/").at(-2)))
  }

  #fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const prefix = "/repos/acme/widgets/"
    assert.ok(url.pathname.startsWith(prefix), `a call outside the repository: ${url.pathname}`)
    const parts = url.pathname.slice(prefix.length).split("/")
    const q = url.searchParams
    if (method !== "GET") this.writes.push({ method, path: url.pathname, body })

    if (method === "GET" && parts.join("/") === "pulls") {
      assert.equal(q.get("state"), "open")
      const page = Number(q.get("page") ?? "1")
      const per = Number(q.get("per_page") ?? "30")
      return json(200, this.pulls.slice((page - 1) * per, page * per).map(({ comments: _, ...pull }) => pull))
    }
    if (method === "GET" && parts.slice(0, 3).join("/") === "git/ref/heads") {
      const sha = this.branches.get(decodeURIComponent(parts.slice(3).join("/")))
      return sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" })
    }
    if (method === "GET" && parts.join("/") === "actions/runs") {
      assert.equal(q.get("event"), "pull_request", "the repository-wide listing is only asked about the Release PR's own run")
      const runs = this.runs.filter((r) => r.head_sha === q.get("head_sha") && r.event === "pull_request")
      return json(200, { total_count: runs.length, workflow_runs: runs.map(({ jobs: _, ...r }) => r) })
    }
    if (method === "GET" && parts[0] === "actions" && parts[1] === "workflows" && parts[3] === "runs") {
      const runs = this.runs.filter(
        (r) =>
          r.workflow_id === Number(parts[2]) &&
          r.head_branch === q.get("branch") &&
          (!q.get("event") || r.event === q.get("event")) &&
          (!q.get("head_sha") || r.head_sha === q.get("head_sha")),
      )
      return json(200, { total_count: runs.length, workflow_runs: runs.map(({ jobs: _, ...r }) => r) })
    }
    if (parts[0] === "actions" && parts[1] === "runs" && parts[2]) {
      const run = this.runs.find((r) => r.id === Number(parts[2]))
      if (!run) return json(404, { message: "Not Found" })
      if (method === "GET" && parts[3] === "jobs") return json(200, { total_count: run.jobs.length, jobs: run.jobs })
      if (method === "POST" && parts[3] === "cancel") {
        if (run.status === "completed") return json(409, { message: "Cannot cancel a workflow run that is completed." })
        run.status = "completed"
        run.conclusion = "cancelled"
        return json(202, {})
      }
    }
    if (method === "POST" && parts[0] === "actions" && parts[1] === "workflows" && parts[3] === "dispatches") {
      assert.equal(Number(parts[2]), PIPELINE_ID, "the workflow the Release PR's own run belongs to")
      if (this.dispatchStatus >= 400) return json(this.dispatchStatus, { message: "Resource not accessible by integration" })
      return new Response(null, { status: 204 })
    }
    const pull = parts[0] === "issues" ? this.pulls.find((p) => p.number === Number(parts[1])) : undefined
    if (pull && parts[2] === "comments") {
      if (method === "GET") return json(200, pull.comments)
      if (method === "POST") {
        pull.comments.push({ body: String(body?.body), user: { login: BOT, type: "Bot" } })
        return json(201, {})
      }
    }
    return json(404, { message: `the fake does not answer ${method} ${url.pathname}` })
  }
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

function verify(w: World, over: { dryRun?: boolean; appSlug?: string | null } = {}) {
  return runVerify({
    client: w.client,
    repo: REPO,
    dryRun: over.dryRun ?? false,
    appSlug: over.appSlug === null ? undefined : (over.appSlug ?? "train-acme"),
  })
}

test("a Release PR that failed as not fully verified gets the full Check of its base started", async () => {
  const w = new World()
  const pull = w.unverified()
  const result = await verify(w)
  assert.equal(result.failed, false)
  assert.deepEqual(result.rows, [
    { number: pull.number, base: "dev", action: "started", reason: `the full Check of dev at ${TIP.slice(0, 7)}` },
  ])
  // One write: the Pipeline, dispatched on the base branch. A dispatch runs the full Check.
  assert.deepEqual(w.writes, [
    { method: "POST", path: `/repos/acme/widgets/actions/workflows/${PIPELINE_ID}/dispatches`, body: { ref: "dev" } },
  ])
})

test("a repository whose only branch is main is verified on main", async () => {
  const w = new World()
  w.branches.clear()
  w.branches.set("main", TIP)
  const pull = w.unverified("main")
  const result = await verify(w)
  assert.deepEqual(
    result.rows.map((r) => [r.number, r.base, r.action]),
    [[pull.number, "main", "started"]],
  )
  assert.deepEqual(w.dispatches(), [{ ref: "main" }])
})

test("one commit is verified once: a full Check that is queued or running is the answer", async () => {
  for (const status of ["queued", "in_progress", "requested", "waiting", "pending"]) {
    const w = new World()
    w.unverified()
    // Whoever started it: a person's dispatch counts like the train's own.
    w.run({ head_sha: TIP, status, conclusion: null, triggering_actor: { login: "octocat" } })
    const result = await verify(w)
    assert.equal(result.rows[0]?.action, "running", status)
    assert.deepEqual(w.writes, [], status)
  }
})

test("a tip that passed the full Check is left to Recheck, by a dispatch or by the nightly run", async () => {
  for (const event of ["workflow_dispatch", "schedule"]) {
    const w = new World()
    w.unverified()
    w.run({ head_sha: TIP, event })
    const result = await verify(w)
    assert.equal(result.rows[0]?.action, "verified", event)
    assert.match(String(result.rows[0]?.reason), /Recheck/)
    assert.deepEqual(w.writes, [], event)
  }
})

test("only a full Check of the tip counts: not a push run, not another workflow, not another branch or commit", async () => {
  const w = new World()
  w.unverified()
  w.run({ head_sha: TIP, event: "push" }) // the fast Check after the merge
  w.run({ head_sha: TIP, event: "pull_request", head_branch: "feat/x" })
  w.run({ head_sha: TIP, name: "Train", workflow_id: 7002 })
  w.run({ head_sha: TIP, head_branch: "main" }) // the same commit, dispatched on another branch
  w.run({ head_sha: OLD_TIP, triggering_actor: { login: "octocat" } }) // the commit before
  const result = await verify(w)
  assert.equal(result.rows[0]?.action, "started")
  assert.deepEqual(w.dispatches(), [{ ref: "dev" }])
})

test("a red full Check is a defect on the base: said once on the Release PR, never repeated", async () => {
  const w = new World()
  const pull = w.unverified()
  const red = w.run({ head_sha: TIP, conclusion: "failure", jobs: failedAt("Test") })

  const first = await verify(w)
  assert.equal(first.failed, false, "a red base is not Verify's failure")
  assert.equal(first.rows[0]?.action, "failed")
  assert.match(String(first.rows[0]?.reason), new RegExp(`failed in Test \\(run ${red.id}\\); it is not repeated`))
  assert.deepEqual(w.dispatches(), [], "the same commit fails the same way")
  assert.equal(pull.comments.length, 1)
  const body = String(pull.comments[0]?.body)
  assert.match(body, new RegExp(`The full Check of \`dev\` at \`${TIP.slice(0, 7)}\` failed in Test`))
  assert.ok(body.includes(`[run ${red.id}](${red.html_url})`))
  assert.match(body, /a fix through a pull request/)
  assert.match(body, /If the failure was a flake, re-run the failed job of that run/)
  assert.ok(body.includes(failedMarker(TIP)))

  const second = await verify(w)
  assert.equal(second.rows[0]?.action, "failed")
  assert.equal(pull.comments.length, 1, "one comment per commit")

  // The fix merged: a new tip, a new Release PR run, and the new tip is verified.
  w.branches.set("dev", "d".repeat(40))
  const third = await verify(w)
  assert.equal(third.rows[0]?.action, "started")
})

test("a person's comment that quotes the marker does not silence the train's own", async () => {
  const w = new World()
  const pull = w.unverified()
  w.run({ head_sha: TIP, conclusion: "failure" })
  pull.comments.push({ body: failedMarker(TIP), user: { login: "octocat", type: "User" } })
  const result = await verify(w)
  // A job that names no failed step is reported without one.
  assert.match(String(result.rows[0]?.reason), /failed \(run \d+\)/)
  assert.equal(pull.comments.length, 2)
  assert.doesNotMatch(String(pull.comments[1]?.body), /failed in/)
})

test("the full Checks this App started for a commit the base has left behind are cancelled", async () => {
  const w = new World()
  w.unverified()
  const overtaken = w.run({ head_sha: OLD_TIP, status: "in_progress", conclusion: null })
  const queued = w.run({ head_sha: OLD_TIP, status: "queued", conclusion: null })
  const byHand = w.run({ head_sha: OLD_TIP, status: "in_progress", conclusion: null, triggering_actor: { login: "octocat" } })
  const done = w.run({ head_sha: OLD_TIP, conclusion: "failure" })
  const nightly = w.run({ head_sha: OLD_TIP, event: "schedule", status: "in_progress", conclusion: null })

  const result = await verify(w)
  assert.deepEqual(result.rows[0]?.cancelled, [overtaken.id, queued.id])
  assert.equal(result.rows[0]?.action, "started", "and the tip gets its own")
  assert.deepEqual(w.cancels(), [overtaken.id, queued.id])
  assert.deepEqual(
    w.writes.map((x) => x.path.split("/").at(-1)),
    ["cancel", "cancel", "dispatches"],
    "cancelled first: the caller queues a dispatch behind the one before it",
  )
  for (const run of [byHand, done, nightly]) assert.ok(!w.cancels().includes(run.id), `run ${run.id} is not the train's to cancel`)
})

test("without the App's name nothing is cancelled", async () => {
  const w = new World()
  w.unverified()
  w.run({ head_sha: OLD_TIP, status: "in_progress", conclusion: null })
  const result = await verify(w, { appSlug: null })
  assert.equal(result.rows[0]?.cancelled, undefined)
  assert.deepEqual(w.cancels(), [])
  assert.equal(result.rows[0]?.action, "started")
})

test("a run that finished before it could be cancelled is not an error", async () => {
  const w = new World()
  w.unverified()
  const run = w.run({ head_sha: OLD_TIP, status: "in_progress", conclusion: null })
  // Between the listing and the cancel the run ends: GitHub answers 409.
  const fetch = w.client
  const original = fetch.rest.bind(fetch)
  fetch.rest = (async (method: string, path: string, opts?: never) => {
    if (method === "POST" && path.endsWith("/cancel")) run.status = "completed"
    return original(method, path, opts)
  }) as typeof fetch.rest
  const result = await verify(w)
  assert.equal(result.failed, false)
  assert.equal(result.rows[0]?.action, "started")
})

test("the tip's own full Check is never cancelled", async () => {
  const w = new World()
  w.unverified()
  w.run({ head_sha: TIP, status: "in_progress", conclusion: null })
  const result = await verify(w)
  assert.equal(result.rows[0]?.action, "running")
  assert.deepEqual(w.writes, [])
})

test("a full Check that ended without a verdict is started again, but not for ever", async () => {
  const w = new World()
  w.unverified()
  w.run({ head_sha: TIP, conclusion: "cancelled" })
  const again = await verify(w)
  assert.equal(again.rows[0]?.action, "started", "one lost run: a runner outage, try once more")

  w.run({ head_sha: TIP, conclusion: "timed_out" })
  assert.equal(MAX_LOST_RUNS, 2)
  const stop = await verify(w)
  assert.equal(stop.rows[0]?.action, "gave_up")
  assert.match(String(stop.rows[0]?.reason), /2 full Checks of dev at aaaaaaa ended without a verdict \(timed_out, cancelled\)/)
  assert.equal(w.dispatches().length, 1, "no third run")
  assert.equal(stop.failed, false)
})

test("a Release PR that is not red as not fully verified is left alone", async () => {
  const cases: [string, (w: World) => void, RegExp][] = [
    ["no run yet", (w) => void w.releasePull(), /no Pipeline run on its head ccccccc yet/],
    [
      "still running",
      (w) => void w.releaseRun(w.releasePull(), UNVERIFIED_STEP, { status: "in_progress", conclusion: null }),
      /not finished/,
    ],
    ["green", (w) => void w.releaseRun(w.releasePull(), UNVERIFIED_STEP, { conclusion: "success", jobs: [] }), /concluded success/],
    ["cancelled", (w) => void w.releaseRun(w.releasePull(), UNVERIFIED_STEP, { conclusion: "cancelled" }), /concluded cancelled/],
    ["failed in the secret scan", (w) => void w.releaseRun(w.releasePull(), "Secret scan"), /failed in Secret scan, not as "Not fully verified"/],
    [
      "Guard failed",
      (w) =>
        void w.releaseRun(w.releasePull(), UNVERIFIED_STEP, {
          jobs: [{ id: 1, name: "pipeline / Guard", conclusion: "failure" }],
        }),
      /its failed job is not pipeline \/ Check/,
    ],
    [
      "the runner went away",
      (w) => void w.releaseRun(w.releasePull(), UNVERIFIED_STEP, { jobs: [{ id: 2, name: CHECK, conclusion: "failure" }] }),
      /failed in no step it names/,
    ],
  ]
  for (const [name, arrange, reason] of cases) {
    const w = new World()
    arrange(w)
    const result = await verify(w)
    assert.equal(result.rows[0]?.action, "skipped", name)
    assert.match(String(result.rows[0]?.reason), reason, name)
    assert.deepEqual(w.writes, [], name)
  }
})

test("the newest run on the Release PR's head is the one that speaks", async () => {
  const w = new World()
  const pull = w.releasePull()
  w.releaseRun(pull) // red first …
  w.releaseRun(pull, UNVERIFIED_STEP, { conclusion: "success", jobs: [] }) // … green after the re-run on a new event
  const result = await verify(w)
  assert.equal(result.rows[0]?.action, "skipped")
  assert.deepEqual(w.writes, [])
})

test("only the train's own Release PR counts: not a fork's branch of that name, not another head", async () => {
  const w = new World()
  w.releaseRun(w.releasePull({ fork: true }))
  w.releaseRun(w.releasePull({ head: "release/main", sha: "e".repeat(40) })) // into dev: not release/dev
  w.releaseRun(w.releasePull({ head: "feat/release/dev", sha: "f".repeat(40) }))
  const result = await verify(w)
  assert.deepEqual(result.rows, [])
  assert.deepEqual(w.writes, [])
})

test("a Release PR whose base branch is gone is skipped", async () => {
  const w = new World()
  w.unverified()
  w.branches.clear()
  const result = await verify(w)
  assert.equal(result.rows[0]?.action, "skipped")
  assert.match(String(result.rows[0]?.reason), /the branch dev does not exist/)
})

test("every open Release PR is looked at, in order, beyond the first page of pull requests", async () => {
  const w = new World()
  for (let i = 0; i < 100; i++) w.releasePull({ head: `feat/n${i}`, sha: String(i).padStart(40, "0") })
  w.branches.set("main", OLD_TIP)
  const onMain = w.releasePull({ base: "main", sha: "e".repeat(40) })
  w.releaseRun(onMain)
  const onDev = w.unverified()
  const result = await verify(w)
  assert.deepEqual(
    result.rows.map((r) => [r.number, r.base, r.action]),
    [
      [onMain.number, "main", "started"],
      [onDev.number, "dev", "started"],
    ],
  )
  assert.deepEqual(w.dispatches(), [{ ref: "main" }, { ref: "dev" }])
})

test("a dry run decides and writes nothing", async () => {
  const w = new World()
  const pull = w.unverified()
  w.run({ head_sha: OLD_TIP, status: "in_progress", conclusion: null })
  const start = await verify(w, { dryRun: true })
  assert.equal(start.rows[0]?.action, "started")
  assert.match(String(start.rows[0]?.reason), /^dry run: would start/)
  assert.equal(start.rows[0]?.cancelled?.length, 1, "what it would cancel is named")

  w.run({ head_sha: TIP, conclusion: "failure" })
  const red = await verify(w, { dryRun: true })
  assert.equal(red.rows[0]?.action, "failed")
  assert.match(String(red.rows[0]?.reason), /^dry run:/)
  assert.equal(pull.comments.length, 0)
  assert.deepEqual(w.writes, [])
})

test("a dispatch GitHub refuses is reported and fails the run; it is not retried as an error", async () => {
  for (const status of [403, 404, 422]) {
    const w = new World()
    w.unverified()
    w.dispatchStatus = status
    const result = await verify(w)
    assert.equal(result.rows[0]?.action, "refused", String(status))
    assert.match(String(result.rows[0]?.reason), /GitHub refused to start the full Check of dev at aaaaaaa/)
    assert.equal(result.failed, true, "an App without the Actions permission must not pass in silence")
    assert.equal(result.error, undefined)
  }
})

test("an unexpected error ends the run, with the rows so far", async () => {
  const w = new World()
  w.unverified()
  w.dispatchStatus = 500
  const result = await verify(w)
  assert.equal(result.failed, true)
  assert.deepEqual(result.rows, [])
  assert.match(String((result.error as Error).message), /500/)
})

// ---- the entry -------------------------------------------------------------

function io(w: World, env: Record<string, string | undefined> = {}, argv: string[] = []) {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/widgets", TRAIN_APP_SLUG: "train-acme", ...env },
      argv,
      out: (line: string) => void out.push(line),
      err: (line: string) => void err.push(line),
      client: w.client,
    },
  }
}

test("the entry prints one JSON line per Release PR and exits 0", async () => {
  const w = new World()
  const pull = w.unverified()
  w.run({ head_sha: OLD_TIP, status: "in_progress", conclusion: null })
  const run = io(w)
  assert.equal(await verifyMain(run.io), 0)
  assert.deepEqual(run.err, [])
  assert.equal(run.out.length, 1)
  const row = JSON.parse(String(run.out[0]))
  assert.deepEqual(Object.keys(row), ["number", "base", "action", "reason", "cancelled"])
  assert.equal(row.number, pull.number)
  assert.equal(row.action, "started")
  assert.equal(w.cancels().length, 1, "TRAIN_APP_SLUG names whose runs may be cancelled")
})

test("the entry has nothing to say without a Release PR, and honours TRAIN_DRY_RUN", async () => {
  const none = io(new World())
  assert.equal(await verifyMain(none.io), 0)
  assert.deepEqual(none.out, [])

  const w = new World()
  w.unverified()
  const dry = io(w, { TRAIN_DRY_RUN: "1" })
  assert.equal(await verifyMain(dry.io), 0)
  assert.match(String(JSON.parse(String(dry.out[0])).reason), /^dry run:/)
  assert.deepEqual(w.writes, [])
})

test("a refused dispatch is exit 1; a missing token or a stray flag is exit 2", async () => {
  const w = new World()
  w.unverified()
  w.dispatchStatus = 403
  const refused = io(w)
  assert.equal(await verifyMain(refused.io), 1)
  assert.equal(JSON.parse(String(refused.out[0])).action, "refused")

  const noToken = io(new World(), { GITHUB_TOKEN: "" })
  assert.equal(await verifyMain(noToken.io), 2)
  assert.match(String(noToken.err[0]), /verify: GITHUB_TOKEN is not set/)
  const flag = io(new World(), {}, ["--force"])
  assert.equal(await verifyMain(flag.io), 2)
})

test("--quiet prints counts and no name: the log may be public", async () => {
  const w = new World()
  w.unverified()
  w.dispatchStatus = 403
  const quiet = io(w, {}, ["--quiet"])
  assert.equal(await verifyMain(quiet.io), 1)
  assert.equal(quiet.out.length, 1)
  const counts = JSON.parse(String(quiet.out[0]))
  assert.deepEqual(Object.keys(counts), [...VERIFY_ACTIONS])
  assert.equal(counts.refused, 1)
  const said = [...quiet.out, ...quiet.err].join("\n")
  assert.doesNotMatch(said, /dev|aaaaaaa|#?4\d\b|release\//, "no branch, commit or pull request")
})
