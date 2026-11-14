/**
 * After Claude Code ran: what it changed, and what it said.
 *
 * Runs in the propose job, next to a tree the pull request controls, so it
 * executes nothing from that tree. The commit's files come from `git ls-tree`
 * (the object database only: no hook, no filter, no index refresh) and are
 * compared with the working tree by hashing each file here. `git status` and
 * `git diff` would run whatever clean filter the tree's attributes name.
 *
 * What it writes is a proposal. The commit job trusts none of it.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_BYTES } from "./guard.ts"

export interface CollectedChange {
  path: string
  /** The file's new content; null when it was deleted or cannot be carried. */
  after: string | null
  /** Why a changed file's content is not here. The commit job refuses such a change. */
  unreadable?: string
}

export interface CollectInput {
  /** The checkout of the pull request's head. */
  tree: string
  /** The commit that checkout is at. */
  baseSha: string
  outputDir: string
  /** The file `claude -p --output-format json` wrote; may be missing. */
  claudeOutput: string
  /** Top-level names the job itself put into the tree. */
  ignore?: string[]
}

export const DEFAULT_IGNORE = [".git", ".pipeline", "fix-input", "fix-output"]
const MAX_DIAGNOSIS_LINES = 10
const MAX_DIAGNOSIS_CHARS = 2000

interface TreeEntry {
  mode: string
  oid: string
}

function lsTree(tree: string, sha: string): Map<string, TreeEntry> {
  const out = execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "ls-tree", "-r", "-z", "--full-tree", sha],
    { cwd: tree, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  )
  const entries = new Map<string, TreeEntry>()
  for (const record of out.toString("utf8").split("\0")) {
    if (!record) continue
    const tab = record.indexOf("\t")
    const [mode = "", , oid = ""] = record.slice(0, tab).split(" ")
    entries.set(record.slice(tab + 1), { mode, oid })
  }
  return entries
}

/** The object id git gives a blob; sha256 repositories have 64-character ids. */
function blobOid(content: Buffer, oidLength: number): string {
  return createHash(oidLength === 64 ? "sha256" : "sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex")
}

function walk(root: string, ignore: string[]): Map<string, "file" | "other"> {
  const found = new Map<string, "file" | "other">()
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (!relative && ignore.includes(entry.name)) continue
      // lstat semantics: a symlink is never followed, wherever it points.
      if (entry.isDirectory()) visit(path)
      else found.set(path, entry.isFile() ? "file" : "other")
    }
  }
  visit("")
  return found
}

export function collectChanges(tree: string, baseSha: string, ignore = DEFAULT_IGNORE): CollectedChange[] {
  const committed = lsTree(tree, baseSha)
  const present = walk(tree, ignore)
  const changes: CollectedChange[] = []

  for (const [path, entry] of committed) {
    if (ignore.includes(path.split("/")[0] ?? "")) continue
    // A submodule is a commit, not content; a tracked symlink is left as it is.
    if (entry.mode === "160000") continue
    const kind = present.get(path)
    if (entry.mode === "120000") {
      if (kind === "file") changes.push({ path, after: null, unreadable: "not a regular file" })
      continue
    }
    if (kind === undefined) {
      // A directory in the file's place is as gone as nothing at all.
      let gone = true
      try {
        gone = !lstatSync(join(tree, path)).isFile()
      } catch {}
      if (gone) changes.push({ path, after: null })
      continue
    }
    if (kind === "other") {
      changes.push({ path, after: null, unreadable: "not a regular file" })
      continue
    }
    const content = readFileSync(join(tree, path))
    if (blobOid(content, entry.oid.length) === entry.oid) continue
    // A checkout with `eol=crlf` holds CRLF where the commit holds LF.
    const lf = Buffer.from(content.toString("latin1").replaceAll("\r\n", "\n"), "latin1")
    if (blobOid(lf, entry.oid.length) === entry.oid) continue
    changes.push(carry(path, content))
  }

  for (const [path, kind] of present) {
    if (committed.has(path)) continue
    if (kind === "other") changes.push({ path, after: null, unreadable: "not a regular file" })
    else changes.push(carry(path, readFileSync(join(tree, path))))
  }
  return changes
}

function carry(path: string, content: Buffer): CollectedChange {
  if (content.length > MAX_BYTES) return { path, after: null, unreadable: "larger than 200 KB" }
  const text = content.toString("utf8")
  if (content.includes(0) || !Buffer.from(text, "utf8").equals(content)) {
    return { path, after: null, unreadable: "binary" }
  }
  return { path, after: text }
}

const NO_RESULT = "Claude Code left no result: the run failed, timed out or was never started.\n"

/**
 * The diagnosis out of Claude Code's JSON result: the lines after
 * `DIAGNOSIS:`, at most ten. A run that ended in an error — out of turns, out
 * of quota, not signed in — says so instead.
 */
export function extractDiagnosis(raw: string | null): string {
  if (raw === null) return NO_RESULT
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return NO_RESULT
  }
  // `--verbose` turns the output into an array whose last element is the result.
  const result = (Array.isArray(parsed) ? parsed.findLast((m) => m?.type === "result") : parsed) as {
    result?: unknown
    is_error?: unknown
    subtype?: unknown
  } | null
  if (!result || typeof result !== "object") return NO_RESULT
  const text = typeof result.result === "string" ? result.result : ""
  if (result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success")) {
    const what = [typeof result.subtype === "string" ? result.subtype : "", clip(text, 3)].filter(Boolean).join(": ")
    return `Claude Code did not finish (${what || "no reason given"}).\n`
  }
  if (!text.trim()) return NO_RESULT
  const at = text.lastIndexOf("DIAGNOSIS:")
  return `${clip(at === -1 ? text : text.slice(at + "DIAGNOSIS:".length), MAX_DIAGNOSIS_LINES)}\n`
}

function clip(text: string, lines: number): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(0, lines)
    .join("\n")
    .slice(0, MAX_DIAGNOSIS_CHARS)
}

export function collect(input: CollectInput): { changes: number } {
  const changes = collectChanges(input.tree, input.baseSha, input.ignore)
  let raw: string | null = null
  try {
    raw = readFileSync(input.claudeOutput, "utf8")
  } catch {}
  mkdirSync(input.outputDir, { recursive: true })
  writeFileSync(join(input.outputDir, "changes.json"), JSON.stringify(changes))
  writeFileSync(join(input.outputDir, "diagnosis.txt"), extractDiagnosis(raw))
  return { changes: changes.length }
}
