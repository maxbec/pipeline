import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Every git operation on a repository is serialized with `flock(1)` on a file
 * inside the common `.git` directory. A clone and all of its worktrees share
 * that directory — refs, `packed-refs`, `index.lock` and `worktrees/` metadata
 * all live there — so parallel agents on the same repository would otherwise
 * collide on `index.lock` or race a `fetch` against a `worktree add`.
 *
 * The lock is taken per command by wrapping the process, not held in-process:
 * it therefore also serializes against a human running git in the same clone.
 */
export const LOCK_FILE = "train.lock"
export const DEFAULT_LOCK_TIMEOUT_SECONDS = 120
/** `flock -E`: the exit code that means "lock not acquired", distinct from git's own. */
const LOCK_CONFLICT_EXIT = 75

export class GitLockTimeoutError extends Error {
  constructor(lockFile: string, seconds: number) {
    super(`could not take the git lock ${lockFile} within ${seconds}s`)
    this.name = "GitLockTimeoutError"
  }
}

export class GitError extends Error {
  readonly cwd: string
  readonly args: readonly string[]
  readonly stderr: string
  readonly exitCode: number | string | undefined
  /** What the command printed before it failed; `merge-tree` reports conflicts this way. */
  readonly stdout: string | undefined
  constructor(
    cwd: string,
    args: readonly string[],
    stderr: string,
    exitCode: number | string | undefined,
    stdout?: string,
  ) {
    super(`git ${args.join(" ")} in ${cwd} failed (${exitCode}): ${stderr.trim()}`)
    this.name = "GitError"
    this.cwd = cwd
    this.args = args
    this.stderr = stderr
    this.exitCode = exitCode
    this.stdout = stdout
  }
}

/**
 * The common `.git` directory for a clone or any of its worktrees. Read-only
 * and lock-free by necessity: it is how the lock file is found.
 */
export async function gitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await run("git", [
    "-C",
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])
  return stdout.trim()
}

export async function lockFileFor(cwd: string): Promise<string> {
  return join(await gitCommonDir(cwd), LOCK_FILE)
}

/** The full argv: `flock -w <s> -E 75 <lock> git -C <cwd> <args>`. */
export function gitArgv(
  cwd: string,
  lockFile: string,
  args: readonly string[],
  timeoutSeconds: number = DEFAULT_LOCK_TIMEOUT_SECONDS,
): string[] {
  return [
    "flock",
    "-w",
    String(timeoutSeconds),
    "-E",
    String(LOCK_CONFLICT_EXIT),
    lockFile,
    "git",
    "-C",
    cwd,
    ...args,
  ]
}

export interface GitOptions {
  timeoutSeconds?: number
  env?: NodeJS.ProcessEnv
}

/** Run one git command under the repository lock and return trimmed stdout. */
export async function git(
  cwd: string,
  args: readonly string[],
  opts: GitOptions = {},
): Promise<string> {
  const out = await runGit(cwd, args, opts, "utf8")
  return String(out).trim()
}

/** The same, with stdout as raw bytes: blob contents, which trimming would corrupt. */
export async function gitBytes(
  cwd: string,
  args: readonly string[],
  opts: GitOptions = {},
): Promise<Buffer> {
  return (await runGit(cwd, args, opts, "buffer")) as Buffer
}

async function runGit(
  cwd: string,
  args: readonly string[],
  opts: GitOptions,
  encoding: "utf8" | "buffer",
): Promise<string | Buffer> {
  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS
  const lockFile = await lockFileFor(cwd)
  const [cmd, ...argv] = gitArgv(cwd, lockFile, args, timeoutSeconds)
  try {
    const { stdout } = await run(cmd as string, argv, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      maxBuffer: 64 * 1024 * 1024,
      encoding,
    })
    return stdout
  } catch (error) {
    const e = error as {
      code?: number | string
      stderr?: string | Buffer
      stdout?: string | Buffer
    }
    if (e.code === LOCK_CONFLICT_EXIT) throw new GitLockTimeoutError(lockFile, timeoutSeconds)
    throw new GitError(
      cwd,
      args,
      e.stderr === undefined ? String(error) : String(e.stderr),
      e.code,
      e.stdout === undefined ? undefined : String(e.stdout),
    )
  }
}
