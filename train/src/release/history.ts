import { GitError, git, gitBytes } from "../git/lock.ts"
import type { CommitInput } from "./conventional.ts"
import { compareVersions, parseVersion } from "./semver.ts"

/**
 * What the version deriver and the changelog need from git, read from the
 * repository clone after a fetch. Everything is a plain read of refs and
 * subjects — the engine never trusts a model for any of it.
 *
 * Two ranges matter: since the newest *stable* tag (the version, rule 4)
 * and since the newest tag of any kind (the changelog section and the
 * "anything new?" question). On `dev` they differ after the first beta.
 *
 * The stable baseline is the newest stable tag **in the repository**, not the
 * newest one reachable from the branch. A version number belongs to the
 * repository, and `dev` cannot see `main`'s tags: `dev` is squash-only, so the
 * backmerge after a promotion lands as a fresh commit and the release tag never
 * enters `dev`'s ancestry. Reading only reachable tags let maxbec/pipeline
 * derive 4.0.0 on a `dev` whose newest reachable stable tag was still v3.2.0 —
 * long after v5.0.0 shipped. Prereleases stay reachability-scoped: they are cut
 * on this branch and number this branch's cycle.
 *
 * Because that tag is not in the branch's ancestry, "since the stable tag" by
 * SHA also lists changes the tag already contains under another SHA: a fix
 * squash-merged into dev and cherry-picked onto main as a hotfix is two
 * commits. Both ranges therefore drop every commit whose patch the stable tag
 * already carries (`containedIn`).
 *
 * Patch identity cannot see through a promotion squash-merged into main: its
 * one commit carries the whole cycle as a single patch. Both ranges therefore
 * also drop everything the prerelease the tag was promoted from carries
 * (`promotedFrom`).
 */

export interface ReleaseHistory {
  /** The tip of the ref that was read. */
  sha: string
  lastStableTag: string | null
  /** The newest prerelease tag reachable, only if newer than the stable one. */
  lastPrereleaseTag: string | null
  /** The newest tag of either kind: what the compare link starts from. */
  lastReleaseTag: string | null
  commitsSinceStable: CommitInput[]
  commitsSinceRelease: CommitInput[]
  /**
   * Commits after the stable tag by SHA whose change the tag already carries
   *. Dropped from both ranges; kept here so a "nothing
   * to release" can say what it set aside.
   */
  alreadyReleased: CommitInput[]
  /**
   * The prerelease the stable tag was promoted from, when the tag's ancestry
   * does not show it; null when it does, or nothing was promoted.
   */
  promotedFrom: string | null
}

export async function fetchOrigin(clone: string): Promise<void> {
  await git(clone, ["fetch", "--quiet", "--prune", "--tags", "--force", "origin"])
}

async function versionTags(clone: string, args: string[]): Promise<string[]> {
  const out = await git(clone, ["tag", ...args])
  return out
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t && parseVersion(t))
}

function newest(tags: string[]): string | null {
  if (tags.length === 0) return null
  return [...tags].sort(compareVersions).at(-1) ?? null
}

/** Newest first, the order `git log` gives and the changelog keeps. */
export async function commitsBetween(
  clone: string,
  from: string | null,
  to: string,
): Promise<CommitInput[]> {
  const range = from ? `${from}..${to}` : to
  const out = await git(clone, ["log", "--format=%H%x1f%s%x1f%b%x1e", range])
  return out
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, subject, body] = c.split("\x1f")
      return { sha: sha ?? "", subject: subject ?? "", body: body ?? "" }
    })
}

/**
 * The commits of `commits` whose change `upstream` already carries under
 * another SHA, by patch identity: `git cherry` marks a commit `-` when a
 * commit on the upstream side has the same `git patch-id`.
 *
 * Patch identity, not the PR number in the subject. Once
 * maxbec/pipeline#87 landed on dev as 2dd2237 and reached main through hotfix
 * PR #90 as a722bac; v5.0.2 was cut from main, and the dev range since v5.0.2
 * listed 2dd2237 again — Release PR #93 "5.0.3-beta.1" with #87 as its only
 * entry. Both commits have patch-id 92798f9a. Their subjects agree on "(#87)"
 * only because #90 cherry-picked the commit and was merged by merge commit; a
 * hotfix squash-merged the usual way carries its own number, so a PR-number
 * match would have missed exactly the common case. A cherry-pick that needed
 * a conflict resolution changes the patch and is counted again — one extra
 * beta, never a lost change.
 *
 * The upstream side is taken per commit, from that commit's own merge base
 * with `upstream`: once the backmerge (a merge commit) has
 * brought the tag into dev, `git cherry <tag> dev` finds the tag itself as the
 * merge base and compares against nothing, while dev's own commit from before
 * the backmerge still sits in `tag..dev`. Commits sharing a merge base share
 * one `git cherry` call; a commit whose merge base is `upstream` itself came
 * after it and is new by construction.
 */
export async function containedIn(
  clone: string,
  upstream: string,
  commits: readonly CommitInput[],
): Promise<Set<string>> {
  const contained = new Set<string>()
  const tip = await resolveRef(clone, upstream)
  if (!tip) return contained
  const groups = new Map<string, string[]>()
  for (const commit of commits) {
    if (!commit.sha) continue
    const base = await mergeBase(clone, tip, commit.sha)
    // No common history, or the commit came after `upstream`: nothing to match.
    if (base === null || base === tip) continue
    groups.set(base, [...(groups.get(base) ?? []), commit.sha])
  }
  for (const [base, shas] of groups) {
    const pending = new Set(shas)
    // `git log` order is newest first: the first pending commit's range covers
    // its whole line back to the base; a side line gets a call of its own.
    for (const head of shas) {
      if (!pending.has(head)) continue
      const out = await git(clone, ["cherry", tip, head, base])
      for (const line of out.split("\n")) {
        const m = /^([+-]) ([0-9a-f]+)$/.exec(line.trim())
        if (!m?.[2]) continue
        pending.delete(m[2])
        if (m[1] === "-" && shas.includes(m[2])) contained.add(m[2])
      }
      pending.delete(head)
    }
  }
  return contained
}

/**
 * The prerelease a stable tag was promoted from, when the tag's ancestry does
 * not show it. A promotion is dev's last release plus one version commit,
 * merged by merge commit; merged as a squash, main gets one commit
 * whose patch is the whole cycle. After a 0.41.0 that went in that way, the
 * next Release PR on dev would list every entry of 0.41.0 again:
 * `v0.41.0..dev` holds all of dev's commits, and no single one of them has
 * the squash's patch.
 *
 * The candidate is the newest prerelease below the tag that the tag's history
 * does not already contain. It counts only when the tag's tree differs from it
 * in nothing but the files the prerelease's own commit wrote — the version
 * files and the changelog of its Release PR. A stable release cut from
 * something else, a feat hotfix that reaches the beta's version first, differs
 * in code and is not taken for the promotion: when in doubt an entry is listed
 * twice, never dropped.
 */
export async function promotedFrom(
  clone: string,
  stableTag: string,
  tags: readonly string[],
): Promise<string | null> {
  const candidate = newest(
    tags.filter((t) => parseVersion(t)?.prerelease !== null && compareVersions(t, stableTag) < 0),
  )
  if (!candidate || (await isAncestor(clone, candidate, stableTag))) return null
  // A root or a merge commit has no single commit of its own to read.
  const parents = (await git(clone, ["rev-list", "--parents", "-n", "1", candidate])).split(" ")
  if (parents.length !== 2) return null
  const names = async (from: string, to: string) =>
    (await git(clone, ["diff", "--name-only", "--no-renames", from, to]))
      .split("\n")
      .filter(Boolean)
  const written = new Set(await names(`${candidate}^`, candidate))
  const differ = await names(candidate, stableTag)
  return differ.every((path) => written.has(path)) ? candidate : null
}

/** The commits `from` reaches that `notFrom` does not. */
export async function reachableOnlyFrom(
  clone: string,
  from: string,
  notFrom: string,
): Promise<Set<string>> {
  const out = await git(clone, ["rev-list", from, `^${notFrom}`])
  return new Set(out.split("\n").filter(Boolean))
}

async function mergeBase(clone: string, a: string, b: string): Promise<string | null> {
  try {
    return await git(clone, ["merge-base", a, b])
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return null
    throw error
  }
}

export async function readHistory(clone: string, ref: string): Promise<ReleaseHistory> {
  const sha = await git(clone, ["rev-parse", "--verify", ref])
  const reachable = await versionTags(clone, ["--merged", ref])
  const everywhere = await versionTags(clone, [])
  const lastStableTag = newest(everywhere.filter((t) => parseVersion(t)?.prerelease === null))
  const prerelease = newest(reachable.filter((t) => parseVersion(t)?.prerelease !== null))
  const lastPrereleaseTag =
    prerelease && (!lastStableTag || compareVersions(prerelease, lastStableTag) > 0)
      ? prerelease
      : null
  const lastReleaseTag = lastPrereleaseTag ?? lastStableTag
  const sinceStable = await commitsBetween(clone, lastStableTag, ref)
  const sinceRelease = await commitsBetween(clone, lastReleaseTag, ref)
  const promoted = lastStableTag ? await promotedFrom(clone, lastStableTag, everywhere) : null
  const carried =
    promoted && lastStableTag
      ? await reachableOnlyFrom(clone, promoted, lastStableTag)
      : new Set<string>()
  const contained = lastStableTag
    ? await containedIn(
        clone,
        lastStableTag,
        sinceStable.filter((c) => !carried.has(c.sha ?? "")),
      )
    : new Set<string>()
  const fresh = (c: CommitInput) => !c.sha || (!carried.has(c.sha) && !contained.has(c.sha))
  return {
    sha,
    lastStableTag,
    lastPrereleaseTag,
    lastReleaseTag,
    commitsSinceStable: sinceStable.filter(fresh),
    commitsSinceRelease: sinceRelease.filter(fresh),
    alreadyReleased: sinceStable.filter((c) => !fresh(c)),
    promotedFrom: promoted,
  }
}

/** A file's content at a ref, or null when the tree has no such path. */
export async function readTreeFile(
  clone: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    return await git(clone, ["show", `${ref}:${path}`])
  } catch {
    return null
  }
}

/**
 * The same, byte-exact: `git()` trims stdout, so the trailing newline is lost.
 * A file that is written back needs it (Prettier rejects a file without one).
 */
export async function readTreeFileExact(
  clone: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    return (await gitBytes(clone, ["show", `${ref}:${path}`])).toString("utf8")
  } catch {
    return null
  }
}

export async function listTree(clone: string, ref: string): Promise<string[]> {
  const out = await git(clone, ["ls-tree", "-r", "--name-only", ref])
  return out.split("\n").filter(Boolean)
}

/** `*` within a segment, `**` across segments, `?` one character. Anchored. */
export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"
        i += 1
        if (glob[i + 1] === "/") i += 1
      } else re += "[^/]*"
    } else if (ch === "?") re += "[^/]"
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

/** The object a ref names, or null when the clone has no such ref. */
export async function resolveRef(
  clone: string,
  ref: string,
  type: "commit" | "tree" = "commit",
): Promise<string | null> {
  try {
    return await git(clone, ["rev-parse", "--verify", "-q", `${ref}^{${type}}`])
  } catch {
    return null
  }
}

/** A file's bytes at a ref, untrimmed; null when the tree has no such path. */
export async function readTreeBytes(
  clone: string,
  ref: string,
  path: string,
): Promise<Buffer | null> {
  try {
    return await gitBytes(clone, ["show", `${ref}:${path}`])
  } catch {
    return null
  }
}

export async function isAncestor(clone: string, ancestor: string, of: string): Promise<boolean> {
  try {
    await git(clone, ["merge-base", "--is-ancestor", ancestor, of])
    return true
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false
    throw error
  }
}

export interface MergeTreeResult {
  /** The three-way merged tree; conflicted files carry markers. */
  tree: string
  /** Paths git could not merge on its own. Empty when the merge is clean. */
  conflicts: string[]
}

/**
 * `git merge-tree --write-tree`: the merge of `theirs` into `ours` as a tree
 * object in the clone, without touching the index or any ref. The merge the
 * engine builds from it is a real merge — git did the three-way work.
 */
export async function mergeTree(
  clone: string,
  ours: string,
  theirs: string,
): Promise<MergeTreeResult> {
  const parse = (out: string) => {
    const [tree = "", ...rest] = out.split("\n")
    const conflicts: string[] = []
    for (const line of rest) {
      if (line === "") break
      conflicts.push(line)
    }
    return { tree, conflicts: [...new Set(conflicts)] }
  }
  try {
    return parse(await git(clone, ["merge-tree", "--write-tree", "--name-only", ours, theirs]))
  } catch (error) {
    // Exit 1 is "merged with conflicts"; the tree and the file list are on stdout.
    if (error instanceof GitError && error.exitCode === 1 && error.stdout !== undefined) {
      return parse(error.stdout)
    }
    throw error
  }
}

export interface TreeChange {
  path: string
  /** null when the path is gone in `to`. */
  mode: string | null
  sha: string | null
}

/** What `to` changes against `from`, path by path, renames shown as delete plus add. */
export async function diffTrees(clone: string, from: string, to: string): Promise<TreeChange[]> {
  const out = await git(clone, ["diff-tree", "-r", "--no-renames", "-z", from, to])
  const fields = out.split("\0")
  const changes: TreeChange[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i] ?? ""
    const path = fields[i + 1] ?? ""
    // :<old mode> <new mode> <old sha> <new sha> <status>
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(meta)
    if (!m || !path) continue
    const deleted = m[5] === "D"
    changes.push({
      path,
      mode: deleted ? null : (m[2] ?? null),
      sha: deleted ? null : (m[4] ?? null),
    })
  }
  return changes
}

/** A blob's bytes, untrimmed. */
export async function readBlob(clone: string, sha: string): Promise<Buffer> {
  return gitBytes(clone, ["cat-file", "blob", sha])
}
