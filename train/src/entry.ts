import { appendFileSync } from "node:fs"
import { envTokenProvider } from "./github/app-auth.ts"
import { GitHubClient } from "./github/client.ts"
import type { RepoRef } from "./github/pr.ts"

/**
 * What the two Actions entries share: the environment contract, the exit
 * codes, and the quiet rule. A reusable workflow also runs in public
 * repositories, where the job log and the step summary are public; `--quiet`
 * therefore prints aggregate counts and nothing that names a pull request, a
 * branch, a version or an error.
 */

export const EXIT_OK = 0
/** An unexpected error, or a result the run must not pass over in silence. */
export const EXIT_FAILED = 1
/** The entry was called wrongly: a missing or malformed variable, an unknown flag, a bad config. */
export const EXIT_USAGE = 2

export interface EntryIo {
  env: Record<string, string | undefined>
  /** The arguments after the script's own name. */
  argv: readonly string[]
  out: (line: string) => void
  err: (line: string) => void
  /** Injected by tests; the entry builds one on `GITHUB_TOKEN` otherwise. */
  client?: GitHubClient
  now?: () => Date
}

export interface EntryContext {
  client: GitHubClient
  repo: RepoRef
  dryRun: boolean
  quiet: boolean
}

export class UsageError extends Error {}

/** All a quiet run says about a failure: the exit code carries the rest. */
export const QUIET_FAILURE =
  "the run failed; this log is quiet because it may be public. Run it again without --quiet where the log is private."
export const QUIET_USAGE = "the entry was called with a bad variable, flag or release config"

/** The variables and flags both entries take. Throws a {@link UsageError} that names what is wrong. */
export function readEntry(io: EntryIo, name: string): EntryContext {
  const unknown = io.argv.filter((arg) => arg !== "--quiet")
  if (unknown.length > 0) {
    throw new UsageError(`${name}: unknown argument ${unknown.join(" ")}; the only flag is --quiet`)
  }
  if (!io.env.GITHUB_TOKEN?.trim()) throw new UsageError(`${name}: GITHUB_TOKEN is not set`)
  const slug = io.env.GITHUB_REPOSITORY?.trim() ?? ""
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(slug)
  if (!match) {
    throw new UsageError(`${name}: GITHUB_REPOSITORY must be owner/name, not "${slug}"`)
  }
  const dry = io.env.TRAIN_DRY_RUN?.trim() ?? ""
  return {
    client: io.client ?? new GitHubClient({ tokens: envTokenProvider("GITHUB_TOKEN") }),
    repo: { owner: match[1] ?? "", name: match[2] ?? "" },
    dryRun: dry !== "" && dry !== "0" && dry !== "false",
    quiet: io.argv.includes("--quiet"),
  }
}

/** How many rows carry each key, every key present so the line has one shape. */
export function countBy<K extends string>(
  keys: readonly K[],
  values: readonly string[],
): Record<K, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>
  for (const value of values) {
    if (value in counts) counts[value as K] += 1
  }
  return counts
}

/** A markdown table; cells are escaped so a title cannot break out of its row. */
export function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ")
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n")
}

/** Append to `$GITHUB_STEP_SUMMARY` when the job has one. Never a reason to fail the run. */
export function writeSummary(io: EntryIo, title: string, table: string): void {
  const path = io.env.GITHUB_STEP_SUMMARY?.trim()
  if (!path) return
  try {
    appendFileSync(path, `### ${title}\n\n${table}\n\n`)
  } catch {
    // The summary is a courtesy; the JSON lines are the record.
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
