import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after } from "node:test"

/**
 * A temporary directory that is removed when the file's tests end — whether
 * they passed, failed, or threw.
 *
 * The suites build their scratch worlds under `os.tmpdir()`, which on a small
 * host is a tmpfs shared with everything else on the box. A suite that removes
 * its directory on the last line of each test leaks one per failing test, and
 * a suite that never removes it leaks one per test full stop. Neither failure
 * is visible from a test run: it shows up weeks later as a full /tmp.
 *
 * So the removal is not left to each call site. Every directory handed out here
 * is remembered and taken down by a root `after` hook, which `node --test` runs
 * once the file is done regardless of how its tests ended, and by a `process
 * exit` handler for the case where the process dies before hooks can run.
 *
 * @param prefix what to call it, e.g. `"train-home-"`; `mkdtemp` appends six
 *   random characters.
 * @param parent where to put it. Defaults to the tmpdir; pass another scratch
 *   directory to nest inside it.
 */
export function scratchDir(prefix: string, parent: string = tmpdir()): string {
  const dir = mkdtempSync(join(parent, prefix))
  created.add(dir)
  return dir
}

const created = new Set<string>()

function removeAll(): void {
  for (const dir of created) {
    // `force` because a nested scratch goes with the parent that already went,
    // and a test that removed its own directory early is not an error here.
    rmSync(dir, { recursive: true, force: true })
    created.delete(dir)
  }
}

// Registered at import, not on first use: a root hook added while the runner is
// already executing tests is not guaranteed to be honoured, and every test file
// imports this module before its first test runs.
after(removeAll)

// The backstop. `after` does not run when the process is killed or dies on an
// uncaught exception outside a test, which is exactly when a suite is most
// likely to have left a world on disk. `rmSync` is synchronous, so it still
// works from an exit handler.
process.on("exit", removeAll)
