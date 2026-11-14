import { type GitHubClient, GitHubHttpError } from "./client.ts"
import { updateBranch } from "./merge.ts"
import type { RepoRef } from "./pr.ts"

/**
 * The one way a BEHIND head is brought forward (F09a/b/c): `await_check`,
 * `merge`, the backmerge and the migration script all ask GitHub to update
 * the branch, and they all need the same three answers. Once per head — the
 * memo remembers the head it asked for, so the next look at a head GitHub is
 * still moving waits instead of asking again. Bounded — every update makes a
 * new head that is BEHIND again on a busy base, so the rounds are counted in
 * the same memo and the helper gives up after MAX_UPDATE_BRANCH_ROUNDS; the
 * caller parks with the reason. And one error policy — 422 (the update would
 * conflict, or the head moved) and 409 (GitHub is already updating it) are a
 * refusal the caller decides about; anything else is thrown, so the poller
 * retries the stage instead of parking on a network blip.
 */
export const MAX_UPDATE_BRANCH_ROUNDS = 3

/** What a stage keeps in its output between looks; older outputs may hold anything. */
export interface UpdateBehindMemo {
  updatedBranchFor?: unknown
  updateBranchRounds?: unknown
}

export interface UpdateBehindRecord {
  updatedBranchFor: string
  updateBranchRounds: number
}

export type UpdateBehindOutcome =
  | { kind: "updated"; memo: UpdateBehindRecord }
  | { kind: "already"; memo: UpdateBehindMemo }
  | { kind: "exhausted"; reason: string; memo: UpdateBehindMemo }
  | { kind: "refused"; reason: string; memo: UpdateBehindRecord }

export interface UpdateBehindInput {
  client: GitHubClient
  repo: RepoRef
  pr: { number: number; headSha: string }
  memo: UpdateBehindMemo
}

export function updateBranchRounds(memo: UpdateBehindMemo): number {
  const n = memo.updateBranchRounds
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * The well-typed part of a memo, for a stage to carry through the outputs of
 * its other waits: the engine replaces a stage's output on every look, so a
 * "checks pending" between two updates would otherwise forget the rounds
 * and lift the cap.
 */
export function carryUpdateBehindMemo(memo: UpdateBehindMemo): Partial<UpdateBehindRecord> {
  const rounds = updateBranchRounds(memo)
  return {
    ...(typeof memo.updatedBranchFor === "string"
      ? { updatedBranchFor: memo.updatedBranchFor }
      : {}),
    ...(rounds > 0 ? { updateBranchRounds: rounds } : {}),
  }
}

export async function updateBehindOnce(input: UpdateBehindInput): Promise<UpdateBehindOutcome> {
  const { client, repo, pr, memo } = input
  if (memo.updatedBranchFor === pr.headSha) return { kind: "already", memo }
  const rounds = updateBranchRounds(memo)
  if (rounds >= MAX_UPDATE_BRANCH_ROUNDS) {
    return {
      kind: "exhausted",
      reason: `the head was updated ${rounds} times and is behind again; the base keeps moving`,
      memo,
    }
  }
  const record: UpdateBehindRecord = {
    updatedBranchFor: pr.headSha,
    updateBranchRounds: rounds + 1,
  }
  try {
    await updateBranch(client, repo, pr.number, pr.headSha)
  } catch (error) {
    if (error instanceof GitHubHttpError && (error.status === 422 || error.status === 409)) {
      return {
        kind: "refused",
        reason: `GitHub refused the update: ${error.message}`,
        memo: record,
      }
    }
    throw error
  }
  return { kind: "updated", memo: record }
}
