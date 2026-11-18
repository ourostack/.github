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
# Run from a clone (bash <clone>/tools/ouro-pr/ouro-pr.sh [flags]), it runs main's copy all the same: it fetches it
# first and runs the local copy only when GitHub cannot be reached, with a warning that says how old that copy is.
# Merge a PR opened some other way, with the same message rules:   gh ouro-pr merge <number-or-url>
#
# One writer per issue: when another open PR already closes an issue this one closes (Fixes #n), it still opens this PR,
# turns the keyword into "Relates to #n" in its body, and prints the other PR's link to coordinate or close one.
#
# Every merge it asks for carries an explicit message: "<PR title> (#n)" and the PR body with any AI or bot
# credit line (Co-authored-by, Assisted-by, ...) removed. Without one GitHub copies the branch commits' co-author
# trailers onto main, and a cloud session's commit signer forces the AI trailer onto those commits.
#
# It pushes the branch (never with force), opens the PR, and turns on auto-merge, which joins the
# merge queue where the repository has one. Where GitHub offers no auto-merge (private repositories
# on a free plan) it says so: merge it yourself the moment it is green.
# The rule it serves: https://github.com/ourostack/.github/blob/main/agents/prs-merge-within-30-minutes.md
set -euo pipefail

# A copy saved in a clone never updates, and an old one keeps old rules: one without the claims lint opened pull
# requests whose text failed ouro-ui's Claims check. So every run starts main's copy, which the alias already
# fetched; this one fetches it (15 seconds at most) and runs it in its place unless the two are the same.
run_main_copy() {
  [ -z "${OURO_PR_MAIN:-}" ] || return 0
  local self=${BASH_SOURCE[0]} latest err pid watcher status
  latest=$(mktemp "${TMPDIR:-/tmp}/ouro-pr-main.XXXXXX")
  err=$(mktemp "${TMPDIR:-/tmp}/ouro-pr-err.XXXXXX")
  gh api -H "Accept: application/vnd.github.raw" repos/ourostack/.github/contents/tools/ouro-pr/ouro-pr.sh >"$latest" 2>"$err" &
  pid=$!
  (sleep 15 && kill "$pid" 2>/dev/null) &
  watcher=$!
  status=0
  wait "$pid" || status=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  if [ "$status" -eq 0 ] && head -n 1 "$latest" | grep -q '^#!/usr/bin/env bash'; then
    rm -f "$err"
    if cmp -s "$latest" "$self"; then
      rm -f "$latest"
      return 0
    fi
    OURO_PR_MAIN=1 exec bash "$latest" "$@"
  fi
  local modified days why
  modified=$(stat -c %Y "$self" 2>/dev/null || stat -f %m "$self" 2>/dev/null || echo "")
  days=$([ -n "$modified" ] && echo "$(( ($(date +%s) - modified) / 86400 )) days" || echo "an unknown time")
  why=$(head -n 1 "$err" 2>/dev/null)
  rm -f "$latest" "$err"
  {
    echo "ouro-pr: ================================================================"
    echo "ouro-pr: WARNING: could not fetch main's copy of ouro-pr (${why:-no answer in 15 seconds})."
    echo "ouro-pr: Running the local copy at $self instead, last changed $days ago."
    echo "ouro-pr: It may lack rules main has, such as the claims lint. Rerun once GitHub answers."
    echo "ouro-pr: ================================================================"
  } >&2
}

run_main_copy "$@"

main() {
title="" body_file="" base="" dry=0 merge_pr=""
extra=()
if [ "${1:-}" = merge ]; then
  [ $# -ge 2 ] || { echo "ouro-pr: merge needs a pull request number or URL" >&2; exit 2; }
  merge_pr=$2; shift 2
fi
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

# The message a merge lands with: "<title> (#n)" and the body without AI or bot credit lines.
AI_CREDIT='^[[:space:]]*[A-Za-z-]+-by[[:space:]]*:.*(\[bot\]|(^|[^A-Za-z0-9])(copilot|claude|anthropic|openai|chatgpt|gpt|codex|gemini|cursor|devin|aider)([^A-Za-z]|$))'
merge_message() {
  local pr=$1
  if msg_subject=$(gh pr view "$pr" --json number,title --jq '"\(.title) (#\(.number))"' 2>/dev/null); then
    msg_body=$(gh pr view "$pr" --json body --jq .body)
  else
    msg_subject="$title"
    msg_body=$(cat "$body_file")
  fi
  msg_body=$(printf '%s\n' "$msg_body" | tr -d '\r' | grep -v -i -E "$AI_CREDIT" | cat -s || true)
}
# gh pr merge <flags> <pr> with that message.
merge_with_message() {
  local pr=${*: -1} flags=("${@:1:$#-1}")
  merge_message "$pr"
  run gh pr merge "${flags[@]}" --subject "$msg_subject" --body "$msg_body" "$pr"
}

# `merge <pr>`: merge a pull request opened some other way, with the same message rules.
if [ "${merge_pr:-}" ]; then
  pr_repo=$(gh pr view "$merge_pr" --json url --jq '.url | capture("github.com/(?<r>[^/]+/[^/]+)/pull").r')
  method=$(gh api "repos/$pr_repo" --jq 'if .allow_squash_merge then "--squash" elif .allow_merge_commit then "--merge" else "--rebase" end')
  if err=$(merge_with_message --auto "$method" "$merge_pr" 2>&1); then
    say "auto-merge on: it merges itself when its checks pass."
  elif printf '%s' "$err" | grep -qiE "(clean|unstable) status"; then
    merge_with_message "$method" --delete-branch "$merge_pr"
  else
    say "could not merge: $err"
    exit 1
  fi
  exit 0
fi

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

url=$(gh pr view "$branch" --json url,state --jq 'select(.state == "OPEN") | .url' 2>/dev/null || true)

# One writer per issue: a second session opening a PR that closes an issue another open PR already closes makes a
# duplicate that is later closed by hand. Nothing is blocked: this PR still opens, but says "Relates to #n" instead of
# a closing keyword, and the other PR's link is printed so the two sessions can coordinate.
if [ -z "$url" ]; then
  closing='(close[sd]?|fix(e[sd])?|resolve[sd]?) +#[0-9]+'
  issues=$({ cat "$body_file"; git log --format=%B "$range"; } | grep -o -i -E "$closing" | grep -o -E '[0-9]+' | sort -un || true)
  if [ -n "$issues" ]; then
    open_prs=$(gh pr list --state open --limit 100 --json number,url,headRefName,body 2>/dev/null || echo '[]')
    for n in $issues; do
      other=$(printf '%s' "$open_prs" | jq -r --arg b "$branch" --arg n "$n" '[.[] | select(.headRefName != $b) | select((.body // "") | test("(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?) +#" + $n + "([^0-9]|$)"))] | first | .url // empty')
      if [ -n "$other" ]; then
        say "$other is already open and closes #$n. This PR opens with \"Relates to #$n\" so the issue closes once, by that one. Coordinate with its writer or close one of the two."
        relaxed=$(mktemp "${TMPDIR:-/tmp}/ouro-pr-body.XXXXXX")
        sed -E "s/(close[sd]?|fix(e[sd])?|resolve[sd]?) +#$n([^0-9]|\$)/Relates to #$n\3/Ig" "$body_file" >"$relaxed"
        body_file=$relaxed
      fi
    done
  fi
fi

# A repository whose package.json has a claims:lint script (ouro-ui) runs that lint on a pull
# request's title and body in CI. Run it here first, before anything is pushed, so a new PR never
# opens with text its Claims check fails.
top=$(git rev-parse --show-toplevel)
case $body_file in /*) ;; *) body_file="$PWD/$body_file" ;; esac
if [ -z "$url" ] && [ -f "$top/package.json" ] && (cd "$top" && node -e 'process.exit(require("./package.json").scripts?.["claims:lint"] ? 0 : 1)') 2>/dev/null; then
  if [ -f "$top/pnpm-lock.yaml" ]; then lint=(pnpm -s claims:lint --pr --title "$title" --body-file "$body_file"); else lint=(npm run -s claims:lint -- --pr --title "$title" --body-file "$body_file"); fi
  if ! (cd "$top" && "${lint[@]}"); then
    say "the claims lint fails this title or body; nothing was pushed or opened. Fix the text (--title, --body-file) and rerun."
    exit 1
  fi
fi

# Push without force. A rejected push means the remote moved: rebase or merge, then rerun.
if ! git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null || [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ]; then
  run git push --quiet -u origin "HEAD:refs/heads/$branch"
fi

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
# A failed call counts as 0, the safe direction: wait for the checks rather than merge at once.
a=$(gh api "repos/$name/branches/$base" --jq '(.protection.required_status_checks.contexts // []) | length' 2>/dev/null) || a=0
b=$(gh api "repos/$name/rules/branches/$base" --jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks | length] | add // 0' 2>/dev/null) || b=0
case $a in ''|*[!0-9]*) a=0 ;; esac
case $b in ''|*[!0-9]*) b=0 ;; esac
required=$((a + b))

if [ "$auto" != true ]; then
  say "GitHub offers no auto-merge in $name (private repository on a free plan)."
  say "Merge it the moment it is green: gh ouro-pr merge $url"
  echo "$url"
  exit 0
fi
if [ "$queue" = true ]; then
  run gh pr merge --auto "$url"
  say "auto-merge on: it joins the merge queue when its checks pass."
else
  # Without required checks, auto-merge would merge at once (or GitHub refuses it with "clean" or
  # "unstable status"). Then wait for whatever checks the PR does run, and merge only if they pass.
  if [ "$dry" = 1 ]; then
    if [ "$required" -gt 0 ]; then merge_with_message --auto "$method" "$url"; else say "no required checks: would wait for the PR's own checks, then merge"; fi
  elif [ "$required" -gt 0 ] && err=$(merge_with_message --auto "$method" "$url" 2>&1); then
    say "auto-merge on: it merges itself when its checks pass."
  elif [ "$required" -gt 0 ] && ! printf '%s' "$err" | grep -qiE "(clean|unstable) status"; then
    say "could not turn on auto-merge: $err"
    echo "$url"
    exit 1
  else
    say "auto-merge can't wait on anything here: waiting for this PR's own checks, then merging."
    # Give Actions up to a minute to register the PR's checks before deciding it has none.
    for _ in 1 2 3 4 5 6; do
      sleep 10
      gh pr checks "$url" 2>&1 | grep -q "no checks reported" || break
    done
    if gh pr checks "$url" --watch --fail-fast --interval 20 >&2; then
      merge_with_message "$method" --delete-branch "$url"
    elif gh pr checks "$url" 2>&1 | grep -q "no checks reported"; then
      merge_with_message "$method" --delete-branch "$url"
    else
      n=$(gh pr view "$url" --json statusCheckRollup --jq '[.statusCheckRollup[] | select(.conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "CANCELLED" or .conclusion == "STARTUP_FAILURE" or .conclusion == "ACTION_REQUIRED" or .state == "FAILURE" or .state == "ERROR")] | length' 2>/dev/null) || n=
      case $n in
        ''|*[!0-9]*|0) ;;
        *) say "a check failed: fix it, push, and rerun gh ouro-pr. Not merged."; echo "$url"; exit 1 ;;
      esac
      # The watch itself stopped (a network or sign-in hiccup), not a check.
      say "lost track of the checks before they finished. Not merged: rerun gh ouro-pr to keep waiting."
      echo "$url"
      exit 1
    fi
  fi
fi
echo "$url"
}

# Read the whole script before running any of it.
main "$@"
