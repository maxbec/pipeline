import type { GitHubClient } from "./client.ts"
import type { RepoRef } from "./pr.ts"

/**
 * The Git Data API, for the one thing `createCommitOnBranch` cannot do: a
 * commit with two parents. Made with the App's installation token, GitHub
 * signs these commits like the mutation's — the token, not the
 * endpoint, is what decides.
 */

export async function createBlob(
  client: GitHubClient,
  repo: RepoRef,
  content: Uint8Array,
): Promise<string> {
  const res = await client.rest<{ sha: string }>(
    "POST",
    `/repos/${repo.owner}/${repo.name}/git/blobs`,
    { body: { content: Buffer.from(content).toString("base64"), encoding: "base64" } },
  )
  if (!res.body?.sha) throw new Error("createBlob: no sha in the answer")
  return res.body.sha
}

export interface TreeEntry {
  path: string
  /** `100644`, `100755` or `120000`; ignored when `sha` is null. */
  mode: string
  /** null removes the path from the base tree. */
  sha: string | null
}

/** A tree that is `baseTree` with `entries` applied. */
export async function createTree(
  client: GitHubClient,
  repo: RepoRef,
  baseTree: string,
  entries: TreeEntry[],
): Promise<string> {
  const res = await client.rest<{ sha: string }>(
    "POST",
    `/repos/${repo.owner}/${repo.name}/git/trees`,
    {
      body: {
        base_tree: baseTree,
        tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })),
      },
    },
  )
  if (!res.body?.sha) throw new Error("createTree: no sha in the answer")
  return res.body.sha
}

export async function createCommit(
  client: GitHubClient,
  repo: RepoRef,
  input: { message: string; tree: string; parents: string[] },
): Promise<string> {
  const res = await client.rest<{ sha: string }>(
    "POST",
    `/repos/${repo.owner}/${repo.name}/git/commits`,
    { body: { message: input.message, tree: input.tree, parents: input.parents } },
  )
  if (!res.body?.sha) throw new Error("createCommit: no sha in the answer")
  return res.body.sha
}
