import { type GitHubClient, GitHubHttpError } from "./client.ts"
import type { RepoRef } from "./pr.ts"

/**
 * Tags, releases, and the two writes the Release PR needs beyond pulls.ts:
 * a force-moved branch ref (the release head is reset to the base tip at
 * every merge) and a retitled PR. Every read here is the status
 * check before the matching write, so a replayed release cycle finds its tag
 * and its release and makes neither twice.
 */

export async function updateBranchRef(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
  sha: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  await client.rest(
    "PATCH",
    `/repos/${repo.owner}/${repo.name}/git/refs/heads/${encodeURIComponent(branch)}`,
    { body: { sha, force: opts.force ?? false } },
  )
}

export async function updatePullRequest(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  patch: { title?: string; body?: string; state?: "open" | "closed" },
): Promise<void> {
  await client.rest("PATCH", `/repos/${repo.owner}/${repo.name}/pulls/${number}`, { body: patch })
}

/** The commit a tag points at, or null when there is no such tag. */
export async function getTagSha(
  client: GitHubClient,
  repo: RepoRef,
  tag: string,
): Promise<string | null> {
  try {
    const res = await client.rest<{ object: { sha: string } }>(
      "GET",
      `/repos/${repo.owner}/${repo.name}/git/ref/tags/${encodeURIComponent(tag)}`,
    )
    return res.body?.object.sha ?? null
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return null
    throw error
  }
}

/** A lightweight tag on an existing commit. No object is created, nothing to sign. */
export async function createTag(
  client: GitHubClient,
  repo: RepoRef,
  tag: string,
  sha: string,
): Promise<void> {
  await client.rest("POST", `/repos/${repo.owner}/${repo.name}/git/refs`, {
    body: { ref: `refs/tags/${tag}`, sha },
  })
}

export interface ReleaseRef {
  id: number
  tag: string
  url: string
  prerelease: boolean
}

interface RawRelease {
  id: number
  tag_name: string
  html_url: string
  prerelease: boolean
}

function shapeRelease(raw: RawRelease): ReleaseRef {
  return { id: raw.id, tag: raw.tag_name, url: raw.html_url, prerelease: raw.prerelease }
}

export async function getReleaseByTag(
  client: GitHubClient,
  repo: RepoRef,
  tag: string,
): Promise<ReleaseRef | null> {
  try {
    const res = await client.rest<RawRelease>(
      "GET",
      `/repos/${repo.owner}/${repo.name}/releases/tags/${encodeURIComponent(tag)}`,
    )
    return res.body ? shapeRelease(res.body) : null
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return null
    throw error
  }
}

/**
 * A published release. Publishing is what triggers Deploy:
 * prerelease → preview, stable → production. Never a draft.
 */
export async function createRelease(
  client: GitHubClient,
  repo: RepoRef,
  input: { tag: string; name: string; body: string; prerelease: boolean; targetCommitish: string },
): Promise<ReleaseRef> {
  const res = await client.rest<RawRelease>("POST", `/repos/${repo.owner}/${repo.name}/releases`, {
    body: {
      tag_name: input.tag,
      target_commitish: input.targetCommitish,
      name: input.name,
      body: input.body,
      prerelease: input.prerelease,
      draft: false,
      make_latest: input.prerelease ? "false" : "true",
    },
  })
  if (!res.body) throw new Error(`create release ${input.tag}: empty response`)
  return shapeRelease(res.body)
}
