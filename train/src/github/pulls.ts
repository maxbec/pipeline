import { type GitHubClient, GitHubHttpError } from "./client.ts"
import type { RepoRef } from "./pr.ts"

/**
 * Pull requests and branch refs, the handful of REST calls the default
 * workflow needs beyond reading state (pr.ts) and merging (merge.ts). Every
 * call here is a status check or an idempotent write: a PR is looked up by
 * head before one is created, a ref is created only if missing, a delete of
 * a missing ref is a no-op.
 */

export interface PullRequestRef {
  number: number
  headSha: string
  url: string
  state: "open" | "closed"
  merged: boolean
  /** Set once merged; the squash commit on the base. */
  mergeCommitSha: string | null
}

interface RawPull {
  number: number
  html_url: string
  state: "open" | "closed"
  merged?: boolean
  merged_at?: string | null
  merge_commit_sha?: string | null
  head: { sha: string }
}

function shape(raw: RawPull): PullRequestRef {
  return {
    number: raw.number,
    headSha: raw.head.sha,
    url: raw.html_url,
    state: raw.state,
    merged: Boolean(raw.merged ?? raw.merged_at),
    mergeCommitSha: raw.merge_commit_sha ?? null,
  }
}

export async function getPullRequest(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
): Promise<PullRequestRef> {
  const res = await client.rest<RawPull>("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`)
  if (!res.body) throw new Error(`pull request ${number}: empty response`)
  return shape(res.body)
}

/** The open PR whose head is `branch`, if any. GitHub allows one per head+base. */
export async function findOpenPullRequest(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
): Promise<PullRequestRef | null> {
  const head = encodeURIComponent(`${repo.owner}:${branch}`)
  const res = await client.rest<RawPull[]>(
    "GET",
    `/repos/${repo.owner}/${repo.name}/pulls?head=${head}&state=open&per_page=1`,
  )
  const first = res.body?.[0]
  return first ? shape(first) : null
}

export async function createPullRequest(
  client: GitHubClient,
  repo: RepoRef,
  input: { head: string; base: string; title: string; body: string },
): Promise<PullRequestRef> {
  const res = await client.rest<RawPull>("POST", `/repos/${repo.owner}/${repo.name}/pulls`, {
    body: { head: input.head, base: input.base, title: input.title, body: input.body },
  })
  if (!res.body) throw new Error("create pull request: empty response")
  return shape(res.body)
}

/** The sha a branch points at on GitHub, or null when it does not exist. */
export async function getBranchSha(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
): Promise<string | null> {
  try {
    const res = await client.rest<{ object: { sha: string } }>(
      "GET",
      `/repos/${repo.owner}/${repo.name}/git/ref/heads/${encodeURIComponent(branch)}`,
    )
    return res.body?.object.sha ?? null
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return null
    throw error
  }
}

/** A ref pointing at an existing commit. No commit is made, nothing to sign. */
export async function createBranch(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
  sha: string,
): Promise<void> {
  await client.rest("POST", `/repos/${repo.owner}/${repo.name}/git/refs`, {
    body: { ref: `refs/heads/${branch}`, sha },
  })
}

/** True when the branch existed and is now gone; false when there was nothing to delete. */
export async function deleteBranch(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
): Promise<boolean> {
  try {
    await client.rest(
      "DELETE",
      `/repos/${repo.owner}/${repo.name}/git/refs/heads/${encodeURIComponent(branch)}`,
    )
    return true
  } catch (error) {
    // 422 "Reference does not exist" is what GitHub answers for a branch it
    // already deleted on merge; 404 for one that never was.
    if (error instanceof GitHubHttpError && (error.status === 404 || error.status === 422)) {
      return false
    }
    throw error
  }
}
