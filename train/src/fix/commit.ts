/**
 * The commit job: turn a proposal into a signed commit, or into a comment.
 *
 * It holds the token that can write, so it never checks the branch out and
 * trusts nothing the propose job produced. The pull request is read again,
 * the list of files it changes comes from GitHub, every file's previous
 * content is loaded at the head the run failed on, and the guard decides.
 * The commit is made through `createCommitOnBranch` with that head as the
 * expected one: if anyone pushed in between, GitHub refuses it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type GitHubClient, GitHubGraphQLError, GitHubHttpError } from "../github/client.ts"
import { createSignedCommit } from "../github/merge.ts"
import type { RepoRef } from "../github/pr.ts"
import { addLabel, fileAt, getPull, listPullFiles, postComment } from "./api.ts"
import { type FixChange, guardFix, looksLikeSecret, MAX_BYTES, MAX_FILES } from "./guard.ts"
import { attemptMarker, CHECK_JOB, MAX_ATTEMPTS, NEEDS_HUMAN } from "./triage.ts"

export interface CommitInput {
  client: GitHubClient
  repo: RepoRef
  pr: number
  /** The head the failed run was on, and the only one a fix is committed onto. */
  headSha: string
  attempt: number
  /** Where the propose job's `changes.json` and `diagnosis.txt` were downloaded to; may not exist. */
  outputDir: string
  log?: (message: string) => void
}

export type CommitOutcome =
  /** The head moved or the pull request closed: someone else is on it, nothing is written. */
  | { outcome: "moved" }
  | { outcome: "unchanged" }
  | { outcome: "refused"; reasons: string[] }
  | { outcome: "committed"; oid: string }

const NO_PROPOSAL = "The propose job left no result: it failed, timed out or was cancelled.\n"
const TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>"
const HEADLINE_MAX = 72

interface Proposal {
  changes: { path: string; after: string | null; unreadable?: string }[]
  /** Set when `changes.json` is not what `collect` writes. */
  malformed: string | null
  diagnosis: string
}

function readProposal(dir: string): Proposal {
  let diagnosis = NO_PROPOSAL
  try {
    diagnosis = readFileSync(join(dir, "diagnosis.txt"), "utf8").slice(0, 4000)
  } catch {}
  if (!diagnosis.trim()) diagnosis = NO_PROPOSAL
  if (looksLikeSecret(diagnosis)) diagnosis = "The diagnosis was withheld: it contains text shaped like a secret.\n"

  let raw: string
  try {
    raw = readFileSync(join(dir, "changes.json"), "utf8")
  } catch {
    return { changes: [], malformed: null, diagnosis }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { changes: [], malformed: "changes.json is not JSON", diagnosis }
  }
  if (!Array.isArray(parsed)) return { changes: [], malformed: "changes.json is not a list", diagnosis }
  const changes: Proposal["changes"] = []
  const seen = new Set<string>()
  for (const item of parsed as unknown[]) {
    const c = item as { path?: unknown; after?: unknown; unreadable?: unknown } | null
    if (
      !c ||
      typeof c !== "object" ||
      typeof c.path !== "string" ||
      !(typeof c.after === "string" || c.after === null) ||
      !(c.unreadable === undefined || typeof c.unreadable === "string") ||
      seen.has(c.path)
    ) {
      return { changes: [], malformed: "changes.json holds an entry that is not a change", diagnosis }
    }
    seen.add(c.path)
    changes.push({ path: c.path, after: c.after, unreadable: c.unreadable })
  }
  return { changes, malformed: null, diagnosis }
}

/** One line, no mention, no markup that could end the comment's code block. */
function plain(text: string): string {
  return Array.from(text, (ch) => ((ch.codePointAt(0) ?? 0) < 32 || ch === "\u007f" ? " " : ch))
    .join("")
    .replace(/[@`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function fixHeadline(diagnosis: string): string {
  const first = plain(diagnosis.split("\n").find((line) => line.trim() !== "") ?? "") || "make the check pass"
  return `fix: ${first}`.slice(0, HEADLINE_MAX).trimEnd()
}

function quoted(text: string): string {
  return `\`\`\`text\n${text.replaceAll("```", "'''").trimEnd()}\n\`\`\``
}

function comment(attempt: number, lead: string, diagnosis: string, extra = ""): string {
  return [
    attemptMarker(attempt),
    `**Fix attempt ${attempt} of ${MAX_ATTEMPTS}** for \`${CHECK_JOB}\`: ${lead}`,
    ...(extra ? [extra] : []),
    "Diagnosis from Claude Code:",
    quoted(diagnosis),
  ].join("\n\n")
}

function headMoved(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ""
  return (
    (error instanceof GitHubGraphQLError || error instanceof GitHubHttpError) &&
    /expected branch to point to|expectedHeadOid|STALE_DATA/i.test(message)
  )
}

export async function commitFix(input: CommitInput): Promise<CommitOutcome> {
  const { client, repo, pr, headSha, attempt } = input
  const log = input.log ?? (() => {})
  const pull = await getPull(client, repo, pr)
  if (pull.state !== "open" || pull.head.sha !== headSha) {
    log(`#${pr} is no longer open at ${headSha}; nothing is written`)
    return { outcome: "moved" }
  }

  const proposal = readProposal(input.outputDir)
  const last = attempt >= MAX_ATTEMPTS
  const handOver = last ? ` This was the last attempt; the label \`${NEEDS_HUMAN}\` asks for a person.` : ""

  const refuse = async (reasons: string[]): Promise<CommitOutcome> => {
    const list = reasons.map((r) => `- ${plain(r)}`).join("\n")
    await postComment(
      client,
      repo,
      pr,
      comment(
        attempt,
        `the proposed change was refused and not committed. The label \`${NEEDS_HUMAN}\` asks for a person.`,
        proposal.diagnosis,
        `Why it was refused:\n\n${list}`,
      ),
    )
    await addLabel(client, repo, pr, NEEDS_HUMAN)
    return { outcome: "refused", reasons }
  }

  if (proposal.malformed) return refuse([proposal.malformed])
  if (proposal.changes.length > MAX_FILES) {
    return refuse([`the fix changes ${proposal.changes.length} files; at most ${MAX_FILES} files are accepted`])
  }
  const unreadable = proposal.changes.filter((c) => c.unreadable !== undefined)
  if (unreadable.length > 0) return refuse(unreadable.map((c) => `${c.path}: ${c.unreadable}`))

  const changes: FixChange[] = []
  const tooLarge: string[] = []
  for (const { path, after } of proposal.changes) {
    const before = await fileAt(client, repo, path, headSha)
    if (before.kind === "other" || (before.kind === "file" && before.size > MAX_BYTES)) {
      tooLarge.push(`${path}: larger than 200 KB, or not a file`)
      continue
    }
    const was = before.kind === "file" ? before.text : null
    if (was !== after) changes.push({ path, before: was, after })
  }
  if (tooLarge.length > 0) return refuse(tooLarge)

  if (changes.length === 0) {
    await postComment(
      client,
      repo,
      pr,
      comment(attempt, `no change was proposed.${handOver}`, proposal.diagnosis),
    )
    if (last) await addLabel(client, repo, pr, NEEDS_HUMAN)
    return { outcome: "unchanged" }
  }

  const prFiles = await listPullFiles(client, repo, pr)
  const verdict = guardFix({ prFiles, changes })
  if (!verdict.ok) return refuse(verdict.reasons)

  let oid: string
  try {
    const made = await createSignedCommit(client, {
      repo,
      branch: pull.head.ref,
      expectedHeadOid: headSha,
      message: {
        headline: fixHeadline(proposal.diagnosis),
        body: `${CHECK_JOB} failed on ${headSha.slice(0, 7)}. Automatic fix attempt ${attempt} of ${MAX_ATTEMPTS}.\n\n${TRAILER}`,
      },
      additions: changes.map((c) => ({ path: c.path, contents: c.after ?? "" })),
    })
    oid = made.oid
  } catch (error) {
    if (!headMoved(error)) throw error
    log(`#${pr} moved while the fix was being committed; nothing is written`)
    return { outcome: "moved" }
  }

  const files = changes.map((c) => `\`${plain(c.path)}\``).join(", ")
  await postComment(
    client,
    repo,
    pr,
    comment(attempt, `committed ${oid.slice(0, 7)} (${files}). The next run of the check is the test.`, proposal.diagnosis),
  )
  return { outcome: "committed", oid }
}
