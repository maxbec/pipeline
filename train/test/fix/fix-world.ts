import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { GitHubClient } from "../../src/github/client.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { FakeGitHub, type FakePull, git } from "../workflow/fake-github.ts"

/**
 * The fake GitHub, plus what only the Fix job asks for: a finished workflow
 * run with its jobs and their logs, a pull request's changed files, its
 * comments and labels, and a file's contents at a commit. Everything else —
 * pulls, `createCommitOnBranch` on the real bare origin — is the shared fake.
 */

export interface FakeRun {
  event: string
  conclusion: string | null
  head_sha: string
  head_branch: string
  /** `owner/name` of the repository the head lives in; a fork names another. */
  head_repository: string
  run_attempt: number
}

export interface FakeJob {
  id: number
  name: string
  conclusion: string | null
}

export interface FakeComment {
  id: number
  body: string
  user: { login: string; type: "Bot" | "User" }
}

export interface PullExtras {
  draft: boolean
  labels: string[]
  files: { filename: string; status: string }[]
  comments: FakeComment[]
}

export const CHECK = "pipeline / Check"

export class FixWorld {
  readonly gh: FakeGitHub
  readonly client: GitHubClient
  readonly seed: string
  readonly runs = new Map<number, FakeRun>()
  readonly jobs = new Map<number, FakeJob[]>()
  readonly logs = new Map<number, string>()
  readonly reruns: number[] = []
  readonly extras = new Map<number, PullExtras>()
  /** Who the App's comments are from. */
  bot = "train-acme[bot]"
  #nextComment = 1

  constructor(name: string) {
    const home = scratchDir("train-fix-")
    const origin = join(home, `${name}.git`)
    git(home, "init", "-q", "--bare", "-b", "dev", origin)
    this.seed = join(home, "seed")
    git(home, "clone", "-q", origin, this.seed)
    this.#write({ "README.md": "# demo\n" })
    git(this.seed, "add", "-A")
    git(this.seed, "commit", "-q", "-m", "chore: init")
    git(this.seed, "push", "-q", "origin", "dev")
    this.gh = new FakeGitHub({ origin, owner: "acme", name })
    this.client = new GitHubClient({
      tokens: { token: async () => "fake" },
      fetch: (input, init) => this.fetch(input, init),
    })
  }

  get repo() {
    return { owner: this.gh.owner, name: this.gh.name }
  }

  #write(files: Record<string, string | Buffer>) {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(this.seed, path)), { recursive: true })
      writeFileSync(join(this.seed, path), contents)
    }
  }

  /** One commit on `branch` (cut from dev when new), pushed; its sha. */
  commit(branch: string, files: Record<string, string | Buffer>): string {
    git(this.seed, "fetch", "-q", "origin")
    const start = this.gh.sha(branch) ? `origin/${branch}` : "origin/dev"
    git(this.seed, "checkout", "-q", "-B", branch, start)
    this.#write(files)
    git(this.seed, "add", "-A")
    git(this.seed, "commit", "-q", "-m", `feat: change on ${branch}`)
    git(this.seed, "push", "-q", "origin", branch)
    return git(this.seed, "rev-parse", "HEAD")
  }

  /** An open pull request from `branch` into dev that changes `files`; the fake pull and its head. */
  pull(
    branch: string,
    files: Record<string, string | Buffer>,
    opts: Partial<PullExtras> & { author?: string; title?: string } = {},
  ): { pull: FakePull; headSha: string } {
    const headSha = this.commit(branch, files)
    const number = Math.max(0, ...this.gh.pulls.keys()) + 1
    const pull: FakePull = {
      number,
      title: opts.title ?? "feat: a change",
      body: "",
      head: branch,
      base: "dev",
      state: "open",
      merged: false,
      mergeSha: null,
      reviews: [],
      threads: [],
      author: opts.author,
    }
    this.gh.pulls.set(number, pull)
    this.extras.set(number, {
      draft: opts.draft ?? false,
      labels: opts.labels ?? [],
      files: opts.files ?? Object.keys(files).map((filename) => ({ filename, status: "modified" })),
      comments: opts.comments ?? [],
    })
    return { pull, headSha }
  }

  /** A finished Pipeline run on `headSha`: Guard green, Check as given. */
  run(
    id: number,
    headSha: string,
    branch: string,
    over: Partial<FakeRun> & { jobs?: FakeJob[]; log?: string } = {},
  ): number {
    const { jobs, log, ...run } = over
    this.runs.set(id, {
      event: "pull_request",
      conclusion: "failure",
      head_sha: headSha,
      head_branch: branch,
      head_repository: `${this.gh.owner}/${this.gh.name}`,
      run_attempt: 1,
      ...run,
    })
    this.jobs.set(
      id,
      jobs ?? [
        { id: id * 10 + 1, name: "pipeline / Guard", conclusion: "success" },
        { id: id * 10 + 2, name: CHECK, conclusion: "failure" },
      ],
    )
    this.logs.set(id * 10 + 2, log ?? "line one\nError: expected 1 to be 2\n")
    return id
  }

  comment(number: number, body: string, type: "Bot" | "User" = "Bot"): void {
    this.extras.get(number)?.comments.push({
      id: this.#nextComment++,
      body,
      user: { login: type === "Bot" ? this.bot : "octocat", type },
    })
  }

  comments(number: number): string[] {
    return (this.extras.get(number)?.comments ?? []).map((c) => c.body)
  }

  labels(number: number): string[] {
    return this.extras.get(number)?.labels ?? []
  }

  /** The file as the branch holds it on the origin, or null. */
  file(branch: string, path: string): string | null {
    try {
      return String(git(this.gh.origin, "show", `refs/heads/${branch}:${path}`, { binary: true }))
    } catch {
      return null
    }
  }

  // ---- the wire -----------------------------------------------------------

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    )
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    const prefix = `/repos/${this.gh.owner}/${this.gh.name}/`
    if (!url.pathname.startsWith(prefix)) return this.gh.handle(input, init)
    const parts = url.pathname.slice(prefix.length).split("/")
    const q = url.searchParams
    const page = <T>(all: T[]): T[] => {
      const n = Number(q.get("page") ?? "1")
      const per = Number(q.get("per_page") ?? "30")
      return all.slice((n - 1) * per, n * per)
    }

    if (parts[0] === "actions" && parts[1] === "runs" && parts[2]) {
      const id = Number(parts[2])
      const run = this.runs.get(id)
      if (!run) return json(404, { message: "Not Found" })
      if (method === "GET" && parts.length === 3) {
        return json(200, { id, ...run, head_repository: { full_name: run.head_repository } })
      }
      if (method === "GET" && parts[3] === "jobs") {
        return json(200, { total_count: this.jobs.get(id)?.length ?? 0, jobs: page(this.jobs.get(id) ?? []) })
      }
      if (method === "POST" && parts[3] === "rerun-failed-jobs") {
        this.reruns.push(id)
        return json(201, {})
      }
    }
    if (method === "GET" && parts[0] === "actions" && parts[1] === "jobs" && parts[3] === "logs") {
      const log = this.logs.get(Number(parts[2]))
      if (log === undefined) return json(404, { message: "Not Found" })
      return new Response(log, { status: 200, headers: { "content-type": "text/plain" } })
    }

    if (parts[0] === "pulls" && method === "GET" && parts.length <= 2) {
      const res = await this.gh.handle(input, init)
      if (res.status !== 200) return res
      const decorate = (p: { number: number; head: Record<string, unknown> }) => {
        const extra = this.extras.get(p.number)
        return {
          ...p,
          draft: extra?.draft ?? false,
          labels: (extra?.labels ?? []).map((name) => ({ name })),
          head: { ...p.head, repo: { full_name: `${this.gh.owner}/${this.gh.name}` } },
        }
      }
      const payload = (await res.json()) as never
      return json(200, Array.isArray(payload) ? (payload as never[]).map(decorate) : decorate(payload))
    }
    if (parts[0] === "pulls" && method === "GET" && parts[2] === "files") {
      return json(200, page(this.extras.get(Number(parts[1]))?.files ?? []))
    }

    const extra = parts[0] === "issues" ? this.extras.get(Number(parts[1])) : undefined
    if (extra && parts[2] === "comments") {
      if (method === "GET") return json(200, page(extra.comments))
      if (method === "POST") {
        const comment: FakeComment = {
          id: this.#nextComment++,
          body: String(body.body),
          user: { login: this.bot, type: "Bot" },
        }
        extra.comments.push(comment)
        return json(201, comment)
      }
    }
    if (extra && parts[2] === "labels" && method === "POST") {
      for (const label of body.labels as string[]) {
        if (!extra.labels.includes(label)) extra.labels.push(label)
      }
      return json(200, extra.labels.map((name) => ({ name })))
    }

    if (method === "GET" && parts[0] === "contents") {
      const path = parts.slice(1).map(decodeURIComponent).join("/")
      const ref = q.get("ref") ?? "dev"
      try {
        const blob = git(this.gh.origin, "show", `${ref}:${path}`, { binary: true }) as unknown as Buffer
        return json(200, {
          type: "file",
          encoding: "base64",
          size: blob.length,
          // The real API leaves `content` empty above 1 MB.
          content: blob.length > 1_000_000 ? "" : blob.toString("base64"),
        })
      } catch {
        return json(404, { message: "Not Found" })
      }
    }
    return this.gh.handle(input, init)
  }
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}
