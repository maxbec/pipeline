import { statSync } from "node:fs"
import { resolve } from "node:path"
import { parseReleaseConfig, type ReleaseConfig } from "./config.ts"
import {
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
import { git } from "./git/lock.ts"
import type { GitHubClient } from "./github/client.ts"
import { repositoryKindOf } from "./github/merge.ts"
import type { RepoRef } from "./github/pr.ts"
import { createRelease, createTag, getReleaseByTag } from "./github/releases.ts"
import { addLabel } from "./merge-run.ts"
import { openBackmerge } from "./release/backmerge.ts"
import { releaseBody, sectionOf } from "./release/changelog.ts"
import { fetchOrigin, readTreeFile } from "./release/history.ts"
import {
  findLatestMergedRelease,
  findPendingRelease,
  type PendingRelease,
  RELEASED_LABEL,
  ReleaseTagMismatchError,
} from "./release/pending.ts"
import { readPrevious } from "./release/previous.ts"
import { parseVersion } from "./release/semver.ts"
import { CHANGELOG_PATH, syncReleasePr } from "./release/sync.ts"
import type { Repository } from "./types.ts"

/**
 * The Release job: both release branches of one repository, once.
 *
 * Per branch, two steps in this order:
 *
 * 1. **Cut the release a person made.** A merged Release PR without its tag
 *    (`findPendingRelease`) is tagged at its merge commit, published as a
 *    GitHub release, and, after a stable release on `main` of a major
 *    repository, backmerged into `dev` through a pull request. Publishing is
 *    what deploys. The Release PR then gets the `released` label, which ends
 *    the cycle for good: a run that finds the label does nothing, also when
 *    someone deleted the tag since.
 * 2. **Keep the Release PR.** `syncReleasePr` opens or refreshes the branch's
 *    Release PR, with its `previous` read from GitHub (`readPrevious`).
 *
 * The tag comes first, so the sync never sees an untagged release of its own:
 * its tip-subject detection is left in place and simply does not fire here.
 * Nothing in this job merges anything.
 */

/** What a branch's row can say: a `syncReleasePr` result kind, or why the sync was not asked. */
export const RELEASE_RESULTS = [
  "pr",
  "nothing",
  "pending",
  "closed",
  "merged",
  "conflict",
  "refused",
  "error",
  "dry_run",
] as const
export type ReleaseResult = (typeof RELEASE_RESULTS)[number]

export interface ReleaseRow {
  branch: string
  result: ReleaseResult
  reason?: string
  /** The Release PR the sync opened, refreshed or found. */
  pr?: number
  version?: string
  /** The tag this run published a release for. */
  released?: string
  /** The backmerge pull request this run opened or found. */
  backmerge?: number
}

export interface ReleaseRunInput {
  client: GitHubClient
  repo: RepoRef
  /** A full clone with tags; history is read from it. */
  clone: string
  /** `TRAIN_RELEASE_CONFIG`: the `release:` block of `.github/pipeline.yaml` as JSON. */
  config: string | undefined
  /** The train's App, without `[bot]`. A Release PR merged by it is refused. */
  appSlug: string | null
  dryRun: boolean
  now: () => Date
}

export interface ReleaseRunResult {
  rows: ReleaseRow[]
  failed: boolean
  error?: unknown
}

/**
 * The override one branch's sync gets. The config holds a single `release_as`
 * for the repository, and `syncReleasePr` takes it literally, as the version
 * to release. So it goes to the one branch that releases versions of that
 * kind: a prerelease to `dev` of a major repository, a stable version to
 * `main`. A small repository has one branch, which takes either.
 */
export function releaseAsFor(
  branch: string,
  kind: Repository["kind"],
  releaseAs: string | null,
): string | null {
  if (releaseAs === null || kind === "small") return releaseAs
  const prerelease = parseVersion(releaseAs)?.prerelease !== null
  return prerelease === (branch === "dev") ? releaseAs : null
}

const RELEASED = {
  name: RELEASED_LABEL,
  color: "0e8a16",
  description: "The release train published this Release PR's release",
}

interface Cut {
  released?: string
  backmerge?: number
  note?: string
  failed?: boolean
}

/**
 * The release, the backmerge and the label for a merge that has its tag: each
 * is looked for before it is made, so a run that died in the middle is simply
 * finished by the next one.
 */
async function publish(
  input: ReleaseRunInput,
  repository: Repository,
  branch: string,
  release: Pick<PendingRelease, "number" | "version" | "mergeSha">,
): Promise<Cut> {
  const { client, repo } = input
  const { version, mergeSha } = release
  const tag = `v${version}`
  const prerelease = parseVersion(version)?.prerelease !== null
  const cut: Cut = {}

  if ((await getReleaseByTag(client, repo, tag)) === null) {
    // The section the version commit wrote into the changelog is the release's body.
    const changelog = await readTreeFile(repository.path, mergeSha, CHANGELOG_PATH)
    const section = changelog === null ? null : sectionOf(`${changelog}\n`, version)
    await createRelease(client, repo, {
      tag,
      name: tag,
      body: releaseBody(section ?? `## ${version}\n`),
      prerelease,
      targetCommitish: mergeSha,
    })
    cut.released = tag
  }

  if (branch === "main" && repository.kind === "major" && !prerelease) {
    try {
      const opened = await openBackmerge({
        client,
        repository,
        version,
        mergeSha,
        mergedBy: "train",
      })
      if (opened.kind === "no_dev") throw new Error("the repository has no origin/dev")
      if (opened.kind === "pr") {
        cut.backmerge = opened.prNumber
        const conflicts = opened.built?.conflicts ?? []
        if (conflicts.length > 0) {
          cut.note = `the backmerge #${opened.prNumber} conflicts in ${conflicts.join(", ")}: resolve it on ${opened.head}`
        }
      }
    } catch (error) {
      // The release is out. No label yet: the next run finds the tag and tries the backmerge again.
      return {
        ...cut,
        failed: true,
        note: `${tag} is published; its backmerge failed: ${messageOf(error)}`,
      }
    }
  }

  await addLabel(client, repo, release.number, RELEASED)
  return cut
}

async function releaseBranch(
  input: ReleaseRunInput,
  repository: Repository,
  config: ReleaseConfig,
  branch: string,
): Promise<{ row: ReleaseRow; failed: boolean }> {
  const { client, repo, dryRun } = input
  let cut: Cut = {}

  let pending: PendingRelease | null
  try {
    pending = await findPendingRelease(client, repo, branch)
  } catch (error) {
    if (!(error instanceof ReleaseTagMismatchError)) throw error
    return { row: { branch, result: "error", reason: error.message }, failed: true }
  }
  if (pending) {
    const tag = `v${pending.version}`
    if (input.appSlug && pending.mergedBy.login === `${input.appSlug}[bot]`) {
      return {
        row: {
          branch,
          result: "refused",
          version: pending.version,
          pr: pending.number,
          reason: `the Release PR #${pending.number} was merged by ${pending.mergedBy.login}: a Release PR must be merged by a person, so ${tag} is not tagged`,
        },
        failed: true,
      }
    }
    if (dryRun) {
      return {
        row: {
          branch,
          result: "dry_run",
          version: pending.version,
          pr: pending.number,
          reason: `would tag ${tag} at ${pending.mergeSha.slice(0, 7)} and publish it; the Release PR is not synced in a dry run`,
        },
        failed: false,
      }
    }
    await createTag(client, repo, tag, pending.mergeSha)
    cut = await publish(input, repository, branch, pending)
  } else if (!dryRun) {
    // No tag to make. A release whose tag is there but whose cycle never got
    // its label is finished here: the release, the backmerge, the label.
    const latest = await findLatestMergedRelease(client, repo, branch)
    if (latest && latest.tagSha === latest.mergeSha && !latest.labels.includes(RELEASED_LABEL)) {
      cut = await publish(input, repository, branch, latest)
    }
  }
  const done = {
    ...(cut.released ? { released: cut.released } : {}),
    ...(cut.backmerge !== undefined ? { backmerge: cut.backmerge } : {}),
  }
  if (cut.failed) {
    return { row: { branch, result: "error", reason: cut.note, ...done }, failed: true }
  }
  if (dryRun) {
    return {
      row: {
        branch,
        result: "dry_run",
        reason: "no release is pending; the Release PR is not synced in a dry run",
      },
      failed: false,
    }
  }

  const releaseAs = releaseAsFor(branch, repository.kind, config.releaseAs)
  const previous = await readPrevious(client, repo, branch)
  // The one field GitHub does not hold; see `readPrevious`.
  if (previous) previous.releaseAs = releaseAs
  const result = await syncReleasePr({
    client,
    repository,
    branch,
    releaseAs,
    previous,
    now: input.now,
  })
  const note = (reason: string | undefined) =>
    [cut.note, reason].filter(Boolean).join("; ") || undefined
  switch (result.kind) {
    case "pr":
      return {
        row: {
          branch,
          result: "pr",
          pr: result.output.prNumber,
          version: result.output.version,
          reason: note(
            result.changed ? "the Release PR was refreshed" : "the Release PR is up to date",
          ),
          ...done,
        },
        failed: false,
      }
    case "closed":
      return {
        row: {
          branch,
          result: "closed",
          pr: result.output.prNumber,
          version: result.output.version,
          reason: note(result.reason),
          ...done,
        },
        failed: false,
      }
    case "merged":
      // Only the step above tags. A merge the sync recognises and that step
      // did not take up carries `released`, or was merged while this ran.
      return {
        row: {
          branch,
          result: "merged",
          pr: result.output.prNumber,
          version: result.output.version,
          reason: note(
            "a merged Release PR this run does not tag: it was released before, or merged while this ran",
          ),
          ...done,
        },
        failed: false,
      }
    case "conflict":
      return {
        row: { branch, result: "conflict", reason: note(result.reason), ...done },
        failed: true,
      }
    default:
      return {
        row: { branch, result: result.kind, reason: note(result.reason), ...done },
        failed: false,
      }
  }
}

export async function runRelease(input: ReleaseRunInput): Promise<ReleaseRunResult> {
  const { client, repo } = input
  const clone = resolve(input.clone)
  try {
    if (!statSync(clone).isDirectory()) throw new Error("not a directory")
  } catch {
    throw new UsageError(`release: TRAIN_CLONE is not a directory: ${clone}`)
  }
  const rows: ReleaseRow[] = []
  let failed = false
  let branch = ""
  try {
    await fetchOrigin(clone)
    const tags = (await git(clone, ["tag", "--list"])).split("\n").filter(Boolean)
    let config: ReleaseConfig
    try {
      config = parseReleaseConfig(input.config, tags)
    } catch (error) {
      throw new UsageError(`release: ${messageOf(error)}`)
    }
    const kind = await repositoryKindOf(client, repo)
    const repository: Repository = {
      id: `${repo.owner}-${repo.name}`,
      company: repo.owner,
      owner: repo.owner,
      name: repo.name,
      kind,
      path: clone,
      dependabotMergeEnabled: false,
      versionFiles: config.versionFiles,
      changelogShowHidden: config.changelogShowHidden,
    }
    // dev first: the release it cuts is what main's promotion is built from.
    for (branch of kind === "major" ? ["dev", "main"] : ["main"]) {
      const done = await releaseBranch(input, repository, config, branch)
      rows.push(done.row)
      failed ||= done.failed
    }
  } catch (error) {
    if (error instanceof UsageError) throw error
    if (branch) rows.push({ branch, result: "error", reason: messageOf(error) })
    return { rows, failed: true, error }
  }
  return { rows, failed }
}

/**
 * `bin/release.ts` without the process: environment in, lines out, the exit
 * code back. See `train/README.md` for the contract.
 */
export async function releaseMain(io: EntryIo): Promise<number> {
  const quiet = io.argv.includes("--quiet")
  let result: ReleaseRunResult
  let dryRun = false
  try {
    const entry = readEntry(io, "release")
    dryRun = entry.dryRun
    result = await runRelease({
      client: entry.client,
      repo: entry.repo,
      clone: io.env.TRAIN_CLONE?.trim() || process.cwd(),
      config: io.env.TRAIN_RELEASE_CONFIG,
      appSlug: io.env.TRAIN_APP_SLUG?.trim() || null,
      dryRun,
      now: io.now ?? (() => new Date()),
    })
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    io.err(quiet ? QUIET_USAGE : error.message)
    return EXIT_USAGE
  }
  if (quiet) {
    const counts: Record<string, number> = {
      released: result.rows.filter((r) => r.released).length,
    }
    for (const key of RELEASE_RESULTS)
      counts[key] = result.rows.filter((r) => r.result === key).length
    io.out(JSON.stringify(counts))
    writeSummary(
      io,
      "Train: release",
      markdownTable(
        ["Result", "Count"],
        Object.entries(counts).map(([key, count]) => [key, String(count)]),
      ),
    )
    if (result.failed) io.err(QUIET_FAILURE)
  } else {
    for (const row of result.rows) io.out(JSON.stringify(row))
    writeSummary(
      io,
      `Train: release${dryRun ? " (dry run)" : ""}`,
      markdownTable(
        ["Branch", "Result", "Version", "Released", "Reason"],
        result.rows.map((r) => [
          r.branch,
          r.result,
          r.version ?? "",
          r.released ?? "",
          r.reason ?? "",
        ]),
      ),
    )
    if (result.error !== undefined) io.err(`release: ${messageOf(result.error)}`)
  }
  return result.failed ? EXIT_FAILED : EXIT_OK
}
