import { execFile } from "node:child_process"
import { createSign } from "node:crypto"
import { promisify } from "node:util"
import type { TokenProvider } from "./client.ts"

const run = promisify(execFile)

/**
 * GitHub App authentication, with nothing but `node:crypto`, and the two
 * other places a token comes from: an environment variable and the gh CLI.
 */

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url")
}

/** RS256 JWT for `/app/*`: issued 60 s in the past, valid nine minutes. */
export function appJwt(appId: string, privateKeyPem: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }))
  const signer = createSign("RSA-SHA256")
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`
}

export interface AppTokenProviderOptions {
  appId: string
  privateKey: string
  installationId: string
  fetch?: typeof fetch
  baseUrl?: string
  now?: () => number
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000

/** Installation tokens expire after an hour; refreshed five minutes early. */
export class AppTokenProvider implements TokenProvider {
  readonly #opts: Required<Pick<AppTokenProviderOptions, "appId" | "privateKey" | "installationId">>
  readonly #fetch: typeof fetch
  readonly #baseUrl: string
  readonly #now: () => number
  #cached: { token: string; expiresAt: number } | null = null
  #inflight: Promise<string> | null = null

  constructor(opts: AppTokenProviderOptions) {
    this.#opts = {
      appId: opts.appId,
      privateKey: opts.privateKey,
      installationId: opts.installationId,
    }
    this.#fetch = opts.fetch ?? fetch
    this.#baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "")
    this.#now = opts.now ?? Date.now
  }

  async token(): Promise<string> {
    const now = this.#now()
    if (this.#cached && this.#cached.expiresAt - REFRESH_MARGIN_MS > now) return this.#cached.token
    if (!this.#inflight) {
      this.#inflight = this.#refresh().finally(() => {
        this.#inflight = null
      })
    }
    return this.#inflight
  }

  async #refresh(): Promise<string> {
    const jwt = appJwt(this.#opts.appId, this.#opts.privateKey, this.#now())
    const res = await this.#fetch(
      `${this.#baseUrl}/app/installations/${this.#opts.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "pipeline-train",
        },
      },
    )
    const body = (await res.json()) as { token?: string; expires_at?: string; message?: string }
    if (res.status !== 201 || !body.token || !body.expires_at) {
      throw new Error(
        `installation token for app ${this.#opts.appId}: ${res.status} ${body.message ?? ""}`.trim(),
      )
    }
    this.#cached = { token: body.token, expiresAt: Date.parse(body.expires_at) }
    return body.token
  }
}

/** The gh CLI's own token: for the hand scripts on a developer's machine. */
export function ghCliTokenProvider(): TokenProvider {
  let cached: string | null = null
  return {
    async token() {
      if (cached) return cached
      const { stdout } = await run("gh", ["auth", "token"])
      cached = stdout.trim()
      return cached
    },
  }
}

/**
 * A token handed in through the environment: `GITHUB_TOKEN` in a workflow
 * job. Read when asked, not when built, and never an empty string: an unset
 * variable is an error that names it, not a request GitHub answers with 401.
 */
export function envTokenProvider(name: string): TokenProvider {
  return {
    async token() {
      const value = process.env[name]?.trim()
      if (!value) throw new Error(`${name} is not set: the GitHub token is read from that variable`)
      return value
    },
  }
}
