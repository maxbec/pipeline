/**
 * The triage job's step: decide, and do what the decision needs that is not
 * Claude Code — rerun the failed jobs, write the proposal's input, or give up
 * in a comment. The outputs are what the workflow's other jobs branch on.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { GitHubClient } from "../github/client.ts"
import type { RepoRef } from "../github/pr.ts"
import { addLabel, listComments, listPullFiles, postComment, rerunFailedJobs } from "./api.ts"
import { buildPrompt, logExcerpt } from "./prompt.ts"
import {
  CHECK_JOB,
  GAVE_UP_MARKER,
  isBotComment,
  MAX_ATTEMPTS,
  NEEDS_HUMAN,
  triageFailure,
} from "./triage.ts"

export interface TriageStepInput {
  client: GitHubClient
  repo: RepoRef
  runId: number
  /** Whether the repository has the Claude token; without it there is a rerun but no proposal. */
  claudeAvailable: boolean
  /** Where `log.txt`, `files.json` and `prompt.txt` go. */
  inputDir: string
  readLog: (jobId: number) => Promise<string>
  notice?: (message: string) => void
}

/** `$GITHUB_OUTPUT` of the triage step; empty where the action has no such value. */
export interface TriageOutputs {
  action: "none" | "rerun" | "propose" | "give_up"
  pr: string
  head_sha: string
  attempt: string
}

const outputs = (action: TriageOutputs["action"], rest: Partial<TriageOutputs> = {}): TriageOutputs => ({
  action,
  pr: "",
  head_sha: "",
  attempt: "",
  ...rest,
})

export async function runTriage(input: TriageStepInput): Promise<TriageOutputs> {
  const { client, repo } = input
  const notice = input.notice ?? (() => {})
  const triage = await triageFailure(client, repo, { id: input.runId })

  if (triage.action === "none") {
    notice(`Fix: nothing to do — ${triage.reason}.`)
    return outputs("none")
  }

  if (triage.action === "rerun") {
    await rerunFailedJobs(client, repo, input.runId)
    notice("Fix: first failure of this run; its failed jobs are rerun once.")
    return outputs("rerun")
  }

  if (triage.action === "give_up") {
    const comments = await listComments(client, repo, triage.pr)
    if (!comments.some((c) => isBotComment(c, GAVE_UP_MARKER))) {
      await postComment(
        client,
        repo,
        triage.pr,
        [
          GAVE_UP_MARKER,
          `\`${CHECK_JOB}\` is still failing after ${MAX_ATTEMPTS} automatic fix attempts. The train stops here; the diagnoses are in the comments above.`,
          `The label \`${NEEDS_HUMAN}\` keeps the Fix away from this pull request. Remove it once the check is green again.`,
        ].join("\n\n"),
      )
    }
    await addLabel(client, repo, triage.pr, NEEDS_HUMAN)
    notice(`Fix: ${triage.reason}; #${triage.pr} is handed to a person.`)
    return outputs("give_up", { pr: String(triage.pr) })
  }

  if (!input.claudeAvailable) {
    notice(
      `Fix: #${triage.pr} is still red after the rerun, but CLAUDE_CODE_OAUTH_TOKEN is not set; no fix is proposed here.`,
    )
    return outputs("none")
  }

  const excerpt = logExcerpt(await input.readLog(triage.jobId))
  const prFiles = await listPullFiles(client, repo, triage.pr)
  mkdirSync(input.inputDir, { recursive: true })
  writeFileSync(join(input.inputDir, "log.txt"), excerpt)
  writeFileSync(join(input.inputDir, "files.json"), JSON.stringify(prFiles))
  writeFileSync(
    join(input.inputDir, "prompt.txt"),
    buildPrompt({
      repo: `${repo.owner}/${repo.name}`,
      prNumber: triage.pr,
      title: triage.title,
      logExcerpt: excerpt,
      prFiles,
    }),
  )
  notice(`Fix: attempt ${triage.attempt} of ${MAX_ATTEMPTS} for #${triage.pr}.`)
  return outputs("propose", {
    pr: String(triage.pr),
    head_sha: triage.headSha,
    attempt: String(triage.attempt),
  })
}
