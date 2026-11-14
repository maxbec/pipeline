import { compareVersions, parseVersion } from "./release/semver.ts"

/**
 * The `release:` block of `.github/pipeline.yaml`, as the workflow hands it
 * over: JSON in `TRAIN_RELEASE_CONFIG`, produced by a `yq` step, so the train
 * carries no YAML parser.
 *
 * ```yaml
 * release:
 *   version_files: [package.json]
 *   changelog_show_hidden: false
 *   release_as: 2.0.0   # ignored once a tag at or above it exists
 * ```
 */

export interface ReleaseConfig {
  /** Globs of the files the version is written to. */
  versionFiles: string[]
  /** Tests, build, CI and chores appear in the changelog. */
  changelogShowHidden: boolean
  /** The version to release as instead of the derived one, while it is still ahead. */
  releaseAs: string | null
}

const KEYS = new Set(["version_files", "changelog_show_hidden", "release_as"])

function invalid(key: string, expected: string, value: unknown): Error {
  return new Error(`release.${key} must be ${expected}, not ${JSON.stringify(value)}`)
}

/**
 * @param json the block as JSON; undefined, empty or `null` when the file has none.
 * @param tags every tag of the repository; the ones that are no versions are ignored.
 */
export function parseReleaseConfig(
  json: string | undefined,
  tags: readonly string[],
): ReleaseConfig {
  const config: ReleaseConfig = {
    versionFiles: ["package.json"],
    changelogShowHidden: false,
    releaseAs: null,
  }
  const text = json?.trim() ?? ""
  if (text === "") return config
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `TRAIN_RELEASE_CONFIG is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (raw === null) return config
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`release must be a mapping, not ${JSON.stringify(raw)}`)
  }
  const block = raw as Record<string, unknown>
  for (const key of Object.keys(block)) {
    if (!KEYS.has(key)) throw new Error(`release.${key} is not a key of the release block`)
  }

  const files = block.version_files
  if (files !== undefined && files !== null) {
    if (!Array.isArray(files) || files.some((f) => typeof f !== "string" || f === "")) {
      throw invalid("version_files", "a list of paths", files)
    }
    config.versionFiles = files as string[]
  }

  const hidden = block.changelog_show_hidden
  if (hidden !== undefined && hidden !== null) {
    if (typeof hidden !== "boolean") throw invalid("changelog_show_hidden", "true or false", hidden)
    config.changelogShowHidden = hidden
  }

  const as = block.release_as
  if (as !== undefined && as !== null) {
    if (typeof as !== "string" || parseVersion(as) === null) {
      throw invalid("release_as", 'a version in quotes, like "2.0.0"', as)
    }
    const version = as.trim().replace(/^v/, "")
    const reached = tags.some(
      (tag) => parseVersion(tag) !== null && compareVersions(tag, version) >= 0,
    )
    config.releaseAs = reached ? null : version
  }
  return config
}
