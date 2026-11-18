# Rulesets

## Stale-base merges: require up-to-date branches, not a merge queue

A PR that was green against an old base can break the merged tree (Tandem: about 96 minutes of red a week). Two native fixes exist:

- **Merge queue** (`merge_queue` rule). Not used: the queue builds its own squash commit, so the explicit `--subject`/`--body` that [the one correct merge command](../agents/prs-merge-within-30-minutes.md#the-one-correct-merge-command) passes to dodge the "No AI co-author credit" ruleset cannot be carried through it, and it needs a `merge_group` trigger added to every workflow that reports a required check (a queue waits forever on a check that never runs). It also runs every check a second time before each merge. Merge queue could not be enabled from this sandbox either: the token cannot create or edit rulesets.
- **Require branches to be up to date** (`strict_required_status_checks_policy: true` on the `required_status_checks` rule). Used: no workflow changes, `gh pr merge --auto --squash --subject --body` works as before, and the checks that gate the merge ran on the tree the PR merges into. [`rearm-merges`](../tools/rearm-merges/rearm-merges.mjs) updates the branch of an armed PR that falls behind, so CI reruns on the new base and auto-merge carries on without anyone.

[`require-up-to-date.sh`](require-up-to-date.sh) sets it, repo by repo, and prints what it would change unless given `--apply`. It needs a token with repository Administration write (the sandbox token has none, so a repository admin runs it):

```sh
rulesets/require-up-to-date.sh --apply ourostack/desk ourostack/shepherd ourostack/housesitter ourostack/hackamore ourostack/.github ourostack/ouro-ui ourostack/ouroboros-website
```

`ourostack/ouroboros` has no required checks, so there is nothing to make strict.

### teams-microsoft/tandem

1. In Tandem's `main` ruleset (Settings > Rules > Rulesets), on **Require status checks to pass** tick **Require branches to be up to date before merging**. Or run `rulesets/require-up-to-date.sh --apply teams-microsoft/tandem` with an admin token. (If the rule is a classic branch protection rule, the same box is "Require branches to be up to date before merging".)
2. Give the `rearm-merges` token (`REARM_MERGES_TOKEN`) access to the repository (pull requests write), and add `teams-microsoft` as an org to the job's scope, so behind PRs are updated automatically. Until then a behind PR needs "Update branch".
3. Keep Tandem's whole-tree inventory tests among the required checks: with up-to-date branches they run on the merged tree.

## Auto-revert of red main

See [`tools/red-main/README.md`](../tools/red-main/README.md): ourostack repos run from the central cron, any other repository (Tandem) opts in with a short caller workflow that uses its own token, so no cross-repo secret is needed.
