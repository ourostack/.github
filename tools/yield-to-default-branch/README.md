# Yield to the default branch

Pull-request bursts across the org can starve default-branch CI of runners (the org shares about 150 concurrent jobs).
`.github/workflows/yield-to-default-branch.yml` is one cheap Linux job. Before a pull request's fan-out starts it checks
the busy repositories (default: ouroboros, ouro-ui, desk, .github, ouroboros-website, plus the caller's own) for a job of a
default-branch push, `merge_group` or `release` run that has been queued without a runner for 30 seconds or more. While
there is one it waits, polling once a minute, for at most 20 minutes. It never skips or fails: any API error, 403 or 429
proceeds at once, and what it waited for goes in the step summary. Only jobs in the caller's runner pool count (`YIELD_RUNNER`, default `ubuntu-latest`; ubuntu and linux labels are one pool, macOS and Windows are others), because the pools have separate caps and waiting on another pool gains nothing.

Adopt it on pull requests only, so default-branch and merge-queue runs never wait, and make the fan-out `needs` it:

```yaml
jobs:
  yield:
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
      actions: read
    uses: ourostack/.github/.github/workflows/yield-to-default-branch.yml@main
  shards:
    needs: [yield]
    # a skipped `yield` (push, merge_group) must not skip the shards
    if: ${{ !cancelled() && (needs.yield.result == 'success' || needs.yield.result == 'skipped') }}
```

Test: `node --test tools/yield-to-default-branch/yield.test.mjs`.
