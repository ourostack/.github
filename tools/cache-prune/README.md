# cache-prune

Keeps a repository's Actions cache well under GitHub's 10 GB limit, so entries stop evicting each other.

- `prune.mjs`: the rule (`familyOf`, `toDelete`) and the CLI that lists the caches, deletes what the rule picks, and prints the totals. Node built-ins only.
- `test/`: `run.sh` runs `prune.test.mjs`, which covers the families, the skips, the default branch rule and the CLI against a fake `gh`.
- `../../.github/workflows/cache-prune-reusable.yml`: the reusable workflow every repository calls. `cache-prune-test.yml` runs the tests on a pull request that touches this folder or the reusable workflow.

## The rule

- A **family** is a cache key with its trailing content hashes removed: a trailing `-<16 or more hex>` segment, repeatedly, then one trailing `-<digits>` run number. `node-cache-Linux-x64-npm-<hash>` and `install-npm-ouro-nova-<hash>` are the families `node-cache-Linux-x64-npm` and `install-npm-ouro-nova`. A key with no hash is its own family, so only exact duplicates collapse.
- A cache from a ref other than the default branch is deleted. A pull request's and a merge queue's entries are leftovers, since the default branch is what the workflows restore.
- On the default branch, each family keeps its newest entry (by `created_at`) and the rest are deleted.
- **Skipped, never deleted:** Docker BuildKit's GitHub Actions cache (keys `buildkit-blob-…` and `index-…#<n>`). Its blobs are content-addressed and shared between images, so deleting one by family would break a build that restores it. A caller adds more prefixes with the `skip-prefixes` input, e.g. `stryker-`.
- Tiny caches are not ignored: a cache under 1 MB is treated like any other.

## Adopting it

Copy this to `.github/workflows/cache-prune.yml`, and replace `main` with the repository's default branch and `CI` with the name of its main CI workflow:

```yaml
name: Cache prune
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
  schedule:
    - cron: "37 * * * *"
  workflow_dispatch:
    inputs:
      dry-run:
        description: "List what would be deleted and delete nothing."
        type: boolean
        default: false
permissions:
  contents: read
  actions: write
concurrency:
  group: cache-prune
  cancel-in-progress: false
jobs:
  prune:
    uses: ourostack/.github/.github/workflows/cache-prune-reusable.yml@main
    with:
      skip-prefixes: ""        # e.g. "stryker-"
      dry-run: ${{ inputs.dry-run || false }}
```

It runs after the repository's main CI (`workflow_run`, completed, on the default branch), hourly, and by hand. The caller grants `actions: write`, which the reusable job needs to delete caches; the job itself asks for nothing more. The reusable workflow checks out `ourostack/.github` at `main` for the CLI, with the checkout SHA the other reusable workflows pin, and sets up Node 24 with `actions/setup-node` v7.1.0 and no cache.

## Dry run and output

`workflow_dispatch` with `dry-run` set lists the deletions by family, with count and size, and deletes nothing. A real run prints the totals before, each deletion, and the totals after. The run's output is also written to the job summary.

Exit codes: a delete that fails with anything other than a 404 (another run deleted it first) exits 1, and so does a run that cannot read the caches or the default branch, since nothing can then be decided.

To try it by hand from a checkout, with a token that can read Actions:

```sh
GH_TOKEN=<token> REPO=owner/name node tools/cache-prune/prune.mjs --dry-run [--skip <prefix>]
```
