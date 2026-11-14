import { setTimeout as sleep } from "node:timers/promises"
import { baseBranchFor, type CompanySlug, type GitHubEvent, type Repository } from "../types.ts"
import type { GitHubClient } from "./client.ts"
import { mergePullRequest } from "./merge.ts"
import { canMerge, getPrState, type MergeVerdict, type PrState, type RepoRef } from "./pr.ts"
import { type UpdateBehindMemo, updateBehindOnce, updateBranchRounds } from "./update-behind.ts"

/** Dependabot as REST, webhooks and `gh` spell it; `PrState.authorLogin` uses the same spelling. */
export const DEPENDABOT_LOGIN = "dependabot[bot]"

/**
 * The events that can change a Dependabot PR's verdict. Anything else on
 * the stream (issues, releases, pushes, workflow runs) is not read.
 */
const PR_EVENT_KINDS = new Set([
  "pull_request",
  "check_run",
  "check_suite",
  "status",
  "pull_request_review",
  "pull_request_review_thread",
])

/** How Dependabot classifies each bump, in the commit body it writes (one line per dependency). */
const UPDATE_TYPE = /^\s*update-type:\s*version-update:semver-(major|minor|patch)\s*$/gim

/** `bump foo from 1.2.3 to 2.0.0`, grouped titles have no versions and fall through. */
const BUMP_TITLE = /\bbump\s+(\S.*?)\s+from\s+(\S+)\s+to\s+(\S+)/i

/**
 * The pauses before each re-read of a PR whose mergeability GitHub is still
 * computing (`UNKNOWN`): about two minutes in all. Right after a merge moves
 * the base GitHub recomputes every sibling, and no event says when it is done.
 */
export const UNKNOWN_REREAD_MS = [5_000, 15_000, 45_000, 55_000] as const

/** The periodic sweep runs every 30 minutes plus up to 30 minutes of jitter. */
export const SWEEP_EVERY_MS = 30 * 60_000
export const SWEEP_JITTER_MS = 30 * 60_000

export type BumpKind = "major" | "minor_or_patch" | "unknown"

/**
 * Major, or not, from what Dependabot itself wrote. The commit body is the
 * authority: every bump of a grouped update is listed there with its
 * `update-type`, and a security update carries it too. The title's
 * `from A to B` is the fallback for a PR whose commits say nothing, with
 * the major read off the leading integer of each version (`v2.0.0` is 2).
 * A PR that says neither is `unknown`, and `unknown` is not merged: the
 * policy is "minor and patch only", and a bump it cannot classify is not
 * known to be one of those.
 */
export function bumpKindOf(pr: Pick<PrState, "title" | "commits">): BumpKind {
  const types = pr.commits.flatMap((c) =>
    [...c.body.matchAll(UPDATE_TYPE)].map((m) => String(m[1]).toLowerCase()),
  )
  if (types.includes("major")) return "major"
  if (types.length > 0) return "minor_or_patch"
  const title = BUMP_TITLE.exec(pr.title)
  if (!title) return "unknown"
  const from = majorOf(title[2] ?? "")
  const to = majorOf(title[3] ?? "")
  if (from === null || to === null) return "unknown"
  return from === to ? "minor_or_patch" : "major"
}

function majorOf(version: string): number | null {
  const m = /^v?(\d+)/i.exec(version)
  return m?.[1] ? Number.parseInt(m[1], 10) : null
}

export type DependabotOutcome =
  | { kind: "merged"; number: number; sha: string }
  | { kind: "updated_branch"; number: number }
  | { kind: "waiting"; number: number; code: string; reason: string }
  | { kind: "skipped"; number: number; reason: string }

export interface DependabotMergerDeps {
  clientFor: (company: CompanySlug) => GitHubClient | null
  repositories: () => Promise<Repository[]>
  log?: (line: string) => void
  /** The pause between two reads of an UNKNOWN PR; tests answer at once. */
  sleep?: (ms: number) => Promise<void>
  /** Arms the next periodic sweep and returns its cancel; the default is an unref'd `setTimeout`. */
  schedule?: (run: () => Promise<void>, ms: number) => () => void
  /** The jitter's source, in [0, 1). */
  random?: () => number
}

interface RestPull {
  number: number
  state: string
  user?: { login?: string } | null
}

/**
 * The Dependabot merger. Where the train is the only merge gate (no ruleset
 * enforces the Check), so GitHub's native auto-merge would merge a Dependabot PR
 * the moment it opened; this merges it the moment `canMerge` says yes and
 * not before, through the company App, squash pinned to the head it judged.
 *
 * Event-driven: a `pull_request`, check or review event names a
 * PR, the PR is read fresh, and the verdict decides. A green minor or patch
 * bump into the Base Branch merges; a BEHIND one is brought forward once per
 * head (`updateBehindOnce`) and waits for the next event; everything else
 * waits, with the reason logged once per head sha and code. A major bump,
 * a PR into `main` of a major repository, a repository that opted out and
 * a PR nobody can classify are left open and logged. Nothing here notifies
 * anyone: a merge that was asked for is not news, and a wait can be read in the PR.
 *
 * One startup sweep over the open PRs of every opted-in repository: a PR
 * that went green while nothing was listening raises no event afterwards (the
 * poller's ETags see nothing new), and it is still a green Dependabot PR.
 * The same sweep runs every 30 to 60 minutes (`startSweeps`), for the PRs
 * no event will ever name again: one GitHub left at `UNKNOWN` after the
 * re-reads (it is held in a retry set and read first), one whose turn
 * never came. After every merge it makes, the merger walks the other open
 * Dependabot PRs of that repository one at a time, because a merge moves
 * the base under them and GitHub raises no event on a PR it put behind.
 * The walk updates one behind head and lets the rest wait their turn, and
 * the update bound (`MAX_UPDATE_BRANCH_ROUNDS`) is refunded the round a
 * merge of its own used up: on a strict base with five bumps open, the
 * fifth is put behind four times by the merger alone.
 */
export class DependabotMerger {
  readonly #deps: DependabotMergerDeps
  /** `owner/repo#n` → author, from one REST read; a PR's author never changes. */
  readonly #authors = new Map<string, string | null>()
  /** `owner/repo#n` → the update-branch memo, so one head is updated once and rounds are bounded. */
  readonly #behind = new Map<string, UpdateBehindMemo>()
  /** `owner/repo#n` → `headSha:code` of the last line logged, so a wait is said once. */
  readonly #said = new Map<string, string>()
  /** `owner/repo#n` → the look in flight, so two events on one PR read and merge one after the other. */
  readonly #inflight = new Map<string, Promise<DependabotOutcome | null>>()
  /** `owner/repo#n` → the PR GitHub still called UNKNOWN after the last re-read; the next sweep reads it. */
  readonly #retry = new Map<string, { repositoryId: string; number: number }>()
  readonly #sleep: (ms: number) => Promise<void>
  #sweeping: Promise<DependabotOutcome[]> | null = null

  constructor(deps: DependabotMergerDeps) {
    this.#deps = deps
    this.#sleep = deps.sleep ?? ((ms) => sleep(ms, undefined, { ref: false }))
  }

  /** The engine's event hook. Never throws: one bad event must not stop the next hook. */
  async onEvent(event: GitHubEvent): Promise<DependabotOutcome | null> {
    if (event.number === null || !PR_EVENT_KINDS.has(event.kind)) return null
    const key = `${event.owner}/${event.repo}#${event.number}`
    if (event.kind === "pull_request" && event.action === "closed") {
      this.#forget(key)
      return null
    }
    let repository: Repository | null
    try {
      repository = await this.#repositoryOf(event.company, event.owner, event.repo)
    } catch (error) {
      this.#deps.log?.(`dependabot: listing repositories: ${String(error)}`)
      return null
    }
    if (!repository) return null
    const outcome = await this.#serialized(key, () =>
      this.#look(repository, event.number as number),
    )
    // The merge moved the base under every sibling, and GitHub says so to none of them.
    if (outcome?.kind === "merged") await this.#walk(repository, new Set(), outcome.number)
    return outcome
  }

  /**
   * Every open Dependabot PR of every opted-in repository, then whatever is
   * left in the retry set. A sweep asked for while one runs joins it.
   * Errors are logged per repository; the sweep never throws.
   */
  sweep(): Promise<DependabotOutcome[]> {
    this.#sweeping ??= this.#sweepAll().finally(() => {
      this.#sweeping = null
    })
    return this.#sweeping
  }

  /** The periodic sweep, every `SWEEP_EVERY_MS` plus up to `SWEEP_JITTER_MS`, until stopped. */
  startSweeps(): { stop(): void } {
    const schedule = this.#deps.schedule ?? scheduleUnref
    const random = this.#deps.random ?? Math.random
    let cancel: (() => void) | null = null
    let stopped = false
    const arm = () => {
      if (stopped) return
      const ms = SWEEP_EVERY_MS + Math.floor(random() * SWEEP_JITTER_MS)
      cancel = schedule(async () => {
        await this.sweep()
        arm()
      }, ms)
    }
    arm()
    return {
      stop: () => {
        stopped = true
        cancel?.()
      },
    }
  }

  async #sweepAll(): Promise<DependabotOutcome[]> {
    const outcomes: DependabotOutcome[] = []
    let repositories: Repository[]
    try {
      repositories = await this.#deps.repositories()
    } catch (error) {
      this.#deps.log?.(`dependabot: listing repositories: ${String(error)}`)
      return outcomes
    }
    const looked = new Set<string>()
    for (const repository of repositories) {
      if (!repository.dependabotMergeEnabled) continue
      outcomes.push(...(await this.#walk(repository, looked)))
    }
    // A PR the walks did not reach (its repository's listing failed, say) is still owed a read.
    for (const [key, { repositoryId, number }] of [...this.#retry]) {
      if (looked.has(key)) continue
      const repository = repositories.find((r) => r.id === repositoryId)
      if (!repository) {
        this.#retry.delete(key)
        continue
      }
      const outcome = await this.#serialized(key, () => this.#look(repository, number))
      if (outcome) outcomes.push(outcome)
    }
    return outcomes
  }

  /**
   * The open Dependabot PRs of one repository, oldest first, one at a time.
   * The first that is brought forward (or already is being) takes the turn;
   * a later one that is behind waits for it instead of being updated too,
   * since each merge would put the other behind again. `except` is the PR
   * that was just merged.
   */
  async #walk(
    repository: Repository,
    looked: Set<string>,
    except?: number,
  ): Promise<DependabotOutcome[]> {
    const outcomes: DependabotOutcome[] = []
    const client = this.#deps.clientFor(repository.company)
    if (!client) return outcomes
    const slug = `${repository.owner}/${repository.name}`
    try {
      const res = await client.rest<RestPull[]>(
        "GET",
        `/repos/${slug}/pulls?state=open&per_page=100`,
      )
      const pulls = res.body ?? []
      for (const pull of pulls)
        this.#authors.set(`${slug}#${pull.number}`, pull.user?.login ?? null)
      const ours = pulls
        .filter((p) => p.user?.login === DEPENDABOT_LOGIN && p.number !== except)
        .sort((a, b) => a.number - b.number)
      let turn: number | null = null
      for (const pull of ours) {
        const key = `${slug}#${pull.number}`
        looked.add(key)
        const outcome = await this.#serialized(key, () => this.#look(repository, pull.number, turn))
        if (!outcome) continue
        outcomes.push(outcome)
        if (
          turn === null &&
          (outcome.kind === "updated_branch" ||
            (outcome.kind === "waiting" && outcome.code === "behind:already"))
        ) {
          turn = pull.number
        }
      }
    } catch (error) {
      this.#deps.log?.(`dependabot: sweeping ${slug}: ${String(error)}`)
    }
    return outcomes
  }

  async #repositoryOf(
    company: CompanySlug,
    owner: string,
    name: string,
  ): Promise<Repository | null> {
    const all = await this.#deps.repositories()
    return (
      all.find(
        (r) =>
          r.company === company &&
          r.owner.toLowerCase() === owner.toLowerCase() &&
          r.name.toLowerCase() === name.toLowerCase(),
      ) ?? null
    )
  }

  #serialized(
    key: string,
    run: () => Promise<DependabotOutcome | null>,
  ): Promise<DependabotOutcome | null> {
    const previous = this.#inflight.get(key) ?? Promise.resolve(null)
    const next = previous.then(run, run).catch((error: unknown) => {
      this.#deps.log?.(`dependabot: ${key}: ${String(error)}`)
      return null
    })
    this.#inflight.set(key, next)
    void next.finally(() => {
      if (this.#inflight.get(key) === next) this.#inflight.delete(key)
    })
    return next
  }

  /** `turn`: the PR of the same walk that is being brought forward; a behind head waits for it. */
  async #look(
    repository: Repository,
    number: number,
    turn: number | null = null,
  ): Promise<DependabotOutcome | null> {
    const repo: RepoRef = { owner: repository.owner, name: repository.name }
    const key = `${repo.owner}/${repo.name}#${number}`
    this.#retry.delete(key)
    if (!repository.dependabotMergeEnabled) {
      return this.#skip(key, number, "opted_out", `${repository.id} opted out of Dependabot merges`)
    }
    const client = this.#deps.clientFor(repository.company)
    if (!client) {
      return this.#skip(
        key,
        number,
        "no_app",
        `no GitHub App for ${repository.company}; the train cannot merge there`,
      )
    }
    if ((await this.#authorOf(client, repo, number)) !== DEPENDABOT_LOGIN) return null

    let pr = await getPrState(client, repo, number)
    // The REST read above is a cache; the fresh read is what decides.
    if (pr.authorLogin !== DEPENDABOT_LOGIN) {
      this.#authors.set(key, pr.authorLogin)
      return null
    }
    if (pr.state !== "OPEN" || pr.merged) {
      this.#forget(key)
      return null
    }
    const base = baseBranchFor(repository)
    if (pr.baseRefName !== base) {
      return this.#skip(
        key,
        number,
        `${pr.headSha}:base`,
        `targets ${pr.baseRefName}, not the Base Branch ${base}${
          repository.kind === "major" && pr.baseRefName === "main"
            ? " (main of a major repository takes promotions only)"
            : ""
        }`,
      )
    }
    const bump = bumpKindOf(pr)
    if (bump !== "minor_or_patch") {
      return this.#skip(
        key,
        number,
        `${pr.headSha}:${bump}`,
        bump === "major"
          ? `a major bump: "${pr.title}" stays open for the owner`
          : `cannot tell whether "${pr.title}" is a major bump: no update-type in its commits and no versions in its title`,
      )
    }

    let verdict: MergeVerdict = canMerge(pr)
    for (const ms of UNKNOWN_REREAD_MS) {
      if (verdict.ok || verdict.code !== "unknown") break
      await this.#sleep(ms)
      pr = await getPrState(client, repo, number)
      verdict = canMerge(pr)
    }
    if (verdict.ok) {
      const merged = await mergePullRequest(client, repo, number, {
        method: "squash",
        expectedHeadSha: pr.headSha,
        title: `${pr.title} (#${number})`,
        body: pr.body,
      })
      this.#forget(key)
      this.#refundSiblings(`${repo.owner}/${repo.name}`)
      this.#deps.log?.(
        `dependabot: merged ${key} "${pr.title}" at ${pr.headSha.slice(0, 7)} into ${base} as ${merged.sha.slice(0, 7)}`,
      )
      return { kind: "merged", number, sha: merged.sha }
    }
    if (verdict.code === "merged" || verdict.code === "closed") {
      this.#forget(key)
      return null
    }
    if (verdict.code === "unknown") {
      this.#retry.set(key, { repositoryId: repository.id, number })
      return this.#wait(
        key,
        number,
        pr.headSha,
        verdict.code,
        `${verdict.reason}; still so after two minutes of re-reads, the next sweep reads it again`,
      )
    }
    if (verdict.code === "behind" && verdict.remedy === "update_branch") {
      if (turn !== null) {
        return this.#wait(
          key,
          number,
          pr.headSha,
          "behind:queued",
          `${verdict.reason}; waits its turn behind #${turn}`,
        )
      }
      const update = await updateBehindOnce({
        client,
        repo,
        pr,
        memo: this.#behind.get(key) ?? {},
      })
      this.#behind.set(key, update.memo)
      if (update.kind === "updated") {
        this.#deps.log?.(
          `dependabot: ${key} is behind ${base}; asked GitHub to update ${pr.headSha.slice(0, 7)}`,
        )
        return { kind: "updated_branch", number }
      }
      const reason =
        update.kind === "already"
          ? `${verdict.reason}; already asked GitHub to update this head`
          : `${verdict.reason}; ${update.reason}`
      return this.#wait(key, number, pr.headSha, `behind:${update.kind}`, reason)
    }
    return this.#wait(key, number, pr.headSha, verdict.code, verdict.reason)
  }

  /** One REST read per PR and process: who opened it. Cached, because an author never changes. */
  async #authorOf(client: GitHubClient, repo: RepoRef, number: number): Promise<string | null> {
    const key = `${repo.owner}/${repo.name}#${number}`
    const known = this.#authors.get(key)
    if (known !== undefined) return known
    const res = await client.rest<RestPull>(
      "GET",
      `/repos/${repo.owner}/${repo.name}/pulls/${number}`,
    )
    const author = res.body?.user?.login ?? null
    this.#authors.set(key, author)
    return author
  }

  #wait(
    key: string,
    number: number,
    headSha: string,
    code: string,
    reason: string,
  ): DependabotOutcome {
    this.#once(key, `${headSha}:${code}`, `dependabot: ${key} waits: ${reason}`)
    return { kind: "waiting", number, code, reason }
  }

  #skip(key: string, number: number, mark: string, reason: string): DependabotOutcome {
    this.#once(key, mark, `dependabot: ${key} not merged: ${reason}`)
    return { kind: "skipped", number, reason }
  }

  #once(key: string, mark: string, line: string): void {
    if (this.#said.get(key) === mark) return
    this.#said.set(key, mark)
    this.#deps.log?.(line)
  }

  /**
   * A merge of the merger's own moved the base under every sibling, so the
   * update each of them now needs is not counted against the bound: one
   * round back for every sibling that has been brought forward before.
   */
  #refundSiblings(slug: string): void {
    for (const [key, memo] of this.#behind) {
      if (!key.startsWith(`${slug}#`)) continue
      const rounds = updateBranchRounds(memo)
      if (rounds > 0) this.#behind.set(key, { ...memo, updateBranchRounds: rounds - 1 })
    }
  }

  #forget(key: string): void {
    this.#said.delete(key)
    this.#behind.delete(key)
    this.#authors.delete(key)
    this.#retry.delete(key)
  }
}

function scheduleUnref(run: () => Promise<void>, ms: number): () => void {
  const timer = setTimeout(() => void run(), ms)
  timer.unref()
  return () => clearTimeout(timer)
}
