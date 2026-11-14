/**
 * The Merge job of the release train, as GitHub Actions runs it.
 *
 *   GITHUB_TOKEN=… GITHUB_REPOSITORY=acme/widgets node train/bin/merge.ts [--quiet]
 *
 * Looks at every open pull request of the repository once and merges the
 * ones that are the train's to merge and green. The contract (variables,
 * output, exit codes) is in `train/README.md`; the logic is `src/merge-run.ts`.
 */
import { mergeMain } from "../src/merge-run.ts"

process.exit(
  await mergeMain({
    env: process.env,
    argv: process.argv.slice(2),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }),
)
