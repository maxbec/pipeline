import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { GitHubClient } from "../../src/github/client.ts"
import { scratchDir } from "../helpers/scratch.ts"

/**
 * A GitHub that is a bare git repository plus a little state.
 *
 * Every write the workflow makes — a branch ref, a signed commit through
 * `createCommitOnBranch`, a squash merge, an update-branch — really moves a
 * ref in the bare origin, so the worktree's fetches and resets see what the
 * real GitHub would give them. Reads (`PR_STATE_QUERY`, review threads,
 * pulls) are answered from the state. Checks are whatever the test sets.
 */

const GIT_IDENTITY = [
  "-c",
  "user.email=t@t",
  "-c",
  "user.name=t",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
]

export function git(cwd: string, ...args: (string | { binary: true })[]): string
export function git(cwd: string, ...args: string[]): string
export function git(cwd: string, ...args: (string | { binary: true })[]): string | Buffer {
  const last = args.at(-1)
  const binary = typeof last === "object"
  const argv = (binary ? args.slice(0, -1) : args) as string[]
  const out = execFileSync("git", [...GIT_IDENTITY, "-C", cwd, ...argv], {
    encoding: binary ? "buffer" : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return binary ? (out as Buffer) : String(out).trim()
}

/** `git` with stdin and environment: plumbing that builds objects. */
function gitWith(
  cwd: string,
  opts: { input?: Buffer | string; env?: NodeJS.ProcessEnv },
  ...args: string[]
): string {
  const out = execFileSync("git", [...GIT_IDENTITY, "-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    input: opts.input,
    stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  })
  return String(out).trim()
}

export interface FakePull {
  number: number
  title: string
  body: string
  head: string
  base: string
  state: "open" | "closed"
  merged: boolean
  mergeSha: string | null
  reviews: { id: number; body: string }[]
  threads: FakeThread[]
  /** Who opened it, as REST spells it (`dependabot[bot]`); defaults to `octocat`. */
  author?: string
  /** Every commit of the PR, oldest first; defaults to the signed head alone. The last one *is* the head. */
  commitLog?: FakeCommit[]
  /** The head's own signature; defaults to the last commit of `commitLog`. */
  headSigned?: boolean
  /** Check contexts on the head beyond the one `checks` drives. */
  contexts?: FakeContext[]
  /** The base branch's protection, as `baseRef` reports it; defaults to none. */
  baseRule?: {
    requiredStatusCheckContexts: string[]
    requiresSignatures: boolean
  }
  labels?: string[]
  draft?: boolean
  /** `owner/name` of the head's repository when it is a fork; null when the fork is gone. */
  headRepo?: string | null
  /** Who merged it, as `GET /pulls/{n}` reports `merged_by`; set by the merge from `mergeActor`. */
  mergedBy?: { login: string; type: "User" | "Bot" }
  /** The conversation: `POST /issues/{n}/comments` on a pull request lands here. */
  comments?: { author: string; body: string }[]
  /** The head as it was when the pull request closed; GitHub keeps reporting that one. */
  closedHeadSha?: string
}

export interface FakeCommit {
  oid: string
  headline: string
  signed: boolean
  /** The message after its first line; Dependabot's `update-type` lines live here. */
  body?: string
}

export interface FakeContext {
  name: string
  status: string
  conclusion: string | null
}

export interface FakeThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number
  comments: { author: string; body: string }[]
}

export interface FakeIssue {
  number: number
  title: string
  body: string
  labels: string[]
  state: "open" | "closed"
  comments: { author: string; body: string }[]
}

export interface FakeRelease {
  id: number
  tag: string
  name: string
  body: string
  prerelease: boolean
  targetCommitish: string
}

export interface RecordedCommit {
  branch: string
  message: { headline: string; body: string }
  additions: string[]
  deletions: string[]
}

export interface Call {
  method: string
  path: string
  body: unknown
}

export class FakeGitHub {
  readonly origin: string
  readonly owner: string
  readonly name: string
  readonly client: GitHubClient
  readonly calls: Call[] = []
  readonly commits: RecordedCommit[] = []
  readonly pulls = new Map<number, FakePull>()
  readonly issues = new Map<number, FakeIssue>()
  readonly releases: FakeRelease[] = []
  /** What every head's checks report. Tests flip it to simulate CI. */
  checks: "success" | "pending" | "failure" = "success"
  /**
   * How many of the next requests never reach GitHub: each rejects the way
   * undici does on an outbound connect timeout. Counts itself down.
   */
  unreachable = 0
  /**
   * How many of the next PR state reads answer `mergeable: UNKNOWN`, the way
   * GitHub does while it recomputes after the base moved. Counts itself down.
   */
  unknownReads = 0
  /** The context every head reports under; a repository not on the pipeline yet reports another. */
  checkName = "pipeline / Check"
  /** GitHub's page size on GraphQL connections; the PR state query pages at it. */
  readonly pageSize = 100
  /** Check runs on a bare ref (a base branch), keyed by sha. */
  /** "none": no check run on the commit yet — its workflow has not reached Check. */
  readonly refChecks = new Map<string, "success" | "pending" | "failure" | "none">()
  /**
   * Called after a PR merges, with the commit it made: a test sets the push
   * run that commit gets on its base (`refChecks`) here.
   */
  onMerged: ((pull: FakePull, sha: string) => void) | null = null
  /** Several runs of `pipeline / Check` on one commit, oldest first; wins over refChecks. */
  readonly refCheckRuns = new Map<string, { status: string; conclusion: string | null }[]>()
  /** What `GET /repos/{o}/{r}` reports; `PATCH` merges into it. */
  readonly settings: Record<string, unknown> = {
    archived: false,
    private: true,
    default_branch: "dev",
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: false,
    delete_branch_on_merge: false,
    squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
    squash_merge_commit_message: "COMMIT_MESSAGES",
  }
  /** Classic branch protection, keyed by branch: only the status-check part is modelled. */
  readonly protection = new Map<string, { strict: boolean; contexts: string[] }>()
  /** Repository rulesets, as `GET /rulesets/{id}` returns them. */
  readonly rulesets: Record<string, unknown>[] = []
  /** Repository Actions variables by name. */
  readonly variables = new Map<string, string>()
  /** Actions runs by id, as `GET /actions/runs/{id}` answers; a rerun of its failed jobs starts the next attempt. */
  readonly workflowRuns = new Map<
    number,
    { run_attempt: number; status: string; conclusion: string | null }
  >()
  /** The runs `POST /actions/runs/{id}/rerun-failed-jobs` was called for, in order. */
  readonly reruns: number[] = []
  /** Status every rerun answers instead, when set (an App with `actions: read` only). */
  rerunFailure: number | null = null
  /** Files the default branch (`HEAD:`) holds for GraphQL `object(expression:)`; not the bare origin's tree. */
  readonly files = new Map<string, string>()
  /**
   * The owner's usage report by `YYYY-MM`, as `usageItems`; a number is the
   * status GitHub answers instead (403: the App lacks the permission).
   */
  readonly billing = new Map<string, Record<string, unknown>[] | number>()
  /** The owner's public repositories, as `GET /orgs/{owner}/repos?type=public` lists them; a number is the status it answers instead. */
  publicRepos: string[] | number = []
  /** What `GET /users/{owner}` says the owner is. */
  ownerType: "User" | "Organization" = "Organization"
  /** Status the next variable writes answer with instead of succeeding. */
  variableWriteStatus: number | null = null
  /** The repository's labels; `POST /labels` adds one, 422 when it exists. */
  readonly labels = new Set<string>()
  /** Status every `POST /labels` answers instead, when set (a missing permission). */
  labelFailure: number | null = null
  /** Status every issue search answers instead, when set (search's own rate limit). */
  searchFailure: number | null = null
  /** Status every `POST /issues` answers instead, when set (Issues: write missing). */
  issueCreateFailure: number | null = null
  /** Who the next `PUT /pulls/{n}/merge` is made by: a person, unless a test says the train's App. */
  mergeActor: { login: string; type: "User" | "Bot" } = { login: "octocat", type: "User" }
  /**
   * Commits GitHub made itself and therefore signed: `createCommitOnBranch`,
   * a merge through the API, a Git Data commit (as on an App token). Anything
   * a test pushed with plain git is unverified, as it would be.
   */
  readonly signed = new Set<string>()
  #nextPull = 1
  #nextThread = 1
  #nextReview = 1

  constructor(opts: { origin: string; owner: string; name: string }) {
    this.origin = opts.origin
    this.owner = opts.owner
    this.name = opts.name
    this.client = new GitHubClient({
      tokens: { token: async () => "fake" },
      fetch: (input, init) => this.#fetch(input, init),
    })
  }

  sha(ref: string): string | null {
    try {
      return git(this.origin, "rev-parse", "--verify", "-q", `refs/heads/${ref}`)
    } catch {
      return null
    }
  }

  tagSha(tag: string): string | null {
    try {
      return git(this.origin, "rev-parse", "--verify", "-q", `refs/tags/${tag}^{commit}`)
    } catch {
      return null
    }
  }

  openThreads(number: number): FakeThread[] {
    return (this.pulls.get(number)?.threads ?? []).filter((t) => !t.isResolved && !t.isOutdated)
  }

  addIssue(issue: Omit<FakeIssue, "comments" | "state"> & Partial<FakeIssue>): FakeIssue {
    const full: FakeIssue = { state: "open", comments: [], ...issue }
    this.issues.set(full.number, full)
    return full
  }

  // ---- the wire -----------------------------------------------------------

  /** The same dispatcher as `client` uses, for serving this fake over HTTP. */
  handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return this.#fetch(input, init)
  }

  async #fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    )
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const path = url.pathname + url.search
    if (this.unreachable > 0) {
      this.unreachable -= 1
      const cause = Object.assign(new Error("Connect Timeout Error"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      })
      throw new TypeError("fetch failed", { cause })
    }
    this.calls.push({ method, path, body })
    try {
      if (url.pathname === "/graphql") return this.#json(200, { data: this.#graphql(body) })
      if (url.pathname === "/search/issues") return this.#searchIssues(url.searchParams)
      return this.#rest(method, url, body)
    } catch (error) {
      const e = error as { status?: number; message: string }
      return this.#json(e.status ?? 500, { message: e.message })
    }
  }

  #json(status: number, payload: unknown): Response {
    return new Response(status === 204 ? null : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
    })
  }

  #rest(method: string, url: URL, body: Record<string, unknown> | undefined): Response {
    if (
      method === "GET" &&
      url.pathname === `/organizations/${this.owner}/settings/billing/usage`
    ) {
      const key = `${url.searchParams.get("year")}-${String(url.searchParams.get("month")).padStart(2, "0")}`
      const usage = this.billing.get(key) ?? []
      if (typeof usage === "number") throw fail(usage, "Resource not accessible by integration")
      return this.#json(200, { usageItems: usage })
    }
    if (method === "GET" && url.pathname === `/orgs/${this.owner}/repos`) {
      if (typeof this.publicRepos === "number") throw fail(this.publicRepos, "Server Error")
      const per = Number(url.searchParams.get("per_page") ?? 30)
      const page = Number(url.searchParams.get("page") ?? 1)
      const names = url.searchParams.get("type") === "public" ? this.publicRepos : []
      return this.#json(
        200,
        names.slice((page - 1) * per, page * per).map((name) => ({ name, private: false })),
      )
    }
    if (method === "GET" && url.pathname === `/users/${this.owner}`) {
      return this.#json(200, { login: this.owner, type: this.ownerType })
    }
    const prefix = `/repos/${this.owner}/${this.name}`
    if (!url.pathname.startsWith(prefix)) throw fail(404, `not this repository: ${url.pathname}`)
    const rest = url.pathname.slice(prefix.length)
    const parts = rest.split("/").filter(Boolean)
    const q = url.searchParams

    // Actions variables: what the Runner Switch reads and writes.
    if (parts[0] === "actions" && parts[1] === "variables") {
      const name = parts[2] ? decodeURIComponent(parts[2]) : undefined
      if (method === "GET" && name) {
        const value = this.variables.get(name)
        if (value === undefined) throw fail(404, "Not Found")
        return this.#json(200, { name, value })
      }
      if ((method === "POST" && !name) || (method === "PATCH" && name)) {
        if (this.variableWriteStatus !== null) {
          throw fail(this.variableWriteStatus, "Resource not accessible by integration")
        }
        const key = name ?? String(body?.name)
        if (method === "POST" && this.variables.has(key)) throw fail(409, "Already exists")
        if (method === "PATCH" && !this.variables.has(key)) throw fail(404, "Not Found")
        this.variables.set(key, String(body?.value))
        return this.#json(method === "POST" ? 201 : 204, {})
      }
    }

    // Actions runs: what the Fix Task on a Release PR reads and reruns.
    if (parts[0] === "actions" && parts[1] === "runs" && parts[2]) {
      const id = Number(parts[2])
      const run = this.workflowRuns.get(id)
      if (!run) throw fail(404, "Not Found")
      if (method === "GET" && parts.length === 3) return this.#json(200, { id, ...run })
      if (method === "POST" && parts[3] === "rerun-failed-jobs") {
        if (this.rerunFailure)
          throw fail(this.rerunFailure, "Resource not accessible by integration")
        if (run.status !== "completed") throw fail(403, "This workflow is already running")
        this.reruns.push(id)
        run.run_attempt += 1
        run.status = "queued"
        run.conclusion = null
        return this.#json(201, {})
      }
    }

    // Git Data: what a two-parent commit takes (the backmerge's resolved merge).
    if (method === "POST" && rest === "/git/blobs") {
      const content =
        body?.encoding === "base64"
          ? Buffer.from(String(body?.content), "base64")
          : Buffer.from(String(body?.content ?? ""), "utf8")
      const sha = gitWith(this.origin, { input: content }, "hash-object", "-w", "--stdin")
      return this.#json(201, { sha })
    }
    if (method === "POST" && rest === "/git/trees") {
      const base = body?.base_tree === undefined ? null : String(body.base_tree)
      const entries = (body?.tree ?? []) as {
        path: string
        mode: string
        type: string
        sha?: string | null
        content?: string
      }[]
      // Like GitHub: an empty tree list is refused, base_tree or not.
      if (entries.length === 0) throw fail(422, "Invalid tree info")
      const dir = scratchDir("train-fake-index-")
      try {
        const env = { GIT_INDEX_FILE: join(dir, "index") }
        if (base) gitWith(this.origin, { env }, "read-tree", base)
        else gitWith(this.origin, { env }, "read-tree", "--empty")
        for (const e of entries) {
          if (e.sha === null) {
            gitWith(this.origin, { env }, "update-index", "--force-remove", e.path)
            continue
          }
          const sha =
            e.sha ??
            gitWith(this.origin, { input: String(e.content ?? "") }, "hash-object", "-w", "--stdin")
          gitWith(
            this.origin,
            { env },
            "update-index",
            "--add",
            "--cacheinfo",
            `${e.mode},${sha},${e.path}`,
          )
        }
        const sha = gitWith(this.origin, { env }, "write-tree")
        return this.#json(201, { sha })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    if (method === "POST" && rest === "/git/commits") {
      const parents = (body?.parents ?? []) as string[]
      const args = ["commit-tree", String(body?.tree)]
      for (const p of parents) args.push("-p", p)
      const sha = gitWith(this.origin, { input: String(body?.message ?? "") }, ...args)
      this.signed.add(sha)
      return this.#json(201, { sha })
    }

    // refs
    if (method === "GET" && rest.startsWith("/git/ref/heads/")) {
      const branch = decodeURIComponent(rest.slice("/git/ref/heads/".length))
      const sha = this.sha(branch)
      if (!sha) throw fail(404, "Not Found")
      return this.#json(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } })
    }
    if (method === "GET" && rest.startsWith("/git/ref/tags/")) {
      const tag = decodeURIComponent(rest.slice("/git/ref/tags/".length))
      const sha = this.tagSha(tag)
      if (!sha) throw fail(404, "Not Found")
      return this.#json(200, { ref: `refs/tags/${tag}`, object: { sha, type: "commit" } })
    }
    if (method === "POST" && rest === "/git/refs") {
      const ref = String(body?.ref)
      const exists = ref.startsWith("refs/tags/")
        ? this.tagSha(ref.slice("refs/tags/".length))
        : this.sha(ref.replace(/^refs\/heads\//, ""))
      if (exists) throw fail(422, "Reference already exists")
      const full = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`
      git(this.origin, "update-ref", full, String(body?.sha))
      return this.#json(201, { ref: full })
    }
    if (method === "PATCH" && rest.startsWith("/git/refs/heads/")) {
      const branch = decodeURIComponent(rest.slice("/git/refs/heads/".length))
      const current = this.sha(branch)
      if (!current) throw fail(422, "Reference does not exist")
      const target = String(body?.sha)
      if (!body?.force) {
        try {
          git(this.origin, "merge-base", "--is-ancestor", current, target)
        } catch {
          throw fail(422, "Update is not a fast forward")
        }
      }
      git(this.origin, "update-ref", `refs/heads/${branch}`, target)
      // GitHub closes a PR the moment its head has no commits over its base.
      for (const pull of this.pulls.values()) {
        if (pull.state === "open" && pull.head === branch && this.sha(pull.base) === target) {
          pull.state = "closed"
        }
      }
      return this.#json(200, { ref: `refs/heads/${branch}`, object: { sha: target } })
    }

    // releases
    if (method === "GET" && parts[0] === "releases" && parts[1] === "tags") {
      const tag = decodeURIComponent(parts[2] ?? "")
      const release = this.releases.find((r) => r.tag === tag)
      if (!release) throw fail(404, "Not Found")
      return this.#json(200, this.#releaseJson(release))
    }
    if (method === "POST" && rest === "/releases") {
      const tag = String(body?.tag_name)
      if (this.releases.some((r) => r.tag === tag)) throw fail(422, "already_exists")
      if (!this.tagSha(tag)) {
        // GitHub creates the tag from target_commitish when it is missing.
        git(this.origin, "update-ref", `refs/tags/${tag}`, String(body?.target_commitish))
      }
      const release: FakeRelease = {
        id: this.releases.length + 1,
        tag,
        name: String(body?.name ?? tag),
        body: String(body?.body ?? ""),
        prerelease: Boolean(body?.prerelease),
        targetCommitish: String(body?.target_commitish ?? ""),
      }
      this.releases.push(release)
      return this.#json(201, this.#releaseJson(release))
    }
    if (method === "DELETE" && rest.startsWith("/git/refs/heads/")) {
      const branch = decodeURIComponent(rest.slice("/git/refs/heads/".length))
      if (!this.sha(branch)) throw fail(422, "Reference does not exist")
      git(this.origin, "update-ref", "-d", `refs/heads/${branch}`)
      return this.#json(204, null)
    }

    // pulls
    if (method === "GET" && parts[0] === "pulls" && parts.length === 1) {
      const head = q.get("head")?.split(":")[1]
      const base = q.get("base")
      const state = q.get("state") ?? "open"
      const list = [...this.pulls.values()]
        .filter(
          (p) =>
            (!head || p.head === head) &&
            (!base || p.base === base) &&
            (state === "all" || state === p.state),
        )
        .sort((a, b) => (q.get("direction") === "desc" ? b.number - a.number : a.number - b.number))
      const page = Number(q.get("page") ?? "1")
      const per = Number(q.get("per_page") ?? "30")
      return this.#json(
        200,
        // The list leaves `merged` and `merged_by` out, like the real one: only `merged_at` says it.
        list.slice((page - 1) * per, page * per).map((p) => {
          const { merged: _merged, merged_by: _by, ...listed } = this.#pullJson(p)
          return listed
        }),
      )
    }
    if (method === "POST" && parts[0] === "pulls" && parts.length === 1) {
      const head = String(body?.head)
      if (!this.sha(head)) throw fail(422, `head ${head} does not exist`)
      const pull: FakePull = {
        number: this.#nextPull++,
        title: String(body?.title),
        body: String(body?.body ?? ""),
        head,
        base: String(body?.base),
        state: "open",
        merged: false,
        mergeSha: null,
        reviews: [],
        threads: [],
      }
      this.pulls.set(pull.number, pull)
      return this.#json(201, this.#pullJson(pull))
    }
    const pull = parts[0] === "pulls" ? this.pulls.get(Number(parts[1])) : undefined
    if (parts[0] === "pulls" && !pull) throw fail(404, "Not Found")
    if (pull && method === "GET" && parts.length === 2) return this.#json(200, this.#pullJson(pull))
    if (pull && method === "PATCH" && parts.length === 2) {
      if (typeof body?.title === "string") pull.title = body.title
      if (typeof body?.body === "string") pull.body = body.body
      if (body?.state === "closed" && !pull.merged && pull.state === "open") {
        pull.state = "closed"
        pull.closedHeadSha = this.sha(pull.head) ?? undefined
      }
      if (body?.state === "open" && !pull.merged) {
        if (this.sha(pull.head) === this.sha(pull.base))
          throw fail(422, "no commits between base and head")
        pull.state = "open"
        delete pull.closedHeadSha
      }
      return this.#json(200, this.#pullJson(pull))
    }
    if (pull && method === "PUT" && parts[2] === "merge") {
      const headSha = this.sha(pull.head)
      if (String(body?.sha) !== headSha) throw fail(409, "Head branch was modified")
      if (pull.merged || pull.state !== "open") throw fail(405, "Pull Request is not mergeable")
      if (this.conflicts(this.sha(pull.base) ?? "", headSha ?? ""))
        throw fail(405, "Pull Request is not mergeable")
      if (body?.merge_method !== "squash" && body?.merge_method !== "merge")
        throw fail(405, "only squash and merge commits here")
      const sha =
        body.merge_method === "merge"
          ? this.#mergeCommit(
              pull,
              String(body?.commit_title ?? `Merge pull request #${pull.number}`),
            )
          : this.#squashMerge(pull, String(body?.commit_title ?? pull.title))
      pull.merged = true
      pull.state = "closed"
      pull.mergeSha = sha
      pull.closedHeadSha = headSha ?? undefined
      pull.mergedBy = { ...this.mergeActor }
      this.signed.add(sha)
      this.onMerged?.(pull, sha)
      return this.#json(200, { sha, merged: true, message: "Pull Request successfully merged" })
    }
    if (pull && method === "PUT" && parts[2] === "update-branch") {
      if (String(body?.expected_head_sha) !== this.sha(pull.head)) throw fail(422, "head moved")
      if (this.conflicts(this.sha(pull.base) ?? "", this.sha(pull.head) ?? ""))
        throw fail(422, "merge conflict between base and head")
      this.#mergeBaseIntoHead(pull)
      return this.#json(202, { message: "Updating pull request branch." })
    }
    if (pull && method === "GET" && parts[2] === "files") {
      const changed = git(this.origin, "diff", "--name-status", "-M", `${pull.base}...${pull.head}`)
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [status = "", first = "", second] = line.split("\t")
          return status.startsWith("R")
            ? { filename: second ?? first, previous_filename: first, status: "renamed" }
            : {
                filename: first,
                status: status === "A" ? "added" : status === "D" ? "removed" : "modified",
              }
        })
      const page = Number(q.get("page") ?? "1")
      const per = Number(q.get("per_page") ?? "30")
      return this.#json(200, changed.slice((page - 1) * per, page * per))
    }
    if (pull && method === "POST" && parts[2] === "reviews") {
      const comments = (body?.comments as { path: string; line: number; body: string }[]) ?? []
      // GitHub answers 422 to a comment on a path the diff does not touch.
      const touched = new Set(
        git(this.origin, "diff", "--name-only", `${pull.base}...${pull.head}`).split("\n"),
      )
      const outside = comments.find((c) => !touched.has(c.path))
      if (outside) throw fail(422, `Unprocessable Entity: ${outside.path} is not part of the diff`)
      const review = { id: this.#nextReview++, body: String(body?.body ?? "") }
      pull.reviews.push(review)
      for (const c of comments) {
        pull.threads.push({
          id: `T${this.#nextThread++}`,
          isResolved: false,
          isOutdated: false,
          path: c.path,
          line: c.line,
          comments: [{ author: `train-${this.owner}[bot]`, body: c.body }],
        })
      }
      return this.#json(200, { id: review.id })
    }

    // issues
    if (method === "GET" && parts[0] === "issues" && parts.length === 1) {
      const labels = (q.get("labels") ?? "").split(",").filter(Boolean)
      const state = q.get("state") ?? "open"
      const list = [...this.issues.values()].filter(
        (i) => (state === "all" || i.state === state) && labels.every((l) => i.labels.includes(l)),
      )
      // Paged, like the comments below and like the real thing. An unpaged
      // fake made "the caller reads every issue" untestable: a caller that
      // only ever asked for the first hundred looked correct against it.
      const page = Number(q.get("page") ?? "1")
      const per = Number(q.get("per_page") ?? "30")
      return this.#json(
        200,
        list.slice((page - 1) * per, page * per).map((i) => this.#issueJson(i)),
      )
    }
    if (method === "POST" && rest === "/labels") {
      if (this.labelFailure !== null)
        throw fail(this.labelFailure, "Resource not accessible by integration")
      const name = String(body?.name)
      if (this.labels.has(name)) throw fail(422, "Validation Failed")
      this.labels.add(name)
      return this.#json(201, { name })
    }
    if (method === "POST" && parts[0] === "issues" && parts.length === 1) {
      if (this.issueCreateFailure !== null) {
        throw fail(this.issueCreateFailure, "Resource not accessible by integration")
      }
      // Issues and pulls share one sequence on GitHub.
      const number =
        Math.max(0, ...this.issues.keys(), ...this.pulls.keys(), this.#nextPull - 1) + 1
      const created = this.addIssue({
        number,
        title: String(body?.title),
        body: String(body?.body ?? ""),
        labels: ((body?.labels as string[] | undefined) ?? []).map(String),
      })
      return this.#json(201, this.#issueJson(created))
    }
    // A pull request is an issue too: its labels and its conversation live here.
    const asIssue = parts[0] === "issues" ? this.pulls.get(Number(parts[1])) : undefined
    if (asIssue && method === "POST" && parts[2] === "labels") {
      const names = ((body?.labels as string[] | undefined) ?? []).map(String)
      asIssue.labels = [...new Set([...(asIssue.labels ?? []), ...names])]
      // GitHub creates a label it is asked to add and does not have.
      for (const name of names) this.labels.add(name)
      return this.#json(
        200,
        asIssue.labels.map((name) => ({ name })),
      )
    }
    if (asIssue && method === "POST" && parts[2] === "comments") {
      asIssue.comments = [
        ...(asIssue.comments ?? []),
        { author: `train-${this.owner}[bot]`, body: String(body?.body) },
      ]
      return this.#json(201, { id: asIssue.comments.length })
    }
    if (asIssue && method === "GET" && parts[2] === "comments") {
      const page = Number(q.get("page") ?? "1")
      const per = Number(q.get("per_page") ?? "30")
      return this.#json(
        200,
        (asIssue.comments ?? [])
          .map((c, i) => ({ id: i + 1, body: c.body, user: { login: c.author } }))
          .slice((page - 1) * per, page * per),
      )
    }
    const issue = parts[0] === "issues" ? this.issues.get(Number(parts[1])) : undefined
    if (parts[0] === "issues" && !issue) throw fail(404, "Not Found")
    if (issue && method === "POST" && parts[2] === "comments") {
      issue.comments.push({ author: `train-${this.owner}[bot]`, body: String(body?.body) })
      return this.#json(201, { id: issue.comments.length })
    }
    if (issue && method === "GET" && parts[2] === "comments") {
      // Paged, like the real thing, and oldest first. An unpaged fake made
      // "the caller reads every comment" untestable: a caller that only ever
      // asked for the first hundred looked correct against it.
      const page = Number(q.get("page") ?? "1")
      const per = Number(q.get("per_page") ?? "30")
      return this.#json(
        200,
        issue.comments
          .map((c, i) => ({ id: i + 1, body: c.body, user: { login: c.author } }))
          .slice((page - 1) * per, page * per),
      )
    }

    // checks on a bare commit
    if (method === "GET" && parts[0] === "commits" && parts[2] === "check-runs") {
      const runs = this.refCheckRuns.get(String(parts[1]))
      if (runs) {
        const all = runs.map((r) => ({ name: "pipeline / Check", head_sha: parts[1], ...r }))
        // GitHub's default filter is "latest": one run per name, the newest.
        const shown = q.get("filter") === "all" ? all : all.slice(-1)
        return this.#json(200, { total_count: shown.length, check_runs: shown })
      }
      const state = this.refChecks.get(String(parts[1])) ?? this.checks
      if (state === "none") return this.#json(200, { total_count: 0, check_runs: [] })
      return this.#json(200, {
        total_count: 1,
        check_runs: [
          {
            name: "pipeline / Check",
            status: state === "pending" ? "in_progress" : "completed",
            conclusion: state === "pending" ? null : state,
            head_sha: parts[1],
          },
        ],
      })
    }
    // One commit: its message, its parents, and whether GitHub verified it.
    if (method === "GET" && parts[0] === "commits" && parts.length === 2) {
      let sha: string
      try {
        sha = git(this.origin, "rev-parse", "--verify", "-q", `${String(parts[1])}^{commit}`)
      } catch {
        throw fail(422, `No commit found for SHA: ${String(parts[1])}`)
      }
      const verified = this.signed.has(sha)
      return this.#json(200, {
        sha,
        commit: {
          message: git(this.origin, "log", "-1", "--format=%B", sha),
          verification: { verified, reason: verified ? "valid" : "unsigned" },
        },
        parents: git(this.origin, "log", "-1", "--format=%P", sha)
          .split(" ")
          .filter(Boolean)
          .map((parent) => ({ sha: parent })),
      })
    }
    // `GET /compare/{base}...{head}`: where head stands relative to base.
    if (method === "GET" && parts[0] === "compare") {
      const [from = "", to = ""] = decodeURIComponent(parts.slice(1).join("/")).split("...")
      const resolve = (ref: string): string => {
        try {
          return git(this.origin, "rev-parse", "--verify", "-q", `${ref}^{commit}`)
        } catch {
          throw fail(404, "Not Found")
        }
      }
      const a = resolve(from)
      const b = resolve(to)
      const [behind = 0, ahead = 0] = git(
        this.origin,
        "rev-list",
        "--left-right",
        "--count",
        `${a}...${b}`,
      )
        .split(/\s+/)
        .map(Number)
      const status =
        ahead === 0 && behind === 0
          ? "identical"
          : behind === 0
            ? "ahead"
            : ahead === 0
              ? "behind"
              : "diverged"
      return this.#json(200, { status, ahead_by: ahead, behind_by: behind })
    }
    if (method === "GET" && parts[0] === "branches" && parts.length === 2) {
      const sha = this.sha(String(parts[1]))
      if (!sha) throw fail(404, "Branch not found")
      return this.#json(200, { name: parts[1], commit: { sha } })
    }

    // Repository metadata and settings.
    if (method === "GET" && parts.length === 0) {
      return this.#json(200, {
        name: this.name,
        full_name: `${this.owner}/${this.name}`,
        owner: { login: this.owner },
        ...this.settings,
      })
    }
    if (method === "PATCH" && parts.length === 0) {
      Object.assign(this.settings, body ?? {})
      return this.#json(200, { ...this.settings })
    }
    if (method === "GET" && parts[0] === "branches" && parts.length === 1) {
      const names = git(this.origin, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
        .split("\n")
        .filter(Boolean)
      const page = Number(q.get("page") ?? "1")
      const per = Number(q.get("per_page") ?? "30")
      return this.#json(
        200,
        names
          .slice((page - 1) * per, page * per)
          .map((name) => ({ name, commit: { sha: this.sha(name) } })),
      )
    }
    if (parts[0] === "branches" && parts[2] === "protection") {
      const branch = String(parts[1])
      const current = this.protection.get(branch)
      if (method === "GET" && parts.length === 3) {
        if (!current) throw fail(404, "Branch not protected")
        return this.#json(200, { required_status_checks: { ...current } })
      }
      if (method === "PATCH" && parts[3] === "required_status_checks") {
        if (!current) throw fail(404, "Branch not protected")
        const next = {
          strict: typeof body?.strict === "boolean" ? body.strict : current.strict,
          contexts: Array.isArray(body?.contexts) ? body.contexts.map(String) : current.contexts,
        }
        this.protection.set(branch, next)
        return this.#json(200, next)
      }
    }
    if (parts[0] === "rulesets") {
      if (method === "GET" && parts.length === 1) {
        return this.#json(
          200,
          this.rulesets.map((r) => ({
            id: r.id,
            name: r.name,
            source_type: r.source_type ?? "Repository",
          })),
        )
      }
      const index = this.rulesets.findIndex((r) => String(r.id) === String(parts[1]))
      if (index < 0) throw fail(404, "Not Found")
      if (method === "GET") return this.#json(200, this.rulesets[index])
      if (method === "PUT") {
        this.rulesets[index] = { ...(body ?? {}), id: this.rulesets[index]?.id }
        return this.#json(200, this.rulesets[index])
      }
    }
    throw fail(404, `unhandled ${method} ${url.pathname}`)
  }

  #graphql(body: { query: string; variables?: Record<string, unknown> }): unknown {
    const { query, variables = {} } = body
    if (query.includes("createCommitOnBranch")) return this.#createCommit(variables)
    if (query.includes("HEAD:.github/pipeline.yaml")) {
      const text = this.files.get(".github/pipeline.yaml")
      return { repository: { object: text === undefined ? null : { text } } }
    }
    if (query.includes("addPullRequestReviewThreadReply")) {
      const thread = this.#thread(String(variables.threadId))
      thread.comments.push({ author: `train-${this.owner}[bot]`, body: String(variables.body) })
      return { addPullRequestReviewThreadReply: { comment: { id: "c" } } }
    }
    if (query.includes("resolveReviewThread")) {
      this.#thread(String(variables.threadId)).isResolved = true
      return { resolveReviewThread: { thread: { id: variables.threadId, isResolved: true } } }
    }
    if (query.includes("query FileAtRef")) return this.#fileAtRef(variables)
    const pull = this.pulls.get(Number(variables.number))
    if (!pull) throw fail(404, `no pull ${String(variables.number)}`)
    const cursor = typeof variables.cursor === "string" ? variables.cursor : null
    if (query.includes("query PrCommitsPage")) {
      return { repository: { pullRequest: { commits: this.#commitsPage(pull, cursor) } } }
    }
    if (query.includes("query PrContextsPage")) {
      const contexts = this.#contextsPage(pull, cursor)
      return {
        repository: {
          pullRequest: {
            headCommit: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] },
          },
        },
      }
    }
    if (query.includes("query PrThreadsPage")) {
      return { repository: { pullRequest: { reviewThreads: this.#threadsPage(pull, cursor) } } }
    }
    if (query.includes("comments(first: 50)")) {
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: pull.threads.map((t) => ({
                id: t.id,
                isResolved: t.isResolved,
                isOutdated: t.isOutdated,
                path: t.path,
                line: t.line,
                comments: {
                  nodes: t.comments.map((c) => ({ body: c.body, author: { login: c.author } })),
                },
              })),
            },
          },
        },
      }
    }
    return { repository: { pullRequest: this.#pullState(pull) } }
  }

  // ---- state shaped like GitHub ------------------------------------------

  /**
   * `GET /search/issues`: `repo:` narrows to this repository (any other
   * answers nothing), `is:issue` is implied, and the quoted phrase must
   * appear in the title, case-insensitively — a phrase match, like the real
   * one, so the caller still has to compare titles exactly.
   */
  #searchIssues(q: URLSearchParams): Response {
    if (this.searchFailure !== null)
      throw fail(this.searchFailure, "API rate limit exceeded for search")
    const query = q.get("q") ?? ""
    const repo = /repo:(\S+)/.exec(query)?.[1]
    const phrase = (/"([^"]*)"/.exec(query)?.[1] ?? "").toLowerCase()
    const items =
      repo === `${this.owner}/${this.name}`
        ? [...this.issues.values()].filter((i) => i.title.toLowerCase().includes(phrase))
        : []
    return this.#json(200, {
      total_count: items.length,
      items: items.map((i) => this.#issueJson(i)),
    })
  }

  /** A git object by `<ref>:<path>`, read off the origin: a Blob, a Tree, or null when absent. */
  #fileAtRef(variables: Record<string, unknown>) {
    if (variables.owner !== this.owner || variables.name !== this.name) {
      throw fail(404, `not this repository: ${String(variables.owner)}/${String(variables.name)}`)
    }
    const expression = String(variables.expression)
    let type: string
    try {
      type = git(this.origin, "cat-file", "-t", expression)
    } catch {
      return { repository: { object: null } }
    }
    if (type !== "blob") return { repository: { object: { __typename: "Tree" } } }
    // Binary, so the text keeps its trailing newline; String() of the Buffer is UTF-8.
    const text = String(git(this.origin, "cat-file", "blob", expression, { binary: true }))
    return {
      repository: {
        object: {
          __typename: "Blob",
          text,
          isBinary: false,
          isTruncated: false,
        },
      },
    }
  }

  #pullJson(p: FakePull) {
    return {
      number: p.number,
      title: p.title,
      body: p.body,
      html_url: `https://github.com/${this.owner}/${this.name}/pull/${p.number}`,
      state: p.state,
      draft: p.draft ?? false,
      merged: p.merged,
      merged_at: p.merged ? "2026-09-04T12:00:00Z" : null,
      merged_by: p.merged ? (p.mergedBy ?? { login: "octocat", type: "User" }) : null,
      merge_commit_sha: p.mergeSha,
      labels: (p.labels ?? []).map((name) => ({ name })),
      head: {
        ref: p.head,
        sha: p.closedHeadSha ?? this.sha(p.head) ?? p.mergeSha ?? "",
        repo:
          p.headRepo === null ? null : { full_name: p.headRepo ?? `${this.owner}/${this.name}` },
      },
      base: { ref: p.base, repo: { full_name: `${this.owner}/${this.name}` } },
      user: { login: p.author ?? "octocat" },
    }
  }

  #issueJson(i: FakeIssue) {
    return {
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      labels: i.labels.map((name) => ({ name })),
      html_url: `https://github.com/${this.owner}/${this.name}/issues/${i.number}`,
      user: { login: "octocat" },
    }
  }

  /** What GitHub's mergeability check finds: a merge-tree with conflicts. */
  conflicts(base: string, head: string): boolean {
    try {
      git(this.origin, "merge-tree", "--write-tree", "--quiet", base, head)
      return false
    } catch {
      return true
    }
  }

  #pullState(p: FakePull) {
    const headSha = this.sha(p.head) ?? p.mergeSha ?? ""
    const baseSha = this.sha(p.base) ?? ""
    let behind = false
    let conflicting = false
    if (!p.merged && headSha && baseSha) {
      conflicting = this.conflicts(baseSha, headSha)
      try {
        git(this.origin, "merge-base", "--is-ancestor", baseSha, headSha)
      } catch {
        behind = true
      }
    }
    const checks = p.merged ? "success" : this.checks
    const open = p.threads.filter((t) => !t.isResolved && !t.isOutdated).length
    const mergeStateStatus = p.merged
      ? "UNKNOWN"
      : conflicting
        ? "DIRTY"
        : behind
          ? "BEHIND"
          : checks === "success" && open === 0
            ? "CLEAN"
            : "UNSTABLE"
    const unknown = !p.merged && this.unknownReads > 0
    if (unknown) this.unknownReads--
    return {
      id: `PR_${p.number}`,
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.merged ? "MERGED" : p.state === "closed" ? "CLOSED" : "OPEN",
      isDraft: p.draft ?? false,
      merged: p.merged,
      mergedAt: p.merged ? "2026-09-04T12:00:00Z" : null,
      author: this.#authorNode(p),
      ...(unknown
        ? { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }
        : { mergeable: conflicting ? "CONFLICTING" : "MERGEABLE", mergeStateStatus }),
      reviewDecision: null,
      baseRefName: p.base,
      headRefName: p.head,
      headRefOid: headSha,
      baseRef: p.baseRule
        ? {
            refUpdateRule: {
              requiredStatusCheckContexts: p.baseRule.requiredStatusCheckContexts,
              requiresSignatures: p.baseRule.requiresSignatures,
            },
          }
        : { refUpdateRule: null },
      headCommit: {
        nodes: [
          {
            commit: {
              oid: headSha,
              signature: this.#headSignature(p),
              statusCheckRollup: {
                state:
                  checks === "pending" ? "PENDING" : checks === "success" ? "SUCCESS" : "FAILURE",
                contexts: this.#contextsPage(p, null),
              },
            },
          },
        ],
      },
      commits: this.#commitsPage(p, null),
      reviewThreads: this.#threadsPage(p, null),
    }
  }

  /** One page of a connection: `cursor` is the index the page starts at. */
  #page<T>(
    list: T[],
    cursor: string | null,
  ): {
    totalCount: number
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: T[]
  } {
    const start = cursor === null ? 0 : Number(cursor)
    const end = Math.min(start + this.pageSize, list.length)
    return {
      totalCount: list.length,
      pageInfo: {
        hasNextPage: end < list.length,
        endCursor: end < list.length ? String(end) : null,
      },
      nodes: list.slice(start, end),
    }
  }

  /** GitHub signs the head or it does not; the head is the last commit of the log. */
  #headSignature(p: FakePull) {
    const signed = p.headSigned ?? p.commitLog?.at(-1)?.signed ?? true
    return signed
      ? { isValid: true, state: "VALID", signer: { login: "web-flow" } }
      : { isValid: false, state: "UNSIGNED", signer: null }
  }

  /** GraphQL spells a Bot without the `[bot]` REST adds; the reader puts it back. */
  #authorNode(p: FakePull) {
    const login = p.author ?? "octocat"
    const bot = /^(.+)\[bot\]$/.exec(login)
    return bot ? { __typename: "Bot", login: bot[1] } : { __typename: "User", login }
  }

  #commitsPage(p: FakePull, cursor: string | null) {
    const headSha = this.sha(p.head) ?? p.mergeSha ?? ""
    const log: FakeCommit[] = p.commitLog ?? [{ oid: headSha, headline: p.title, signed: true }]
    // The last commit of the log is the head, so it carries the head's sha:
    // `headRefOid` and this connection describe one and the same commit.
    return this.#page(
      log.map((c, i) => ({
        commit: {
          oid: i === log.length - 1 ? headSha : c.oid,
          messageHeadline: c.headline.split("\n", 1)[0],
          messageBody: c.body ?? "",
          signature: c.signed
            ? { isValid: true, state: "VALID" }
            : { isValid: false, state: "UNSIGNED" },
        },
      })),
      cursor,
    )
  }

  #contextsPage(p: FakePull, cursor: string | null) {
    const checks = p.merged ? "success" : this.checks
    const first: FakeContext = {
      name: this.checkName,
      status: checks === "pending" ? "IN_PROGRESS" : "COMPLETED",
      conclusion: checks === "pending" ? null : checks === "success" ? "SUCCESS" : "FAILURE",
    }
    // Check runs belong to the commit, not the PR: a head that is also a
    // branch tip carries that branch's push run too, and GitHub lists both
    // under one name.
    const headSha = this.sha(p.head) ?? p.mergeSha ?? ""
    const push = p.merged ? undefined : this.refChecks.get(headSha)
    const pushed: FakeContext[] =
      push === undefined || push === "none"
        ? []
        : [
            {
              name: this.checkName,
              status: push === "pending" ? "IN_PROGRESS" : "COMPLETED",
              conclusion: push === "pending" ? null : push === "success" ? "SUCCESS" : "FAILURE",
            },
          ]
    return this.#page(
      [first, ...pushed, ...(p.contexts ?? [])].map((c) => ({
        __typename: "CheckRun",
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        isRequired: false,
      })),
      cursor,
    )
  }

  #threadsPage(p: FakePull, cursor: string | null) {
    return this.#page(
      p.threads.map((t) => ({ id: t.id, isResolved: t.isResolved, isOutdated: t.isOutdated })),
      cursor,
    )
  }

  #thread(id: string): FakeThread {
    for (const p of this.pulls.values()) {
      const t = p.threads.find((x) => x.id === id)
      if (t) return t
    }
    throw fail(404, `no thread ${id}`)
  }

  // ---- git behind the API -------------------------------------------------

  #withClone<T>(branch: string, fn: (dir: string) => T): T {
    const dir = scratchDir("train-fake-github-")
    try {
      git(dir, "clone", "-q", "--branch", branch, this.origin, "work")
      return fn(join(dir, "work"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  #createCommit(variables: Record<string, unknown>) {
    const input = variables.input as {
      branch: { branchName: string }
      expectedHeadOid: string
      message: { headline: string; body?: string }
      fileChanges: {
        additions: { path: string; contents: string }[]
        deletions: { path: string }[]
      }
    }
    const branch = input.branch.branchName
    const head = this.sha(branch)
    if (!head) throw fail(422, `branch ${branch} does not exist`)
    if (head !== input.expectedHeadOid)
      throw fail(422, "Expected branch to point to a different commit")
    const oid = this.#withClone(branch, (work) => {
      for (const a of input.fileChanges.additions) {
        mkdirSync(dirname(join(work, a.path)), { recursive: true })
        writeFileSync(join(work, a.path), Buffer.from(a.contents, "base64"))
      }
      for (const d of input.fileChanges.deletions) rmSync(join(work, d.path), { force: true })
      git(work, "add", "-A")
      git(
        work,
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        input.message.headline,
        "-m",
        input.message.body ?? "",
      )
      git(work, "push", "-q", "origin", `HEAD:${branch}`)
      return git(work, "rev-parse", "HEAD")
    })
    this.signed.add(oid)
    this.commits.push({
      branch,
      message: { headline: input.message.headline, body: input.message.body ?? "" },
      additions: input.fileChanges.additions.map((a) => a.path),
      deletions: input.fileChanges.deletions.map((d) => d.path),
    })
    return {
      createCommitOnBranch: {
        commit: { oid, url: `https://github.com/${this.owner}/${this.name}/commit/${oid}` },
      },
    }
  }

  #releaseJson(r: FakeRelease) {
    return {
      id: r.id,
      tag_name: r.tag,
      name: r.name,
      body: r.body,
      prerelease: r.prerelease,
      draft: false,
      target_commitish: r.targetCommitish,
      html_url: `https://github.com/${this.owner}/${this.name}/releases/tag/${r.tag}`,
    }
  }

  #mergeCommit(pull: FakePull, title: string): string {
    return this.#withClone(pull.base, (work) => {
      git(work, "fetch", "-q", "origin", pull.head)
      git(work, "merge", "-q", "--no-ff", "-m", title, "FETCH_HEAD")
      git(work, "push", "-q", "origin", `HEAD:${pull.base}`)
      return git(work, "rev-parse", "HEAD")
    })
  }

  #squashMerge(pull: FakePull, title: string): string {
    return this.#withClone(pull.base, (work) => {
      git(work, "fetch", "-q", "origin", pull.head)
      git(work, "merge", "-q", "--squash", "FETCH_HEAD")
      git(work, "commit", "-q", "-m", title, "-m", `(#${pull.number})`)
      git(work, "push", "-q", "origin", `HEAD:${pull.base}`)
      return git(work, "rev-parse", "HEAD")
    })
  }

  #mergeBaseIntoHead(pull: FakePull): void {
    this.#withClone(pull.head, (work) => {
      git(work, "fetch", "-q", "origin", pull.base)
      git(work, "merge", "-q", "--no-edit", "FETCH_HEAD")
      git(work, "push", "-q", "origin", `HEAD:${pull.head}`)
    })
  }
}

function fail(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}
