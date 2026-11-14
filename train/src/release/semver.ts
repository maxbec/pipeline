/**
 * The slice of semver the release path needs. No dependency: every rule here
 * has to be readable against the version rules, and a full semver library would import
 * range syntax nothing uses.
 */

export interface Prerelease {
  tag: string
  /** `1.3.0-beta` reads as n = 0, the way release-please names a first beta. */
  n: number
}

export interface Version {
  major: number
  minor: number
  patch: number
  prerelease: Prerelease | null
}

export type Bump = "major" | "minor" | "patch"

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z][A-Za-z0-9]*)(?:\.(\d+))?)?$/

export function parseVersion(input: string): Version | null {
  const m = VERSION_RE.exec(input.trim())
  if (!m) return null
  const [, major, minor, patch, tag, n] = m
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: tag ? { tag, n: n === undefined ? 0 : Number(n) } : null,
  }
}

export function formatVersion(v: Version): string {
  const base = `${v.major}.${v.minor}.${v.patch}`
  if (!v.prerelease) return base
  return v.prerelease.n === 0
    ? `${base}-${v.prerelease.tag}`
    : `${base}-${v.prerelease.tag}.${v.prerelease.n}`
}

/** `1.3.0-beta.2` → `1.3.0`: the release a prerelease is heading toward. */
export function baseOf(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`
}

function mustParse(input: string): Version {
  const v = parseVersion(input)
  if (!v) throw new Error(`not a version: ${input}`)
  return v
}

/** Semver precedence: a prerelease sorts before its release, betas by number. */
export function compareVersions(a: string, b: string): number {
  const x = mustParse(a)
  const y = mustParse(b)
  for (const key of ["major", "minor", "patch"] as const) {
    if (x[key] !== y[key]) return x[key] - y[key]
  }
  if (!x.prerelease && !y.prerelease) return 0
  if (!x.prerelease) return 1
  if (!y.prerelease) return -1
  if (x.prerelease.tag !== y.prerelease.tag) return x.prerelease.tag < y.prerelease.tag ? -1 : 1
  return x.prerelease.n - y.prerelease.n
}

export function bumpVersion(version: string, bump: Bump): string {
  const v = mustParse(version)
  switch (bump) {
    case "major":
      return `${v.major + 1}.0.0`
    case "minor":
      return `${v.major}.${v.minor + 1}.0`
    case "patch":
      return `${v.major}.${v.minor}.${v.patch + 1}`
  }
}
