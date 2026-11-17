#!/usr/bin/env bash
# The per-repository copy of the no-AI-credit ruleset: every unarchived, non-fork ourostack repository (forks take
# upstream commits we don't author). Needs repo admin only, so it works without admin:org. Idempotent.
#   apply-repo-rulesets.sh            create it where missing
#   apply-repo-rulesets.sh --remove   delete those copies (once the org ruleset exists)
set -euo pipefail
dir=$(dirname "${BASH_SOURCE[0]}")
for repo in $(gh api --paginate orgs/ourostack/repos --jq '.[] | select(.archived == false and .fork == false) | .name'); do
  id=$(gh api "repos/ourostack/$repo/rulesets" --jq '.[] | select(.name == "no-ai-credit-trailer" and .source_type == "Repository") | .id' | head -1)
  if [ "${1:-}" = --remove ]; then
    [ -z "$id" ] || { gh api -X DELETE "repos/ourostack/$repo/rulesets/$id"; echo "$repo: removed"; }
  elif [ -n "$id" ]; then gh api -X PUT "repos/ourostack/$repo/rulesets/$id" --input "$dir/ruleset-repo.json" --silent; echo "$repo: updated"
  else gh api -X POST "repos/ourostack/$repo/rulesets" --input "$dir/ruleset-repo.json" --silent; echo "$repo: created"; fi
done
