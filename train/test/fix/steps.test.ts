import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { collect, extractDiagnosis } from "../../src/fix/collect.ts"
import { commitFix } from "../../src/fix/commit.ts"
import { runTriage } from "../../src/fix/steps.ts"
import { attemptMarker, GAVE_UP_MARKER } from "../../src/fix/triage.ts"
import { scratchDir } from "../helpers/scratch.ts"
import { git } from "../workflow/fake-github.ts"
import { FixWorld } from "./fix-world.ts"

let n = 0
const SOURCE = "export const a = 1\n"
const TEST = "test('a', () => {\n  assert.equal(a, 2)\n})\n"

function world(over: Parameters<FixWorld["pull"]>[2] = {}) {
  const w = new FixWorld(`steps-${++n}`)
  const { pull, headSha } = w.pull("feat/x", { "src/a.ts": SOURCE, "test/a.test.ts": TEST }, over)
  const dir = scratchDir("train-fix-out-")
  return { w, pull, headSha, dir }
}

// ---- triage ----------------------------------------------------------------

function triage(t: ReturnType<typeof world>, opts: { claude?: boolean } = {}) {
  const notices: string[] = []
  return runTriage({
    client: t.w.client,
    repo: t.w.repo,
    runId: 7,
    claudeAvailable: opts.claude ?? true,
    inputDir: join(t.dir, "fix-input"),
    readLog: async (jobId) => t.w.logs.get(jobId) ?? "",
    notice: (m) => notices.push(m),
  }).then((outputs) => ({ outputs, notices }))
}

test("triage: the first failure reruns the failed jobs and writes nothing", async () => {
  const t = world()
  t.w.run(7, t.headSha, "feat/x")
  const { outputs } = await triage(t)
  assert.deepEqual(outputs, { action: "rerun", pr: "", head_sha: "", attempt: "" })
  assert.deepEqual(t.w.reruns, [7])
  assert.equal(existsSync(join(t.dir, "fix-input")), false)
})

test("triage: a second failure writes the log excerpt, the file list and the prompt", async () => {
  const t = world({
    files: [
      { filename: "src/a.ts", status: "modified" },
      { filename: "test/a.test.ts", status: "added" },
      { filename: "src/gone.ts", status: "removed" },
    ],
  })
  t.w.run(7, t.headSha, "feat/x", { run_attempt: 2, log: "boom\nError: expected 1 to be 2\n" })
  const { outputs } = await triage(t)
  assert.deepEqual(outputs, { action: "propose", pr: "1", head_sha: t.headSha, attempt: "1" })
  assert.deepEqual(t.w.reruns, [])
  const input = join(t.dir, "fix-input")
  assert.equal(readFileSync(join(input, "log.txt"), "utf8"), "boom\nError: expected 1 to be 2")
  assert.deepEqual(JSON.parse(readFileSync(join(input, "files.json"), "utf8")), ["src/a.ts", "test/a.test.ts"])
  const prompt = readFileSync(join(input, "prompt.txt"), "utf8")
  assert.match(prompt, /Error: expected 1 to be 2/)
  assert.match(prompt, /^- src\/a\.ts$/m)
  assert.doesNotMatch(prompt, /src\/gone\.ts/, "a removed file cannot be edited")
  assert.deepEqual(t.w.comments(1), [], "triage says nothing on the pull request")
})

test("triage: without the Claude token a second failure is reported and skipped", async () => {
  const t = world()
  t.w.run(7, t.headSha, "feat/x", { run_attempt: 2 })
  const { outputs, notices } = await triage(t, { claude: false })
  assert.equal(outputs.action, "none")
  assert.match(notices.join("\n"), /CLAUDE_CODE_OAUTH_TOKEN/)
  assert.equal(existsSync(join(t.dir, "fix-input")), false)
  // The rerun needs no model.
  t.w.runs.get(7)!.run_attempt = 1
  assert.equal((await triage(t, { claude: false })).outputs.action, "rerun")
})

test("triage: giving up comments once and asks for a person", async () => {
  const t = world()
  t.w.run(7, t.headSha, "feat/x", { run_attempt: 2 })
  for (let i = 1; i <= 3; i++) t.w.comment(1, attemptMarker(i))
  const { outputs } = await triage(t)
  assert.deepEqual(outputs, { action: "give_up", pr: "1", head_sha: "", attempt: "" })
  assert.deepEqual(t.w.labels(1), ["needs-human"])
  const final = t.w.comments(1).filter((c) => c.includes(GAVE_UP_MARKER))
  assert.equal(final.length, 1)
  assert.match(final[0] ?? "", /three|3/)

  // A later run finds the label and stops; had the label been removed, the comment is not repeated.
  t.w.extras.get(1)!.labels.length = 0
  await triage(t)
  assert.equal(t.w.comments(1).filter((c) => c.includes(GAVE_UP_MARKER)).length, 1)
  assert.deepEqual(t.w.labels(1), ["needs-human"])
})

test("triage: a run that is nobody's business writes the reason and nothing else", async () => {
  const t = world()
  t.w.run(7, t.headSha, "feat/x", { conclusion: "cancelled" })
  const { outputs, notices } = await triage(t)
  assert.equal(outputs.action, "none")
  assert.equal(notices.length, 1)
  assert.deepEqual(t.w.reruns, [])
})

// ---- collect ---------------------------------------------------------------

/** A checkout of the pull request's head, the way the propose job has it. */
function checkout(t: ReturnType<typeof world>): string {
  const tree = join(t.dir, "tree")
  git(t.dir, "clone", "-q", t.w.gh.origin, tree)
  git(tree, "checkout", "-q", "--detach", t.headSha)
  return tree
}

function claudeOutput(dir: string, payload: unknown): string {
  const file = join(dir, "claude.json")
  writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload))
  return file
}

test("collect: every file that differs from the head, and the diagnosis", () => {
  const t = world()
  const tree = checkout(t)
  writeFileSync(join(tree, "src/a.ts"), "export const a = 2\n")
  writeFileSync(join(tree, "src/new.ts"), "export const b = 1\n")
  rmSync(join(tree, "README.md"))
  // What the job itself puts into the workspace is not a change.
  mkdirSync(join(tree, ".pipeline/train"), { recursive: true })
  writeFileSync(join(tree, ".pipeline/train/x.ts"), "x\n")
  const out = join(t.dir, "fix-output")
  collect({
    tree,
    baseSha: t.headSha,
    outputDir: out,
    claudeOutput: claudeOutput(t.dir, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "I changed one line.\n\nDIAGNOSIS:\nThe constant was 1.\nThe test wants 2.\nChanged it.\n",
    }),
  })
  const changes = JSON.parse(readFileSync(join(out, "changes.json"), "utf8")) as { path: string }[]
  assert.deepEqual(
    changes.sort((x, y) => x.path.localeCompare(y.path)),
    [
      { path: "README.md", after: null },
      { path: "src/a.ts", after: "export const a = 2\n" },
      { path: "src/new.ts", after: "export const b = 1\n" },
    ],
  )
  assert.equal(
    readFileSync(join(out, "diagnosis.txt"), "utf8"),
    "The constant was 1.\nThe test wants 2.\nChanged it.\n",
  )
})

test("collect: an untouched tree is no change, whatever its line endings", () => {
  const t = world()
  const tree = checkout(t)
  // A checkout with `eol=crlf` holds CRLF where the commit holds LF.
  writeFileSync(join(tree, "src/a.ts"), SOURCE.replaceAll("\n", "\r\n"))
  const out = join(t.dir, "fix-output")
  collect({ tree, baseSha: t.headSha, outputDir: out, claudeOutput: join(t.dir, "missing.json") })
  assert.deepEqual(JSON.parse(readFileSync(join(out, "changes.json"), "utf8")), [])
  assert.match(readFileSync(join(out, "diagnosis.txt"), "utf8"), /no result/i)
})

test("collect: a large or binary file is named, not carried, and a symlink is not followed", () => {
  const t = world()
  const tree = checkout(t)
  writeFileSync(join(tree, "src/a.ts"), "x".repeat(300 * 1024))
  writeFileSync(join(tree, "test/a.test.ts"), Buffer.from([0x66, 0x00, 0x01, 0xff]))
  symlinkSync("/etc/hostname", join(tree, "link"))
  const out = join(t.dir, "fix-output")
  collect({ tree, baseSha: t.headSha, outputDir: out, claudeOutput: join(t.dir, "missing.json") })
  const changes = JSON.parse(readFileSync(join(out, "changes.json"), "utf8")) as { path: string }[]
  assert.deepEqual(
    changes.sort((x, y) => x.path.localeCompare(y.path)),
    [
      { path: "link", after: null, unreadable: "not a regular file" },
      { path: "src/a.ts", after: null, unreadable: "larger than 200 KB" },
      { path: "test/a.test.ts", after: null, unreadable: "binary" },
    ],
  )
})

test("the diagnosis is what follows DIAGNOSIS:, at most ten lines", () => {
  const lines = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`)
  assert.equal(
    extractDiagnosis(JSON.stringify({ result: `preamble\nDIAGNOSIS:\n\n${lines.join("\n")}` })),
    `${lines.slice(0, 10).join("\n")}\n`,
  )
  // Without the heading the answer's own first lines stand in.
  assert.equal(extractDiagnosis(JSON.stringify({ result: "It is the lockfile.\nNothing changed." })), "It is the lockfile.\nNothing changed.\n")
})

test("a run that failed says so in the diagnosis", () => {
  assert.match(
    extractDiagnosis(JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "" })),
    /did not finish.*error_max_turns/,
  )
  assert.match(
    extractDiagnosis(JSON.stringify({ is_error: true, result: "Claude usage limit reached. Resets at 3pm." })),
    /did not finish.*usage limit reached/s,
  )
  assert.match(extractDiagnosis("not json at all"), /no result/i)
  assert.match(extractDiagnosis(null), /no result/i)
})

// ---- commit ----------------------------------------------------------------

function output(dir: string, changes: unknown, diagnosis = "The constant was 1.\nThe test wants 2.\n"): string {
  const out = join(dir, "fix-output")
  mkdirSync(out, { recursive: true })
  if (changes !== undefined) writeFileSync(join(out, "changes.json"), JSON.stringify(changes))
  writeFileSync(join(out, "diagnosis.txt"), diagnosis)
  return out
}

function commit(t: ReturnType<typeof world>, outputDir: string, attempt = 1, headSha = t.headSha) {
  return commitFix({ client: t.w.client, repo: t.w.repo, pr: 1, headSha, attempt, outputDir })
}

test("commit: a head that moved writes nothing at all", async () => {
  const t = world()
  const out = output(t.dir, [{ path: "src/a.ts", after: "export const a = 2\n" }])
  const moved = t.w.commit("feat/x", { "src/a.ts": "export const a = 3\n" })
  assert.deepEqual(await commit(t, out), { outcome: "moved" })
  assert.equal(t.w.gh.sha("feat/x"), moved)
  assert.deepEqual(t.w.gh.commits, [])
  assert.deepEqual(t.w.comments(1), [])
  assert.deepEqual(t.w.labels(1), [])
})

test("commit: a closed pull request writes nothing", async () => {
  const t = world()
  t.pull.state = "closed"
  assert.deepEqual(await commit(t, output(t.dir, [])), { outcome: "moved" })
  assert.deepEqual(t.w.comments(1), [])
})

test("commit: an accepted fix is one signed commit on the head, then the marker comment", async () => {
  const t = world()
  const out = output(t.dir, [{ path: "src/a.ts", after: "export const a = 2\n" }])
  const result = await commit(t, out)
  assert.equal(result.outcome, "committed")
  const tip = t.w.gh.sha("feat/x") ?? ""
  assert.notEqual(tip, t.headSha)
  assert.equal(git(t.w.gh.origin, "rev-parse", `${tip}^`), t.headSha, "its parent is the head the run failed on")
  assert.equal(t.w.file("feat/x", "src/a.ts"), "export const a = 2\n")
  assert.equal(t.w.gh.commits.length, 1)
  const made = t.w.gh.commits[0]!
  assert.deepEqual(made.additions, ["src/a.ts"])
  assert.deepEqual(made.deletions, [])
  assert.equal(made.message.headline, "fix: The constant was 1.")
  assert.match(made.message.body, /pipeline \/ Check/)
  assert.match(made.message.body, /Co-Authored-By: Claude <noreply@anthropic\.com>\s*$/)
  const comments = t.w.comments(1)
  assert.equal(comments.length, 1)
  assert.ok(comments[0]!.startsWith(attemptMarker(1)))
  assert.match(comments[0]!, /The test wants 2\./)
  assert.match(comments[0]!, new RegExp(tip.slice(0, 7)))
  assert.deepEqual(t.w.labels(1), [])
})

test("commit: the headline is one line of at most 72 characters and mentions nobody", async () => {
  const t = world()
  const out = output(
    t.dir,
    [{ path: "src/a.ts", after: "export const a = 2\n" }],
    `@octocat ${"long ".repeat(30)}\nsecond line\n`,
  )
  await commit(t, out)
  const headline = t.w.gh.commits[0]!.message.headline
  assert.ok(headline.length <= 72, headline)
  assert.doesNotMatch(headline, /@|\n/)
  assert.doesNotMatch(t.w.comments(1)[0]!.replace(/```[\s\S]*?```/g, ""), /@octocat/, "the diagnosis is quoted as code")
})

test("commit: a refused change is not committed; the pull request waits for a person", async () => {
  const t = world()
  const out = output(t.dir, [
    { path: "src/a.ts", after: "// @ts-ignore\nexport const a = 2\n" },
    { path: ".github/workflows/ci.yaml", after: "on: push\n" },
  ])
  const result = await commit(t, out, 2)
  assert.equal(result.outcome, "refused")
  assert.equal(t.w.gh.sha("feat/x"), t.headSha)
  assert.deepEqual(t.w.gh.commits, [])
  assert.deepEqual(t.w.labels(1), ["needs-human"])
  const [comment] = t.w.comments(1)
  assert.ok(comment!.startsWith(attemptMarker(2)))
  assert.match(comment!, /suppression/)
  assert.match(comment!, /\.github\/workflows\/ci\.yaml/)
  assert.match(comment!, /The constant was 1\./)
})

test("commit: the file list comes from GitHub, never from the artifact", async () => {
  const t = world({ files: [{ filename: "test/a.test.ts", status: "modified" }] })
  const out = output(t.dir, [{ path: "src/a.ts", after: "export const a = 2\n" }])
  writeFileSync(join(out, "files.json"), JSON.stringify(["src/a.ts"]))
  assert.equal((await commit(t, out)).outcome, "refused")
  assert.deepEqual(t.w.gh.commits, [])
})

test("commit: unreadable, malformed and oversized output is refused, not trusted", async () => {
  for (const changes of [
    [{ path: "src/a.ts", after: null, unreadable: "binary" }],
    [{ path: "src/a.ts", after: 5 }],
    { path: "src/a.ts" },
    "nonsense",
    Array.from({ length: 21 }, (_, i) => ({ path: `src/f${i}.ts`, after: "x\n" })),
  ]) {
    const t = world()
    const result = await commit(t, output(t.dir, changes))
    assert.equal(result.outcome, "refused", JSON.stringify(changes).slice(0, 60))
    assert.deepEqual(t.w.gh.commits, [])
    assert.deepEqual(t.w.labels(1), ["needs-human"])
  }
})

test("commit: a diagnosis shaped like a secret is withheld", async () => {
  const t = world()
  const secret = ["gh", "s_", "a".repeat(36)].join("")
  const out = output(t.dir, [], `The token is ${secret}\n`)
  await commit(t, out)
  assert.doesNotMatch(t.w.comments(1).join("\n"), new RegExp(secret))
  assert.match(t.w.comments(1)[0]!, /withheld/)
})

test("commit: no change is a diagnosis with the marker and no label", async () => {
  const t = world()
  // The same content as the head holds is not a change either.
  const out = output(t.dir, [{ path: "src/a.ts", after: SOURCE }], "The test is right.\nThe cause is in src/other.ts.\n")
  assert.equal((await commit(t, out)).outcome, "unchanged")
  assert.deepEqual(t.w.gh.commits, [])
  assert.deepEqual(t.w.labels(1), [])
  const [comment] = t.w.comments(1)
  assert.ok(comment!.startsWith(attemptMarker(1)))
  assert.match(comment!, /The cause is in src\/other\.ts\./)
})

test("commit: a propose job that left nothing behind still reports", async () => {
  const t = world()
  assert.equal((await commit(t, join(t.dir, "nowhere"))).outcome, "unchanged")
  const [comment] = t.w.comments(1)
  assert.ok(comment!.startsWith(attemptMarker(1)))
  assert.match(comment!, /propose job/)
})

test("commit: the third attempt without a fix hands the pull request to a person", async () => {
  const t = world()
  t.w.comment(1, attemptMarker(1))
  t.w.comment(1, attemptMarker(2))
  assert.equal((await commit(t, output(t.dir, []), 3)).outcome, "unchanged")
  assert.deepEqual(t.w.labels(1), ["needs-human"])
  const last = t.w.comments(1).at(-1)!
  assert.ok(last.startsWith(attemptMarker(3)))
  assert.match(last, /last/i)
})

test("commit: a third attempt that commits leaves the verdict to the next Check", async () => {
  const t = world()
  const out = output(t.dir, [{ path: "src/a.ts", after: "export const a = 2\n" }])
  assert.equal((await commit(t, out, 3)).outcome, "committed")
  assert.deepEqual(t.w.labels(1), [])
  assert.ok(t.w.comments(1).at(-1)!.startsWith(attemptMarker(3)))
})
