import assert from "node:assert/strict"
import { test } from "node:test"
import { guardFix } from "../../src/fix/guard.ts"

type Change = { path: string; before: string | null; after: string | null }

/** Guard one change to a file the pull request already changes. */
function one(path: string, before: string | null, after: string | null, prFiles = [path]) {
  return guardFix({ prFiles, changes: [{ path, before, after }] })
}

function refused(result: ReturnType<typeof guardFix>, pattern: RegExp, label: string) {
  assert.equal(result.ok, false, `${label}: expected a refusal`)
  if (!result.ok) assert.match(result.reasons.join("\n"), pattern, label)
}

// Secret shapes are assembled here, so that no scanner reads this file as a leak.
const j = (...parts: string[]) => parts.join("")

test("a plain source fix in a file the pull request changes passes", () => {
  assert.deepEqual(
    guardFix({
      prFiles: ["src/a.ts", "src/b.py", "docs/x.md"],
      changes: [
        { path: "src/a.ts", before: "export const a = 1\n", after: "export const a = 2\n" },
        { path: "src/b.py", before: "x = 1  # noqa\n", after: "x = 2  # noqa\n" },
      ],
    }),
    { ok: true },
  )
})

test("a test file may change when it keeps its assertions and gains no skip", () => {
  assert.deepEqual(
    one(
      "test/a.test.ts",
      "test('a', () => {\n  assert.equal(a, 1)\n})\n",
      "test('a', () => {\n  assert.equal(a, 1)\n  assert.ok(b)\n})\n",
    ),
    { ok: true },
  )
})

test("only files the pull request itself changes, and none created or deleted", () => {
  refused(one("src/other.ts", "a\n", "b\n", ["src/a.ts"]), /src\/other\.ts.*does not change/, "outside")
  refused(one("src/a.ts", null, "new\n"), /create/, "created")
  refused(one("src/a.ts", "old\n", null), /delete/, "deleted")
  refused(one("../x.ts", "a\n", "b\n"), /path/, "traversal")
  refused(one("/etc/passwd", "a\n", "b\n"), /path/, "absolute")
})

test("CI, hook and tool directories are out of reach", () => {
  for (const path of [
    ".github/workflows/ci.yaml",
    ".github/pipeline.yaml",
    ".trunk/trunk.yaml",
    ".husky/pre-commit",
    "packages/app/.husky/pre-push",
  ]) {
    refused(one(path, "a\n", "b\n"), /CI|hook|configuration/, path)
  }
})

test("lockfiles, manifests and lint, format and test-runner configuration are out of reach", () => {
  for (const path of [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "uv.lock",
    "poetry.lock",
    "Cargo.lock",
    "apps/web/pnpm-lock.yaml",
    "package.json",
    "apps/web/package.json",
    "pyproject.toml",
    "tsconfig.json",
    "tsconfig.build.json",
    "biome.json",
    "biome.jsonc",
    ".eslintrc",
    ".eslintrc.cjs",
    "eslint.config.mjs",
    "prettier.config.js",
    ".prettierrc",
    ".prettierrc.json",
    "jest.config.ts",
    "vitest.config.ts",
    "playwright.config.ts",
    "pytest.ini",
    "tox.ini",
    "setup.cfg",
    ".editorconfig",
  ]) {
    refused(one(path, "a\n", "b\n"), /lockfile|configuration/, path)
  }
  // Names that only resemble them stay open.
  assert.deepEqual(one("src/package.json.ts", "a\n", "b\n"), { ok: true })
  assert.deepEqual(one("src/tsconfig.ts", "a\n", "b\n"), { ok: true })
})

test("a test file may not lose assertions", () => {
  const before = "it('a', () => {\n  expect(a).toBe(1)\n  expect(b).toBe(2)\n})\n"
  const after = "it('a', () => {\n  expect(a).toBe(1)\n})\n"
  for (const path of [
    "test/a.ts",
    "tests/a.py",
    "src/__tests__/a.ts",
    "e2e/login.ts",
    "src/a.test.ts",
    "src/a.spec.tsx",
    "pkg/test_a.py",
    "pkg/a_test.go",
  ]) {
    refused(one(path, before, after), /assert/, path)
  }
  // The same edit in a file that is not a test is an ordinary change.
  assert.deepEqual(one("src/a.ts", before, after), { ok: true })
})

test("a test file may not gain a skip, only, todo or expected-failure marker", () => {
  const body = "  expect(a).toBe(1)\n})\n"
  const cases: [string, string, string][] = [
    ["a.test.ts", "it('a', () => {\n", "it.skip('a', () => {\n"],
    ["a.test.ts", "it('a', () => {\n", "it.only('a', () => {\n"],
    ["a.test.ts", "it('a', () => {\n", "it.todo('a', () => {\n"],
    ["a.test.ts", "it('a', () => {\n", "it.fails('a', () => {\n"],
    ["a.test.ts", "it('a', () => {\n", "it.skipIf(true)('a', () => {\n"],
    ["a.test.ts", "it('a', () => {\n", "xit('a', () => {\n"],
    ["a.test.ts", "describe('a', () => {\n", "xdescribe('a', () => {\n"],
    ["test_a.py", "def test_a():\n", "@pytest.mark.skip\ndef test_a():\n"],
    ["test_a.py", "def test_a():\n", "@pytest.mark.xfail\ndef test_a():\n"],
    ["a_test.go", "func TestA(t *testing.T) {\n", "func TestA(t *testing.T) {\n\tt.Skip()\n"],
  ]
  for (const [path, before, after] of cases) {
    refused(one(path, before + body, after + body), /skip|marker/, after.trim())
  }
  // A marker that was already there is not the fix's doing.
  assert.deepEqual(
    one("a.test.ts", `it.skip('a', () => {\n${body}`, `it.skip('a', () => {\n  expect(a).toBe(2)\n})\n`),
    { ok: true },
  )
})

test("no file may gain a suppression", () => {
  for (const marker of [
    "// @ts-ignore",
    "// @ts-expect-error",
    "// @ts-nocheck",
    "// eslint-disable-next-line no-console",
    "/* eslint-disable */",
    "// biome-ignore lint: reason",
    "x = 1  # noqa",
    "x = 1  # type: ignore",
    "x := 1 //nolint:errcheck",
    "/* istanbul ignore next */",
    "/* c8 ignore next */",
  ]) {
    refused(one("src/a.ts", "const a = 1\n", `${marker}\nconst a = 1\n`), /suppression/, marker)
  }
})

test("binary content, large files and wide changes are refused", () => {
  refused(one("src/a.ts", "a\n", "a\u0000b"), /binary/, "binary after")
  refused(one("src/a.ts", "a\u0000b", "a\n"), /binary/, "binary before")
  refused(one("src/a.ts", "a\n", "x".repeat(200 * 1024 + 1)), /200 KB/, "large")
  assert.deepEqual(one("src/a.ts", "a\n", "x".repeat(200 * 1024)), { ok: true })

  const many: Change[] = Array.from({ length: 21 }, (_, i) => ({
    path: `src/f${i}.ts`,
    before: "a\n",
    after: "b\n",
  }))
  refused(guardFix({ prFiles: many.map((c) => c.path), changes: many }), /20 files/, "21 files")
  assert.deepEqual(guardFix({ prFiles: many.map((c) => c.path), changes: many.slice(0, 20) }), { ok: true })
})

test("content shaped like a secret is never shipped", () => {
  for (const secret of [
    j("sk-", "ant-", "api03-abcdefgh"),
    j("gh", "s_", "a".repeat(36)),
    j("gh", "p_", "a".repeat(36)),
    j("github", "_pat_", "a".repeat(22)),
    j("-----", "BEGIN ", "OPENSSH PRIVATE KEY-----"),
    j("AK", "IA", "ABCDEFGHIJKLMNOP"),
  ]) {
    refused(one("src/a.ts", "const a = 1\n", `const a = "${secret}"\n`), /secret/, secret.slice(0, 6))
  }
})

test("every reason is reported, not just the first", () => {
  const result = guardFix({
    prFiles: ["src/a.ts"],
    changes: [
      { path: "src/a.ts", before: "a\n", after: "// @ts-ignore\na\n" },
      { path: "package.json", before: "{}\n", after: "{ }\n" },
    ],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reasons.length, 3)
})
