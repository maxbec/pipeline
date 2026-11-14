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

## Fix

`bin/fix.ts` and `src/fix/` are the Fix: what the train does when
`pipeline / Check` fails on a pull request. Three subcommands, one per job of
`train.yaml`:

```
fix.ts triage    src/fix/triage.ts, steps.ts   nothing, a rerun, a proposal, or giving up
fix.ts collect   src/fix/collect.ts            what Claude Code changed in the tree, and its diagnosis
fix.ts commit    src/fix/commit.ts, guard.ts   the guard, then one signed commit or a comment
```

`triage.ts` decides from the run and the pull request as GitHub reports them;
`prompt.ts` builds the prompt around the failed job's log, fenced as untrusted
data; `guard.ts` is the allowlist a proposed change has to pass. `collect`
runs next to a tree the pull request controls and executes nothing from it;
`commit` holds the token that writes and never has that tree. The tests in
`test/fix/` run against `fix-world.ts`, the fake GitHub plus runs, jobs, logs,
comments and labels.

## Fleet tool

`bin/migrate-repos.ts` brings every repository to the shape the pipeline
expects, pinned to one commit of `maxbec/pipeline`. It is run by hand from a
clone of this repository, never in Actions.

```sh
npm ci                                             # once: the config conversion needs the `yaml` package
node train/bin/migrate-repos.ts                    # dry run: the plan per repository, nothing written
node train/bin/migrate-repos.ts --only acme/widgets --apply
```

What it needs:

- **Local clones.** It never clones. It works on every git clone it finds
  under `<home>/companies/<company>/repos/<repo>` whose `origin` is on
  github.com (a clone named `docs` is skipped), and reads each tree from
  `origin/<branch>` after a fetch. A repository with `origin/dev` is major and
  gets its pull request into `dev`; any other gets it into `main`.
- **A clone of this repository with its tags**, for the pin and the two
  templates. By default the one the tool runs from.
- **The `gh` CLI, logged in.** Every GitHub call uses its token.

Per repository, in one signed commit (`createCommitOnBranch`) on the branch
`chore/slim-pipeline` and one pull request into the base branch:

- `.github/workflows/ci.yaml` from `examples/caller.yaml` and
  `.github/workflows/train.yaml` from `examples/train-caller.yaml`, both at the
  same pin: the sha on the `uses:` line, the tag in a comment above it, no
  line over 120 characters.
- `.github/pipeline.yaml` in version 3, the files of earlier release tooling
  deleted, and the pipeline section of `AGENTS.md` / `CLAUDE.md` rewritten
  where the file has one.

Beside the commit it normalizes the merge settings and the default branch,
sets the required status context to `pipeline / Check` in the repository's own
branch protection and rulesets, and closes the pull requests and branches of
the old release bots. A rerun finishes what an earlier run left: it merges the
pull request once `canMerge` says so (squash, pinned to the head it judged),
updates it once when it is behind, and does nothing when the files already
match. `maxbec/pipeline` itself and archived repositories are skipped.

| Option | |
|---|---|
| `--apply` | write; without it the tool prints the plan and changes nothing |
| `--only <owner/name>` | this repository only; repeatable |
| `--pipeline-ref <tag-or-sha>` | the pin; default is the newest stable `vX.Y.Z` tag. A prerelease tag (`v5.5.0-beta.1`) is a tagged pin and is rendered with its version |
| `--allow-untagged` | let `--apply` pin a commit that carries no version tag; refused otherwise |
| `--overrides <file.json>` | the fleet's deviations (below); default none |
| `--train-schedule keep\|drop\|auto` | the schedule block of the Train caller. `auto` (default) asks `GET /users/{owner}`: dropped for a user account, whose repositories a central sweep covers, kept for an organization |
| `--no-train` | leave `.github/workflows/train.yaml` alone: neither written nor removed |
| `--remove-train` | delete `.github/workflows/train.yaml` where it exists |
| `--home <dir>` | where `companies/` lives; default the user's home directory |
| `--company <name>` | look only in `companies/<name>/repos`; repeatable; default every directory under `companies/` |
| `--pipeline-clone <dir>` | the pipeline clone to read the pin and templates from; default the checkout the tool runs from |

Exit 0 when every repository was planned or applied, 1 when one failed, 2 for
a wrong command line, an unknown ref or an untagged pin on `--apply`.

A pin whose commit has no `examples/train-caller.yaml` cannot carry a Train
caller: the tool says so and leaves `train.yaml` alone.

### The overrides file

Deviations name repositories, so they are not in this repository. They live
in a JSON file with whoever runs the tool; every key is optional, an unknown
key is refused.

```json
{
  "repositories": {
    "acme/widgets": {
      "secrets": { "NPM_TOKEN": "${{ secrets.ACME_NPM_TOKEN }}" },
      "renderHook": true,
      "extraFiles": { ".github/workflows/extra.yaml": "---\nname: Extra\n" }
    }
  },
  "legacyPaths": ["^\\.oldtool/"],
  "singleQuoteTrunkPlugins": ["acme-trunk-plugin"]
}
```

| Key | |
|---|---|
| `repositories.<owner/name>.secrets` | a secret the Pipeline caller forwards, taken from a differently named repository secret; the name must be one the template forwards |
| `repositories.<owner/name>.renderHook` | sets `deploy.render.hook: true` in `.github/pipeline.yaml` |
| `repositories.<owner/name>.extraFiles` | path to contents, written beside the callers. A YAML file must start with `---`. A difference that is only a moved action pin is not written back |
| `legacyPaths` | regular expressions over repository paths, deleted in addition to the built-in list |
| `singleQuoteTrunkPlugins` | a `.trunk/trunk.yaml` that mentions one of these gets `.github/pipeline.yaml` single-quoted, for a plugin whose prettier config asks for that |

### Moving one repository to a beta pin

```sh
git fetch --tags
node train/bin/migrate-repos.ts --only acme/widgets --pipeline-ref v5.5.0-beta.1          # look
node train/bin/migrate-repos.ts --only acme/widgets --pipeline-ref v5.5.0-beta.1 --apply  # commit and pull request
node train/bin/migrate-repos.ts --only acme/widgets --pipeline-ref v5.5.0-beta.1 --apply  # again, once Check is green: merge
```

### Rolling back

A caller pinned to a commit that has no `.github/workflows/train.yaml` dies
with `startup_failure`, so going back to a pin from before the train takes the
Train caller out in the same commit that moves `ci.yaml` back:

```sh
node train/bin/migrate-repos.ts --only acme/widgets --pipeline-ref v5.4.2 --remove-train --apply
```
