import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import type { Repository } from "../../src/types.ts"
import {
  type OpenBackmergeInput,
  type OpenedBackmerge,
  openBackmerge,
} from "../../src/release/backmerge.ts"
import { failingCommitter, pushingCommitter } from "../helpers/committer.ts"
import { repositoryOf } from "../helpers/repository.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { FakeGitHub, git } from "../workflow/fake-github.ts"

const home = scratchDir("train-backmerge-")

const CHANGELOG = "# Changelog\n\n## [1.2.0](x) (2026-09-01)\n\n* old\n"

/**
 * `openBackmerge` on its own, the way a release script calls it
 * after a stable release of main: a bare origin with dev and main, a clone at
 * the repository path, and the fake GitHub.
 */
function rig(name: string) {
  const origin = join(home, `${name}.git`)
  git(home, "init", "-q", "--bare", "-b", "dev", origin)
  const seed = join(home, `${name}-seed`)
  git(home, "clone", "-q", origin, seed)
  const write = (files: Record<string, string>) => {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(seed, path, ".."), { recursive: true })
      writeFileSync(join(seed, path), contents)
    }
  }
  write({
    "package.json": '{\n  "name": "demo",\n  "version": "1.2.0"\n}\n',
    "CHANGELOG.md": CHANGELOG,
    "app.txt": "one\n",
  })
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
  })
  const gh = new FakeGitHub({ origin, owner: "acme", name })
  /** One commit on `branch` as it is on origin, pushed; its sha. */
  const commit = (branch: string, subject: string, files: Record<string, string>): string => {
    git(seed, "fetch", "-q", "origin")
    git(seed, "checkout", "-q", "-B", branch, `origin/${branch}`)
    write(files)
    git(seed, "add", "-A")
    git(seed, "commit", "-q", "-m", subject)
    git(seed, "push", "-q", "origin", branch)
    return git(seed, "rev-parse", "HEAD")
  }
  const open = (overrides: Partial<OpenBackmergeInput> = {}): Promise<OpenedBackmerge> =>
    openBackmerge({
      client: gh.client,
      repository,
      version: "1.3.0",
      mergeSha: git(origin, "rev-parse", "main"),
      commitMerge: pushingCommitter,
      mergedBy: "hand",
      ...overrides,
    })
  return { gh, origin, seed, repository, commit, open }
}

/**
 * main released 1.3.0 and dev went on to its next beta without it: the
 * version files and the changelog conflict, as on almost every backmerge.
 * `extra` adds files to each side, for a conflict only a person resolves.
 */
function releasedOnMain(
  r: Awaited<ReturnType<typeof rig>>,
  extra: { main?: Record<string, string>; dev?: Record<string, string> } = {},
): { mainSha: string; devSha: string } {
  const mainSha = r.commit("main", "chore(release): 1.3.0 (#5)", {
    "package.json": '{\n  "name": "demo",\n  "version": "1.3.0"\n}\n',
    "CHANGELOG.md": CHANGELOG.replace(
      "## [1.2.0]",
      "## [1.3.0](x) (2026-10-14)\n\n* new\n\n## [1.2.0]",
    ),
    ...extra.main,
  })
  r.commit("dev", "feat: the next thing (#6)", { "next.txt": "next\n", ...extra.dev })
  const devSha = r.commit("dev", "chore(release): 1.4.0-beta.1 (#7)", {
    "package.json": '{\n  "name": "demo",\n  "version": "1.4.0-beta.1"\n}\n',
    "CHANGELOG.md": CHANGELOG.replace(
      "## [1.2.0]",
      "## [1.4.0-beta.1](x) (2026-10-15)\n\n* next\n\n## [1.2.0]",
    ),
  })
  return { mainSha, devSha }
}

function pr(opened: OpenedBackmerge): Extract<OpenedBackmerge, { kind: "pr" }> {
  assert.equal(opened.kind, "pr", JSON.stringify(opened))
  return opened as Extract<OpenedBackmerge, { kind: "pr" }>
}

function parentsOf(origin: string, sha: string): string[] {
  return git(origin, "rev-list", "--parents", "-n", "1", sha).split(" ").slice(1)
}

function gitDataCommits(gh: FakeGitHub): number {
  return gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/commits")).length
}

/**
 * A release script on a user's token opens the backmerge PR itself, with a
 * committer of its own (`commitMerge`) that pushes the head: the Git Data
 * API is not asked to commit, and nothing here merges.
 */
test("after a stable release of main the backmerge PR into dev is opened, its head a merge made by the injected committer", async () => {
  const r = rig("injected")
  const { mainSha, devSha } = releasedOnMain(r)

  const opened = pr(await r.open())
  assert.equal(opened.head, "backmerge/v1.3.0")
  assert.equal(opened.devSha, devSha)
  const head = r.gh.sha(opened.head)
  assert.ok(head)
  assert.equal(head, opened.built?.sha)
  assert.deepEqual(parentsOf(r.origin, head), [devSha, mainSha], "dev, then the release")
  assert.equal(gitDataCommits(r.gh), 0, "the Git Data API made no commit")

  // Resolved as the plan resolves it: dev keeps its beta, the changelog takes both sections.
  assert.deepEqual([...(opened.built?.resolved ?? [])].sort(), ["CHANGELOG.md", "package.json"])
  assert.deepEqual(opened.built?.conflicts, [])
  assert.match(git(r.origin, "show", `${head}:package.json`), /"version": "1.4.0-beta.1"/)
  const changelog = git(r.origin, "show", `${head}:CHANGELOG.md`)
  assert.match(changelog, /## \[1\.3\.0\]/)
  assert.match(changelog, /## \[1\.4\.0-beta\.1\]/)
  assert.match(git(r.origin, "log", "-1", "--format=%B", head), /Resolved by the release train: /)

  // Opened, not merged: that is a person's, by merge commit.
  const pull = r.gh.pulls.get(opened.prNumber)
  assert.equal(pull?.base, "dev")
  assert.equal(pull?.head, "backmerge/v1.3.0")
  assert.equal(pull?.title, "chore(release): backmerge v1.3.0 into dev")
  assert.equal(pull?.state, "open")
  assert.equal(pull?.merged, false)
  assert.match(pull?.body ?? "", /by merge commit, never squash/)
  assert.match(pull?.body ?? "", /resolved the conflict with dev at/)
  assert.doesNotMatch(pull?.body ?? "", /The release train merges this pull request/)
})

test("a rerun finds the head and its PR: nothing is built or opened twice", async () => {
  const r = rig("rerun")
  releasedOnMain(r)
  const first = pr(await r.open())
  const head = r.gh.sha(first.head)

  const second = pr(await r.open())
  assert.equal(second.prNumber, first.prNumber)
  assert.equal(second.built, null, "the head was there already")
  assert.equal(r.gh.sha(second.head), head, "not rebuilt")
  assert.equal(r.gh.pulls.size, 1)
})

test("a dev that already contains the release gets no head and no PR", async () => {
  const r = rig("in-dev")
  const { mainSha } = releasedOnMain(r)
  git(r.seed, "fetch", "-q", "origin")
  git(r.seed, "checkout", "-q", "-B", "dev", "origin/dev")
  git(r.seed, "merge", "-q", "--no-edit", "-s", "ours", "origin/main")
  git(r.seed, "push", "-q", "origin", "dev")

  const opened = await r.open({ mergeSha: mainSha })
  assert.deepEqual(opened, { kind: "in_dev", devSha: git(r.origin, "rev-parse", "dev") })
  assert.equal(r.gh.sha("backmerge/v1.3.0"), null)
  assert.equal(r.gh.pulls.size, 0)
})

test("a committer that refuses the backmerge leaves nothing behind: no head, no PR", async () => {
  const r = rig("committer-refuses")
  releasedOnMain(r)

  await assert.rejects(r.open({ commitMerge: failingCommitter }), /the committer refused/)
  assert.equal(r.gh.sha("backmerge/v1.3.0"), null, "no head")
  assert.equal(r.gh.pulls.size, 0, "no PR")
  assert.equal(gitDataCommits(r.gh), 0, "no fallback to the Git Data API")
})

test("a conflict outside the version files and the changelog leaves the head at the release, for a person to resolve", async () => {
  const r = rig("conflict")
  const { mainSha } = releasedOnMain(r, {
    main: { "app.txt": "main's\n" },
    dev: { "app.txt": "dev's\n" },
  })
  // Nothing is committed for it: a committer that refuses would throw.
  const opened = pr(await r.open({ commitMerge: failingCommitter }))
  assert.deepEqual(opened.built?.conflicts, ["app.txt"])
  assert.deepEqual(opened.built?.resolved, [])
  assert.equal(opened.built?.sha, mainSha)
  assert.equal(r.gh.sha(opened.head), mainSha, "the head is the release itself")
  const pull = r.gh.pulls.get(opened.prNumber)
  assert.equal(pull?.state, "open")
  assert.doesNotMatch(pull?.body ?? "", /resolved the conflict/)
})

test("without an injected committer the head's merge commit is made through the Git Data API", async () => {
  const r = rig("git-data")
  const { mainSha, devSha } = releasedOnMain(r)

  const opened = pr(await r.open({ commitMerge: undefined, mergedBy: "train" }))
  const head = r.gh.sha(opened.head)
  assert.ok(head)
  assert.equal(head, opened.built?.sha)
  assert.deepEqual(parentsOf(r.origin, head), [devSha, mainSha], "dev, then the release")
  assert.equal(gitDataCommits(r.gh), 1, "one commit, made by the Git Data API")
  assert.deepEqual([...(opened.built?.resolved ?? [])].sort(), ["CHANGELOG.md", "package.json"])
  assert.match(r.gh.pulls.get(opened.prNumber)?.body ?? "", /The release train merges this pull request/)
})
