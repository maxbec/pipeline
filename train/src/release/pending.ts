import type { GitHubClient } from "../github/client.ts"
import type { RepoRef } from "../github/pr.ts"
import { getTagSha } from "../github/releases.ts"
import { parseVersion } from "./semver.ts"
import { PROMOTION_HEAD, releaseHeadFor } from "./sync.ts"

/**
 * The release a person made by merging a Release PR, found by pull request.
 *
 * `syncReleasePr` recognises such a merge by the branch tip's subject, which
 * only works while the tip is the merge and GitHub titled it
 * `chore(release): X (#N)`. The merge button titles a merge commit "Merge pull
 * request #N from …", and a tip moves on with the next merge. The pull request
 * itself says all of it whatever the commit is called: closed and merged, the
 * release head, its merge commit on the branch.
 *
 * Nothing here needs a clone, so the Merge job can ask too: while a release is
 * pending on a base, nothing else merges into it.
 */

/** Put on a Release PR once its release is published; it is never tagged again after that. */
export const RELEASED_LABEL = "released"

/** The heads a Release PR into `branch` can have. */
export function releaseHeadsFor(branch: string): string[] {
  return branch === "main" ? [releaseHeadFor(branch), PROMOTION_HEAD] : [releaseHeadFor(branch)]
}

export interface MergedBy {
  /** As REST spells it: an App's account carries `[bot]`. */
  login: string
  type: string
}

export interface PendingRelease {
  number: number
  version: string
  mergeSha: string
  mergedBy: MergedBy
}

/** The last Release PR merged into a branch, and how far its release got. */
export interface MergedRelease extends PendingRelease {
  labels: string[]
  /** The commit `v<version>` points at, or null when there is no such tag. */
  tagSha: string | null
}

/** `v<version>` exists and is not the merge: somebody else's tag, or a moved one. */
export class ReleaseTagMismatchError extends Error {
  constructor(release: Pick<MergedRelease, "number" | "version" | "mergeSha">, tagSha: string) {
    super(
      `tag v${release.version} already points at ${tagSha.slice(0, 7)}, not at ${release.mergeSha.slice(0, 7)}, the merge of the Release PR #${release.number}`,
    )
    this.name = "ReleaseTagMismatchError"
  }
}

interface RawPull {
  number: number
  title: string
  merged_at?: string | null
  merge_commit_sha?: string | null
  merged_by?: { login: string; type: string } | null
  labels?: { name: string }[]
  head: { ref: string; repo?: { full_name: string } | null }
  base: { ref: string }
}

const RELEASE_TITLE = /^chore\(release\): (\S+)$/

/** How many merged Release PRs are tried for one that the branch still contains. */
const MAX_CANDIDATES = 5

/** True when `sha` is the branch tip or an ancestor of it, as GitHub sees it. */
async function onBranch(
  client: GitHubClient,
  repo: RepoRef,
  sha: string,
  branch: string,
): Promise<boolean> {
  const res = await client.rest<{ status: string }>(
    "GET",
    `/repos/${repo.owner}/${repo.name}/compare/${sha}...${encodeURIComponent(branch)}?per_page=1`,
  )
  return res.body?.status === "ahead" || res.body?.status === "identical"
}

/**
 * The newest merged Release PR of `branch` whose merge commit the branch still
 * contains, with its tag. Null when the branch never released that way.
 */
export async function findLatestMergedRelease(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
): Promise<MergedRelease | null> {
  const slug = `${repo.owner}/${repo.name}`.toLowerCase()
  const candidates: { pull: RawPull; version: string; mergeSha: string; mergedAt: string }[] = []
  for (const head of releaseHeadsFor(branch)) {
    const res = await client.rest<RawPull[]>(
      "GET",
      `/repos/${repo.owner}/${repo.name}/pulls?state=closed&head=${encodeURIComponent(`${repo.owner}:${head}`)}&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=30`,
    )
    for (const pull of res.body ?? []) {
      // The filters GitHub applied, held again: a fork can name its branch anything.
      if (pull.head.ref !== head || pull.base.ref !== branch) continue
      if (pull.head.repo?.full_name.toLowerCase() !== slug) continue
      if (!pull.merged_at || !pull.merge_commit_sha) continue
      const version = RELEASE_TITLE.exec(pull.title)?.[1]?.replace(/^v/, "")
      if (!version || parseVersion(version) === null) continue
      candidates.push({ pull, version, mergeSha: pull.merge_commit_sha, mergedAt: pull.merged_at })
    }
  }
  candidates.sort(
    (a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || b.pull.number - a.pull.number,
  )
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (!(await onBranch(client, repo, candidate.mergeSha, branch))) continue
    // `merged_by` is on the single pull request only; the list leaves it out.
    const one = await client.rest<RawPull>(
      "GET",
      `/repos/${repo.owner}/${repo.name}/pulls/${candidate.pull.number}`,
    )
    const by = one.body?.merged_by
    return {
      number: candidate.pull.number,
      version: candidate.version,
      mergeSha: candidate.mergeSha,
      mergedBy: { login: by?.login ?? "ghost", type: by?.type ?? "User" },
      labels: (one.body?.labels ?? candidate.pull.labels ?? []).map((l) => l.name),
      tagSha: await getTagSha(client, repo, `v${candidate.version}`),
    }
  }
  return null
}

/**
 * A merged Release PR that has no tag yet: the release the Release job still
 * has to cut. Null when the last one is tagged at its merge, or carries the
 * `released` label (it was published once; a tag deleted by hand since is a
 * decision, not a job to redo).
 *
 * @throws ReleaseTagMismatchError when the version's tag is on another commit.
 */
export async function findPendingRelease(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
): Promise<PendingRelease | null> {
  const latest = await findLatestMergedRelease(client, repo, branch)
  if (!latest || latest.labels.includes(RELEASED_LABEL)) return null
  if (latest.tagSha !== null) {
    if (latest.tagSha === latest.mergeSha) return null
    throw new ReleaseTagMismatchError(latest, latest.tagSha)
  }
  const { number, version, mergeSha, mergedBy } = latest
  return { number, version, mergeSha, mergedBy }
}
