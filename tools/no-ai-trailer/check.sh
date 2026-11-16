#!/usr/bin/env bash
# no-ai-trailer: fail when a commit on main credits an AI tool or a bot (Co-authored-by, Assisted-by, ...).
#   check.sh <range>      commits in the git range, e.g. before..after
#   check.sh --sweep      the recent main commits of every unarchived ourostack repository, since SINCE
# GitHub copies a branch's co-author trailers into the squash commit unless the merge passes an explicit message.
set -euo pipefail

# Commits landed before the guard existed stay as they are: history is never rewritten.
SINCE=${SINCE:-2026-11-16T19:10:00Z}
AI_CREDIT='^[[:space:]]*[A-Za-z-]+-by[[:space:]]*:.*(\[bot\]|(^|[^A-Za-z0-9])(copilot|claude|anthropic|openai|chatgpt|gpt|codex|gemini|cursor|devin|aider)([^A-Za-z]|$))'
FIX='merge with an explicit message that has no such line: gh ouro-pr merge <pr>, or gh pr merge <pr> --squash --subject "<title> (#<pr>)" --body "<body without the line>". Do not rewrite main; the next merge must be clean.'

bad=0
if [ "${1:-}" = --sweep ]; then
  for repo in $(gh api --paginate orgs/ourostack/repos --jq '.[] | select(.archived == false) | .name'); do
    branch=$(gh api "repos/ourostack/$repo" --jq .default_branch)
    while read -r sha; do
      echo "::error::ourostack/$repo $branch ${sha:0:12} credits an AI tool or a bot. Fix: $FIX"; bad=1
    done < <(gh api "repos/ourostack/$repo/commits?sha=$branch&since=$SINCE&per_page=100" | jq -r --arg re "(^|\n)${AI_CREDIT#^}" '.[] | select(.commit.message | test($re; "i")) | .sha')
  done
else
  range=${1:?usage: check.sh <range> | --sweep}
  for sha in $(git rev-list "$range"); do
    if git log -1 --format=%B "$sha" | grep -qiE "$AI_CREDIT"; then
      echo "::error::commit ${sha:0:12} on main credits an AI tool or a bot: $(git log -1 --format=%s "$sha"). Fix: $FIX"; bad=1
    fi
  done
fi
exit $bad
