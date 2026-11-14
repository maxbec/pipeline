import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import {
  canMerge,
  type MergeVerdict,
  mergeFallbackAdvice,
  type PrState,
  parsePrState,
  releaseApprovalFor,
} from "../../src/github/pr.ts"
import { backmergeHeadFor } from "../../src/release/backmerge.ts"
import { PROMOTION_HEAD, releaseHeadFor } from "../../src/release/sync.ts"

/** Narrow to the refusal branch so the reason can be asserted on. */
function refused(v: MergeVerdict): Extract<MergeVerdict, { ok: false }> {
  assert.equal(v.ok, false)
  return v as Extract<MergeVerdict, { ok: false }>
}

const fixtures = join(import.meta.dirname, "..", "fixtures", "github")
function fixture(name: string): PrState {
  const raw = JSON.parse(readFileSync(join(fixtures, `pr-${name}.json`), "utf8"))
  return parsePrState(raw.data.repository.pullRequest)
}

/** The recorded CLEAN, signed, green PR, tweaked per case. */
function clean(patch: Partial<PrState> = {}): PrState {
  return { ...fixture("acme-widgets-3"), ...patch }
}

test("a recorded CLEAN, signed, green PR is mergeable", () => {
  const state = fixture("acme-widgets-3")
  assert.equal(state.headSha, "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567")
  assert.equal(state.signed, true)
  assert.equal(state.statusCheckRollup, "SUCCESS")
  assert.ok(state.checks.some((c) => c.name === "pipeline / Check" && c.conclusion === "SUCCESS"))
  assert.deepEqual(canMerge(state), { ok: true })
})

test("a red check refuses with the check named", () => {
  const state = clean({
    checks: [
      ...clean().checks,
      { name: "pipeline / Check", status: "COMPLETED", conclusion: "FAILURE", required: false },
    ],
    statusCheckRollup: "FAILURE",
  })
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "checks_red")
  assert.match(verdict.reason, /pipeline \/ Check/)
})

test("a pending check is not a red check", () => {
  const state = clean({
    checks: [
      { name: "pipeline / Check", status: "IN_PROGRESS", conclusion: null, required: false },
    ],
    statusCheckRollup: "PENDING",
    mergeStateStatus: "UNSTABLE",
  })
  assert.equal(refused(canMerge(state)).code, "checks_pending")
})

test("a required check that never reported is pending, not green", () => {
  const verdict = refused(canMerge(clean(), { requiredChecks: ["pipeline / Check", "Verify"] }))
  assert.equal(verdict.code, "checks_pending")
  assert.match(verdict.reason, /Verify/)
})

test("BEHIND on a feature head wants update-branch; on a promotion head it wants a promote/* branch", () => {
  const feature = refused(canMerge(clean({ mergeStateStatus: "BEHIND" })))
  assert.equal(feature.code, "behind")
  assert.equal(feature.remedy, "update_branch")

  const promotion = refused(
    canMerge(clean({ mergeStateStatus: "BEHIND", headRefName: "dev", baseRefName: "main" })),
  )
  assert.equal(promotion.code, "behind")
  assert.equal(promotion.remedy, "promote_branch")
  assert.match(promotion.reason, /promote\//)
  assert.doesNotMatch(promotion.reason, /back-merge main into dev/)
})

test("CONFLICTING is a real conflict, resolved on a branch, never by the merge button", () => {
  const verdict = refused(canMerge(clean({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })))
  assert.equal(verdict.code, "conflicting")
})

test("BLOCKED with every check green names the two silent gates", () => {
  const unsigned = refused(
    canMerge(clean({ mergeStateStatus: "BLOCKED", signed: false, signatureState: "UNSIGNED" })),
  )
  assert.equal(unsigned.code, "unsigned")
  assert.match(unsigned.reason, /required_signatures/)

  const thread = refused(
    canMerge(
      clean({
        mergeStateStatus: "BLOCKED",
        reviewThreads: [{ id: "T1", isResolved: false, isOutdated: false }],
      }),
    ),
  )
  assert.equal(thread.code, "unresolved_threads")

  const silent = refused(canMerge(clean({ mergeStateStatus: "BLOCKED" })))
  assert.equal(silent.code, "blocked")
  assert.match(silent.reason, /unsigned commit|unresolved review thread/)
})

test("an unresolved review thread blocks even when GitHub says CLEAN; an outdated one does not", () => {
  const open = refused(
    canMerge(clean({ reviewThreads: [{ id: "T1", isResolved: false, isOutdated: false }] })),
  )
  assert.equal(open.code, "unresolved_threads")
  const outdated = canMerge(
    clean({ reviewThreads: [{ id: "T1", isResolved: false, isOutdated: true }] }),
  )
  assert.deepEqual(outdated, { ok: true })
})

test("approvals are never a reason: the orgs require zero", () => {
  assert.deepEqual(canMerge(clean({ reviewDecision: "REVIEW_REQUIRED" })), { ok: true })
})

test("draft, closed, merged and UNKNOWN are each their own answer", () => {
  assert.equal(refused(canMerge(clean({ isDraft: true }))).code, "draft")
  assert.equal(refused(canMerge(clean({ state: "CLOSED" }))).code, "closed")
  assert.equal(refused(canMerge(fixture("acme-widgets-10"))).code, "merged")
  assert.equal(
    refused(canMerge(clean({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }))).code,
    "unknown",
  )
})

test("parsePrState reads a merged PR's fixture without inventing a rollup", () => {
  const merged = fixture("acme-gadgets-74")
  assert.equal(merged.merged, true)
  assert.equal(merged.signed, true)
  assert.equal(merged.mergeable, "UNKNOWN")
})

test("when the only blocker is a required context that never reported, the fallback names the exact command", () => {
  const repo = { owner: "acme", name: "widgets" }
  const missing = clean({ checks: clean().checks.filter((c) => c.name !== "pipeline / Check") })
  assert.equal(refused(canMerge(missing)).code, "checks_pending")
  const advice = mergeFallbackAdvice(missing, repo, 57)
  assert.ok(advice)
  assert.match(advice, /pipeline \/ Check/)
  assert.match(advice, /gh pr merge 57 --squash --delete-branch -R acme\/widgets/)
  assert.match(advice, /MERGEABLE/)
  assert.match(advice, /CLEAN/)
  assert.match(advice, /green/)
  assert.match(advice, /Fallback: /)

  assert.equal(mergeFallbackAdvice(clean(), repo, 57), null, "a mergeable PR needs no fallback")
  const pending = clean({
    checks: missing.checks.map((c) =>
      c.name === "Branch Guard" ? { ...c, status: "IN_PROGRESS", conclusion: null } : c,
    ),
  })
  assert.equal(mergeFallbackAdvice(pending, repo, 57), null, "a check still running is a wait")
  const red = clean({
    checks: missing.checks.map((c) =>
      c.name === "Branch Guard" ? { ...c, conclusion: "FAILURE" } : c,
    ),
  })
  assert.equal(mergeFallbackAdvice(red, repo, 57), null, "red is red")
  const blocked = clean({ checks: missing.checks, mergeStateStatus: "BLOCKED" })
  assert.equal(mergeFallbackAdvice(blocked, repo, 57), null, "GitHub itself refuses: gh would too")
  const behind = clean({ checks: missing.checks, mergeStateStatus: "BEHIND" })
  assert.equal(mergeFallbackAdvice(behind, repo, 57), null, "not CLEAN")
})

test("a required context that reported SKIPPED or NEUTRAL is not the fallback case: no fallback", () => {
  const repo = { owner: "acme", name: "widgets" }
  for (const conclusion of ["SKIPPED", "NEUTRAL"]) {
    const reported = clean({
      checks: clean().checks.map((c) =>
        c.name === "pipeline / Check" ? { ...c, status: "COMPLETED", conclusion } : c,
      ),
    })
    assert.equal(refused(canMerge(reported)).code, "checks_pending", conclusion)
    assert.equal(
      mergeFallbackAdvice(reported, repo, 57),
      null,
      `${conclusion}: the pipeline runs here, it just did not say SUCCESS`,
    )
  }
})

test("parsePrState keeps every commit of the PR and an unsigned one in the middle unsigns it", () => {
  const raw = JSON.parse(readFileSync(join(fixtures, "pr-acme-widgets-3.json"), "utf8")).data
    .repository.pullRequest
  const commit = (oid: string, headline: string, state: string) => ({
    commit: { oid, messageHeadline: headline, signature: { isValid: state === "VALID", state } },
  })
  raw.headCommit = raw.commits
  raw.commits = {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      commit("1111111aaaaaaaa", "feat: first", "VALID"),
      commit("2222222bbbbbbbb", "wip: local fixup\n\nnot signed", "UNSIGNED"),
      commit("0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", "feat: head", "VALID"),
    ],
  }
  const state = parsePrState(raw)
  assert.equal(state.commits.length, 3)
  assert.equal(state.headSha, "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567")
  assert.equal(state.signed, false)
  assert.equal(state.signatureState, "UNSIGNED")
  assert.ok(state.checks.length > 0, "the head's rollup is still read from headCommit")
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "unsigned")
  assert.match(verdict.reason, /2222222 /)
  assert.match(verdict.reason, /wip: local fixup/)
  assert.doesNotMatch(verdict.reason, /not signed/)
})

test("a context the base's protection requires that never reported is pending, named as such", () => {
  const state = clean({
    baseRule: {
      requiredStatusCheckContexts: ["Check Gate"],
      requiresSignatures: true,
    },
  })
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "checks_pending")
  assert.match(verdict.reason, /Check Gate/)
  assert.match(verdict.reason, /protection/)
  const satisfied = clean({
    baseRule: {
      requiredStatusCheckContexts: ["pipeline / Check"],
      requiresSignatures: true,
    },
  })
  assert.deepEqual(canMerge(satisfied), { ok: true })
})

/** The recorded PR as raw GraphQL, so the parse rules can be driven directly. */
function raw(): Record<string, /* biome-ignore lint/suspicious/noExplicitAny: raw payload */ any> {
  return JSON.parse(readFileSync(join(fixtures, "pr-acme-widgets-3.json"), "utf8")).data.repository
    .pullRequest
}

const HEAD = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567"

function commitNode(oid: string, headline: string, state: string | null) {
  return {
    commit: {
      oid,
      messageHeadline: headline,
      signature: state === null ? null : { isValid: state === "VALID", state },
    },
  }
}

/** Move the recorded head node aside so `commits` can be scripted per case. */
function withCommits(
  pr: ReturnType<typeof raw>,
  nodes: unknown[],
  patch: { totalCount?: number; hasNextPage?: boolean } = {},
) {
  pr.headCommit = pr.commits
  pr.commits = {
    ...(patch.totalCount === undefined ? {} : { totalCount: patch.totalCount }),
    pageInfo: {
      hasNextPage: patch.hasNextPage ?? false,
      endCursor: patch.hasNextPage ? "1" : null,
    },
    nodes,
  }
  return pr
}

const protectedBase = {
  requiredStatusCheckContexts: ["Check Gate"],
  requiresSignatures: true,
}

test("an unsigned commit is named before any wait on a context that never reports", () => {
  const state = clean({ signed: false, signatureState: "UNSIGNED", baseRule: protectedBase })
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "unsigned", "signing emits no check-run: that wait is permanent")
  assert.match(verdict.reason, /required_signatures/)

  const alsoMissingRequired = refused(
    canMerge(clean({ signed: false, signatureState: "UNSIGNED" }), {
      requiredChecks: ["pipeline / Check", "Verify"],
    }),
  )
  assert.equal(alsoMissingRequired.code, "unsigned")
})

test("the fallback survives a protected base: the lenient read ignores base protection", () => {
  const repo = { owner: "acme", name: "widgets" }
  const state = clean({
    checks: clean().checks.filter((c) => c.name !== "pipeline / Check"),
    baseRule: protectedBase,
  })
  assert.equal(refused(canMerge(state)).code, "checks_pending")
  const advice = mergeFallbackAdvice(state, repo, 57)
  assert.ok(advice, "a base rule must not silently swallow the operator's escape")
  assert.match(advice, /pipeline \/ Check/)
  assert.match(advice, /gh pr merge 57 --squash/)
})

test("the head's own signature is required, however the commit list looks", () => {
  const pr = withCommits(raw(), [commitNode(HEAD, "feat: head", "VALID")])
  pr.headCommit.nodes[0].commit.signature = { isValid: false, state: "UNSIGNED" }
  const state = parsePrState(pr)
  assert.equal(state.signed, false, "the head is what a squash is pinned to")
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "unsigned")
  assert.match(verdict.reason, /0a1b2c3/)
})

test("a head sha absent from the commits read is refused, never assumed verified", () => {
  const pr = withCommits(raw(), [commitNode("aaaaaaa1111111", "feat: elsewhere", "VALID")])
  const state = parsePrState(pr)
  assert.equal(state.headInCommits, false)
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "blocked")
  assert.match(verdict.reason, /0a1b2c3/)
  assert.match(verdict.reason, /not among the commits/)
})

test("a commit with no signature at all is unsigned, not silently verified", () => {
  const pr = withCommits(raw(), [commitNode(HEAD, "feat: head", null)])
  const state = parsePrState(pr)
  assert.equal(state.signed, false)
  assert.equal(state.commits[0]?.signatureState, null, "no signature object at all")
  assert.equal(state.signatureState, "UNSIGNED", "which reads as unsigned, never as verified")
  assert.equal(refused(canMerge(state)).code, "unsigned")
})

test("a connection shorter than its totalCount is truncated, whatever pageInfo claims", () => {
  const pr = withCommits(raw(), [commitNode(HEAD, "feat: head", "VALID")], { totalCount: 300 })
  const state = parsePrState(pr)
  assert.equal(state.truncated.commits, true, "GitHub caps the commit list without saying so")
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "blocked")
  assert.match(verdict.reason, /too many commits to verify/)
})

test("a node this token cannot see is a hole in the read, not an absence", () => {
  const pr = withCommits(raw(), [commitNode(HEAD, "feat: head", "VALID")])
  pr.reviewThreads = {
    totalCount: 2,
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [null, { id: "T1", isResolved: true, isOutdated: false }],
  }
  const state = parsePrState(pr)
  assert.equal(state.reviewThreads.length, 1)
  assert.equal(state.truncated.reviewThreads, true)
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "blocked")
  assert.match(verdict.reason, /review threads/)
})

test("check contexts the read could not exhaust refuse before any check is judged", () => {
  const state = clean({ truncated: { commits: false, checks: true, reviewThreads: false } })
  const verdict = refused(canMerge(state))
  assert.equal(verdict.code, "blocked")
  assert.match(verdict.reason, /check contexts/)
})

test("a Release PR and a promotion into main are the owner's Release Approval; feature work and a backmerge are not", () => {
  const need = (headRefName: string, baseRefName: string) =>
    releaseApprovalFor({ headRefName, baseRefName })
  const gated = (headRefName: string, baseRefName: string) => {
    const n = need(headRefName, baseRefName)
    assert.equal(n.required, true, `${headRefName} -> ${baseRefName}`)
    return n as Extract<ReturnType<typeof releaseApprovalFor>, { required: true }>
  }
  // The heads the release engine opens, by its own names.
  const beta = gated(releaseHeadFor("dev"), "dev")
  assert.equal(beta.kind, "release")
  assert.equal(beta.deploys, "preview", "a beta Release PR deploys preview the moment it merges")
  assert.match(beta.reason, /Release PR on `dev`/)
  const stable = gated(releaseHeadFor("main"), "main")
  assert.equal(stable.kind, "release")
  assert.equal(stable.deploys, "production")
  const promotion = gated(PROMOTION_HEAD, "main")
  assert.equal(promotion.kind, "promotion")
  assert.equal(promotion.deploys, "production")
  assert.match(promotion.reason, /promotion of `promote\/main` into `main`/)
  // A promotion straight from dev, a hotfix, and the legacy release-please head.
  assert.equal(gated("dev", "main").kind, "promotion")
  assert.equal(gated("hotfix/y", "main").kind, "promotion")
  assert.equal(gated("release-please--branches--main", "main").kind, "release")
  // What a session may merge on its own once the gates are green.
  assert.deepEqual(need(backmergeHeadFor("0.12.0"), "dev"), { required: false })
  assert.deepEqual(need("feat/x", "dev"), { required: false })
  assert.deepEqual(
    need("fix/z", "main"),
    { required: false },
    "a small repository's only branch; Guard, not this, decides who may target main",
  )
  assert.deepEqual(need("dev", "staging"), { required: false }, "dev promotes into main only")
})
