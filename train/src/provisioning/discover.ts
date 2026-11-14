/**
 * Find the local clones the fleet tool works on:
 * `<home>/companies/<company>/repos/<repo>`, one directory per owner group.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Repository } from "../types.ts"

/** A clone of this name holds documentation: no workflow, no releases. */
export const DOCS_REPOSITORY = "docs"

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
  } catch {
    return null
  }
}

/**
 * The owner and name of a **github.com** remote, or null.
 *
 * Only `git@github.com:owner/name[.git]`, `ssh://git@github.com/owner/name`,
 * `git://github.com/owner/name` and `https://github.com/owner/name[.git]` are
 * repositories. Taking the last two path segments of any remote would turn a
 * local clone at `~/origins/greeter` into owner `origins`, name `greeter` — a
 * repository whose GitHub calls could only ever 404. A host that merely ends
 * in `github.com` (`github.example.com`) is not github.com either.
 *
 * Scheme and host are matched case-insensitively, as URLs are. The path is
 * left alone — GitHub keeps the case an owner and a repository were created
 * with.
 */
export function parseOwnerName(remote: string): { owner: string; name: string } | null {
  const trimmed = remote.trim()
  const scp = /^(?:[^@/]+@)?github\.com:(?!\/)(.+)$/i.exec(trimmed)
  let path: string | null = scp?.[1] ?? null
  if (path === null) {
    const url = /^(?:https|ssh|git\+ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/(.+)$/i.exec(
      trimmed,
    )
    path = url?.[1] ?? null
  }
  if (path === null) return null
  const m = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(path)
  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : null
}

/** A remote as it may be printed: with any userinfo taken out. */
export function redactRemote(remote: string): string {
  return remote.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, "$1***@")
}

export interface DiscoverOptions {
  /** Defaults to the user's home directory. */
  home?: string
  /** The directories under `<home>/companies` to look in; defaults to every one of them. */
  companies?: string[]
  log?: (line: string) => void
}

/**
 * The clones under `<home>/companies/<company>/repos`.
 *
 * The kind is derived from the remote, never from the local branch list: a
 * clone that happens to have a local `dev` is still a small repository if
 * `origin` has none.
 */
export function discoverRepositories(opts: DiscoverOptions = {}): Repository[] {
  const home = opts.home ?? homedir()
  const log = opts.log ?? ((line: string) => console.warn(line))
  const root = join(home, "companies")
  const companies =
    opts.companies && opts.companies.length > 0
      ? opts.companies
      : existsSync(root)
        ? readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
        : []
  const found: Repository[] = []
  for (const company of companies) {
    const reposDir = join(root, company, "repos")
    if (!existsSync(reposDir)) continue
    const entries = readdirSync(reposDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === DOCS_REPOSITORY) continue
      const path = join(reposDir, entry.name)
      if (!existsSync(join(path, ".git"))) continue
      const remote = git(path, "remote", "get-url", "origin")
      const parsed = remote ? parseOwnerName(remote) : null
      if (!parsed) {
        // Skipped loudly: a clone that cannot be reached on GitHub is one the
        // operator has to know about, not one that silently goes missing.
        log(
          `repositories: skipped ${path}: origin ${
            remote ? redactRemote(remote) : "(none)"
          } is not a github.com remote`,
        )
        continue
      }
      const hasDev = git(path, "rev-parse", "--verify", "-q", "refs/remotes/origin/dev") !== null
      found.push({
        id: `${company}-${parsed.name}`,
        company,
        owner: parsed.owner,
        name: parsed.name,
        kind: hasDev ? "major" : "small",
        path,
        dependabotMergeEnabled: false,
        versionFiles: ["package.json"],
        changelogShowHidden: false,
      })
    }
  }
  return found
}
