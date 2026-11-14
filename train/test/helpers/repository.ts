import type { Repository } from "../../src/types.ts"

/** A repository as an entry point would build it: the identity given, the rest at its defaults. */
export function repositoryOf(
  input: Pick<Repository, "owner" | "name" | "kind" | "path"> & Partial<Repository>,
): Repository {
  return {
    id: `${input.owner}-${input.name}`,
    company: input.owner,
    dependabotMergeEnabled: true,
    versionFiles: ["package.json"],
    changelogShowHidden: false,
    ...input,
  }
}
