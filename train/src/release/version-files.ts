/**
 * Version rule 9: the version lands in package.json (all listed workspace
 * packages), a plain version file, or a `version = "…"` line. The edit is a
 * targeted replacement so the file's formatting survives — a JSON round trip
 * would rewrite every package.json in the repository's own style.
 */

const JSON_VERSION_RE = /^(\s*"version"\s*:\s*")[^"]*(")/m
const SEMVER_RE = /\d+\.\d+\.\d+(?:-[A-Za-z][A-Za-z0-9]*(?:\.\d+)?)?/
const PLAIN_FILE_RE = /^\s*v?\d+\.\d+\.\d+(?:-[A-Za-z][A-Za-z0-9]*(?:\.\d+)?)?\s*$/
const ASSIGNMENT_LINE_RE =
  /^([^\n]*\bversion\b[^\n]*?)(\d+\.\d+\.\d+(?:-[A-Za-z][A-Za-z0-9]*(?:\.\d+)?)?)/im

export function applyVersion(path: string, content: string, version: string): string {
  if (path.endsWith(".json")) {
    if (!JSON_VERSION_RE.test(content)) throw new Error(noVersionKey(path, content))
    return content.replace(JSON_VERSION_RE, `$1${version}$2`)
  }
  if (PLAIN_FILE_RE.test(content)) {
    return content.replace(SEMVER_RE, version)
  }
  if (!ASSIGNMENT_LINE_RE.test(content)) throw new Error(`${path}: no version line`)
  return content.replace(ASSIGNMENT_LINE_RE, `$1${version}`)
}

/**
 * Why the version could not be written, said in the terms that fix it.
 *
 * The default `versionFiles` glob is `package.json` and `globToRegExp` anchors
 * it, so in a monorepo the root is the *only* file it matches — and a workspace
 * root is usually never published and carries no version. A bare
 * `package.json: no version key` is true there and says nothing about the way
 * out.
 *
 * The way out is always configuration, never a version invented here. Writing
 * one into a file the operator did not name would be the release lying about
 * where its version lives; skipping the file silently would be worse, because
 * the tag would move while every package still declared the old one, and a
 * package.json version is what a service reports about itself.
 */
function noVersionKey(path: string, content: string): string {
  const head = `${path}: no version key`
  const configure =
    "set the repository's versionFiles to the files that do carry one" +
    ' (a monorepo usually wants "apps/*/package.json" and "packages/*/package.json"),' +
    " or set it empty to release with the tag and CHANGELOG only"
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return `${head} (and the file does not parse as JSON — check the versionFiles glob points at the files you mean)`
  }
  const object =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  // The key is there, just not where the writer can see it: the replacement is
  // line-anchored so the file's own formatting survives, and a one-line
  // package.json has no line to anchor to.
  if (object && "version" in object) {
    return `${head} on a line of its own — the version is written by a targeted replacement so the file's formatting survives, which a single-line JSON file defeats. Reformat it, or point versionFiles elsewhere.`
  }
  // Private is a hint, not the cause: this repository's own workspace packages
  // are private *and* versioned. It is worth saying because the file that
  // usually reaches here is a never-published workspace root.
  if (object?.private) {
    return `${head}. A never-published workspace root carries none, which is what this file looks like — ${configure}`
  }
  return `${head} — ${configure}`
}
