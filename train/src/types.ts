/**
 * The few shared shapes the train works on. Plain types, no schema library:
 * whoever builds a value (an entry point reading its config, a test) is the
 * one that validates it.
 */

/** The owner group a repository belongs to; one GitHub App installation each. */
export type CompanySlug = string

/**
 * A major repository has `dev` and `main`; a small repository has only `main`.
 * The kind is what the base branch derives from — never store the branch.
 */
export type RepositoryKind = "major" | "small"

export interface Repository {
  id: string
  company: CompanySlug
  owner: string
  name: string
  kind: RepositoryKind
  /** The local clone the history is read from. */
  path: string
  /** The train squash-merges this repository's green Dependabot pull requests. */
  dependabotMergeEnabled: boolean
  /**
   * Where the version is written. Globs relative to the repository root; a
   * single-version monorepo lists its workspace packages, a non-Node
   * repository lists its own files or nothing (tag and CHANGELOG only).
   */
  versionFiles: string[]
  /** Tests, build, CI and chores are hidden from the changelog unless this is on. */
  changelogShowHidden: boolean
}

/** The base branch work branches from and targets. */
export function baseBranchFor(repo: Pick<Repository, "kind">): "dev" | "main" {
  return repo.kind === "major" ? "dev" : "main"
}

/** The merge rules, as a verdict a caller can show or act on. */
export type MergeVerdict =
  | { ok: true }
  | {
      ok: false
      code:
        | "merged"
        | "closed"
        | "draft"
        | "conflicting"
        | "checks_red"
        | "checks_pending"
        | "unresolved_threads"
        | "unsigned"
        | "behind"
        | "blocked"
        | "unknown"
      reason: string
      remedy?: "update_branch" | "promote_branch" | "resolve_on_branch" | "wait" | "fix" | "none"
    }

/** "Something about PR N of owner/repo changed": what a merge pass is woken with. */
export interface GitHubEvent {
  id: number
  company: CompanySlug
  owner: string
  repo: string
  /** The `X-GitHub-Event` name, or the resource a poll watched. */
  kind: string
  action: string
  number: number | null
  headSha: string | null
  deliveryId: string | null
  source: "webhook" | "poll"
  payload: Record<string, unknown>
  receivedAt: string
}
