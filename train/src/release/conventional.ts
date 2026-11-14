/**
 * Conventional commit subjects are the source of truth for versions and
 * changelogs. A squash merge makes the PR title the subject and
 * GitHub appends ` (#N)`, which is where the PR number comes from.
 */

export interface CommitInput {
  subject: string
  body?: string
  sha?: string
}

export interface ConventionalCommit {
  type: string
  scope: string | null
  description: string
  breaking: boolean
  /** The text after `BREAKING CHANGE:`; null when only `!` marked it. */
  breakingNote: string | null
  pr: number | null
  sha: string | null
  subject: string
}

const SUBJECT_RE = /^([a-z]+)(?:\(([^()]*)\))?(!)?: (.+)$/
const PR_SUFFIX_RE = /\s\(#(\d+)\)$/
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:\s*(.*)$/m

export function parseConventional(commit: CommitInput | string): ConventionalCommit | null {
  const input = typeof commit === "string" ? { subject: commit } : commit
  const subject = input.subject.trim()
  const m = SUBJECT_RE.exec(subject)
  if (!m) return null
  const [, type, scope, bang, rest] = m as unknown as [
    string,
    string,
    string | undefined,
    string | undefined,
    string,
  ]
  let description = rest.trim()
  let pr: number | null = null
  const suffix = PR_SUFFIX_RE.exec(description)
  if (suffix) {
    pr = Number(suffix[1])
    description = description.slice(0, suffix.index).trim()
  }
  const footer = input.body ? BREAKING_FOOTER_RE.exec(input.body) : null
  return {
    type,
    scope: scope?.trim() ? scope.trim() : null,
    description,
    breaking: Boolean(bang) || footer !== null,
    breakingNote: footer ? (footer[1] ?? "").trim() || null : null,
    pr,
    sha: input.sha ?? null,
    subject,
  }
}
