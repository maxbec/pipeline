import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fetchOrigin, readHistory } from "../../src/release/history.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { git } from "../workflow/fake-github.ts"

const home = scratchDir("train-history-")

/**
 * An origin whose `dev` and `main` have diverged the way every repository here
 * does: `dev` is squash-only, so the backmerge of a promotion lands as a fresh
 * commit and `main`'s release tags never enter `dev`'s ancestry.
 */
function rig(name: string) {
  const origin = join(home, `${name}.git`)
  git(home, "init", "-q", "--bare", "-b", "dev", origin)
  const seed = join(home, `${name}-seed`)
  git(home, "clone", "-q", origin, seed)
  const commit = (subject: string) => {
    writeFileSync(join(seed, `${subject.replace(/\W+/g, "-")}.txt`), `${subject}\n`)
    git(seed, "add", "-A")
    git(seed, "commit", "-q", "-m", subject)
  }
  const clone = join(home, "clones", name)
  mkdirSync(join(clone, ".."), { recursive: true })
  return { origin, seed, clone, commit }
}

test("the stable baseline is the newest tag in the repository, not the newest reachable one", async () => {
  const { origin, seed, clone, commit } = rig("promoted")
  commit("chore: init")
  git(seed, "tag", "v1.2.0")
  git(seed, "push", "-q", "origin", "dev", "--tags")
  git(seed, "push", "-q", "origin", "dev:main")

  // A beta on dev, then the promotion: main gets the release, and the
  // backmerge arrives on dev as a squash — no ancestry, so `git tag --merged
  // origin/dev` cannot see v1.3.0. maxbec/pipeline once derived 4.0.0 from a dev
  // whose newest reachable stable tag was still v3.2.0, while v5.0.0 existed.
  commit("feat: something new")
  git(seed, "tag", "v1.3.0-beta.1")
  git(seed, "push", "-q", "origin", "dev", "--tags")
  git(seed, "checkout", "-q", "--orphan", "promotion")
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "chore(release): 1.3.0")
  git(seed, "tag", "v1.3.0")
  git(seed, "push", "-q", "origin", "promotion:main", "--tags", "--force")
  git(seed, "checkout", "-q", "dev")
  commit("fix: a real fix")
  git(seed, "push", "-q", "origin", "dev")

  git(home, "clone", "-q", origin, clone)
  await fetchOrigin(clone)
  const history = await readHistory(clone, "origin/dev")

  assert.equal(history.lastStableTag, "v1.3.0", "a version number belongs to the repository")
  assert.equal(history.lastPrereleaseTag, null, "v1.3.0-beta.1 is older than v1.3.0")
  assert.equal(history.lastReleaseTag, "v1.3.0")
  // The range asks what dev carries that the release does not. v1.3.0 has
  // v1.3.0-beta.1's tree under another SHA: it was promoted from it.
  assert.equal(history.promotedFrom, "v1.3.0-beta.1")
  const subjects = history.commitsSinceStable.map((c) => c.subject)
  assert.deepEqual(subjects, ["fix: a real fix"])
  assert.deepEqual(
    history.alreadyReleased.map((c) => c.subject),
    ["feat: something new", "chore: init"],
  )
})

test("a branch that is ahead of every tag reads its own history", async () => {
  const { origin, seed, clone, commit } = rig("plain")
  commit("chore: init")
  git(seed, "tag", "v2.0.0")
  commit("fix: after the tag")
  git(seed, "push", "-q", "origin", "dev", "--tags")

  git(home, "clone", "-q", origin, clone)
  await fetchOrigin(clone)
  const history = await readHistory(clone, "origin/dev")
  assert.equal(history.lastStableTag, "v2.0.0")
  assert.equal(history.lastReleaseTag, "v2.0.0")
  assert.deepEqual(
    history.commitsSinceStable.map((c) => c.subject),
    ["fix: after the tag"],
  )
})

/**
 * A cycle the way a major repository runs it: feature commits on dev, a Release
 * PR on dev that writes the version files and the changelog, its tag.
 */
function betaCycle(r: ReturnType<typeof rig>, version: string, features: string[]) {
  for (const subject of features) r.commit(subject)
  writeFileSync(join(r.seed, "package.json"), `{ "version": "${version}" }\n`)
  writeFileSync(join(r.seed, "CHANGELOG.md"), `# Changelog\n\n## ${version}\n`)
  git(r.seed, "add", "-A")
  git(r.seed, "commit", "-q", "-m", `chore(release): ${version}`)
  git(r.seed, "tag", `v${version}`)
}

/** main gets `stable` as one commit on its own tip: what a squash merge makes. */
function squashOntoMain(r: ReturnType<typeof rig>, from: string, stable: string) {
  git(r.seed, "checkout", "-q", "main")
  git(r.seed, "checkout", "-q", from, "--", ".")
  writeFileSync(join(r.seed, "package.json"), `{ "version": "${stable}" }\n`)
  writeFileSync(join(r.seed, "CHANGELOG.md"), `# Changelog\n\n## ${stable}\n`)
  git(r.seed, "add", "-A")
  git(r.seed, "commit", "-q", "-m", `chore(release): ${stable} (#386)`)
  git(r.seed, "tag", `v${stable}`)
}

test("a promotion squash-merged into main still carries the beta it was promoted from", async () => {
  const r = rig("squashed-promotion")
  r.commit("chore: init")
  git(r.seed, "tag", "v0.40.0")
  git(r.seed, "branch", "main")
  betaCycle(r, "0.41.0-beta.1", [
    "feat(website): own photo gallery (#384)",
    "fix: metadata (#385)",
  ])
  // The promotion went in as a squash.
  squashOntoMain(r, "v0.41.0-beta.1", "0.41.0")
  // The backmerge is a merge commit, and dev moves on.
  git(r.seed, "checkout", "-q", "dev")
  git(
    r.seed,
    "merge",
    "-q",
    "--no-ff",
    "-X",
    "theirs",
    "-m",
    "chore(release): backmerge v0.41.0 into dev",
    "main",
  )
  r.commit("feat: guest access (#388)")
  git(r.seed, "push", "-q", "origin", "dev", "main", "--tags")

  git(home, "clone", "-q", r.origin, r.clone)
  await fetchOrigin(r.clone)
  const dev = await readHistory(r.clone, "origin/dev")
  assert.equal(dev.lastStableTag, "v0.41.0")
  assert.equal(dev.promotedFrom, "v0.41.0-beta.1")
  assert.deepEqual(
    dev.commitsSinceStable.map((c) => c.subject),
    ["feat: guest access (#388)", "chore(release): backmerge v0.41.0 into dev"],
    "0.41.0's entries are not listed again",
  )
  assert.deepEqual(dev.commitsSinceRelease, dev.commitsSinceStable)
  assert.deepEqual(
    dev.alreadyReleased.map((c) => c.subject),
    [
      "chore(release): 0.41.0-beta.1",
      "fix: metadata (#385)",
      "feat(website): own photo gallery (#384)",
    ],
  )
})

test("a stable release cut from something else is not taken for the promotion of the newest beta", async () => {
  const r = rig("not-promoted")
  r.commit("chore: init")
  git(r.seed, "tag", "v0.40.0")
  git(r.seed, "branch", "main")
  betaCycle(r, "0.41.0-beta.1", ["feat: on dev only (#10)"])
  // main releases 0.41.0 from its own feat hotfix: the beta is not in it.
  git(r.seed, "checkout", "-q", "main")
  r.commit("feat: a hotfix with a feature (#11)")
  git(r.seed, "tag", "v0.41.0")
  git(r.seed, "checkout", "-q", "dev")
  git(r.seed, "push", "-q", "origin", "dev", "main", "--tags")

  git(home, "clone", "-q", r.origin, r.clone)
  await fetchOrigin(r.clone)
  const dev = await readHistory(r.clone, "origin/dev")
  assert.equal(dev.promotedFrom, null, "the tag's tree differs from the beta's in code")
  assert.deepEqual(
    dev.commitsSinceStable.map((c) => c.subject),
    ["chore(release): 0.41.0-beta.1", "feat: on dev only (#10)"],
    "listed again rather than lost",
  )
})
