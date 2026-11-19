/**
 * The Verify job of the release train, as GitHub Actions runs it.
 *
 *   GITHUB_TOKEN=… GITHUB_REPOSITORY=acme/widgets node train/bin/verify.ts [--quiet]
 *
 * Looks at every open Release PR of the repository once and starts the full
 * Check of its base branch where the Release PR failed as "Not fully
 * verified" and no full Check of the tip exists yet. The contract (variables,
 * output, exit codes) is in `train/README.md`; the logic is `src/verify-run.ts`.
 */
import { verifyMain } from "../src/verify-run.ts"

process.exit(
  await verifyMain({
    env: process.env,
    argv: process.argv.slice(2),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }),
)
