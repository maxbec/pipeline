import type { RepositoryKind } from "../types.ts"
import { type GitHubClient, GitHubHttpError } from "./client.ts"
import type { RepoRef } from "./pr.ts"

/**
 * Merge control and signed commits.
 *
 * A squash merge through the API is committed by GitHub itself and verifies
 * as signed (measured on maxbec/pipeline#74); a rebase merge is not, so there
 * is no rebase here. Scripted commits go through `createCommitOnBranch`,
 * which GitHub signs regardless of token. The contents API `PUT` produces
 * unsigned commits under a user token and has no code path in this module.
 */

export interface SquashMergeInput {
  /** The head the decision was made on; GitHub answers 409 if it moved. */
  expectedHeadSha: string
  title: string
  body: string
}

/**
 * Squash for feature work into a base, merge commit for a promotion into
 * `main` and a backmerge into `dev` (Phase 6). Both are committed by GitHub
 * and verify as signed. Rebase is not an option here.
 */
export type MergeMethod = "squash" | "merge"

/**
 * The method a PR merges by, read off its branches the way the release engine
 * chooses it. A promotion (`dev` or `promote/*` into `main`) and a backmerge
 * (`backmerge/v*`) carry one branch's history into the other and merge by
 * merge commit. A squashed promotion leaves `dev` without `main`'s history, so
 * every later backmerge drags all of it along again.
 *
 * `main` of a major repository takes merge commits only, a hotfix and its
 * Release PR included; a ruleset may refuse a squash there.
 * Everything else squashes: feature work into `dev`, a Release PR on `dev`,
 * and anything into the only branch of a small repository.
 */
export function mergeMethodFor(
  pr: { baseRefName: string; headRefName: string },
  kind: RepositoryKind,
): MergeMethod {
  if (pr.headRefName.startsWith("backmerge/")) return "merge"
  if (pr.baseRefName !== "main") return "squash"
  if (kind === "major") return "merge"
  return pr.headRefName === "dev" || pr.headRefName.startsWith("promote/") ? "merge" : "squash"
}

/**
 * A repository's kind as GitHub has it: major when `origin` has a `dev`
 * branch, the rule `discoverRepositories` applies to a clone.
 */
export async function repositoryKindOf(
  client: GitHubClient,
  repo: RepoRef,
): Promise<RepositoryKind> {
  try {
    await client.rest("GET", `/repos/${repo.owner}/${repo.name}/branches/dev`)
    return "major"
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return "small"
    throw error
  }
}

export async function mergePullRequest(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  input: SquashMergeInput & { method: MergeMethod },
): Promise<{ sha: string; merged: boolean }> {
  const res = await client.rest<{ sha: string; merged: boolean }>(
    "PUT",
    `/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`,
    {
      body: {
        merge_method: input.method,
        sha: input.expectedHeadSha,
        commit_title: input.title,
        commit_message: input.body,
      },
    },
  )
  if (!res.body?.merged) throw new Error(`merge of #${number} did not report merged`)
  return { sha: res.body.sha, merged: true }
}

export async function squashMerge(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  input: SquashMergeInput,
): Promise<{ sha: string; merged: boolean }> {
  return mergePullRequest(client, repo, number, { ...input, method: "squash" })
}

/** `PUT .../update-branch`; GitHub answers 202 and does the merge asynchronously. */
export async function updateBranch(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  expectedHeadSha: string,
): Promise<void> {
  await client.rest("PUT", `/repos/${repo.owner}/${repo.name}/pulls/${number}/update-branch`, {
    body: { expected_head_sha: expectedHeadSha },
  })
}

const REPLY_MUTATION = /* GraphQL */ `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`

const RESOLVE_MUTATION = /* GraphQL */ `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`

/**
 * After fixing a review comment: reply in-thread with what was done, then
 * resolve. Both, always — a resolved thread with no reply tells the reviewer
 * nothing, an unresolved one blocks the merge.
 */
export async function resolveReviewThread(
  client: GitHubClient,
  threadId: string,
  reply?: string,
): Promise<void> {
  if (reply) await client.graphql(REPLY_MUTATION, { threadId, body: reply })
  await client.graphql(RESOLVE_MUTATION, { threadId })
}

const CREATE_COMMIT_MUTATION = /* GraphQL */ `
mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url }
  }
}`

export interface SignedCommitInput {
  repo: RepoRef
  branch: string
  /** The branch tip the change was computed against; the mutation fails if it moved. */
  expectedHeadOid: string
  message: { headline: string; body?: string }
  additions?: { path: string; contents: string | Uint8Array }[]
  deletions?: { path: string }[]
}

/** A commit GitHub signs: committer `noreply@github.com`, `verified=true`. */
export async function createSignedCommit(
  client: GitHubClient,
  input: SignedCommitInput,
): Promise<{ oid: string; url: string }> {
  const data = await client.graphql<{
    createCommitOnBranch: { commit: { oid: string; url: string } }
  }>(CREATE_COMMIT_MUTATION, {
    input: {
      branch: {
        repositoryNameWithOwner: `${input.repo.owner}/${input.repo.name}`,
        branchName: input.branch,
      },
      expectedHeadOid: input.expectedHeadOid,
      message: { headline: input.message.headline, body: input.message.body ?? "" },
      fileChanges: {
        additions: (input.additions ?? []).map((a) => ({
          path: a.path,
          contents: Buffer.from(a.contents).toString("base64"),
        })),
        deletions: input.deletions ?? [],
      },
    },
  })
  return data.createCommitOnBranch.commit
}

/** `verification.verified` on the commit — what `required_signatures` actually checks. */
export async function verifyCommitSigned(
  client: GitHubClient,
  repo: RepoRef,
  sha: string,
): Promise<{ verified: boolean; reason: string }> {
  // The REST commit object nests it: `commit.verification`, not top-level.
  const res = await client.rest<{
    commit?: { verification?: { verified: boolean; reason: string } }
  }>("GET", `/repos/${repo.owner}/${repo.name}/commits/${sha}`)
  const v = res.body?.commit?.verification
  return { verified: Boolean(v?.verified), reason: v?.reason ?? "unknown" }
}
