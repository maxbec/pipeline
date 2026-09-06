// Test helpers: the pipeline's logic lives inline in the workflow's `run:`
// blocks (a reusable workflow cannot see its own repository's files at run
// time), so tests pull each block out of the YAML by step id and execute it.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const ROOT = new URL("..", import.meta.url).pathname
export const WORKFLOW = join(ROOT, ".github/workflows/universal-pipeline.yaml")

/** Parse a YAML file into JSON via yq (present on every runner and this host). */
export function yaml(file) {
  return JSON.parse(execFileSync("yq", ["-o=json", "-I=0", ".", file], { encoding: "utf8" }))
}

/**
 * Scratch space inside the repository, not /tmp: /tmp is a small tmpfs on the
 * development host and a snap-confined yq cannot read /tmp or ~/.cache at
 * all. Runners use RUNNER_TEMP. Everything is removed when the process exits.
 */
const created = []
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})
export function scratch(prefix = "t-") {
  const base = process.env.RUNNER_TEMP ?? join(ROOT, "test", ".scratch")
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, prefix))
  created.push(dir)
  return dir
}

/** The `run:` script of the step with `id` inside `job`, or null. */
export function stepScript(job, id, file = WORKFLOW) {
  const doc = yaml(file)
  const step = (doc.jobs?.[job]?.steps ?? []).find((s) => s.id === id)
  return step?.run ?? null
}

/**
 * Run a `run:` block under bash with the given env. GITHUB_OUTPUT is a scratch
 * file; its `key=value` lines come back parsed. Multiline outputs use the
 * `key<<EOF` heredoc form GitHub accepts.
 */
export function runStep(job, id, env = {}) {
  const script = stepScript(job, id)
  if (script === null) throw new Error(`no step ${job}.${id} with a run: block`)
  const dir = scratch()
  const outputFile = join(dir, "output")
  writeFileSync(outputFile, "")
  const scriptFile = join(dir, "step.sh")
  writeFileSync(scriptFile, script)
  const res = spawnSync("bash", ["-e", scriptFile], {
    cwd: env.CWD ?? dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: outputFile, ...env },
  })
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    outputs: parseOutputs(readFileSync(outputFile, "utf8")),
  }
}

export function parseOutputs(text) {
  const out = {}
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const heredoc = /^([\w-]+)<<(\w+)$/.exec(line)
    if (heredoc) {
      const [, key, marker] = heredoc
      const body = []
      for (i++; i < lines.length && lines[i] !== marker; i++) body.push(lines[i])
      out[key] = body.join("\n")
      continue
    }
    const eq = line.indexOf("=")
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}
