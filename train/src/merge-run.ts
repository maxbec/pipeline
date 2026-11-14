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
import { type GitHubClient, GitHubHttpError } from "./github/client.ts"
import {
  mergeMethodFor,
  mergePullRequest,
  repositoryKindOf,
  updateBranch,
  verifyCommitSigned,
} from "./github/merge.ts"
import { canMerge, getPrState, type RepoRef } from "./github/pr.ts"
import { mergePolicy, type PolicyDecision, type PolicyInput } from "./policy.ts"
import { findPendingRelease, ReleaseTagMismatchError } from "./release/pending.ts"

/**
 * The Merge job: every open pull request of one repository, once.
 *
 * The event that started the run is only a poke; the whole repository is
 * looked at every time. For each pull request `mergePolicy` says whether it
 * is the train's to merge at all, and only then `canMerge` says whether it is
 * green. Nothing `mergePolicy` did not return `consider` for is ever merged.
 */

export const MERGE_ACTIONS = [
  "merged",
  "updated",
  "waiting",
  "skipped",
  "needs_human",
  "blocked",
] as const
export type MergeAction = (typeof MERGE_ACTIONS)[number]

export interface MergeRow {
  number: number
  action: MergeAction
  reason: string
}

export interface MergeRunInput {
  client: GitHubClient
  repo: RepoRef
  /** Decide and report, write nothing: no merge, no branch update, no label, no comment. */
  dryRun: boolean
}

export interface MergeRunResult {
  rows: MergeRow[]
  /** A merge commit GitHub did not verify, or an unexpected error: the run is exit 1. */
  failed: boolean
  /** The unexpected error that ended the run early, when one did. */
  error?: unknown
}

/** Set on a pull request the train will not merge because it changes its own judge. */
export const NEEDS_HUMAN_LABEL = "needs-human"
/** Marks the train's one comment on such a pull request, so it is never repeated. */
export const NEEDS_HUMAN_MARKER = "<!-- train:needs-human -->"

/** GitHub lists at most this many files of a pull request; more than that is not known. */
const MAX_LISTED_FILES = 3000

interface OpenPull {
  number: number
  title: string
  draft?: boolean
  labels?: { name: string }[]
  user?: { login: string } | null
  head: { ref: string; repo?: { full_name: string } | null }
  base: { ref: string; repo?: { full_name: string } | null }
}

async function paged<T>(client: GitHubClient, path: string): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; ; page++) {
    const res = await client.rest<T[]>(
      "GET",
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    )
    const items = res.body ?? []
    all.push(...items)
    if (items.length < 100) return all
  }
}

/** Every path a pull request changes, a rename's old path included; null when GitHub cut the list. */
async function changedFiles(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
): Promise<string[] | null> {
  const files = await paged<{ filename: string; previous_filename?: string }>(
    client,
    `/repos/${repo.owner}/${repo.name}/pulls/${number}/files`,
  )
  if (files.length >= MAX_LISTED_FILES) return null
  return files.flatMap((f) =>
    f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
  )
}

/** Create the label when the repository lacks it, then put it on the pull request. */
export async function addLabel(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  label: { name: string; color: string; description: string },
): Promise<void> {
  try {
    await client.rest("POST", `/repos/${repo.owner}/${repo.name}/labels`, { body: label })
  } catch (error) {
    // 422: the label is there already, which is all this wanted.
    if (!(error instanceof GitHubHttpError && error.status === 422)) throw error
  }
  await client.rest("POST", `/repos/${repo.owner}/${repo.name}/issues/${number}/labels`, {
    body: { labels: [label.name] },
  })
}

/** The label and the one comment. Both are looked for before they are written. */
async function flagNeedsHuman(
  client: GitHubClient,
  repo: RepoRef,
  pull: OpenPull,
  reason: string,
): Promise<void> {
  if (!(pull.labels ?? []).some((l) => l.name === NEEDS_HUMAN_LABEL)) {
    await addLabel(client, repo, pull.number, {
      name: NEEDS_HUMAN_LABEL,
      color: "d93f0b",
      description: "The release train leaves this pull request to a person",
    })
  }
  const comments = await paged<{ body?: string | null }>(
    client,
    `/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
  )
  if (comments.some((c) => c.body?.includes(NEEDS_HUMAN_MARKER))) return
  await client.rest("POST", `/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`, {
    body: {
      body: [
        NEEDS_HUMAN_MARKER,
        `The release train does not merge this pull request: it ${reason}.`,
        "",
        "A person reviews the change to the pipeline and merges it by hand once `pipeline / Check` is green.",
      ].join("\n"),
    },
  })
}

/** GitHub's answers to a merge or a branch update that lost a race: the next run sees the new state. */
function lostRace(error: unknown): error is GitHubHttpError {
  return error instanceof GitHubHttpError && [405, 409, 422].includes(error.status)
}

export async function runMerge(input: MergeRunInput): Promise<MergeRunResult> {
  const { client, repo, dryRun } = input
  const rows: MergeRow[] = []
  let failed = false
  const would = (reason: string) => (dryRun ? `dry run: ${reason}` : reason)

  // Why nothing may merge into a base right now, or null; asked once per base.
  const held = new Map<string, string | null>()
  const heldBase = async (base: string): Promise<string | null> => {
    if (!held.has(base)) {
      let reason: string | null = null
      try {
        const pending = await findPendingRelease(client, repo, base)
        if (pending) {
          reason = `the Release PR #${pending.number} (${pending.version}) is merged into ${base} and not tagged yet; nothing merges into ${base} until it is`
        }
      } catch (error) {
        // A tag on the wrong commit is the Release job's to fail on; here the base is simply held.
        if (!(error instanceof ReleaseTagMismatchError)) throw error
        reason = error.message
      }
      held.set(base, reason)
    }
    return held.get(base) ?? null
  }

  try {
    const kind = await repositoryKindOf(client, repo)
    const pulls = await paged<OpenPull>(
      client,
      `/repos/${repo.owner}/${repo.name}/pulls?state=open&sort=created&direction=asc`,
    )
    for (const pull of pulls) {
      const { number } = pull
      const state = await getPrState(client, repo, number)
      const facts: Omit<PolicyInput, "changedFiles"> = {
        isDraft: Boolean(pull.draft) || state.isDraft,
        labels: (pull.labels ?? []).map((l) => l.name),
        headRefName: pull.head.ref,
        baseRefName: pull.base.ref,
        headRepository: pull.head.repo?.full_name ?? null,
        baseRepository: pull.base.repo?.full_name ?? `${repo.owner}/${repo.name}`,
        authorLogin: pull.user?.login ?? state.authorLogin,
        title: state.title,
        commits: state.commits,
      }
      // The diff is only read for a pull request nothing else already rules out.
      let decision: PolicyDecision = mergePolicy({ ...facts, changedFiles: [] }, kind)
      if (decision.action === "consider") {
        const files = await changedFiles(client, repo, number)
        decision =
          files === null
            ? {
                action: "needs_human",
                reason: `changes more files than GitHub lists (${MAX_LISTED_FILES}), so whether it touches the pipeline is not known`,
              }
            : mergePolicy({ ...facts, changedFiles: files }, kind)
      }
      if (decision.action === "skip") {
        rows.push({ number, action: "skipped", reason: decision.reason })
        continue
      }
      const waiting = await heldBase(pull.base.ref)
      if (waiting) {
        rows.push({ number, action: "waiting", reason: waiting })
        continue
      }
      if (decision.action === "needs_human") {
        if (!dryRun) await flagNeedsHuman(client, repo, pull, decision.reason)
        rows.push({ number, action: "needs_human", reason: decision.reason })
        continue
      }

      const verdict = canMerge(state)
      if (!verdict.ok) {
        if (verdict.code === "behind" && verdict.remedy === "update_branch") {
          try {
            if (!dryRun) await updateBranch(client, repo, number, state.headSha)
            rows.push({ number, action: "updated", reason: would(verdict.reason) })
          } catch (error) {
            if (!lostRace(error)) throw error
            rows.push({ number, action: "blocked", reason: `update-branch: ${error.message}` })
          }
          continue
        }
        rows.push({ number, action: "blocked", reason: verdict.reason })
        continue
      }
      const method = mergeMethodFor(state, kind)
      if (dryRun) {
        rows.push({ number, action: "merged", reason: would(`would merge by ${method}`) })
        continue
      }
      let sha: string
      try {
        const merged = await mergePullRequest(client, repo, number, {
          method,
          expectedHeadSha: state.headSha,
          title: `${state.title} (#${number})`,
          body: state.body,
        })
        sha = merged.sha
      } catch (error) {
        if (!lostRace(error)) throw error
        rows.push({ number, action: "blocked", reason: `merge: ${error.message}` })
        continue
      }
      const verification = await verifyCommitSigned(client, repo, sha)
      if (verification.verified) {
        rows.push({ number, action: "merged", reason: `${method} ${sha.slice(0, 7)}, verified` })
      } else {
        failed = true
        rows.push({
          number,
          action: "merged",
          reason: `${method} ${sha.slice(0, 7)} is not verified (${verification.reason}): the base now carries an unsigned commit`,
        })
      }
    }
  } catch (error) {
    return { rows, failed: true, error }
  }
  return { rows, failed }
}

/**
 * `bin/merge.ts` without the process: environment in, lines out, the exit
 * code back. See `train/README.md` for the contract.
 */
export async function mergeMain(io: EntryIo): Promise<number> {
  let entry: ReturnType<typeof readEntry>
  try {
    entry = readEntry(io, "merge")
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    io.err(io.argv.includes("--quiet") ? QUIET_USAGE : error.message)
    return EXIT_USAGE
  }
  const result = await runMerge({ client: entry.client, repo: entry.repo, dryRun: entry.dryRun })
  const counts = countBy(
    MERGE_ACTIONS,
    result.rows.map((r) => r.action),
  )
  if (entry.quiet) {
    io.out(JSON.stringify(counts))
    writeSummary(
      io,
      "Train: merge",
      markdownTable(
        ["Action", "Count"],
        MERGE_ACTIONS.map((action) => [action, String(counts[action])]),
      ),
    )
    if (result.failed) io.err(QUIET_FAILURE)
  } else {
    for (const row of result.rows) io.out(JSON.stringify(row))
    writeSummary(
      io,
      `Train: merge${entry.dryRun ? " (dry run)" : ""}`,
      result.rows.length === 0
        ? "No open pull requests."
        : markdownTable(
            ["PR", "Action", "Reason"],
            result.rows.map((r) => [`#${r.number}`, r.action, r.reason]),
          ),
    )
    if (result.error !== undefined) io.err(`merge: ${messageOf(result.error)}`)
  }
  return result.failed ? EXIT_FAILED : EXIT_OK
}
