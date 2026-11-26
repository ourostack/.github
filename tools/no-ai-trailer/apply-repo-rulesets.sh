#!/usr/bin/env bash
# The per-repository copy of the no-AI-credit ruleset: every unarchived, non-fork ourostack repository (forks take
# upstream commits we don't author). Needs repo admin only, so it works without admin:org. Idempotent.
#   apply-repo-rulesets.sh            create it where missing (skipped where the org ruleset already applies)
#   apply-repo-rulesets.sh --remove   delete those copies (once the org ruleset exists)
# Repositories with a merge queue also get no-ai-credit-trailer-on-push (ruleset-queue-push.json), which refuses
# the push itself: a queue lands branch commits (or their squash credit) on the default branch, so a credited
# commit there can never merge and would only fail at the front of the queue. --remove leaves it in place.
set -euo pipefail
dir=$(dirname "${BASH_SOURCE[0]}")
for repo in $(gh api --paginate orgs/ourostack/repos --jq '.[] | select(.archived == false and .fork == false) | .name'); do
  id=$(gh api "repos/ourostack/$repo/rulesets" --jq '.[] | select(.name == "no-ai-credit-trailer" and .source_type == "Repository") | .id' | head -1)
  org=$(gh api "repos/ourostack/$repo/rulesets" --jq '.[] | select(.name == "no-ai-credit-trailer" and .source_type == "Organization") | .id' | head -1)
  if [ "${1:-}" = --remove ]; then
    [ -z "$id" ] || { gh api -X DELETE "repos/ourostack/$repo/rulesets/$id"; echo "$repo: removed"; }
  elif [ -n "$org" ]; then :  # the org ruleset already covers the default branch
  elif [ -n "$id" ]; then gh api -X PUT "repos/ourostack/$repo/rulesets/$id" --input "$dir/ruleset-repo.json" --silent; echo "$repo: updated"
  else gh api -X POST "repos/ourostack/$repo/rulesets" --input "$dir/ruleset-repo.json" --silent; echo "$repo: created"; fi
  [ "${1:-}" = --remove ] && continue
  queue=$(gh api graphql -f query="{repository(owner:\"ourostack\",name:\"$repo\"){mergeQueue{id}}}" --jq '.data.repository.mergeQueue.id // empty')
  [ -n "$queue" ] || continue
  pid=$(gh api "repos/ourostack/$repo/rulesets" --jq '.[] | select(.name == "no-ai-credit-trailer-on-push") | .id' | head -1)
  if [ -n "$pid" ]; then gh api -X PUT "repos/ourostack/$repo/rulesets/$pid" --input "$dir/ruleset-queue-push.json" --silent; echo "$repo: push rule updated"
  else gh api -X POST "repos/ourostack/$repo/rulesets" --input "$dir/ruleset-queue-push.json" --silent; echo "$repo: push rule created"; fi
done
