/**
 * The Release job of the release train, as GitHub Actions runs it.
 *
 *   GITHUB_TOKEN=… GITHUB_REPOSITORY=acme/widgets TRAIN_CLONE=. node train/bin/release.ts [--quiet]
 *
 * Tags and publishes a Release PR a person merged, opens the backmerge after
 * a stable release, and keeps the Release PR of each release branch. The
 * contract (variables, output, exit codes) is in `train/README.md`; the logic
 * is `src/release-run.ts`.
 */
import { releaseMain } from "../src/release-run.ts"

process.exit(
  await releaseMain({
    env: process.env,
    argv: process.argv.slice(2),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }),
)
