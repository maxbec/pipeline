/**
 * The fleet's own knowledge, kept outside this repository: the deviations
 * from the uniform pattern, one entry per repository that needs one, and two
 * lists the pattern itself reads. The file names private repositories, so it
 * lives with whoever runs the tool and is passed with `--overrides`.
 *
 * ```json
 * {
 *   "repositories": {
 *     "acme/widgets": {
 *       "secrets": { "NPM_TOKEN": "${{ secrets.ACME_NPM_TOKEN }}" },
 *       "renderHook": true,
 *       "extraFiles": { ".github/workflows/extra.yaml": "---\nname: Extra\n" }
 *     }
 *   },
 *   "legacyPaths": ["^\\.oldtool/"],
 *   "singleQuoteTrunkPlugins": ["acme-trunk-plugin"]
 * }
 * ```
 *
 * Every key is optional. An unknown key is refused: a typo would otherwise
 * read as "no override" and render the uniform file over a deviation.
 */
import { readFileSync } from "node:fs"
import type { RepoOverride } from "./migrate.ts"

export interface FleetOverrides {
  /** Keyed `owner/name`. */
  repositories: Record<string, RepoOverride>
  /** Regular expressions over a repository path; a match is deleted like the built-in legacy paths. */
  legacyPaths: RegExp[]
  /** A `.trunk/trunk.yaml` that mentions one of these gets its YAML single-quoted. */
  singleQuoteTrunkPlugins: string[]
}

export const NO_OVERRIDES: FleetOverrides = {
  repositories: {},
  legacyPaths: [],
  singleQuoteTrunkPlugins: [],
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) throw new Error(`${where}: unknown key ${unknown.join(", ")}`)
}

function stringMap(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${where}: expected an object of strings`)
  for (const [k, v] of Object.entries(value))
    if (typeof v !== "string") throw new Error(`${where}.${k}: expected a string`)
  return value as Record<string, string>
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error(`${where}: expected a list of strings`)
  return value as string[]
}

function parseOverride(value: unknown, where: string): RepoOverride {
  if (!isRecord(value)) throw new Error(`${where}: expected an object`)
  onlyKeys(value, ["secrets", "renderHook", "extraFiles"], where)
  const out: RepoOverride = {}
  if (value.secrets !== undefined) out.secrets = stringMap(value.secrets, `${where}.secrets`)
  if (value.renderHook !== undefined) {
    if (typeof value.renderHook !== "boolean")
      throw new Error(`${where}.renderHook: expected true or false`)
    out.renderHook = value.renderHook
  }
  if (value.extraFiles !== undefined) {
    out.extraFiles = stringMap(value.extraFiles, `${where}.extraFiles`)
    for (const [path, contents] of Object.entries(out.extraFiles)) {
      // yamllint's document-start rule runs over the file the tool just wrote,
      // in the repository's own Check.
      if (/\.ya?ml$/.test(path) && !contents.startsWith("---\n"))
        throw new Error(`${where}.extraFiles: ${path} does not start with the document marker`)
    }
  }
  return out
}

/** Validate the parsed JSON of an overrides file. Throws with the place that is wrong. */
export function parseOverrides(value: unknown): FleetOverrides {
  if (!isRecord(value)) throw new Error("overrides: expected an object")
  onlyKeys(value, ["repositories", "legacyPaths", "singleQuoteTrunkPlugins"], "overrides")
  const repositories: Record<string, RepoOverride> = {}
  if (value.repositories !== undefined) {
    if (!isRecord(value.repositories)) throw new Error("overrides.repositories: expected an object")
    for (const [slug, override] of Object.entries(value.repositories)) {
      if (!/^[^/\s]+\/[^/\s]+$/.test(slug))
        throw new Error(`overrides.repositories: ${slug} is not owner/name`)
      repositories[slug] = parseOverride(override, `overrides.repositories.${slug}`)
    }
  }
  const legacyPaths = (
    value.legacyPaths === undefined ? [] : stringList(value.legacyPaths, "overrides.legacyPaths")
  ).map((source) => {
    try {
      return new RegExp(source)
    } catch {
      throw new Error(`overrides.legacyPaths: ${source} is not a regular expression`)
    }
  })
  const singleQuoteTrunkPlugins =
    value.singleQuoteTrunkPlugins === undefined
      ? []
      : stringList(value.singleQuoteTrunkPlugins, "overrides.singleQuoteTrunkPlugins")
  return { repositories, legacyPaths, singleQuoteTrunkPlugins }
}

/** Read and validate an overrides file; no file given is no overrides. */
export function loadOverrides(file: string | undefined): FleetOverrides {
  if (file === undefined) return NO_OVERRIDES
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseOverrides(parsed)
}
