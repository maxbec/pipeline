import assert from "node:assert/strict"
import { test } from "node:test"
import { RELEASED_LABEL } from "../src/release/pending.ts"
import { releaseMain, runRelease } from "../src/release-run.ts"
import { scratchDir } from "./helpers/scratch.ts"
import { type World, world } from "./helpers/world.ts"
import { git } from "./workflow/fake-github.ts"

const home = scratchDir("train-release-run-")
const NOW = () => new Date("2026-09-06T12:00:00Z")

function run(w: World, opts: { config?: string; appSlug?: string; dryRun?: boolean } = {}) {
  return runRelease({
    client: w.gh.client,
    repo: w.repo,
    clone: w.clone,
    config: opts.config,
    appSlug: opts.appSlug ?? "train-acme",
    dryRun: opts.dryRun ?? false,
    now: NOW,
  })
}

type Result = Awaited<ReturnType<typeof run>>

function row(result: Result, branch: string) {
  const found = result.rows.find((r) => r.branch === branch)
  assert.ok(found, `no row for ${branch}: ${JSON.stringify(result.rows)}`)
  return found
}

function writes(w: World, from = 0): string[] {
  return w.gh.calls
    .slice(from)
    .filter(
      (c) =>
        c.method !== "GET" &&
        !(c.path === "/graphql" && !JSON.stringify(c.body).includes("mutation")),
    )
    .map((c) => `${c.method} ${c.path}`)
}

/** The number of the open pull request with this head. */
function openPr(w: World, head: string): number {
  const pull = [...w.gh.pulls.values()].find((p) => p.head === head && p.state === "open")
  assert.ok(pull, `no open pull request with head ${head}`)
  return pull.number
}

test("the first run opens the Release PR of dev; main has nothing to promote yet", async () => {
  const w = world(home, "first")
  w.land("feat: the endpoint (#1)")
  const result = await run(w)
  assert.equal(result.failed, false)
  assert.deepEqual(
    result.rows.map((r) => [r.branch, r.result]),
    [
      ["dev", "pr"],
      ["main", "nothing"],
    ],
  )
  assert.equal(row(result, "dev").version, "1.3.0-beta.1")
  assert.equal(w.gh.pulls.get(openPr(w, "release/dev"))?.title, "chore(release): 1.3.0-beta.1")

  // Nothing moved: the second run reads its previous from GitHub and rebuilds nothing.
  const before = w.gh.calls.length
  const again = await run(w)
  assert.equal(row(again, "dev").result, "pr")
  assert.deepEqual(writes(w, before), [])
})

test("a beta, a promotion and a stable release, each merged by a person with the button", async () => {
  const w = world(home, "cycle")
  w.land("feat: the endpoint (#1)")
  await run(w)
  const beta = openPr(w, "release/dev")
  const betaMerge = await w.button(beta, "squash")

  // The merge of the dev Release PR: tag, prerelease, and the promotion PR on main.
  const second = await run(w)
  assert.equal(second.failed, false, JSON.stringify(second.rows))
  assert.equal(row(second, "dev").released, "v1.3.0-beta.1")
  assert.equal(w.gh.tagSha("v1.3.0-beta.1"), betaMerge)
  assert.equal(w.gh.releases.length, 1)
  const prerelease = w.gh.releases[0]
  assert.equal(prerelease?.prerelease, true)
  assert.equal(prerelease?.name, "v1.3.0-beta.1")
  assert.equal(prerelease?.targetCommitish, betaMerge)
  assert.match(prerelease?.body ?? "", /^## \[1\.3\.0-beta\.1\]/)
  assert.match(prerelease?.body ?? "", /the endpoint/)
  assert.equal(
    prerelease?.body,
    prerelease?.body.trimEnd(),
    "the section without its trailing newline",
  )
  assert.deepEqual(w.gh.pulls.get(beta)?.labels, [RELEASED_LABEL])
  assert.equal(row(second, "main").result, "pr")
  assert.equal(row(second, "main").version, "1.3.0")
  assert.equal([...w.gh.pulls.values()].filter((p) => p.head.startsWith("backmerge/")).length, 0)

  // The promotion, merged with the button: GitHub words the commit, and the tip then moves on.
  const promotion = openPr(w, "promote/main")
  const stableMerge = await w.button(promotion, "merge")
  assert.match(git(w.gh.origin, "log", "-1", "--format=%s", stableMerge), /^Merge pull request #/)
  const third = await run(w)
  assert.equal(third.failed, false, JSON.stringify(third.rows))
  assert.equal(row(third, "main").released, "v1.3.0")
  assert.equal(w.gh.tagSha("v1.3.0"), stableMerge)
  const stable = w.gh.releases.find((r) => r.tag === "v1.3.0")
  assert.equal(stable?.prerelease, false)
  assert.equal(stable?.targetCommitish, stableMerge)
  assert.match(stable?.body ?? "", /^## \[1\.3\.0\]/)
  const backmerge = [...w.gh.pulls.values()].find((p) => p.head === "backmerge/v1.3.0")
  assert.ok(backmerge, "the backmerge PR is opened")
  assert.equal(backmerge.base, "dev")
  assert.equal(backmerge.state, "open")
  assert.equal(row(third, "main").backmerge, backmerge.number)
  assert.deepEqual(w.gh.pulls.get(promotion)?.labels, [RELEASED_LABEL])

  // Rerun after the published release: a no-op.
  const before = w.gh.calls.length
  const pulls = w.gh.pulls.size
  const fourth = await run(w)
  assert.equal(fourth.failed, false, JSON.stringify(fourth.rows))
  assert.deepEqual(writes(w, before), [])
  assert.equal(w.gh.releases.length, 2)
  assert.equal(w.gh.pulls.size, pulls)
  assert.equal(row(fourth, "main").released, undefined)
})

test("a Release PR merged by the train's own App is refused: no tag, no release, exit 1", async () => {
  const w = world(home, "bot")
  w.land("feat: the endpoint (#1)")
  await run(w)
  w.gh.mergeActor = { login: "train-acme[bot]", type: "Bot" }
  await w.button(openPr(w, "release/dev"), "squash")
  const before = w.gh.calls.length

  const result = await run(w)
  assert.equal(result.failed, true)
  assert.equal(row(result, "dev").result, "refused")
  assert.match(row(result, "dev").reason ?? "", /person/)
  assert.equal(w.gh.tagSha("v1.3.0-beta.1"), null)
  assert.equal(w.gh.releases.length, 0)
  assert.deepEqual(writes(w, before), [], "and nothing else on that branch either")

  // Another App's merge is not the train's: only its own slug is the defect.
  const other = await run(w, { appSlug: "another-app" })
  assert.equal(row(other, "dev").released, "v1.3.0-beta.1")
})

test("a Release PR that carries `released` is never tagged again", async () => {
  const w = world(home, "label")
  w.land("feat: the endpoint (#1)")
  await run(w)
  const number = openPr(w, "release/dev")
  await w.button(number, "squash")
  await run(w)
  assert.ok(w.gh.tagSha("v1.3.0-beta.1"))

  // A person deletes the release and its tag: that is a decision, not a job to redo.
  git(w.gh.origin, "tag", "-d", "v1.3.0-beta.1")
  w.gh.releases.length = 0
  const result = await run(w)
  assert.equal(result.failed, false, JSON.stringify(result.rows))
  assert.equal(w.gh.tagSha("v1.3.0-beta.1"), null)
  assert.equal(w.gh.releases.length, 0)
  assert.equal(row(result, "dev").released, undefined)
})

test("a tag without its release gets only the release", async () => {
  const w = world(home, "half")
  w.land("feat: the endpoint (#1)")
  await run(w)
  const number = openPr(w, "release/dev")
  const mergeSha = await w.button(number, "squash")
  // The run before this one died between the tag and the release.
  git(w.gh.origin, "tag", "v1.3.0-beta.1", mergeSha)
  const before = w.gh.calls.length

  const result = await run(w)
  assert.equal(result.failed, false, JSON.stringify(result.rows))
  assert.equal(row(result, "dev").released, "v1.3.0-beta.1")
  assert.equal(w.gh.releases.length, 1)
  assert.equal(w.gh.releases[0]?.prerelease, true)
  const tagged = w.gh.calls
    .slice(before)
    .filter((c) => String((c.body as { ref?: string } | undefined)?.ref).startsWith("refs/tags/"))
  assert.deepEqual(tagged, [], "no tag is created: the one there is the right one")
  assert.deepEqual(w.gh.pulls.get(number)?.labels, [RELEASED_LABEL])
})

test("a tag of that version on another commit is exit 1, and nothing is published", async () => {
  const w = world(home, "mismatch")
  w.land("feat: the endpoint (#1)")
  await run(w)
  const elsewhere = w.gh.sha("dev") ?? ""
  await w.button(openPr(w, "release/dev"), "squash")
  git(w.gh.origin, "tag", "v1.3.0-beta.1", elsewhere)

  const result = await run(w)
  assert.equal(result.failed, true)
  assert.equal(row(result, "dev").result, "error")
  assert.match(row(result, "dev").reason ?? "", /v1\.3\.0-beta\.1 already points at/)
  assert.equal(w.gh.releases.length, 0)
})

test("a small repository releases stable from main and opens no backmerge", async () => {
  const w = world(home, "small", "small")
  w.land("fix: the empty case (#1)", "main")
  const first = await run(w)
  assert.deepEqual(
    first.rows.map((r) => [r.branch, r.result, r.version]),
    [["main", "pr", "1.2.1"]],
  )
  const mergeSha = await w.button(openPr(w, "release/main"), "squash")

  const second = await run(w)
  assert.equal(second.failed, false, JSON.stringify(second.rows))
  assert.equal(row(second, "main").released, "v1.2.1")
  assert.equal(row(second, "main").backmerge, undefined)
  assert.equal(w.gh.tagSha("v1.2.1"), mergeSha)
  assert.equal(w.gh.releases[0]?.prerelease, false)
  assert.equal([...w.gh.pulls.values()].filter((p) => p.head.startsWith("backmerge/")).length, 0)
})

test("a promotion that conflicts with main is exit 1", async () => {
  const w = world(home, "conflict")
  w.land("docs: main's own notes", "main", { "NOTES.md": "main\n" })
  const released = w.land("feat: the endpoint (#1)", "dev", { "NOTES.md": "dev\n" })
  git(w.gh.origin, "tag", "v1.3.0-beta.1", released)
  const result = await run(w)
  assert.equal(row(result, "main").result, "conflict", JSON.stringify(result.rows))
  assert.equal(result.failed, true)
})

test("the release block of the config reaches the sync: release_as and version_files", async () => {
  const w = world(home, "config")
  w.land("feat: the endpoint (#1)", "dev", {
    "packages/a/package.json": '{\n  "name": "a",\n  "version": "1.2.0"\n}\n',
  })
  const config = JSON.stringify({
    release_as: "2.0.0-beta.1",
    version_files: ["package.json", "packages/*/package.json"],
  })
  const result = await run(w, { config })
  assert.equal(row(result, "dev").version, "2.0.0-beta.1")
  assert.deepEqual(w.gh.commits.find((c) => c.branch === "release/dev")?.additions.sort(), [
    "CHANGELOG.md",
    "package.json",
    "packages/a/package.json",
  ])
  // A prerelease is dev's to release: main is not asked to release as a beta.
  assert.equal(row(result, "main").result, "nothing", JSON.stringify(result.rows))

  // The same config again: the previous read from GitHub does not force a rebuild.
  const before = w.gh.calls.length
  await run(w, { config })
  assert.deepEqual(writes(w, before), [])
})

test("release_as goes to the branch that releases versions of its kind, and to no other", async () => {
  // A stable version on a major repository: main's, never dev's betas.
  const w = world(home, "release-as-stable")
  w.land("feat: the endpoint (#1)")
  const result = await run(w, { config: '{"release_as":"2.0.0"}' })
  assert.equal(row(result, "dev").version, "1.3.0-beta.1", "dev derives its own")
  assert.equal(row(result, "main").version, "2.0.0")

  // A small repository has one branch, and it takes whatever is asked.
  const small = world(home, "release-as-small", "small")
  small.land("fix: the empty case (#1)", "main")
  assert.equal(row(await run(small, { config: '{"release_as":"2.0.0"}' }), "main").version, "2.0.0")

  // Once the tag is there the override is spent.
  const spent = world(home, "release-as-spent", "small")
  spent.land("fix: the empty case (#1)", "main")
  git(spent.gh.origin, "tag", "v2.0.0", spent.gh.sha("main") ?? "")
  spent.land("fix: another case (#2)", "main")
  assert.equal(row(await run(spent, { config: '{"release_as":"2.0.0"}' }), "main").version, "2.0.1")
})

test("a dry run reports what is pending and writes nothing", async () => {
  const w = world(home, "dry")
  w.land("feat: the endpoint (#1)")
  await run(w)
  await w.button(openPr(w, "release/dev"), "squash")
  const before = w.gh.calls.length
  const result = await run(w, { dryRun: true })
  assert.equal(result.failed, false)
  assert.equal(row(result, "dev").result, "dry_run")
  assert.match(row(result, "dev").reason ?? "", /v1\.3\.0-beta\.1/)
  assert.deepEqual(writes(w, before), [])
  assert.equal(w.gh.tagSha("v1.3.0-beta.1"), null)
})

// ---- the entry: environment, output, exit codes ---------------------------

function entry(w: World, env: Record<string, string> = {}, argv: string[] = []) {
  const out: string[] = []
  const err: string[] = []
  const code = releaseMain({
    env: {
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: `${w.repo.owner}/${w.repo.name}`,
      TRAIN_CLONE: w.clone,
      TRAIN_APP_SLUG: "train-acme",
      ...env,
    },
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    client: w.gh.client,
    now: NOW,
  })
  return { out, err, code }
}

test("the entry prints one JSON line per branch and exits 0", async () => {
  const w = world(home, "entry")
  w.land("feat: the endpoint (#1)")
  const e = entry(w)
  assert.equal(await e.code, 0, e.err.join("\n"))
  const lines = e.out.map((l) => JSON.parse(l) as { branch: string; result: string })
  assert.deepEqual(
    lines.map((l) => [l.branch, l.result]),
    [
      ["dev", "pr"],
      ["main", "nothing"],
    ],
  )
})

test("the entry exits 1 on a bot-merged release and says why", async () => {
  const w = world(home, "entry-bot")
  w.land("feat: the endpoint (#1)")
  await run(w)
  w.gh.mergeActor = { login: "train-acme[bot]", type: "Bot" }
  await w.button(openPr(w, "release/dev"), "squash")
  const e = entry(w)
  assert.equal(await e.code, 1)
  assert.match(e.out.join("\n"), /"result":"refused"/)
  assert.equal(w.gh.tagSha("v1.3.0-beta.1"), null)
})

test("quiet prints counts only: no branch, version, number or reason", async () => {
  const w = world(home, "entry-quiet")
  w.land("feat: the secret endpoint (#1)")
  await run(w)
  await w.button(openPr(w, "release/dev"), "squash")
  const e = entry(w, {}, ["--quiet"])
  assert.equal(await e.code, 0, e.err.join("\n"))
  assert.equal(e.out.length, 1)
  const counts = JSON.parse(e.out[0] ?? "") as Record<string, number>
  assert.equal(counts.released, 1)
  assert.equal(counts.pr, 1)
  for (const value of Object.values(counts)) assert.equal(typeof value, "number")
  assert.doesNotMatch(e.out.join("\n"), /secret|1\.3\.0|dev|main|acme|#\d|endpoint/)

  // And on a failure: the code, not the cause.
  const w2 = world(home, "entry-quiet-fail")
  w2.land("feat: the secret endpoint (#1)")
  await run(w2)
  w2.gh.mergeActor = { login: "train-acme[bot]", type: "Bot" }
  await w2.button(openPr(w2, "release/dev"), "squash")
  const failed = entry(w2, {}, ["--quiet"])
  assert.equal(await failed.code, 1)
  assert.doesNotMatch(
    [...failed.out, ...failed.err].join("\n"),
    /secret|1\.3\.0|dev|acme|#\d|person/,
  )
})

test("a bad release config is a usage error: exit 2, nothing written", async () => {
  const w = world(home, "entry-config")
  w.land("feat: the endpoint (#1)")
  const e = entry(w, { TRAIN_RELEASE_CONFIG: '{"versionFiles":["package.json"]}' })
  assert.equal(await e.code, 2)
  assert.match(e.err.join("\n"), /versionFiles/)
  assert.deepEqual(writes(w), [])
  assert.equal(await entry(w, { GITHUB_TOKEN: "" }).code, 2)
  assert.equal(await entry(w, { TRAIN_CLONE: `${w.clone}-missing` }).code, 2)
})
