// The central sweep runs in a PUBLIC log over PRIVATE repositories. These tests
// run scripts/train-sweep.sh against a fake `gh` and a fake `node` on PATH and
// real git over local bare repositories, and hold it to its one hard rule:
// nothing but indexes, counts and exit codes is ever printed.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ROOT, scratch } from "./helpers.mjs"

const SCRIPT = join(ROOT, "scripts/train-sweep.sh")
const SELF = "acme/sweeper"

const FAKE_GH = `#!/usr/bin/env bash
# Everything this prints on a failure carries the repository's name, as the
# real gh does; the sweep must not let it through.
set -euo pipefail
[[ "$1" == "api" ]] || { echo "fake gh: unexpected $*" >&2; exit 2; }
endpoint="$2"
case "$endpoint" in
  /installation/repositories)
    if [[ -f "$FIXTURE/list-fails" ]]; then echo "HTTP 401 for secret-owner" >&2; exit 1; fi
    jq -r '.repositories[] | select(.archived | not) | .full_name' "$FIXTURE/repositories.json"
    ;;
  repos/*/contents/.github/workflows/train.yaml)
    name="\${endpoint#repos/}"; name="\${name%/contents/*}"
    if grep -qxF "$name" "$FIXTURE/with-caller"; then echo "{\\"path\\":\\"$name\\"}"; exit 0; fi
    echo "gh: Not Found (HTTP 404) $name" >&2; exit 1
    ;;
  repos/*/actions/variables/TRAIN)
    name="\${endpoint#repos/}"; name="\${name%/actions/*}"
    if grep -qxF "$name" "$FIXTURE/switched-off"; then echo off; exit 0; fi
    echo "gh: Resource not accessible by integration (HTTP 403) $name" >&2; exit 1
    ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
`

const FAKE_NODE = `#!/usr/bin/env bash
# Stands in for the two entries: records the call, prints the repository's
# name on both streams, and fails where the fixture says so.
entry="$(basename "$1")"
echo "$GITHUB_REPOSITORY $entry \${2:-} clone=\${TRAIN_CLONE:-} config=\${TRAIN_RELEASE_CONFIG:-} token=$GITHUB_TOKEN slug=\${TRAIN_APP_SLUG:-}" >> "$FIXTURE/calls"
if [[ "$entry" == "release.ts" ]]; then
  git -C "$TRAIN_CLONE" tag --list >> "$FIXTURE/tags"
  git -C "$TRAIN_CLONE" fetch --quiet origin || exit 9
fi
echo "merged $GITHUB_REPOSITORY#12 fix(secret-branch): secret title"
echo "error in $GITHUB_REPOSITORY: boom" >&2
if grep -qxF "$GITHUB_REPOSITORY $entry" "$FIXTURE/failing"; then exit 1; fi
exit 0
`

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  })
}

/**
 * A fixture: `repos` is a list of { name, archived, caller, off, origin,
 * config }. A repository with `origin: false` is listed but cannot be cloned.
 */
function fixture(repos, { failing = [], listFails = false } = {}) {
  const dir = scratch("sweep-")
  const bin = join(dir, "bin")
  const origins = join(dir, "origins")
  mkdirSync(bin)
  mkdirSync(origins)
  for (const [name, body] of [
    ["gh", FAKE_GH],
    ["node", FAKE_NODE],
  ]) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(
    join(dir, "repositories.json"),
    JSON.stringify({ repositories: repos.map((r) => ({ full_name: r.name, archived: r.archived === true })) }),
  )
  writeFileSync(join(dir, "with-caller"), repos.filter((r) => r.caller !== false).map((r) => `${r.name}\n`).join(""))
  writeFileSync(join(dir, "switched-off"), repos.filter((r) => r.off).map((r) => `${r.name}\n`).join(""))
  writeFileSync(join(dir, "failing"), failing.map((f) => `${f}\n`).join(""))
  writeFileSync(join(dir, "calls"), "")
  writeFileSync(join(dir, "tags"), "")
  if (listFails) writeFileSync(join(dir, "list-fails"), "")
  for (const r of repos) {
    if (r.origin === false) continue
    const work = join(dir, "seed", r.name)
    mkdirSync(work, { recursive: true })
    git(work, "init", "--quiet", "--initial-branch=main")
    if (r.config !== undefined) {
      mkdirSync(join(work, ".github"))
      writeFileSync(join(work, ".github/pipeline.yaml"), r.config)
    }
    writeFileSync(join(work, "README.md"), "x\n")
    git(work, "add", "-A")
    git(work, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "feat: first")
    git(work, "-c", "tag.gpgsign=false", "tag", "v1.0.0")
    const bare = join(origins, `${r.name}.git`)
    mkdirSync(join(bare, ".."), { recursive: true })
    execFileSync("git", ["clone", "--quiet", "--bare", work, bare], { stdio: "pipe" })
  }
  return { dir, bin, origins }
}

function sweep(fx, env = {}) {
  const res = spawnSync("bash", [SCRIPT], {
    cwd: fx.dir,
    encoding: "utf8",
    env: {
      PATH: `${fx.bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      FIXTURE: fx.dir,
      GH_TOKEN: "ghs_faketoken",
      SWEEP_SELF: SELF,
      SWEEP_TRAIN_BIN: join(fx.dir, "train-bin"),
      SWEEP_WORK: join(fx.dir, "work"),
      SWEEP_GIT_BASE: fx.origins,
      TRAIN_APP_SLUG: "the-app",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...env,
    },
  })
  const calls = readFileSync(join(fx.dir, "calls"), "utf8").split("\n").filter(Boolean)
  return { ...res, out: res.stdout + res.stderr, calls }
}

/** What a reader of the public log sees: the runner replaces mask commands. */
const visible = (out) =>
  out
    .split("\n")
    .filter((l) => !l.startsWith("::add-mask::"))
    .join("\n")

const REPOS = [
  { name: "acme/alpha-secret", config: "version: '3'\nrelease:\n  version_files: [package.json]\n" },
  { name: "acme/bravo-secret" },
  { name: "acme/charlie-secret" },
]

test("the sweep runs release then merge for every repository with the caller", () => {
  const fx = fixture(REPOS)
  const r = sweep(fx)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(
    r.calls.map((c) => c.split(" ").slice(0, 3).join(" ")),
    REPOS.flatMap((repo) => [`${repo.name} release.ts --quiet`, `${repo.name} merge.ts --quiet`]),
  )
  const [release, merge] = r.calls
  assert.match(release, / clone=\S+\/work\/1 /, "a clone of its own, named by index")
  assert.match(release, / config=\{"version_files":\["package\.json"\]\} /, "the release block as JSON")
  assert.match(r.calls[2], / config=\{\} /, "no configuration file: an empty block")
  assert.match(release, / token=ghs_faketoken slug=the-app$/)
  assert.match(merge, / token=ghs_faketoken /)
  assert.match(r.stdout, /^repository 1: release=0 merge=0$/m)
  assert.match(r.stdout, /^Sweep done: 3 swept, 0 skipped, 0 failed\.$/m)
  // A full clone with its tags, in which the entry can fetch; gone afterwards.
  assert.equal(readFileSync(join(fx.dir, "tags"), "utf8"), "v1.0.0\n".repeat(3))
  assert.ok(!existsSync(join(fx.dir, "work")) || readdirSync(join(fx.dir, "work")).length === 0, "no clone left behind")
})

test("no repository name, title, branch or error text reaches the log", () => {
  const fx = fixture(
    [
      ...REPOS,
      { name: SELF },
      { name: "acme/delta-secret", caller: false },
      { name: "acme/echo-secret", origin: false },
      { name: "acme/foxtrot-secret", off: true },
      { name: "acme/golf-secret", config: "release: [unclosed\n" },
      { name: "acme/hotel-secret", archived: true },
    ],
    { failing: ["acme/bravo-secret release.ts", "acme/charlie-secret merge.ts"] },
  )
  const r = sweep(fx)
  assert.equal(r.status, 1)
  const log = visible(r.out)
  assert.doesNotMatch(log, /secret|acme|sweeper|boom|title|#12|HTTP|Not Found|ghs_|fatal|pipeline\.yaml/i, log)
  // Every name was masked before the loop touched it — whole and without its owner.
  const lines = r.out.split("\n")
  const firstUse = lines.findIndex((l) => /^repository \d+:/.test(l))
  for (const repo of ["acme/alpha-secret", "acme/delta-secret", "acme/echo-secret", "acme/golf-secret", SELF]) {
    for (const mask of [repo, repo.split("/")[1]]) {
      const at = lines.indexOf(`::add-mask::${mask}`)
      assert.ok(at >= 0 && at < firstUse, `${mask} is masked before first use`)
    }
  }
  assert.ok(!r.out.includes("hotel"), "an archived repository is not even listed")
  // Only these shapes of line exist.
  for (const line of log.split("\n").filter(Boolean)) {
    assert.match(
      line,
      /^(Sweep: \d+ repositories in the installation\.|repository \d+: (skipped \((this repository|no train caller|train switched off)\)|(clone|config)=\d+|release=\d+ merge=\d+)|Sweep done: \d+ swept, \d+ skipped, \d+ failed\.|::error::\d+ of \d+ repositories failed; the codes are above\.)$/,
    )
  }
  assert.match(log, /^repository 4: skipped \(this repository\)$/m)
  assert.match(log, /^repository 5: skipped \(no train caller\)$/m)
  assert.match(log, /^repository 6: clone=\d+$/m)
  assert.match(log, /^repository 7: skipped \(train switched off\)$/m)
  assert.match(log, /^repository 8: config=1$/m)
  assert.match(log, /^Sweep done: 3 swept, 3 skipped, 4 failed\.$/m)
  assert.ok(!r.calls.some((c) => /sweeper|delta|echo|foxtrot|golf|hotel/.test(c)), "skipped ones are never run")
})

test("a failure in the second repository does not skip the third, and fails the sweep", () => {
  const fx = fixture(REPOS, { failing: ["acme/bravo-secret release.ts"] })
  const r = sweep(fx)
  assert.equal(r.status, 1, "non-zero when any repository failed")
  assert.match(r.stdout, /^repository 1: release=0 merge=0$/m)
  assert.match(r.stdout, /^repository 2: release=1 merge=0$/m, "Merge still runs after a failed Release")
  assert.match(r.stdout, /^repository 3: release=0 merge=0$/m)
  assert.deepEqual(
    r.calls.filter((c) => c.startsWith("acme/charlie-secret ")).map((c) => c.split(" ")[1]),
    ["release.ts", "merge.ts"],
  )
  assert.match(r.stdout, /^Sweep done: 3 swept, 0 skipped, 1 failed\.$/m)
  assert.match(r.stdout, /^::error::1 of 3 repositories failed/m)
})

test("a listing that fails is an error without its text", () => {
  const fx = fixture(REPOS, { listFails: true })
  const r = sweep(fx)
  assert.equal(r.status, 1)
  assert.equal(visible(r.out).trim(), "::error::The installation's repositories could not be listed.")
  assert.deepEqual(r.calls, [])
})

test("the sweep script never traces and never lets a child print", () => {
  const text = readFileSync(SCRIPT, "utf8")
  assert.match(text, /^set -euo pipefail$/m)
  const code = text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
  assert.doesNotMatch(code, /set -[a-z]*x|xtrace/, "tracing would print every name")
  // Each gh, git and node call is either wrapped in quiet() or drops its stderr.
  for (const line of code.split("\n")) {
    if (!/\b(gh api|git clone|node "|yq )/.test(line)) continue
    assert.match(line, /quiet |2> \/dev\/null/, `this call can print: ${line.trim()}`)
  }
})
