import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { discoverRepositories, parseOwnerName, redactRemote } from "../../src/provisioning/discover.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { git } from "../workflow/fake-github.ts"

function clone(home: string, company: string, dir: string, remote: string | null, dev = false): string {
  const path = join(home, "companies", company, "repos", dir)
  mkdirSync(path, { recursive: true })
  git(path, "init", "-q", "-b", "main")
  if (remote) git(path, "remote", "add", "origin", remote)
  if (dev) {
    git(path, "config", "user.email", "test@example.com")
    git(path, "config", "user.name", "Test")
    git(path, "config", "commit.gpgsign", "false")
    git(path, "commit", "-q", "--allow-empty", "-m", "init")
    git(path, "update-ref", "refs/remotes/origin/dev", "HEAD")
  }
  return path
}

test("every clone under <home>/companies/*/repos/* is found, with its kind from origin", () => {
  const home = scratchDir("train-discover-")
  const widgets = clone(home, "acme", "widgets", "git@github.com:acme/widgets.git", true)
  clone(home, "acme", "docs", "git@github.com:acme/docs.git")
  clone(home, "acme", "elsewhere", "https://git.example.com/acme/elsewhere.git")
  clone(home, "globex", "gadgets", "https://github.com/Globex/gadgets")
  mkdirSync(join(home, "companies", "acme", "repos", "not-a-clone"), { recursive: true })
  mkdirSync(join(home, "companies", "empty"), { recursive: true })
  const skipped: string[] = []
  const found = discoverRepositories({ home, log: (line) => skipped.push(line) })
  assert.deepEqual(
    found.map((r) => [r.company, `${r.owner}/${r.name}`, r.kind]),
    [
      ["acme", "acme/widgets", "major"],
      ["globex", "Globex/gadgets", "small"],
    ],
  )
  assert.equal(found[0]?.path, widgets)
  assert.equal(skipped.length, 1, "the clone that is not on github.com is skipped out loud")
  assert.match(skipped[0] ?? "", /elsewhere.*not a github\.com remote/)
  assert.deepEqual(
    discoverRepositories({ home, companies: ["globex"], log: () => {} }).map((r) => r.name),
    ["gadgets"],
  )
  assert.deepEqual(discoverRepositories({ home: join(home, "nowhere") }), [])
})

test("only github.com remotes are repositories, and a logged remote carries no userinfo", () => {
  assert.deepEqual(parseOwnerName("git@github.com:acme/widgets.git"), { owner: "acme", name: "widgets" })
  assert.deepEqual(parseOwnerName("HTTPS://GitHub.com/acme/widgets/"), { owner: "acme", name: "widgets" })
  assert.deepEqual(parseOwnerName("ssh://git@github.com/acme/widgets"), { owner: "acme", name: "widgets" })
  assert.equal(parseOwnerName("https://github.example.com/acme/widgets"), null)
  assert.equal(parseOwnerName("/home/someone/origins/widgets"), null)
  assert.equal(redactRemote("https://user:token@example.com/x.git"), "https://***@example.com/x.git")
})
