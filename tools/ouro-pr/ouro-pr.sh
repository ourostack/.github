#!/usr/bin/env bash
# ouro-pr: publish the current branch as a pull request that merges itself when green.
#
# Install once (always runs the latest version from ourostack/.github main):
#   gh alias set --clobber ouro-pr '!f=$(mktemp) && gh api -H "Accept: application/vnd.github.raw" repos/ourostack/.github/contents/tools/ouro-pr/ouro-pr.sh >"$f" && bash "$f" "$@"'
# Then, from a finished, reviewed, locally validated branch:
#   gh ouro-pr                       # title and body from the commits
#   gh ouro-pr --title "..." --body-file notes.md --base main
#   gh ouro-pr --dry-run             # print what it would do
#
# It pushes the branch (never with force), opens the PR, and turns on auto-merge, which joins the
# merge queue where the repository has one. Where GitHub offers no auto-merge (private repositories
# on a free plan) it says so: merge it yourself the moment it is green.
# The rule it serves: https://github.com/ourostack/.github/blob/main/agents/prs-merge-within-30-minutes.md
set -euo pipefail

main() {
title="" body_file="" base="" dry=0
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --title|-t|--body-file|-F|--base|-B)
      [ $# -ge 2 ] || { echo "ouro-pr: $1 needs a value" >&2; exit 2; }
      case "$1" in --title|-t) title="$2" ;; --body-file|-F) body_file="$2" ;; *) base="$2" ;; esac
      shift 2 ;;
    --dry-run) dry=1; shift ;;
    --draft|-d) echo "ouro-pr: no drafts. Publish when the work is done and has passed every review and local check." >&2; exit 2 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null || true; echo "Usage: gh ouro-pr [--title T] [--body-file F] [--base B] [--dry-run] [gh pr create flags]"; exit 0 ;;
    *) extra+=("$1"); shift ;;
  esac
done

say() { printf 'ouro-pr: %s\n' "$*" >&2; }
run() { if [ "$dry" = 1 ]; then printf '[dry-run]' >&2; printf ' %q' "$@" >&2; echo >&2; else "$@"; fi; }

branch=$(git symbolic-ref --short HEAD 2>/dev/null) || { say "not on a branch"; exit 2; }
repo=$(gh repo view "$(git remote get-url origin)" --json nameWithOwner,defaultBranchRef --jq '.nameWithOwner + " " + .defaultBranchRef.name')
name=${repo%% *}
[ -n "$base" ] || base=${repo##* }
[ "$branch" != "$base" ] || { say "you are on $base; make a branch first"; exit 2; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then say "uncommitted changes; commit them first"; exit 2; fi

git fetch --quiet origin "$base"
range="origin/$base..HEAD"
count=$(git rev-list --count "$range")
[ "$count" -gt 0 ] || { say "no commits ahead of origin/$base"; exit 2; }

# Title: the only commit's subject, or the oldest commit's subject for a stack.
[ -n "$title" ] || title=$(git log --format=%s "$range" | tail -n 1)

if [ -z "$body_file" ]; then
  body_file=$(mktemp "${TMPDIR:-/tmp}/ouro-pr-body.XXXXXX")
  {
    if [ "$count" = 1 ]; then
      git log -1 --format=%b HEAD | grep -v -i -E '^(Co-Authored-By|Signed-off-by):' || true
    else
      git log --reverse --format='- %s' "$range"
      # Keep the owner line the PR clock reads.
      task=$(git log --format=%b "$range" | grep -m 1 -E '^Desk-Task:' || true)
      [ -z "$task" ] || printf '\n%s\n' "$task"
    fi
  } >"$body_file"
  # Never publish an empty body: GitHub shows "No description provided", which helps no one.
  [ -s "$body_file" ] && grep -q '[^[:space:]]' "$body_file" || echo "$title." >"$body_file"
fi

# Push without force. A rejected push means the remote moved: rebase or merge, then rerun.
if ! git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null || [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ]; then
  run git push --quiet -u origin "HEAD:refs/heads/$branch"
fi

url=$(gh pr view "$branch" --json url,state --jq 'select(.state == "OPEN") | .url' 2>/dev/null || true)
if [ -z "$url" ]; then
  if [ "$dry" = 1 ]; then
    run gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$body_file" "${extra[@]+"${extra[@]}"}"
    say "body would be:"; cat "$body_file" >&2
    url="(new PR)"
  else
    url=$(gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$body_file" "${extra[@]+"${extra[@]}"}")
  fi
else
  say "PR already open: $url"
fi

# How this repository merges: a merge queue decides its own method; otherwise prefer squash.
# shellcheck disable=SC2016 # GraphQL variables, not shell ones
info=$(gh api graphql -f owner="${name%%/*}" -f repo="${name##*/}" -f base="$base" -f query='
query($owner:String!,$repo:String!,$base:String!){repository(owner:$owner,name:$repo){
  autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed mergeQueue(branch:$base){id}}}' \
  --jq '.data.repository | [(.autoMergeAllowed|tostring), (.mergeQueue != null|tostring), (if .squashMergeAllowed then "--squash" elif .mergeCommitAllowed then "--merge" else "--rebase" end)] | join(" ")')
read -r auto queue method <<<"$info"

# Required checks on the base branch, from branch protection and rulesets. With none, GitHub's
# auto-merge merges at once, before any check has run, so wait for the PR's checks instead.
required=$(( $(gh api "repos/$name/branches/$base" --jq '(.protection.required_status_checks.contexts // []) | length' 2>/dev/null || echo 0) \
  + $(gh api "repos/$name/rules/branches/$base" --jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks | length] | add // 0' 2>/dev/null || echo 0) ))

if [ "$auto" != true ]; then
  say "GitHub offers no auto-merge in $name (private repository on a free plan)."
  say "Merge it the moment it is green: gh pr merge $method --delete-branch $url"
  echo "$url"
  exit 0
fi
if [ "$queue" = true ]; then
  run gh pr merge --auto "$url"
  say "auto-merge on: it joins the merge queue when its checks pass."
else
  # A repository with no required checks has nothing for auto-merge to wait on, and GitHub refuses
  # it ("clean status"). Then wait for whatever checks the PR does run, and merge only if they pass.
  if [ "$dry" = 1 ]; then
    if [ "$required" -gt 0 ]; then run gh pr merge --auto "$method" "$url"; else say "no required checks: would wait for the PR's own checks, then merge"; fi
  elif [ "$required" -gt 0 ] && err=$(gh pr merge --auto "$method" "$url" 2>&1); then
    say "auto-merge on: it merges itself when its checks pass."
  elif [ "$required" -gt 0 ] && ! printf '%s' "$err" | grep -qiE "(clean|unstable) status"; then
    say "could not turn on auto-merge: $err"
    echo "$url"
    exit 1
  else
    say "no required checks here: waiting for this PR's own checks, then merging."
    # Give Actions up to a minute to register the PR's checks before deciding it has none.
    for _ in 1 2 3 4 5 6; do
      sleep 10
      gh pr checks "$url" 2>&1 | grep -q "no checks reported" || break
    done
    if gh pr checks "$url" --watch --fail-fast --interval 20 >&2; then
      gh pr merge "$method" --delete-branch "$url"
    elif gh pr checks "$url" 2>&1 | grep -q "no checks reported"; then
      gh pr merge "$method" --delete-branch "$url"
    else
      say "a check failed: fix it, push, and rerun gh ouro-pr. Not merged."
      echo "$url"
      exit 1
    fi
  fi
fi
echo "$url"
}

# Read the whole script before running any of it.
main "$@"
