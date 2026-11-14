/**
 * Bring one repository to the uniform shape the pipeline expects.
 *
 * One pattern for every repository; small and major differ only by the
 * presence of `dev`. A repository gets the Pipeline caller SHA-pinned (and the
 * Train caller at the same pin), `.github/pipeline.yaml` in version 3, the
 * files of earlier release tooling removed, the pipeline section of its agent
 * file current, merge settings and required checks normalized, and the bot
 * pull requests and branches of the old release tooling closed. Every write is
 * idempotent: the plan is computed against what GitHub and the tree say now,
 * so a rerun after a partial pass finishes the pass and a rerun after a full
 * pass does nothing.
 *
 * Commits go through GraphQL `createCommitOnBranch`, the one path a user
 * token can take to a signed commit. The change lands as a pull request on
 * the working branch; the train's own merge rules (`canMerge` with
 * `pipeline / Check` required) decide when it merges.
 */
import { isDeepStrictEqual } from "node:util"
import { type Document, parse, parseDocument, Scalar, stringify, visit } from "yaml"
import { type GitHubClient, GitHubHttpError } from "../github/client.ts"
import { createSignedCommit, mergePullRequest } from "../github/merge.ts"
import { canMerge, getPrState, type RepoRef } from "../github/pr.ts"
import { updateBehindOnce } from "../github/update-behind.ts"
import { fetchOrigin, listTree, readTreeFile, readTreeFileExact } from "../release/history.ts"
import type { Repository } from "../types.ts"
import type { PipelinePin } from "./pin.ts"

export const MIGRATION_BRANCH = "chore/slim-pipeline"
export const MIGRATION_TITLE = "chore(ci): move to the slim pipeline"
/** The one status context every branch protection and ruleset requires. */
export const REQUIRED_CONTEXT = "pipeline / Check"
export const CALLER_PATH = ".github/workflows/ci.yaml"
/** The second caller, rendered at the same pin in the same commit. */
export const TRAIN_CALLER_PATH = ".github/workflows/train.yaml"

export const CONFIG_PATH = ".github/pipeline.yaml"
export const TRUNK_CONFIG_PATH = ".trunk/trunk.yaml"
/**
 * Agent instruction files. Earlier tooling wrote a section into them between
 * markers; the same place now carries the pipeline section, rewritten on every pass.
 */
export const AGENT_FILES = ["AGENTS.md", "CLAUDE.md"]
const AGENTS_BLOCK_START = "<!-- pipeline:start -->"
const AGENTS_BLOCK_END = "<!-- pipeline:end -->"
const FLAMA_BLOCK = /<!-- flama-delivery:start -->[\s\S]*?<!-- flama-delivery:end -->/
const PIPELINE_BLOCK = /<!-- pipeline:start -->[\s\S]*?<!-- pipeline:end -->/

// The shape lives with the code that reads it out of the pipeline clone.
export type { PipelinePin }

/** Per-repository deviations from the uniform pattern; keyed `owner/name`. */
export interface RepoOverride {
  /** Caller secrets forwarded from a differently named repository secret. */
  secrets?: Record<string, string>
  /** `deploy.render.hook: true` — fire the Render hook after the production Docker deploy. */
  renderHook?: boolean
  /** Extra workflow files the repository needs beside the caller. */
  extraFiles?: Record<string, string>
}

/** Whether the Train caller's schedule block stays; `auto` decides by the owner's account type. */
export type TrainSchedule = "keep" | "drop" | "auto"

/** What happens to `.github/workflows/train.yaml`. Absent from the context, the file is left alone. */
export type TrainPlan =
  | {
      mode: "render"
      /** `examples/train-caller.yaml` from maxbec/pipeline at the pinned sha. */
      template: string
      schedule: TrainSchedule
    }
  /** The rollback path: delete the caller where it exists. */
  | { mode: "remove" }

export interface PlanContext {
  pin: PipelinePin
  /** `examples/caller.yaml` from maxbec/pipeline at the pinned sha. */
  template: string
  overrides: Record<string, RepoOverride>
  /** Paths to delete beside the built-in list; from the overrides file. */
  legacyPaths?: RegExp[]
  /** A trunk config that mentions one of these gets single-quoted YAML; from the overrides file. */
  singleQuoteTrunkPlugins?: string[]
  train?: TrainPlan
}

export interface FactsContext {
  /** How a branch is addressed in the local tree: `origin/<b>` in a clone (default), `<b>` in a bare origin. */
  ref?: (branch: string) => string
  /** Fetch the clone before reading; defaults to true when `ref` is the default. */
  fetch?: boolean
}

export interface ApplyContext extends PlanContext, FactsContext {
  dryRun?: boolean
}

export interface RepoSettings {
  allow_squash_merge: boolean
  allow_merge_commit: boolean
  allow_rebase_merge: boolean
  delete_branch_on_merge: boolean
  squash_merge_commit_title: string
  squash_merge_commit_message: string
}

export interface Protection {
  strict: boolean
  contexts: string[]
}

export interface RepoFacts {
  archived: boolean
  private: boolean
  /** `type` of `GET /users/{owner}`; read only when the Train schedule is decided by it. */
  ownerType?: string
  defaultBranch: string
  settings: RepoSettings
  branches: string[]
  /** Paths at the migration source: the migration branch when it exists, else the base. */
  tree: string[]
  read: (path: string) => string | null
  protection: Record<string, Protection>
  rulesets: { id: number; name: string; contexts: string[] }[]
  openPulls: { number: number; head: string; title: string }[]
}

export interface Plan {
  repo: string
  base: string
  kind: Repository["kind"]
  skip?: string
  idle: boolean
  additions: { path: string; contents: string }[]
  deletions: string[]
  /** Workflow files that are neither the caller nor legacy — left alone, listed for review. */
  kept: string[]
  settings: Partial<RepoSettings> & { default_branch?: string }
  protection: { branch: string; strict: boolean; contexts: string[] }[]
  rulesets: { id: number; name: string; contexts: string[] }[]
  closePulls: { number: number; head: string }[]
  deleteBranches: string[]
  /** An open migration PR from an earlier pass. */
  pendingPr: number | null
}

export type ApplyResult =
  | { status: "skipped"; reason: string }
  | { status: "idle" }
  | { status: "planned" }
  | { status: "waiting"; pr: number; reason: string }
  | { status: "merged"; pr: number; sha: string }

// ---- what goes and what stays ------------------------------------------------

const LEGACY: RegExp[] = [
  /^\.flama\//,
  /^(?:\.github\/)?\.?release-please-(?:config|manifest)[^/]*\.json$/,
  /^CHANGELOG\.dev\.md$/,
  /^\.github\/delivery-contract[^/]*$/,
  /^\.github\/workflows\/(?:flama-[^/]+|promote[^/]*|auto-promote[^/]*|create-release-pr[^/]*|release(?:-dev|-pr-checks)?\.ya?ml|claude-code[^/]*|cron-weekly-release[^/]*|action-(?:create|draft)-release[^/]*|action-pr-merged-[^/]*)$/,
  /^\.github\/workflows\/examples\//,
]
const BOT_BRANCH = /^(?:release-please--|flama\/)/

export function isLegacyPath(path: string, extra: RegExp[] = []): boolean {
  return LEGACY.some((re) => re.test(path)) || extra.some((re) => re.test(path))
}

export function baseFor(repository: Pick<Repository, "kind">): string {
  return repository.kind === "major" ? "dev" : "main"
}

// ---- pipeline.yaml v2 -> v3 --------------------------------------------------

type Doc = Record<string, unknown>
const obj = (v: unknown): Doc =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {}
function pick(from: Doc, keys: string[]): Doc {
  const out: Doc = {}
  for (const k of keys) if (from[k] !== undefined) out[k] = from[k]
  return out
}

const PROVIDERS: Record<string, string> = {
  none: "none",
  docker: "docker-ghcr",
  "docker-ghcr": "docker-ghcr",
  vercel: "vercel",
  cloudflare: "cloudflare-workers",
  "cloudflare-workers": "cloudflare-workers",
  npm: "npm",
}

// `---` first: yamllint's document-start rule is on in every trunk repository.
// `---` first, and the repository's own quote style: yamllint's document-start
// rule and prettier both run over the file the migration just wrote, in the
// pipeline's own Check.
const dump = (doc: Doc, singleQuote: boolean): string =>
  `---\n${stringify(doc, { singleQuote, lineWidth: 0 })}`
const dumpDocument = (doc: Document, singleQuote: boolean): string => {
  // A scalar parsed from a file remembers how it was quoted, and would keep
  // that style through `toString`. Forget it, so the requested style wins.
  visit(doc, {
    Scalar(_key, node) {
      if (node.type === Scalar.QUOTE_DOUBLE || node.type === Scalar.QUOTE_SINGLE)
        node.type = undefined
    },
  })
  // A document parsed from a file that already had the marker prints it itself.
  const body = doc.toString({ singleQuote, lineWidth: 0 })
  return body.startsWith("---\n") ? body : `---\n${body}`
}

/** Each folded block scalar (`>-`) of a file, by value, as the file spells it. */
function foldedScalars(text: string): { value: unknown; from: number; to: number }[] {
  const found: { value: unknown; from: number; to: number }[] = []
  visit(parseDocument(text), {
    Scalar(_key, node) {
      if (node.type === Scalar.BLOCK_FOLDED && node.range)
        found.push({ value: node.value, from: node.range[0], to: node.range[1] })
    },
  })
  return found
}

/**
 * A folded block scalar loses its line breaks on parse, so the dumper writes a
 * command someone folded over three lines back as one long line: a diff nobody
 * asked for, and a line yamllint may refuse. Where the value is unchanged, put
 * the scalar back the way the file had it.
 */
function keepFolds(original: string, dumped: string): string {
  const written = new Map(
    foldedScalars(original).map((s) => [s.value, original.slice(s.from, s.to)]),
  )
  let out = dumped
  for (const scalar of foldedScalars(dumped).reverse()) {
    const source = written.get(scalar.value)
    if (source !== undefined) out = out.slice(0, scalar.from) + source + out.slice(scalar.to)
  }
  // The original indentation may not fit where the scalar now sits; a result
  // that reads differently is not worth the layout.
  return isDeepStrictEqual(parse(out), parse(dumped)) ? out : dumped
}

/**
 * A shared trunk plugin may ship a prettier config with `singleQuote: true`; a
 * repository on plain trunk gets prettier's default. Guessing wrong leaves
 * `trunk fmt` red for ever, because the file the tool writes is the file trunk
 * checks. Which plugins do that is the fleet's own knowledge: `plugins` comes
 * from the overrides file.
 */
export function prefersSingleQuotes(trunkConfig: string | null, plugins: string[] = []): boolean {
  return trunkConfig !== null && plugins.some((plugin) => trunkConfig.includes(plugin))
}

export interface ConvertOptions {
  renderHook?: boolean
  /** The repository's prettier style; see `prefersSingleQuotes`. */
  singleQuote?: boolean
  /** Public repositories stay GitHub-hosted; the org variable would route them to self-hosted. */
  hostedRunner?: boolean
}

function hasRunnerLabels(doc: Doc): boolean {
  const labels = obj(doc.runner).labels
  return Array.isArray(labels) && labels.length > 0
}

function ensureHostedRunner(doc: Doc): void {
  if (hasRunnerLabels(doc)) return
  doc.runner = { labels: ["ubuntu-latest"] }
}

function setRenderHook(doc: Doc): void {
  const deploy = obj(doc.deploy)
  deploy.render = { ...obj(deploy.render), hook: true }
  doc.deploy = deploy
}

/** The v3 shape, as far as this module reads or writes it. */
export interface PipelineConfig {
  version: string
  stack?: string
  runner?: { labels?: string[] }
  runtime?: { node_version?: string; python_version?: string }
  security?: Record<string, boolean>
  lint?: { enable?: boolean; command?: string }
  test?: { enable?: boolean; command?: string }
  build?: { enable?: boolean; command?: string; artifact_path?: string }
  deploy: {
    provider: string
    docker?: { images?: Record<string, unknown>[]; cache_backend?: string }
    vercel?: Record<string, unknown>
    cloudflare?: Record<string, unknown>
    render?: { hook: boolean }
  }
  [key: string]: unknown
}

/**
 * `deployment:` becomes `deploy:` with the v3 provider names, `release:` and
 * `pipeline:` vanish (the train owns versions, the pipeline owns caching), and
 * every key the slim pipeline does not read is dropped so Guard never sees a
 * stale one. A v3 file passes through untouched unless an override applies.
 */
export function convertConfig(
  text: string | null,
  opts: ConvertOptions,
): { text: string; parsed: PipelineConfig } {
  const src = text === null ? { version: "3", deploy: { provider: "none" } } : obj(parse(text))
  const singleQuote = opts.singleQuote === true
  const version = String(src.version ?? "")
  if (version.startsWith("3")) {
    // Re-serialise rather than pass the text through: the first fleet run wrote
    // these files itself, without the document start and in the wrong quote
    // style, and a passed-through file can never be repaired. `parseDocument`
    // keeps the comments and the key order, so a hand-written file survives.
    const doc = text === null ? null : parseDocument(text)
    if (doc === null) {
      const fresh = structuredClone(src)
      if (opts.renderHook) setRenderHook(fresh)
      if (opts.hostedRunner) ensureHostedRunner(fresh)
      return { text: dump(fresh, singleQuote), parsed: fresh as PipelineConfig }
    }
    if (opts.renderHook) doc.setIn(["deploy", "render", "hook"], true)
    if (opts.hostedRunner && !hasRunnerLabels(doc.toJS() as Doc))
      doc.setIn(["runner", "labels"], ["ubuntu-latest"])
    // Same rule as the v2 conversion: with an explicit `trunk` command
    // the pipeline runs the binary it never installed; without one it uses the
    // Trunk action.
    if (/^trunk(\s|$)/.test(String(doc.getIn(["lint", "command"]) ?? "")))
      doc.deleteIn(["lint", "command"])
    return {
      text: keepFolds(text ?? "", dumpDocument(doc, singleQuote)),
      parsed: doc.toJS() as PipelineConfig,
    }
  }
  if (!version.startsWith("2")) {
    throw new Error(`unsupported pipeline.yaml version '${version || "unset"}'; expected 2 or 3`)
  }
  const out: Doc = { version: "3" }
  if (src.stack !== undefined) out.stack = src.stack
  if (src.runner !== undefined) out.runner = pick(obj(src.runner), ["labels"])
  const runtime = obj(src.runtime)
  const rt: Doc = {}
  if (runtime.node_version !== undefined) rt.node_version = String(runtime.node_version)
  if (runtime.python_version !== undefined) rt.python_version = String(runtime.python_version)
  if (Object.keys(rt).length > 0) out.runtime = rt
  if (src.security !== undefined) {
    out.security = pick(obj(src.security), [
      "enable",
      "trufflehog",
      "dependency_review",
      "fail_on_secrets",
      "fail_on_vulnerabilities",
    ])
  }
  if (src.lint !== undefined) {
    const lint = pick(obj(src.lint), ["enable", "command"])
    // The slim pipeline runs trunk itself (trunk-action) when no command is set;
    // a `trunk check …` command would run on a runner that has no trunk.
    if (typeof lint.command === "string" && /^trunk(\s|$)/.test(lint.command)) delete lint.command
    out.lint = lint
  }
  if (src.test !== undefined) out.test = pick(obj(src.test), ["enable", "command"])
  if (src.build !== undefined) {
    out.build = pick(obj(src.build), ["enable", "command", "artifact_path"])
  }
  const deployment = obj(src.deployment ?? src.deploy)
  const provider = String(deployment.provider ?? "none")
  const mapped = PROVIDERS[provider]
  if (!mapped) {
    throw new Error(
      `unknown v2 deploy provider '${provider}'; the slim pipeline knows none, vercel, cloudflare-workers, docker-ghcr and npm`,
    )
  }
  const deploy: Doc = { provider: mapped }
  if (mapped === "docker-ghcr") {
    const d = obj(deployment.docker)
    const docker: Doc = {}
    if (Array.isArray(d.images)) {
      docker.images = d.images.map((i) =>
        pick(obj(i), ["name", "dockerfile", "context", "platforms", "build_args", "image_name"]),
      )
    }
    if (d.cache_backend !== undefined) docker.cache_backend = d.cache_backend
    deploy.docker = docker
  }
  if (mapped === "vercel") deploy.vercel = pick(obj(deployment.vercel), ["scope", "build_command"])
  if (mapped === "cloudflare-workers") {
    deploy.cloudflare = pick(obj(deployment.cloudflare), ["config", "build_command"])
  }
  if (opts.renderHook) deploy.render = { hook: true }
  out.deploy = deploy
  if (opts.hostedRunner) ensureHostedRunner(out)
  return { text: dump(out, singleQuote), parsed: out as PipelineConfig }
}

// ---- the caller ---------------------------------------------------------------

/** The template with the pin filled in, within yamllint's 120 characters, ending in a newline. */
function fillPin(template: string, pin: PipelinePin, what: string): string {
  const version = pin.version ? `v${pin.version.replace(/^v/, "")}` : null
  // The `uses:` line carries the tag as a trailing comment only when there is one;
  // the template's prose mentions the placeholders too and gets plain words.
  const text = template
    .replace(/@__PIPELINE_SHA__(?:[ \t]*#[ \t]*__PIPELINE_VERSION__)?/g, (m) =>
      m.includes("#") && version ? `@${pin.sha} # ${version}` : `@${pin.sha}`,
    )
    .replaceAll("__PIPELINE_SHA__", pin.sha)
    .replaceAll("__PIPELINE_VERSION__", version ?? "an untagged commit")
  if (/__PIPELINE_/.test(text)) throw new Error(`${what} template placeholders left unfilled`)
  return text
}

function finish(text: string, what: string): string {
  // The CLI reads the template through `git show`, trimmed; yamllint wants the final newline
  // and refuses lines over 120 characters (the sha plus an inline tag comment is 124).
  const long = text.split("\n").find((line) => line.length > 120)
  if (long !== undefined)
    throw new Error(`rendered ${what} line exceeds 120 characters: ${long.trim()}`)
  return text.endsWith("\n") ? text : `${text}\n`
}

export function renderCaller(
  template: string,
  pin: PipelinePin,
  override: Pick<RepoOverride, "secrets">,
): string {
  let text = fillPin(template, pin, "caller")
  for (const [name, value] of Object.entries(override.secrets ?? {})) {
    const re = new RegExp(`^([ \\t]*)${name}: .*$`, "m")
    if (!re.test(text)) throw new Error(`secret ${name} is not forwarded by the caller template`)
    text = text.replace(re, (_m, indent: string) => `${indent}${name}: ${value}`)
  }
  return finish(text, "caller")
}

const SCHEDULE_BEGIN = "# __TRAIN_SCHEDULE_BEGIN__"
const SCHEDULE_END = "# __TRAIN_SCHEDULE_END__"

/**
 * The Train caller at the same pin. The schedule block sits between two marker
 * lines in the template: `keep` leaves the block and takes the markers out,
 * `drop` takes out all of it — for a repository a central sweep covers. The
 * marker lines never reach the rendered file.
 */
export function renderTrainCaller(
  template: string,
  pin: PipelinePin,
  schedule: "keep" | "drop",
): string {
  const lines = fillPin(template, pin, "Train caller").split("\n")
  const begin = lines.findIndex((line) => line.trim() === SCHEDULE_BEGIN)
  const end = lines.findIndex((line) => line.trim() === SCHEDULE_END)
  if (begin < 0 || end < begin)
    throw new Error("the Train caller template has no schedule block between its two markers")
  const kept = [
    ...lines.slice(0, begin),
    ...(schedule === "keep" ? lines.slice(begin + 1, end) : []),
    ...lines.slice(end + 1),
  ]
  const text = kept.join("\n")
  if (text.includes("__TRAIN_SCHEDULE_"))
    throw new Error("the Train caller template repeats a schedule marker")
  return finish(text, "Train caller")
}

/** `auto`: a user account's repositories are swept centrally, an organization's run their own schedule. */
export function trainScheduleFor(
  schedule: TrainSchedule,
  ownerType: string | undefined,
): "keep" | "drop" {
  if (schedule !== "auto") return schedule
  if (ownerType === undefined)
    throw new Error("the owner's account type is unknown; pass --train-schedule keep or drop")
  return ownerType === "User" ? "drop" : "keep"
}

// ---- reading the repository ---------------------------------------------------

/**
 * Prettier with `proseWrap: always` refills every paragraph to its `printWidth`,
 * and the widest config this was rolled out against uses 120.
 * Rendering the section already filled that way keeps the file formatted under
 * that config and under `preserve`, so Trunk Check stays green on the repin PR.
 */
const AGENTS_WIDTH = 120

/** Greedy fill, the way Prettier lays out prose; an inline code span is one word. */
function fill(text: string, first: string, rest: string): string[] {
  const words: string[] = []
  let word = ""
  let code = false
  for (const ch of text) {
    if (ch === "`") code = !code
    if (ch === " " && !code) {
      if (word) words.push(word)
      word = ""
      continue
    }
    word += ch
  }
  if (word) words.push(word)
  const lines: string[] = []
  let line = first
  let empty = true
  for (const w of words) {
    if (!empty && line.length + 1 + w.length > AGENTS_WIDTH) {
      lines.push(line)
      line = rest + w
    } else {
      line = empty ? line + w : `${line} ${w}`
    }
    empty = false
  }
  lines.push(line)
  return lines
}

/**
 * The section every repository's agent file carries about the pipeline, between
 * markers so a later pass can rewrite it. Self-contained on purpose: an agent
 * session may see this file and nothing of the operator's documentation, so it
 * says the whole contract rather than pointing at it.
 */
export function renderAgentsBlock(kind: Repository["kind"]): string {
  const intro =
    "CI is `maxbec/pipeline`, called SHA-pinned from `.github/workflows/ci.yaml`. The fleet tool renders that " +
    "caller and this section (`train/bin/migrate-repos.ts` in `maxbec/pipeline`); never edit either by hand. " +
    "Behaviour is configured only in `.github/pipeline.yaml`."
  const branching =
    kind === "major"
      ? "Branch off `dev` and target `dev`; squash merge. Never open a pull request against `main`: only `dev`, " +
        "`promote/*`, `hotfix/*` and `release/*` enter `main`, and the promotion is the release train's."
      : "Branch off `main` and target `main`; squash merge. There is no `dev` here."
  const bullets = [
    "Three jobs: `Guard` enforces the branch rules and a conventional PR title; `Check` runs secret scan, lint, " +
      "test and build and is the single required status (`pipeline / Check`); `Deploy` runs only on a published " +
      "GitHub release (prerelease to `preview`, stable to `production`). Pushes never deploy.",
    branching,
    "Conventional PR titles (`type(scope): summary`): the version is derived from them. Never edit a version, tag " +
      "or changelog by hand; the release train keeps one Release PR per branch and merging it is the release.",
    "A pull request merges only when `pipeline / Check` is green, the head is signed and every review thread is " +
      "resolved. Fix a red pipeline at the root; never weaken or skip a check.",
    "Never print or commit a secret value. CI credentials arrive as GitHub secrets; CI reads `preview`, never " +
      "`production`.",
  ]
  return [
    AGENTS_BLOCK_START,
    "",
    "## Pipeline",
    "",
    ...fill(intro, "", ""),
    "",
    ...bullets.flatMap((b) => fill(b, "- ", "  ")),
    "",
    AGENTS_BLOCK_END,
  ].join("\n")
}

/**
 * The agent file with its pipeline section current: the section of the earlier
 * tooling is replaced, an outdated pipeline section rewritten. `null` when the file has
 * neither (a repository's own instructions are its own) or already reads right.
 */
export function upgradeAgentsFile(contents: string, kind: Repository["kind"]): string | null {
  const marker = FLAMA_BLOCK.test(contents)
    ? FLAMA_BLOCK
    : PIPELINE_BLOCK.test(contents)
      ? PIPELINE_BLOCK
      : null
  if (marker === null) return null
  // Exactly one trailing newline: Prettier (and so Trunk Check) rejects a file without it.
  const next = `${contents.replace(marker, renderAgentsBlock(kind)).replace(/\n*$/, "")}\n`
  return next === contents ? null : next
}

function overrideFor(ctx: PlanContext, repository: RepoRef): RepoOverride {
  return ctx.overrides[`${repository.owner}/${repository.name}`] ?? {}
}

async function getOr<T>(client: GitHubClient, path: string, fallback: T): Promise<T> {
  try {
    const res = await client.rest<T>("GET", path)
    return res.body ?? fallback
  } catch (error) {
    if (error instanceof GitHubHttpError && (error.status === 404 || error.status === 403)) {
      return fallback
    }
    throw error
  }
}

interface RawRepo {
  archived: boolean
  private: boolean
  default_branch: string
  allow_squash_merge: boolean
  allow_merge_commit: boolean
  allow_rebase_merge: boolean
  delete_branch_on_merge: boolean
  squash_merge_commit_title: string
  squash_merge_commit_message: string
}

export async function readFacts(
  client: GitHubClient,
  repository: Repository,
  ctx: PlanContext & FactsContext,
): Promise<RepoFacts> {
  const r = `/repos/${repository.owner}/${repository.name}`
  const meta = (await client.rest<RawRepo>("GET", r)).body
  if (!meta) throw new Error(`GET ${r}: empty response`)
  const branches: string[] = []
  for (let page = 1; page <= 5; page++) {
    const list = (await getOr<{ name: string }[]>(
      client,
      `${r}/branches?per_page=100&page=${page}`,
      [],
    )) as {
      name: string
    }[]
    branches.push(...list.map((b) => b.name))
    if (list.length < 100) break
  }
  const base = baseFor(repository)
  const source = branches.includes(MIGRATION_BRANCH) ? MIGRATION_BRANCH : base
  const ref = ctx.ref ?? ((b: string) => `origin/${b}`)
  if (ctx.fetch ?? ctx.ref === undefined) await fetchOrigin(repository.path)
  let tree: string[] = []
  try {
    tree = await listTree(repository.path, ref(source))
  } catch {
    tree = []
  }
  const files = new Map<string, string | null>()
  const wanted = [
    CONFIG_PATH,
    CALLER_PATH,
    TRAIN_CALLER_PATH,
    TRUNK_CONFIG_PATH,
    ...AGENT_FILES,
    ...Object.keys(overrideFor(ctx, repository).extraFiles ?? {}),
  ]
  for (const path of wanted) {
    // Agent files are written back as they are, so they are read byte-exact;
    // the rendered files are compared without their trailing newline anyway.
    const read = AGENT_FILES.includes(path) ? readTreeFileExact : readTreeFile
    files.set(path, tree.includes(path) ? await read(repository.path, ref(source), path) : null)
  }
  const protection: Record<string, Protection> = {}
  for (const branch of [...new Set([base, "main"])]) {
    if (!branches.includes(branch)) continue
    const p = (await getOr<{
      required_status_checks: { strict: boolean; contexts: string[] } | null
    } | null>(client, `${r}/branches/${branch}/protection`, null)) as {
      required_status_checks: { strict: boolean; contexts: string[] } | null
    } | null
    if (p?.required_status_checks) {
      protection[branch] = {
        strict: Boolean(p.required_status_checks.strict),
        contexts: [...(p.required_status_checks.contexts ?? [])],
      }
    }
  }
  const rulesets: RepoFacts["rulesets"] = []
  // The repository endpoint also lists the organization's rulesets that apply here;
  // those are edited once at the org, not once per repository.
  const list = (
    await getOr<{ id: number; name: string; source_type?: string }[]>(client, `${r}/rulesets`, [])
  ).filter((rs) => (rs.source_type ?? "Repository") === "Repository")
  for (const rs of list) {
    const full = (await getOr<{
      rules?: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[]
    }>(client, `${r}/rulesets/${rs.id}`, { rules: [] })) as {
      rules?: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[]
    }
    const checks = (full.rules ?? []).find((rule) => rule.type === "required_status_checks")
    if (checks) {
      rulesets.push({
        id: rs.id,
        name: rs.name,
        contexts: (checks.parameters?.required_status_checks ?? []).map((c) => c.context),
      })
    }
  }
  const pulls = (await getOr<{ number: number; title: string; head: { ref: string } }[]>(
    client,
    `${r}/pulls?state=open&per_page=100`,
    [],
  )) as { number: number; title: string; head: { ref: string } }[]
  // Only `auto` needs the owner's account type, and only when a caller is rendered.
  const ownerType =
    ctx.train?.mode === "render" && ctx.train.schedule === "auto"
      ? (await getOr<{ type?: string }>(client, `/users/${repository.owner}`, {})).type
      : undefined
  return {
    archived: Boolean(meta.archived),
    private: Boolean(meta.private),
    ...(ownerType === undefined ? {} : { ownerType }),
    defaultBranch: meta.default_branch,
    settings: {
      allow_squash_merge: Boolean(meta.allow_squash_merge),
      allow_merge_commit: Boolean(meta.allow_merge_commit),
      allow_rebase_merge: Boolean(meta.allow_rebase_merge),
      delete_branch_on_merge: Boolean(meta.delete_branch_on_merge),
      squash_merge_commit_title: String(meta.squash_merge_commit_title ?? ""),
      squash_merge_commit_message: String(meta.squash_merge_commit_message ?? ""),
    },
    branches,
    tree,
    read: (path) => files.get(path) ?? null,
    protection,
    rulesets,
    openPulls: pulls.map((p) => ({ number: p.number, head: p.head.ref, title: p.title })),
  }
}

// ---- the plan ------------------------------------------------------------------

export function planRepository(repository: Repository, facts: RepoFacts, ctx: PlanContext): Plan {
  const repo = `${repository.owner}/${repository.name}`
  const base = baseFor(repository)
  const empty: Plan = {
    repo,
    base,
    kind: repository.kind,
    idle: true,
    additions: [],
    deletions: [],
    kept: [],
    settings: {},
    protection: [],
    rulesets: [],
    closePulls: [],
    deleteBranches: [],
    pendingPr: null,
  }
  if (facts.archived) return { ...empty, skip: "archived" }
  if (repo === "maxbec/pipeline") {
    return {
      ...empty,
      skip: "dogfoods the pipeline from its own tree (ci.yaml uses the local path)",
    }
  }
  const override = overrideFor(ctx, repository)

  const desired = new Map<string, string>()
  desired.set(
    CONFIG_PATH,
    convertConfig(facts.read(CONFIG_PATH), {
      renderHook: override.renderHook,
      hostedRunner: !facts.private,
      singleQuote: prefersSingleQuotes(facts.read(TRUNK_CONFIG_PATH), ctx.singleQuoteTrunkPlugins),
    }).text,
  )
  desired.set(CALLER_PATH, renderCaller(ctx.template, ctx.pin, override))
  if (ctx.train?.mode === "render") {
    desired.set(
      TRAIN_CALLER_PATH,
      renderTrainCaller(
        ctx.train.template,
        ctx.pin,
        trainScheduleFor(ctx.train.schedule, facts.ownerType),
      ),
    )
  }
  for (const [path, contents] of Object.entries(override.extraFiles ?? {}))
    desired.set(path, contents)
  for (const path of AGENT_FILES) {
    const current = facts.read(path)
    if (current === null) continue
    const next = upgradeAgentsFile(current, repository.kind)
    if (next !== null) desired.set(path, next)
  }
  // `git show` output comes back without its trailing newline for the rendered files, so
  // those compare as text. Agent files are read byte-exact and compare exactly: a missing
  // final newline is the difference Prettier fails them on.
  // An extra file is the repository's own workflow, and Dependabot moves its action
  // pins there. A template that still names the older pin does not take them back.
  const extra = new Set(Object.keys(override.extraFiles ?? {}))
  const unpinned = (text: string) =>
    text.replace(/^(\s*-?\s*uses:\s*[^@\s]+)@[0-9a-f]{40}(\s+#.*)?$/gm, "$1")
  const same = (path: string, a: string | null, b: string) => {
    if (a === null) return false
    if (AGENT_FILES.includes(path)) return a === b
    if (extra.has(path)) return unpinned(a).trimEnd() === unpinned(b).trimEnd()
    return a.trimEnd() === b.trimEnd()
  }
  const additions = [...desired]
    .filter(([path, contents]) => !same(path, facts.read(path), contents))
    .map(([path, contents]) => ({ path, contents }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const legacy = (p: string) =>
    isLegacyPath(p, ctx.legacyPaths) || (ctx.train?.mode === "remove" && p === TRAIN_CALLER_PATH)
  const deletions = facts.tree.filter((p) => legacy(p) && !desired.has(p)).sort()
  const kept = facts.tree
    .filter((p) => p.startsWith(".github/workflows/") && !legacy(p) && !desired.has(p))
    .sort()

  const want: Required<Plan["settings"]> = {
    default_branch: base,
    allow_squash_merge: true,
    allow_merge_commit: repository.kind === "major",
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "PR_BODY",
  }
  const have: Plan["settings"] = { ...facts.settings, default_branch: facts.defaultBranch }
  const settings: Plan["settings"] = {}
  for (const key of Object.keys(want) as (keyof typeof want)[]) {
    if (have[key] !== want[key]) (settings as Record<string, unknown>)[key] = want[key]
  }

  const protection = Object.entries(facts.protection)
    .filter(([, p]) => p.contexts.length !== 1 || p.contexts[0] !== REQUIRED_CONTEXT)
    .map(([branch, p]) => ({ branch, strict: p.strict, contexts: [REQUIRED_CONTEXT] }))
  const rulesets = facts.rulesets
    .filter((r) => r.contexts.length !== 1 || r.contexts[0] !== REQUIRED_CONTEXT)
    .map((r) => ({ id: r.id, name: r.name, contexts: [REQUIRED_CONTEXT] }))
  const closePulls = facts.openPulls
    .filter((p) => BOT_BRANCH.test(p.head))
    .map((p) => ({ number: p.number, head: p.head }))
  const deleteBranches = [
    ...new Set([
      ...facts.branches.filter((b) => BOT_BRANCH.test(b)),
      ...closePulls.map((p) => p.head),
    ]),
  ].sort()
  const pendingPr = facts.openPulls.find((p) => p.head === MIGRATION_BRANCH)?.number ?? null

  const idle =
    additions.length === 0 &&
    deletions.length === 0 &&
    Object.keys(settings).length === 0 &&
    protection.length === 0 &&
    rulesets.length === 0 &&
    closePulls.length === 0 &&
    deleteBranches.length === 0 &&
    pendingPr === null
  return {
    ...empty,
    idle,
    additions,
    deletions,
    kept,
    settings,
    protection,
    rulesets,
    closePulls,
    deleteBranches,
    pendingPr,
  }
}

export function formatPlan(plan: Plan): string {
  const lines = [`${plan.repo} (${plan.kind}, base ${plan.base})`]
  if (plan.skip) return `${lines[0]}: skipped — ${plan.skip}`
  if (plan.idle) return `${lines[0]}: nothing to do`
  for (const a of plan.additions) lines.push(`  + ${a.path} (${a.contents.length} bytes)`)
  for (const d of plan.deletions) lines.push(`  - ${d}`)
  for (const k of plan.kept) lines.push(`  = ${k} (kept, review by hand)`)
  for (const [k, v] of Object.entries(plan.settings))
    lines.push(`  settings.${k} -> ${JSON.stringify(v)}`)
  for (const p of plan.protection)
    lines.push(
      `  protection ${p.branch}: contexts -> ${p.contexts.join(", ")} (strict ${p.strict})`,
    )
  for (const r of plan.rulesets)
    lines.push(`  ruleset ${r.id} "${r.name}": contexts -> ${r.contexts.join(", ")}`)
  for (const p of plan.closePulls) lines.push(`  close PR #${p.number} (${p.head})`)
  for (const b of plan.deleteBranches) lines.push(`  delete branch ${b}`)
  if (plan.pendingPr)
    lines.push(`  migration PR #${plan.pendingPr} is open; merge when ${REQUIRED_CONTEXT} is green`)
  return lines.join("\n")
}

// ---- applying it ----------------------------------------------------------------

function commitBody(plan: Plan, pin: PipelinePin): string {
  const lines = [
    `Callers pinned to maxbec/pipeline@${pin.sha.slice(0, 7)}${pin.version ? ` (v${pin.version.replace(/^v/, "")})` : ""};`,
    `${CONFIG_PATH} in version 3. Versions, tags and release notes are the release train's;`,
    "deploys run on published releases only.",
    "",
  ]
  const agents = plan.additions.map((a) => a.path).filter((path) => AGENT_FILES.includes(path))
  if (agents.length > 0) lines.push(`${agents.join(", ")}: the pipeline section is current.`, "")
  if (plan.deletions.length > 0) lines.push("Removed:", ...plan.deletions.map((d) => `- ${d}`), "")
  if (plan.kept.length > 0) lines.push("Left alone:", ...plan.kept.map((k) => `- ${k}`), "")
  lines.push("Written by train/bin/migrate-repos.ts (maxbec/pipeline).")
  return lines.join("\n")
}

async function refSha(client: GitHubClient, repo: RepoRef, branch: string): Promise<string | null> {
  try {
    const res = await client.rest<{ object: { sha: string } }>(
      "GET",
      `/repos/${repo.owner}/${repo.name}/git/ref/heads/${branch}`,
    )
    return res.body?.object.sha ?? null
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return null
    throw error
  }
}

export async function applyPlan(
  client: GitHubClient,
  repository: Repository,
  plan: Plan,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  if (plan.skip) return { status: "skipped", reason: plan.skip }
  if (plan.idle) return { status: "idle" }
  if (ctx.dryRun) return { status: "planned" }
  const repo: RepoRef = { owner: repository.owner, name: repository.name }
  const r = `/repos/${repo.owner}/${repo.name}`

  if (Object.keys(plan.settings).length > 0) await client.rest("PATCH", r, { body: plan.settings })
  for (const p of plan.protection) {
    await client.rest("PATCH", `${r}/branches/${p.branch}/protection/required_status_checks`, {
      body: { strict: p.strict, contexts: p.contexts },
    })
  }
  for (const rs of plan.rulesets) {
    const full = (await client.rest<Record<string, unknown>>("GET", `${r}/rulesets/${rs.id}`)).body
    if (!full) continue
    const rules = (full.rules as { type: string; parameters?: Record<string, unknown> }[]).map(
      (rule) =>
        rule.type === "required_status_checks"
          ? {
              ...rule,
              parameters: {
                ...rule.parameters,
                required_status_checks: rs.contexts.map((context) => ({ context })),
              },
            }
          : rule,
    )
    await client.rest("PUT", `${r}/rulesets/${rs.id}`, {
      body: {
        name: full.name,
        target: full.target,
        enforcement: full.enforcement,
        conditions: full.conditions,
        bypass_actors: full.bypass_actors ?? [],
        rules,
      },
    })
  }
  for (const p of plan.closePulls) {
    await client.rest("PATCH", `${r}/pulls/${p.number}`, { body: { state: "closed" } })
  }
  for (const branch of plan.deleteBranches) {
    try {
      await client.rest("DELETE", `${r}/git/refs/heads/${branch}`)
    } catch (error) {
      if (!(error instanceof GitHubHttpError && (error.status === 404 || error.status === 422)))
        throw error
    }
  }

  if (plan.additions.length > 0 || plan.deletions.length > 0) {
    let head = await refSha(client, repo, MIGRATION_BRANCH)
    if (head === null) {
      const baseSha = await refSha(client, repo, plan.base)
      if (baseSha === null) throw new Error(`${plan.repo}: base branch ${plan.base} does not exist`)
      await client.rest("POST", `${r}/git/refs`, {
        body: { ref: `refs/heads/${MIGRATION_BRANCH}`, sha: baseSha },
      })
      head = baseSha
    }
    await createSignedCommit(client, {
      repo,
      branch: MIGRATION_BRANCH,
      expectedHeadOid: head,
      message: { headline: MIGRATION_TITLE, body: commitBody(plan, ctx.pin) },
      additions: plan.additions,
      deletions: plan.deletions.map((path) => ({ path })),
    })
  }

  let number = plan.pendingPr
  if (number === null) {
    const open = (
      await client.rest<{ number: number }[]>(
        "GET",
        `${r}/pulls?state=open&head=${repo.owner}:${MIGRATION_BRANCH}&per_page=10`,
      )
    ).body
    number = open?.[0]?.number ?? null
  }
  if (number === null) {
    if ((await refSha(client, repo, MIGRATION_BRANCH)) === null) {
      // Settings-only pass: nothing to put in a PR.
      return { status: "idle" }
    }
    const created = (
      await client.rest<{ number: number }>("POST", `${r}/pulls`, {
        body: {
          title: MIGRATION_TITLE,
          head: MIGRATION_BRANCH,
          base: plan.base,
          body: `${commitBody(plan, ctx.pin)}\n\nMerged by the same script once \`${REQUIRED_CONTEXT}\` is green.`,
        },
      })
    ).body
    if (!created) throw new Error(`${plan.repo}: creating the migration PR returned nothing`)
    number = created.number
  }

  const state = await getPrState(client, repo, number)
  const verdict = canMerge(state)
  if (!verdict.ok) {
    // The base moved while the PR waited for Check: ask GitHub to update the
    // head once per run (`updateBehindOnce`; the script
    // keeps no memo between runs, so each run is one round); the next run
    // sees it current (or conflicting) and decides. A refused update (422:
    // conflict, 409: already updating) is reported, not thrown — the operator
    // reads it in the summary; anything else surfaces as the error it is.
    if (verdict.code === "behind" && verdict.remedy === "update_branch") {
      const update = await updateBehindOnce({ client, repo, pr: state, memo: {} })
      return {
        status: "waiting",
        pr: number,
        reason:
          update.kind === "updated"
            ? `${verdict.reason} (asked GitHub to update it)`
            : `${verdict.reason}; ${update.kind === "already" ? "already asked" : update.reason}`,
      }
    }
    return { status: "waiting", pr: number, reason: verdict.reason }
  }
  const merged = await mergePullRequest(client, repo, number, {
    method: "squash",
    expectedHeadSha: state.headSha,
    title: `${MIGRATION_TITLE} (#${number})`,
    body: state.body,
  })
  return { status: "merged", pr: number, sha: merged.sha }
}
