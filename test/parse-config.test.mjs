import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { runStep, scratch } from "./helpers.mjs"

function parse(config, env = {}) {
  const dir = scratch()
  writeFileSync(join(dir, "pipeline.yaml"), config)
  return runStep("guard", "config", { CWD: dir, CONFIG_FILE: "pipeline.yaml", ...env })
}

const minimal = `version: '3'\n`

test("a minimal v3 config gets every default", () => {
  const r = parse(minimal)
  assert.equal(r.status, 0, r.stderr)
  const o = r.outputs
  assert.equal(o.stack, "none", "nothing to detect in an empty tree")
  assert.equal(o.runner, '["ubuntu-latest"]')
  assert.equal(o.security, "true")
  assert.equal(o.lint, "true")
  assert.equal(o.test, "true")
  assert.equal(o.build, "true")
  assert.equal(o["deploy-provider"], "none")
  assert.equal(o["deploy-targets"], '[{"name":"app"}]')
  assert.equal(o["render-hook"], "false")
})

test("the stack and toolchain are detected from the tree when not configured", () => {
  const dir = scratch()
  writeFileSync(join(dir, "pipeline.yaml"), minimal)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: ">=22" }, packageManager: "pnpm@11.0.0" }))
  writeFileSync(join(dir, "pnpm-lock.yaml"), "")
  const r = runStep("guard", "config", { CWD: dir, CONFIG_FILE: "pipeline.yaml" })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.outputs.stack, "nodejs")
  assert.equal(r.outputs["node-version"], "22")
  assert.equal(r.outputs["package-manager"], "pnpm")
  assert.equal(r.outputs["pnpm-version"], "", "packageManager pins pnpm; the action reads it")
  assert.equal(r.outputs.cache, "pnpm")
  writeFileSync(join(dir, ".nvmrc"), "v24\n")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
  const again = runStep("guard", "config", { CWD: dir, CONFIG_FILE: "pipeline.yaml" })
  assert.equal(again.outputs["node-version"], "24", ".nvmrc wins over engines")
  assert.equal(again.outputs["pnpm-version"], "latest", "no packageManager field: install the latest pnpm")
})

test("a boolean that is not a boolean is a configuration error", () => {
  const r = parse(`version: '3'\nlint:\n  enable: yes please\n`)
  assert.equal(r.status, 1)
  assert.match(r.stdout + r.stderr, /::error::.*true or false/)
})

test("a v2 config is refused loudly instead of half-working", () => {
  const r = parse(`version: '2.0'\nstack: nodejs\ndeployment:\n  provider: vercel\n`)
  assert.equal(r.status, 1)
  assert.match(r.stdout + r.stderr, /::error::.*version/)
})

test("a missing config file is a configuration error, not a green run", () => {
  const r = runStep("guard", "config", { CWD: scratch(), CONFIG_FILE: "nope.yaml" })
  assert.equal(r.status, 1)
})

test("runner labels come from config, then PIPELINE_RUNNER, then ubuntu-latest", () => {
  assert.equal(parse(minimal, { PIPELINE_RUNNER: '["self-hosted","mainz-homelab"]' }).outputs.runner, '["self-hosted","mainz-homelab"]')
  assert.equal(
    parse(`version: '3'\nrunner:\n  labels: [self-hosted, mainz-homelab, linux, x64]\n`, { PIPELINE_RUNNER: '["x"]' }).outputs.runner,
    '["self-hosted","mainz-homelab","linux","x64"]',
  )
})

test("stack, runtime and the check commands pass through", () => {
  const r = parse(`version: '3'
stack: nodejs
runtime:
  node_version: 26.8.1
security:
  trufflehog: false
lint:
  command: pnpm lint
test:
  command: bash scripts/ci-test.sh
  coverage: false
build:
  enable: false
`)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.outputs.stack, "nodejs")
  assert.equal(r.outputs["node-version"], "26.8.1")
  assert.equal(r.outputs.trufflehog, "false")
  assert.equal(r.outputs["dependency-review"], "true")
  assert.equal(r.outputs["lint-command"], "pnpm lint")
  assert.equal(r.outputs["test-command"], "bash scripts/ci-test.sh")
  assert.equal(r.outputs.build, "false")
})

test("a multi-line build command survives as one output", () => {
  const r = parse(`version: '3'\nbuild:\n  command: |\n    set -a\n    pnpm build\n`)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.outputs["build-command"], "set -a\npnpm build")
})

test("docker-ghcr images become the Deploy matrix, with the first image primary", () => {
  const r = parse(`version: '3'
deploy:
  provider: docker-ghcr
  docker:
    images:
      - name: default
        dockerfile: docker/unraid/Dockerfile
        context: .
        platforms: linux/amd64
      - name: cron
        dockerfile: docker/unraid/cron.Dockerfile
  render:
    hook: true
`)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.outputs["deploy-provider"], "docker-ghcr")
  const targets = JSON.parse(r.outputs["deploy-targets"])
  assert.deepEqual(targets.map((t) => t.name), ["default", "cron"])
  assert.equal(targets[0].dockerfile, "docker/unraid/Dockerfile")
  assert.equal(r.outputs["primary-target"], "default")
  assert.equal(r.outputs["render-hook"], "true")
})

test("vercel and cloudflare-workers carry their provider settings", () => {
  const v = parse(`version: '3'\ndeploy:\n  provider: vercel\n  vercel:\n    scope: navigaite\n`)
  assert.equal(v.outputs["deploy-provider"], "vercel")
  assert.equal(v.outputs["vercel-scope"], "navigaite")
  assert.equal(v.outputs["deploy-targets"], '[{"name":"app"}]')
  const c = parse(`version: '3'\ndeploy:\n  provider: cloudflare-workers\n  cloudflare:\n    config: wrangler.jsonc\n    build_command: npm run build\n`)
  assert.equal(c.outputs["cloudflare-config"], "wrangler.jsonc")
  assert.equal(c.outputs["cloudflare-build-command"], "npm run build")
})

test("an unknown provider is refused", () => {
  const r = parse(`version: '3'\ndeploy:\n  provider: digitalocean\n`)
  assert.equal(r.status, 1)
  assert.match(r.stdout + r.stderr, /::error::.*provider/)
})
