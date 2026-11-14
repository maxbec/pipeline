import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMigrateArgs, UsageError } from "../../src/provisioning/cli.ts"

test("no arguments is a dry run over everything, the Train caller rendered with schedule auto", () => {
  assert.deepEqual(parseMigrateArgs([]), {
    apply: false,
    only: [],
    pipelineRef: undefined,
    allowUntagged: false,
    home: undefined,
    companies: [],
    pipelineClone: undefined,
    overrides: undefined,
    train: "render",
    trainSchedule: "auto",
  })
})

test("every flag lands where the tool reads it", () => {
  const options = parseMigrateArgs([
    "--apply",
    "--only",
    "Acme/Widgets",
    "--only",
    "acme/gadgets",
    "--pipeline-ref",
    "v5.5.0-beta.1",
    "--allow-untagged",
    "--home",
    "/srv",
    "--company",
    "acme",
    "--pipeline-clone",
    "/srv/pipeline",
    "--overrides",
    "/srv/fleet.json",
    "--train-schedule",
    "drop",
  ])
  assert.deepEqual(options, {
    apply: true,
    only: ["acme/widgets", "acme/gadgets"],
    pipelineRef: "v5.5.0-beta.1",
    allowUntagged: true,
    home: "/srv",
    companies: ["acme"],
    pipelineClone: "/srv/pipeline",
    overrides: "/srv/fleet.json",
    train: "render",
    trainSchedule: "drop",
  })
})

test("--no-train skips the Train caller, --remove-train deletes it, both together is a usage error", () => {
  assert.equal(parseMigrateArgs(["--no-train"]).train, "skip")
  assert.equal(parseMigrateArgs(["--remove-train"]).train, "remove")
  assert.throws(() => parseMigrateArgs(["--no-train", "--remove-train"]), UsageError)
})

test("an unknown schedule or flag is a usage error", () => {
  assert.throws(() => parseMigrateArgs(["--train-schedule", "sometimes"]), UsageError)
  assert.throws(() => parseMigrateArgs(["--aply"]), UsageError)
})
