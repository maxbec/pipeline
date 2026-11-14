import type { GitHubClient } from "../github/client.ts"
import { repositoryKindOf } from "../github/merge.ts"
import type { RepoRef } from "../github/pr.ts"
import { getBranchSha } from "../github/pulls.ts"
import { releaseHeadsFor } from "./pending.ts"
import { baseOf, parseVersion } from "./semver.ts"
import { PROMOTION_HEAD, type ReleaseMode, releaseTitle, type SyncOutput } from "./sync.ts"

/**
 * What the last run of the Release job produced, read from GitHub alone.
 *
 * `syncReleasePr` takes a `previous`: its own last output, which a host used
 * to keep in a state file. A workflow job has no such file, and the pull
 * request's body is no substitute, since anyone with write access can edit
 * it. What cannot be edited is the head commit the train made: GitHub signed
 * it, its headline carries the version, and its parent is the commit the
 * release was cut from.
 *
 * What the sync reads of a `previous`, and where each comes from:
 *
 * | field        | source                                                          |
 * |--------------|-----------------------------------------------------------------|
 * | `prNumber`   | the open Release PR of the branch's release head                |
 * | `head`       | that pull request's head branch                                 |
 * | `headSha`    | the head branch's tip                                           |
 * | `version`    | the tip's headline, `chore(release): <version>`, verified       |
 * | `target`     | the version without its prerelease (the beta counter is in it)  |
 * | `sourceSha`  | the tip's parent; under a forward merge, that merge's first one |
 * | `mergedMain` | the forward merge's second parent, else null                    |
 * | `releaseAs`  | not on GitHub: always null here, see {@link readPrevious}       |
 *
 * The remaining fields of a `SyncOutput` are never read back by the sync;
 * they are filled as far as the pull request says (`prUrl`, `base`, `mode`,
 * `mergeMethod`, `prerelease`) and left empty otherwise (`bump`, `section`,
 * `previousTag`).
 */

export interface PreviousRead {
  previous: SyncOutput | null
  /** Why there is none, or where the one there is was read from. */
  reason: string
}

interface RawPull {
  number: number
  title: string
  html_url: string
  state: "open" | "closed"
  merged_at?: string | null
  head: { ref: string; sha: string; repo?: { full_name: string } | null }
  base: { ref: string }
}

interface RawCommit {
  sha: string
  commit: { message: string; verification?: { verified: boolean; reason: string } }
  parents: { sha: string }[]
}

const VERSION_COMMIT = /^chore\(release\): (\S+)$/
/** The headline `syncReleasePr` gives the promotion's forward merge of main. */
const FORWARD_MERGE = /^chore\(release\): merge main into \S+ for \S+$/

async function commitOf(client: GitHubClient, repo: RepoRef, sha: string): Promise<RawCommit> {
  const res = await client.rest<RawCommit>(
    "GET",
    `/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  )
  if (!res.body) throw new Error(`commit ${sha}: empty response`)
  return res.body
}

function headline(commit: RawCommit): string {
  return commit.commit.message.split("\n", 1)[0] ?? ""
}

async function pullsOf(
  client: GitHubClient,
  repo: RepoRef,
  head: string,
  branch: string,
  state: "open" | "closed",
): Promise<RawPull[]> {
  const slug = `${repo.owner}/${repo.name}`.toLowerCase()
  const res = await client.rest<RawPull[]>(
    "GET",
    `/repos/${repo.owner}/${repo.name}/pulls?state=${state}&head=${encodeURIComponent(`${repo.owner}:${head}`)}&base=${encodeURIComponent(branch)}&sort=created&direction=desc&per_page=5`,
  )
  return (res.body ?? []).filter(
    (p) =>
      p.head.ref === head && p.base.ref === branch && p.head.repo?.full_name.toLowerCase() === slug,
  )
}

/** {@link readPrevious}, with the reason for a null. */
export async function inspectPrevious(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
): Promise<PreviousRead> {
  const none = (reason: string): PreviousRead => ({ previous: null, reason })
  const heads = releaseHeadsFor(branch)

  // The open Release PR; main can have one per head for a moment, the newer one counts.
  let pull: RawPull | null = null
  for (const head of heads) {
    const [open] = await pullsOf(client, repo, head, branch, "open")
    if (open && (!pull || open.number > pull.number)) pull = open
  }
  let closed = false
  if (!pull) {
    // None open: the newest closed one decides. Merged, it was the release and
    // the next cycle starts fresh. Unmerged, a person may have closed it.
    for (const head of heads) {
      const [last] = await pullsOf(client, repo, head, branch, "closed")
      if (last && (!pull || last.number > pull.number)) pull = last
    }
    if (!pull) return none(`no Release PR on ${branch}`)
    if (pull.merged_at) return none(`the last Release PR #${pull.number} was merged`)
    closed = true
  }

  const head = pull.head.ref
  const headSha = await getBranchSha(client, repo, head)
  if (headSha === null) return none(`the head ${head} of #${pull.number} is gone`)
  // A closed pull request keeps the head it was closed with. Only that one,
  // untouched, is "closed by a person"; a head that moved since is nobody's decision.
  if (closed && pull.head.sha !== headSha) {
    return none(`the closed Release PR #${pull.number} no longer has the head it was closed with`)
  }

  const tip = await commitOf(client, repo, headSha)
  if (!tip.commit.verification?.verified) {
    return none(
      `the head commit ${headSha.slice(0, 7)} of ${head} is not verified (${tip.commit.verification?.reason ?? "unknown"})`,
    )
  }
  const version = VERSION_COMMIT.exec(headline(tip))?.[1]
  const parsed = version ? parseVersion(version) : null
  if (!version || !parsed) {
    return none(
      `the head commit ${headSha.slice(0, 7)} of ${head} is not the train's version commit: "${headline(tip)}"`,
    )
  }
  const parent = tip.parents.length === 1 ? tip.parents[0]?.sha : undefined
  if (!parent) {
    return none(
      `the head commit ${headSha.slice(0, 7)} of ${head} has ${tip.parents.length} parents`,
    )
  }
  if (closed && pull.title !== releaseTitle(version)) {
    return none(
      `the closed Release PR #${pull.number} does not carry the version of its head in its title`,
    )
  }

  // A promotion whose main had commits dev lacked sits on a merge of main
  // into dev's release: the source is that merge's first parent.
  let sourceSha = parent
  let mergedMain: string | null = null
  if (head === PROMOTION_HEAD) {
    const below = await commitOf(client, repo, parent)
    const [ours, theirs] = below.parents
    if (below.parents.length === 2 && ours && theirs && FORWARD_MERGE.test(headline(below))) {
      sourceSha = ours.sha
      mergedMain = theirs.sha
    }
  }

  const mode: ReleaseMode =
    head === PROMOTION_HEAD
      ? "promotion"
      : branch === "main" && (await repositoryKindOf(client, repo)) === "major"
        ? "hotfix"
        : "branch"
  const source = mode === "promotion" ? "dev" : branch
  return {
    reason: closed
      ? `the closed Release PR #${pull.number}, its head intact`
      : `the open Release PR #${pull.number}`,
    previous: {
      prNumber: pull.number,
      prUrl: pull.html_url,
      version,
      target: baseOf(parsed),
      bump: "",
      head,
      base: branch,
      source,
      sourceRef: `origin/${source}`,
      mode,
      mergeMethod: mode === "branch" ? "squash" : "merge",
      prerelease: parsed.prerelease !== null,
      sourceSha,
      headSha,
      previousTag: null,
      section: "",
      releaseAs: null,
      mergedMain,
    },
  }
}

/**
 * The `previous` of the next `syncReleasePr`, or null when GitHub shows none
 * the train can trust: no Release PR, a merged one, or a head whose tip is
 * not the train's verified version commit. A null is always safe: the sync
 * then derives everything from the tags and rebuilds the head.
 *
 * `releaseAs` is the one field GitHub does not hold: it says which override
 * was in force when the head was built, and the sync compares it with the
 * current one only to rebuild on a change. The caller sets it to the current
 * override. A change that alters the version is still caught, because the
 * sync compares the versions too; one that does not needs no rebuild.
 */
export async function readPrevious(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
): Promise<SyncOutput | null> {
  return (await inspectPrevious(client, repo, branch)).previous
}
