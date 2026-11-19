# branch-prune

Deletes a repository's stale remote branches once a day, so the branch list stays the work in progress.

- `prune.mjs`: the rule (`screen`, `recentPushReason`, `decide`) and the CLI that lists the branches and their pull requests, deletes what the rule picks, and prints the counts. Node built-ins only.
- `test/`: `run.sh` runs `prune.test.mjs`, which covers each rule, the arguments and the CLI against a fake `gh`.
- `../../.github/workflows/branch-prune-reusable.yml`: the reusable workflow every repository calls. `branch-prune-test.yml` runs the tests on a pull request that touches this folder or the reusable workflow.

## The rule

A branch is deleted only when one of these holds, and never when one of the keep rules applies. The first rule that matches decides, and its reason is printed.

**Kept, always:**

- the default branch;
- a protected branch, or one a ruleset forbids deleting;
- a release or system branch: `release/…`, `releases/…`, `hotfix…`, a version tag such as `v1.3.0`, the merge queue's `gh-readonly-queue/…`, and `gh-pages`. A name that only starts like one, such as `released-notes`, is an ordinary branch;
- a branch with an open pull request, from it or into it. Deleting the base of an open pull request would close that pull request;
- a branch pushed to in the last `min-age-days` days (3 by default). Its last push counts, or the commit date of its tip when no push is recorded. A branch with neither time is kept.

**Deleted:**

- (a) a branch fully merged into the default branch, with no commits the default branch lacks;
- (b) a branch whose most recent pull request was closed unmerged at least `min-age-days` days ago, and whose tip is still that pull request's head;
- (c) a branch whose most recent pull request was merged at least `min-age-days` days ago, and whose tip is still that pull request's head. A squash or rebase merge leaves the branch's own commits outside the default branch, so it isn't fully merged, but nothing on it is left to merge.

Only pull requests from this repository count. A pull request from a fork does not protect or condemn a branch.

Everything else is kept, with the reason: for example `PR #12 merged, branch changed since`, `PR #12 closed unmerged, branch changed since`, or `no PR, not merged`.

Each delete is checked just before it happens. If the branch's tip has moved, or an open pull request has appeared for it, the branch is skipped and the log says so.

## Adopting it

Copy this to `.github/workflows/branch-prune.yml`:

```yaml
name: Branch prune
on:
  schedule:
    - cron: "17 7 * * *"
  workflow_dispatch:
    inputs:
      dry-run:
        description: "List what would be deleted and delete nothing."
        type: boolean
        default: false
permissions:
  contents: read
concurrency:
  group: branch-prune
  cancel-in-progress: false
jobs:
  prune:
    uses: ourostack/.github/.github/workflows/branch-prune-reusable.yml@main
    permissions:
      contents: write
      pull-requests: read
    with:
      dry-run: ${{ inputs.dry-run || false }}
      min-age-days: 3
```

It runs daily at 07:17 UTC and by hand. The caller grants `contents: write`, which deleting a branch needs, and `pull-requests: read`, which the rule reads. The reusable workflow checks out `ourostack/.github` at `main` for the CLI, with the checkout SHA the other reusable workflows pin, and sets up Node 24 with `actions/setup-node` v7.1.0 and no cache.

## Dry run and output

Run it by hand with `workflow_dispatch` and `dry-run` set to see what it would delete. The output is also written to the job summary. An example, with made-up names and counts:

```text
owner/name: default branch main
before: 7 branches
would delete 2 branches:
would delete merged-old: fully merged into main
would delete fix/abandoned: PR #8 closed unmerged 4 days ago, unchanged since
kept 5:
  default branch: 1
  open PR: 1
  pushed inside the window: 1
  protected: 1
  no PR, not merged: 1
dry run: nothing deleted
would leave: 5 branches
```

A real run prints the same lines as `deleting`, `deleted`, `already gone` or `skipped`, then `after: N branches`, so the before and after counts sit side by side in the summary.

Exit codes: a delete that fails with anything other than a missing branch (a 404, or a 422, which GitHub sends for a reference that no longer exists, so another run deleted it first) exits 1, and so does a run that cannot read the branches or the pull requests, since nothing can then be decided.

To try it by hand from a checkout, with a token that can read the branches and pull requests:

```sh
GH_TOKEN=<token> REPO=owner/name node tools/branch-prune/prune.mjs --dry-run [--min-age-days 3]
```

Drop `--dry-run` to delete. The CLI reads `REPO` and `GH_TOKEN` from the environment and needs `gh` on the path.
