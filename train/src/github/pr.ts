import type { MergeVerdict } from "../types.ts"
import type { GitHubClient } from "./client.ts"

/**
 * Deterministic PR state and the merge rules.
 *
 * Every rule in `canMerge` has already cost a debugging session on this
 * fleet; the reasons are written for the person reading the run log, not
 * for the machine.
 */
export interface RepoRef {
  owner: string
  name: string
}

export interface PrCheck {
  name: string
  /** QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING | REQUESTED */
  status: string
  /** SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STALE | ERROR | EXPECTED | null */
  conclusion: string | null
  required: boolean
}

export interface ReviewThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
}

/** One commit of the PR, as far as the merge rules care: who signed it. */
export interface PrCommit {
  oid: string
  /** The first line of the message, for the person reading the verdict. */
  headline: string
  /** The rest of the message: where Dependabot writes each bump's `update-type`. */
  body: string
  /** GitHub verified the signature (`signature.state === VALID`). */
  signed: boolean
  signatureState: string | null
}

/**
 * Connections the read could not exhaust within `MAX_PAGES` (F08). A verdict
 * over a truncated connection would be a guess, so `canMerge` refuses instead.
 */
export interface PrTruncation {
  commits: boolean
  checks: boolean
  reviewThreads: boolean
}

export interface PrState {
  number: number
  title: string
  body: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  merged: boolean
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  /**
   * Who opened it, as REST spells it: a Bot carries the `[bot]` suffix
   * (`dependabot[bot]`), which GraphQL's `login` leaves off. Null when the
   * account is gone or the read predates the field.
   */
  authorLogin: string | null
  mergeStateStatus:
    | "BEHIND"
    | "BLOCKED"
    | "CLEAN"
    | "DIRTY"
    | "DRAFT"
    | "HAS_HOOKS"
    | "UNKNOWN"
    | "UNSTABLE"
  reviewDecision: string | null
  baseRefName: string
  headRefName: string
  headSha: string
  /** Every commit of the PR carries a signature GitHub verified (F08: `required_signatures` looks at all of them). */
  signed: boolean
  /** The first unsigned commit's state, or the head's when all are signed. */
  signatureState: string | null
  /** Every commit of the PR, oldest first, as far as the read got (see `truncated.commits`). */
  commits: PrCommit[]
  /**
   * `headSha` was among the commits read. The two come from different
   * connections (`headRefOid` and `commits`), so a force-push mid-read makes
   * them disagree — and then nothing verified the commit a squash pins to.
   */
  headInCommits: boolean
  statusCheckRollup: string | null
  checks: PrCheck[]
  reviewThreads: ReviewThread[]
  truncated: PrTruncation
  baseRule: {
    requiredStatusCheckContexts: string[]
    requiresSignatures: boolean
  } | null
}

/** GitHub's page size cap on these connections. */
export const PAGE_SIZE = 100
/** Pages per connection before the read gives up and says so (1000 nodes). */
export const MAX_PAGES = 10
/**
 * Extra page requests one `getPrState` may spend over all three connections.
 * The Cockpit's repository view reads up to 30 open PRs to paint one list, so
 * an unbounded read is a page that costs hundreds of requests.
 */
export const MAX_PAGES_PER_READ = 12

const CONTEXT_NODES = /* GraphQL */ `
  __typename
  ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
  ... on StatusContext { context state isRequired(pullRequestNumber: $number) }`

const COMMIT_NODES = /* GraphQL */ `
  commit { oid messageHeadline messageBody signature { isValid state } }`

/**
 * `totalCount` as well as the cursor: GitHub caps a PR's commit list (REST
 * says 250) by answering `hasNextPage: false` on a list it truncated itself,
 * and only the count says so.
 */
const PAGE_INFO = /* GraphQL */ `totalCount pageInfo { hasNextPage endCursor }`

/**
 * The base's gates come from `refUpdateRule` alone. `branchProtectionRule`
 * carries the same contexts and signing requirement but needs the
 * Administration permission, which the train's App does not have: on a
 * repository that actually has protection the whole query fails with
 * "Resource not accessible by integration". `refUpdateRule` is the view
 * GitHub gives any installation that can push; on a branch with classic
 * protection plus rulesets it names the required contexts and
 * `requiresSignatures`, which is all `canMerge` reads.
 */
export const PR_STATE_QUERY = /* GraphQL */ `
query PrState($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title body state isDraft merged mergedAt
      author { __typename login }
      mergeable mergeStateStatus reviewDecision
      baseRefName headRefName headRefOid
      baseRef { refUpdateRule { requiredStatusCheckContexts requiresSignatures } }
      headCommit: commits(last: 1) { nodes { commit {
        oid
        signature { isValid state signer { login } }
        statusCheckRollup { state contexts(first: ${PAGE_SIZE}) { ${PAGE_INFO} nodes { ${CONTEXT_NODES} } } }
      } } }
      commits(first: ${PAGE_SIZE}) { ${PAGE_INFO} nodes { ${COMMIT_NODES} } }
      reviewThreads(first: ${PAGE_SIZE}) { ${PAGE_INFO} nodes { id isResolved isOutdated } }
    }
  }
}`

/** One more page of the PR's commits (F08: every signature, not the head's). */
export const PR_COMMITS_PAGE_QUERY = /* GraphQL */ `
query PrCommitsPage($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: ${PAGE_SIZE}, after: $cursor) { ${PAGE_INFO} nodes { ${COMMIT_NODES} } }
    }
  }
}`

/** One more page of the head commit's check contexts. */
export const PR_CONTEXTS_PAGE_QUERY = /* GraphQL */ `
query PrContextsPage($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headCommit: commits(last: 1) { nodes { commit {
        oid
        statusCheckRollup { contexts(first: ${PAGE_SIZE}, after: $cursor) { ${PAGE_INFO} nodes { ${CONTEXT_NODES} } } }
      } } }
    }
  }
}`

/** One more page of review threads. */
export const PR_THREADS_PAGE_QUERY = /* GraphQL */ `
query PrThreadsPage($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${PAGE_SIZE}, after: $cursor) { ${PAGE_INFO} nodes { id isResolved isOutdated } }
    }
  }
}`

/* biome-ignore lint/suspicious/noExplicitAny: the raw GraphQL payload is shaped here, once. */
type Raw = any

interface Page<T> {
  nodes: T[]
  /** The cursor to continue from, or null when the connection is exhausted. */
  next: string | null
  /** `totalCount`, when the connection reported one. */
  total: number | null
  /** Nodes GitHub returned as null: items this token cannot see — a hole in the read, not an absence. */
  dropped: number
}

function page<T>(connection: Raw, shape: (node: Raw) => T): Page<T> {
  const raw: Raw[] = connection?.nodes ?? []
  const visible: Raw[] = raw.filter((n: Raw) => n != null)
  const info = connection?.pageInfo ?? null
  const next = info?.hasNextPage === true && info.endCursor != null ? String(info.endCursor) : null
  const total = typeof connection?.totalCount === "number" ? connection.totalCount : null
  return { nodes: visible.map(shape), next, total, dropped: raw.length - visible.length }
}

/**
 * A connection the read cannot claim to have seen whole: more pages, a node
 * this token cannot see, or fewer nodes than the connection's own count.
 */
function isTruncated(p: Pick<Page<unknown>, "next" | "total" | "dropped">, read: number): boolean {
  return p.next !== null || p.dropped > 0 || (p.total !== null && read !== p.total)
}

function shapeCheck(c: Raw): PrCheck {
  return c.__typename === "StatusContext"
    ? {
        name: String(c.context),
        status: c.state === "PENDING" || c.state === "EXPECTED" ? "PENDING" : "COMPLETED",
        conclusion: c.state === "PENDING" ? null : String(c.state),
        required: Boolean(c.isRequired),
      }
    : {
        name: String(c.name),
        status: String(c.status),
        conclusion:
          c.conclusion === null || c.conclusion === undefined ? null : String(c.conclusion),
        required: Boolean(c.isRequired),
      }
}

function shapeCommit(n: Raw): PrCommit {
  const c = n.commit ?? n
  return {
    oid: String(c.oid ?? ""),
    headline: String(c.messageHeadline ?? c.message ?? "").split("\n", 1)[0] ?? "",
    body: String(c.messageBody ?? ""),
    signed: c.signature?.isValid === true && c.signature?.state === "VALID",
    signatureState: c.signature?.state ?? null,
  }
}

/** GraphQL names a Bot `dependabot`; REST, webhooks and `gh` say `dependabot[bot]`. One spelling here. */
function authorLoginOf(author: Raw): string | null {
  if (!author || typeof author.login !== "string") return null
  return author.__typename === "Bot" ? `${author.login}[bot]` : author.login
}

function shapeThread(t: Raw): ReviewThread {
  return { id: String(t.id), isResolved: Boolean(t.isResolved), isOutdated: Boolean(t.isOutdated) }
}

/**
 * The signature verdict over every commit read so far: the first unsigned one
 * decides, and the head's own signature is one of them. The head arrives on
 * its own connection, so a commit list of signed commits says nothing about
 * the commit a squash would be pinned to.
 */
function signatureOf(
  commits: PrCommit[],
  head: PrCommit | null,
): Pick<PrState, "signed" | "signatureState"> {
  const unsigned = commits.find((c) => !c.signed)
  if (unsigned) return { signed: false, signatureState: unsigned.signatureState ?? "UNSIGNED" }
  if (head && !head.signed) {
    return { signed: false, signatureState: head.signatureState ?? "UNSIGNED" }
  }
  if (commits.length === 0) {
    return { signed: head?.signed ?? false, signatureState: head?.signatureState ?? null }
  }
  return {
    signed: true,
    signatureState: head?.signatureState ?? commits.at(-1)?.signatureState ?? null,
  }
}

/** The head is one of the commits the read verified, not a sha from elsewhere. */
function headIsInCommits(headSha: string, commits: PrCommit[]): boolean {
  return headSha !== "" && commits.some((c) => c.oid === headSha)
}

/**
 * The first page of each connection, parsed; `getPrState` follows the cursors.
 * Kept apart from the parse so fixtures can drive it.
 */
interface ParsedPage {
  state: PrState
  /** The head commit as `headCommit` returned it, for the signature verdict once every page is in. */
  head: PrCommit | null
  pages: { commits: Page<PrCommit>; checks: Page<PrCheck>; reviewThreads: Page<ReviewThread> }
}

function parseFirstPage(pr: Raw): ParsedPage {
  // Recorded fixtures predate the `headCommit` alias: there, `commits` is the
  // single head node and doubles as the commit list.
  const head: Raw = pr.headCommit?.nodes?.[0]?.commit ?? pr.commits?.nodes?.at(-1)?.commit ?? {}
  const rollup = head.statusCheckRollup ?? null
  const checks = page(rollup?.contexts, shapeCheck)
  const commits = page(pr.commits, shapeCommit)
  const threads = page(pr.reviewThreads, shapeThread)
  const headCommit = head.oid ? shapeCommit(head) : null
  const headSha = String(pr.headRefOid ?? head.oid ?? "")
  const rule = pr.baseRef?.refUpdateRule ?? null
  const state: PrState = {
    number: Number(pr.number),
    title: String(pr.title ?? ""),
    body: String(pr.body ?? ""),
    state: pr.state,
    isDraft: Boolean(pr.isDraft),
    merged: Boolean(pr.merged),
    mergeable: pr.mergeable ?? "UNKNOWN",
    mergeStateStatus: pr.mergeStateStatus ?? "UNKNOWN",
    reviewDecision: pr.reviewDecision ?? null,
    authorLogin: authorLoginOf(pr.author),
    baseRefName: String(pr.baseRefName),
    headRefName: String(pr.headRefName),
    headSha,
    ...signatureOf(commits.nodes, headCommit),
    commits: commits.nodes,
    headInCommits: headIsInCommits(headSha, commits.nodes),
    statusCheckRollup: rollup?.state ?? null,
    checks: checks.nodes,
    reviewThreads: threads.nodes,
    truncated: {
      commits: isTruncated(commits, commits.nodes.length),
      checks: isTruncated(checks, checks.nodes.length),
      reviewThreads: isTruncated(threads, threads.nodes.length),
    },
    baseRule: rule
      ? {
          requiredStatusCheckContexts: rule.requiredStatusCheckContexts ?? [],
          requiresSignatures: Boolean(rule.requiresSignatures),
        }
      : null,
  }
  return { state, head: headCommit, pages: { commits, checks, reviewThreads: threads } }
}

/**
 * Pure: shape one GraphQL payload. A connection whose `pageInfo` says there
 * is more stays `truncated`; only `getPrState` can follow the cursors.
 */
export function parsePrState(pr: Raw): PrState {
  return parseFirstPage(pr).state
}

/** The head moved between two pages of one read; the pages describe two commits. */
class HeadMovedError extends Error {
  constructor(repo: RepoRef, number: number, from: string, to: string) {
    super(
      `${repo.owner}/${repo.name}#${number}: head moved from ${from.slice(0, 7)} to ${to.slice(0, 7)} while the PR was read`,
    )
    this.name = "HeadMovedError"
  }
}

interface Drain<T> {
  client: GitHubClient
  vars: Record<string, unknown>
  query: string
  pick: (data: Raw) => Raw
  shape: (node: Raw) => T
  /** The first page, already parsed and already in `into`. */
  first: Page<T>
  into: T[]
  /** Requests left for this whole read, shared by the three connections. */
  budget: { left: number }
  /** True once the nodes read decide the verdict: the rest of the connection buys nothing. */
  decided?: (nodes: T[]) => boolean
  /** Sees each page's payload and throws when the head moved under the read. */
  guard?: (data: Raw) => void
}

/** Follow one connection's cursor until it is exhausted, decided, or bounded. */
async function drain<T>(d: Drain<T>): Promise<{ truncated: boolean }> {
  if (d.decided?.(d.into)) return { truncated: false }
  let cursor = d.first.next
  let dropped = d.first.dropped
  // The first page is already read; MAX_PAGES counts every page.
  for (let read = 1; cursor !== null; read++) {
    if (read >= MAX_PAGES || d.budget.left <= 0) return { truncated: true }
    d.budget.left--
    const data = await d.client.graphql<Raw>(d.query, { ...d.vars, cursor })
    d.guard?.(data)
    const next = page(d.pick(data), d.shape)
    d.into.push(...next.nodes)
    dropped += next.dropped
    cursor = next.next
    if (d.decided?.(d.into)) return { truncated: false }
  }
  return { truncated: isTruncated({ next: null, total: d.first.total, dropped }, d.into.length) }
}

export async function getPrState(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
): Promise<PrState> {
  // A head that moves between two pages makes the pages describe two commits;
  // the read is abandoned and taken again, once, before it gives up.
  for (let attempt = 0; ; attempt++) {
    try {
      return await readPrState(client, repo, number)
    } catch (err) {
      if (attempt >= 1 || !(err instanceof HeadMovedError)) throw err
    }
  }
}

async function readPrState(client: GitHubClient, repo: RepoRef, number: number): Promise<PrState> {
  const vars = { owner: repo.owner, name: repo.name, number }
  const data = await client.graphql<{ repository: { pullRequest: Raw } }>(PR_STATE_QUERY, vars)
  if (!data.repository?.pullRequest)
    throw new Error(`${repo.owner}/${repo.name}#${number} not found`)
  const { state, head, pages } = parseFirstPage(data.repository.pullRequest)
  const pr = (d: Raw) => d.repository?.pullRequest
  const budget = { left: MAX_PAGES_PER_READ }
  const commits = await drain({
    client,
    vars,
    query: PR_COMMITS_PAGE_QUERY,
    pick: (d) => pr(d)?.commits,
    shape: shapeCommit,
    first: pages.commits,
    into: state.commits,
    budget,
    // One unsigned commit is the whole verdict (F08); the remaining pages
    // cost requests and change nothing.
    decided: (nodes) => (head !== null && !head.signed) || nodes.some((c) => !c.signed),
  })
  const checks = await drain({
    client,
    vars,
    query: PR_CONTEXTS_PAGE_QUERY,
    pick: (d) => pr(d)?.headCommit?.nodes?.[0]?.commit?.statusCheckRollup?.contexts,
    shape: shapeCheck,
    first: pages.checks,
    into: state.checks,
    budget,
    guard: (d) => {
      const oid = pr(d)?.headCommit?.nodes?.[0]?.commit?.oid
      if (typeof oid === "string" && oid !== "" && oid !== state.headSha) {
        throw new HeadMovedError(repo, number, state.headSha, oid)
      }
    },
  })
  const threads = await drain({
    client,
    vars,
    query: PR_THREADS_PAGE_QUERY,
    pick: (d) => pr(d)?.reviewThreads,
    shape: shapeThread,
    first: pages.reviewThreads,
    into: state.reviewThreads,
    budget,
  })
  return {
    ...state,
    ...signatureOf(state.commits, head),
    headInCommits: headIsInCommits(state.headSha, state.commits),
    truncated: {
      commits: commits.truncated,
      checks: checks.truncated,
      reviewThreads: threads.truncated,
    },
  }
}

export type { MergeVerdict }

const RED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE"])
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])

/** `dev`, `promote/*`, `hotfix/*` and release heads are the only PRs into `main`. */
export function isPromotionHead(headRefName: string): boolean {
  return (
    headRefName === "dev" ||
    headRefName.startsWith("promote/") ||
    headRefName.startsWith("hotfix/") ||
    headRefName.startsWith("release-please--")
  )
}

/**
 * Whether merging this PR is a Release Approval: a decision only the
 * repository's owner takes, for a dev release as much as for a production one. A Release PR
 * (`release/<base>`) deploys the moment it merges — a beta onto preview from
 * `dev`, a stable version onto production from `main`. A promotion head into
 * `main` (`dev`, `promote/*`, `hotfix/*`) is the step the production Release
 * PR is built from. Feature work and the engine's own backmerge are neither.
 * `bin/merge-pr.ts` refuses the first two without `--release-approval`: a
 * blanket "merge everything" must never put a version on production unasked.
 */
export type ReleaseApprovalNeed =
  | { required: false }
  | {
      required: true
      kind: "release" | "promotion"
      deploys: "preview" | "production"
      reason: string
    }

export function releaseApprovalFor(pr: {
  baseRefName: string
  headRefName: string
}): ReleaseApprovalNeed {
  const { baseRefName: base, headRefName: head } = pr
  if (head.startsWith("release/") || head.startsWith("release-please--")) {
    const deploys = base === "main" ? "production" : "preview"
    return {
      required: true,
      kind: "release",
      deploys,
      reason: `the Release PR on \`${base}\`: merging it is the release and deploys ${deploys}`,
    }
  }
  if (base === "main" && isPromotionHead(head)) {
    return {
      required: true,
      kind: "promotion",
      deploys: "production",
      reason: `a promotion of \`${head}\` into \`main\`, the step the production release is built from`,
    }
  }
  return { required: false }
}

/**
 * The one check every repository on the slim pipeline emits: the
 * caller's job `pipeline` calling the reusable job `Check`. A PR without it
 * is pending, never green — an unmigrated repository cannot merge by accident.
 */
export const REQUIRED_CHECKS: readonly string[] = ["pipeline / Check"]

export interface CanMergeOptions {
  /** Check names that must have reported SUCCESS; a missing one is pending, not green. Defaults to REQUIRED_CHECKS. */
  requiredChecks?: readonly string[]
  /**
   * Skip the base-protection contexts rule. `mergeFallbackAdvice` asks "is
   * anything *but* a required context in the way?", and that rule answers a
   * required-context question with a required-context refusal.
   */
  skipBaseProtection?: boolean
}

/**
 * The train is the only merge gate where no ruleset enforces one: Check green, every
 * commit signed, review threads resolved. `mergeable` and `mergeStateStatus` are
 * both consulted — a PR can be BLOCKED with every check green. Approvals are
 * never consulted: the org rulesets require zero, so "cannot self-approve"
 * is never a real diagnosis.
 */
export function canMerge(pr: PrState, opts: CanMergeOptions = {}): MergeVerdict {
  const no = (
    code: Exclude<MergeVerdict, { ok: true }>["code"],
    reason: string,
    remedy?: Exclude<MergeVerdict, { ok: true }>["remedy"],
  ): MergeVerdict => (remedy ? { ok: false, code, reason, remedy } : { ok: false, code, reason })

  if (pr.merged || pr.state === "MERGED")
    return no("merged", `#${pr.number} is already merged`, "none")
  if (pr.state === "CLOSED") return no("closed", `#${pr.number} is closed`, "none")
  if (pr.isDraft || pr.mergeStateStatus === "DRAFT")
    return no("draft", `#${pr.number} is a draft`, "fix")
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return no(
      "conflicting",
      `#${pr.number} conflicts with ${pr.baseRefName}; resolve on a branch, the merge button cannot`,
      "resolve_on_branch",
    )
  }

  // F08: a verdict over a connection the read could not exhaust is a guess.
  const bound = MAX_PAGES * PAGE_SIZE
  const whole = `over ${bound}, or hidden from this token`
  if (pr.truncated.commits) {
    return no(
      "blocked",
      `#${pr.number} has commits this read could not see (${whole}): too many commits to verify every signature; split the PR`,
      "fix",
    )
  }
  if (pr.truncated.checks) {
    return no(
      "blocked",
      `head ${pr.headSha.slice(0, 7)} has check contexts this read could not see (${whole}): too many checks to verify`,
      "fix",
    )
  }
  if (pr.truncated.reviewThreads) {
    return no(
      "blocked",
      `#${pr.number} has review threads this read could not see (${whole}): too many review threads to verify`,
      "fix",
    )
  }

  const red = pr.checks.filter((c) => c.conclusion !== null && RED.has(c.conclusion))
  if (red.length > 0) {
    return no("checks_red", `red checks: ${red.map((c) => c.name).join(", ")}`, "fix")
  }
  const pending = pr.checks.filter((c) => c.status !== "COMPLETED" || c.conclusion === null)
  if (pending.length > 0 || pr.statusCheckRollup === "PENDING") {
    const names = pending.map((c) => c.name).join(", ") || "status rollup"
    return no("checks_pending", `checks still running: ${names}`, "wait")
  }
  // Before either wait below: signing emits no check-run, so a PR whose real
  // blocker is a signature would otherwise sit behind a required context that
  // never reports — a permanent wait on the wrong thing (F08).
  if (!pr.signed) {
    const unsigned = pr.commits.find((c) => !c.signed)
    const which = unsigned
      ? `commit ${unsigned.oid.slice(0, 7)} "${unsigned.headline}" is ${unsigned.signatureState ?? "unsigned"}`
      : `head ${pr.headSha.slice(0, 7)} is ${pr.signatureState ?? "unsigned"}`
    return no(
      "unsigned",
      `${which}; required_signatures emits no check-run, so nothing else will say so`,
      "fix",
    )
  }
  // The squash is pinned to `headSha`. A commit list that does not
  // contain it verified other commits than the one that would merge.
  if (!pr.headInCommits) {
    return no(
      "blocked",
      `head ${pr.headSha.slice(0, 7)} is not among the commits read (${pr.commits.length}): the branch moved under the read, so nothing verified the commit a merge would pin to; read the PR again`,
      "fix",
    )
  }
  const required = opts.requiredChecks ?? REQUIRED_CHECKS
  for (const name of required) {
    const check = pr.checks.find((c) => c.name === name)
    if (check?.conclusion !== "SUCCESS") {
      return no(
        "checks_pending",
        check
          ? `required check ${name} is ${check.conclusion}, not SUCCESS`
          : `required check ${name} has not reported`,
        "wait",
      )
    }
  }
  // A context the base's protection requires that never reported: GitHub
  // will not merge either, and its rollup does not say why.
  for (const name of opts.skipBaseProtection
    ? []
    : (pr.baseRule?.requiredStatusCheckContexts ?? [])) {
    if (required.includes(name) || pr.checks.some((c) => c.name === name)) continue
    return no(
      "checks_pending",
      `${pr.baseRefName}'s protection requires ${name}, which has not reported`,
      "wait",
    )
  }
  const unexpected = pr.checks.filter((c) => c.conclusion !== null && !GREEN.has(c.conclusion))
  if (unexpected.length > 0) {
    return no(
      "checks_red",
      `checks not green: ${unexpected.map((c) => `${c.name}=${c.conclusion}`).join(", ")}`,
      "fix",
    )
  }

  const open = pr.reviewThreads.filter((t) => !t.isResolved && !t.isOutdated)
  if (open.length > 0) {
    return no(
      "unresolved_threads",
      `${open.length} unresolved review thread(s); reply in-thread and resolve each`,
      "fix",
    )
  }
  if (pr.mergeStateStatus === "BEHIND") {
    if (isPromotionHead(pr.headRefName)) {
      return no(
        "behind",
        `${pr.headRefName} is behind ${pr.baseRefName} and a squash-only head can never catch up: build a promote/* branch from ${pr.baseRefName}, never back-merge`,
        "promote_branch",
      )
    }
    return no(
      "behind",
      `${pr.headRefName} is behind ${pr.baseRefName}; update the branch`,
      "update_branch",
    )
  }
  if (pr.mergeStateStatus === "BLOCKED") {
    return no(
      "blocked",
      "BLOCKED with every check green, every commit signed and no open thread: usually an unsigned commit or an unresolved review thread that this read missed; check the base's protection flags",
      "fix",
    )
  }
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN") {
    return no("unknown", "GitHub is still computing mergeability; read again", "wait")
  }
  if (pr.mergeStateStatus === "UNSTABLE") {
    return no(
      "checks_red",
      "GitHub reports a non-passing status that the rollup did not list",
      "fix",
    )
  }
  return { ok: true }
}

/**
 * While a repository's pipeline does not emit `pipeline / Check` yet,
 * the train's gate waits forever on a context that never reports, although
 * GitHub itself would merge. When that missing required context is the
 * *only* thing in the way — every check that did report is green, no open
 * thread, the head signed, GitHub says MERGEABLE and CLEAN — this names the
 * operator's fallback with the real numbers. A required context that *did*
 * report, only not SUCCESS (SKIPPED, NEUTRAL), is a pipeline that runs here
 * and has not said yes: waiting, not the fallback. Anything else (red,
 * pending, BLOCKED, BEHIND, a conflict) is null too: `gh` would refuse, or
 * waiting is the right answer.
 */
export function mergeFallbackAdvice(
  pr: PrState,
  repo: RepoRef,
  number: number,
  opts: CanMergeOptions = {},
): string | null {
  const strict = canMerge(pr, opts)
  if (strict.ok || strict.code !== "checks_pending") return null
  // Without the base-protection rule: it refuses on a missing required
  // context too, which is the very question being asked here.
  const lenient = canMerge(pr, { requiredChecks: [], skipBaseProtection: true })
  if (!lenient.ok) return null
  if (pr.mergeable !== "MERGEABLE" || pr.mergeStateStatus !== "CLEAN") return null
  const required = opts.requiredChecks ?? REQUIRED_CHECKS
  const missing = required.filter((name) => !pr.checks.some((c) => c.name === name))
  const reported = required.filter((name) =>
    pr.checks.some((c) => c.name === name && c.conclusion !== "SUCCESS"),
  )
  if (missing.length === 0 || reported.length > 0) return null
  return [
    `The train's gate waits for ${missing.map((n) => `\`${n}\``).join(", ")}, which this repository does not emit (yet); nothing else is in the way.`,
    "Fallback: once GitHub shows the PR MERGEABLE and CLEAN and every check that did report is green, the operator merges by hand:",
    `  gh pr merge ${number} --squash --delete-branch -R ${repo.owner}/${repo.name}`,
  ].join("\n")
}
