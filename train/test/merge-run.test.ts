import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { mergeMain, NEEDS_HUMAN_LABEL, runMerge } from "../src/merge-run.ts"
import { scratchDir } from "./helpers/scratch.ts"
import { type World, world } from "./helpers/world.ts"
import { git } from "./workflow/fake-github.ts"

const home = scratchDir("train-merge-run-")

/** A feature PR with one commit of its own. */
async function feature(
  w: World,
  head: string,
  title: string,
  files?: Record<string, string>,
  base = "dev",
): Promise<number> {
  w.branch(head, base, files)
  return w.open(head, base, title)
}

function run(w: World, dryRun = false) {
  return runMerge({ client: w.gh.client, repo: w.repo, dryRun })
}

/** The REST writes the run made; reads and GraphQL queries are not writes. */
function writes(w: World, from = 0): string[] {
  return w.gh.calls
    .slice(from)
    .filter((c) => c.method !== "GET" && c.path !== "/graphql")
    .map((c) => `${c.method} ${c.path}`)
}

function row(
  result: { rows: { number: number; action: string; reason: string }[] },
  number: number,
) {
  const found = result.rows.find((r) => r.number === number)
  assert.ok(found, `no row for #${number}`)
  return found
}

test("a green feature PR is squash-merged, pinned to its head, and the merge commit is verified", async () => {
  const w = world(home, "green")
  const number = await feature(w, "feat/endpoint", "feat: the endpoint")
  const head = w.gh.sha("feat/endpoint")

  const result = await run(w)
  assert.equal(result.failed, false)
  assert.equal(row(result, number).action, "merged")
  const pull = w.gh.pulls.get(number)
  assert.equal(pull?.merged, true)
  const merge = w.gh.calls.find(
    (c) => c.method === "PUT" && c.path.endsWith(`/pulls/${number}/merge`),
  )
  assert.deepEqual(merge?.body, {
    merge_method: "squash",
    sha: head,
    commit_title: `feat: the endpoint (#${number})`,
    commit_message: "",
  })
  assert.equal(
    git(w.gh.origin, "log", "-1", "--format=%s", "dev"),
    `feat: the endpoint (#${number})`,
  )
  assert.ok(
    w.gh.calls.some((c) => c.method === "GET" && c.path.endsWith(`/commits/${pull?.mergeSha}`)),
    "the merge commit's signature was read back",
  )
})

test("a merge commit GitHub did not verify fails the run", async () => {
  const w = world(home, "unverified")
  const number = await feature(w, "feat/endpoint", "feat: the endpoint")
  w.gh.onMerged = (_pull, sha) => w.gh.signed.delete(sha)
  const result = await run(w)
  assert.equal(result.failed, true)
  assert.equal(row(result, number).action, "merged")
  assert.match(row(result, number).reason, /not verified/)
})

test("a held PR is not merged, however green", async () => {
  const w = world(home, "hold")
  const number = await feature(w, "feat/endpoint", "feat: the endpoint")
  const pull = w.gh.pulls.get(number)
  if (pull) pull.labels = ["hold"]
  const result = await run(w)
  assert.equal(row(result, number).action, "skipped")
  assert.match(row(result, number).reason, /hold/)
  assert.equal(pull?.merged, false)
  assert.deepEqual(writes(w), [`POST /repos/acme/hold/pulls`])
})

test("a Release PR is never merged, even when green; nor a promotion, a hotfix or a draft", async () => {
  const w = world(home, "release")
  const release = await feature(w, "release/dev", "chore(release): 1.3.0-beta.1")
  const promotion = await feature(w, "promote/main", "chore(release): 1.3.0", undefined, "main")
  const hotfix = await feature(w, "hotfix/login", "fix: the login", undefined, "main")
  const draft = await feature(w, "feat/wip", "feat: not yet")
  const drafted = w.gh.pulls.get(draft)
  if (drafted) drafted.draft = true
  const before = w.gh.calls.length

  const result = await run(w)
  assert.equal(result.failed, false)
  for (const number of [release, promotion, hotfix, draft]) {
    assert.equal(row(result, number).action, "skipped", `#${number}`)
    assert.equal(w.gh.pulls.get(number)?.merged, false, `#${number}`)
  }
  assert.deepEqual(writes(w, before), [])
})

test("a PR that changes a workflow gets needs-human and a comment, once, and no merge", async () => {
  const w = world(home, "workflow")
  const number = await feature(w, "feat/ci", "ci: a faster check", {
    ".github/workflows/x.yaml": "name: X\n",
  })
  const first = await run(w)
  assert.equal(first.failed, false)
  assert.equal(row(first, number).action, "needs_human")
  assert.match(row(first, number).reason, /\.github\/workflows\/x\.yaml/)
  const pull = w.gh.pulls.get(number)
  assert.equal(pull?.merged, false)
  assert.deepEqual(pull?.labels, [NEEDS_HUMAN_LABEL])
  assert.ok(w.gh.labels.has(NEEDS_HUMAN_LABEL), "the label exists in the repository")
  assert.equal(pull?.comments?.length, 1)
  assert.match(pull?.comments?.[0]?.body ?? "", /\.github\/workflows\/x\.yaml/)

  // Idempotent: the second run reports the same and writes nothing.
  const before = w.gh.calls.length
  const second = await run(w)
  assert.equal(row(second, number).action, "needs_human")
  assert.deepEqual(writes(w, before), [])
  assert.equal(pull?.comments?.length, 1)
  assert.equal(pull?.merged, false)
})

test("a dry run merges nothing and writes nothing", async () => {
  const w = world(home, "dry")
  const green = await feature(w, "feat/endpoint", "feat: the endpoint")
  const workflow = await feature(w, "feat/ci", "ci: a faster check", {
    ".github/pipeline.yaml": "version: '3'\n",
  })
  const before = w.gh.calls.length
  const result = await run(w, true)
  assert.equal(result.failed, false)
  assert.equal(row(result, green).action, "merged")
  assert.match(row(result, green).reason, /^dry run/)
  assert.equal(row(result, workflow).action, "needs_human")
  assert.deepEqual(writes(w, before), [])
  assert.equal(w.gh.pulls.get(green)?.merged, false)
  assert.equal(w.gh.pulls.get(workflow)?.labels, undefined)
})

test("a red or pending Check blocks; nothing is merged", async () => {
  const w = world(home, "red")
  const number = await feature(w, "feat/endpoint", "feat: the endpoint")
  w.gh.checks = "failure"
  const red = await run(w)
  assert.equal(row(red, number).action, "blocked")
  assert.equal(red.failed, false, "a blocked PR is not a failed run")
  w.gh.checks = "pending"
  assert.equal(row(await run(w), number).action, "blocked")
  assert.equal(w.gh.pulls.get(number)?.merged, false)
})

test("a PR behind a base that demands it gets its branch updated, once, and is not merged in that run", async () => {
  const w = world(home, "behind")
  const number = await feature(w, "feat/endpoint", "feat: the endpoint")
  w.land("fix: something else (#9)")
  const pull = w.gh.pulls.get(number)
  const result = await run(w)
  assert.equal(row(result, number).action, "updated", JSON.stringify(result.rows))
  assert.equal(pull?.merged, false)
  assert.equal(writes(w).filter((c) => c.endsWith("/update-branch")).length, 1)
  // The head now contains the base; the next run merges it.
  assert.equal(row(await run(w), number).action, "merged")
})

test("while a merged Release PR waits for its tag, nothing merges into that base", async () => {
  const w = world(home, "waiting")
  w.branch("release/dev", "dev", undefined, "chore(release): 1.3.0-beta.1")
  const release = await w.open("release/dev", "dev", "chore(release): 1.3.0-beta.1")
  const mergeSha = await w.button(release, "squash")
  const number = await feature(w, "feat/endpoint", "feat: the endpoint")

  const held = await run(w)
  assert.equal(row(held, number).action, "waiting")
  assert.match(row(held, number).reason, /1\.3\.0-beta\.1/)
  assert.equal(w.gh.pulls.get(number)?.merged, false)

  git(w.gh.origin, "tag", "v1.3.0-beta.1", mergeSha)
  assert.equal(row(await run(w), number).action, "merged")
})

test("a backmerge into dev merges by merge commit; a Dependabot major does not merge at all", async () => {
  const w = world(home, "kinds")
  // The head `openBackmerge` builds is a merge on top of dev; one commit over dev stands in for it.
  w.branch("backmerge/v1.2.1", "dev", undefined, "chore: backmerge v1.2.1")
  const backmerge = await w.open("backmerge/v1.2.1", "dev", "chore: backmerge v1.2.1 into dev")
  const major = await feature(
    w,
    "dependabot/npm/left-pad-2.0.0",
    "chore(deps): bump left-pad from 1.2.0 to 2.0.0",
  )
  const minor = await feature(
    w,
    "dependabot/npm/right-pad-1.3.0",
    "chore(deps): bump right-pad from 1.2.0 to 1.3.0",
  )
  for (const number of [major, minor]) {
    const pull = w.gh.pulls.get(number)
    if (pull) pull.author = "dependabot[bot]"
  }

  const result = await run(w)
  assert.equal(row(result, backmerge).action, "merged", JSON.stringify(result.rows))
  const merge = w.gh.calls.find(
    (c) => c.method === "PUT" && c.path.endsWith(`/pulls/${backmerge}/merge`),
  )
  assert.equal((merge?.body as { merge_method?: string } | undefined)?.merge_method, "merge")
  assert.equal(row(result, major).action, "skipped")
  assert.equal(w.gh.pulls.get(major)?.merged, false)
  // The minor bump is the train's to merge; right after another merge GitHub
  // may still call it behind, so only "not skipped" is asserted here.
  assert.notEqual(row(result, minor).action, "skipped")
})

test("a small repository merges feature work into main", async () => {
  const w = world(home, "small", "small")
  const number = await feature(w, "feat/endpoint", "feat: the endpoint", undefined, "main")
  const result = await run(w)
  assert.equal(row(result, number).action, "merged")
})

// ---- the entry: environment, output, exit codes ---------------------------

function entry(w: World | null, env: Record<string, string>, argv: string[] = []) {
  const out: string[] = []
  const err: string[] = []
  const code = mergeMain({
    env: {
      GITHUB_TOKEN: "t",
      ...(w ? { GITHUB_REPOSITORY: `${w.repo.owner}/${w.repo.name}` } : {}),
      ...env,
    },
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(w ? { client: w.gh.client } : {}),
  })
  return { out, err, code }
}

test("the entry prints one JSON line per PR, writes the step summary, and exits 0", async () => {
  const w = world(home, "entry")
  const merged = await feature(w, "feat/endpoint", "feat: the endpoint")
  const held = await feature(w, "feat/later", "feat: later")
  const pull = w.gh.pulls.get(held)
  if (pull) pull.labels = ["hold"]
  const summary = join(scratchDir("train-summary-"), "summary.md")
  writeFileSync(summary, "")

  const e = entry(w, { GITHUB_STEP_SUMMARY: summary })
  assert.equal(await e.code, 0)
  const lines = e.out.map(
    (l) => JSON.parse(l) as { number: number; action: string; reason: string },
  )
  assert.deepEqual(
    lines.map((l) => [l.number, l.action]),
    [
      [merged, "merged"],
      [held, "skipped"],
    ],
  )
  for (const line of lines) assert.deepEqual(Object.keys(line), ["number", "action", "reason"])
  const table = readFileSync(summary, "utf8")
  assert.match(table, /\| PR \| Action \| Reason \|/)
  assert.ok(table.includes(`| #${merged} | merged |`))
})

test("quiet prints the counts only: no number, no title, no branch, no reason", async () => {
  const w = world(home, "quiet")
  await feature(w, "feat/secret-endpoint", "feat: the secret endpoint")
  const held = await feature(w, "feat/later", "feat: later")
  const pull = w.gh.pulls.get(held)
  if (pull) pull.labels = ["hold"]
  const summary = join(scratchDir("train-summary-"), "summary.md")
  writeFileSync(summary, "")

  const e = entry(w, { GITHUB_STEP_SUMMARY: summary }, ["--quiet"])
  assert.equal(await e.code, 0)
  assert.deepEqual(e.err, [])
  assert.equal(e.out.length, 1)
  assert.deepEqual(JSON.parse(e.out[0] ?? ""), {
    merged: 1,
    updated: 0,
    waiting: 0,
    skipped: 1,
    needs_human: 0,
    blocked: 0,
  })
  for (const text of [e.out.join("\n"), readFileSync(summary, "utf8")]) {
    assert.doesNotMatch(text, /secret|later|feat|hold|#\d|quiet|acme/)
  }
})

test("quiet says nothing about an error either, and the exit code still does", async () => {
  const w = world(home, "quiet-error")
  await feature(w, "feat/secret-endpoint", "feat: the secret endpoint")
  w.gh.onMerged = (_pull, sha) => w.gh.signed.delete(sha)
  const e = entry(w, {}, ["--quiet"])
  assert.equal(await e.code, 1)
  assert.doesNotMatch([...e.out, ...e.err].join("\n"), /secret|feat|#\d|acme|verified/)

  // An unexpected error: the repository is not there.
  const gone = entry(w, { GITHUB_REPOSITORY: "acme/secret-other" }, ["--quiet"])
  assert.equal(await gone.code, 1)
  assert.doesNotMatch([...gone.out, ...gone.err].join("\n"), /secret|acme|not this repository/)
})

test("an unexpected error is exit 1 and is named when not quiet", async () => {
  const w = world(home, "error")
  const e = entry(w, { GITHUB_REPOSITORY: "acme/elsewhere" })
  assert.equal(await e.code, 1)
  assert.match(e.err.join("\n"), /elsewhere/)
})

test("TRAIN_DRY_RUN=1 merges nothing through the entry", async () => {
  const w = world(home, "entry-dry")
  const number = await feature(w, "feat/endpoint", "feat: the endpoint")
  const e = entry(w, { TRAIN_DRY_RUN: "1" })
  assert.equal(await e.code, 0)
  assert.equal(w.gh.pulls.get(number)?.merged, false)
})

test("a usage error is exit 2: no token, no repository, a malformed one, an unknown flag", async () => {
  const w = world(home, "usage")
  assert.equal(await entry(w, { GITHUB_TOKEN: "" }).code, 2)
  assert.equal(await entry(null, {}).code, 2)
  assert.equal(await entry(w, { GITHUB_REPOSITORY: "widgets" }).code, 2)
  assert.equal(await entry(w, {}, ["--force"]).code, 2)
  assert.deepEqual(writes(w), [])
})
