#!/usr/bin/env bash
# Require every ruleset's status checks to run on an up-to-date branch ("Require branches to be up to date before
# merging"), so a PR can only merge after its required checks passed on the tree it will actually merge into. That is
# what closes the stale-base red: PRs that were green against an old base and broke the merged tree.
#
#   rulesets/require-up-to-date.sh ourostack/desk ourostack/ouro-ui     # show what would change (default)
#   rulesets/require-up-to-date.sh --apply teams-microsoft/tandem       # set strict_required_status_checks_policy: true
#
# Needs a token that can read and edit repository rulesets (repository Administration: write). Idempotent: a ruleset
# already strict is left alone, and a rule that is not required_status_checks is never touched. The rearm-merges job
# updates armed PRs that fall behind, so nothing waits on a person.
#
# Why not the merge queue (rulesets/README.md): it ignores the explicit squash message our "No AI co-author credit"
# ruleset needs, and requires merge_group triggers in every workflow.
set -euo pipefail

apply=0
[ "${1:-}" = "--apply" ] && { apply=1; shift; }
[ "$#" -gt 0 ] || { echo "usage: $0 [--apply] owner/repo..." >&2; exit 2; }

for repo in "$@"; do
  ids=$(gh api "repos/$repo/rulesets" --jq '.[] | select(.target=="branch") | .id')
  [ -n "$ids" ] || { echo "$repo: no branch rulesets"; continue; }
  for id in $ids; do
    rs=$(gh api "repos/$repo/rulesets/$id")
    source_type=$(jq -r '.source_type' <<<"$rs")
    if [ "$source_type" != "Repository" ]; then
      echo "$repo ruleset $id ($(jq -r .name <<<"$rs")): defined at $source_type level, edit it there"
      continue
    fi
    if ! jq -e '.rules[] | select(.type=="required_status_checks")' >/dev/null <<<"$rs"; then
      continue
    fi
    if jq -e '.rules[] | select(.type=="required_status_checks") | .parameters.strict_required_status_checks_policy == true' >/dev/null <<<"$rs"; then
      echo "$repo ruleset $id: already requires up-to-date branches"
      continue
    fi
    body=$(jq '{name, target, enforcement, conditions, bypass_actors, rules: [.rules[] | if .type=="required_status_checks" then .parameters.strict_required_status_checks_policy = true else . end]}' <<<"$rs")
    if [ "$apply" = 1 ]; then
      gh api -X PUT "repos/$repo/rulesets/$id" --input - <<<"$body" >/dev/null
      echo "$repo ruleset $id: now requires up-to-date branches"
    else
      echo "$repo ruleset $id: would require up-to-date branches (pass --apply)"
    fi
  done
done
