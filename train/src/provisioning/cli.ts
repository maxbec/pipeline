/** The fleet tool's command line, parsed apart from the work so it can be tested. */
import { parseArgs } from "node:util"
import type { TrainSchedule } from "./migrate.ts"

export interface MigrateOptions {
  /** Write. Without it the tool prints the plan per repository and changes nothing. */
  apply: boolean
  /** `owner/name`, lower-cased; empty means every discovered repository. */
  only: string[]
  /** A tag, branch or sha of the pipeline clone; undefined is the newest stable tag. */
  pipelineRef: string | undefined
  allowUntagged: boolean
  /** The directory that holds `companies/<company>/repos/<repo>`; undefined is the user's home. */
  home: string | undefined
  /** Directories under `<home>/companies` to look in; empty means all of them. */
  companies: string[]
  /** The local clone of the pipeline; undefined is the checkout the tool runs from. */
  pipelineClone: string | undefined
  /** The overrides JSON file; undefined is no overrides. */
  overrides: string | undefined
  /** `render` writes the Train caller, `skip` leaves it alone, `remove` deletes it. */
  train: "render" | "skip" | "remove"
  trainSchedule: TrainSchedule
}

/** A command line the tool cannot act on; the entry prints it and exits 2. */
export class UsageError extends Error {}

const SCHEDULES: readonly string[] = ["keep", "drop", "auto"]

export function parseMigrateArgs(argv: string[]): MigrateOptions {
  let values: Record<string, string | boolean | string[] | undefined>
  try {
    values = parseArgs({
      args: argv,
      options: {
        apply: { type: "boolean", default: false },
        only: { type: "string", multiple: true, default: [] },
        "pipeline-ref": { type: "string" },
        "allow-untagged": { type: "boolean", default: false },
        home: { type: "string" },
        company: { type: "string", multiple: true, default: [] },
        "pipeline-clone": { type: "string" },
        overrides: { type: "string" },
        "train-schedule": { type: "string", default: "auto" },
        "no-train": { type: "boolean", default: false },
        "remove-train": { type: "boolean", default: false },
      },
    }).values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const schedule = String(values["train-schedule"])
  if (!SCHEDULES.includes(schedule))
    throw new UsageError(`--train-schedule is keep, drop or auto, not ${schedule}`)
  if (values["no-train"] && values["remove-train"])
    throw new UsageError("--no-train leaves the Train caller alone and --remove-train deletes it; pass one")
  const text = (name: string) => values[name] as string | undefined
  return {
    apply: values.apply === true,
    only: (values.only as string[]).map((s) => s.toLowerCase()),
    pipelineRef: text("pipeline-ref"),
    allowUntagged: values["allow-untagged"] === true,
    home: text("home"),
    companies: values.company as string[],
    pipelineClone: text("pipeline-clone"),
    overrides: text("overrides"),
    train: values["remove-train"] ? "remove" : values["no-train"] ? "skip" : "render",
    trainSchedule: schedule as TrainSchedule,
  }
}

/**
 * Whether this pin may be written to the fleet. An untagged commit is refused
 * on `--apply` unless `--allow-untagged`; a prerelease tag is a tag.
 */
export function untaggedRefusal(
  options: Pick<MigrateOptions, "apply" | "allowUntagged">,
  pin: { sha: string; version: string | null },
): string | null {
  if (!options.apply || pin.version !== null || options.allowUntagged) return null
  return `refusing to pin the fleet to untagged ${pin.sha.slice(0, 7)}; release the pipeline first or pass --allow-untagged`
}
