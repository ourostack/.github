# Cancel orphaned merge-group runs

A reformed merge queue leaves the old groups' `merge_group` runs going, and they hold runners the live groups wait
for. `.github/workflows/orphan-runs-reusable.yml` cancels the calling repository's runs whose group commit is not a
current queue entry, with that repository's own `GITHUB_TOKEN` (`actions: write`), so no personal token is needed.

Add this to any repository that has a merge queue, as `.github/workflows/orphan-runs.yml`:

```yaml
name: Cancel orphaned merge-group runs
on:
  schedule:
    - cron: "*/10 * * * *"
  merge_group:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  cancel:
    permissions:
      actions: write
      contents: read
    uses: ourostack/.github/.github/workflows/orphan-runs-reusable.yml@main
```

Test: `node --test tools/orphan-runs/cancel.test.mjs`.
