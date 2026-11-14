# train/

The release train's library: the code that decides whether a pull request may
merge, derives the next version from conventional PR titles, keeps one Release
PR per branch, and plans the promotion and the backmerge. It was moved here
from the private `maxbec/flaiky` repository, where it ran as part of a
long-lived service; here it is plain library code without that host.

## Layout

```
src/types.ts      the shared shapes (Repository, MergeVerdict, GitHubEvent)
src/github/       REST + GraphQL client, token providers, PR state and merge rules,
                  pulls, releases, Git Data commits, update-branch, the Dependabot merger
src/release/      conventional titles, semver, version derivation, version files,
                  changelog, history read from a clone, Release PR sync, backmerge
src/git/lock.ts   git in a shared clone, serialized with flock
bin/merge-pr.ts   merge one PR through the rules by hand (`--auth gh|env`)
test/             node:test; `workflow/fake-github.ts` is a GitHub over a real bare origin
```

## Runtime

Node 24.12 or later, native type stripping: `.ts` files run as they are, import
specifiers carry the `.ts` extension, nothing is built. No runtime npm
dependency. `git` on PATH; `flock` where several processes share one clone.

Tokens come from a `TokenProvider`: `AppTokenProvider` (a GitHub App
installation), `envTokenProvider("GITHUB_TOKEN")` (a workflow job) or
`ghCliTokenProvider()` (a developer's machine).

## Tests

```sh
npm test            # from the repository root: the pipeline's tests and train/test
node --test "train/test/**/*.test.ts"
npm run typecheck   # tsc --noEmit over train/
```

The tests build scratch repositories under the system temp directory and remove
them again; they need `git` and nothing else.

## Not here yet

The Actions entry points (`bin/merge.ts`, `bin/release.ts`, `bin/fix.ts`), the
remaining hand scripts and the reusable `train.yaml` workflow follow in later
pull requests. Until then nothing in this repository calls this code.
