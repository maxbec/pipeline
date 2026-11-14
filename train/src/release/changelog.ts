import { type CommitInput, type ConventionalCommit, parseConventional } from "./conventional.ts"

/**
 * Release notes in release-please's own layout, byte for byte: the
 * repositories' existing CHANGELOG files continue without a visible seam.
 * Sections in a fixed order, hidden types behind a per-repository toggle,
 * entries `**scope:** subject (#PR) (sha)` with links. Nothing here calls a
 * model; the Codex polish toggle is reserved and off.
 */

export interface ChangelogRepo {
  owner: string
  name: string
}

export interface RenderSectionInput {
  version: string
  /** The tag the compare link starts from; null for the first release. */
  previousTag: string | null
  /** YYYY-MM-DD, as release-please prints it. */
  date: string
  repo: ChangelogRepo
  /** Newest first, the order `git log` gives and release-please keeps. */
  commits: (string | CommitInput)[]
  showHidden?: boolean
}

interface SectionSpec {
  type: string
  title: string
  hidden: boolean
}

export const BREAKING_SECTION = "⚠ BREAKING CHANGES"

/** The section order, with Reverts visible (they bump the patch) and the hidden tail. */
export const SECTIONS: readonly SectionSpec[] = [
  { type: "feat", title: "✨ Features", hidden: false },
  { type: "fix", title: "🐛 Bug Fixes", hidden: false },
  { type: "perf", title: "⚡ Performance", hidden: false },
  { type: "revert", title: "⏪ Reverts", hidden: false },
  { type: "refactor", title: "♻️ Refactoring", hidden: false },
  { type: "docs", title: "📝 Documentation", hidden: false },
  { type: "test", title: "✅ Tests", hidden: true },
  { type: "build", title: "📦 Build", hidden: true },
  { type: "ci", title: "🚀 CI/CD", hidden: true },
  { type: "chore", title: "🔧 Miscellaneous", hidden: true },
  { type: "style", title: "💄 Styles", hidden: true },
]

function repoUrl(repo: ChangelogRepo): string {
  return `https://github.com/${repo.owner}/${repo.name}`
}

function scoped(commit: ConventionalCommit, text: string): string {
  return commit.scope ? `**${commit.scope}:** ${text}` : text
}

function entry(commit: ConventionalCommit, repo: ChangelogRepo): string {
  const parts = [scoped(commit, commit.description)]
  if (commit.pr !== null) parts.push(`([#${commit.pr}](${repoUrl(repo)}/issues/${commit.pr}))`)
  if (commit.sha) parts.push(`([${commit.sha.slice(0, 7)}](${repoUrl(repo)}/commit/${commit.sha}))`)
  return `* ${parts.join(" ")}`
}

function breakingEntry(commit: ConventionalCommit): string {
  return `* ${scoped(commit, commit.breakingNote ?? commit.description)}`
}

export function sectionHeader(
  input: Pick<RenderSectionInput, "version" | "previousTag" | "date" | "repo">,
): string {
  const { version, previousTag, date, repo } = input
  if (!previousTag) return `## ${version} (${date})`
  return `## [${version}](${repoUrl(repo)}/compare/${previousTag}...v${version}) (${date})`
}

export function renderSection(input: RenderSectionInput): string {
  const commits = input.commits
    .map((c) => parseConventional(c))
    .filter((c): c is ConventionalCommit => c !== null)
  const blocks: string[] = []
  const breaking = commits.filter((c) => c.breaking)
  if (breaking.length > 0) {
    blocks.push(`### ${BREAKING_SECTION}\n\n${breaking.map(breakingEntry).join("\n")}\n`)
  }
  for (const section of SECTIONS) {
    if (section.hidden && !input.showHidden) continue
    const entries = commits.filter((c) => c.type === section.type)
    if (entries.length === 0) continue
    blocks.push(`### ${section.title}\n\n${entries.map((c) => entry(c, input.repo)).join("\n")}\n`)
  }
  const header = `${sectionHeader(input)}\n`
  return blocks.length === 0 ? header : `${header}\n\n${blocks.join("\n\n")}`
}

export const CHANGELOG_TITLE = "# Changelog\n"

/** The new section goes under the title, above everything else, unchanged. */
export function prependToChangelog(existing: string | null, section: string): string {
  const current = existing ?? ""
  if (current.trim() === "") return `${CHANGELOG_TITLE}\n${section}`
  if (current.startsWith(CHANGELOG_TITLE)) {
    const rest = current.slice(CHANGELOG_TITLE.length).replace(/^\n+/, "")
    return `${CHANGELOG_TITLE}\n${section}\n${rest}`
  }
  return `${section}\n${current}`
}

/** The GitHub release body: the section without its trailing newline. */
export function releaseBody(section: string): string {
  return section.trimEnd()
}

/** Read one version's section back out of a changelog, or null. */
export function sectionOf(changelog: string, version: string): string | null {
  const lines = changelog.split("\n")
  const isHeader = (line: string) =>
    line.startsWith(`## [${version}]`) || line.startsWith(`## ${version} `)
  const start = lines.findIndex(isHeader)
  if (start < 0) return null
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "))
  if (end < 0) end = lines.length
  // Drop the blank separator that sits between sections in the file.
  while (end > start + 1 && lines[end - 1] === "") end -= 1
  return `${lines.slice(start, end).join("\n")}\n`
}

/** Every `## ` section of a changelog, newest first as the file keeps them. */
export function sectionsOf(changelog: string): { version: string; text: string }[] {
  const lines = changelog.split("\n")
  const starts = lines.map((line, i) => (line.startsWith("## ") ? i : -1)).filter((i) => i >= 0)
  return starts.map((start, n) => {
    let end = starts[n + 1] ?? lines.length
    while (end > start + 1 && lines[end - 1] === "") end -= 1
    const header = lines[start] ?? ""
    const version = /^## \[?([^\]\s]+)/.exec(header)?.[1] ?? header
    return { version, text: `${lines.slice(start, end).join("\n")}\n` }
  })
}

/**
 * `ours` plus the sections only `theirs` has, on top: what a backmerge does
 * to dev's changelog when main released in the meantime. Nothing is
 * rewritten — sections are byte-for-byte what each branch wrote.
 */
export function mergeChangelogs(ours: string, theirs: string): string {
  const have = new Set(sectionsOf(ours).map((s) => s.version))
  const incoming = sectionsOf(theirs).filter((s) => !have.has(s.version))
  let merged = ours
  for (const section of [...incoming].reverse()) merged = prependToChangelog(merged, section.text)
  return merged
}
