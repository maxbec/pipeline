import { type CommitInput, type ConventionalCommit, parseConventional } from "./conventional.ts"
import { type Bump, baseOf, bumpVersion, compareVersions, parseVersion } from "./semver.ts"

/**
 * The version rules, as a pure function. No I/O, no model call, ever: the caller
 * reads git and the open Release PR, this decides. Every rule below is named
 * by its rule number and has one test of its own.
 */

export interface DeriveVersionInput {
  /** Commits on the branch since `lastStableTag`, subjects or subject+body. */
  commits: (string | CommitInput)[]
  /** The newest stable tag reachable from the branch; null before the first release. */
  lastStableTag: string | null
  /** The newest prerelease tag reachable from the branch (rule 4's N). */
  lastPrerelease?: string | null
  branch: string
  repoKind: "major" | "small"
  /** What the open Release PR says today; rule 3 never lets it shrink. */
  currentTarget: string | null
  /** Rule 7: "release as X.Y.Z". */
  override?: string | null
}

export type DerivedBump = Bump | "none" | "override"

export interface DerivedVersion {
  /** Null when there is nothing to release. */
  version: string | null
  /** The stable version this cycle heads toward (a beta's base). */
  target: string | null
  bump: DerivedBump
  reason: string
}

const IMPACT: Record<Bump, number> = { patch: 1, minor: 2, major: 3 }

/** Rule 2, with rule 6's pre-1.0 mapping applied by the caller. */
export function impactOf(commit: ConventionalCommit): Bump | null {
  if (commit.breaking) return "major"
  if (commit.type === "feat") return "minor"
  if (commit.type === "fix" || commit.type === "perf" || commit.type === "revert") return "patch"
  return null
}

function preOneMapping(bump: Bump): Bump {
  // Rule 6: while the major is 0, breaking → minor, feat → minor, fix → patch.
  return bump === "major" ? "minor" : bump
}

function bumpBetween(from: string, to: string): Bump {
  const a = parseVersion(from)
  const b = parseVersion(to)
  if (!a || !b) throw new Error(`not versions: ${from} → ${to}`)
  if (b.major !== a.major) return "major"
  if (b.minor !== a.minor) return "minor"
  return "patch"
}

export function deriveVersion(input: DeriveVersionInput): DerivedVersion {
  const baseline = input.lastStableTag ? parseVersion(input.lastStableTag) : null
  if (input.lastStableTag && !baseline) {
    throw new Error(`lastStableTag is not a version: ${input.lastStableTag}`)
  }
  const baselineVersion = baseline ? baseOf(baseline) : "0.0.0"
  const preOne = (baseline?.major ?? 0) === 0
  const isBeta = input.repoKind === "major" && input.branch === "dev"

  // Rule 7 first: the override is the answer, whatever the commits say.
  if (input.override) {
    const parsed = parseVersion(input.override)
    if (!parsed) throw new Error(`override is not a version: ${input.override}`)
    return {
      version: input.override,
      target: baseOf(parsed),
      bump: "override",
      reason: `release as ${input.override} (manual override)`,
    }
  }

  // Rules 1 and 2: the highest impact across the unreleased conventional commits.
  let best: { bump: Bump; commit: ConventionalCommit } | null = null
  let counted = 0
  for (const raw of input.commits) {
    const commit = parseConventional(raw)
    if (!commit) continue
    counted += 1
    const impact = impactOf(commit)
    if (!impact) continue
    const bump = preOne ? preOneMapping(impact) : impact
    if (!best || IMPACT[bump] > IMPACT[best.bump]) best = { bump, commit }
  }

  // Rule 3: the target may only grow.
  const computed = best ? bumpVersion(baselineVersion, best.bump) : null
  let target = computed
  if (input.currentTarget && (!target || compareVersions(input.currentTarget, target) > 0)) {
    target = input.currentTarget
  }
  if (!target) {
    return {
      version: null,
      target: null,
      bump: "none",
      reason: `nothing to release: ${counted} conventional commit(s) since ${input.lastStableTag ?? "the beginning"}, none of them feat, fix, perf, revert or breaking`,
    }
  }
  // The bump names the distance from the baseline to the target, so a kept
  // target (rule 3) still reads as the minor it is.
  const bump = bumpBetween(baselineVersion, target)
  const why = best
    ? `${best.bump}: ${best.commit.breaking ? "BREAKING " : ""}${best.commit.subject} is the highest impact of ${counted} commit(s) since ${input.lastStableTag ?? "the beginning"}`
    : `kept the open Release PR's target ${target} (rule 3); the range itself carries no bump`
  const reason =
    target !== computed && computed && best
      ? `${why}; kept the open Release PR's target ${target} (rule 3)`
      : why

  // Rules 4 and 5: betas on dev of a major repository, stable everywhere else.
  if (!isBeta) return { version: target, target, bump, reason }
  const previous = input.lastPrerelease ? parseVersion(input.lastPrerelease) : null
  const n = previous?.prerelease && baseOf(previous) === target ? previous.prerelease.n + 1 : 1
  return { version: `${target}-beta.${n}`, target, bump, reason }
}
