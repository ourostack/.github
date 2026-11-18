# Claim an issue before you build it

Shared guidance for every agent and person working in this organization's repositories. Each repository's AGENTS.md points here.

Two sessions that build the same fix at once waste both of them, and the pull request that loses is closed unmerged. A claim, made before any branch exists, tells every other session that the issue has an owner.

## The rule

1. **Check for a claim first.** Before you open a branch for an issue, read its assignee and its comments. If another session holds a claim, don't build the same fix in parallel: coordinate with that session on the issue, or wait for it to release the claim.
2. **Claim before you branch.** From a clone of the repository, run `gh ouro-pr claim <issue>`. It assigns your gh user to the issue and comments `Claimed by <session>: building this now.`, followed by a hidden marker that `gh ouro-pr` reads. Your session's name is `OURO_SESSION`, or `--as <name>` for one run.
3. **Release when you stop.** If you stop without finishing, run `gh ouro-pr release <issue>`. It comments `Released by <session>.` with its own marker and leaves the assignee alone. Only the session that holds a claim can release it. A claim stands until that session releases it, or until it lapses after two hours with no activity.

## What `gh ouro-pr` refuses

Before it pushes anything, `gh ouro-pr` reads the issues the pull request is for: those its body closes, fixes or resolves, and those it refs or relates to, all in the same repository. For each one that is open and carries another session's live claim, it stops and publishes nothing:

```
ouro-pr: #<issue> is claimed by <session> since <claimed at> (<comment url>). Coordinate with that session, have it run gh ouro-pr release <issue>, or take the issue over with --take-over "<reason>".
ouro-pr: nothing was pushed or opened.
```

With no session name set, it refuses the same way and asks for `OURO_SESSION` or `--as`. A claim your own session holds passes. A claim on a closed issue is not checked, and an issue that cannot be read is said so and skipped: a failed read never blocks a publish.

A claim lapses when nothing has happened on it for two hours. Something has happened if the claimant's account has commented on the issue since the claim (a later claim, a status comment, anything), or if a PR that references the issue has been pushed to since (its head commit's date). A lapsed claim no longer refuses; `gh ouro-pr` says so in one line and goes on:

```
ouro-pr: the claim on #<issue> by <session> lapsed (no activity since <last activity>).
```

Its session can still release a lapsed claim, and `gh ouro-pr claim` replaces it.

## Taking an issue over

When a live claim is stale in practice but has not lapsed, or its session has gone quiet on purpose, take it over with a reason:

```sh
gh ouro-pr --take-over "<reason>"           # when publishing the PR
gh ouro-pr claim <issue> --take-over "<reason>"
```

The reason is required, and so is a session name. The issue gets a comment, `Taken over by <session> from <claimant>: <reason>`, with the marker for the new session, so the issue is now claimed by the session that took it over. Then publishing goes on. A dry run only prints the comment.

Use it deliberately: the comment is the record that the claimant was overridden, and the reason is what the claimant reads when it comes back.

## One writer per issue

When another open PR already closes an issue this PR closes, `gh ouro-pr` still opens this PR. It turns the closing keyword into `Relates to #<issue>` in its body, so the issue closes once, by the other PR, and prints that PR's link so the two sessions can coordinate or close one.

## Probes

A probe is a pull request opened only to read one CI result, such as a runner's behaviour or a workflow change, and never meant to merge. Name its branch `probe/<topic>`, or pass `--probe`. Then `gh ouro-pr`:

- labels the pull request `probe`, creating the label first if the repository lacks it;
- turns no auto-merge on, because a probe is never merged;
- skips the claim check, because a probe builds nothing.

Close a probe once you have read its result. The label keeps probes counted apart from abandoned work, so a probe is never a sign of a pull request someone gave up on.

## Where it lives

The checks are in [`tools/ouro-pr/ouro-pr.sh`](../tools/ouro-pr/ouro-pr.sh), with tests in [`tools/ouro-pr/test/run.sh`](../tools/ouro-pr/test/run.sh) (`bash tools/ouro-pr/test/run.sh`). The publishing rules are in [every PR merges fast](prs-merge-within-30-minutes.md).
