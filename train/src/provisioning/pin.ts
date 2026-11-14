/**
 * The pipeline pin: which commit of maxbec/pipeline the callers point at, read
 * from a local clone of it without a network call.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/** A pipeline pin: the commit the callers point at, and its tag if it has one. */
export interface PipelinePin {
  /** Full commit sha of maxbec/pipeline the callers pin. */
  sha: string
  /** `X.Y.Z[-pre]` of the tag at that sha, or null when the sha is untagged. */
  version: string | null
}

const VERSION_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const STABLE_TAG = /^v\d+\.\d+\.\d+$/

async function git(clone: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", clone, ...args], { encoding: "utf8" })).stdout.trim()
}

/** The newest stable `vX.Y.Z` tag in the pipeline clone, without its `v`. */
export async function latestPipelineTag(pipelineClone: string): Promise<string | null> {
  try {
    const tags = await git(pipelineClone, "tag", "--sort=-v:refname")
    return (
      tags
        .split("\n")
        .find((t) => STABLE_TAG.test(t))
        ?.slice(1) ?? null
    )
  } catch {
    return null
  }
}

/**
 * Resolve what the fleet should be pinned to. `ref` is a tag, branch or sha in
 * the pipeline clone; omitted, it means the newest stable tag there.
 *
 * A ref the clone does not have is the ordinary mistake, not a bug: asking for
 * a version before its release is tagged. Say that, and name the clone that
 * was searched — a raw `git rev-parse` failure with a Node stack reads like
 * the tool itself broke.
 *
 * The version is the tag that was asked for when `ref` is a version tag, a
 * prerelease such as `v5.5.0-beta.1` included: a commit may carry several
 * tags, and the one named is the one the callers should show. For a sha or a
 * branch it is a version tag at that commit, a stable one first.
 */
export async function resolvePipelinePin(
  pipelineClone: string,
  ref: string | undefined,
): Promise<PipelinePin> {
  const wanted = ref ?? (await latestPipelineTag(pipelineClone).then((v) => (v ? `v${v}` : null)))
  if (!wanted) throw new Error(`no stable tag in ${pipelineClone}; pass --pipeline-ref`)
  let sha: string
  try {
    sha = await git(pipelineClone, "rev-parse", "--verify", `${wanted}^{commit}`)
  } catch {
    const latest = await latestPipelineTag(pipelineClone)
    throw new Error(
      `${pipelineClone} has no ${wanted}. It is probably not released yet — merge and tag the release, then fetch. ` +
        (latest
          ? `The newest stable tag there is v${latest}.`
          : "It carries no stable tag at all."),
    )
  }
  const tags = (await git(pipelineClone, "tag", "--points-at", sha, "--sort=-v:refname"))
    .split("\n")
    .filter((t) => VERSION_TAG.test(t))
  const tag = tags.includes(wanted)
    ? wanted
    : (tags.find((t) => STABLE_TAG.test(t)) ?? tags[0] ?? null)
  return { sha, version: tag === null ? null : tag.slice(1) }
}
