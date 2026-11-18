# red-main

- `red-main.mjs`: red-minutes measure and owner routing.
- `auto-revert.mjs`: reverts the one squash-merged PR behind a main that has stayed red for 60 minutes (guards and opt-in list in the file header and `auto-revert.json`; tests in `auto-revert.test.mjs`).

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
