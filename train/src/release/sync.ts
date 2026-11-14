import type { Repository } from "../types.ts"
import type { GitHubClient } from "../github/client.ts"
import { createSignedCommit, type MergeMethod } from "../github/merge.ts"
import { REQUIRED_CHECKS, type RepoRef } from "../github/pr.ts"
import {
  createBranch,
  createPullRequest,
  deleteBranch,
  findOpenPullRequest,
  getBranchSha,
  getPullRequest,
} from "../github/pulls.ts"
import { updateBranchRef, updatePullRequest } from "../github/releases.ts"
import { createMergeCommit, type MergeCommitter, type MergePlan, planMerge } from "./backmerge.ts"
import { prependToChangelog, renderSection } from "./changelog.ts"
import { parseConventional } from "./conventional.ts"
import {
  commitsBetween,
  containedIn,
  fetchOrigin,
  globToRegExp,
  isAncestor,
  listTree,
  type ReleaseHistory,
  reachableOnlyFrom,
  readHistory,
  readTreeFile,
  resolveRef,
} from "./history.ts"
import { type Bump, baseOf, parseVersion } from "./semver.ts"
import { deriveVersion, impactOf } from "./version.ts"
import { applyVersion } from "./version-files.ts"

/**
 * One Release PR per branch, recomputed at every merge (version rule 3).
 * The head is reset to the base tip and carries exactly one commit — the
 * version files and the CHANGELOG — made by the engine through
 * `createCommitOnBranch`. Nothing here calls a model.
 *
 * Idempotent by construction: a base that has not moved since the last sync
 * leaves head and PR alone; a PR that was merged in the meantime is reported
 * as merged, never re-created.
 */

export const CHANGELOG_PATH = "CHANGELOG.md"

/** The pipeline caller every repository on the pipeline carries. */
const CALLER_PATH = ".github/workflows/ci.yaml"

export interface SyncOutput {
  prNumber: number
  prUrl: string
  version: string
  target: string
  bump: string
  head: string
  base: string
  /** What is released: the branch whose tree the head was cut from. */
  source: string
  /** What the version commit sits on: the source tip, or dev's last release for a promotion. */
  sourceRef: string
  /** `branch`: the branch's own commits; `hotfix`: main's own; `promotion`: dev into main. */
  mode: ReleaseMode
  mergeMethod: MergeMethod
  prerelease: boolean
  sourceSha: string
  headSha: string
  previousTag: string | null
  section: string
  releaseAs: string | null
  /**
   * A promotion whose main carried commits dev never received merges main into
   * its head first: the tip of main that was merged, so the
   * next sync knows whether main moved. `null` when nothing had to be merged.
   */
  mergedMain?: string | null
}

export type SyncResult =
  /**
   * `withdrawn`: the number of the Release PR this sync closed because the
   * branch has nothing left to release; absent when none was open.
   */
  | { kind: "nothing"; reason: string; withdrawn?: number }
  | { kind: "pr"; output: SyncOutput; changed: boolean }
  | { kind: "merged"; output: SyncOutput; mergeSha: string }
  /** Somebody closed the Release PR on purpose (its head is intact): it stays closed. */
  | { kind: "closed"; output: SyncOutput; reason: string }
  /** The promotion's forward merge of main conflicts outside what the engine resolves. */
  | { kind: "conflict"; reason: string }
  /** The base tip's own `pipeline / Check` is not green yet: the Release PR stays as it is. */
  | { kind: "pending"; reason: string }

export interface SyncInput {
  client: GitHubClient
  repository: Repository
  branch: string
  releaseAs: string | null
  previous: SyncOutput | null
  now: () => Date
  /**
   * Who makes the promotion's forward merge. Defaults to the Git Data API,
   * which GitHub signs on an App or Actions token only; a commit made that
   * way on a user's token stays unsigned, so such a caller passes its own.
   */
  commitMerge?: MergeCommitter
}

export type ReleaseMode = "branch" | "hotfix" | "promotion"

/** The promotion PR's head: dev's last release plus the version commit, merged by merge commit. */
export const PROMOTION_HEAD = "promote/main"

export function releaseHeadFor(branch: string): string {
  return `release/${branch}`
}

export function releaseTitle(version: string): string {
  return `chore(release): ${version}`
}

export function isSyncOutput(value: unknown): value is SyncOutput {
  const o = value as Partial<SyncOutput> | null
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.prNumber === "number" &&
    typeof o.version === "string" &&
    typeof o.head === "string" &&
    typeof o.sourceSha === "string"
  )
}

function prBody(
  section: string,
  version: string,
  branch: string,
  prerelease: boolean,
  note: string | null,
): string {
  const deploy = prerelease
    ? "as a pre-release, which deploys preview"
    : "as the latest release, which deploys production"
  return [
    section.trimEnd(),
    "",
    "---",
    ...(note ? [note, ""] : []),
    `Merging this pull request **is** the release: the release train tags \`v${version}\`, publishes the GitHub release ${deploy}, and backmerges where a backmerge is due.`,
    `The version is recomputed at every merge into \`${branch}\` and only grows. To release as a different version, rerun the train with that version as its release-as.`,
    "",
  ].join("\n")
}

function isoDate(now: () => Date): string {
  return now().toISOString().slice(0, 10)
}

/** The version files of the source tree, each with the new version applied. */
async function versionedFiles(
  repository: Repository,
  ref: string,
  version: string,
  overrides: ReadonlyMap<string, string> = new Map(),
): Promise<{ path: string; contents: string }[]> {
  const tree = await listTree(repository.path, ref)
  const paths = new Set<string>()
  for (const glob of repository.versionFiles) {
    const re = globToRegExp(glob)
    for (const path of tree) if (re.test(path)) paths.add(path)
  }
  const files: { path: string; contents: string }[] = []
  for (const path of [...paths].sort()) {
    const content = overrides.get(path) ?? (await readTreeFile(repository.path, ref, path))
    if (content === null) continue
    files.push({ path, contents: applyVersion(path, `${content}\n`, version) })
  }
  return files
}

/**
 * What this branch would release right now. Exported for the promotion and
 * hotfix modes that build on it; `syncReleasePr` is the whole operation.
 */
export async function planRelease(
  repository: Repository,
  branch: string,
  history: ReleaseHistory,
  opts: { currentTarget: string | null; releaseAs: string | null },
): Promise<
  | { kind: "nothing"; reason: string }
  | { kind: "release"; version: string; target: string; bump: string; prerelease: boolean }
> {
  const repoKind = repository.kind
  // Anything new since the last release of this branch? A docs-only merge
  // after a beta is not a release, whatever the target says.
  const sinceRelease = deriveVersion({
    commits: history.commitsSinceRelease,
    lastStableTag: history.lastStableTag,
    lastPrerelease: history.lastPrereleaseTag,
    branch,
    repoKind,
    currentTarget: null,
    override: opts.releaseAs,
  })
  if (sinceRelease.bump === "none") {
    return {
      kind: "nothing",
      reason: `nothing to release on ${branch} since ${history.lastReleaseTag ?? "the beginning"}: ${sinceRelease.reason}${setAside(history)}`,
    }
  }
  const derived = deriveVersion({
    commits: history.commitsSinceStable,
    lastStableTag: history.lastStableTag,
    lastPrerelease: history.lastPrereleaseTag,
    branch,
    repoKind,
    currentTarget: opts.currentTarget,
    override: opts.releaseAs,
  })
  if (!derived.version || !derived.target) {
    return { kind: "nothing", reason: derived.reason }
  }
  return {
    kind: "release",
    version: derived.version,
    target: derived.target,
    bump: derived.bump,
    prerelease: parseVersion(derived.version)?.prerelease !== null,
  }
}

/** What the patch-identity filter dropped, for the "nothing" reason. */
function setAside(history: ReleaseHistory): string {
  const already = history.alreadyReleased
  if (already.length === 0) return ""
  const list = already.map((c) => c.subject).join("; ")
  return `; ${already.length} commit(s) already in ${history.lastStableTag} under another SHA: ${list}`
}

function carriesImpact(commits: ReleaseHistory["commitsSinceRelease"]): boolean {
  return commits.some((c) => {
    const parsed = parseConventional(c)
    return parsed !== null && impactOf(parsed) !== null
  })
}

interface ReleaseSource {
  mode: ReleaseMode
  source: string
  sourceRef: string
  head: string
  mergeMethod: MergeMethod
  history: ReleaseHistory
}

/**
 * What a branch releases. dev, and main of a small repository, release
 * their own commits. main of a major repository releases either its own
 * unreleased commits — a hotfix — or, when it has none, dev's last
 * release: the promotion. The promotion's history is main's
 * baseline with dev's commits on top, so the version and the section are
 * derived exactly as for any other branch.
 */
async function readSource(repository: Repository, branch: string): Promise<ReleaseSource> {
  const clone = repository.path
  if (branch !== "main" || repository.kind !== "major") {
    const ref = `origin/${branch}`
    return {
      mode: "branch",
      source: branch,
      sourceRef: ref,
      head: releaseHeadFor(branch),
      mergeMethod: "squash",
      history: await readHistory(clone, ref),
    }
  }
  const main = await readHistory(clone, "origin/main")
  const dev = await readHistory(clone, "origin/dev")
  const sourceRef = dev.lastReleaseTag ?? "origin/dev"
  const sha = await resolveRef(clone, sourceRef)
  if (!sha) throw new Error(`${repository.owner}/${repository.name}: no ${sourceRef} in the clone`)
  // main's own commits are the ones dev's last release does not carry. A
  // repository that became major with unreleased commits on main cut dev from
  // them; those reach main through the promotion, not as a hotfix.
  const notInDev = new Set((await commitsBetween(clone, sha, "origin/main")).map((c) => c.sha))
  // main of a major repository takes merge commits only, the hotfix
  // release as much as the promotion.
  if (carriesImpact(main.commitsSinceRelease.filter((c) => notInDev.has(c.sha)))) {
    return {
      mode: "hotfix",
      source: "main",
      sourceRef: "origin/main",
      head: releaseHeadFor("main"),
      mergeMethod: "merge",
      history: main,
    }
  }
  // The same change can reach main twice: a fix on dev that main
  // already carries as a hotfix is not promoted again, nor is a cycle main
  // already carries through a squash-merged promotion.
  const between = await commitsBetween(clone, "origin/main", sha)
  const carried = main.promotedFrom
    ? await reachableOnlyFrom(clone, main.promotedFrom, "origin/main")
    : new Set<string>()
  const onMain = await containedIn(
    clone,
    "origin/main",
    between.filter((c) => !carried.has(c.sha ?? "")),
  )
  const released = (c: { sha?: string }) => carried.has(c.sha ?? "") || onMain.has(c.sha ?? "")
  const promoted = between.filter((c) => !released(c))
  return {
    mode: "promotion",
    source: "dev",
    sourceRef,
    head: PROMOTION_HEAD,
    mergeMethod: "merge",
    history: {
      sha,
      lastStableTag: main.lastStableTag,
      lastPrereleaseTag: null,
      lastReleaseTag: main.lastReleaseTag,
      commitsSinceStable: [...promoted, ...main.commitsSinceStable],
      commitsSinceRelease: [...promoted, ...main.commitsSinceRelease],
      alreadyReleased: between.filter(released),
      promotedFrom: main.promotedFrom,
    },
  }
}

/** The squash or merge commit of a Release PR: the title the execute stage sets. */
const RELEASE_COMMIT = /^chore\(release\): (\S+) \(#(\d+)\)$/

/**
 * A Release PR merged in GitHub whose cycle ended before the tag — the
 * release step failed for good — and the next cycle starts with no
 * `previous`. The base tip is then the version commit itself, untagged, so
 * `commitsSinceRelease` still lists it; planning from those commits would
 * open a second PR for the same version with the CHANGELOG section doubled.
 * The tip names its PR; GitHub confirms that PR is the merge; the result is
 * the merge, and the execute stage tags and publishes it as it would have.
 * A tagged release is never seen here: the tag ends the range.
 */
async function mergedUntaggedRelease(
  input: SyncInput,
  src: ReleaseSource,
  repo: RepoRef,
): Promise<SyncResult | null> {
  const { client, repository, branch } = input
  const tipSha = await resolveRef(repository.path, `origin/${branch}`)
  if (!tipSha) return null
  const tip = src.history.commitsSinceRelease.find((c) => c.sha === tipSha)
  const match = tip ? RELEASE_COMMIT.exec(tip.subject) : null
  if (!match) return null
  const version = match[1] ?? ""
  const number = Number(match[2])
  const parsed = parseVersion(version)
  if (!parsed) return null
  const pull = await getPullRequest(client, repo, number)
  if (!pull.merged || pull.mergeCommitSha !== tipSha) return null

  const commits = src.history.commitsSinceRelease.filter((c) => c.sha !== tipSha)
  let bump: Bump = "patch"
  for (const commit of commits) {
    const conventional = parseConventional(commit)
    const impact = conventional ? impactOf(conventional) : null
    if (impact === "major" || (impact === "minor" && bump === "patch")) bump = impact
  }
  const section = renderSection({
    version,
    previousTag: src.history.lastReleaseTag,
    date: isoDate(input.now),
    repo,
    commits,
    showHidden: repository.changelogShowHidden,
  })
  const sourceSha = (await resolveRef(repository.path, `${tipSha}^`)) ?? tipSha
  return {
    kind: "merged",
    mergeSha: tipSha,
    output: {
      prNumber: pull.number,
      prUrl: pull.url,
      version,
      target: baseOf(parsed),
      bump,
      head: src.head,
      base: branch,
      source: src.source,
      sourceRef: src.sourceRef,
      mode: src.mode,
      mergeMethod: src.mergeMethod,
      prerelease: parsed.prerelease !== null,
      sourceSha,
      headSha: pull.headSha,
      previousTag: src.history.lastReleaseTag,
      section,
      releaseAs: input.releaseAs,
      mergedMain: null,
    },
  }
}

/** The promotion's forward merge: main's tip and the merge of it into dev's release. */
interface ForwardMerge {
  mainSha: string
  plan: Extract<MergePlan, { kind: "resolved" }>
}

/**
 * A promotion assumes dev contains main, which every backmerge keeps true —
 * except for a main that released before anything backmerged it (for one,
 * maxbec/pipeline v5.0.1). Its promotion PR, built on dev's release tag, then conflicts
 * with main in the version files and the changelog, and GitHub's merge button
 * cannot take it. The engine merges main into the head first, resolved as a
 * backmerge is (dev's version files, the union of the changelogs), and puts
 * the version commit on top; the stable release that follows is backmerged as
 * usual, after which dev contains main and this path is never taken again.
 */
async function planForwardMerge(
  repository: Repository,
  sourceSha: string,
): Promise<ForwardMerge | { kind: "conflict"; paths: string[] } | null> {
  const clone = repository.path
  const mainSha = await resolveRef(clone, "origin/main")
  if (!mainSha || (await isAncestor(clone, mainSha, sourceSha))) return null
  const plan = await planMerge(repository, sourceSha, mainSha)
  if (plan.kind === "conflict") return plan
  return { mainSha, plan }
}

/**
 * A Release PR still open on a branch whose only changes the last stable tag
 * already carries is closed and its head deleted: it would release
 * them a second time — maxbec/pipeline#93, "5.0.3-beta.1" for a #87
 * already in v5.0.2. The target does not survive it; the next change starts a
 * fresh Release PR from the stable baseline. Returns the closed PR's number.
 */
async function withdrawReleasePr(
  client: GitHubClient,
  repo: RepoRef,
  head: string,
): Promise<number | null> {
  const open = await findOpenPullRequest(client, repo, head)
  if (!open) return null
  await updatePullRequest(client, repo, open.number, { state: "closed" })
  await deleteBranch(client, repo, head)
  return open.number
}

/** Where the next head of a Release PR is built before the head moves onto it. */
export function stagingBranch(head: string): string {
  return `train-staging/${head}`
}

/**
 * Why the Release PR must not be rebuilt over `sha` yet, or null when it may.
 *
 * The head is `sha` plus the version commit, and the pipeline reuses the
 * Check of `sha`'s own push run for exactly that head instead of running it
 * again (maxbec/pipeline#99). So the head is built only once that run is
 * green. Before that, a rebuild would run the full Check on a tree the push run
 * is checking at the same moment: minutes of a runner, once per merge. A red base is not offered as a
 * release either: the fix task the red Check opens moves the tip again.
 * Waiting also folds a burst of merges into one rebuild. The check_run
 * webhook of the push run pokes the train, so no clock is involved.
 *
 * A repository without the pipeline caller has no such run to wait for.
 */
async function baseCheckPending(
  client: GitHubClient,
  repo: RepoRef,
  repository: Repository,
  sha: string,
  label: string,
): Promise<string | null> {
  if ((await readTreeFile(repository.path, sha, CALLER_PATH)) === null) return null
  // Every run, not GitHub's default "latest": a released commit also carries
  // the release event's run, whose Check is always skipped, and that one is
  // the latest. Seen on the first promotion after this gate, maxbec/pipeline
  // v5.2.0-beta.2 (e4f38e2): green push run, skipped release run, and the
  // promotion waited on a Check that had passed.
  const res = await client.rest<{
    check_runs: { name: string; status: string; conclusion: string | null }[]
  }>("GET", `/repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?filter=all&per_page=100`)
  const runs = res.body?.check_runs ?? []
  const at = `${label} at ${sha.slice(0, 7)}`
  for (const name of REQUIRED_CHECKS) {
    const named = runs.filter((r) => r.name === name)
    // One pass proves the tree: it is the same commit whichever run checked it.
    if (named.some((r) => r.conclusion === "success")) continue
    if (named.length === 0) return `waiting for ${name} on ${at} to start`
    if (named.some((r) => r.status !== "completed")) return `waiting for ${name} on ${at} to finish`
    const red = named.find((r) => r.conclusion !== "skipped") ?? named[0]
    return `${name} is ${red?.conclusion ?? "unknown"} on ${at}; the Release PR waits for a green ${label}`
  }
  return null
}

export async function syncReleasePr(input: SyncInput): Promise<SyncResult> {
  const { client, repository, branch, releaseAs, previous } = input
  const repo: RepoRef = { owner: repository.owner, name: repository.name }

  // Status check first: the PR of the previous sync may have been merged by
  // hand in the meantime — that is the release, not a reason to open another.
  const previousPr = previous ? await getPullRequest(client, repo, previous.prNumber) : null
  if (previous && previousPr?.merged && previousPr.mergeCommitSha) {
    return { kind: "merged", output: previous, mergeSha: previousPr.mergeCommitSha }
  }

  await fetchOrigin(repository.path)
  const src = await readSource(repository, branch)
  const { history } = src
  const ref = history.sha
  // The base tip may itself be a merged Release PR whose cycle died before the
  // tag (F11): that PR *is* the release, whatever `previous` knows.
  const untagged = await mergedUntaggedRelease(input, src, repo)
  if (untagged) return untagged
  // Rule 3 (the target only grows) holds within one Release PR. A hotfix
  // under an open promotion PR is another release line: its target starts over.
  const plan = await planRelease(repository, branch, history, {
    currentTarget: previous && previous.head === src.head ? previous.target : null,
    releaseAs,
  })
  if (plan.kind === "nothing") {
    const reason =
      src.mode === "promotion" ? `nothing to promote from dev: ${plan.reason}` : plan.reason
    // Only when the stable tag explains the "nothing": a Release PR kept at a
    // cleared "release as" over a docs-only range also plans nothing, and that
    // one stays (rule 3) — it is the owner's to close.
    const withdrawn =
      history.alreadyReleased.length > 0 ? await withdrawReleasePr(client, repo, src.head) : null
    return withdrawn === null
      ? { kind: "nothing", reason }
      : { kind: "nothing", reason: `${reason}; closed the Release PR #${withdrawn}`, withdrawn }
  }

  const forward = src.mode === "promotion" ? await planForwardMerge(repository, history.sha) : null
  if (forward && "kind" in forward) {
    return {
      kind: "conflict",
      reason: `the promotion of ${src.sourceRef} conflicts with main in ${forward.paths.join(", ")}: main carries commits dev never received; backmerge main into dev by hand; the next release of dev promotes cleanly`,
    }
  }
  const mergedMain = forward?.mainSha ?? null

  const head = src.head
  // A mode switch (a hotfix landed under an open promotion PR, or the other
  // way round) changes the head: the PR of the old head is closed, not left.
  if (previous && previousPr && previous.head !== head) {
    if (!previousPr.merged && previousPr.state === "open") {
      await updatePullRequest(client, repo, previous.prNumber, { state: "closed" })
      await deleteBranch(client, repo, previous.head)
    }
  }
  const openPr = await findOpenPullRequest(client, repo, head)
  // The previous PR is closed but not merged, on the same head. Two ways there:
  // a sync that died between the reset and the commit left it closed for good
  // (GitHub closes a PR with no commits over its base) — its head is the base
  // tip now, not the head the sync recorded — and that PR is the one to
  // reopen, never the reason for a second one. Or a person closed it,
  // and the head the train built is still there untouched: that is a decision,
  // and it stays closed; the train reports it and touches nothing. A PR the
  // mode switch above closed on purpose has another head and is neither.
  const closedUnmerged =
    previous && previousPr && previous.head === head && !previousPr.merged && !openPr
      ? previousPr
      : null
  if (previous && closedUnmerged && closedUnmerged.headSha === previous.headSha) {
    return {
      kind: "closed",
      output: previous,
      reason: `the Release PR #${previous.prNumber} was closed with its head intact; it stays closed until someone reopens it`,
    }
  }
  const crashed = closedUnmerged
  if (
    previous &&
    openPr &&
    openPr.number === previous.prNumber &&
    previous.sourceSha === history.sha &&
    (previous.mergedMain ?? null) === mergedMain &&
    previous.version === plan.version &&
    previous.releaseAs === releaseAs &&
    openPr.headSha === previous.headSha
  ) {
    return { kind: "pr", output: previous, changed: false }
  }

  const label = src.sourceRef.replace(/^origin\//, "")
  const waitFor = await baseCheckPending(client, repo, repository, history.sha, label)
  if (waitFor) return { kind: "pending", reason: waitFor }

  const section = renderSection({
    version: plan.version,
    previousTag: history.lastReleaseTag,
    date: isoDate(input.now),
    repo,
    commits: history.commitsSinceRelease,
    showHidden: repository.changelogShowHidden,
  })
  // The forward merge, when main has commits the release lacks: a two-parent
  // commit on GitHub (the clone only has its tree), the version commit's base.
  let base = history.sha
  let baseTree = ref
  const merged = new Map<string, string>()
  const staging = stagingBranch(head)
  if (forward) {
    const resolved =
      forward.plan.resolved.length > 0 ? ` Resolved: ${forward.plan.resolved.join(", ")}.` : ""
    const commitMerge: MergeCommitter =
      input.commitMerge ?? ((merge) => createMergeCommit(client, repo, merge))
    base = await commitMerge({
      branch: staging,
      clone: repository.path,
      ours: history.sha,
      theirs: forward.mainSha,
      plan: forward.plan,
      message: `chore(release): merge main into ${head} for ${plan.version}\n\nmain carried commits dev never received; merged by the release train ahead of the promotion.${resolved}`,
    })
    baseTree = forward.plan.tree
    // The plan's entries are byte-exact; `readTreeFile` trims. The writers
    // below add the one trailing newline themselves, so the override must
    // look like a `readTreeFile` result or the written file ends in two
    // (and a formatter fails the Check on exactly that).
    for (const entry of forward.plan.entries) {
      if (entry.content !== null) {
        merged.set(entry.path, entry.content.toString("utf8").replace(/\n+$/, ""))
      }
    }
  }
  const existingChangelog =
    merged.get(CHANGELOG_PATH) ?? (await readTreeFile(repository.path, baseTree, CHANGELOG_PATH))
  const additions = [
    ...(await versionedFiles(repository, baseTree, plan.version, merged)),
    {
      path: CHANGELOG_PATH,
      contents: prependToChangelog(
        existingChangelog === null ? null : `${existingChangelog}\n`,
        section,
      ),
    },
  ]

  // The head is the base plus one signed commit, every time. A head that
  // already exists is not reset to the base first: that passes through "no
  // commits over the base", GitHub closes the PR, and the reopen and the push
  // each start a pipeline run. The commit is built on a staging branch and
  // the head moves onto it in one step — one push, one run, the PR stays open.
  const message = {
    headline: releaseTitle(plan.version),
    body: "Release PR maintained by the release train. Merging it is the release.",
  }
  let commit: { oid: string }
  if ((await getBranchSha(client, repo, head)) === null) {
    await createBranch(client, repo, head, base)
    commit = await createSignedCommit(client, {
      repo,
      branch: head,
      expectedHeadOid: base,
      message,
      additions,
    })
    // A committer that pushed the forward merge left it on the staging branch.
    if (forward && input.commitMerge) await deleteBranch(client, repo, staging)
  } else {
    // A sync that died after creating it left it behind: reuse, never trip on it.
    if ((await getBranchSha(client, repo, staging)) === null) {
      await createBranch(client, repo, staging, base)
    } else {
      await updateBranchRef(client, repo, staging, base, { force: true })
    }
    commit = await createSignedCommit(client, {
      repo,
      branch: staging,
      expectedHeadOid: base,
      message,
      additions,
    })
    await updateBranchRef(client, repo, head, commit.oid, { force: true })
    await deleteBranch(client, repo, staging)
  }

  const title = releaseTitle(plan.version)
  const forwardNote = forward
    ? ` main carried commits dev never received, so the release train merged main (\`${forward.mainSha.slice(0, 7)}\`) into the head first${forward.plan.resolved.length > 0 ? `, resolving ${forward.plan.resolved.map((p) => `\`${p}\``).join(", ")}` : ""}; the backmerge after this release brings them to dev.`
    : ""
  const note =
    src.mode === "promotion"
      ? `This is the promotion of \`dev\` into \`main\`: \`${src.sourceRef}\` (\`${history.sha.slice(0, 7)}\`), the last release of dev, merged by merge commit. Commits on dev after that release wait for their own beta.${forwardNote}`
      : src.mode === "hotfix"
        ? "This is a hotfix release from `main`'s own commits; its backmerge into `dev` follows the release."
        : null
  const body = prBody(section, plan.version, branch, plan.prerelease, note)
  let number: number
  let url: string
  // A sync that died between creating the head and its commit left the PR
  // closed with no commits over the base (`crashed`); asking for `open` again
  // is idempotent for one that never closed.
  const reopenable = openPr ?? crashed
  if (reopenable) {
    number = reopenable.number
    url = reopenable.url
    await updatePullRequest(client, repo, number, { title, body, state: "open" })
  } else {
    const created = await createPullRequest(client, repo, { head, base: branch, title, body })
    number = created.number
    url = created.url
  }
  return {
    kind: "pr",
    changed: true,
    output: {
      prNumber: number,
      prUrl: url,
      version: plan.version,
      target: plan.target,
      bump: plan.bump,
      head,
      base: branch,
      source: src.source,
      sourceRef: src.sourceRef,
      mode: src.mode,
      mergeMethod: src.mergeMethod,
      prerelease: plan.prerelease,
      sourceSha: history.sha,
      headSha: commit.oid,
      previousTag: history.lastReleaseTag,
      section,
      releaseAs,
      mergedMain,
    },
  }
}
