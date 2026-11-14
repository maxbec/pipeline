import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import {
  bumpKindOf,
  DEPENDABOT_LOGIN,
  DependabotMerger,
  type DependabotMergerDeps,
  type DependabotOutcome,
  SWEEP_EVERY_MS,
  SWEEP_JITTER_MS,
  UNKNOWN_REREAD_MS,
} from "../../src/github/dependabot.ts"
import { MAX_UPDATE_BRANCH_ROUNDS } from "../../src/github/update-behind.ts"
import type { GitHubEvent, Repository } from "../../src/types.ts"
import { repositoryOf } from "../helpers/repository.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { type FakeCommit, FakeGitHub, type FakePull, git } from "../workflow/fake-github.ts"

/**
 * The Dependabot merger over the fake GitHub: a real origin with
 * `dev` (and `main`), a Dependabot branch with one bump commit on it, and
 * one open PR. The merger reads the PR the way the engine does
 * (`getPrState`), so what the fake answers to the GraphQL read is what
 * decides; `gh.checks` is the Check.
 */

const home = scratchDir("train-dependabot-")

const HEAD = "dependabot/npm_and_yarn/dev/zod-4.2.0"
const TITLE = "chore(deps): bump zod from 4.1.0 to 4.2.0"
const MINOR_BODY = [
  "Bumps [zod](https://github.com/colinhacks/zod) from 4.1.0 to 4.2.0.",
  "",
  "---",
  "updated-dependencies:",
  "- dependency-name: zod",
  "  dependency-version: 4.2.0",
  "  dependency-type: direct:production",
  "  update-type: version-update:semver-minor",
  "...",
  "",
  "Signed-off-by: dependabot[bot] <support@github.com>",
].join("\n")

function repository(name: string, patch: Partial<Repository> = {}): Repository {
  return repositoryOf({
    owner: "acme",
    name,
    kind: "major",
    path: join(home, `${name}-clone`),
    ...patch,
  })
}

/**
 * A bare origin whose `dev` and `main` share one commit, a Dependabot
 * branch one bump ahead of `dev`, and one open PR over it. `moveBase`
 * pushes one more commit to the base afterwards, so the head is BEHIND.
 */
function setup(
  name: string,
  opts: {
    pull?: Partial<FakePull>
    repo?: Partial<Repository>
    body?: string
    moveBase?: boolean
    checks?: FakeGitHub["checks"]
    deps?: Partial<DependabotMergerDeps>
  } = {},
) {
  const origin = join(home, `${name}.git`)
  git(home, "init", "-q", "--bare", "-b", "dev", origin)
  const seed = join(home, `${name}-seed`)
  git(home, "clone", "-q", origin, seed)
  writeFileSync(join(seed, "package.json"), '{"dependencies":{"zod":"4.1.0"}}\n')
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "init")
  git(seed, "push", "-q", "origin", "dev", "dev:main")
  const base = opts.pull?.base ?? "dev"
  git(seed, "checkout", "-q", "-b", HEAD)
  writeFileSync(join(seed, "package.json"), '{"dependencies":{"zod":"4.2.0"}}\n')
  git(seed, "commit", "-q", "-am", `${opts.pull?.title ?? TITLE}\n\n${opts.body ?? MINOR_BODY}`)
  git(seed, "push", "-q", "origin", HEAD)
  if (opts.moveBase) {
    git(seed, "checkout", "-q", base)
    writeFileSync(join(seed, "README.md"), "# moved\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-q", "-m", "feat: something else landed")
    git(seed, "push", "-q", "origin", base)
  }
  const gh = new FakeGitHub({ origin, owner: "acme", name })
  gh.checks = opts.checks ?? "success"
  const commit: FakeCommit = {
    oid: gh.sha(HEAD) ?? "",
    headline: opts.pull?.title ?? TITLE,
    signed: true,
    body: opts.body ?? MINOR_BODY,
  }
  gh.pulls.set(1, {
    number: 1,
    title: TITLE,
    body: "Bumps zod from 4.1.0 to 4.2.0.",
    head: HEAD,
    base,
    state: "open",
    merged: false,
    mergeSha: null,
    reviews: [],
    threads: [],
    author: DEPENDABOT_LOGIN,
    commitLog: [commit],
    ...opts.pull,
  })
  const repo = repository(name, opts.repo)
  const lines: string[] = []
  const sleeps: number[] = []
  const merger = new DependabotMerger({
    clientFor: (company) => (company === "acme" ? gh.client : null),
    repositories: async () => [repo],
    log: (line) => lines.push(line),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...opts.deps,
  })
  return { gh, repo, merger, lines, sleeps, seed }
}

/**
 * Another open Dependabot PR `#n` off the same `dev`, bumping its own
 * package in its own file: it never conflicts with #1, but once #1 lands
 * it is behind.
 */
function sibling(ctx: { gh: FakeGitHub; seed: string }, n: number): void {
  const { gh, seed } = ctx
  const pkg = `pkg${n}`
  const branch = `dependabot/npm_and_yarn/dev/${pkg}-1.1.0`
  const title = `chore(deps): bump ${pkg} from 1.0.0 to 1.1.0`
  const body = MINOR_BODY.replaceAll("zod", pkg)
  git(seed, "fetch", "-q", "origin")
  git(seed, "checkout", "-q", "-B", branch, "origin/dev")
  writeFileSync(join(seed, `${pkg}.txt`), "1.1.0\n")
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", `${title}\n\n${body}`)
  git(seed, "push", "-q", "origin", branch)
  gh.pulls.set(n, {
    ...(gh.pulls.get(1) as FakePull),
    number: n,
    title,
    head: branch,
    threads: [],
    reviews: [],
    commitLog: [{ oid: gh.sha(branch) ?? "", headline: title, signed: true, body }],
  })
}

function event(repo: Repository, patch: Partial<GitHubEvent> = {}): GitHubEvent {
  return {
    id: 1,
    company: repo.company,
    owner: repo.owner,
    repo: repo.name,
    kind: "pull_request",
    action: "observed",
    number: 1,
    headSha: null,
    deliveryId: null,
    source: "poll",
    payload: {},
    receivedAt: "2026-10-22T10:00:00.000Z",
    ...patch,
  }
}

function calls(gh: FakeGitHub, method: string, suffix: string): number {
  return gh.calls.filter((c) => c.method === method && c.path.endsWith(suffix)).length
}

function merged(outcome: DependabotOutcome | null): Extract<DependabotOutcome, { kind: "merged" }> {
  assert.equal(outcome?.kind, "merged", JSON.stringify(outcome))
  return outcome as Extract<DependabotOutcome, { kind: "merged" }>
}

test("a green minor bump into dev is squash-merged through the App, pinned to its head, titled like the PR", async () => {
  const { gh, repo, merger, lines } = setup("green")
  const head = gh.sha(HEAD)
  const outcome = merged(await merger.onEvent(event(repo)))
  const pull = gh.pulls.get(1) as FakePull
  assert.equal(pull.merged, true)
  assert.equal(outcome.sha, pull.mergeSha)
  const merge = gh.calls.find((c) => c.method === "PUT" && c.path.endsWith("/pulls/1/merge"))
  assert.ok(merge, "merged through the pulls API")
  assert.deepEqual(
    (merge.body as Record<string, unknown>).merge_method,
    "squash",
    "feature work into dev squashes",
  )
  assert.equal((merge.body as Record<string, unknown>).sha, head, "pinned to the head it judged")
  assert.equal((merge.body as Record<string, unknown>).commit_title, `${TITLE} (#1)`)
  assert.equal(git(gh.origin, "log", "-1", "--format=%s", "dev"), `${TITLE} (#1)`)
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? "", /merged acme\/green#1/)
})

test("a red one waits, says why once per head, and merges nothing", async () => {
  const { gh, repo, merger, lines } = setup("red", { checks: "failure" })
  const first = await merger.onEvent(event(repo))
  assert.equal(first?.kind, "waiting")
  assert.equal((first as { code: string }).code, "checks_red")
  await merger.onEvent(event(repo, { id: 2, kind: "check_run", action: "changed" }))
  await merger.onEvent(event(repo, { id: 3, kind: "check_run", action: "changed" }))
  assert.equal((gh.pulls.get(1) as FakePull).merged, false)
  assert.equal(calls(gh, "PUT", "/pulls/1/merge"), 0)
  assert.equal(lines.length, 1, "the same head and reason are said once")
  assert.match(lines[0] ?? "", /waits: red checks: pipeline \/ Check/)
  // The Check goes green: the next event merges.
  gh.checks = "success"
  merged(await merger.onEvent(event(repo, { id: 4, kind: "check_run", action: "changed" })))
})

test("a head behind dev gets one branch update, then merges on the next event", async () => {
  const { gh, repo, merger } = setup("behind", { moveBase: true })
  const before = gh.sha(HEAD)
  const first = await merger.onEvent(event(repo))
  assert.equal(first?.kind, "updated_branch", JSON.stringify(first))
  assert.equal(calls(gh, "PUT", "/pulls/1/update-branch"), 1)
  assert.equal(calls(gh, "PUT", "/pulls/1/merge"), 0, "no merge on a head that was behind")
  assert.notEqual(gh.sha(HEAD), before, "GitHub brought the head forward")
  // The update made a new head; its event finds it current and merges it.
  merged(await merger.onEvent(event(repo, { id: 2, action: "changed", headSha: gh.sha(HEAD) })))
  assert.equal(calls(gh, "PUT", "/pulls/1/update-branch"), 1, "one update, never a second")
})

test("a major bump is left open and logged, however green it is", async () => {
  const major = MINOR_BODY.replace("semver-minor", "semver-major").replaceAll("4.2.0", "5.0.0")
  const { gh, repo, merger, lines } = setup("major", {
    pull: { title: "chore(deps): bump zod from 4.1.0 to 5.0.0" },
    body: major,
  })
  const outcome = await merger.onEvent(event(repo))
  assert.equal(outcome?.kind, "skipped")
  assert.match((outcome as { reason: string }).reason, /major bump/)
  assert.equal((gh.pulls.get(1) as FakePull).merged, false)
  assert.equal(calls(gh, "PUT", "/pulls/1/merge"), 0)
  await merger.onEvent(event(repo, { id: 2 }))
  assert.equal(lines.length, 1, "said once")
})

test("a Dependabot PR into main of a major repository is refused, green or not", async () => {
  const { gh, repo, merger } = setup("into-main", { pull: { base: "main" } })
  const outcome = await merger.onEvent(event(repo))
  assert.equal(outcome?.kind, "skipped")
  assert.match((outcome as { reason: string }).reason, /targets main, not the Base Branch dev/)
  assert.match((outcome as { reason: string }).reason, /promotions only/)
  assert.equal((gh.pulls.get(1) as FakePull).merged, false)
  assert.equal(calls(gh, "PUT", "/pulls/1/merge"), 0)
})

test("a small repository's main is its Base Branch, and a green bump into it merges", async () => {
  const { gh, repo, merger } = setup("small", { pull: { base: "main" }, repo: { kind: "small" } })
  merged(await merger.onEvent(event(repo)))
  assert.equal((gh.pulls.get(1) as FakePull).merged, true)
})

test("a repository that opted out is never read, let alone merged", async () => {
  const { gh, repo, merger, lines } = setup("opted-out", {
    repo: { dependabotMergeEnabled: false },
  })
  const outcome = await merger.onEvent(event(repo))
  assert.equal(outcome?.kind, "skipped")
  assert.match((outcome as { reason: string }).reason, /opted out/)
  assert.equal(gh.calls.length, 0, "no GitHub call at all")
  assert.equal((gh.pulls.get(1) as FakePull).merged, false)
  await merger.onEvent(event(repo, { id: 2 }))
  assert.equal(lines.length, 1)
})

test("a PR by anyone else is not the merger's: one REST read, no verdict, no merge", async () => {
  const { gh, repo, merger, lines } = setup("human", { pull: { author: "octocat" } })
  assert.equal(await merger.onEvent(event(repo)), null)
  assert.equal(await merger.onEvent(event(repo, { id: 2, kind: "check_run" })), null)
  assert.equal(calls(gh, "GET", "/pulls/1"), 1, "the author is read once and remembered")
  assert.equal(calls(gh, "POST", "/graphql"), 0, "no verdict read for a human PR")
  assert.equal((gh.pulls.get(1) as FakePull).merged, false)
  assert.equal(lines.length, 0)
})

test("events without a PR, and a closed PR, are ignored", async () => {
  const { gh, repo, merger } = setup("ignored")
  assert.equal(await merger.onEvent(event(repo, { kind: "workflow_run", number: null })), null)
  assert.equal(await merger.onEvent(event(repo, { kind: "release", number: 7 })), null)
  assert.equal(await merger.onEvent(event(repo, { action: "closed" })), null)
  assert.equal(gh.calls.length, 0)
})

test("the startup sweep merges a green Dependabot PR that raised no event", async () => {
  const { gh, merger } = setup("sweep")
  gh.pulls.set(2, {
    ...(gh.pulls.get(1) as FakePull),
    number: 2,
    author: "octocat",
    head: "dev",
  })
  const outcomes = await merger.sweep()
  assert.deepEqual(
    outcomes.map((o) => [o.kind, o.number]),
    [["merged", 1]],
  )
  assert.equal((gh.pulls.get(1) as FakePull).merged, true)
  assert.equal((gh.pulls.get(2) as FakePull).merged, false)
})

test("an UNKNOWN mergeability is read again with backoff, and merges once GitHub has computed it", async () => {
  const { gh, repo, merger, lines, sleeps } = setup("unknown")
  gh.unknownReads = 2
  merged(await merger.onEvent(event(repo)))
  assert.deepEqual(sleeps, [5_000, 15_000], "two pauses, one before each re-read")
  assert.equal((gh.pulls.get(1) as FakePull).merged, true)
  assert.equal(lines.length, 1, "the re-reads are not news; the merge is the one line")
  assert.match(lines[0] ?? "", /merged acme\/unknown#1/)
})

test("still UNKNOWN after two minutes of re-reads: it waits, said once, and the next sweep merges it", async () => {
  const { gh, repo, merger, lines, sleeps } = setup("unknown-long")
  gh.unknownReads = UNKNOWN_REREAD_MS.length + 1
  const first = await merger.onEvent(event(repo))
  assert.equal(first?.kind, "waiting", JSON.stringify(first))
  assert.equal((first as { code: string }).code, "unknown")
  assert.deepEqual(sleeps, [...UNKNOWN_REREAD_MS])
  assert.ok(
    UNKNOWN_REREAD_MS.reduce((a, b) => a + b, 0) <= 120_000,
    "the re-reads stay within two minutes",
  )
  assert.equal(calls(gh, "PUT", "/pulls/1/merge"), 0)
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? "", /waits: GitHub is still computing mergeability.*next sweep/)
  // GitHub has computed it by the next sweep, and no event ever came.
  const outcomes = await merger.sweep()
  assert.deepEqual(
    outcomes.map((o) => [o.kind, o.number]),
    [["merged", 1]],
  )
})

test("merging one bump puts its sibling behind: the merger walks to it, updates it, and merges it", async () => {
  const ctx = setup("siblings")
  const { gh, repo, merger, lines } = ctx
  sibling(ctx, 2)
  merged(await merger.onEvent(event(repo)))
  assert.equal(calls(gh, "PUT", "/pulls/2/update-branch"), 1, "the walk after the merge")
  assert.equal((gh.pulls.get(2) as FakePull).merged, false, "an updated head waits for its Check")
  // The update made a new head; its Check reports, and that event merges it.
  merged(
    await merger.onEvent(event(repo, { id: 2, kind: "check_run", action: "changed", number: 2 })),
  )
  assert.equal((gh.pulls.get(2) as FakePull).merged, true)
  assert.deepEqual(
    lines.map((l) => l.replace(/ at .*/, "").replace(/; asked.*/, "")),
    [
      'dependabot: merged acme/siblings#1 "chore(deps): bump zod from 4.1.0 to 4.2.0"',
      "dependabot: acme/siblings#2 is behind dev",
      'dependabot: merged acme/siblings#2 "chore(deps): bump pkg2 from 1.0.0 to 1.1.0"',
    ],
    "one line per state change",
  )
})

test("the update bound does not count the base moves the merger's own merges make", async () => {
  const ctx = setup("many")
  const { gh, repo, merger } = ctx
  for (const n of [2, 3, 4, 5]) sibling(ctx, n)
  const onFive = (id: number) =>
    merger.onEvent(event(repo, { id, kind: "check_run", action: "changed", number: 5 }))
  // #1 merges; the walk updates #2 and lets #3..#5 wait their turn.
  merged(await merger.onEvent(event(repo)))
  assert.equal(calls(gh, "PUT", "/pulls/2/update-branch"), 1)
  assert.equal(calls(gh, "PUT", "/pulls/3/update-branch"), 0, "one behind head at a time")
  // #5 hears of its own Check on every round and is brought forward each time;
  // each merge of #2..#4 puts it behind again.
  let id = 10
  for (const n of [2, 3, 4]) {
    const five = await onFive(id++)
    assert.equal(five?.kind, "updated_branch", JSON.stringify(five))
    merged(
      await merger.onEvent(
        event(repo, { id: id++, kind: "check_run", action: "changed", number: n }),
      ),
    )
  }
  assert.ok(
    calls(gh, "PUT", "/pulls/5/update-branch") > MAX_UPDATE_BRANCH_ROUNDS,
    "more updates than the bound, all made necessary by the merger's own merges",
  )
  merged(await onFive(id++))
  assert.ok([1, 2, 3, 4, 5].every((n) => (gh.pulls.get(n) as FakePull).merged))
})

test("the periodic sweep, every 30 to 60 minutes, merges a green PR that raised no event", async () => {
  const armed: { run: () => Promise<void>; ms: number }[] = []
  let cancelled = 0
  const { gh, merger } = setup("periodic", {
    deps: {
      schedule: (run, ms) => {
        armed.push({ run, ms })
        return () => {
          cancelled++
        }
      },
      random: () => 0.5,
    },
  })
  const sweeps = merger.startSweeps()
  assert.equal(armed.length, 1)
  assert.equal(armed[0]?.ms, SWEEP_EVERY_MS + SWEEP_JITTER_MS / 2)
  assert.ok(SWEEP_EVERY_MS >= 30 * 60_000 && SWEEP_EVERY_MS + SWEEP_JITTER_MS <= 60 * 60_000)
  assert.equal(gh.calls.length, 0, "nothing is read before the timer fires")
  await armed[0]?.run()
  assert.equal((gh.pulls.get(1) as FakePull).merged, true)
  assert.equal(armed.length, 2, "the next sweep is armed after this one")
  sweeps.stop()
  assert.equal(cancelled, 1)
})

test("bumpKindOf: the commit body decides, the title is the fallback, silence is unknown", () => {
  const commit = (body: string) => ({
    oid: "0".repeat(40),
    headline: "x",
    signed: true,
    signatureState: "VALID",
    body,
  })
  const grouped = [
    "updated-dependencies:",
    "- dependency-name: a",
    "  update-type: version-update:semver-patch",
    "- dependency-name: b",
    "  update-type: version-update:semver-major",
  ].join("\n")
  assert.equal(
    bumpKindOf({
      title: "chore(deps): bump the npm group with 2 updates",
      commits: [commit(grouped)],
    }),
    "major",
    "one major in a group makes the group major",
  )
  assert.equal(
    bumpKindOf({
      title: "chore(deps): bump the npm group with 2 updates",
      commits: [commit(grouped.replace("semver-major", "semver-minor"))],
    }),
    "minor_or_patch",
  )
  assert.equal(
    bumpKindOf({ title: "chore(deps): bump foo from v1.9.0 to v2.0.0", commits: [commit("")] }),
    "major",
    "the title's majors differ",
  )
  assert.equal(
    bumpKindOf({ title: "build(deps-dev): bump foo from 1.9.0 to 1.10.0", commits: [commit("")] }),
    "minor_or_patch",
  )
  assert.equal(
    bumpKindOf({ title: "chore(deps): bump the npm group with 2 updates", commits: [commit("")] }),
    "unknown",
    "a grouped title without a body says nothing",
  )
  assert.equal(
    bumpKindOf({
      title: "chore(deps): bump foo from 1.0.0 to 1.0.1",
      commits: [commit("update-type: version-update:semver-major")],
    }),
    "major",
    "the body wins over a title that looks harmless",
  )
})
