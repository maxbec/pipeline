/**
 * Merge one PR through the train's rules, by hand.
 *
 *   node train/bin/merge-pr.ts acme/widgets 11 [--dry-run] [--auth gh|env] [--method squash|merge]
 *                                              [--release-approval "<the owner's go, quoted, with its date>"]
 *
 * Reads the PR deterministically, prints the verdict, merges pinned to the
 * head it decided on — by merge commit for a promotion, a backmerge and
 * anything into `main` of a major repository, squashed otherwise
 * (`mergeMethodFor`; `--method` overrides it) — then reads
 * the merge commit back and prints whether GitHub verified its signature —
 * the property `required_signatures` actually checks. When the only blocker
 * is a required context the repository does not emit yet, it prints the
 * fallback (`gh pr merge`) with the real numbers and exits 1. `--auth gh`
 * (the default) uses the gh CLI's token; `--auth env` reads `GITHUB_TOKEN`.
 *
 * A Release PR or a promotion into `main` is a Release Approval, which only
 * the repository's owner gives (`releaseApprovalFor`). Without
 * `--release-approval` the script stops at exit 4 and says so, dry run or
 * not. The value is the owner's go for this PR, quoted with its date; it is
 * printed with the merge so the transcript carries it. A blanket "merge
 * everything" is not a go: the flag is passed only after the owner named this
 * PR, this release, or this repository and version.
 */
import { parseArgs } from "node:util"
import { envTokenProvider, ghCliTokenProvider } from "../src/github/app-auth.ts"
import { GitHubClient } from "../src/github/client.ts"
import {
  type MergeMethod,
  mergeMethodFor,
  mergePullRequest,
  repositoryKindOf,
  verifyCommitSigned,
} from "../src/github/merge.ts"
import { canMerge, getPrState, mergeFallbackAdvice, releaseApprovalFor } from "../src/github/pr.ts"

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    auth: { type: "string", default: "gh" },
    method: { type: "string" },
    "release-approval": { type: "string" },
  },
})
const [slug, numberArg] = positionals
if (!slug || !numberArg) {
  console.error(
    'usage: merge-pr.ts <owner/repo> <number> [--dry-run] [--auth gh|env] [--method squash|merge] [--release-approval "<the owner\'s go>"]',
  )
  process.exit(2)
}
if (values.method !== undefined && values.method !== "squash" && values.method !== "merge") {
  console.error(`--method must be squash or merge, not ${values.method}`)
  process.exit(2)
}
const approval = values["release-approval"]?.trim() ?? null
if (values["release-approval"] !== undefined && !approval) {
  console.error(
    "--release-approval must carry the owner's go for this PR, quoted with its date; an empty flag is not one",
  )
  process.exit(2)
}
if (values.auth !== "gh" && values.auth !== "env") {
  console.error(`--auth must be gh or env, not ${values.auth}`)
  process.exit(2)
}
const [owner, name] = slug.split("/") as [string, string]
const number = Number(numberArg)

const tokens = values.auth === "env" ? envTokenProvider("GITHUB_TOKEN") : ghCliTokenProvider()
const client = new GitHubClient({ tokens })
const repo = { owner, name }

const state = await getPrState(client, repo, number)
const verdict = canMerge(state)
const method: MergeMethod =
  (values.method as MergeMethod | undefined) ??
  mergeMethodFor(state, await repositoryKindOf(client, repo))
const need = releaseApprovalFor(state)
console.log(
  JSON.stringify(
    {
      pr: `${slug}#${number}`,
      head: state.headSha,
      base: state.baseRefName,
      mergeable: state.mergeable,
      mergeStateStatus: state.mergeStateStatus,
      signed: state.signed,
      method,
      checks: state.checks.map((c) => `${c.name}=${c.conclusion ?? c.status}`),
      verdict,
      releaseApproval: need.required
        ? { required: true, kind: need.kind, deploys: need.deploys, given: approval }
        : { required: false },
    },
    null,
    2,
  ),
)
if (!verdict.ok) {
  // A required context this repository never emits is not a reason to
  // wait forever; say exactly what the operator runs instead, and when.
  const fallback = mergeFallbackAdvice(state, repo, number)
  if (fallback) console.error(`\n${fallback}`)
  process.exit(1)
}
if (need.required && !approval) {
  // The gates are green, so this is the one decision left, and it is the owner's.
  console.error(
    [
      "",
      `#${number} is ${need.reason}. That merge is a Release Approval: the owner's, never an agent's.`,
      "Report it ready (verdict, checks, signature, method, what ships) and ask. Once the owner has",
      "given the go for this PR, rerun with:",
      `  --release-approval "<the owner's words, with the date>"`,
      'A blanket "merge everything" is not a go.',
    ].join("\n"),
  )
  process.exit(4)
}
if (values["dry-run"]) process.exit(0)

const merged = await mergePullRequest(client, repo, number, {
  method,
  expectedHeadSha: state.headSha,
  title: `${state.title} (#${number})`,
  body: state.body,
})
const verification = await verifyCommitSigned(client, repo, merged.sha)
console.log(
  JSON.stringify(
    { merged: merged.sha, verification, ...(approval ? { releaseApproval: approval } : {}) },
    null,
    2,
  ),
)
process.exit(verification.verified ? 0 : 1)
