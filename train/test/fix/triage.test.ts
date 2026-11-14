import assert from "node:assert/strict"
import { test } from "node:test"
import { attemptMarker, MAX_ATTEMPTS, triageFailure } from "../../src/fix/triage.ts"
import { CHECK, FixWorld } from "./fix-world.ts"

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
