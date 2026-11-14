/**
 * The Fix job's three steps, one per job of the workflow.
 *
 *   node train/bin/fix.ts triage
 *     env GITHUB_TOKEN (the App's), GITHUB_REPOSITORY, RUN_ID, CLAUDE_AVAILABLE,
 *     FIX_INPUT_DIR (default fix-input). Decides, reruns or writes the
 *     proposal's input, and writes action, pr, head_sha, attempt to
 *     $GITHUB_OUTPUT.
 *
 *   node train/bin/fix.ts collect <claude-output.json>
 *     env BASE_SHA, FIX_TREE (default: the working directory), FIX_OUTPUT_DIR
 *     (default fix-output). No token, no network: reads the tree Claude Code
 *     edited and writes changes.json and diagnosis.txt.
 *
 *   node train/bin/fix.ts commit
 *     env GITHUB_TOKEN (the App's, contents: write), GITHUB_REPOSITORY, PR,
 *     HEAD_SHA, ATTEMPT, FIX_OUTPUT_DIR (default fix-output). Guards the
 *     proposal and commits it, or comments why not.
 */
import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { envTokenProvider } from "../src/github/app-auth.ts"
import { GitHubClient } from "../src/github/client.ts"
import type { RepoRef } from "../src/github/pr.ts"
import { fetchJobLog } from "../src/fix/api.ts"
import { collect } from "../src/fix/collect.ts"
import { commitFix } from "../src/fix/commit.ts"
import { runTriage } from "../src/fix/steps.ts"

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function repository(): RepoRef {
  const [owner, name] = env("GITHUB_REPOSITORY").split("/")
  if (!owner || !name) throw new Error("GITHUB_REPOSITORY is not owner/name")
  return { owner, name }
}

function positive(name: string): number {
  const value = Number(env(name))
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} is not a positive integer`)
  return value
}

const notice = (message: string) => console.log(`::notice::${message.replace(/\r?\n/g, " ")}`)

async function main(command: string | undefined, args: string[]): Promise<void> {
  if (command === "triage") {
    const tokens = envTokenProvider("GITHUB_TOKEN")
    const repo = repository()
    const result = await runTriage({
      client: new GitHubClient({ tokens }),
      repo,
      runId: positive("RUN_ID"),
      claudeAvailable: process.env.CLAUDE_AVAILABLE === "true",
      inputDir: resolve(process.env.FIX_INPUT_DIR || "fix-input"),
      readLog: (jobId) => fetchJobLog({ tokens }, repo, jobId),
      notice,
    })
    const lines = Object.entries(result).map(([key, value]) => `${key}=${value}\n`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join(""))
    console.log(lines.join("").trimEnd())
    return
  }
  if (command === "collect") {
    const [claudeOutput] = args
    if (!claudeOutput) throw new Error("usage: fix.ts collect <claude-output.json>")
    const { changes } = collect({
      tree: resolve(process.env.FIX_TREE || "."),
      baseSha: env("BASE_SHA"),
      outputDir: resolve(process.env.FIX_OUTPUT_DIR || "fix-output"),
      claudeOutput: resolve(claudeOutput),
    })
    console.log(`${changes} changed file(s) collected`)
    return
  }
  if (command === "commit") {
    const result = await commitFix({
      client: new GitHubClient({ tokens: envTokenProvider("GITHUB_TOKEN") }),
      repo: repository(),
      pr: positive("PR"),
      headSha: env("HEAD_SHA"),
      attempt: positive("ATTEMPT"),
      outputDir: resolve(process.env.FIX_OUTPUT_DIR || "fix-output"),
      log: console.log,
    })
    notice(`Fix: ${result.outcome}${result.outcome === "committed" ? ` ${result.oid.slice(0, 7)}` : ""}.`)
    return
  }
  throw new Error("usage: fix.ts triage | collect <claude-output.json> | commit")
}

main(process.argv[2], process.argv.slice(3)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
