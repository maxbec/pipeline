import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { attemptMarker, MAX_ATTEMPTS, NEVER_PATCHED, OWN_FAILURE_STEPS, triageFailure } from "../../src/fix/triage.ts"
import { CHECK, FixWorld, stepsFailingAt } from "./fix-world.ts"

let n = 0
/** A world with one open pull request whose Check failed on its head, second attempt. */
function red(over: Parameters<FixWorld["pull"]>[2] = {}, branch = "feat/x") {
  const w = new FixWorld(`triage-${++n}`)
  const { pull, headSha } = w.pull(branch, { "src/a.ts": "export const a = 1\n" }, over)
  w.run(7, headSha, branch, { run_attempt: 2 })
  return { w, pull, headSha, triage: () => triageFailure(w.client, w.repo, { id: 7 }) }
}

test("a run that is not a pull request's is left alone", async () => {
  const { w, triage } = red()
  w.runs.get(7)!.event = "push"
  const t = await triage()
  assert.equal(t.action, "none")
  assert.match(t.action === "none" ? t.reason : "", /pull_request/)
})

test("only a conclusion of exactly failure counts", async () => {
  for (const conclusion of ["cancelled", "timed_out", "success", "skipped", "action_required", null]) {
    const { w, triage } = red()
    w.runs.get(7)!.conclusion = conclusion
    assert.equal((await triage()).action, "none", String(conclusion))
  }
})

test("a fork's run is left alone", async () => {
  const { w, triage } = red()
  w.runs.get(7)!.head_repository = "mallory/triage"
  const t = await triage()
  assert.equal(t.action, "none")
  assert.match(t.action === "none" ? t.reason : "", /fork|another repository/)
})

test("no open pull request for the branch, or two, is left alone", async () => {
  const none = red()
  none.pull.state = "closed"
  assert.equal((await none.triage()).action, "none")

  const two = red()
  const copy = { ...two.pull, number: 2 }
  two.w.gh.pulls.set(2, copy)
  two.w.extras.set(2, { draft: false, labels: [], files: [], comments: [] })
  assert.equal((await two.triage()).action, "none")
})

test("a head that moved since the run is left alone", async () => {
  const { w, triage } = red()
  w.commit("feat/x", { "src/a.ts": "export const a = 2\n" })
  const t = await triage()
  assert.equal(t.action, "none")
  assert.match(t.action === "none" ? t.reason : "", /moved/)
})

test("release, promotion, backmerge and hotfix heads are never patched", async () => {
  for (const branch of ["release/dev", "promote/main", "backmerge/1.2.0", "hotfix/urgent"]) {
    const t = await red({}, branch).triage()
    assert.equal(t.action, "none", branch)
  }
})

test("Dependabot's pull requests are never patched", async () => {
  assert.equal((await red({ author: "dependabot[bot]" }).triage()).action, "none")
})

test("a draft, a held pull request and one waiting for a person are left alone", async () => {
  assert.equal((await red({ draft: true }).triage()).action, "none")
  assert.equal((await red({ labels: ["hold"] }).triage()).action, "none")
  assert.equal((await red({ labels: ["needs-human"] }).triage()).action, "none")
})

test("a failed Guard is not something to patch", async () => {
  const { w, triage } = red()
  w.jobs.set(7, [
    { id: 71, name: "pipeline / Guard", conclusion: "failure" },
    { id: 72, name: CHECK, conclusion: "skipped" },
  ])
  const t = await triage()
  assert.equal(t.action, "none")
  assert.match(t.action === "none" ? t.reason : "", /pipeline \/ Check/)
})

test("the first attempt of a run is rerun, and nothing is read from the pull request's comments", async () => {
  const { w, triage } = red()
  w.runs.get(7)!.run_attempt = 1
  assert.deepEqual(await triage(), { action: "rerun" })
  assert.equal(w.reruns.length, 0, "the decision alone; the caller reruns")
})

/** A world whose Check failed on the run's first attempt, in `failedStep` (none named when omitted). */
function firstRed(failedStep?: string) {
  const w = new FixWorld(`triage-${++n}`)
  const { pull, headSha } = w.pull("feat/x", { "src/a.ts": "export const a = 1\n" })
  w.run(7, headSha, "feat/x", failedStep === undefined ? {} : { failedStep })
  return { w, pull, headSha, triage: () => triageFailure(w.client, w.repo, { id: 7 }) }
}

test("a first failure in Lint, Test or Build is not rerun: the same commit fails the same way", async () => {
  // edilio, 2026-11-15: six reruns of a red Check, none recovered. Each was a
  // test or a lint failure, and each rerun billed a whole Check again.
  assert.deepEqual(OWN_FAILURE_STEPS, ["Lint", "Lint (trunk)", "Test", "Build"])
  for (const step of OWN_FAILURE_STEPS) {
    const { w, pull, headSha, triage } = firstRed(step)
    assert.deepEqual(
      await triage(),
      { action: "propose", pr: pull.number, headSha, attempt: 1, jobId: 72, branch: "feat/x", title: "feat: a change" },
      step,
    )
    assert.equal(w.reruns.length, 0, step)
  }
})

test("a first failure anywhere else is rerun: a lost runner, a registry, a cache", async () => {
  for (const step of ["Set up job", "Checkout", "Secret scan", "Install dependencies", "Restore the build cache"]) {
    assert.deepEqual(await firstRed(step).triage(), { action: "rerun" }, step)
  }
  // A job that failed without a failed step — the runner went away — and one
  // whose steps the API does not list.
  const lost = firstRed()
  lost.w.jobs.set(7, [{ id: 72, name: CHECK, conclusion: "failure", steps: [{ name: "Test", conclusion: "cancelled" }] }])
  assert.deepEqual(await lost.triage(), { action: "rerun" })
  assert.deepEqual(await firstRed().triage(), { action: "rerun" })
})

test("the step that failed first decides, not one that failed in its wake", async () => {
  const tests = firstRed()
  tests.w.jobs.set(7, [
    {
      id: 72,
      name: CHECK,
      conclusion: "failure",
      steps: [
        { name: "Test", conclusion: "failure" },
        { name: "Upload test artifacts", conclusion: "failure" },
      ],
    },
  ])
  assert.equal((await tests.triage()).action, "propose")

  const install = firstRed()
  install.w.jobs.set(7, [
    {
      id: 72,
      name: CHECK,
      conclusion: "failure",
      steps: [
        { name: "Install dependencies", conclusion: "failure" },
        { name: "Build", conclusion: "skipped" },
        { name: "Save the build cache", conclusion: "failure" },
      ],
    },
  ])
  assert.deepEqual(await install.triage(), { action: "rerun" })
})

test("a first failure that is not rerun still counts the attempts already made", async () => {
  const second = firstRed("Test")
  second.w.comment(1, attemptMarker(1))
  const t = await second.triage()
  assert.equal(t.action === "propose" ? t.attempt : 0, 2)

  const spent = firstRed("Build")
  for (let i = 1; i <= MAX_ATTEMPTS; i++) spent.w.comment(1, attemptMarker(i))
  assert.equal((await spent.triage()).action, "give_up")
})

test("after its rerun a run goes on to the proposal whatever the step", async () => {
  for (const step of ["Install dependencies", "Test"]) {
    const { w, triage } = red()
    w.jobs.set(7, [{ id: 72, name: CHECK, conclusion: "failure", steps: stepsFailingAt(step) }])
    assert.equal((await triage()).action, "propose", step)
  }
})

test("the workflow starts no triage runner for a head triage never patches", () => {
  // triage answers `none` for these heads anyway; the job's condition keeps
  // the runner from starting. A Release PR over a base that is not fully
  // verified is red by design, and every such run would bill a minute here.
  const file = new URL("../../../.github/workflows/train.yaml", import.meta.url)
  const cond = String(parse(readFileSync(file, "utf8")).jobs["fix-triage"].if).replace(/\s+/g, " ")
  assert.deepEqual(NEVER_PATCHED, ["release/", "promote/", "backmerge/", "hotfix/"])
  for (const prefix of NEVER_PATCHED) {
    assert.ok(
      cond.includes(`!startsWith(github.event.workflow_run.head_branch, '${prefix}')`),
      `${prefix} is missing from: ${cond}`,
    )
  }
  assert.equal(cond.match(/startsWith\(/g)?.length, NEVER_PATCHED.length, "and no other head is kept out")
})

test("still red after the rerun: propose, numbered by the marker comments a Bot left", async () => {
  const first = red()
  assert.deepEqual(await first.triage(), {
    action: "propose",
    pr: first.pull.number,
    headSha: first.headSha,
    attempt: 1,
    jobId: 72,
    branch: "feat/x",
    title: "feat: a change",
  })

  const third = red()
  third.w.comment(1, `${attemptMarker(1)}\nfirst`)
  third.w.comment(1, `${attemptMarker(2)}\nsecond`)
  // A person quoting the marker does not use up an attempt.
  third.w.comment(1, attemptMarker(3), "User")
  third.w.comment(1, "an unrelated comment")
  const t = await third.triage()
  assert.equal(t.action === "propose" ? t.attempt : 0, 3)
})

test("after three attempts the train gives up", async () => {
  const { w, pull, triage } = red()
  // More comments than one page holds, so the count has to read every page.
  for (let i = 0; i < 120; i++) w.comment(1, `noise ${i}`)
  for (let i = 1; i <= MAX_ATTEMPTS; i++) w.comment(1, attemptMarker(i))
  const t = await triage()
  assert.equal(t.action, "give_up")
  assert.equal(t.action === "give_up" ? t.pr : 0, pull.number)
  assert.match(t.action === "give_up" ? t.reason : "", /3/)
})
