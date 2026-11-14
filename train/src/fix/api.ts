/**
 * The REST calls only the Fix job makes: a finished run and its jobs, a pull
 * request's files, comments and labels, a file's contents at a commit.
 */
import { type GitHubClient, GitHubHttpError, type TokenProvider } from "../github/client.ts"
import type { RepoRef } from "../github/pr.ts"

const PER_PAGE = 100
/** GitHub lists at most 3000 files of a pull request; comments are read as far. */
const MAX_PAGES = 30

async function pages<T>(client: GitHubClient, path: string, pick: (body: unknown) => T[]): Promise<T[]> {
  const all: T[] = []
  const sep = path.includes("?") ? "&" : "?"
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.rest("GET", `${path}${sep}per_page=${PER_PAGE}&page=${page}`)
    const items = pick(res.body)
    all.push(...items)
    if (items.length < PER_PAGE) break
  }
  return all
}

const base = (repo: RepoRef) => `/repos/${repo.owner}/${repo.name}`

export interface WorkflowRun {
  id: number
  event: string
  conclusion: string | null
  head_sha: string
  head_branch: string | null
  head_repository: { full_name: string } | null
  run_attempt?: number
}

export async function getRun(client: GitHubClient, repo: RepoRef, id: number): Promise<WorkflowRun> {
  const res = await client.rest<WorkflowRun>("GET", `${base(repo)}/actions/runs/${id}`)
  if (!res.body) throw new Error(`run ${id}: empty answer`)
  return res.body
}

export interface WorkflowJob {
  id: number
  name: string
  conclusion: string | null
}

/** The jobs of the run's latest attempt. */
export function listRunJobs(client: GitHubClient, repo: RepoRef, id: number): Promise<WorkflowJob[]> {
  return pages(
    client,
    `${base(repo)}/actions/runs/${id}/jobs?filter=latest`,
    (body) => (body as { jobs?: WorkflowJob[] } | null)?.jobs ?? [],
  )
}

/** Needs the App's `actions: write`. */
export async function rerunFailedJobs(client: GitHubClient, repo: RepoRef, id: number): Promise<void> {
  await client.rest("POST", `${base(repo)}/actions/runs/${id}/rerun-failed-jobs`)
}

export interface OpenPull {
  number: number
  title: string
  state: string
  draft?: boolean
  user: { login: string } | null
  labels?: { name: string }[]
  head: { ref: string; sha: string; repo?: { full_name: string } | null }
}

/** Open pull requests of this repository whose head is `branch`. */
export async function openPullsForBranch(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
): Promise<OpenPull[]> {
  const head = encodeURIComponent(`${repo.owner}:${branch}`)
  const res = await client.rest<OpenPull[]>(
    "GET",
    `${base(repo)}/pulls?state=open&head=${head}&per_page=${PER_PAGE}`,
  )
  return res.body ?? []
}

export async function getPull(client: GitHubClient, repo: RepoRef, number: number): Promise<OpenPull> {
  const res = await client.rest<OpenPull>("GET", `${base(repo)}/pulls/${number}`)
  if (!res.body) throw new Error(`pull request ${number}: empty answer`)
  return res.body
}

/** The paths a pull request changes and that still exist on its head. */
export async function listPullFiles(client: GitHubClient, repo: RepoRef, number: number): Promise<string[]> {
  const files = await pages(
    client,
    `${base(repo)}/pulls/${number}/files`,
    (body) => (body as { filename: string; status: string }[] | null) ?? [],
  )
  return files.filter((f) => f.status !== "removed").map((f) => f.filename)
}

export interface IssueComment {
  body: string | null
  user: { login: string; type?: string } | null
}

export function listComments(client: GitHubClient, repo: RepoRef, number: number): Promise<IssueComment[]> {
  return pages(
    client,
    `${base(repo)}/issues/${number}/comments`,
    (body) => (body as IssueComment[] | null) ?? [],
  )
}

export async function postComment(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  body: string,
): Promise<void> {
  await client.rest("POST", `${base(repo)}/issues/${number}/comments`, { body: { body } })
}

/** GitHub creates a label that does not exist yet. */
export async function addLabel(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  label: string,
): Promise<void> {
  await client.rest("POST", `${base(repo)}/issues/${number}/labels`, { body: { labels: [label] } })
}

export type FileAt =
  | { kind: "file"; text: string; size: number }
  /** Too large for the contents API to carry (over 1 MB), or not a file. */
  | { kind: "other"; size: number }
  | { kind: "missing" }

/** A file as `ref` holds it. */
export async function fileAt(
  client: GitHubClient,
  repo: RepoRef,
  path: string,
  ref: string,
): Promise<FileAt> {
  const encoded = path.split("/").map(encodeURIComponent).join("/")
  try {
    const res = await client.rest<{
      type?: string
      encoding?: string
      content?: string
      size?: number
    }>("GET", `${base(repo)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`)
    const body = res.body
    const size = body?.size ?? 0
    if (!body || Array.isArray(body) || body.type !== "file") return { kind: "other", size }
    if (body.encoding !== "base64" || (size > 0 && !body.content)) return { kind: "other", size }
    return { kind: "file", text: Buffer.from(body.content ?? "", "base64").toString("utf8"), size }
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return { kind: "missing" }
    throw error
  }
}

/**
 * A job's log as plain text. The endpoint answers with a redirect to a
 * short-lived download; `fetch` follows it and leaves the token behind on the
 * way to the other host.
 */
export async function fetchJobLog(
  opts: { tokens: TokenProvider; fetch?: typeof fetch; baseUrl?: string },
  repo: RepoRef,
  jobId: number,
): Promise<string> {
  const url = `${(opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "")}${base(repo)}/actions/jobs/${jobId}/logs`
  const res = await (opts.fetch ?? fetch)(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await opts.tokens.token()}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "pipeline-train",
    },
    redirect: "follow",
  })
  if (!res.ok) throw new GitHubHttpError("GET", url, res.status, null)
  return res.text()
}
