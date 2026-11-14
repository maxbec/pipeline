/**
 * What to do about a failed Pipeline run: nothing, rerun it, let Claude Code
 * propose a patch, or give up and ask for a person.
 *
 * The rules are checked in order and the first that does not hold ends it.
 * Everything is read from GitHub at decision time; the event that started the
 * job only names the run.
 */
import type { GitHubClient } from "../github/client.ts"
import type { RepoRef } from "../github/pr.ts"
import { getRun, listComments, listRunJobs, openPullsForBranch } from "./api.ts"

export interface RunRef {
  id: number
}

export type Triage =
  | { action: "none"; reason: string }
  | { action: "rerun" }
  | {
      action: "propose"
      pr: number
      headSha: string
      attempt: number
      /** The failed Check job, whose log the proposal reads. */
      jobId: number
      branch: string
      title: string
    }
  | { action: "give_up"; pr: number; reason: string }

/** The job a fix is for. A failed Guard — a wrong title or target — is not something to patch. */
export const CHECK_JOB = "pipeline / Check"
export const MAX_ATTEMPTS = 3
export const NEEDS_HUMAN = "needs-human"
export const HOLD = "hold"
export const GAVE_UP_MARKER = "<!-- train-fix gave-up -->"

/** Heads the train builds or a person owns; none of them is patched. */
const NEVER = ["release/", "promote/", "backmerge/", "hotfix/"]
const DEPENDABOT = "dependabot[bot]"

export function attemptMarker(attempt: number): string {
  return `<!-- train-fix attempt=${attempt} -->`
}

const MARKER = /<!-- train-fix attempt=\d+ -->/

/** Whether a comment is one the train (a Bot account) left with `marker`. */
export function isBotComment(
  comment: { body: string | null; user: { type?: string } | null },
  marker: RegExp | string,
): boolean {
  if (comment.user?.type !== "Bot" || !comment.body) return false
  return typeof marker === "string" ? comment.body.includes(marker) : marker.test(comment.body)
}

const none = (reason: string): Triage => ({ action: "none", reason })

export async function triageFailure(client: GitHubClient, repo: RepoRef, ref: RunRef): Promise<Triage> {
  const run = await getRun(client, repo, ref.id)
  if (run.event !== "pull_request") return none(`the run's event is ${run.event}, not pull_request`)
  if (run.conclusion !== "failure") return none(`the run concluded ${run.conclusion ?? "nothing"}, not failure`)

  const here = `${repo.owner}/${repo.name}`.toLowerCase()
  if (run.head_repository?.full_name.toLowerCase() !== here) {
    return none("the head is in another repository (a fork)")
  }
  const branch = run.head_branch ?? ""
  if (!branch) return none("the run names no head branch")
  if (NEVER.some((prefix) => branch.startsWith(prefix))) return none(`${branch} is never patched`)

  const pulls = await openPullsForBranch(client, repo, branch)
  const [pull, ...more] = pulls
  if (!pull || more.length > 0) return none(`${pulls.length} open pull requests have the head ${branch}`)
  if (pull.head.repo && pull.head.repo.full_name.toLowerCase() !== here) {
    return none("the pull request's head is in another repository (a fork)")
  }
  if (pull.head.sha !== run.head_sha) return none("the head moved since the run")
  if (pull.user?.login === DEPENDABOT) return none("Dependabot's pull requests are not patched")
  if (pull.draft) return none("the pull request is a draft")
  const labels = (pull.labels ?? []).map((l) => l.name)
  for (const label of [HOLD, NEEDS_HUMAN]) {
    if (labels.includes(label)) return none(`the pull request carries the label ${label}`)
  }

  const jobs = await listRunJobs(client, repo, ref.id)
  const check = jobs.find((j) => j.name === CHECK_JOB && j.conclusion === "failure")
  if (!check) return none(`the failed job is not ${CHECK_JOB}`)

  if ((run.run_attempt ?? 1) <= 1) return { action: "rerun" }

  const comments = await listComments(client, repo, pull.number)
  const attempts = comments.filter((c) => isBotComment(c, MARKER)).length
  if (attempts >= MAX_ATTEMPTS) {
    return {
      action: "give_up",
      pr: pull.number,
      reason: `${CHECK_JOB} is still failing after ${MAX_ATTEMPTS} fix attempts`,
    }
  }
  return {
    action: "propose",
    pr: pull.number,
    headSha: pull.head.sha,
    attempt: attempts + 1,
    jobId: check.id,
    branch,
    title: pull.title,
  }
}
