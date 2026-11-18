# red-main

- `red-main.mjs`: red-minutes measure and owner routing.
- `auto-revert.mjs`: reverts the one squash-merged PR behind a main that has stayed red for 60 minutes (guards and opt-in list in the file header and `auto-revert.json`; tests in `auto-revert.test.mjs`).

The measure reads the whole window, not just the API's newest 1,000 runs: it queries `created` ranges and halves any range that reports more than 1,000.

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

Only a job that fails counts; emit it only for causes outside the code under test. A commit that has any non-infra failure is still red. A run whose only failures show GitHub 5xx (`POST /graphql: 504`, `502 Bad Gateway`) or `ETIMEDOUT` in the job log is classed infra without any annotation.

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
jobs:
  auto-revert:
    uses: ourostack/.github/.github/workflows/auto-revert-reusable.yml@main
    secrets:
      token: ${{ secrets.AUTO_REVERT_TOKEN }}   # optional, see below
```

The repository's Actions settings must allow workflows to create pull requests, and the repository must be able to use the public `ourostack/.github` workflow (Settings > Actions > General, for private repositories in other orgs). The workflow uses the caller's `GITHUB_TOKEN` (contents, pull-requests and actions write, the last for the rerun of the failed jobs). GitHub does not start `pull_request` workflows for a PR opened with `GITHUB_TOKEN`, so the revert PR's required checks would never report; pass a PAT or GitHub App token as the optional `AUTO_REVERT_TOKEN` secret to avoid that (or run the repository's required checks on `workflow_dispatch`/`push` too). Add `"enabled": false` rows to `auto-revert.json` only for repositories the central cron should cover.

### teams-microsoft/tandem

1. Add the caller file above as `.github/workflows/auto-revert.yml`.
2. Settings > Actions > General > Workflow permissions: tick "Allow GitHub Actions to create and approve pull requests".
3. Create the `AUTO_REVERT_TOKEN` secret (a token with contents and pull-requests write) so the revert PR's checks run. Without it the revert PR needs its checks started by hand.
4. Dry run first: set `apply: false` through a `with:` block, or `workflow_dispatch` and read the summary; then leave it on.
