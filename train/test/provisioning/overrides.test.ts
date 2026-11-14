import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { planRepository, type RepoFacts } from "../../src/provisioning/migrate.ts"
import { loadOverrides, NO_OVERRIDES, parseOverrides } from "../../src/provisioning/overrides.ts"
import { repositoryOf } from "../helpers/repository.ts"
import { scratchDir } from "../helpers/scratch.ts"

const FILE = {
  repositories: {
    "acme/widgets": {
      secrets: { NPM_TOKEN: "${{ secrets.ACME_NPM_TOKEN }}" },
      renderHook: true,
      extraFiles: { ".github/workflows/extra.yaml": "---\nname: Extra\n" },
    },
  },
  legacyPaths: ["^\\.oldtool/"],
  singleQuoteTrunkPlugins: ["acme-trunk-plugin"],
}

test("no file is no overrides", () => {
  assert.equal(loadOverrides(undefined), NO_OVERRIDES)
  assert.deepEqual(parseOverrides({}), NO_OVERRIDES)
})

test("a file is read into the shape the plan takes", () => {
  const file = join(scratchDir("train-overrides-"), "fleet.json")
  writeFileSync(file, JSON.stringify(FILE))
  const fleet = loadOverrides(file)
  assert.deepEqual(fleet.repositories, FILE.repositories)
  assert.deepEqual(
    fleet.legacyPaths.map((re) => re.source),
    ["^\\.oldtool\\/"],
  )
  assert.equal(fleet.legacyPaths[0]?.test(".oldtool/state.json"), true)
  assert.deepEqual(fleet.singleQuoteTrunkPlugins, ["acme-trunk-plugin"])
})

test("a loaded override reaches the rendered files", () => {
  const fleet = parseOverrides(FILE)
  const facts: RepoFacts = {
    archived: false,
    private: true,
    defaultBranch: "main",
    settings: {
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
    },
    branches: ["main"],
    tree: [],
    read: () => null,
    protection: {},
    rulesets: [],
    openPulls: [],
  }
  const plan = planRepository(
    repositoryOf({ owner: "acme", name: "widgets", kind: "small", path: "/nowhere" }),
    facts,
    {
      pin: { sha: "a".repeat(40), version: "5.0.0" },
      template:
        "jobs:\n  pipeline:\n    # __PIPELINE_VERSION__\n    uses: maxbec/pipeline/.github/workflows/universal-pipeline.yaml@__PIPELINE_SHA__\n    secrets:\n      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n",
      overrides: fleet.repositories,
    },
  )
  const contents = (path: string) => plan.additions.find((a) => a.path === path)?.contents ?? ""
  assert.match(contents(".github/workflows/ci.yaml"), /NPM_TOKEN: \$\{\{ secrets\.ACME_NPM_TOKEN \}\}/)
  assert.match(contents(".github/pipeline.yaml"), /render:\n\s+hook: true/)
  assert.equal(contents(".github/workflows/extra.yaml"), "---\nname: Extra\n")
})

test("every YAML extra file starts with the document marker", () => {
  // yamllint's document-start rule runs over the files the tool just wrote.
  assert.throws(
    () =>
      parseOverrides({
        repositories: { "acme/widgets": { extraFiles: { ".github/workflows/x.yaml": "name: X\n" } } },
      }),
    /x\.yaml does not start with the document marker/,
  )
  assert.doesNotThrow(() =>
    parseOverrides({ repositories: { "acme/widgets": { extraFiles: { "NOTES.md": "plain\n" } } } }),
  )
})

test("a malformed file is refused with the place that is wrong", () => {
  assert.throws(() => parseOverrides([]), /expected an object/)
  assert.throws(() => parseOverrides({ repos: {} }), /unknown key repos/)
  assert.throws(() => parseOverrides({ repositories: { widgets: {} } }), /not owner\/name/)
  assert.throws(
    () => parseOverrides({ repositories: { "acme/widgets": { secret: {} } } }),
    /acme\/widgets: unknown key secret/,
  )
  assert.throws(
    () => parseOverrides({ repositories: { "acme/widgets": { secrets: { A: 1 } } } }),
    /secrets\.A: expected a string/,
  )
  assert.throws(
    () => parseOverrides({ repositories: { "acme/widgets": { renderHook: "yes" } } }),
    /renderHook/,
  )
  assert.throws(() => parseOverrides({ legacyPaths: ["("] }), /not a regular expression/)
  assert.throws(() => parseOverrides({ singleQuoteTrunkPlugins: "x" }), /list of strings/)
  const file = join(scratchDir("train-overrides-"), "broken.json")
  writeFileSync(file, "{")
  assert.throws(() => loadOverrides(file), /broken\.json/)
})
