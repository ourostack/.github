# red-main

- `red-main.mjs`: red-minutes measure and owner routing.
- `auto-revert.mjs`: reverts the one squash-merged PR behind a main that has stayed red for 60 minutes (guards and opt-in list in the file header and `auto-revert.json`; tests in `auto-revert.test.mjs`).

The measure reads the whole window, not just the API's newest 1,000 runs: it queries `created` ranges and halves any range that reports more than 1,000.

## Red, waiting for runners, and where a red stretch ends

A red stretch opens at the first failing commit's failure and ends at the **push time** (its first run's start) of the first later commit whose push runs all finished with none failed. The time from that push to its last run finishing is not red: the code was fixed when it landed and the runners were queued. It is reported in its own column, `waiting for runners` (with `% wait`), beside `% red`, so neither hides the other. A wait never overlaps the next red stretch. A fix commit that fails, or is still running, does not end the stretch. Auto-revert's "red for 60 minutes" uses the same red definition (the wait column never counts toward it).

## Infrastructure failures: `title=infra`

A failed job that is not the code's fault says so with one line. red-main then counts it in the `infra` column, apart from code red: it opens no red episode, wakes no owner, and `auto-revert.mjs` never reverts it. Emit it from the failing step (GitHub turns the workflow command into a check-run annotation titled `infra`):

```
::error title=infra::<reason>
```

Shell step:

```yaml
- run: |
    if ! ./provision-runner.sh; then
      echo "::error title=infra::runner pool exhausted"
      exit 1
    fi
```

Node script (stdout of a step):

```js
console.log("::error title=infra::device farm unreachable");
process.exit(1);
```

Only a job that fails counts; emit it only for causes outside the code under test. A commit that has any non-infra failure is still red. A runner that is lost cannot annotate its own job, so red-main classes these as infra itself, in both `red-main.mjs` and `auto-revert.mjs`: run conclusion `startup_failure`; a run `cancelled` with no newer push of the same workflow (a concurrency cancel by a newer push is not a failure at all; a user's cancel leaves no trace in the API, so it is treated as infra too); a failed job that ran no steps or was assigned no runner; and log or annotation text such as `The runner has received a shutdown signal`, `lost communication with the server`, `The job was not acquired by Runner`, `The operation was canceled`. A run whose only failures show GitHub 5xx (`POST /graphql: 504`, `502 Bad Gateway`) or `ETIMEDOUT` in the job log is classed infra without any annotation.

## Opting a repository in with its own token (no cross-repo secret)

Add `.github/workflows/auto-revert.yml` to the repository:

```yaml
name: Auto-revert red main
on:
  schedule:
    - cron: "4-59/10 * * * *"
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  actions: write
  checks: read
jobs:
  auto-revert:
    uses: ourostack/.github/.github/workflows/auto-revert-reusable.yml@main
    secrets:
      token: ${{ secrets.AUTO_REVERT_TOKEN }}   # optional, see below
```

The repository's Actions settings must allow workflows to create pull requests, and the repository must be able to use the public `ourostack/.github` workflow (Settings > Actions > General, for private repositories in other orgs). The workflow reads everything, check runs and `title=infra` annotations included, with the caller's `GITHUB_TOKEN` (so the caller must grant `checks: read`; a fine-grained `AUTO_REVERT_TOKEN` cannot read Checks), and uses `AUTO_REVERT_TOKEN` only for the writes: revert branch, PR, auto-merge and the rerun. If annotations cannot be read, auto-revert treats the failure as "can't tell" and does not revert. Without the token, `GITHUB_TOKEN` does the writes too (contents, pull-requests and actions write). GitHub does not start `pull_request` workflows for a PR opened with `GITHUB_TOKEN`, so the revert PR's required checks would never report; pass a PAT or GitHub App token as the optional `AUTO_REVERT_TOKEN` secret to avoid that (or run the repository's required checks on `workflow_dispatch`/`push` too). Add `"enabled": false` rows to `auto-revert.json` only for repositories the central cron should cover.

### teams-microsoft/tandem

1. Add the caller file above as `.github/workflows/auto-revert.yml`.
2. Settings > Actions > General > Workflow permissions: tick "Allow GitHub Actions to create and approve pull requests".
3. Create the `AUTO_REVERT_TOKEN` secret (a token with contents and pull-requests write) so the revert PR's checks run. Without it the revert PR needs its checks started by hand.
4. Dry run first: set `apply: false` through a `with:` block, or `workflow_dispatch` and read the summary; then leave it on.
