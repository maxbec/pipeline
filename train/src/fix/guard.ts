/**
 * What a fix may change. Pure: paths and contents in, a verdict out.
 *
 * An allowlist, not a denylist: a fix may touch only files the pull request
 * itself already changes, and among those nothing that decides whether the
 * pull request passes — CI, hooks, lockfiles, manifests, lint, format and
 * test-runner configuration — and no test in a way that makes it assert less.
 * The rules are mechanical on purpose. They refuse some honest fixes; a
 * refused fix costs a person a look, an accepted bad one costs a green check
 * that means nothing.
 */

export interface FixChange {
  path: string
  /** The file at the head the run failed on; null when it does not exist there. */
  before: string | null
  /** The file as the fix leaves it; null when the fix deletes it. */
  after: string | null
}

export interface GuardInput {
  /** The files the pull request itself changes. */
  prFiles: string[]
  changes: FixChange[]
}

export type GuardResult = { ok: true } | { ok: false; reasons: string[] }

export const MAX_FILES = 20
export const MAX_BYTES = 200 * 1024

const FORBIDDEN_DIRS = [".github", ".trunk", ".husky"]

const LOCKFILES = [
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^bun\.lock/,
  /^uv\.lock$/,
  /^poetry\.lock$/,
  /^Cargo\.lock$/,
]

/** Manifests, and everything that configures a compiler, a linter, a formatter or a test runner. */
const CONFIG = [
  /^package\.json$/,
  /^pyproject\.toml$/,
  /^tsconfig.*\.json$/,
  /^biome\.json/,
  /^\.eslintrc/,
  /^\.eslintignore$/,
  /^eslint\.config\./,
  /^prettier/,
  /^\.prettierrc/,
  /^\.prettierignore$/,
  /^jest\.config\./,
  /^vitest\.config\./,
  /^playwright\.config\./,
  /^pytest\.ini$/,
  /^tox\.ini$/,
  /^setup\.cfg$/,
  /^\.editorconfig$/,
]

const TEST_DIRS = ["test", "tests", "__tests__", "e2e"]
const TEST_NAMES = [/\.test\./, /\.spec\./, /^test_.*\.py$/, /_test\./]

/** In a test file: what turns a test off, or lets it fail unnoticed. */
const SKIP_MARKERS = [
  ".skip",
  ".only",
  ".todo",
  ".fails",
  "skipIf",
  "xit(",
  "xdescribe(",
  "@pytest.mark.skip",
  "@pytest.mark.xfail",
  "t.Skip",
]

/** In any file: what tells a checker to look away. */
const SUPPRESSIONS = [
  "@ts-ignore",
  "@ts-expect-error",
  "@ts-nocheck",
  "eslint-disable",
  "biome-ignore",
  "# noqa",
  "# type: ignore",
  "nolint",
  "istanbul ignore",
  "c8 ignore",
]

/**
 * Obvious secret shapes. A model that read its environment must not be able
 * to ship what it found; the commit job is the last place to stop that.
 */
export const SECRET_SHAPES = [
  /sk-ant-/,
  /ghs_/,
  /ghp_/,
  /github_pat_/,
  /-----BEGIN /,
  /AKIA[0-9A-Z]{16}/,
]

export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPES.some((shape) => shape.test(text))
}

export function isTestFile(path: string): boolean {
  const segments = path.split("/")
  const name = segments.at(-1) ?? ""
  return (
    segments.slice(0, -1).some((s) => TEST_DIRS.includes(s)) || TEST_NAMES.some((p) => p.test(name))
  )
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function assertionLines(text: string): number {
  return text.split("\n").filter((line) => line.includes("assert") || line.includes("expect(")).length
}

function isBinary(text: string): boolean {
  return text.includes("\u0000")
}

function guardPath(path: string): string | null {
  const segments = path.split("/")
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    return `${path || "(empty)"}: not a path inside the repository`
  }
  const name = segments.at(-1) ?? ""
  if (segments.slice(0, -1).some((s) => FORBIDDEN_DIRS.includes(s))) {
    return `${path}: CI, hook and tool configuration is never changed by a fix`
  }
  if (LOCKFILES.some((p) => p.test(name))) return `${path}: a lockfile is never changed by a fix`
  if (CONFIG.some((p) => p.test(name))) {
    return `${path}: manifests and lint, format, build and test configuration are never changed by a fix`
  }
  return null
}

export function guardFix(input: GuardInput): GuardResult {
  const reasons: string[] = []
  const prFiles = new Set(input.prFiles)
  if (input.changes.length > MAX_FILES) {
    reasons.push(`the fix changes ${input.changes.length} files; at most ${MAX_FILES} files are accepted`)
  }

  for (const { path, before, after } of input.changes) {
    const add = (reason: string) => reasons.push(`${path}: ${reason}`)
    if (!prFiles.has(path)) add("the pull request does not change this file")
    const refusedPath = guardPath(path)
    if (refusedPath) reasons.push(refusedPath)
    if (before === null) add("a fix may not create a file")
    if (after === null) add("a fix may not delete a file")
    if ((before !== null && isBinary(before)) || (after !== null && isBinary(after))) {
      add("binary content")
      continue
    }
    if (after === null) continue
    if (Buffer.byteLength(after) > MAX_BYTES) add("larger than 200 KB")
    if (looksLikeSecret(after)) add("the content is shaped like a secret")

    const was = before ?? ""
    const suppressions = SUPPRESSIONS.filter((s) => count(after, s) > count(was, s))
    if (suppressions.length > 0) add(`adds a suppression (${suppressions.join(", ")})`)

    if (isTestFile(path)) {
      if (assertionLines(after) < assertionLines(was)) add("a test file may not lose assertions")
      const markers = SKIP_MARKERS.filter((m) => count(after, m) > count(was, m))
      if (markers.length > 0) add(`adds a skip marker to a test (${markers.join(", ")})`)
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}
