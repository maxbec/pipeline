import { bumpKindOf, DEPENDABOT_LOGIN } from "./github/dependabot.ts"
import type { PrCommit } from "./github/pr.ts"
import type { RepositoryKind } from "./types.ts"

/**
 * Which pull requests the Merge job may look at at all. A pure decision, no
 * I/O: the entry reads the pull request, this says whether `canMerge` is even
 * asked. `canMerge` answers "is it green"; this answers "is it the train's to
 * merge", and everything it does not return `consider` for is never merged
 * by the train, however green.
 */

export interface PolicyInput {
  isDraft: boolean
  labels: readonly string[]
  headRefName: string
  baseRefName: string
  /** `owner/name` of the head's repository; null when it is gone (a deleted fork). */
  headRepository: string | null
  /** `owner/name` of the repository the pull request is in. */
  baseRepository: string
  /** As REST spells it: a Bot carries `[bot]`. */
  authorLogin: string | null
  title: string
  /** The commits, for Dependabot's `update-type` lines. */
  commits: readonly PrCommit[]
  /** Every path the pull request changes, a rename's old path included. */
  changedFiles: readonly string[]
}

export type PolicyDecision =
  | { action: "consider" }
  | { action: "skip"; reason: string }
  | { action: "needs_human"; reason: string }

/** A person's "not yet": the train leaves a pull request with this label alone. */
export const HOLD_LABEL = "hold"

/** The pipeline's own files: the caller, any other workflow, and the config Guard reads. */
const WORKFLOWS = ".github/workflows/"
const PIPELINE_CONFIG = ".github/pipeline.yaml"

function judgesItself(path: string): boolean {
  return path.startsWith(WORKFLOWS) || path === PIPELINE_CONFIG
}

export function mergePolicy(pr: PolicyInput, kind: RepositoryKind): PolicyDecision {
  const skip = (reason: string): PolicyDecision => ({ action: "skip", reason })
  const { headRefName: head, baseRefName: base } = pr

  // A person's decision first: nothing below may speak for a held pull request.
  if (pr.labels.includes(HOLD_LABEL)) return skip(`carries the \`${HOLD_LABEL}\` label`)
  if (pr.isDraft) return skip("is a draft")
  // A fork's head runs the fork's code, and Guard keeps forks out of `main` anyway.
  if (pr.headRepository === null) return skip("its head repository is gone")
  if (pr.headRepository.toLowerCase() !== pr.baseRepository.toLowerCase()) {
    return skip(`its head is in ${pr.headRepository}, a fork`)
  }
  // A release is a person's merge, in every shape it comes in.
  if (head.startsWith("release/")) return skip("is a Release PR: merging it is the release")
  if (head.startsWith("promote/")) return skip("is a promotion")
  if (head === "dev" && base === "main") return skip("is a promotion of dev into main")
  if (head.startsWith("hotfix/")) return skip("is a hotfix")
  if (kind === "major") {
    if (base === "main") return skip("targets main of a repository that has dev")
    if (base !== "dev") return skip(`targets ${base}, not dev`)
  } else if (base !== "main") {
    return skip(`targets ${base}, not main`)
  }
  if (pr.authorLogin === DEPENDABOT_LOGIN) {
    const bump = bumpKindOf({ title: pr.title, commits: [...pr.commits] })
    if (bump === "major") return skip("is a Dependabot major bump")
    if (bump === "unknown") return skip("is a Dependabot bump that cannot be classified")
  }
  // Last: only a pull request the train would otherwise merge is handed to a person.
  const own = pr.changedFiles.filter(judgesItself)
  if (own.length > 0) {
    return {
      action: "needs_human",
      reason: `changes ${own.join(", ")}: it could rewrite the check it is judged by`,
    }
  }
  return { action: "consider" }
}
