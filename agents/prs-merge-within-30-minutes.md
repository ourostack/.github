# Every PR merges within 30 minutes

Shared guidance for every agent and person working in ourostack, spoonjoy and arimendelow repositories. Each repository's AGENTS.md points here.

**A pull request open for more than 30 minutes is a problem.** Ari, 2026-11-07: "if any PR is open for more than 30 mins, it's a problem :) ... i don't like these backups in ourostack". An open PR holds finished work away from main, goes stale against everyone else's changes, and turns into a pile of conflicts and reruns that someone has to untangle later. Small PRs that land fast keep main the one true picture of the work.

## The flow: done first, then publish, and green means merged

Ari, 2026-11-07: "can we have auto merge on pass by default? and we keep it safe by having agents only publish prs once it passes all the reviews and non-ci validation etc".

1. **Finish the work on your branch.** Run the independent review, the taste review, the device run and anything else CI doesn't do, locally, before the PR exists. Fix what they find.
2. **Publish with auto-merge already on:** `gh ouro-pr` (below). Never open a draft to park work, and never open a PR you expect to change after review.
3. **Green means merged.** Nobody, human or agent, has a step after that. If CI finds something, fix it on the branch; auto-merge stays on.

### `gh ouro-pr`: the one command

Install it once on any machine:

```sh
gh alias set --clobber ouro-pr '!gh api -H "Accept: application/vnd.github.raw" repos/ourostack/.github/contents/tools/ouro-pr/ouro-pr.sh | bash -s --'
```

Then, from a finished branch, run `gh ouro-pr`. It pushes the branch (never with force), opens the PR with a title and body taken from the commits (or your `--title` and `--body-file`), and turns on auto-merge, which joins the merge queue where the repository has one. Pass `--dry-run` to see what it would do. It always runs the latest [`tools/ouro-pr/ouro-pr.sh`](../tools/ouro-pr/ouro-pr.sh) from this repository.

Put a `Desk-Task: <track>/<task>` line in a commit body or the PR body: the PR clock uses it to name the owner.

Private repositories on a free plan have no auto-merge. There `gh ouro-pr` says so, and you merge the PR yourself the moment it is green.

## Question every check that isn't in CI

Ari, 2026-11-07: "for all non ci validation, always question whether it can be made deterministic / put in ci etc ... keep things easy for agents :)". Every step you do by hand before publishing (a taste review, a run on a device, a screenshot compared by eye) costs every future change. For each one, ask: can a deterministic check do this, in CI? If yes, move it there. If not yet, file an issue in that repository saying what it would take, so the next agent doesn't have to rediscover it.

## When a PR passes 30 minutes

The [PR clock](#the-pr-clock) names every late PR and what is holding it. Whoever owns the PR, or whoever sees it first if the owner is gone, does one of these, now:

| What's holding it | Do this |
| --- | --- |
| 🟢 Green, but not merged | Merge it. Then ask why auto-merge wasn't on, and use `gh ouro-pr` next time. |
| 🔴 A red check | Fix the cause on the branch. If it looks random (a flake, a runner hiccup), **file an issue first** with the run link and failure, then rerun. Never rerun a failure nobody has written down, and never bypass a required check. |
| 🟡 Checks running for a long time, or waiting for a runner | The CI is too slow or the runners are too few for this rule. Note it on that repository's CI-speed issue; don't wait silently. |
| 🟠 Behind or conflicting with its base | Rebase or merge the base into it (never force-push a shared branch; push a fresh branch if you must rewrite), then let auto-merge carry it. |
| 🟣 In the merge queue for a long time | The queue is the bottleneck: look at the queue's checks, and at the repository's CI-speed issue. |
| 🔵 Waiting for a required review, or 🙋 waiting on Ari | Only Ari can unblock it: say so in one line, in the conversation he reads, with the PR link. A PR should rarely be here; decisions belong before publishing. |
| ⚪ A draft, or anything that isn't going anywhere | Finish it and publish properly, or close it with a one-line reason (what replaced it, or why it stopped). A closed PR with a reason is fine; a forgotten open one is not. |

Draining someone else's late PR is fine when its owner is gone; read the PR and its linked task first, and don't push into a branch another agent is still working on: comment instead.

## The PR clock

A scheduled workflow here ([`.github/workflows/pr-clock.yml`](../.github/workflows/pr-clock.yml), every 10 minutes) keeps one pinned issue current: **PRs past 30 minutes**. One line per late PR: how long it has been open, what is holding it (worked out from its checks and merge state), its likely owner, and ⏸️ if it was published without auto-merge. When nothing is late, it says **All clear**. The issue title carries the count, so the pinned card reads at a glance.

Run it locally with `GH_TOKEN=$(gh auth token) node tools/pr-clock/pr-clock.mjs`. Tests: `node --test tools/pr-clock/pr-clock.test.mjs`.

It reads with the workflow's own token, which sees every public repository (today, every repository with PRs). Setting the `PR_CLOCK_APP_ID` variable and `PR_CLOCK_APP_PRIVATE_KEY` secret for a read-only GitHub App installed on `arimendelow` would let it see private repositories too.

## Prior art

| Tool | What it does | Verdict |
| --- | --- | --- |
| [actions/stale](https://github.com/actions/stale) | Labels and closes PRs inactive for days | Ignore: day-scale, and it closes instead of diagnosing. |
| [github/issue-metrics](https://github.com/github/issue-metrics) | Writes time-to-first-response and time-to-close for a search into an issue | Borrow the idea of an issue as the dashboard; watch it for the CI-speed audit. It reports history, not what is blocking a PR now. |
| [Kestra stale-PR alert blueprint](https://kestra.io/blueprints/github-stale-pull-request-alert) | Lists open PRs past an idle SLA | Borrow the SLA framing. Needs Kestra, and doesn't read checks or merge state. |
| [babbel/stale-pr-reporter](https://github.com/babbel/stale-pr-reporter) | Posts stale Dependabot and Renovate PRs to Slack | Ignore: bots only, Slack only. |
| GitHub merge queue and auto-merge | Merges when green | Adopt: every repository has auto-merge on, and `gh ouro-pr` turns it on per PR. |

None of them reads a PR's checks and merge state to say *why* it is stuck at a 30-minute scale across three owners, so the clock is our own small script.
