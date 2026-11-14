import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import type { Repository } from "../../src/types.ts"
import { updateBranchRef } from "../../src/github/releases.ts"
import type { MergeCommitter } from "../../src/release/backmerge.ts"
import {
  PROMOTION_HEAD,
  type SyncOutput,
  type SyncResult,
  stagingBranch,
  syncReleasePr,
} from "../../src/release/sync.ts"
import { failingCommitter, pushingCommitter } from "../helpers/committer.ts"
import { repositoryOf } from "../helpers/repository.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { FakeGitHub, git } from "../workflow/fake-github.ts"

const home = scratchDir("train-sync-")

/**
 * `syncReleasePr` on its own, the way a release script calls it:
 * a bare origin, a clone at the repository path, and the fake GitHub.
 */
function rig(
  name: string,
  opts: { files?: Record<string, string>; versionFiles?: string[] } = {},
) {
  const origin = join(home, `${name}.git`)
  git(home, "init", "-q", "--bare", "-b", "dev", origin)
  const seed = join(home, `${name}-seed`)
  git(home, "clone", "-q", origin, seed)
  const files = opts.files ?? { "package.json": '{\n  "name": "demo",\n  "version": "1.2.0"\n}\n' }
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(seed, path, ".."), { recursive: true })
    writeFileSync(join(seed, path), contents)
  }
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "chore: init")
  git(seed, "tag", "v1.2.0")
  git(seed, "push", "-q", "origin", "dev", "--tags")
  git(seed, "push", "-q", "origin", "dev:main")
  const clone = join(home, "clones", name)
  mkdirSync(join(clone, ".."), { recursive: true })
  git(home, "clone", "-q", origin, clone)
  const repository: Repository = repositoryOf({
    owner: "acme",
    name,
    kind: "major",
    path: clone,
    ...(opts.versionFiles ? { versionFiles: opts.versionFiles } : {}),
  })
  const gh = new FakeGitHub({ origin, owner: "acme", name })
  let landed = 0
  const land = (subject: string): string => {
    git(seed, "fetch", "-q", "origin")
    git(seed, "checkout", "-q", "-B", "dev", "origin/dev")
    landed += 1
    writeFileSync(join(seed, `touch-${landed}.txt`), `${subject}\n`)
    git(seed, "add", "-A")
    git(seed, "commit", "-q", "-m", subject)
    git(seed, "push", "-q", "origin", "dev")
    return git(seed, "rev-parse", "HEAD")
  }
  const sync = (
    previous: SyncOutput | null,
    releaseAs: string | null,
    branch = "dev",
    commitMerge?: MergeCommitter,
  ): Promise<SyncResult> =>
    syncReleasePr({
      client: gh.client,
      repository,
      branch,
      releaseAs,
      previous,
      now: () => new Date("2026-09-06T12:00:00Z"),
      ...(commitMerge ? { commitMerge } : {}),
    })
  return { gh, repository, seed, land, sync }
}

function pr(result: SyncResult): SyncOutput {
  assert.equal(result.kind, "pr", JSON.stringify(result))
  return (result as Extract<SyncResult, { kind: "pr" }>).output
}

test("a rerun without --release-as keeps the persisted version; without the state it would rebuild lower (B13)", async () => {
  const r = rig("release-as")
  r.land("feat: the endpoint (#1)")
  const first = pr(await r.sync(null, "2.0.0-beta.1"))
  assert.equal(first.version, "2.0.0-beta.1")
  assert.equal(first.releaseAs, "2.0.0-beta.1")
  assert.equal(r.gh.commits.length, 1)

  // A caller persists the flag with the output and passes both to the rerun.
  const second = await r.sync(first, first.releaseAs)
  assert.equal(second.kind, "pr")
  assert.equal((second as { changed: boolean }).changed, false, "nothing moved: no rebuild")
  assert.equal(pr(second).version, "2.0.0-beta.1")
  assert.equal(r.gh.commits.length, 1)
  assert.equal(r.gh.pulls.get(1)?.title, "chore(release): 2.0.0-beta.1")

  // The bug this guards: the flag forgotten, the version is derived again and
  // the head force-rebuilt although nothing landed — and with no state
  // at all (a fresh cycle) the derived beta is the lower one.
  const forgotten = await r.sync(first, null)
  assert.equal((forgotten as { changed: boolean }).changed, true)
  assert.equal(pr(forgotten).releaseAs, null)
  assert.notEqual(pr(forgotten).bump, "override", "derived again, not the override")
  assert.equal(r.gh.commits.length, 2, "a needless rebuild")
  assert.equal(pr(await r.sync(null, null)).version, "1.3.0-beta.1")
})

test("a crash between the reset and the commit leaves the PR closed; the next sync reopens it rather than opening a second", async () => {
  const r = rig("reopen")
  r.land("feat: the endpoint (#1)")
  const first = pr(await r.sync(null, null))
  assert.equal(first.prNumber, 1)
  assert.equal(r.gh.pulls.get(1)?.state, "open")

  // The base moves; the rebuild resets the head to the new tip and dies before the commit.
  const tip = r.land("fix: the empty case (#2)")
  await updateBranchRef(
    r.gh.client,
    { owner: "acme", name: r.repository.name },
    first.head,
    tip,
    {
      force: true,
    },
  )
  assert.equal(
    r.gh.pulls.get(1)?.state,
    "closed",
    "GitHub closes a PR with no commits over its base",
  )

  const second = pr(await r.sync(first, null))
  assert.equal(second.prNumber, 1, "the closed PR is reopened")
  assert.equal(r.gh.pulls.size, 1, "not a second one")
  assert.equal(r.gh.pulls.get(1)?.state, "open")
  assert.match(r.gh.pulls.get(1)?.body ?? "", /handle the empty case|the empty case/)
  assert.equal(git(r.gh.origin, "rev-parse", `${first.head}^`), tip, "head = base tip + one commit")

  // A merged PR on the same head is never the one to reopen: the crash case needs an unmerged one.
  await r.gh.client.rest("PUT", `/repos/acme/${r.repository.name}/pulls/1/merge`, {
    body: {
      sha: r.gh.sha(first.head),
      merge_method: "squash",
      commit_title: "chore(release): x (#1)",
    },
  })
  assert.equal(r.gh.pulls.get(1)?.merged, true)
  r.land("feat: next (#3)")
  const third = pr(await r.sync(null, null))
  assert.equal(third.prNumber, 2, "a fresh PR after the release")
})

test("a merged Release PR left untagged is the release of the next cycle, not the seed of a second PR", async () => {
  const r = rig("merged-untagged")
  r.land("feat: the endpoint (#1)")
  const first = pr(await r.sync(null, null))
  assert.equal(first.prNumber, 1)
  // Merged in GitHub, the way the execute stage does it — and then the cycle
  // ended before the tag, so the next one starts with no `previous`.
  await r.gh.client.rest("PUT", `/repos/acme/${r.repository.name}/pulls/1/merge`, {
    body: {
      sha: r.gh.sha(first.head),
      merge_method: "squash",
      commit_title: `chore(release): ${first.version} (#1)`,
    },
  })
  const tip = git(r.gh.origin, "rev-parse", "dev")
  const commits = r.gh.commits.length

  const next = await r.sync(null, null)
  assert.equal(next.kind, "merged", JSON.stringify(next))
  const merged = next as { kind: "merged"; output: SyncOutput; mergeSha: string }
  assert.equal(merged.mergeSha, tip, "the tip is the merge")
  assert.equal(merged.output.prNumber, 1)
  assert.equal(merged.output.version, first.version)
  assert.equal(merged.output.target, first.target)
  assert.equal(merged.output.bump, "minor")
  assert.equal(merged.output.prerelease, first.prerelease)
  assert.equal(merged.output.head, first.head)
  assert.equal(merged.output.headSha, first.headSha)
  assert.equal(merged.output.sourceSha, first.sourceSha, "the version commit sits on the old tip")
  assert.match(merged.output.section, /the endpoint/)
  assert.doesNotMatch(
    merged.output.section,
    /chore\(release\)/,
    "the version commit is not its own note",
  )
  assert.equal(r.gh.pulls.size, 1, "no second PR")
  assert.equal(r.gh.commits.length, commits, "nothing written")

  // Tagged, the range ends at the tag and the next cycle has nothing to do.
  git(r.gh.origin, "tag", `v${first.version}`, tip)
  const after = await r.sync(null, null)
  assert.equal(after.kind, "nothing", JSON.stringify(after))
})

test("a Release PR a person closed on an intact head stays closed: no reopen, no second PR, and the sync says so", async () => {
  const r = rig("closed-by-hand")
  r.land("feat: the endpoint (#1)")
  const first = pr(await r.sync(null, null))
  assert.equal(first.prNumber, 1)
  await r.gh.client.rest("PATCH", `/repos/acme/${r.repository.name}/pulls/1`, {
    body: { state: "closed" },
  })
  assert.equal(r.gh.pulls.get(1)?.state, "closed")
  assert.equal(r.gh.sha(first.head), first.headSha, "the head is intact: nobody reset it")

  const commits = r.gh.commits.length
  const closed = await r.sync(first, null)
  assert.equal(closed.kind, "closed", JSON.stringify(closed))
  assert.match((closed as { reason: string }).reason, /#1/)
  assert.match((closed as { reason: string }).reason, /closed/)
  assert.deepEqual((closed as { output: SyncOutput }).output, first)
  assert.equal(r.gh.pulls.size, 1, "no second PR")
  assert.equal(r.gh.pulls.get(1)?.state, "closed", "not reopened")
  assert.equal(r.gh.commits.length, commits, "the head was not rebuilt")
  assert.equal(r.gh.sha(first.head), first.headSha)

  // The base moving does not change that: the head is still the one the train built.
  r.land("fix: the empty case (#2)")
  const still = await r.sync(first, null)
  assert.equal(still.kind, "closed", JSON.stringify(still))
  assert.equal(r.gh.pulls.get(1)?.state, "closed")
  assert.equal(r.gh.pulls.size, 1)
})

// ---- a change the stable tag already carries --------------------

const pkg = (version: string) => `{\n  "name": "demo",\n  "version": "${version}"\n}\n`

/**
 * A hotfix after the fact: dev's commit reaches main as a hotfix of its
 * own (a squash merge: same patch, another SHA, its own PR number), main
 * releases it, and the release comes back to dev as one squash commit — so
 * the tag never enters dev's ancestry and `tag..dev` still lists dev's commit.
 */
function hotfixAndBackmerge(
  r: Awaited<ReturnType<typeof rig>>,
  devSha: string,
  hotfixSubject: string,
  version: string,
) {
  const { seed } = r
  git(seed, "fetch", "-q", "origin")
  git(seed, "checkout", "-q", "-B", "main", "origin/main")
  git(seed, "cherry-pick", "--no-commit", devSha)
  git(seed, "commit", "-q", "-m", hotfixSubject)
  writeFileSync(join(seed, "package.json"), pkg(version))
  git(seed, "commit", "-q", "-am", `chore(release): ${version} (#91)`)
  git(seed, "tag", `v${version}`)
  git(seed, "push", "-q", "origin", "main", "--tags")
  git(seed, "checkout", "-q", "-B", "dev", "origin/dev")
  writeFileSync(join(seed, "package.json"), pkg(version))
  git(seed, "commit", "-q", "-am", `chore(release): backmerge v${version} into dev (#92)`)
  git(seed, "push", "-q", "origin", "dev")
}

function entries(section: string): string[] {
  return section.split("\n").filter((line) => line.startsWith("* "))
}

test("a hotfix on main of a change dev already has: dev has nothing to release, no beta, no Release PR", async () => {
  const r = rig("hotfix-same-change")
  const fix = r.land("fix(deploy): check the pipeline out at job.workflow_sha (#87)")
  hotfixAndBackmerge(
    r,
    fix,
    "fix(deploy): check the pipeline out at job.workflow_sha (#90)",
    "1.2.1",
  )

  const result = await r.sync(null, null)
  assert.equal(result.kind, "nothing", JSON.stringify(result))
  const nothing = result as Extract<SyncResult, { kind: "nothing" }>
  assert.equal(nothing.withdrawn, undefined, "there was no Release PR to close")
  assert.match(nothing.reason, /since v1\.2\.1/)
  assert.match(
    nothing.reason,
    /already in v1\.2\.1 under another SHA: .*fix\(deploy\): check the pipeline out at job\.workflow_sha \(#87\)/,
  )
  assert.equal(r.gh.pulls.size, 0, "no Release PR")
  assert.equal(r.gh.commits.length, 0, "no version commit")
})

test("an open Release PR whose only change the stable tag now carries is closed; a genuine fix after it is a beta with one entry", async () => {
  const r = rig("hotfix-withdraw")
  const fix = r.land("fix(deploy): check the pipeline out at job.workflow_sha (#87)")
  const first = pr(await r.sync(null, null))
  assert.equal(first.version, "1.2.1-beta.1")
  assert.equal(r.gh.pulls.get(1)?.state, "open")

  // The same change reaches main as a hotfix and is released there: #93's situation.
  hotfixAndBackmerge(
    r,
    fix,
    "fix(deploy): check the pipeline out at job.workflow_sha (#90)",
    "1.2.1",
  )
  const withdrawn = await r.sync(first, null)
  assert.equal(withdrawn.kind, "nothing", JSON.stringify(withdrawn))
  assert.equal((withdrawn as { withdrawn?: number }).withdrawn, 1)
  assert.match((withdrawn as { reason: string }).reason, /closed the Release PR #1/)
  assert.equal(r.gh.pulls.get(1)?.state, "closed")
  assert.equal(r.gh.pulls.get(1)?.merged, false)
  assert.equal(r.gh.sha(first.head), null, "the head is deleted")

  // The cycle that owned #1 ends; the next starts with no previous and the target over.
  const again = await r.sync(null, null)
  assert.equal(again.kind, "nothing", JSON.stringify(again))
  assert.equal((again as { withdrawn?: number }).withdrawn, undefined)

  r.land("fix(api): handle the empty body (#95)")
  const next = pr(await r.sync(null, null))
  assert.equal(next.prNumber, 2)
  assert.equal(next.version, "1.2.2-beta.1", "one patch over v1.2.1, not two")
  assert.equal(next.target, "1.2.2")
  assert.equal(next.bump, "patch")
  assert.equal(next.previousTag, "v1.2.1")
  assert.deepEqual(entries(next.section).length, 1, next.section)
  assert.match(next.section, /handle the empty body/)
  assert.doesNotMatch(next.section, /#87|job\.workflow_sha/)
})

test("mixed: dev's range holds a change main already released next to genuine ones; only the genuine ones count", async () => {
  const r = rig("hotfix-mixed")
  const fix = r.land("fix(deploy): check the pipeline out at job.workflow_sha (#87)")
  r.land("feat(deploy): deploy previews of every package (#88)")
  hotfixAndBackmerge(
    r,
    fix,
    "fix(deploy): check the pipeline out at job.workflow_sha (#90)",
    "1.2.1",
  )
  r.land("fix(api): handle the empty body (#95)")
  r.land("docs: the deploy section (#96)")

  const out = pr(await r.sync(null, null))
  assert.equal(out.version, "1.3.0-beta.1")
  assert.equal(out.target, "1.3.0")
  assert.equal(out.bump, "minor")
  assert.equal(out.previousTag, "v1.2.1")
  const lines = entries(out.section)
  assert.equal(lines.length, 3, out.section)
  assert.match(
    out.section,
    /### ✨ Features\n\n\* \*\*deploy:\*\* deploy previews of every package/,
  )
  assert.match(out.section, /### 🐛 Bug Fixes\n\n\* \*\*api:\*\* handle the empty body/)
  assert.match(out.section, /the deploy section/)
  assert.doesNotMatch(
    out.section,
    /#87|job\.workflow_sha/,
    "the hotfix is v1.2.1's, not this beta's",
  )
})

const WORKSPACE = {
  "package.json": '{\n  "name": "widgets",\n  "private": true,\n  "type": "module"\n}\n',
  "apps/server/package.json":
    '{\n  "name": "server",\n  "private": true,\n  "version": "0.0.0"\n}\n',
  "packages/protocol/package.json":
    '{\n  "name": "@x/protocol",\n  "private": true,\n  "version": "0.0.0"\n}\n',
}

test("a monorepo whose root carries no version refuses to release until versionFiles names the packages that do", async () => {
  // The default glob is anchored, so in a workspace it matches the private
  // root and nothing else. A workspace repository is that shape and the
  // release train cannot run on it at all.
  const r = rig("workspace-default", { files: WORKSPACE })
  r.land("feat: the endpoint (#1)")
  await assert.rejects(r.sync(null, null), /never-published workspace root carries none/)
  assert.equal(r.gh.commits.length, 0, "nothing is committed on the way to the error")
})

test("with versionFiles naming the workspace packages, every one of them carries the released version", async () => {
  const r = rig("workspace-configured", {
    files: WORKSPACE,
    versionFiles: ["apps/*/package.json", "packages/*/package.json"],
  })
  r.land("feat: the endpoint (#1)")
  const out = pr(await r.sync(null, null))
  assert.equal(out.version, "1.3.0-beta.1")
  assert.deepEqual(r.gh.commits.at(-1)?.additions, [
    "apps/server/package.json",
    "packages/protocol/package.json",
    "CHANGELOG.md",
  ])
})

const withPipeline = {
  "package.json": '{\n  "name": "demo",\n  "version": "1.2.0"\n}\n',
  ".github/workflows/ci.yaml": "name: Pipeline\n",
}

test("the Release PR is built only over a base tip whose pipeline / Check passed", async () => {
  const r = rig("base-check", { files: withPipeline })
  const tip = r.land("feat: the endpoint (#1)")

  r.gh.refChecks.set(tip, "none")
  const notStarted = await r.sync(null, null)
  assert.deepEqual(notStarted, {
    kind: "pending",
    reason: `waiting for pipeline / Check on dev at ${tip.slice(0, 7)} to start`,
  })
  r.gh.refChecks.set(tip, "pending")
  assert.match((await r.sync(null, null)).kind, /^pending$/)
  r.gh.refChecks.set(tip, "failure")
  const red = await r.sync(null, null)
  assert.equal(red.kind, "pending")
  assert.match((red as { reason: string }).reason, /is failure on dev .*waits for a green dev/)
  assert.equal(r.gh.commits.length, 0, "no head, no commit, no pipeline run while dev is not green")
  assert.equal(r.gh.pulls.size, 0)

  r.gh.refChecks.set(tip, "success")
  const first = pr(await r.sync(null, null))
  assert.equal(first.sourceSha, tip)

  // dev moves on: the open Release PR stays as it is until the new tip is green.
  const next = r.land("fix: the empty case (#2)")
  r.gh.refChecks.set(next, "pending")
  assert.equal((await r.sync(first, null)).kind, "pending")
  assert.equal(r.gh.sha(first.head), first.headSha, "the head did not move")
  r.gh.refChecks.set(next, "success")
  assert.equal(pr(await r.sync(first, null)).sourceSha, next)
})

test("a repository without the pipeline caller does not wait for a Check it never runs", async () => {
  const r = rig("no-pipeline")
  const tip = r.land("feat: the endpoint (#1)")
  r.gh.refChecks.set(tip, "none")
  assert.equal(pr(await r.sync(null, null)).sourceSha, tip)
})

test("a rebuild moves the head in one step: the Release PR never closes, so one push and one run", async () => {
  const r = rig("one-push", { files: withPipeline })
  r.land("feat: the endpoint (#1)")
  const first = pr(await r.sync(null, null))
  const tip = r.land("fix: the empty case (#2)")
  // A sync that died mid-rebuild left its staging branch behind: it is reused.
  git(r.seed, "push", "-q", "origin", `${tip}:refs/heads/train-staging/${first.head}`)
  const calls = r.gh.calls.length

  const second = pr(await r.sync(first, null))
  assert.equal(second.prNumber, first.prNumber)
  assert.equal(r.gh.pulls.get(first.prNumber)?.state, "open")
  const moves = r.gh.calls
    .slice(calls)
    .filter(
      (c) =>
        c.method === "PATCH" &&
        c.path.includes(`/git/refs/heads/${encodeURIComponent(first.head)}`),
    )
  assert.deepEqual(
    moves.map((c) => (c.body as { sha: string }).sha),
    [second.headSha],
    "the head moved once, straight onto the release commit — never onto the bare base",
  )
  assert.equal(git(origin(r), "rev-parse", `${second.headSha}^`), tip, "base plus one commit")
  assert.equal(r.gh.sha(`train-staging/${first.head}`), null, "the staging branch is gone")
})

function origin(r: { gh: FakeGitHub }): string {
  return r.gh.origin
}

test("a released base counts its green push run, not the release run's skipped Check that GitHub lists as latest", async () => {
  const r = rig("released-base", { files: withPipeline })
  const tip = r.land("feat: the endpoint (#1)")
  // The push run passed; publishing a release on the same commit started a
  // second run whose Check is skipped by design, and that one is the latest.
  r.gh.refCheckRuns.set(tip, [
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "skipped" },
  ])
  assert.equal(pr(await r.sync(null, null)).sourceSha, tip)

  // Skipped alone is not a pass, and a red run says it is red.
  r.gh.refCheckRuns.set(tip, [{ status: "completed", conclusion: "skipped" }])
  assert.match(((await r.sync(null, null)) as { reason: string }).reason, /is skipped on dev/)
  r.gh.refCheckRuns.set(tip, [
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "skipped" },
  ])
  assert.match(((await r.sync(null, null)) as { reason: string }).reason, /is failure on dev/)
})

/**
 * A repository that became major after v0.34.0,
 * with feat commits on main that were never released. dev was cut from that
 * main, so it carries them. Counting them as main's own made main a hotfix
 * whose Release PR had been closed, and no promotion ever opened.
 */
test("main's unreleased commits that dev's last release already carries are promoted, not a hotfix", async () => {
  const r = rig("promotion-after-major-switch")
  const { seed } = r
  git(seed, "fetch", "-q", "origin")
  git(seed, "checkout", "-q", "-B", "main", "origin/main")
  writeFileSync(join(seed, "before-dev.txt"), "feat\n")
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "feat: landed on main before dev existed (#287)")
  git(seed, "push", "-q", "origin", "main")
  git(seed, "push", "-q", "-f", "origin", "main:dev")
  r.land("fix(website): a fix on dev (#301)")
  git(seed, "tag", "v1.3.0-beta.1")
  git(seed, "push", "-q", "origin", "--tags")

  const out = pr(await r.sync(null, null, "main"))
  assert.equal(out.mode, "promotion")
  assert.equal(out.head, "promote/main")
  assert.equal(out.sourceRef, "v1.3.0-beta.1")
  assert.equal(out.version, "1.3.0")
})

test("a commit on main that dev's last release lacks is still main's own: a hotfix", async () => {
  const r = rig("hotfix-not-in-dev")
  r.land("feat: a feature on dev (#10)")
  const { seed } = r
  git(seed, "tag", "v1.3.0-beta.1")
  git(seed, "push", "-q", "origin", "--tags")
  git(seed, "checkout", "-q", "-B", "main", "origin/main")
  writeFileSync(join(seed, "hotfix.txt"), "fix\n")
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "fix: only on main (#11)")
  git(seed, "push", "-q", "origin", "main")

  const out = pr(await r.sync(null, null, "main"))
  assert.equal(out.mode, "hotfix")
  assert.equal(out.version, "1.2.1")
})

/**
 * main carries a stable release whose commit dev never received by sha,
 * because its backmerge was squashed: the content, not the history. dev then
 * cut its next beta, so the promotion has to merge main forward first.
 */
function mainCarriesWhatDevLacks(r: Awaited<ReturnType<typeof rig>>): void {
  const { seed } = r
  // main's stable release, whose commit dev never received by sha ...
  git(seed, "fetch", "-q", "origin")
  git(seed, "checkout", "-q", "-B", "main", "origin/main")
  writeFileSync(join(seed, "package.json"), '{\n  "name": "demo",\n  "version": "1.2.1"\n}\n')
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "chore(release): 1.2.1 (#5)")
  git(seed, "tag", "v1.2.1")
  git(seed, "push", "-q", "origin", "main", "--tags")
  // ... because its backmerge was squashed: the content, not the history.
  git(seed, "checkout", "-q", "-B", "dev", "origin/dev")
  writeFileSync(join(seed, "package.json"), '{\n  "name": "demo",\n  "version": "1.2.1"\n}\n')
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "chore(release): backmerge v1.2.1 into dev (#6)")
  git(seed, "push", "-q", "origin", "dev")
  r.land("feat: a feature on dev (#7)")
  writeFileSync(
    join(seed, "package.json"),
    '{\n  "name": "demo",\n  "version": "1.3.0-beta.1"\n}\n',
  )
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "chore(release): 1.3.0-beta.1 (#8)")
  git(seed, "tag", "v1.3.0-beta.1")
  git(seed, "push", "-q", "origin", "dev", "--tags")
}

/**
 * The forward merge's entries are byte-exact; `readTreeFile` trims. The version
 * writer adds the trailing newline itself, so a forward-merged version file
 * ended in two and a formatter failed the promotion's Check. Seen
 * after a backmerge had been squashed
 * and main's release commit was no ancestor of dev any more.
 */
test("a promotion over a forward merge of main writes its version files with one trailing newline", async () => {
  const r = rig("promotion-forward-merge")
  const { seed } = r
  mainCarriesWhatDevLacks(r)

  const out = pr(await r.sync(null, null, "main"))
  assert.equal(out.mode, "promotion")
  assert.equal(out.version, "1.3.0")
  assert.ok(out.mergedMain, "main is no ancestor of the beta, so the head carries a forward merge")
  git(seed, "fetch", "-q", "origin")
  // Byte-exact: the helper's string form trims, which would hide the defect.
  const written = String(git(seed, "show", `origin/${out.head}:package.json`, { binary: true }))
  assert.match(written, /"version": "1.3.0"/)
  assert.ok(
    written.endsWith("}\n") && !written.endsWith("\n\n"),
    `one trailing newline, not ${JSON.stringify(written.slice(-4))}`,
  )
})

/** The forward merge under a promotion head: the version commit's parent. */
function forwardMergeOf(origin: string, head: string): { sha: string; parents: string[] } {
  const [sha = "", ...parents] = git(origin, "rev-list", "--parents", "-n", "1", `${head}^`).split(
    " ",
  )
  return { sha, parents }
}

/**
 * A caller may bring its own committer for the forward merge (`commitMerge`):
 * one that pushes the commit to the scratch branch itself. The Git Data API
 * is then not asked to commit, and the scratch branch does not outlive the sync.
 */
test("an injected committer makes the promotion's forward merge and pushes it; the Git Data API is not asked", async () => {
  const r = rig("promotion-injected-forward-merge")
  mainCarriesWhatDevLacks(r)
  const origin = r.gh.origin

  const out = pr(await r.sync(null, null, "main", pushingCommitter))
  assert.equal(out.mode, "promotion")
  assert.equal(out.mergedMain, git(origin, "rev-parse", "main"))
  const merge = forwardMergeOf(origin, out.head)
  assert.deepEqual(merge.parents, [out.sourceSha, out.mergedMain], "dev's release, then main")
  // The version file conflicted and was resolved as the Git Data path resolves it: dev's.
  assert.match(git(origin, "show", `${merge.sha}:package.json`), /"version": "1.3.0-beta.1"/)
  assert.equal(
    r.gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/commits")).length,
    0,
    "the Git Data API made no commit",
  )
  assert.equal(r.gh.sha(stagingBranch(out.head)), null, "the scratch branch is gone")
})

test("a committer that refuses the forward merge leaves nothing behind", async () => {
  const r = rig("promotion-committer-refuses")
  mainCarriesWhatDevLacks(r)

  await assert.rejects(r.sync(null, null, "main", failingCommitter), /the committer refused/)
  assert.equal(r.gh.sha(PROMOTION_HEAD), null, "no head")
  assert.equal(r.gh.sha(stagingBranch(PROMOTION_HEAD)), null, "no scratch branch")
  assert.equal(r.gh.pulls.size, 0, "no Release PR")
})
