import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RepoRef } from "../../src/github/pr.ts"
import type { Repository, RepositoryKind } from "../../src/types.ts"
import { FakeGitHub, git } from "../workflow/fake-github.ts"
import { repositoryOf } from "./repository.ts"

/**
 * One repository as an entry point meets it: a bare origin behind the fake
 * GitHub, a clone at the path the entry reads history from, and a seed clone
 * the test pushes through, the way people and other jobs push.
 *
 * The origin starts with one commit tagged `v1.2.0` on `main`, and on `dev`
 * too when the repository is major.
 */
export interface World {
  gh: FakeGitHub
  repo: RepoRef
  repository: Repository
  clone: string
  /** A commit straight onto a branch (a merge the test does not care about). Returns its sha. */
  land(subject: string, branch?: string, files?: Record<string, string>): string
  /** A branch cut from `from` with one commit of its own. Returns the head sha. */
  branch(head: string, from: string, files?: Record<string, string>, subject?: string): string
  /** A pull request through the API, as anyone opens one. Returns its number. */
  open(head: string, base: string, title: string): Promise<number>
  /** GitHub's merge button: no title is passed, so GitHub words the commit itself. Returns the merge sha. */
  button(number: number, method: "merge" | "squash"): Promise<string>
}

export function world(home: string, name: string, kind: RepositoryKind = "major"): World {
  const base = kind === "major" ? "dev" : "main"
  const origin = join(home, `${name}.git`)
  git(home, "init", "-q", "--bare", "-b", base, origin)
  const seed = join(home, `${name}-seed`)
  git(home, "clone", "-q", origin, seed)
  writeFileSync(join(seed, "package.json"), '{\n  "name": "demo",\n  "version": "1.2.0"\n}\n')
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "chore: init")
  git(seed, "tag", "v1.2.0")
  git(seed, "push", "-q", "origin", base, "--tags")
  if (kind === "major") git(seed, "push", "-q", "origin", "dev:main")
  const clone = join(home, "clones", name)
  mkdirSync(join(clone, ".."), { recursive: true })
  git(home, "clone", "-q", origin, clone)
  const gh = new FakeGitHub({ origin, owner: "acme", name })
  const repo: RepoRef = { owner: "acme", name }
  const repository = repositoryOf({ owner: "acme", name, kind, path: clone })

  let touched = 0
  const commit = (subject: string, files?: Record<string, string>): string => {
    touched += 1
    const all = files ?? { [`touch-${touched}.txt`]: `${subject}\n` }
    for (const [path, contents] of Object.entries(all)) {
      mkdirSync(join(seed, path, ".."), { recursive: true })
      writeFileSync(join(seed, path), contents)
    }
    git(seed, "add", "-A")
    git(seed, "commit", "-q", "-m", subject)
    return git(seed, "rev-parse", "HEAD")
  }

  return {
    gh,
    repo,
    repository,
    clone,
    land(subject, branch = base, files) {
      git(seed, "fetch", "-q", "origin")
      git(seed, "checkout", "-q", "-B", branch, `origin/${branch}`)
      const sha = commit(subject, files)
      git(seed, "push", "-q", "origin", branch)
      return sha
    },
    branch(head, from, files, subject = `change on ${head}`) {
      git(seed, "fetch", "-q", "origin")
      git(seed, "checkout", "-q", "-B", head, `origin/${from}`)
      const sha = commit(subject, files)
      git(seed, "push", "-q", "--force", "origin", head)
      return sha
    },
    async open(head, into, title) {
      const res = await gh.client.rest<{ number: number }>(
        "POST",
        `/repos/${repo.owner}/${repo.name}/pulls`,
        { body: { head, base: into, title, body: "" } },
      )
      return res.body?.number ?? 0
    },
    async button(number, method) {
      const pull = gh.pulls.get(number)
      const res = await gh.client.rest<{ sha: string }>(
        "PUT",
        `/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`,
        { body: { merge_method: method, sha: gh.sha(pull?.head ?? "") } },
      )
      return res.body?.sha ?? ""
    },
  }
}
