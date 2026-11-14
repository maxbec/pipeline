import { execFileSync } from "node:child_process"
import { join } from "node:path"
import type { MergeCommitter } from "../../src/release/backmerge.ts"
import { scratchDir } from "./scratch.ts"

/**
 * An injected `commitMerge`: a committer that makes the merge commit in the
 * clone and pushes it to the scratch branch itself, where the default one
 * asks the Git Data API. The tree is built as the default builds it — ours'
 * tree plus the planned entries — in a throwaway index.
 */
export const pushingCommitter: MergeCommitter = async (input) => {
  const env = { ...process.env, GIT_INDEX_FILE: join(scratchDir("train-committer-"), "index") }
  const run = (args: string[], stdin?: Buffer | string): string =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        input.clone,
        ...args,
      ],
      { encoding: "utf8", env, input: stdin, stdio: ["pipe", "pipe", "pipe"] },
    ).trim()
  run(["read-tree", `${input.ours}^{tree}`])
  for (const entry of input.plan.entries) {
    if (entry.content === null) {
      run(["update-index", "--force-remove", "--", entry.path])
      continue
    }
    const blob = run(["hash-object", "-w", "--no-filters", "--stdin"], entry.content)
    run(["update-index", "--add", "--cacheinfo", `${entry.mode},${blob},${entry.path}`])
  }
  const tree = run(["write-tree"])
  const sha = run(
    ["commit-tree", "-p", input.ours, "-p", input.theirs, "-F", "-", tree],
    input.message,
  )
  run(["push", "--quiet", "--force", "origin", `${sha}:refs/heads/${input.branch}`])
  return sha
}

/** A committer that cannot commit: whatever it was asked for, nothing may be left behind. */
export const failingCommitter: MergeCommitter = async () => {
  throw new Error("the committer refused")
}
