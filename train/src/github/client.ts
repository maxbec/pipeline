/**
 * The GitHub API, deterministically.
 *
 * A thin REST + GraphQL client over `fetch`. No SDK: the surface the train needs
 * is a dozen calls, and every one of them has to be readable against the
 * rule it encodes. Tokens come from a provider so the same client serves an
 * App installation and, on the shell, the gh CLI.
 */
export interface TokenProvider {
  token(): Promise<string>
}

export interface RestOptions {
  body?: unknown
  /** Sent as `If-None-Match`; a 304 answer is rate-limit-free. */
  etag?: string
  headers?: Record<string, string>
}

export interface RestResponse<T> {
  status: number
  body: T | null
  notModified: boolean
  etag: string | null
  rateLimitRemaining: number | null
  rateLimitReset: Date | null
  /** `X-Poll-Interval`, seconds; GitHub's floor for polling that endpoint. */
  pollInterval: number | null
  headers: Headers
}

export class GitHubHttpError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(method: string, url: string, status: number, body: unknown) {
    const detail =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : ""
    super(`${method} ${url} -> ${status}${detail ? `: ${detail}` : ""}`)
    this.name = "GitHubHttpError"
    this.status = status
    this.body = body
  }
}

/**
 * GitHub out of reach, not GitHub saying no: `fetch` reports a connect or
 * read timeout, a reset or a failed lookup as a TypeError whose message
 * starts with "fetch failed" or whose cause carries an errno code, and a
 * gateway in front of api.github.com answers 502/503/504 while it is
 * unavailable. A 500 and every 4xx are an answer about the request itself
 * and stay errors; a TypeError without either mark is a programming error.
 */
export function isTransientGitHubFailure(error: unknown): boolean {
  if (error instanceof GitHubHttpError) {
    return error.status === 502 || error.status === 503 || error.status === 504
  }
  const e = error as { name?: unknown; message?: unknown; cause?: unknown } | null
  if (e?.name === "TimeoutError") return true
  if (e?.name !== "TypeError") return false
  if (typeof e.message === "string" && e.message.startsWith("fetch failed")) return true
  return (e.cause as { code?: unknown } | null | undefined)?.code !== undefined
}

export class GitHubGraphQLError extends Error {
  readonly errors: { message: string; path?: unknown }[]
  constructor(errors: { message: string; path?: unknown }[]) {
    super(`GraphQL: ${errors.map((e) => e.message).join("; ")}`)
    this.name = "GitHubGraphQLError"
    this.errors = errors
  }
}

export interface GitHubClientOptions {
  tokens: TokenProvider
  fetch?: typeof fetch
  baseUrl?: string
  userAgent?: string
}

export const API_VERSION = "2022-11-28"

/** What the last REST answer said was left of the hour's budget, and when it refills. */
export interface RateLimitState {
  remaining: number | null
  reset: Date | null
}

export class GitHubClient {
  readonly #tokens: TokenProvider
  readonly #fetch: typeof fetch
  readonly baseUrl: string
  readonly userAgent: string
  #rateLimit: RateLimitState = { remaining: null, reset: null }

  /**
   * The last rate limit this client was told about — `null` until it has
   * made a REST call. A caller about to open many reads at once can ask
   * before spending a request on `/rate_limit`, and stop rather than burn
   * the rest of the hour.
   */
  get rateLimit(): RateLimitState {
    return this.#rateLimit
  }

  constructor(opts: GitHubClientOptions) {
    this.#tokens = opts.tokens
    this.#fetch = opts.fetch ?? fetch
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "")
    this.userAgent = opts.userAgent ?? "pipeline-train"
  }

  async #headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await this.#tokens.token()}`,
      "x-github-api-version": API_VERSION,
      "user-agent": this.userAgent,
      ...extra,
    }
  }

  async rest<T = unknown>(
    method: string,
    path: string,
    opts: RestOptions = {},
  ): Promise<RestResponse<T>> {
    const url = /^https?:/.test(path) ? path : `${this.baseUrl}${path}`
    const headers = await this.#headers({
      ...(opts.etag ? { "if-none-match": opts.etag } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    })
    const res = await this.#fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    const body = (await readJson(res)) as T | null
    const remaining = res.headers.get("x-ratelimit-remaining")
    const reset = res.headers.get("x-ratelimit-reset")
    const poll = res.headers.get("x-poll-interval")
    const rateLimitRemaining = remaining === null ? null : Number(remaining)
    const rateLimitReset = reset === null ? null : new Date(Number(reset) * 1000)
    // Recorded before the throw: the answer that says the budget is gone is
    // a 403, and it is the one a caller most needs to have been told about.
    if (rateLimitRemaining !== null || rateLimitReset !== null) {
      this.#rateLimit = { remaining: rateLimitRemaining, reset: rateLimitReset }
    }
    if (res.status >= 400) throw new GitHubHttpError(method, url, res.status, body)
    return {
      status: res.status,
      body: res.status === 304 ? null : body,
      notModified: res.status === 304,
      etag: res.headers.get("etag"),
      rateLimitRemaining,
      rateLimitReset,
      pollInterval: poll === null ? null : Number(poll),
      headers: res.headers,
    }
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.baseUrl}/graphql`
    const res = await this.#fetch(url, {
      method: "POST",
      headers: await this.#headers({ "content-type": "application/json" }),
      body: JSON.stringify({ query, variables }),
    })
    const payload = (await readJson(res)) as {
      data?: T
      errors?: { message: string; path?: unknown }[]
    } | null
    if (res.status >= 400) throw new GitHubHttpError("POST", url, res.status, payload)
    if (payload?.errors?.length) throw new GitHubGraphQLError(payload.errors)
    if (!payload || payload.data === undefined)
      throw new GitHubGraphQLError([{ message: "empty response" }])
    return payload.data
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text.slice(0, 500) }
  }
}
