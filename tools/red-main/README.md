# red-main

- `red-main.mjs`: red-minutes measure and owner routing. `owners.json` maps each repository to the coordinator that owns it, and optionally to `fixers`, such as its issue drain: a red main wakes the fixers first, telling them to clear it before other work, then the owner.
- `auto-revert.mjs`: finds the pull request that turned main's ci red and reverts it (design, guards and options in the file header, opt-in list in `auto-revert.json`, tests in `auto-revert.test.mjs`). Below, [How auto-revert finds the culprit](#how-auto-revert-finds-the-culprit).

The measure reads the whole window, not just the API's newest 1,000 runs: it queries `created` ranges and halves any range that reports more than 1,000.

## API budget

Every GitHub API call counts against the repository's hourly allowance, so both tools print what they spent.

- **auto-revert** reads main's push runs newest first (one page of 50 per counted workflow, more only until each has a green run), so a green main costs 1 call (2 with `--apply`, which also lists open pull requests to land its own reverts). Once red, it reads the failed jobs of the red runs it walks back through (jobs list, each failed job's log, streamed, and annotations only for a job with no failing test), and nothing else from the API: commits, files and imports come from git. `--cache <file>` keeps each finished job's parsed failures, so a later tick reads only new logs. The run ends with `auto-revert: N API calls (R read, W write)`.
- **red-main** reads a UTC day at a time and keeps finished days (all runs completed) in a cache file (`--cache <file>`, default `~/.cache/red-main.json` or `$RED_MAIN_CACHE`, `--no-cache` to read everything). A repeat run fetches only days not yet cached plus today, today's run-list pages with `If-None-Match` (a 304 is free), and remembers each failed run's infra verdict. Today's pages use the day's fixed range, so their URL (and ETag) is the same on every run. A failure on a commit that comes while a red stretch is already open is not read for infra (it cannot open or close a stretch), so a long red costs the reads of its first commit only. Measured cold on the same 7 days for ourostack/desk: 328 calls before, 190 after; a repeat run reads only today's pages (free when unchanged). It reads `X-RateLimit-Remaining` from every response and, once fewer than 500 calls are left (`RED_MAIN_FLOOR`), stops and prints `PARTIAL`: the repos it did not cover and when the budget resets. The cache keeps what was read, so the next run continues. It prints `red-main: N API calls (M answered 304, free)` to stderr. Persist the file between runs (an Actions cache keyed on the file, or the host's disk).

## Red, waiting for runners, and where a red stretch ends

A red stretch opens at the first failing commit's failure and ends at the **push time** (its first run's start) of the first later commit whose push runs all finished with none failed. The time from that push to its last run finishing is not red: the code was fixed when it landed and the runners were queued. It is reported in its own column, `waiting for runners` (with `% wait`), beside `% red`, so neither hides the other. A wait never overlaps the next red stretch. A fix commit that fails, or is still running, does not end the stretch. Auto-revert judges red differently: by the newest completed run's verdict, not by a stretch of commits ([How auto-revert finds the culprit](#how-auto-revert-finds-the-culprit)).

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

GitHub's own transient failures (GraphQL "Something went wrong while executing your query", HTTP 502/503/504, secondary rate limits) are retried once after a pause by `tools/infra/infra.mjs`, used by pr-clock, rearm-merges and brand converge; a second failure exits with `::error title=infra::` and the GitHub request id.

**Heal first.** auto-revert reruns the failed jobs of the newest red run once (`rerun-failed-jobs`, only while `run_attempt` is 1), whatever the cause, so a flake or infra red clears itself and the newest verdict turns green. A failure that survives the rerun, or fails in two runs in a row, is confirmed.

## How auto-revert finds the culprit

A main whose runs share one concurrency group (a waiting run is replaced by the newest commit's) gets a verdict on some commits only, so one red run covers every commit since the run before it. auto-revert never judges the tip, which is nearly always still running when merges come every few minutes.

1. **Red is a verdict.** Each counted workflow (`"workflows"` in `auto-revert.json`, or every push workflow but `"ignoreWorkflows"`) is judged by its newest completed push run on main. Pending and running runs, runs replaced by concurrency and infrastructure-only failures say nothing. A run cancelled after some of its jobs failed is a red verdict for those jobs. A newer completed green run clears it.
2. **Failures.** The red run's failed jobs are read from their logs: each failing node:test (`not ok`, with its `location:` file and every repository file its failure text names), or, for a job with no failing test, the job and the files its error lines name.
3. **Range.** Each failure is followed back through the older completed runs to the newest one where it didn't fail. It began in a commit after that run, up to the first run where it failed.
4. **Attribution.** From the failing test file and the files its failure names, the code is followed through runtime imports and the repository paths it names as strings (a spawned script, a fixture), at the commit that first failed; type-only imports don't count. The squash-merged pull request in the range that changed the closest file is the culprit (a tie goes to the newest). Nothing reachable and one pull request in the range: that one. Otherwise the failure is reported, unattributed, and red-main wakes the owner. A pull request already reverted while the failure stayed is passed over, so the next closest is tried.
5. **Guards.** A culprit is skipped while unconfirmed (the rerun decides), when a commit on main since the red run names it (`main red since #N`, a revert), when a fix or revert pull request for it is open, and while main has been red under the repository's `minRedMinutes` (60 by default; Tandem's is 0: it acts on confirmation).
6. **Revert and land.** Each culprit gets its own revert (GitHub's `revertPullRequest`), so two breaks in one range are both reverted in one cycle. It turns on auto-merge where the repository allows it; on every tick it also merges its own open revert pull requests whose head checks are green (the repository's `.github/merge-checks.json` `required` list when it has one, and never with a failed check), so a revert lands like any pull request and main is green after the next ci run.

Replay any moment: `node tools/red-main/auto-revert.mjs --repo <owner/repo> --as-of <ISO time>` judges main as it stood then (runs created later unseen, runs finishing later still running) and only says what it would do. Commits and files come from `--git <clone>`, or a blobless clone of its own (in `$RUNNER_TEMP` or `~/.cache/auto-revert`), which fetches each commit's source files in one request. In Actions, git authenticates through `GIT_CONFIG_*` environment variables, never the command line.

## Opting a repository in with its own token (no cross-repo secret)

Add `.github/workflows/auto-revert.yml` to the repository:

```yaml
name: Auto-revert red main
on:
  schedule:
    - cron: "4-59/10 * * * *"
  workflow_run:
    workflows: [ci]            # your required workflow's name; cron alone can be delayed or dropped
    types: [completed]
    branches: [main]
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

The repository's Actions settings must allow workflows to create pull requests, and the repository must be able to use the public `ourostack/.github` workflow (Settings > Actions > General, for private repositories in other orgs). The workflow reads everything, check runs, `title=infra` annotations and the repository's history (a blobless git clone) included, with the caller's `GITHUB_TOKEN` (so the caller must grant `contents: read`, `checks: read`, `actions: read` and `pull-requests: read`, the last for `commits/{sha}/pulls`, without which a caller that keeps its own read-only permissions fails every run with `Resource not accessible by integration`; a fine-grained `AUTO_REVERT_TOKEN` cannot read Checks), and uses `AUTO_REVERT_TOKEN` only for the writes: revert branch, PR, auto-merge, the merge of its own green revert and the rerun. If annotations cannot be read, auto-revert treats the failure as "can't tell" and does not revert. Without the token, `GITHUB_TOKEN` does the writes too (contents, pull-requests and actions write). GitHub does not start `pull_request` workflows for a PR opened with `GITHUB_TOKEN`, so the revert PR's required checks would never report; pass a PAT or GitHub App token as the optional `AUTO_REVERT_TOKEN` secret to avoid that (or run the repository's required checks on `workflow_dispatch`/`push` too). To make auto-revert ignore a workflow whose red says nothing about the commit before it (a gate that checks only the newest commit), add its file name without `.yml` (or its workflow name) to that repository's `"ignoreWorkflows"` list in `auto-revert.json`; its runs are not read, so they neither start nor extend a red stretch. The list applies to caller workflows too (`--self` reads the repository's row), so a caller adds nothing to its own file. Add `"enabled": false` rows to `auto-revert.json` only for repositories the central cron should cover.

### teams-microsoft/tandem

1. Add the caller file above as `.github/workflows/auto-revert.yml`.
2. Settings > Actions > General > Workflow permissions: tick "Allow GitHub Actions to create and approve pull requests".
3. Create the `AUTO_REVERT_TOKEN` secret (a token with contents and pull-requests write) so the revert PR's checks run. Without it the revert PR needs its checks started by hand.
4. Dry run first: set `apply: false` through a `with:` block, or `workflow_dispatch` and read the summary; then leave it on.
