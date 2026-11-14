import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import {
  mergeChangelogs,
  prependToChangelog,
  releaseBody,
  renderSection,
  sectionOf,
  sectionsOf,
} from "../../src/release/changelog.ts"

const repo = { owner: "acme", name: "demo" }
const sha = (n: string) => n.repeat(40).slice(0, 40)

test("a fixed commit list renders byte-for-byte: emoji, order, hidden sections, links", () => {
  const section = renderSection({
    version: "1.3.0",
    previousTag: "v1.2.0",
    date: "2026-09-05",
    repo,
    commits: [
      { subject: "docs: explain the release path (#30)", sha: sha("f") },
      { subject: "chore(deps): bump things (#29)", sha: sha("e") },
      { subject: "test: cover the parser", sha: sha("d") },
      { subject: "fix: handle the empty case (#28)", sha: sha("c") },
      { subject: "refactor(engine): split the driver (#27)", sha: sha("b") },
      { subject: "feat(api): add the endpoint (#26)", sha: sha("a") },
      { subject: "Merge pull request #25 from acme/dev", sha: sha("9") },
      {
        subject: "feat(api)!: drop the v1 routes (#24)",
        body: "BREAKING CHANGE: /v1 is gone, use /v2.",
        sha: sha("8"),
      },
      { subject: "perf: cache the tree", sha: sha("7") },
      { subject: "revert: undo the thing (#22)", sha: sha("6") },
    ],
  })
  const expected = [
    "## [1.3.0](https://github.com/acme/demo/compare/v1.2.0...v1.3.0) (2026-09-05)",
    "",
    "",
    "### ⚠ BREAKING CHANGES",
    "",
    "* **api:** /v1 is gone, use /v2.",
    "",
    "",
    "### ✨ Features",
    "",
    `* **api:** add the endpoint ([#26](https://github.com/acme/demo/issues/26)) ([${"a".repeat(7)}](https://github.com/acme/demo/commit/${sha("a")}))`,
    `* **api:** drop the v1 routes ([#24](https://github.com/acme/demo/issues/24)) ([${"8".repeat(7)}](https://github.com/acme/demo/commit/${sha("8")}))`,
    "",
    "",
    "### 🐛 Bug Fixes",
    "",
    `* handle the empty case ([#28](https://github.com/acme/demo/issues/28)) ([${"c".repeat(7)}](https://github.com/acme/demo/commit/${sha("c")}))`,
    "",
    "",
    "### ⚡ Performance",
    "",
    `* cache the tree ([${"7".repeat(7)}](https://github.com/acme/demo/commit/${sha("7")}))`,
    "",
    "",
    "### ⏪ Reverts",
    "",
    `* undo the thing ([#22](https://github.com/acme/demo/issues/22)) ([${"6".repeat(7)}](https://github.com/acme/demo/commit/${sha("6")}))`,
    "",
    "",
    "### ♻️ Refactoring",
    "",
    `* **engine:** split the driver ([#27](https://github.com/acme/demo/issues/27)) ([${"b".repeat(7)}](https://github.com/acme/demo/commit/${sha("b")}))`,
    "",
    "",
    "### 📝 Documentation",
    "",
    `* explain the release path ([#30](https://github.com/acme/demo/issues/30)) ([${"f".repeat(7)}](https://github.com/acme/demo/commit/${sha("f")}))`,
    "",
  ].join("\n")
  assert.equal(section, expected)
})

test("the per-repository toggle shows the hidden sections after the visible ones", () => {
  const section = renderSection({
    version: "1.3.1",
    previousTag: "v1.3.0",
    date: "2026-09-05",
    repo,
    showHidden: true,
    commits: [
      { subject: "ci: pin the runner (#31)", sha: sha("1") },
      { subject: "fix: a (#32)", sha: sha("2") },
      { subject: "chore: tidy (#33)", sha: sha("3") },
      { subject: "build: bump node (#34)", sha: sha("4") },
      { subject: "test: more (#35)", sha: sha("5") },
      { subject: "style: format (#36)", sha: sha("6") },
      { subject: "wip: unknown type is never shown", sha: sha("7") },
    ],
  })
  const headings = section.split("\n").filter((l) => l.startsWith("### "))
  assert.deepEqual(headings, [
    "### 🐛 Bug Fixes",
    "### ✅ Tests",
    "### 📦 Build",
    "### 🚀 CI/CD",
    "### 🔧 Miscellaneous",
    "### 💄 Styles",
  ])
  assert.doesNotMatch(section, /unknown type/)
})

test("a breaking change marked only by `!` uses its description as the note", () => {
  const section = renderSection({
    version: "2.0.0",
    previousTag: "v1.3.1",
    date: "2026-09-05",
    repo,
    commits: [{ subject: "fix!: stop accepting numbers (#40)", sha: sha("a") }],
  })
  assert.match(section, /### ⚠ BREAKING CHANGES\n\n\* stop accepting numbers\n/)
})

test("the first release has no compare link", () => {
  const section = renderSection({
    version: "0.1.0",
    previousTag: null,
    date: "2026-09-05",
    repo,
    commits: [{ subject: "feat: begin", sha: sha("a") }],
  })
  assert.ok(section.startsWith("## 0.1.0 (2026-09-05)\n\n\n### ✨ Features\n"))
})

test("a real release-please section is reproduced from its commits", () => {
  const expected = readFileSync(
    join(import.meta.dirname, "../fixtures/changelog/release-please-0.7.0-beta.18.md"),
    "utf8",
  )
  const section = renderSection({
    version: "0.7.0-beta.18",
    previousTag: "v0.7.0-beta.17",
    date: "2026-09-02",
    repo: { owner: "acme", name: "widgets" },
    commits: [
      {
        subject: "chore(dev): release 0.7.0-beta.18 (#911)",
        sha: "60718293a4b5c6d7e8f9012345670a1b2c3d4e5f",
      },
      {
        subject: "feat(invoicing): convert a quote to an invoice from the quotes page (#908)",
        sha: "3d4e5f60718293a4b5c6d7e8f9012345670a1b2c",
      },
      {
        subject:
          "feat(projects): add document catalog and live message prefill to document requests (#910)",
        sha: "4e5f60718293a4b5c6d7e8f9012345670a1b2c3d",
      },
      {
        subject: "fix(products): theme-correct catalogue cards, calmer drop, click-to-add (#909)",
        sha: "5f60718293a4b5c6d7e8f9012345670a1b2c3d4e",
      },
    ],
  })
  assert.equal(section, expected)
})

test("prepending keeps the existing changelog byte-for-byte and starts a new one with the title", () => {
  const section = "## [1.1.0](x) (2026-09-05)\n\n\n### ✨ Features\n\n* a\n"
  const existing = "# Changelog\n\n## [1.0.0](y) (2026-09-01)\n\n\n### 🐛 Bug Fixes\n\n* b\n"
  assert.equal(
    prependToChangelog(existing, section),
    "# Changelog\n\n## [1.1.0](x) (2026-09-05)\n\n\n### ✨ Features\n\n* a\n\n## [1.0.0](y) (2026-09-01)\n\n\n### 🐛 Bug Fixes\n\n* b\n",
  )
  assert.equal(prependToChangelog(null, section), `# Changelog\n\n${section}`)
  assert.equal(prependToChangelog("", section), `# Changelog\n\n${section}`)
  // A changelog without the title line gets the section on top all the same.
  assert.equal(
    prependToChangelog("## [1.0.0](y) (d)\n", section),
    `${section}\n## [1.0.0](y) (d)\n`,
  )
})

test("the release body is the section and the section of a version can be read back", () => {
  const section = "## [1.1.0](x) (2026-09-05)\n\n\n### ✨ Features\n\n* a\n"
  const file = prependToChangelog("# Changelog\n\n## [1.0.0](y) (d)\n\n* b\n", section)
  assert.equal(releaseBody(section), section.trimEnd())
  assert.equal(sectionOf(file, "1.1.0"), section)
  assert.equal(sectionOf(file, "1.0.0"), "## [1.0.0](y) (d)\n\n* b\n")
  assert.equal(sectionOf(file, "9.9.9"), null)
})

test("a section with nothing visible still renders its header", () => {
  const section = renderSection({
    version: "1.0.1",
    previousTag: "v1.0.0",
    date: "2026-09-05",
    repo,
    commits: [{ subject: "chore: only", sha: sha("a") }],
  })
  assert.equal(
    section,
    "## [1.0.1](https://github.com/acme/demo/compare/v1.0.0...v1.0.1) (2026-09-05)\n",
  )
})

test("merging changelogs takes the sections only the other side has, on top, byte-for-byte", () => {
  const ours =
    "# Changelog\n\n## [1.3.0-beta.1](x) (2026-09-05)\n\n\n### ✨ Features\n\n* a\n\n## [1.2.0](x) (2026-09-01)\n\n\n### ✨ Features\n\n* old\n"
  const theirs =
    "# Changelog\n\n## [1.2.1](x) (2026-09-06)\n\n\n### 🐛 Bug Fixes\n\n* b\n\n## [1.2.0](x) (2026-09-01)\n\n\n### ✨ Features\n\n* old\n"
  assert.equal(
    mergeChangelogs(ours, theirs),
    "# Changelog\n\n## [1.2.1](x) (2026-09-06)\n\n\n### 🐛 Bug Fixes\n\n* b\n\n## [1.3.0-beta.1](x) (2026-09-05)\n\n\n### ✨ Features\n\n* a\n\n## [1.2.0](x) (2026-09-01)\n\n\n### ✨ Features\n\n* old\n",
  )
  assert.equal(mergeChangelogs(ours, ours), ours, "nothing new, nothing changed")
  assert.deepEqual(
    sectionsOf(theirs).map((s) => s.version),
    ["1.2.1", "1.2.0"],
  )
})
