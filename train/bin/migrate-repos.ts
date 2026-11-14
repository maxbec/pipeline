#!/usr/bin/env node
/**
 * The fleet tool: bring every local clone's repository to the pipeline's
 * uniform shape, pinned to one commit of maxbec/pipeline.
 *
 *   node train/bin/migrate-repos.ts                              # dry run: print the plan per repository
 *   node train/bin/migrate-repos.ts --only acme/widgets          # one repository
 *   node train/bin/migrate-repos.ts --apply                      # write: settings, protection, one signed commit + PR each
 *   node train/bin/migrate-repos.ts --pipeline-ref v5.5.0-beta.1 # pin this tag (default: the newest stable tag)
 *   node train/bin/migrate-repos.ts --overrides fleet.json       # per-repository deviations (src/provisioning/overrides.ts)
 *   node train/bin/migrate-repos.ts --train-schedule keep|drop|auto   # the Train caller's schedule block
 *   node train/bin/migrate-repos.ts --no-train | --remove-train  # leave the Train caller alone | delete it
 *
 * Idempotent: rerun it until every repository reports "merged" or "nothing to
 * do". A repository whose pull request waits for `pipeline / Check` is merged
 * on the next run once the check is green. Commits go through GraphQL
 * `createCommitOnBranch` (GitHub-signed) with the gh CLI's token. Never clones
 * anything: it reads the local clones under `<home>/companies/<company>/repos`
 * and a local clone of maxbec/pipeline — by default the one it runs from.
 *
 * Run by hand from a clone after `npm ci` (the config conversion needs the
 * `yaml` package); never in Actions.
 */
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { ghCliTokenProvider } from "../src/github/app-auth.ts"
import { GitHubClient } from "../src/github/client.ts"
import { parseMigrateArgs, UsageError, untaggedRefusal } from "../src/provisioning/cli.ts"
import { discoverRepositories } from "../src/provisioning/discover.ts"
import {
  type ApplyContext,
  type ApplyResult,
  applyPlan,
  formatPlan,
  planRepository,
  readFacts,
  type TrainPlan,
} from "../src/provisioning/migrate.ts"
import { loadOverrides } from "../src/provisioning/overrides.ts"
import { resolvePipelinePin } from "../src/provisioning/pin.ts"
import { fetchOrigin } from "../src/release/history.ts"

const run = promisify(execFile)

async function show(clone: string, sha: string, path: string): Promise<string | null> {
  try {
    return (await run("git", ["-C", clone, "show", `${sha}:${path}`], { encoding: "utf8" })).stdout.trim()
  } catch {
    return null
  }
}

function usage(message: string): never {
  console.error(message)
  process.exit(2)
}

let options: ReturnType<typeof parseMigrateArgs>
let fleet: ReturnType<typeof loadOverrides>
try {
  options = parseMigrateArgs(process.argv.slice(2))
  fleet = loadOverrides(options.overrides)
} catch (error) {
  if (error instanceof UsageError) usage(error.message)
  usage(error instanceof Error ? error.message : String(error))
}

const home = options.home ?? homedir()
const clone = options.pipelineClone ?? fileURLToPath(new URL("../..", import.meta.url))
await fetchOrigin(clone)
const pin = await resolvePipelinePin(clone, options.pipelineRef).catch((error: unknown) =>
  usage(error instanceof Error ? error.message : String(error)),
)
const refusal = untaggedRefusal(options, pin)
if (refusal !== null) usage(refusal)
const template = await show(clone, pin.sha, ".github/workflows/examples/caller.yaml")
if (template === null) usage(`${pin.sha.slice(0, 7)} has no .github/workflows/examples/caller.yaml`)
console.log(
  `pipeline pin: ${pin.sha}${pin.version ? ` (v${pin.version})` : " (untagged)"}; ${options.apply ? "APPLYING" : "dry run"}`,
)

let train: TrainPlan | undefined
if (options.train === "remove") train = { mode: "remove" }
if (options.train === "render") {
  const trainTemplate = await show(clone, pin.sha, ".github/workflows/examples/train-caller.yaml")
  if (trainTemplate === null) {
    // A caller pinned to a commit without the reusable workflow dies at startup.
    console.log(
      "this pin has no Train caller: .github/workflows/train.yaml is neither written nor changed (--remove-train deletes it)",
    )
  } else {
    train = { mode: "render", template: trainTemplate, schedule: options.trainSchedule }
  }
}
console.log()

const only = new Set(options.only)
const repositories = discoverRepositories({ home, companies: options.companies }).filter(
  (r) => only.size === 0 || only.has(`${r.owner}/${r.name}`.toLowerCase()),
)
if (repositories.length === 0) usage("no repositories matched")

const client = new GitHubClient({ tokens: ghCliTokenProvider() })
const ctx: ApplyContext = {
  pin,
  template,
  overrides: fleet.repositories,
  legacyPaths: fleet.legacyPaths,
  singleQuoteTrunkPlugins: fleet.singleQuoteTrunkPlugins,
  dryRun: !options.apply,
  ...(train ? { train } : {}),
}
const summary: { repo: string; result: ApplyResult | { status: "error"; reason: string } }[] = []
let files = 0
for (const repository of repositories) {
  const slug = `${repository.owner}/${repository.name}`
  try {
    const facts = await readFacts(client, repository, ctx)
    const plan = planRepository(repository, facts, ctx)
    console.log(formatPlan(plan))
    if (!plan.skip) files += plan.additions.length + plan.deletions.length
    const result = await applyPlan(client, repository, plan, ctx)
    if (!plan.skip && !plan.idle) console.log(`  => ${JSON.stringify(result)}`)
    console.log()
    summary.push({ repo: slug, result })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.log(`${slug}: ERROR ${reason}\n`)
    summary.push({ repo: slug, result: { status: "error", reason } })
  }
}
console.log("summary:")
for (const { repo, result } of summary) {
  const detail =
    "reason" in result
      ? `: ${result.reason}`
      : "pr" in result
        ? ` #${result.pr}${"sha" in result ? ` ${result.sha.slice(0, 7)}` : ""}`
        : ""
  console.log(`  ${result.status.padEnd(8)} ${repo}${detail}`)
}
console.log(`files ${options.apply ? "written or deleted" : "that would change"}: ${files}`)
process.exit(summary.some((s) => s.result.status === "error") ? 1 : 0)
