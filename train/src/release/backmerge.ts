import type { Repository } from "../types.ts"
import type { GitHubClient } from "../github/client.ts"
import { createBlob, createCommit, createTree, type TreeEntry } from "../github/git-data.ts"
import type { RepoRef } from "../github/pr.ts"
import {
  createBranch,
  createPullRequest,
  findOpenPullRequest,
  getBranchSha,
} from "../github/pulls.ts"
import { mergeChangelogs } from "./changelog.ts"
import {
  diffTrees,
  fetchOrigin,
  globToRegExp,
  isAncestor,
  mergeTree,
  readBlob,
  readTreeBytes,
  resolveRef,
} from "./history.ts"
import { CHANGELOG_PATH } from "./sync.ts"

/**
 * The backmerge of a stable release into dev, as a merge
 * git computes in the clone and the train turns into a signed two-parent
 * commit through the Git Data API.
 *
 * Two files conflict on almost every hotfix backmerge, and only those two
 * have a right answer the engine knows: the version files keep dev's
 * prerelease (dev is ahead of the hotfix by construction), and the changelog
 * is the union of both branches' sections. Anything else that conflicts is
 * a human's — the plan says so and the stage parks.
 */

export type BackmergePlan =
  | { kind: "clean" }
  | { kind: "conflict"; paths: string[] }
  | { kind: "resolved"; tree: string; resolved: string[]; entries: PlannedEntry[] }

/** A merge the engine commits itself, conflicts or not: the promotion's forward merge. */
export type MergePlan = Exclude<BackmergePlan, { kind: "clean" }>

export type PlannedEntry =
  | { path: string; mode: string; content: Buffer }
  | { path: string; mode: string; content: null }

export function backmergeHeadFor(version: string): string {
  return `backmerge/v${version}`
}

export function backmergeTitle(version: string): string {
  return `chore(release): backmerge v${version} into dev`
}

/**
 * Who merges the backmerge PR: the train itself, or a person after a hand
 * script opened it (the script does not merge).
 */
export type BackmergeMerger = "train" | "hand"

export function backmergeBody(
  version: string,
  mergeSha: string,
  resolution: { devSha: string; paths: string[] } | null,
  mergedBy: BackmergeMerger = "train",
): string {
  return [
    `Backmerge of v${version} (${mergeSha.slice(0, 7)}) into \`dev\`.`,
    "",
    mergedBy === "train"
      ? "The release train merges this pull request by merge commit as soon as it is green. A conflict in the version files or the changelog is resolved by the train; any other conflict is left for a person."
      : "Opened by the release script, which does not merge it. Merge it by merge commit, never squash, once `pipeline / Check` is green: a squashed backmerge leaves the release commit out of dev's history, and the next promotion has to merge main forward again. A conflict outside the version files and the changelog is resolved by hand on this branch.",
    ...(resolution
      ? [
          "",
          `The release train resolved the conflict with dev at ${resolution.devSha.slice(0, 7)} in ${resolution.paths.map((p) => `\`${p}\``).join(", ")}: dev keeps its version, the changelog takes both sides' sections.`,
        ]
      : []),
    "",
  ].join("\n")
}

function isVersionFile(repository: Repository, path: string): boolean {
  return repository.versionFiles.some((glob) => globToRegExp(glob).test(path))
}

/**
 * What merging `theirs` into `ours` (a commit each) takes, read from the clone.
 * A merge without conflicts is `clean`: GitHub can make it, the engine need not.
 */
export async function planBackmerge(
  repository: Repository,
  ours: string,
  theirs: string,
): Promise<BackmergePlan> {
  const plan = await planMerge(repository, ours, theirs)
  return plan.kind === "resolved" && plan.resolved.length === 0 ? { kind: "clean" } : plan
}

/**
 * The same merge for an engine that commits it either way — the promotion's
 * forward merge of main, whose head GitHub never merges
 * for us. Clean or resolved, the entries are what the merged tree changes.
 */
export async function planMerge(
  repository: Repository,
  ours: string,
  theirs: string,
): Promise<MergePlan> {
  const clone = repository.path
  const merged = await mergeTree(clone, ours, theirs)

  const resolutions = new Map<string, Buffer>()
  const unresolved: string[] = []
  for (const path of merged.conflicts) {
    const mine = await readTreeBytes(clone, ours, path)
    const yours = await readTreeBytes(clone, theirs, path)
    if (mine === null || yours === null) {
      unresolved.push(path)
    } else if (isVersionFile(repository, path)) {
      resolutions.set(path, mine)
    } else if (path === CHANGELOG_PATH) {
      resolutions.set(
        path,
        Buffer.from(mergeChangelogs(mine.toString("utf8"), yours.toString("utf8"))),
      )
    } else {
      unresolved.push(path)
    }
  }
  if (unresolved.length > 0) return { kind: "conflict", paths: unresolved }

  const entries: PlannedEntry[] = []
  for (const change of await diffTrees(clone, ours, merged.tree)) {
    if (change.mode === "160000") return { kind: "conflict", paths: [change.path] }
    if (change.sha === null || change.mode === null) {
      entries.push({ path: change.path, mode: "100644", content: null })
      continue
    }
    const content = resolutions.get(change.path) ?? (await readBlob(clone, change.sha))
    entries.push({ path: change.path, mode: change.mode, content })
  }
  return { kind: "resolved", tree: merged.tree, resolved: [...resolutions.keys()], entries }
}

export interface MergeCommitInput {
  clone: string
  ours: string
  theirs: string
  plan: Extract<BackmergePlan, { kind: "resolved" }>
  message: string
}

/**
 * Who makes the merge commit, signed, and puts it on GitHub. `branch` is a
 * scratch branch a committer may push it to; the caller owns that branch and
 * deletes it. The train's committer is the Git Data API
 * ({@link createMergeCommit}), which GitHub signs on an App or Actions token.
 */
export type MergeCommitter = (input: MergeCommitInput & { branch: string }) => Promise<string>

/**
 * The merge commit itself: dev's tree plus the planned entries, parents dev
 * and the release. Every blob is uploaded — a three-way merged file exists
 * nowhere on GitHub yet.
 */
export async function createMergeCommit(
  client: GitHubClient,
  repo: RepoRef,
  input: MergeCommitInput,
): Promise<string> {
  const baseTree = await resolveRef(input.clone, `${input.ours}^{tree}`, "tree")
  if (!baseTree) throw new Error(`backmerge: ${input.ours} has no tree`)
  const entries: TreeEntry[] = []
  for (const entry of input.plan.entries) {
    entries.push({
      path: entry.path,
      mode: entry.mode,
      sha: entry.content === null ? null : await createBlob(client, repo, entry.content),
    })
  }
  // A merge that changes no file of ours keeps ours' tree: GitHub answers an
  // empty tree list with 422 "Invalid tree info" (a hotfix that aligned
  // main's files with dev's makes every later promotion such a merge).
  const tree = entries.length === 0 ? baseTree : await createTree(client, repo, baseTree, entries)
  return createCommit(client, repo, {
    message: input.message,
    tree,
    parents: [input.ours, input.theirs],
  })
}

/** What {@link openBackmerge} built the head with, when this call built it. */
export interface BackmergeBuild {
  /** dev's tip the release was merged into. */
  devSha: string
  /** The head's commit: the merge, or the release itself when only a person can merge it. */
  sha: string
  /** What the train resolved: the version files and the changelog. */
  resolved: string[]
  /** What only a person can resolve; the head is then the release, and GitHub reports the conflict. */
  conflicts: string[]
}

export type OpenedBackmerge =
  | { kind: "no_dev" }
  | { kind: "in_dev"; devSha: string }
  | {
      kind: "pr"
      devSha: string
      head: string
      prNumber: number
      prUrl: string
      /** null: the head was there already, from an earlier look. */
      built: BackmergeBuild | null
    }

export interface OpenBackmergeInput {
  client: GitHubClient
  repository: Repository
  version: string
  /** The release commit on main. */
  mergeSha: string
  /**
   * Who makes the head's merge commit. Defaults to the Git Data API, which
   * GitHub signs on an App or Actions token only; a caller on a user's token
   * passes a committer of its own, which may push the head itself.
   */
  commitMerge?: MergeCommitter
  mergedBy?: BackmergeMerger
}

/**
 * The backmerge's head and its PR into dev, each exactly once. Nothing here
 * merges: the caller decides that on the PR's state, or leaves it to a
 * person. A dev that already contains the release needs neither.
 *
 * The head is a merge commit of its own, never the release commit: check
 * runs belong to the commit, so a head at main's tip carries main's push run
 * beside the PR's, both required, and a red one blocks the backmerge however
 * green the PR's is. A conflict only a person
 * can resolve leaves the head at the release; GitHub reports it on the PR.
 */
export async function openBackmerge(input: OpenBackmergeInput): Promise<OpenedBackmerge> {
  const { client, repository, version, mergeSha } = input
  const repo: RepoRef = { owner: repository.owner, name: repository.name }
  const clone = repository.path
  await fetchOrigin(clone)
  const devSha = await resolveRef(clone, "origin/dev")
  if (!devSha) return { kind: "no_dev" }
  if (await isAncestor(clone, mergeSha, "origin/dev")) return { kind: "in_dev", devSha }

  const head = backmergeHeadFor(version)
  const title = backmergeTitle(version)
  let built: BackmergeBuild | null = null
  if ((await getBranchSha(client, repo, head)) === null) {
    const plan = await planMerge(repository, devSha, mergeSha)
    built = { devSha, sha: mergeSha, resolved: [], conflicts: [] }
    if (plan.kind === "conflict") {
      built.conflicts = plan.paths
    } else {
      const commitMerge: MergeCommitter =
        input.commitMerge ?? ((merge) => createMergeCommit(client, repo, merge))
      built.resolved = plan.resolved
      built.sha = await commitMerge({
        branch: head,
        clone,
        ours: devSha,
        theirs: mergeSha,
        plan,
        message:
          plan.resolved.length > 0
            ? `${title}\n\nResolved by the release train: ${plan.resolved.join(", ")}.`
            : title,
      })
    }
    // A committer that pushes put the head there itself; the Git Data API only made the commit.
    const pushed =
      input.commitMerge !== undefined && (await getBranchSha(client, repo, head)) === built.sha
    if (!pushed) await createBranch(client, repo, head, built.sha)
  }
  const resolution = built && built.resolved.length > 0 ? { devSha, paths: built.resolved } : null
  const pr =
    (await findOpenPullRequest(client, repo, head)) ??
    (await createPullRequest(client, repo, {
      head,
      base: "dev",
      title,
      body: backmergeBody(version, mergeSha, resolution, input.mergedBy),
    }))
  return { kind: "pr", devSha, head, prNumber: pr.number, prUrl: pr.url, built }
}
