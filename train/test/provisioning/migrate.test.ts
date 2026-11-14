import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import type { Repository } from "../../src/types.ts"
import { GitHubClient, GitHubHttpError } from "../../src/github/client.ts"
import { canMerge, REQUIRED_CHECKS } from "../../src/github/pr.ts"
import {
  applyPlan,
  convertConfig,
  MIGRATION_BRANCH,
  MIGRATION_TITLE,
  planRepository,
  type RepoFacts,
  readFacts,
  renderAgentsBlock,
  renderCaller,
  renderTrainCaller,
  TRAIN_CALLER_PATH,
  trainScheduleFor,
  upgradeAgentsFile,
} from "../../src/provisioning/migrate.ts"
import { repositoryOf } from "../helpers/repository.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { FakeGitHub, git } from "../workflow/fake-github.ts"

const home = scratchDir("train-migrate-")

const TEMPLATE = `# The one caller every repository carries. The fleet tool renders it:
# __PIPELINE_SHA__ and __PIPELINE_VERSION__ become the pinned commit and its tag.
name: Pipeline
on:
  pull_request:
  release:
    types: [published]
jobs:
  pipeline:
    # __PIPELINE_VERSION__
    uses: maxbec/pipeline/.github/workflows/universal-pipeline.yaml@__PIPELINE_SHA__
    with:
      config-file: .github/pipeline.yaml
    secrets:
      CF_ACCESS_CLIENT_ID: \${{ secrets.CF_ACCESS_CLIENT_ID }}
      RENDER_DEPLOY_HOOK: \${{ secrets.RENDER_DEPLOY_HOOK }}
      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`
const PIN = { sha: "a".repeat(40), version: "5.0.0" }

const V2_CONFIG = `---
version: '2.0'
stack: nodejs
runner:
  labels: [self-hosted, rack-a]
runtime:
  node_version: 22
pipeline:
  enable_caching: true
security:
  enable: true
  trufflehog: true
  dependency_review: true
  fail_on_secrets: true
  fail_on_vulnerabilities: false # warn only for now
lint:
  enable: true
  command: trunk check --ci --no-fix
test:
  enable: true
  coverage: true
  services:
    - docker
  command: pnpm turbo run type-check && pnpm turbo run test
build:
  enable: true
  command: pnpm turbo run build
  upload_artifacts: false
deployment:
  provider: docker
  docker:
    images:
      - name: default
        dockerfile: docker/app/Dockerfile
        context: .
        registry: ghcr
        platforms: linux/amd64
      - name: cron
        dockerfile: docker/app/cron.Dockerfile
        context: .
        registry: ghcr
        platforms: linux/amd64
release:
  enable: true
  strategy: release-please
  prerelease_branches:
    - branch: dev
      label: beta
`

// ---- pure conversions ------------------------------------------------------

test("a v2 config becomes v3: deploy replaces deployment, release and pipeline blocks vanish", () => {
  const out = convertConfig(V2_CONFIG, { renderHook: true })
  const doc = out.parsed
  assert.equal(doc.version, "3")
  assert.equal(doc.stack, "nodejs")
  assert.deepEqual(doc.runner, { labels: ["self-hosted", "rack-a"] })
  assert.deepEqual(doc.runtime, { node_version: "22" })
  assert.equal(doc.pipeline, undefined)
  assert.equal(doc.release, undefined)
  assert.equal(doc.deployment, undefined)
  assert.deepEqual(doc.security, {
    enable: true,
    trufflehog: true,
    dependency_review: true,
    fail_on_secrets: true,
    fail_on_vulnerabilities: false,
  })
  assert.deepEqual(
    doc.lint,
    { enable: true },
    "a trunk command is dropped: the pipeline runs trunk natively",
  )
  assert.deepEqual(doc.test, {
    enable: true,
    command: "pnpm turbo run type-check && pnpm turbo run test",
  })
  assert.deepEqual(doc.build, { enable: true, command: "pnpm turbo run build" })
  assert.equal(doc.deploy.provider, "docker-ghcr")
  assert.deepEqual(doc.deploy.docker?.images, [
    {
      name: "default",
      dockerfile: "docker/app/Dockerfile",
      context: ".",
      platforms: "linux/amd64",
    },
    {
      name: "cron",
      dockerfile: "docker/app/cron.Dockerfile",
      context: ".",
      platforms: "linux/amd64",
    },
  ])
  assert.deepEqual(doc.deploy.render, { hook: true })
  assert.match(
    out.text,
    /^---\nversion: "3"\n/,
    "the file starts with the version, quoted the way prettier wants it",
  )
  assert.doesNotMatch(out.text, /registry|coverage|services|upload_artifacts|enable_caching/)
})

test("a repository without a config gets the minimal v3 file, and provider none stays none", () => {
  const fresh = convertConfig(null, {})
  assert.equal(fresh.parsed.version, "3")
  assert.equal(fresh.parsed.deploy.provider, "none")
  const none = convertConfig(
    "version: '2.0'\nstack: nodejs\ndeployment:\n  provider: none\nrelease:\n  enable: false\n",
    {},
  )
  assert.equal(none.parsed.deploy.provider, "none")
  assert.equal(none.parsed.stack, "nodejs")
})

test("the quote style follows the repository's own formatter", () => {
  // A shared trunk plugin may ship a prettier config with singleQuote: true,
  // and a double-quoted file then fails
  // `trunk fmt`. A repository on plain trunk wants prettier's default instead.
  assert.match(convertConfig(V2_CONFIG, { singleQuote: true }).text, /^---\nversion: '3'\n/)
  assert.match(convertConfig(V2_CONFIG, {}).text, /^---\nversion: "3"\n/)
  const doubled = '---\nversion: "3"\nruntime:\n  node_version: "20"\n'
  assert.equal(
    convertConfig(doubled, { singleQuote: true }).text,
    "---\nversion: '3'\nruntime:\n  node_version: '20'\n",
    "an existing file is re-quoted too, or it stays unformatted for ever",
  )
})

test("a repository whose trunk config names a single-quote plugin gets a single-quoted config", () => {
  const plan = planRepository(
    repository("gadgets", "small"),
    facts({
      tree: [".trunk/trunk.yaml", ".github/pipeline.yaml"],
      read: (path) =>
        path === ".trunk/trunk.yaml"
          ? "plugins:\n  sources:\n    - id: acme\n      uri: https://github.com/acme/acme-trunk-plugin\n"
          : path === ".github/pipeline.yaml"
            ? V2_CONFIG
            : null,
    }),
    { pin: PIN, template: TEMPLATE, overrides: {}, singleQuoteTrunkPlugins: ["acme-trunk-plugin"] },
  )
  const config = plan.additions.find((a) => a.path === ".github/pipeline.yaml")
  assert.ok(
    config?.contents.startsWith("---\nversion: '3'\n"),
    config?.contents.slice(0, 40) ?? "no config addition",
  )
})

test("a v3 config keeps its content and its comments, apart from the requested overrides", () => {
  const v3 =
    '---\nversion: "3"\n# hand-written, keep me\nstack: python\ndeploy:\n  provider: none\n'
  assert.equal(convertConfig(v3, {}).text, v3)
})

test("a v3 config the first fleet run wrote is repaired, comments and all", () => {
  // Run one wrote pipeline.yaml without `---`, in single quotes, and with the
  // trunk lint command that the runner has no binary for. Passing the file
  // through meant no later pass could ever repair it: trunk repositories failed
  // yamllint and prettier, and a repository's Check died with `trunk: command not found`.
  const v3 =
    "version: '3'\n# hand-written, keep me\nlint:\n  enable: true\n  command: trunk check --ci --no-fix\n"
  assert.equal(
    convertConfig(v3, {}).text,
    '---\nversion: "3"\n# hand-written, keep me\nlint:\n  enable: true\n',
  )
})

test("a v3 config keeps a folded command the way it was written", () => {
  // The dumper wrote one repository's three-line test command back as one line of 140
  // characters, so every migration run planned a change to a file nobody touched.
  const v3 =
    '---\nversion: "3"\ntest:\n  enable: true\n  command: >-\n    node a.mjs\n    && node b.mjs\n    && node c.mjs\ndeploy:\n  provider: none\n'
  assert.equal(convertConfig(v3, {}).text, v3)
  // The repairs still happen around it.
  assert.equal(convertConfig(v3.replace('---\nversion: "3"', "version: '3'"), {}).text, v3)
})

test("unknown v2 providers are refused rather than guessed", () => {
  assert.throws(
    () => convertConfig("version: '2.0'\ndeployment:\n  provider: coolify\n", {}),
    /provider 'coolify'/,
  )
})

test("the caller is the template with the pin filled in and per-repository secret overrides applied", () => {
  const plain = renderCaller(TEMPLATE, PIN, {})
  assert.match(
    plain,
    new RegExp(
      `\n    # v5.0.0\n    uses: maxbec/pipeline/.github/workflows/universal-pipeline.yaml@${"a".repeat(40)}\n`,
    ),
  )
  assert.doesNotMatch(plain, /__PIPELINE/)
  const renamed = renderCaller(TEMPLATE, PIN, {
      secrets: { RENDER_DEPLOY_HOOK: "${{ secrets.RENDER_SITE_PROD_HOOK }}" },
  })
  assert.match(renamed, /RENDER_DEPLOY_HOOK: \$\{\{ secrets\.RENDER_SITE_PROD_HOOK \}\}/)
  assert.match(
    renamed,
    /CF_ACCESS_CLIENT_ID: \$\{\{ secrets\.CF_ACCESS_CLIENT_ID \}\}/,
    "other secrets untouched",
  )
  assert.throws(() => renderCaller(TEMPLATE, PIN, { secrets: { NOPE: "x" } }), /NOPE/)
  assert.match(
    plain,
    /^# a{40} and v5\.0\.0 become the pinned commit and its tag\.$/m,
    "prose placeholders filled too",
  )
  const untagged = renderCaller(TEMPLATE, { sha: PIN.sha, version: null }, {})
  assert.match(
    untagged,
    new RegExp(
      `# an untagged commit\n    universal-pipeline.yaml@${"a".repeat(40)}\n`.replace(
        "universal",
        "uses: maxbec/pipeline/.github/workflows/universal",
      ),
    ),
    "no version, the comment says so",
  )
  assert.match(untagged, /an untagged commit become the pinned commit/)
})

// ---- planning --------------------------------------------------------------

function repository(name: string, kind: "major" | "small", owner = "maxbec"): Repository {
  return repositoryOf({ owner, name, kind, path: `/nowhere/${name}` })
}

const FLAMA_TREE = [
  ".flama/policy.yaml",
  ".flama/contract.json",
  ".github/pipeline.yaml",
  ".github/workflows/ci.yaml",
  ".github/workflows/flama-auto-merge.yml",
  ".github/workflows/flama-branch-guard.yml",
  ".github/workflows/claude-code-fix.yaml",
  ".github/workflows/create-release-pr.yaml",
  ".github/workflows/cron-dunning.yml",
  ".github/workflows/nightly-maintenance.yaml",
  ".github/release-please-config.json",
  ".release-please-manifest.json",
  ".release-please-manifest.dev.json",
  "release-please-config.main.json",
  "CHANGELOG.md",
  "CHANGELOG.dev.md",
  "package.json",
  "src/index.ts",
]

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    archived: false,
    private: true,
    defaultBranch: "main",
    settings: {
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      delete_branch_on_merge: false,
      squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
      squash_merge_commit_message: "COMMIT_MESSAGES",
    },
    branches: ["dev", "main", "release-please--branches--dev", "feat/keep-me"],
    tree: FLAMA_TREE,
    read: (path) =>
      path === ".github/pipeline.yaml"
        ? V2_CONFIG
        : path === ".github/workflows/ci.yaml"
          ? "old caller"
          : null,
    protection: {
      dev: { strict: true, contexts: ["Check Gate", "branch-guard / Flama Branch Guard"] },
      main: { strict: true, contexts: ["Check Gate"] },
    },
    rulesets: [],
    openPulls: [
      {
        number: 686,
        head: "release-please--branches--dev",
        title: "chore(dev): release 1.2.0-beta.3",
      },
      { number: 700, head: "feat/keep-me", title: "feat: keep me" },
    ],
    ...overrides,
  }
}

test("a major repository's plan: caller + config written, Flama and release-please gone, dev is the default, merges normalized", () => {
  const plan = planRepository(repository("widgets", "major", "acme"), facts(), {
    pin: PIN,
    template: TEMPLATE,
    overrides: {
      "acme/widgets": {
              secrets: { RENDER_DEPLOY_HOOK: "${{ secrets.RENDER_SITE_PROD_HOOK }}" },
        renderHook: true,
        extraFiles: { ".github/workflows/extra.yaml": "name: Extra\n" },
      },
    },
  })
  assert.equal(plan.skip, undefined)
  assert.equal(plan.base, "dev")
  assert.deepEqual(
    plan.additions.map((a) => a.path),
    [".github/pipeline.yaml", ".github/workflows/ci.yaml", ".github/workflows/extra.yaml"],
  )
  const caller = plan.additions.find((a) => a.path === ".github/workflows/ci.yaml")?.contents ?? ""
  assert.match(caller, /RENDER_SITE_PROD_HOOK/)
  const config = plan.additions.find((a) => a.path === ".github/pipeline.yaml")?.contents ?? ""
  assert.match(config, /provider: docker-ghcr/)
  assert.match(config, /render:\n\s+hook: true/)
  assert.deepEqual(plan.deletions.sort(), [
    ".flama/contract.json",
    ".flama/policy.yaml",
    ".github/release-please-config.json",
    ".github/workflows/claude-code-fix.yaml",
    ".github/workflows/create-release-pr.yaml",
    ".github/workflows/flama-auto-merge.yml",
    ".github/workflows/flama-branch-guard.yml",
    ".release-please-manifest.dev.json",
    ".release-please-manifest.json",
    "CHANGELOG.dev.md",
    "release-please-config.main.json",
  ])
  assert.deepEqual(plan.kept.sort(), [
    ".github/workflows/cron-dunning.yml",
    ".github/workflows/nightly-maintenance.yaml",
  ])
  assert.deepEqual(plan.settings, {
    default_branch: "dev",
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "PR_BODY",
  })
  assert.deepEqual(plan.protection, [
    { branch: "dev", strict: true, contexts: ["pipeline / Check"] },
    { branch: "main", strict: true, contexts: ["pipeline / Check"] },
  ])
  assert.deepEqual(plan.closePulls, [{ number: 686, head: "release-please--branches--dev" }])
  assert.deepEqual(plan.deleteBranches, ["release-please--branches--dev"])
})

test("a small repository targets main, forbids merge commits and touches nothing that is already right", () => {
  const plan = planRepository(
    repository("gadgets", "small"),
    facts({
      branches: ["main"],
      tree: ["package.json", "README.md"],
      read: () => null,
      protection: {},
      openPulls: [],
      settings: {
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        delete_branch_on_merge: true,
        squash_merge_commit_title: "PR_TITLE",
        squash_merge_commit_message: "PR_BODY",
      },
    }),
    { pin: PIN, template: TEMPLATE, overrides: {} },
  )
  assert.equal(plan.base, "main")
  assert.deepEqual(plan.settings, {}, "nothing to change")
  assert.deepEqual(
    plan.additions.map((a) => a.path),
    [".github/pipeline.yaml", ".github/workflows/ci.yaml"],
  )
  assert.match(plan.additions[0]?.contents ?? "", /provider: none/)
  assert.deepEqual(plan.deletions, [])
  assert.deepEqual(plan.protection, [])
  assert.deepEqual(plan.closePulls, [])
})

test("a major repository that still allows only squash gets merge commits back for promotions", () => {
  const plan = planRepository(
    repository("x", "major"),
    facts({
      settings: { ...facts().settings, allow_merge_commit: false, default_branch: "dev" } as never,
    }),
    { pin: PIN, template: TEMPLATE, overrides: {} },
  )
  assert.equal(plan.settings.allow_merge_commit, true)
})

test("archived repositories and the pipeline itself are skipped with a reason", () => {
  const archived = planRepository(repository("old", "major"), facts({ archived: true }), {
    pin: PIN,
    template: TEMPLATE,
    overrides: {},
  })
  assert.match(archived.skip ?? "", /archived/)
  const pipeline = planRepository(repository("pipeline", "major"), facts(), {
    pin: PIN,
    template: TEMPLATE,
    overrides: {},
  })
  assert.match(pipeline.skip ?? "", /dogfoods/)
})

test("a repository already on the slim caller has an empty plan", () => {
  const first = planRepository(
    repository("done", "small"),
    facts({ branches: ["main"], tree: [], read: () => null, protection: {}, openPulls: [] }),
    {
      pin: PIN,
      template: TEMPLATE,
      overrides: {},
    },
  )
  const written = new Map(first.additions.map((a) => [a.path, a.contents]))
  const second = planRepository(
    repository("done", "small"),
    facts({
      branches: ["main"],
      tree: [...written.keys()],
      read: (p) => written.get(p) ?? null,
      protection: {},
      openPulls: [],
      settings: { ...facts().settings, ...first.settings } as never,
    }),
    { pin: PIN, template: TEMPLATE, overrides: {} },
  )
  assert.deepEqual(second.additions, [])
  assert.deepEqual(second.deletions, [])
  assert.equal(second.idle, true)
})

test("an extra file whose action pins the repository moved is left alone; any other difference is written", () => {
  const path = ".github/workflows/extra.yaml"
  const template = `jobs:\n  a:\n    steps:\n      - uses: pnpm/action-setup@${"a".repeat(40)} # v6.1.0\n      - run: pnpm test\n`
  const bumped = template.replace(`${"a".repeat(40)} # v6.1.0`, `${"b".repeat(40)} # v6.1.1`)
  const ctx = {
    pin: PIN,
    template: TEMPLATE,
    overrides: { "maxbec/extra": { extraFiles: { [path]: template } } },
  }
  const plan = (current: string) =>
    planRepository(
      repository("extra", "small"),
      facts({
        branches: ["main"],
        tree: [path],
        read: (p) => (p === path ? current : null),
        protection: {},
        openPulls: [],
      }),
      ctx,
    ).additions.map((a) => a.path)
  // Dependabot bumped the pin in the repository: not a difference worth a commit.
  assert.equal(plan(bumped).includes(path), false)
  assert.equal(plan(bumped.replace("pnpm test", "pnpm lint")).includes(path), true)
})

// ---- the live shape, against the fake --------------------------------------

/** Two ruleset rules as GitHub returns them: approvals and one required context. */
const checks = (context: string) => [
  { type: "pull_request", parameters: { required_approving_review_count: 0 } },
  { type: "required_status_checks", parameters: { required_status_checks: [{ context }] } },
]

/** A bare origin with `dev` and `main`, a v2 tree with Flama on dev, and a release-please branch. */
function seed(name: string) {
  const origin = join(home, `${name}.git`)
  git(home, "init", "-q", "--bare", "-b", "main", origin)
  const work = join(home, `${name}-seed`)
  git(home, "clone", "-q", origin, work)
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(work, path)), { recursive: true })
    writeFileSync(join(work, path), text)
  }
  put("package.json", JSON.stringify({ name, version: "1.0.0", scripts: { test: "true" } }))
  put(
    ".github/pipeline.yaml",
    "version: '2.0'\nstack: nodejs\ndeployment:\n  provider: none\nrelease:\n  enable: false\n",
  )
  put(".github/workflows/ci.yaml", "name: old\n")
  put(".github/workflows/flama-policy.yml", "name: flama\n")
  put(".flama/policy.yaml", "gates: []\n")
  put(".release-please-manifest.json", "{}\n")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "init")
  git(work, "push", "-q", "origin", "main")
  git(work, "checkout", "-q", "-b", "dev")
  put("src.ts", "export const a = 1\n")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "feat: a")
  git(work, "push", "-q", "origin", "dev")
  git(work, "checkout", "-q", "-b", "release-please--branches--dev")
  put("CHANGELOG.md", "# 1.1.0-beta.1\n")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "chore(dev): release 1.1.0-beta.1")
  git(work, "push", "-q", "origin", "release-please--branches--dev")
  const gh = new FakeGitHub({ origin, owner: "maxbec", name })
  gh.settings.default_branch = "main"
  gh.settings.allow_rebase_merge = true
  gh.protection.set("dev", { strict: true, contexts: ["Check Gate", "Old Preflight"] })
  gh.rulesets.push(
    {
      id: 1,
      name: "main",
      source_type: "Repository",
      target: "branch",
      enforcement: "active",
      conditions: {},
      rules: checks("Check Gate"),
    },
    {
      id: 2,
      name: "Require Check Gate",
      source_type: "Organization",
      target: "branch",
      enforcement: "active",
      conditions: {},
      rules: checks("Check Gate"),
    },
  )
  const repo = { ...repository(name, "major"), path: origin }
  return { origin, gh, repo }
}

test("apply converges: settings, protection, bot PR, one signed commit, one PR; the rerun merges when Check is green", async () => {
  const { origin, gh, repo } = seed("apply")
  const botPr = await gh.client.rest<{ number: number }>("POST", `/repos/maxbec/apply/pulls`, {
    body: {
      title: "chore(dev): release 1.1.0-beta.1",
      head: "release-please--branches--dev",
      base: "dev",
      body: "",
    },
  })
  const ctx = { pin: PIN, template: TEMPLATE, overrides: {}, ref: (b: string) => b }
  const before = await readFacts(gh.client, repo, ctx)
  assert.equal(before.defaultBranch, "main")
  assert.deepEqual(
    before.openPulls.map((p) => p.number),
    [botPr.body?.number],
  )
  const plan = planRepository(repo, before, ctx)
  assert.equal(plan.base, "dev")
  assert.deepEqual(
    plan.rulesets,
    [{ id: 1, name: "main", contexts: ["pipeline / Check"] }],
    "the repository's own ruleset is rewritten; the organization's is not this repository's to edit",
  )

  gh.checks = "pending"
  const first = await applyPlan(gh.client, repo, plan, ctx)
  assert.equal(first.status, "waiting", JSON.stringify(first))
  assert.equal(gh.settings.default_branch, "dev")
  assert.equal(gh.settings.allow_rebase_merge, false)
  assert.equal(gh.settings.delete_branch_on_merge, true)
  assert.deepEqual(gh.protection.get("dev"), { strict: true, contexts: ["pipeline / Check"] })
  const rewritten = gh.rulesets[0]?.rules as { type: string; parameters: Record<string, unknown> }[]
  assert.deepEqual(rewritten[1]?.parameters.required_status_checks, [
    { context: "pipeline / Check" },
  ])
  assert.deepEqual(rewritten[0], checks("x")[0], "the other rules travel unchanged")
  const org = gh.rulesets[1]?.rules as { type: string; parameters: Record<string, unknown> }[]
  assert.deepEqual(
    org[1]?.parameters.required_status_checks,
    [{ context: "Check Gate" }],
    "untouched",
  )
  assert.equal(gh.pulls.get(botPr.body?.number ?? 0)?.state, "closed", "the bot PR is closed")
  assert.equal(gh.sha("release-please--branches--dev"), null, "and its branch deleted")
  assert.equal(gh.commits.length, 1, "exactly one createCommitOnBranch")
  assert.equal(gh.commits[0]?.branch, MIGRATION_BRANCH)
  assert.deepEqual(gh.commits[0]?.additions, [".github/pipeline.yaml", ".github/workflows/ci.yaml"])
  assert.deepEqual(gh.commits[0]?.deletions.sort(), [
    ".flama/policy.yaml",
    ".github/workflows/flama-policy.yml",
    ".release-please-manifest.json",
  ])
  const migration = [...gh.pulls.values()].find((p) => p.head === MIGRATION_BRANCH)
  assert.ok(migration, "a migration PR")
  assert.equal(migration.title, MIGRATION_TITLE)
  assert.equal(migration.base, "dev")
  assert.equal(first.pr, migration.number)
  assert.equal(
    git(origin, "show", `${MIGRATION_BRANCH}:.github/pipeline.yaml`).startsWith(
      '---\nversion: "3"',
    ),
    true,
  )
  assert.throws(() => git(origin, "show", `${MIGRATION_BRANCH}:.flama/policy.yaml`))

  // Rerun while pending: nothing new is written, the PR is reused.
  const again = await applyPlan(
    gh.client,
    repo,
    planRepository(repo, await readFacts(gh.client, repo, ctx), ctx),
    ctx,
  )
  assert.equal(again.status, "waiting")
  assert.equal(gh.commits.length, 1, "idempotent: no second commit")
  assert.equal([...gh.pulls.values()].filter((p) => p.head === MIGRATION_BRANCH).length, 1)

  // Check reports green: the rerun merges, pinned to the head it verified.
  gh.checks = "success"
  const merged = await applyPlan(
    gh.client,
    repo,
    planRepository(repo, await readFacts(gh.client, repo, ctx), ctx),
    ctx,
  )
  assert.equal(merged.status, "merged", JSON.stringify(merged))
  assert.equal(gh.pulls.get(migration.number)?.merged, true)
  assert.equal(
    git(origin, "show", "dev:.github/workflows/ci.yaml").includes(
      `# v5.0.0\n    uses: maxbec/pipeline/.github/workflows/universal-pipeline.yaml@${PIN.sha}\n`,
    ),
    true,
  )

  // And once merged the facts show nothing left to do.
  const done = planRepository(repo, await readFacts(gh.client, repo, ctx), ctx)
  assert.equal(done.idle, true, JSON.stringify(done))
  const nothing = await applyPlan(gh.client, repo, done, ctx)
  assert.equal(nothing.status, "idle")
})

test("dry runs write nothing", async () => {
  const { gh, repo } = seed("dry")
  const ctx = { pin: PIN, template: TEMPLATE, overrides: {}, ref: (b: string) => b }
  const plan = planRepository(repo, await readFacts(gh.client, repo, ctx), ctx)
  const writes = gh.calls.length
  const result = await applyPlan(gh.client, repo, plan, { ...ctx, dryRun: true })
  assert.equal(result.status, "planned")
  assert.equal(gh.calls.filter((c) => c.method !== "GET").length, 0)
  assert.ok(gh.calls.length >= writes)
  assert.equal(gh.commits.length, 0)
})

// ---- the merge gate --------------------------------------------------------

test("canMerge requires pipeline / Check by default: a PR without it is pending, not green", () => {
  assert.deepEqual(REQUIRED_CHECKS, ["pipeline / Check"])
  const base = {
    number: 1,
    title: "feat: x",
    body: "",
    state: "OPEN",
    merged: false,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRefName: "dev",
    headRefName: "feat/x",
    headSha: "deadbeef",
    signed: true,
    signatureState: "VALID",
    commits: [{ oid: "deadbeef", headline: "feat: x", signed: true, signatureState: "VALID" }],
    headInCommits: true,
    truncated: { commits: false, checks: false, reviewThreads: false },
    reviewDecision: null,
    statusCheckRollup: "SUCCESS",
    reviewThreads: [],
    baseRule: null,
    checks: [{ name: "Something Else", status: "COMPLETED", conclusion: "SUCCESS" }],
  }
  const missing = canMerge(base as never)
  assert.equal(missing.ok, false)
  assert.match((missing as { reason: string }).reason, /pipeline \/ Check has not reported/)
  const green = canMerge({
    ...base,
    checks: [{ name: "pipeline / Check", status: "COMPLETED", conclusion: "SUCCESS" }],
  } as never)
  assert.equal(green.ok, true)
})

test("the rendered caller ends with a newline and keeps every line within 120 characters", () => {
  // The template comes out of `git show`, which the CLI trims; the first fleet
  // run wrote every ci.yaml without a final newline and trunk's yamllint failed.
  const rendered = renderCaller(TEMPLATE.trimEnd(), { sha: PIN.sha, version: "5.0.0-beta.12" }, {})
  assert.ok(rendered.endsWith("\n"))
  assert.ok(!rendered.endsWith("\n\n"))
  for (const line of rendered.split("\n")) assert.ok(line.length <= 120, `${line.length}: ${line}`)
  // The old inline style (`@sha # vX`) is 124 characters with a prerelease tag; refuse it.
  const inline = TEMPLATE.replace("    # __PIPELINE_VERSION__\n", "").replace(
    "@__PIPELINE_SHA__",
    "@__PIPELINE_SHA__ # __PIPELINE_VERSION__",
  )
  assert.throws(() => renderCaller(inline, { sha: PIN.sha, version: "5.0.0-beta.12" }, {}), /120/)
})

test("a rendered pipeline.yaml starts with a document marker; a trunk lint command is dropped, other commands stay", () => {
  // yamllint's document-start rule failed the first fleet run on every trunk repository.
  assert.ok(convertConfig(V2_CONFIG, {}).text.startsWith("---\n"))
  assert.ok(convertConfig(null, {}).text.startsWith("---\n"))
  const kept = convertConfig(V2_CONFIG.replace("trunk check --ci --no-fix", "pnpm lint"), {})
  assert.deepEqual(kept.parsed.lint, { enable: true, command: "pnpm lint" })
  const v3 = '---\nversion: "3"\ndeploy:\n  provider: none\n'
  assert.equal(convertConfig(v3, {}).text, v3, "an existing v3 file keeps its content")
})

test("a public repository is pinned to GitHub-hosted runners, whatever the org variable says", () => {
  // An organization's PIPELINE_RUNNER routed a public repository's Check to a
  // self-hosted runner group that does not serve public repositories: queued for ever.
  const noRunner = V2_CONFIG.replace("runner:\n  labels: [self-hosted, rack-a]\n", "")
  assert.deepEqual(convertConfig(noRunner, { hostedRunner: true }).parsed.runner, {
    labels: ["ubuntu-latest"],
  })
  assert.deepEqual(
    convertConfig(V2_CONFIG, { hostedRunner: true }).parsed.runner,
    { labels: ["self-hosted", "rack-a"] },
    "explicit labels are kept",
  )
  assert.equal(
    convertConfig(noRunner, {}).parsed.runner,
    undefined,
    "private repositories follow the org variable",
  )
  assert.deepEqual(convertConfig(null, { hostedRunner: true }).parsed.runner, {
    labels: ["ubuntu-latest"],
  })
  const v3 = '---\nversion: "3"\ndeploy:\n  provider: none\n'
  assert.deepEqual(convertConfig(v3, { hostedRunner: true }).parsed.runner, {
    labels: ["ubuntu-latest"],
  })
  const plan = planRepository(
    repository("dotgithub", "small"),
    facts({
      private: false,
      branches: ["main"],
      tree: ["README.md"],
      read: () => null,
      protection: {},
      openPulls: [],
    }),
    { pin: PIN, template: TEMPLATE, overrides: {} },
  )
  const config = plan.additions.find((a) => a.path === ".github/pipeline.yaml")
  assert.match(config?.contents ?? "", /runner:\n {2}labels:\n {4}- ubuntu-latest\n/)
})

test("a waiting migration PR that falls behind its base is updated once, then merges when current and green", async () => {
  const { gh, repo } = seed("behind")
  const ctx = { pin: PIN, template: TEMPLATE, overrides: {}, ref: (b: string) => b }
  const apply = async () =>
    applyPlan(
      gh.client,
      repo,
      planRepository(repo, await readFacts(gh.client, repo, ctx), ctx),
      ctx,
    )
  gh.checks = "pending"
  const first = await apply()
  assert.equal(first.status, "waiting", JSON.stringify(first))

  // dev moves on while the PR waits: BEHIND, and the engine never asked GitHub to update it.
  const work = join(home, "behind-seed")
  git(work, "checkout", "-q", "dev")
  writeFileSync(join(work, "other.ts"), "export const b = 2\n")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "feat: b")
  git(work, "push", "-q", "origin", "dev")
  gh.checks = "success"
  const headBefore = gh.sha(MIGRATION_BRANCH)
  const updates = () => gh.calls.filter((c) => c.path.endsWith("/update-branch")).length
  const behind = await apply()
  assert.equal(behind.status, "waiting", JSON.stringify(behind))
  assert.match((behind as { reason: string }).reason, /behind/)
  assert.equal(updates(), 1, "one update-branch")
  assert.notEqual(gh.sha(MIGRATION_BRANCH), headBefore, "the fake moved the head")
  assert.equal(gh.commits.length, 1, "no second migration commit")

  const merged = await apply()
  assert.equal(merged.status, "merged", JSON.stringify(merged))
  assert.equal(updates(), 1, "no second update once current")
})

test("a refused update-branch (422) is reported as waiting with the reason, not recorded as an error", async () => {
  const { gh, repo } = seed("behind-refused")
  const ctx = { pin: PIN, template: TEMPLATE, overrides: {}, ref: (b: string) => b }
  gh.checks = "pending"
  const first = await applyPlan(
    gh.client,
    repo,
    planRepository(repo, await readFacts(gh.client, repo, ctx), ctx),
    ctx,
  )
  assert.equal(first.status, "waiting", JSON.stringify(first))
  const work = join(home, "behind-refused-seed")
  git(work, "checkout", "-q", "dev")
  writeFileSync(join(work, "other.ts"), "export const b = 2\n")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "feat: b")
  git(work, "push", "-q", "origin", "dev")
  gh.checks = "success"

  const answering = (status: number) =>
    new GitHubClient({
      tokens: { token: async () => "fake" },
      fetch: (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (init?.method === "PUT" && url.endsWith("/update-branch")) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: `answer ${status}` }), { status }),
          )
        }
        return gh.handle(input, init)
      },
    })
  const apply = async (client: GitHubClient) =>
    applyPlan(client, repo, planRepository(repo, await readFacts(client, repo, ctx), ctx), ctx)
  const refused = await apply(answering(422))
  assert.equal(refused.status, "waiting", JSON.stringify(refused))
  assert.match((refused as { reason: string }).reason, /refused the update/)
  assert.match((refused as { reason: string }).reason, /422/)
  // Anything else is not a decision the script can make: it surfaces, and the operator reruns.
  await assert.rejects(
    apply(answering(502)),
    (error: unknown) => error instanceof GitHubHttpError && error.status === 502,
  )
})

const FLAMA_AGENTS = [
  "# Widgets",
  "",
  "Own rules stay.",
  "",
  "<!-- prettier-ignore-start -->",
  "<!-- flama-delivery:start -->",
  "",
  "## Flama delivery",
  "",
  "Run deterministic checks only through `./scripts/delivery`.",
  "",
  "<!-- flama-delivery:end -->",
  "<!-- prettier-ignore-end -->",
  "",
].join("\n")

test("the Flama section of an agent file becomes the pipeline section; the rest stays the repository's own", () => {
  const major = upgradeAgentsFile(FLAMA_AGENTS, "major")
  assert.ok(major)
  assert.match(
    major,
    /^# Widgets\n\nOwn rules stay\.\n\n<!-- prettier-ignore-start -->\n<!-- pipeline:start -->\n/,
  )
  assert.match(major, /<!-- pipeline:end -->\n<!-- prettier-ignore-end -->\n$/)
  assert.doesNotMatch(major, /[Ff]lama/)
  assert.match(major, /target `dev`/)
  assert.match(major, /`pipeline \/ Check`/)
  assert.match(major, /`train\/bin\/migrate-repos\.ts`/)
  const small = upgradeAgentsFile(FLAMA_AGENTS, "small") ?? ""
  assert.match(small, /target `main`; squash merge\. There is no `dev` here\./)
  assert.doesNotMatch(small, /promote\/\*/)
  // Idempotent: a current section is left alone, an outdated one is rewritten.
  assert.equal(upgradeAgentsFile(major, "major"), null)
  const outdated = major.replace("## Pipeline", "## Pipeline (2026-09)")
  assert.equal(upgradeAgentsFile(outdated, "major"), major)
  // A file without any section is the repository's own: untouched.
  assert.equal(upgradeAgentsFile("# Plain\n\nNo section here.\n", "major"), null)
  // Exactly one trailing newline, whatever came in: Prettier fails a file without it.
  assert.equal(upgradeAgentsFile(FLAMA_AGENTS.trimEnd(), "major"), major)
  assert.equal(upgradeAgentsFile(major.trimEnd(), "major"), major)
  assert.equal(upgradeAgentsFile(`${major}\n\n`, "major"), major)
  assert.equal(renderAgentsBlock("major").split("\n").at(-1), "<!-- pipeline:end -->")
})

test("the pipeline section carries the secrets rule, which a session that sees only this file gets nowhere else", () => {
  for (const kind of ["major", "small"] as const) {
    assert.match(
      renderAgentsBlock(kind),
      /\n- Never print or commit a secret value\. CI credentials arrive as GitHub secrets;/,
    )
  }
})

test("the pipeline section is laid out the way Prettier's proseWrap: always at 120 columns would, so Trunk stays green", () => {
  for (const kind of ["major", "small"] as const) {
    const lines = renderAgentsBlock(kind).split("\n")
    for (const line of lines) assert.ok(line.length <= 120, `${line.length} columns: ${line}`)
    // Greedy: the first word of a continuation line would not have fit on the line before it.
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1] ?? ""
      const line = lines[i] ?? ""
      if (!line.startsWith("  ") || prev.startsWith("<!--") || prev === "") continue
      const word = line.trim().split(" ")[0] ?? ""
      assert.ok(
        prev.length + 1 + word.length > 120,
        `"${word}" would still have fit after: ${prev}`,
      )
    }
  }
  // One line pinned to Prettier's own output (prettier 3.6.2, printWidth 120, proseWrap always).
  assert.match(
    renderAgentsBlock("major"),
    /\n- Three jobs: `Guard` enforces the branch rules and a conventional PR title; `Check` runs secret scan, lint, test and\n {2}build/,
  )
})

test("the plan rewrites an agent file only where a Flama or pipeline section exists", () => {
  const base = facts()
  const plan = planRepository(
    repository("widgets", "major", "acme"),
    facts({
      tree: [...base.tree, "AGENTS.md", "CLAUDE.md"],
      read: (p) =>
        p === "AGENTS.md"
          ? FLAMA_AGENTS
          : p === "CLAUDE.md"
            ? "# Own\n\nNo section.\n"
            : base.read(p),
    }),
    { pin: PIN, template: TEMPLATE, overrides: {} },
  )
  assert.deepEqual(plan.additions.map((a) => a.path).sort(), [
    ".github/pipeline.yaml",
    ".github/workflows/ci.yaml",
    "AGENTS.md",
  ])
  const agents = plan.additions.find((a) => a.path === "AGENTS.md")?.contents ?? ""
  assert.match(agents, /<!-- pipeline:start -->/)
  assert.doesNotMatch(agents, /flama-delivery/)
  assert.ok(agents.endsWith("-->\n"))
  // The agent file compares byte-exact: a current section without its final newline is
  // rewritten (that is how the first rollout went red), the same file with it is left alone.
  const again = (read: string) =>
    planRepository(
      repository("widgets", "major", "acme"),
      facts({
        tree: [...base.tree, "AGENTS.md"],
        read: (p) => (p === "AGENTS.md" ? read : base.read(p)),
      }),
      { pin: PIN, template: TEMPLATE, overrides: {} },
    ).additions.some((a) => a.path === "AGENTS.md")
  assert.equal(again(agents.trimEnd()), true)
  assert.equal(again(agents), false)
})

// ---- the Train caller --------------------------------------------------------

/** The real template: what the tool reads out of the pipeline clone at the pin. */
const TRAIN_TEMPLATE = readFileSync(
  new URL("../../../.github/workflows/examples/train-caller.yaml", import.meta.url),
  "utf8",
)
const CALLER_TEMPLATE = readFileSync(
  new URL("../../../.github/workflows/examples/caller.yaml", import.meta.url),
  "utf8",
)
const BETA = { sha: "b".repeat(40), version: "5.5.0-beta.1" }

test("the Train caller is rendered at the pin, without the marker lines, within 120 characters", () => {
  for (const schedule of ["keep", "drop"] as const) {
    const text = renderTrainCaller(TRAIN_TEMPLATE, BETA, schedule)
    assert.doesNotMatch(text, /__PIPELINE_|__TRAIN_SCHEDULE_/, schedule)
    assert.match(
      text,
      new RegExp(
        `\n    # v5\\.5\\.0-beta\\.1\n    uses: maxbec/pipeline/\\.github/workflows/train\\.yaml@${"b".repeat(40)}\n`,
      ),
      schedule,
    )
    for (const line of text.split("\n")) assert.ok(line.length <= 120, `${line.length}: ${line}`)
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"))
    assert.match(text, /\n {2}workflow_dispatch: \{\}\n/, "the other triggers stay")
    assert.match(text, /\npermissions: \{\}\n/)
  }
})

test("the schedule block is kept or dropped as asked; nothing else differs", () => {
  const kept = renderTrainCaller(TRAIN_TEMPLATE, BETA, "keep")
  const dropped = renderTrainCaller(TRAIN_TEMPLATE, BETA, "drop")
  assert.match(kept, /\n {2}schedule:\n {4}- cron: '\*\/30 \* \* \* \*'\n/)
  assert.doesNotMatch(dropped, /schedule:|cron:/)
  const keptLines = kept.split("\n")
  const droppedLines = dropped.split("\n")
  assert.deepEqual(
    keptLines.filter((line) => !droppedLines.includes(line)).map((line) => line.trim()),
    ["# The sweep, for what no event reports (a resolved thread, a lost event).", "schedule:", "- cron: '*/30 * * * *'"],
  )
  assert.equal(keptLines.length - droppedLines.length, 3)
  assert.throws(
    () => renderTrainCaller("name: Train\non:\n  workflow_dispatch:\n", BETA, "drop"),
    /schedule block/,
    "a template without the markers is not guessed at",
  )
})

test("auto drops the schedule for a user account and keeps it for an organization", () => {
  assert.equal(trainScheduleFor("auto", "User"), "drop")
  assert.equal(trainScheduleFor("auto", "Organization"), "keep")
  assert.equal(trainScheduleFor("keep", "User"), "keep")
  assert.equal(trainScheduleFor("drop", "Organization"), "drop")
  assert.throws(() => trainScheduleFor("auto", undefined), /account type/)
})

test("a prerelease pin is a tagged pin: both callers carry its version in the comment", () => {
  const plan = planRepository(
    repository("widgets", "major", "acme"),
    facts({ ownerType: "Organization" }),
    {
      pin: BETA,
      template: CALLER_TEMPLATE,
      overrides: {},
      train: { mode: "render", template: TRAIN_TEMPLATE, schedule: "auto" },
    },
  )
  const ci = plan.additions.find((a) => a.path === ".github/workflows/ci.yaml")?.contents ?? ""
  const train = plan.additions.find((a) => a.path === TRAIN_CALLER_PATH)?.contents ?? ""
  for (const [file, text] of [
    ["universal-pipeline.yaml", ci],
    ["train.yaml", train],
  ] as const) {
    assert.ok(
      text.includes(
        `    # v5.5.0-beta.1\n    uses: maxbec/pipeline/.github/workflows/${file}@${BETA.sha}\n`,
      ),
      file,
    )
    assert.doesNotMatch(text, /untagged/)
  }
  assert.match(train, /\n {2}schedule:\n/, "an organization keeps its own schedule")
  assert.equal(plan.kept.includes(TRAIN_CALLER_PATH), false)
})

test("without a Train plan the Train caller is neither written nor removed", () => {
  const base = facts()
  const plan = planRepository(
    repository("widgets", "major", "acme"),
    facts({ tree: [...base.tree, TRAIN_CALLER_PATH] }),
    { pin: PIN, template: TEMPLATE, overrides: {} },
  )
  assert.equal(plan.additions.some((a) => a.path === TRAIN_CALLER_PATH), false)
  assert.equal(plan.deletions.includes(TRAIN_CALLER_PATH), false)
})

test("extra legacy paths from the overrides file are deleted like the built-in ones", () => {
  const base = facts()
  const tree = [...base.tree, ".oldtool/state.json"]
  const ctx = { pin: PIN, template: TEMPLATE, overrides: {} }
  const repo = repository("widgets", "major", "acme")
  assert.equal(planRepository(repo, facts({ tree }), ctx).deletions.includes(".oldtool/state.json"), false)
  assert.equal(
    planRepository(repo, facts({ tree }), { ...ctx, legacyPaths: [/^\.oldtool\//] }).deletions.includes(
      ".oldtool/state.json",
    ),
    true,
  )
})

test("both callers land in one commit and one PR; a rerun on matching files commits nothing; --remove-train deletes", async () => {
  const { origin, gh, repo } = seed("train")
  gh.ownerType = "User"
  const ctx = {
    pin: BETA,
    template: CALLER_TEMPLATE,
    overrides: {},
    ref: (b: string) => b,
    train: { mode: "render" as const, template: TRAIN_TEMPLATE, schedule: "auto" as const },
  }
  const facts1 = await readFacts(gh.client, repo, ctx)
  assert.equal(facts1.ownerType, "User")
  gh.checks = "success"
  const first = await applyPlan(gh.client, repo, planRepository(repo, facts1, ctx), ctx)
  assert.equal(gh.commits.length, 1, "one commit")
  assert.deepEqual(gh.commits[0]?.additions, [
    ".github/pipeline.yaml",
    ".github/workflows/ci.yaml",
    TRAIN_CALLER_PATH,
  ])
  assert.equal([...gh.pulls.values()].filter((p) => p.head === MIGRATION_BRANCH).length, 1, "one PR")
  const written = git(origin, "show", `${MIGRATION_BRANCH}:${TRAIN_CALLER_PATH}`)
  assert.ok(written.includes(`uses: maxbec/pipeline/.github/workflows/train.yaml@${BETA.sha}`))
  assert.doesNotMatch(written, /__TRAIN_SCHEDULE_|schedule:/, "a user account is swept centrally")
  // Rerun until merged; then the rendered files match and nothing is committed.
  let result = first
  for (let i = 0; i < 3 && result.status !== "merged"; i++) {
    result = await applyPlan(
      gh.client,
      repo,
      planRepository(repo, await readFacts(gh.client, repo, ctx), ctx),
      ctx,
    )
  }
  assert.equal(result.status, "merged", JSON.stringify(result))
  const settled = planRepository(repo, await readFacts(gh.client, repo, ctx), ctx)
  assert.equal(settled.idle, true, JSON.stringify(settled))
  assert.equal((await applyPlan(gh.client, repo, settled, ctx)).status, "idle")
  assert.equal(gh.commits.length, 1, "no second commit")

  // The rollback: the Train caller goes, in a commit of its own.
  const back = { ...ctx, train: { mode: "remove" as const } }
  const rollback = planRepository(repo, await readFacts(gh.client, repo, back), back)
  assert.deepEqual(rollback.deletions, [TRAIN_CALLER_PATH])
  assert.deepEqual(rollback.additions, [])
  await applyPlan(gh.client, repo, rollback, back)
  assert.equal(gh.commits.length, 2)
  assert.deepEqual(gh.commits[1]?.deletions, [TRAIN_CALLER_PATH])
  assert.deepEqual(gh.commits[1]?.additions, [])
  // Without a Train caller there is nothing to remove.
  const { gh: gh2, repo: repo2 } = seed("train-none")
  const none = planRepository(repo2, await readFacts(gh2.client, repo2, back), back)
  assert.equal(none.deletions.includes(TRAIN_CALLER_PATH), false)
})
