import {
  countBy,
  type EntryIo,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  markdownTable,
  messageOf,
  QUIET_FAILURE,
  QUIET_USAGE,
  readEntry,
  UsageError,
  writeSummary,
} from "./entry.ts"
import { listComments, listRunJobs, postComment } from "./fix/api.ts"
import { CHECK_JOB, isBotComment } from "./fix/triage.ts"
import { type GitHubClient, GitHubHttpError } from "./github/client.ts"
import type { RepoRef } from "./github/pr.ts"
import { getBranchSha } from "./github/pulls.ts"

/**
 * The Verify job: start the full Check a Release PR is waiting for.
 *
 * In a repository with two Check depths a Release PR runs no Check of its
 * own. It is green once the tip of its base has passed the full Check and
 * fails at once, "Not fully verified", until then — and the full Check runs
 * on a dispatch or at night, never after a merge. Somebody had to start it.
 * This is that somebody: for every Release PR that failed that way it starts
 * the Pipeline on the base branch, which is a full Check; when that is green
 * the pipeline's own Recheck job re-runs the Release PR.
 *
 * It only ever starts a run. What the Release PR needs to be green, and what
 * a release needs to be tagged, is decided where it was before.
 *
 * Like the other entries it looks at the whole repository; the event that
 * started the run is only a poke. One commit is verified once: a full Check
 * that is queued, running or finished for the tip is the answer, whoever
 * started it.
 */

/** The workflow every caller is named, and the one the Train callers wait for. */
export const PIPELINE_WORKFLOW = "Pipeline"
/** The step of the Check job that fails a Release PR over an unverified base (universal-pipeline.yaml). */
export const UNVERIFIED_STEP = "Not fully verified"
/** A Check on a branch is the full one when one of these started the run. */
export const FULL_EVENTS = ["workflow_dispatch", "schedule"]
/**
 * Full Checks of one commit that may end without a verdict — cancelled, timed
 * out, never started — before Verify stops starting another. A runner outage
 * must not turn into a run per poke.
 */
export const MAX_LOST_RUNS = 2
/** What a 403 on the dispatch means in practice, and the two ways out. */
export const NEEDS_ACTIONS_WRITE =
  "The train's App needs the repository permission Actions: read and write to start a run; grant it, or set the variable TRAIN_VERIFY to off here."

export const VERIFY_ACTIONS = [
  "started",
  "running",
  "verified",
  "failed",
  "gave_up",
  "refused",
  "skipped",
] as const
export type VerifyAction = (typeof VERIFY_ACTIONS)[number]

export interface VerifyRow {
  /** The Release PR. */
  number: number
  base: string
  action: VerifyAction
  reason: string
  /** Full Checks of older commits that this run cancelled; absent when there were none. */
  cancelled?: number[]
}

export interface VerifyRunInput {
  client: GitHubClient
  repo: RepoRef
  /** Decide and report, write nothing: no run started, none cancelled, no comment. */
  dryRun: boolean
  /**
   * The train's GitHub App, without `[bot]`. Verify cancels only the runs this
   * account started; without it nothing is cancelled.
   */
  appSlug?: string
}

export interface VerifyRunResult {
  rows: VerifyRow[]
  /** GitHub refused to start a run, or an unexpected error: the run is exit 1. */
  failed: boolean
  error?: unknown
}

/** Marks the one comment about a red full Check of `sha`, so it is never repeated. */
export function failedMarker(sha: string): string {
  return `<!-- train-verify failed=${sha} -->`
}

interface ReleasePull {
  number: number
  head: { ref: string; sha: string; repo?: { full_name: string } | null }
  base: { ref: string }
}

interface PipelineRun {
  id: number
  name: string | null
  workflow_id: number
  event: string
  status: string | null
  conclusion: string | null
  head_sha: string
  head_branch: string | null
  html_url?: string
  triggering_actor?: { login: string } | null
}

const PER_PAGE = 100
/** Open pull requests are read this far; a Release PR is among the newest of them or not open. */
const MAX_PULL_PAGES = 10

const api = (repo: RepoRef) => `/repos/${repo.owner}/${repo.name}`
const short = (sha: string) => sha.slice(0, 7)

/**
 * The open Release PRs: head `release/<base>` in this repository. A fork's
 * branch of that name is not one, and neither is a `release/x` into another
 * base — the train names the head after the base it releases.
 */
async function openReleasePulls(client: GitHubClient, repo: RepoRef): Promise<ReleasePull[]> {
  const here = `${repo.owner}/${repo.name}`.toLowerCase()
  const found: ReleasePull[] = []
  for (let page = 1; page <= MAX_PULL_PAGES; page++) {
    const res = await client.rest<ReleasePull[]>(
      "GET",
      `${api(repo)}/pulls?state=open&per_page=${PER_PAGE}&page=${page}`,
    )
    const pulls = res.body ?? []
    for (const pull of pulls) {
      if (pull.head.ref !== `release/${pull.base.ref}`) continue
      if (pull.head.repo?.full_name.toLowerCase() !== here) continue
      found.push(pull)
    }
    if (pulls.length < PER_PAGE) break
  }
  return found.sort((a, b) => a.number - b.number)
}

/** The newest Pipeline run a pull request event started on `sha`, the Release PR's head. */
async function pullRequestRunOn(
  client: GitHubClient,
  repo: RepoRef,
  sha: string,
): Promise<PipelineRun | undefined> {
  const res = await client.rest<{ workflow_runs?: PipelineRun[] }>(
    "GET",
    `${api(repo)}/actions/runs?head_sha=${sha}&event=pull_request&per_page=${PER_PAGE}`,
  )
  return (res.body?.workflow_runs ?? [])
    .filter((run) => run.name === PIPELINE_WORKFLOW)
    .sort((a, b) => b.id - a.id)[0]
}

/**
 * The full Checks of `sha` on `base`, newest first: the runs of that one
 * workflow which a dispatch or the schedule started. Asked of the workflow,
 * not of the repository: every finished Pipeline run starts a Train run on the
 * default branch's tip, and a tip that stands for a day collects more of those
 * than one page holds.
 */
async function fullChecksOf(
  client: GitHubClient,
  repo: RepoRef,
  workflowId: number,
  base: string,
  sha: string,
): Promise<PipelineRun[]> {
  const res = await client.rest<{ workflow_runs?: PipelineRun[] }>(
    "GET",
    `${api(repo)}/actions/workflows/${workflowId}/runs?head_sha=${sha}&branch=${encodeURIComponent(base)}&per_page=${PER_PAGE}`,
  )
  return (res.body?.workflow_runs ?? [])
    .filter((run) => run.head_sha === sha && run.head_branch === base && FULL_EVENTS.includes(run.event))
    .sort((a, b) => b.id - a.id)
}

/**
 * The full Checks this App started on `base` that are still under way for a
 * commit the branch has left behind. They can no longer turn the Release PR
 * green, and the caller queues a dispatch behind the one before it
 * (`concurrency`, one group per event and ref), so the tip would wait for a
 * run nobody needs. A run a person started is theirs and is left alone.
 */
async function overtakenRuns(
  client: GitHubClient,
  repo: RepoRef,
  workflowId: number,
  base: string,
  tip: string,
  bot: string,
): Promise<number[]> {
  const res = await client.rest<{ workflow_runs?: PipelineRun[] }>(
    "GET",
    `${api(repo)}/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(base)}&event=workflow_dispatch&per_page=${PER_PAGE}`,
  )
  return (res.body?.workflow_runs ?? [])
    .filter(
      (run) =>
        run.status !== "completed" &&
        run.head_sha !== tip &&
        run.triggering_actor?.login.toLowerCase() === bot,
    )
    .map((run) => run.id)
}

/** A run that finished in the meantime answers 409; it needs no cancelling. */
async function cancelRun(client: GitHubClient, repo: RepoRef, id: number): Promise<void> {
  try {
    await client.rest("POST", `${api(repo)}/actions/runs/${id}/cancel`)
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 409) return
    throw error
  }
}

/**
 * Says once, on the Release PR, that the full Check of `sha` failed: from here
 * on the Release PR's own message ("run the full Check") points the wrong way.
 */
async function reportFailedCheck(
  client: GitHubClient,
  repo: RepoRef,
  pull: ReleasePull,
  sha: string,
  run: PipelineRun,
): Promise<string> {
  const jobs = await listRunJobs(client, repo, run.id)
  const step = jobs
    .find((job) => job.name === CHECK_JOB && job.conclusion === "failure")
    ?.steps?.find((s) => s.conclusion === "failure")?.name
  const where = step ? ` in ${step}` : ""
  const marker = failedMarker(sha)
  const comments = await listComments(client, repo, pull.number)
  if (!comments.some((comment) => isBotComment(comment, marker))) {
    const link = run.html_url ? `[run ${run.id}](${run.html_url})` : `run ${run.id}`
    await postComment(
      client,
      repo,
      pull.number,
      [
        `The full Check of \`${pull.base.ref}\` at \`${short(sha)}\` failed${where} (${link}).`,
        "",
        `That is a defect on \`${pull.base.ref}\`, not a missing run: it needs a fix through a pull request. ` +
          "Once that fix is merged, the full Check of the new tip starts by itself.",
        "",
        "If the failure was a flake, re-run the failed job of that run: a green re-run turns this pull request green as well.",
        "",
        marker,
      ].join("\n"),
    )
  }
  return where
}

async function verifyPull(input: VerifyRunInput, pull: ReleasePull): Promise<VerifyRow> {
  const { client, repo, dryRun } = input
  const base = pull.base.ref
  const row = (action: VerifyAction, reason: string, cancelled: number[] = []): VerifyRow => ({
    number: pull.number,
    base,
    action,
    reason,
    ...(cancelled.length > 0 ? { cancelled } : {}),
  })

  // Is this Release PR red because its base is unverified? Guard answered
  // that on the Release PR's own run; its answer is read, not derived again.
  const own = await pullRequestRunOn(client, repo, pull.head.sha)
  if (!own) return row("skipped", `no ${PIPELINE_WORKFLOW} run on its head ${short(pull.head.sha)} yet`)
  if (own.status !== "completed") return row("skipped", `its ${PIPELINE_WORKFLOW} run is not finished`)
  if (own.conclusion !== "failure") {
    return row("skipped", `its ${PIPELINE_WORKFLOW} run concluded ${own.conclusion ?? "nothing"}`)
  }
  const check = (await listRunJobs(client, repo, own.id)).find(
    (job) => job.name === CHECK_JOB && job.conclusion === "failure",
  )
  const failedStep = check?.steps?.find((s) => s.conclusion === "failure")?.name
  if (failedStep !== UNVERIFIED_STEP) {
    return row(
      "skipped",
      check
        ? `${CHECK_JOB} failed in ${failedStep ?? "no step it names"}, not as "${UNVERIFIED_STEP}"`
        : `its failed job is not ${CHECK_JOB}`,
    )
  }

  // A dispatch always runs the branch's tip, so the tip is what is asked
  // about — also when the Release PR still sits on the commit before it: the
  // Release PR the train builds next needs this very run.
  const tip = await getBranchSha(client, repo, base)
  if (!tip) return row("skipped", `the branch ${base} does not exist`)

  const bot = input.appSlug ? `${input.appSlug}[bot]`.toLowerCase() : ""
  const cancelled = bot ? await overtakenRuns(client, repo, own.workflow_id, base, tip, bot) : []
  if (!dryRun) for (const id of cancelled) await cancelRun(client, repo, id)

  const full = await fullChecksOf(client, repo, own.workflow_id, base, tip)
  const at = `${base} at ${short(tip)}`
  if (full.some((run) => run.status !== "completed")) {
    return row("running", `the full Check of ${at} is queued or running`, cancelled)
  }
  if (full.some((run) => run.conclusion === "success")) {
    return row("verified", `${at} has passed the full Check; the Release PR's run is re-run by Recheck`, cancelled)
  }
  const red = full.find((run) => run.conclusion === "failure")
  if (red) {
    if (dryRun) return row("failed", `dry run: the full Check of ${at} failed (run ${red.id})`, cancelled)
    const where = await reportFailedCheck(client, repo, pull, tip, red)
    return row("failed", `the full Check of ${at} failed${where} (run ${red.id}); it is not repeated`, cancelled)
  }
  if (full.length >= MAX_LOST_RUNS) {
    return row(
      "gave_up",
      `${full.length} full Checks of ${at} ended without a verdict (${full.map((run) => run.conclusion).join(", ")})`,
      cancelled,
    )
  }
  if (dryRun) return row("started", `dry run: would start the full Check of ${at}`, cancelled)
  try {
    await client.rest("POST", `${api(repo)}/actions/workflows/${own.workflow_id}/dispatches`, {
      body: { ref: base },
    })
  } catch (error) {
    // 403: the App may not write Actions. 404 and 422: the caller cannot be
    // dispatched. None of them gets better by trying again.
    if (error instanceof GitHubHttpError && [403, 404, 422].includes(error.status)) {
      const hint = error.status === 403 ? ` ${NEEDS_ACTIONS_WRITE}` : ""
      return row("refused", `GitHub refused to start the full Check of ${at}: ${error.message}.${hint}`, cancelled)
    }
    throw error
  }
  return row("started", `the full Check of ${at}`, cancelled)
}

/** Every open Release PR of the repository, once. */
export async function runVerify(input: VerifyRunInput): Promise<VerifyRunResult> {
  const rows: VerifyRow[] = []
  try {
    for (const pull of await openReleasePulls(input.client, input.repo)) {
      rows.push(await verifyPull(input, pull))
    }
  } catch (error) {
    return { rows, failed: true, error }
  }
  return { rows, failed: rows.some((row) => row.action === "refused") }
}

/**
 * `bin/verify.ts` without the process: environment in, lines out, the exit
 * code back. See `train/README.md` for the contract.
 */
export async function verifyMain(io: EntryIo): Promise<number> {
  let entry: ReturnType<typeof readEntry>
  try {
    entry = readEntry(io, "verify")
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    io.err(io.argv.includes("--quiet") ? QUIET_USAGE : error.message)
    return EXIT_USAGE
  }
  const result = await runVerify({
    client: entry.client,
    repo: entry.repo,
    dryRun: entry.dryRun,
    appSlug: io.env.TRAIN_APP_SLUG?.trim() || undefined,
  })
  const counts = countBy(
    VERIFY_ACTIONS,
    result.rows.map((r) => r.action),
  )
  if (entry.quiet) {
    io.out(JSON.stringify(counts))
    writeSummary(
      io,
      "Train: verify",
      markdownTable(
        ["Action", "Count"],
        VERIFY_ACTIONS.map((action) => [action, String(counts[action])]),
      ),
    )
    if (result.failed) io.err(QUIET_FAILURE)
  } else {
    for (const row of result.rows) io.out(JSON.stringify(row))
    writeSummary(
      io,
      `Train: verify${entry.dryRun ? " (dry run)" : ""}`,
      result.rows.length === 0
        ? "No open Release PR."
        : markdownTable(
            ["PR", "Base", "Action", "Reason"],
            result.rows.map((r) => [`#${r.number}`, r.base, r.action, r.reason]),
          ),
    )
    if (result.error !== undefined) io.err(`verify: ${messageOf(result.error)}`)
  }
  return result.failed ? EXIT_FAILED : EXIT_OK
}
