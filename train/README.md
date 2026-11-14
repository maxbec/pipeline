# train/

The release train's library: the code that decides whether a pull request may
merge, derives the next version from conventional PR titles, keeps one Release
PR per branch, and plans the promotion and the backmerge. It was moved here
from the private `maxbec/flaiky` repository, where it ran as part of a
long-lived service; here it is plain library code without that host.

## Layout

```
src/types.ts        the shared shapes (Repository, MergeVerdict, GitHubEvent)
src/github/         REST + GraphQL client, token providers, PR state and merge rules,
                    pulls, releases, Git Data commits, update-branch, the Dependabot merger
src/release/        conventional titles, semver, version derivation, version files,
                    changelog, history read from a clone, Release PR sync, backmerge,
                    the pending release (`pending.ts`) and the last run's output (`previous.ts`)
src/policy.ts       which pull requests the Merge job may consider at all (pure)
src/config.ts       the `release:` block of `.github/pipeline.yaml`, from JSON
src/merge-run.ts    the Merge job; `bin/merge.ts` is its wrapper
src/release-run.ts  the Release job; `bin/release.ts` is its wrapper
src/entry.ts        what both entries share: environment, exit codes, quiet output
src/git/lock.ts     git in a shared clone, serialized with flock
bin/merge.ts        Actions entry: merge what is the train's to merge and green
bin/release.ts      Actions entry: tag and publish a merged Release PR, keep the Release PRs
bin/merge-pr.ts     merge one PR through the rules by hand (`--auth gh|env`)
test/               node:test; `workflow/fake-github.ts` is a GitHub over a real bare origin
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

## The Actions entries

Two scripts a workflow job runs. Each looks at the whole repository every
time; the event that started the run is only a poke. Both take their input
from the environment and one flag.

| Variable | Entry | |
|---|---|---|
| `GITHUB_TOKEN` | both | required; the token every call is made with |
| `GITHUB_REPOSITORY` | both | required; `owner/name` |
| `TRAIN_DRY_RUN` | both | `1`: decide and report, write nothing |
| `GITHUB_STEP_SUMMARY` | both | when set, a markdown table is appended to it |
| `TRAIN_CLONE` | release | a full clone with tags (`fetch-depth: 0`); defaults to the working directory |
| `TRAIN_RELEASE_CONFIG` | release | the `release:` block of `.github/pipeline.yaml` as JSON (a `yq` step produces it); unset or `null` is the defaults |
| `TRAIN_APP_SLUG` | release | the train's GitHub App, without `[bot]`; a Release PR merged by it is refused |

`--quiet` prints one JSON object of counts and nothing else: no pull request
number, title, branch, version or error text, on stdout, stderr or in the step
summary. It is for runs whose log is public while the repository they work on
is not.

| Exit | |
|---|---|
| 0 | the run did what there was to do, which may be nothing |
| 1 | an unexpected error, or a result that must not pass in silence (below) |
| 2 | the entry was called wrongly: a missing or malformed variable, an unknown flag, an invalid release config |

### `bin/merge.ts`

```sh
GITHUB_TOKEN=… GITHUB_REPOSITORY=acme/widgets node train/bin/merge.ts [--quiet]
```

For every open pull request, in this order:

1. `mergePolicy` (`src/policy.ts`). **Skipped**: a draft, the `hold` label
   (which wins over everything), a fork's head, a Release PR (`release/*`), a
   promotion (`promote/*`, `dev` into `main`), a hotfix, anything into `main`
   of a repository that has `dev`, any base that is not the repository's base
   branch, and a Dependabot bump that is major or cannot be classified.
2. A merged Release PR that has no tag yet holds its base: **waiting**.
3. A pull request that changes `.github/workflows/**` or
   `.github/pipeline.yaml` could rewrite the check it is judged by. It gets
   the `needs-human` label and one comment, and is left to a person:
   **needs_human**.
4. `canMerge`. Behind its base: the branch is updated once (**updated**). Not
   green: **blocked**. Green: merged, pinned to the head the verdict was made
   on, squashed or by merge commit as `mergeMethodFor` says (**merged**), and
   the merge commit's signature is read back.

Output: one JSON line per pull request, `{"number":7,"action":"merged","reason":"…"}`,
with `action` one of `merged`, `updated`, `waiting`, `skipped`, `needs_human`,
`blocked`. In a dry run the action is the one the run would have taken and the
reason starts with `dry run:`.

Exit 1: a merge commit GitHub did not verify, or an unexpected error. A
blocked, skipped or waiting pull request is not a failure.

### `bin/release.ts`

```sh
GITHUB_TOKEN=… GITHUB_REPOSITORY=acme/widgets TRAIN_CLONE=. node train/bin/release.ts [--quiet]
```

For `dev` and then `main` of a repository that has `dev`, for `main` otherwise:

1. **Cut the release a person made.** The newest merged Release PR of the
   branch (head `release/<branch>`, or `promote/main` on `main`) whose merge
   commit the branch contains and whose version has no tag is tagged
   `v<version>` at that merge commit and published as a GitHub release:
   the version's section of `CHANGELOG.md` as the body, a prerelease when the
   version is one. After a stable release on `main` of a repository that has
   `dev`, the backmerge pull request into `dev` is opened. The Release PR
   then gets the `released` label.
2. **Keep the Release PR.** `syncReleasePr` opens or refreshes the branch's
   Release PR. What the last run produced is read from GitHub
   (`src/release/previous.ts`): the open Release PR, its head commit, which
   must be verified and titled `chore(release): <version>`, and that commit's
   parent. The pull request's title and body are not trusted.

Every step looks before it writes, so a run that died is finished by the next
one: a tag without a release gets the release, a release without the label
gets the backmerge and the label, and a rerun after all of it writes nothing.
A Release PR that carries `released` is never tagged again, also when its tag
and release were deleted by hand since.

`release_as` is taken literally and goes to one branch: a prerelease version
to `dev`, a stable one to `main`; a repository with `main` alone takes either.
It is ignored once a tag at or above it exists.

Output: one JSON line per branch, `{"branch":"dev","result":"pr",…}`. `result`
is what `syncReleasePr` answered (`pr`, `nothing`, `pending`, `closed`,
`merged`, `conflict`) or why it was not asked (`refused`, `error`, `dry_run`);
`released` names the tag this run published, `backmerge` the pull request it
opened, `pr` and `version` the Release PR.

Exit 1: a promotion that conflicts with `main` (`conflict`), a tag of the
version on another commit than the merge (`error`), a Release PR merged by
`${TRAIN_APP_SLUG}[bot]` (`refused`: no tag, no release; a Release PR is
merged by a person), a backmerge that could not be opened, or an unexpected
error.

## Not here yet

`bin/fix.ts` and the remaining hand scripts follow in later pull requests.
