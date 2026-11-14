import assert from "node:assert/strict"
import { test } from "node:test"
import { parseConventional } from "../../src/release/conventional.ts"
import { bumpVersion, compareVersions, parseVersion } from "../../src/release/semver.ts"
import { deriveVersion } from "../../src/release/version.ts"
import { applyVersion } from "../../src/release/version-files.ts"

// ---- conventional commit parsing (the input of rule 1) ---------------------

test("a squash subject parses into type, scope, description and PR number", () => {
  const c = parseConventional({
    subject: "feat(server): add the thing (#42)",
    sha: "0123456789abcdef0123456789abcdef01234567",
  })
  assert.ok(c)
  assert.equal(c.type, "feat")
  assert.equal(c.scope, "server")
  assert.equal(c.description, "add the thing")
  assert.equal(c.pr, 42)
  assert.equal(c.breaking, false)
  assert.equal(c.sha, "0123456789abcdef0123456789abcdef01234567")
})

test("`!` and a BREAKING CHANGE footer both mark a commit breaking", () => {
  assert.equal(parseConventional("feat!: drop the old api")?.breaking, true)
  assert.equal(parseConventional("fix(x)!: hard stop")?.breaking, true)
  const footer = parseConventional({
    subject: "refactor: rename the module",
    body: "Long story.\n\nBREAKING CHANGE: the import path moved.",
  })
  assert.equal(footer?.breaking, true)
  assert.equal(footer?.breakingNote, "the import path moved.")
  assert.equal(parseConventional("feat: plain")?.breakingNote, null)
})

test("non-conventional subjects and merge commits are not commits of any type", () => {
  assert.equal(parseConventional("Merge pull request #70 from acme/dev"), null)
  assert.equal(parseConventional("Add the thing"), null)
  assert.equal(parseConventional("feat:no space"), null)
  assert.equal(parseConventional("Feat: capitalized type"), null)
})

// ---- semver helpers ---------------------------------------------------------

test("versions parse with or without the v prefix and compare like semver", () => {
  assert.deepEqual(parseVersion("v1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: null,
  })
  assert.deepEqual(parseVersion("1.3.0-beta.4")?.prerelease, { tag: "beta", n: 4 })
  assert.deepEqual(parseVersion("4.0.0-beta")?.prerelease, { tag: "beta", n: 0 })
  assert.equal(parseVersion("1.2"), null)
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0)
  assert.ok(compareVersions("1.3.0-beta.2", "1.3.0") < 0, "a prerelease sorts before its release")
  assert.ok(compareVersions("1.3.0-beta.2", "1.3.0-beta.10") < 0)
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0")
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0")
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4")
})

// ---- the version rules, one test per rule ----

test("rule 1: the source of truth is the conventional subjects since the last stable tag", () => {
  const r = deriveVersion({
    commits: [
      "fix(api): handle the empty case (#12)",
      "Merge pull request #13 from acme/dev",
      "chore(release): 1.2.1-beta.1 (#14)",
      { subject: "refactor: move it", body: "BREAKING CHANGE: the path moved" },
    ],
    lastStableTag: "v1.2.0",
    branch: "main",
    repoKind: "small",
    currentTarget: null,
  })
  assert.equal(r.bump, "major", "the footer counts, the merge and release commits do not")
  assert.equal(r.version, "2.0.0")
  assert.match(r.reason, /BREAKING/)
})

test("rule 2: the bump is the highest impact across every unreleased commit", () => {
  const base = {
    lastStableTag: "v1.2.0",
    branch: "main",
    repoKind: "small" as const,
    currentTarget: null,
  }
  assert.equal(
    deriveVersion({ ...base, commits: ["fix: a", "feat: b", "docs: c"] }).version,
    "1.3.0",
  )
  assert.equal(deriveVersion({ ...base, commits: ["perf: a", "revert: b"] }).version, "1.2.1")
  assert.equal(deriveVersion({ ...base, commits: ["feat: a", "fix!: b"] }).version, "2.0.0")
  const none = deriveVersion({ ...base, commits: ["docs: a", "chore: b", "ci: c", "test: d"] })
  assert.equal(none.bump, "none")
  assert.equal(none.version, null, "nothing to release")
  assert.equal(none.target, null)
})

test("rule 3: the target only grows: a later fix does not shrink a minor target", () => {
  const a = deriveVersion({
    commits: ["feat: x"],
    lastStableTag: "v1.2.0",
    branch: "dev",
    repoKind: "major",
    currentTarget: null,
  })
  assert.equal(a.version, "1.3.0-beta.1")
  assert.equal(a.target, "1.3.0")
  // The open Release PR says 1.3.0; the range now reads as patch-only (a
  // force-push dropped the feat). The PR keeps its target.
  const b = deriveVersion({
    commits: ["fix: y"],
    lastStableTag: "v1.2.0",
    branch: "dev",
    repoKind: "major",
    currentTarget: "1.3.0",
  })
  assert.equal(b.target, "1.3.0")
  assert.equal(b.version, "1.3.0-beta.1")
  assert.equal(b.bump, "minor")
  // …and grows past it when a breaking change lands.
  const c = deriveVersion({
    commits: ["fix: y", "feat!: z"],
    lastStableTag: "v1.2.0",
    branch: "dev",
    repoKind: "major",
    currentTarget: "1.3.0",
  })
  assert.equal(c.version, "2.0.0-beta.1")
})

test("rule 4: dev carries <target>-beta.N, N resets with the target, promotion drops the suffix", () => {
  const first = deriveVersion({
    commits: ["feat: x"],
    lastStableTag: "v1.2.0",
    lastPrerelease: null,
    branch: "dev",
    repoKind: "major",
    currentTarget: null,
  })
  assert.equal(first.version, "1.3.0-beta.1")
  const second = deriveVersion({
    commits: ["feat: x", "fix: y"],
    lastStableTag: "v1.2.0",
    lastPrerelease: "v1.3.0-beta.1",
    branch: "dev",
    repoKind: "major",
    currentTarget: "1.3.0",
  })
  assert.equal(second.version, "1.3.0-beta.2", "N counts dev releases toward the same target")
  const grown = deriveVersion({
    commits: ["feat: x", "fix: y", "feat!: z"],
    lastStableTag: "v1.2.0",
    lastPrerelease: "v1.3.0-beta.2",
    branch: "dev",
    repoKind: "major",
    currentTarget: "1.3.0",
  })
  assert.equal(grown.version, "2.0.0-beta.1", "N resets when the target changes")
  const promotion = deriveVersion({
    commits: ["feat: x", "fix: y", "feat!: z", "chore(release): 2.0.0-beta.1 (#9)"],
    lastStableTag: "v1.2.0",
    lastPrerelease: "v2.0.0-beta.1",
    branch: "main",
    repoKind: "major",
    currentTarget: null,
  })
  assert.equal(promotion.version, "2.0.0", "computed over everything since the last stable tag")
})

test("rule 5: small repositories get stable versions only", () => {
  const r = deriveVersion({
    commits: ["feat: x"],
    lastStableTag: "v1.2.0",
    lastPrerelease: "v1.3.0-beta.1",
    branch: "main",
    repoKind: "small",
    currentTarget: null,
  })
  assert.equal(r.version, "1.3.0")
})

test("rule 6: pre-1.0, a breaking change is a minor, not a major; leaving 0.x is an override", () => {
  const r = deriveVersion({
    commits: ["feat!: drop the old api"],
    lastStableTag: "v0.4.2",
    branch: "main",
    repoKind: "small",
    currentTarget: null,
  })
  assert.equal(r.version, "0.5.0")
  assert.equal(r.bump, "minor")
  const base = {
    lastStableTag: "v0.4.2",
    branch: "main",
    repoKind: "small" as const,
    currentTarget: null,
  }
  assert.equal(deriveVersion({ ...base, commits: ["feat: a"] }).version, "0.5.0")
  assert.equal(deriveVersion({ ...base, commits: ["fix: a"] }).version, "0.4.3")
  // No tag at all is 0.0.0 and therefore pre-1.0.
  const fresh = {
    lastStableTag: null,
    branch: "main",
    repoKind: "small" as const,
    currentTarget: null,
  }
  assert.equal(deriveVersion({ ...fresh, commits: ["feat: a"] }).version, "0.1.0")
  assert.equal(deriveVersion({ ...fresh, commits: ["fix: a"] }).version, "0.0.1")
  // Nothing derives 1.0.0 on its own.
  assert.equal(deriveVersion({ ...base, commits: ["feat!: a", "feat!: b"] }).version, "0.5.0")
})

test("rule 7: a manual 'release as' override wins, verbatim", () => {
  const r = deriveVersion({
    commits: ["docs: only"],
    lastStableTag: "v0.9.4",
    branch: "main",
    repoKind: "small",
    currentTarget: null,
    override: "1.0.0",
  })
  assert.equal(r.version, "1.0.0")
  assert.equal(r.target, "1.0.0")
  assert.equal(r.bump, "override")
  const beta = deriveVersion({
    commits: ["fix: a"],
    lastStableTag: "v1.2.0",
    lastPrerelease: "v1.2.1-beta.3",
    branch: "dev",
    repoKind: "major",
    currentTarget: "1.2.1",
    override: "1.3.0-beta.1",
  })
  assert.equal(beta.version, "1.3.0-beta.1")
  assert.throws(
    () =>
      deriveVersion({
        ...r,
        commits: [],
        lastStableTag: null,
        branch: "main",
        repoKind: "small",
        currentTarget: null,
        override: "banana",
      } as never),
    /override/,
  )
})

test("rule 8: after a hotfix release on main, the backmerge moves dev's baseline forward", () => {
  // dev was at 1.3.0-beta.2 (a feat over 1.2.0); main shipped hotfix 1.2.1 and
  // it was backmerged, so the newest stable tag reachable from dev is now
  // 1.2.1 while the feat is still unreleased. Same target, next beta.
  const feat = deriveVersion({
    commits: ["feat: x", "fix: hot"],
    lastStableTag: "v1.2.1",
    lastPrerelease: "v1.3.0-beta.2",
    branch: "dev",
    repoKind: "major",
    currentTarget: "1.3.0",
  })
  assert.equal(feat.version, "1.3.0-beta.3")
  // dev had only fixes (target 1.2.1-beta.2); the hotfix took 1.2.1 itself.
  // The target is the bump applied to the newest stable tag: 1.2.2, N restarts.
  const patch = deriveVersion({
    commits: ["fix: a"],
    lastStableTag: "v1.2.1",
    lastPrerelease: "v1.2.1-beta.2",
    branch: "dev",
    repoKind: "major",
    currentTarget: "1.2.1",
  })
  assert.equal(patch.target, "1.2.2")
  assert.equal(patch.version, "1.2.2-beta.1")
})

test("rule 9: the version is written into package.json files and plain version files, nothing else", () => {
  const pkg = '{\n  "name": "x",\n  "version": "1.2.0",\n  "dependencies": { "y": "1.2.0" }\n}\n'
  assert.equal(
    applyVersion("package.json", pkg, "1.3.0-beta.1"),
    '{\n  "name": "x",\n  "version": "1.3.0-beta.1",\n  "dependencies": { "y": "1.2.0" }\n}\n',
    "only the top-level version key changes and the formatting survives",
  )
  assert.equal(applyVersion("VERSION", "1.2.0\n", "1.3.0"), "1.3.0\n")
  assert.equal(
    applyVersion("pyproject.toml", '[project]\nname = "x"\nversion = "1.2.0"\n', "1.3.0"),
    '[project]\nname = "x"\nversion = "1.3.0"\n',
  )
  assert.throws(() => applyVersion("README.md", "no version here\n", "1.3.0"), /no version/)
})

test("a version key that cannot be found says how to fix it, in the terms that fix it", () => {
  // A workspace root: private, no version key, and the only file the default
  // anchored glob matches. `package.json: no version key` was true and told
  // nobody what to do — the answer is always versionFiles, never a version
  // invented in the writer.
  const root = '{\n  "name": "widgets",\n  "private": true,\n  "type": "module"\n}\n'
  assert.throws(
    () => applyVersion("package.json", root, "0.1.0"),
    (error: Error) => {
      assert.match(error.message, /never-published workspace root carries none/)
      assert.match(error.message, /versionFiles/)
      assert.match(error.message, /apps\/\*\/package\.json/)
      return true
    },
  )
  // Not private: the same knob, without the workspace-root explanation.
  assert.throws(
    () => applyVersion("package.json", '{\n  "name": "x"\n}\n', "0.1.0"),
    (error: Error) => {
      assert.match(error.message, /versionFiles/)
      assert.doesNotMatch(error.message, /workspace root/)
      return true
    },
  )
  // The key is there, just not on a line the anchored replacement can see:
  // saying "no version key" about a file that has one sends the reader to the
  // wrong knob.
  assert.throws(
    () => applyVersion("package.json", '{ "name": "x", "version": "1.2.0" }\n', "0.1.0"),
    /on a line of its own/,
  )
  // A file the glob claims is a package and is not even JSON.
  assert.throws(
    () => applyVersion("package.json", "{ not json\n", "0.1.0"),
    /does not parse as JSON/,
  )
})
