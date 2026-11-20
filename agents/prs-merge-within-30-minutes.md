# Every PR merges fast: 30 minutes is a goal, never a deadline

Shared guidance for every agent and person working in ourostack, spoonjoy and arimendelow repositories. Each repository's AGENTS.md points here.

**A pull request open for more than 30 minutes is a problem.** Ari, 2026-11-07: "if any PR is open for more than 30 mins, it's a problem :) ... i don't like these backups in ourostack".

**30 minutes is a goal, never a deadline.** It is arbitrary. Every PR should be ready before it is opened and merge on green within minutes, and CI runs as fast as possible, with sub-minute checks wherever we can. Ari, 2026-11-10: "that 'within 30 minutes' thing - it's an arbitrary target, 'the pursuit of excellence requires no justification' :) generally, everything should be as svelte and fast as possibel! gave 30 mins cuz there were all these PRs sitting around for days at a time and i needed to push you agents." The clock exists to stop PRs sitting open for days. It never justifies discarding or abandoning work: a late PR gets finished and landed (the table below), not closed to beat the clock. On trunk-based work, the fix is a smaller PR next time. An open PR holds finished work away from main, goes stale against everyone else's changes, and turns into a pile of conflicts and reruns that someone has to untangle later. Small PRs that land fast keep main the one true picture of the work.

Merging is only part of the clock: the change must also be live for users within [single-digit minutes at most, and seconds wherever we can build it](changes-live-in-seconds.md).

## The flow: done first, then publish, and green means merged

Ari, 2026-11-07: "can we have auto merge on pass by default? and we keep it safe by having agents only publish prs once it passes all the reviews and non-ci validation etc".

1. **Finish the work on your branch.** Run the independent review, the taste review, the device run and anything else CI doesn't do, locally, before the PR exists. Fix what they find.
2. **Publish with auto-merge already on:** `gh ouro-pr` (below). Never open a draft to park work, and never open a PR you expect to change after review.
3. **Green means merged.** Nobody, human or agent, has a step after that. If CI finds something, fix it on the branch; auto-merge stays on.

### `gh ouro-pr`: the one command

Install it once on any machine:

```sh
gh alias set --clobber ouro-pr '!f=$(mktemp) && gh api -H "Accept: application/vnd.github.raw" repos/ourostack/.github/contents/tools/ouro-pr/ouro-pr.sh >"$f" && bash "$f" "$@"'
```

Then, from a finished branch, run `gh ouro-pr`. It pushes the branch (never with force), opens the PR with a title and body taken from the commits (or your `--title` and `--body-file`), and turns on auto-merge, which joins the merge queue where the repository has one. Pass `--dry-run` to see what it would do. Before you open a branch for an issue, [claim it](claim-before-building.md) with `gh ouro-pr claim <n>`: `gh ouro-pr` refuses a pull request for an issue another session has claimed, and a probe (a `probe/` branch or `--probe`) is labelled `probe` and never merged. It always runs the latest [`tools/ouro-pr/ouro-pr.sh`](../tools/ouro-pr/ouro-pr.sh) from this repository's main, so a change merged to that file runs on every agent's machine at its next publish: review it like any shared tool. A copy run from a clone runs main's too: it fetches main's copy first, and runs itself only when GitHub cannot be reached, with a warning that says how old it is. In a repository with no required checks, GitHub's auto-merge merges at once, before any check runs, so there `gh ouro-pr` waits for the PR's own checks and merges only if they all pass. Give every active repository at least one required check, so green means merged without anyone waiting.

Put a `Desk-Task: <track>/<task>` line in a commit body or the PR body: the PR clock uses it to name the owner.

Some repositories (ouro-ui, spoonjoy-v2) check the PR's title and body for unsourced claims, and the body `gh ouro-pr` builds from commit messages can trip them (a number, an "every", even a `Desk-Task` path). There, write the body yourself and pass `--body-file`; keep a `Desk-Task` line in it, or in the latest commit's message, which is the one the clock reads. In a repository whose `package.json` has a `claims:lint` script (ouro-ui), `gh ouro-pr` runs that lint on the title and body before it pushes or opens anything, and stops with the lint's findings when it fails, so open new pull requests there with `gh ouro-pr`, not a bare `gh pr create`.

Private repositories on a free plan have no auto-merge. There `gh ouro-pr` says so, and you merge the PR yourself the moment it is green.

## Question every check that isn't in CI

Ari, 2026-11-07: "for all non ci validation, always question whether it can be made deterministic / put in ci etc ... keep things easy for agents :)". Every step you do by hand before publishing (a taste review, a run on a device, a screenshot compared by eye) costs every future change. For each one, ask: can a deterministic check do this, in CI? If yes, move it there. If not yet, file an issue in that repository saying what it would take, so the next agent doesn't have to rediscover it.

## When a PR passes 30 minutes

The [PR clock](#the-pr-clock) names every late PR and what is holding it. Whoever owns the PR, or whoever sees it first if the owner is gone, does one of these, now:

| What's holding it | Do this |
| --- | --- |
| 🟢 Green, but not merged | Merge it. Then ask why auto-merge wasn't on, and use `gh ouro-pr` next time. |
| 🔴 A red check | Find the cause and fix it on the branch. If it is a known flaky test, re-run it once and say so on the PR. If the cause is unclear, ask for help in one line with the run link. Never bypass a required check. |
| 🟡 Checks running for a long time, or waiting for a runner | The CI is too slow or the runners are too few for this rule. Note it on that repository's CI-speed issue; don't wait silently. |
| 🟠 Behind or conflicting with its base | Rebase or merge the base into it (never force-push a shared branch; push a fresh branch if you must rewrite), then let auto-merge carry it. |
| 🟣 In the merge queue for a long time | The queue is the bottleneck: look at the queue's checks, and at the repository's CI-speed issue. |
| 🔵 Waiting for a required review, or 🙋 waiting on Ari | Ask the reviewer it waits on, in one line with the PR link, where they read. A PR should rarely be here: decisions belong before publishing. |
| ⚪ A draft, or anything that isn't going anywhere | Finish it and publish it, then ask for help. Never close it or discard its work because of the clock. |

Draining someone else's late PR is fine when its owner is gone; read the PR and its linked task first, and don't push into a branch another agent is still working on: comment instead.

## The PR clock

A scheduled workflow here ([`.github/workflows/pr-clock.yml`](../.github/workflows/pr-clock.yml), every 10 minutes) keeps one pinned issue current: **PRs past 30 minutes**. One line per late PR: how long it has been open, what is holding it (worked out from its checks and merge state), its likely owner, and ⏸️ if it was published without auto-merge. When nothing is late, it says **All clear**. The issue title carries the count, so the pinned card reads at a glance. Age counts from when the PR was opened, so a draft marked ready after a day is already late: don't park work in drafts.

It also lists every **red main**: a repository whose default branch is red at its latest commit, with how long that commit has stood, its red checks and its likely owner (the commit's `Desk-Task` line, or the owner the repository's AGENTS.md names under CI). A red main holds every PR behind it, so it shows above the late PRs, its count goes in the title, and the issue never says All clear while one stands. Like late PRs, a private repository's red main is counted, never named. The clock reads repositories with open issues or PRs, so a repository with neither isn't checked.

Run it locally with `GH_TOKEN=$(gh auth token) node tools/pr-clock/pr-clock.mjs`. Tests: `node --test tools/pr-clock/pr-clock.test.mjs`.

It reads with the workflow's own token, which sees every public repository (today, every repository with PRs). Setting the `PR_CLOCK_APP_CLIENT_ID` variable and `PR_CLOCK_APP_PRIVATE_KEY` secret for a read-only GitHub App installed on `arimendelow` would let it count late PRs in arimendelow's private repositories too; this issue is public, so it counts them without naming them.

## Prior art

| Tool | What it does | Verdict |
| --- | --- | --- |
| [actions/stale](https://github.com/actions/stale) | Labels and closes PRs inactive for days | Ignore: day-scale, and it closes instead of diagnosing. |
| [github/issue-metrics](https://github.com/github/issue-metrics) | Writes time-to-first-response and time-to-close for a search into an issue | Borrow the idea of an issue as the dashboard; watch it for the CI-speed audit. It reports history, not what is blocking a PR now. |
| [Kestra stale-PR alert blueprint](https://kestra.io/blueprints/github-stale-pull-request-alert) | Lists open PRs past an idle SLA | Borrow the SLA framing. Needs Kestra, and doesn't read checks or merge state. |
| [babbel/stale-pr-reporter](https://github.com/babbel/stale-pr-reporter) | Posts stale Dependabot and Renovate PRs to Slack | Ignore: bots only, Slack only. |
| GitHub merge queue and auto-merge | Merges when green | Adopt: every repository has auto-merge on, and `gh ouro-pr` turns it on per PR. |

None of them reads a PR's checks and merge state to say *why* it is stuck at a 30-minute scale across three owners, so the clock is our own small script.

## Merge with an explicit message

Cloud sessions' commit signer forces a `Co-authored-by: copilot-swe-agent[bot]` trailer onto branch commits, and GitHub's squash merge copies it onto `main` (the repository's squash-message setting does not stop that). Our rule is no AI attribution on `main`, so every merge passes its own message: `gh ouro-pr` and `gh ouro-pr merge <pr>` use `--subject "<title> (#n)"` and `--body` with AI and bot credit lines removed, as does Desk's merge-when-green relay. The [no-ai-trailer guard](../.github/workflows/no-ai-trailer.yml) fails `main`, and its sweep every ten minutes covers every repository.

### The one correct merge command

Since 2026-11-17 an organization ruleset ("No AI co-author credit", `commit_message_pattern`, negated `(?i)co-authored-by:[^\n]*(\[bot\]|copilot)`) rejects any commit on a default branch whose message has such a line. GitHub's default squash message, and the default message of auto-merge, append the branch commits' co-author lines, so a PR from a cloud lane shows BLOCKED with every check green and nothing failing. The fix is always the same: pass the message yourself.

```
gh pr merge <pr> --auto --squash --subject "<PR title> (#<pr>)" --body "<PR body without Co-authored-by / Assisted-by lines>"
```

Never run `gh pr merge --auto` or `gh pr merge --squash` without `--subject` and `--body`, never use the web button, never set `--admin`, and never merge with a direct API call (`gh api -X PUT repos/<repo>/pulls/<pr>/merge`): an admin account passes the required checks that way, which is how a red change reached `desk` main on 2026-11-17. Repository admins no longer bypass any default-branch ruleset; the one bypass left is the `desk` and `flow-review` release deploy key, which pushes the release commit. The ruleset stays as it is. [`rearm-merges`](../.github/workflows/rearm-merges.yml) runs every 10 minutes, finds open PRs whose auto-merge uses the default message and turns it on again with a clean one (`node tools/rearm-merges/rearm-merges.mjs --dry-run` shows what it would do; `--merge-ready` also merges green PRs with no auto-merge). Tests: `node --test tools/rearm-merges/rearm-merges.test.mjs`. It needs the `REARM_MERGES_TOKEN` secret, a token with pull-request write access to every ourostack repository.

Two more guards keep main green without anyone awake. **Stale base:** a ruleset that requires branches to be up to date makes every required check run on the tree the PR merges into, and `rearm-merges` updates armed PRs that fall behind (the merge queue does not fit: it cannot carry the explicit message above; see [`rulesets/`](../rulesets/README.md)). **Red main:** [`auto-revert`](../.github/workflows/auto-revert.yml) judges main by its newest completed run, not its tip, traces each failure back to the range of commits that introduced it, and opens a revert PR with auto-merge for the pull request closest to it once the failure reproduces (a rerun, or two runs in a row) and is not infrastructure, with no fix landed or open (after an hour of red, or at once where `minRedMinutes` is 0); it wakes the owner, and repositories opt in in `tools/red-main/auto-revert.json` ([how it finds the culprit](../tools/red-main/README.md#how-auto-revert-finds-the-culprit)).

### Cloud lanes: the clean merge command

A Copilot cloud lane (and anything else that merges without `gh ouro-pr`) must not use the default message, the web button or a bare `gh pr merge`. Merge with:

```
gh pr merge <pr> --auto --squash --subject "<PR title> (#<pr>)" --body "<PR body without Co-authored-by / Assisted-by lines>"
```

Never a direct PUT to the merge endpoint. The branch commits keep the trailer the signer forces; only the squash message must be clean.

### Layers that keep the trailer off `main`

1. **Organization ruleset** (owner action, needs the plan to support metadata restrictions): a commit-message pattern on default branches that rejects `Co-authored-by: .*\[bot\]` and Copilot trailers. A GitHub App or personal token without organization administration cannot create it, so check `gh api orgs/ourostack/rulesets` first.
2. **PR check**: the [no-ai-trailer-pr](../.github/workflows/no-ai-trailer-pr.yml) reusable workflow fails a PR whose title or body carries a credit and warns when its commits do. Require it by ruleset.
3. **Push guard and sweep**: [no-ai-trailer](../.github/workflows/no-ai-trailer.yml) fails `main` on any new offender.
4. **Acknowledged history**: `main` is never rewritten, so offenders that landed before a layer existed are listed in [`tools/no-ai-trailer/acknowledged.txt`](../tools/no-ai-trailer/acknowledged.txt) (full SHA, repository, credit, reason, fix PR). The sweep skips exactly those SHAs; anything else is red. Never ack a new offender to get green: merge clean instead. Tests: `bash tools/no-ai-trailer/test/run.sh`.
