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
# Claim an issue before you build it, so two sessions never build the same fix:
#   gh ouro-pr claim <issue> [--as name]                  # assigns you to it and says so on the issue
#   gh ouro-pr claim <issue> --take-over "<reason>"       # takes a live claim over, with the reason on the issue
#   gh ouro-pr release <issue> [--as name]                # says you have stopped; the assignee stays
# Your session's name is $OURO_SESSION, or --as. A claim stands until its session releases it, or until it lapses: no sign
# of life for claim_lapse_seconds (two hours). A sign of life is a comment by the claimant's account after the claim, or a
# push since then to an open PR that references the issue. Opening a PR for an open issue with a live claim by another
# session is refused before anything is pushed; --take-over "<reason>" takes that claim over and proceeds. A lapsed claim
# is said, and passed. OURO_PR_NOW (epoch seconds) replaces the clock; the tests use it.
# A probe, opened only to read a CI result, is a branch named probe/... or --probe: it gets the probe label and no
# auto-merge, and is never merged.
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

# Print and run: say writes to stderr, and run only prints its command under --dry-run.
say() { printf 'ouro-pr: %s\n' "$*" >&2; }
run() { if [ "$dry" = 1 ]; then printf '[dry-run]' >&2; printf ' %q' "$@" >&2; echo >&2; else "$@"; fi; }
probe_description="Opened to read a CI result; never meant to merge"

# The issues a pull request is for: those its body closes, fixes or resolves, and those it refs or relates to. Reads the
# body on stdin; $1 is owner/name. Another repository's #N never counts, so "fixes other/repo#4" is left out.
closing_issues() {
  local esc=${1//./\\.}
  grep -Eio "(^|[^[:alnum:]_])((close[sd]?|fix(e[sd])?|resolve[sd]?|refs|relates[[:space:]]+to)[[:space:]]+(${esc})?#[0-9]+)" \
    | grep -Eo '[0-9]+$' | sort -un || true
}

# The clock the claim rules read: OURO_PR_NOW (epoch seconds, set by the tests) or the time now.
now_epoch() { printf '%s' "${OURO_PR_NOW:-$(date +%s)}"; }

# A claim with no sign of life for this long lapses and no longer refuses. A sign of life is a comment by the claimant's
# account after the claim, or a push since then to an open PR that references the issue (its head commit's date).
claim_lapse_seconds=7200

# The comments on an issue as "kind|session|login|epoch|created_at|url" lines, oldest first. A marker (<!-- ouro-claim:
# name --> to claim, <!-- ouro-claim-release: name --> to release, each a line of its own) makes a claim or release line;
# any other comment makes a note. gh's own jq reads the JSON and turns the dates into epoch seconds, so the script needs
# nothing else installed.
claim_events() {
  # shellcheck disable=SC2016 # jq variables, not shell ones
  gh api --paginate "repos/$1/issues/$2/comments" --jq '
    .[] | . as $c | ($c.user.login // "") as $who | ($c.created_at | fromdateiso8601) as $t
    | [($c.body // "") | split("\n")[] | capture("^\\s*<!-- ouro-claim(?<r>-release)?: (?<s>[A-Za-z0-9._-]+) -->\\s*$")?] as $ms
    | if ($ms | length) == 0 then ["note", "", $who, $t, $c.created_at, $c.html_url] | join("|")
      else $ms[] | [(if .r then "release" else "claim" end), .s, $who, $t, $c.created_at, $c.html_url] | join("|") end'
}

# The open PRs that reference issue $2 (they close, fix or resolve it, or refs or relate to it), as "push|||epoch|date|url"
# lines, dated by each PR's head commit (its committer date, the time of its last push). A push since a claim is a sign of
# life. The PR list carries no commits: GitHub's GraphQL refuses that for a repository with many pull requests.
open_pr_pushes() {
  local name=$1 n=$2 refs url oid dated
  # shellcheck disable=SC2016 # jq variables, not shell ones
  refs=$(gh pr list --repo "$name" --state open --limit 100 --json url,body,headRefOid --jq '
    .[] | select((.body // "") | test("(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?|refs|relates +to) +#'"$n"'([^0-9]|$)")) | [.url, .headRefOid] | @tsv') || return 1
  while IFS=$'\t' read -r url oid; do
    [ -n "$url" ] || continue
    # shellcheck disable=SC2016 # jq variables, not shell ones
    dated=$(gh api "repos/$name/commits/$oid" --jq '.commit.committer.date | [(fromdateiso8601), .] | join("|")') || return 1
    printf 'push|||%s|%s\n' "$dated" "$url"
  done <<<"$refs"
}

# What bears on an issue's claim, oldest first: its comments, then the pushes to open PRs that reference it. A failed
# read of the comments fails the call; a failed read of the PRs is said, and the comments alone are judged.
issue_events() {
  local name=$1 n=$2 pushes
  claim_events "$name" "$n" || return 1
  if ! pushes=$(open_pr_pushes "$name" "$n" 2>/dev/null); then
    say "could not read the open PRs that reference #$n, so pushes since its claim are not seen."
  elif [ -n "$pushes" ]; then
    printf '%s\n' "$pushes"
  fi
}

# The claim that stands on an issue, from issue_events on stdin, given "now" and the lapse in epoch seconds. A claim
# stands until a release from its own session follows it; a later claim replaces it. Its last sign of life is the latest
# of: the claim, a comment by the claimant's account after it, and a push after it. Prints nothing when no claim stands,
# else "live|session|claimed_at|claim_url|last_activity", or the same with "lapsed" when the last sign is over the lapse.
claim_status() {
  local now=$1 lapse=$2 kind sess login epoch iso url events
  local hs="" hlogin="" hep="" hiso="" hurl="" last_ep last_iso claim_state
  events=$(cat)
  while IFS='|' read -r kind sess login epoch iso url; do
    case $kind in
      claim) hs=$sess; hlogin=$login; hep=$epoch; hiso=$iso; hurl=$url ;;
      release) if [ -n "$hs" ] && [ "$sess" = "$hs" ]; then hs=""; fi ;;
    esac
  done <<<"$events"
  [ -n "$hs" ] || return 0
  last_ep=$hep; last_iso=$hiso
  while IFS='|' read -r kind sess login epoch iso url; do
    case $epoch in ''|*[!0-9]*) continue ;; esac
    [ "$epoch" -gt "$hep" ] || continue
    if { [ -n "$hlogin" ] && [ "$login" = "$hlogin" ]; } || [ "$kind" = push ]; then
      if [ "$epoch" -gt "$last_ep" ]; then last_ep=$epoch; last_iso=$iso; fi
    fi
  done <<<"$events"
  if [ $((now - last_ep)) -le "$lapse" ]; then claim_state=live; else claim_state=lapsed; fi
  printf '%s|%s|%s|%s|%s\n' "$claim_state" "$hs" "$hiso" "$hurl" "$last_iso"
}

# Takes an issue over from its live claimant. The comment carries the new session's marker, so the issue is claimed by it.
take_over_issue() {
  local name=$1 n=$2 session=$3 from=$4 reason=$5
  run gh issue comment "$n" --repo "$name" --body "$(printf 'Taken over by %s from %s: %s\n\n<!-- ouro-claim: %s -->' "$session" "$from" "$reason" "$session")"
  if [ "$dry" = 1 ]; then say "dry run: #$n would be taken over from $from."; else say "took #$n over from $from."; fi
}

# Refuses (exit 1) when an open issue the pull request is for has a live claim by another session, unless --take-over takes
# it over. A lapsed claim is said and passed. Runs before anything is pushed. A read that fails is said and skipped: it
# never blocks a publish.
check_claims() {
  local name=$1 session=$2 body=$3 now n issue_state events status claim_state who since url last
  now=$(now_epoch)
  for n in $(closing_issues "$name" <"$body"); do
    if ! issue_state=$(gh api "repos/$name/issues/$n" --jq .state 2>/dev/null); then
      say "could not read #$n, so its claim is not checked."
      continue
    fi
    [ "$issue_state" = open ] || continue
    if ! events=$(issue_events "$name" "$n"); then
      say "could not read #$n's comments, so its claim is not checked."
      continue
    fi
    status=$(printf '%s\n' "$events" | claim_status "$now" "$claim_lapse_seconds")
    [ -n "$status" ] || continue
    IFS='|' read -r claim_state who since url last <<<"$status"
    if [ "$who" = "$session" ]; then continue; fi
    if [ "$claim_state" = lapsed ]; then
      say "the claim on #$n by $who lapsed (no activity since $last)."
      continue
    fi
    if [ "$take_over_set" = 1 ]; then
      take_over_issue "$name" "$n" "$session" "$who" "$take_over"
      continue
    fi
    if [ -z "$session" ]; then
      say "#$n is claimed by $who since $since ($url), and this run has no session name. Set OURO_SESSION or pass --as <name>."
    else
      say "#$n is claimed by $who since $since ($url). Coordinate with that session, have it run gh ouro-pr release $n, or take the issue over with --take-over \"<reason>\"."
    fi
    say "nothing was pushed or opened."
    exit 1
  done
}

# gh ouro-pr claim <issue>: assigns this session's gh user and says so on the issue. A live claim by another session
# refuses, unless --take-over takes it over; a lapsed one is said and replaced.
do_claim() {
  local name=$1 n=$2 session=$3 now issue_state events status claim_state who since url last
  [ -n "$session" ] || { say "claim needs a session name: set OURO_SESSION or pass --as <name>."; exit 2; }
  now=$(now_epoch)
  issue_state=$(gh api "repos/$name/issues/$n" --jq .state) || { say "could not read #$n, so nothing was claimed."; exit 1; }
  [ "$issue_state" = open ] || { say "#$n is $issue_state: nothing to claim."; exit 2; }
  events=$(issue_events "$name" "$n") || { say "could not read #$n's comments, so nothing was claimed."; exit 1; }
  status=$(printf '%s\n' "$events" | claim_status "$now" "$claim_lapse_seconds")
  if [ -n "$status" ]; then
    IFS='|' read -r claim_state who since url last <<<"$status"
    if [ "$who" = "$session" ]; then say "#$n is already claimed by $session: nothing to do."; return 0; fi
    if [ "$claim_state" = lapsed ]; then
      say "the claim on #$n by $who lapsed (no activity since $last)."
    elif [ "$take_over_set" = 1 ]; then
      take_over_issue "$name" "$n" "$session" "$who" "$take_over"
      run gh issue edit "$n" --repo "$name" --add-assignee @me
      return 0
    else
      say "#$n is claimed by $who since $since ($url). Coordinate with that session, have it run gh ouro-pr release $n, or take the issue over with --take-over \"<reason>\"."
      exit 1
    fi
  fi
  run gh issue edit "$n" --repo "$name" --add-assignee @me
  run gh issue comment "$n" --repo "$name" --body "$(printf 'Claimed by %s: building this now.\n\n<!-- ouro-claim: %s -->' "$session" "$session")"
  if [ "$dry" = 1 ]; then say "dry run: #$n is not claimed."; else say "claimed #$n as $session."; fi
}

# gh ouro-pr release <issue>: says this session has stopped. Only the session that holds the claim can release it, lapsed or not.
do_release() {
  local name=$1 n=$2 session=$3 now events status who
  [ -n "$session" ] || { say "release needs a session name: set OURO_SESSION or pass --as <name>."; exit 2; }
  now=$(now_epoch)
  events=$(issue_events "$name" "$n") || { say "could not read #$n's comments, so nothing was released."; exit 1; }
  status=$(printf '%s\n' "$events" | claim_status "$now" "$claim_lapse_seconds")
  who=""
  [ -z "$status" ] || IFS='|' read -r _ who _ _ _ <<<"$status"
  if [ "$who" != "$session" ]; then say "#$n is not claimed by $session: nothing to release."; return 0; fi
  run gh issue comment "$n" --repo "$name" --body "$(printf 'Released by %s.\n\n<!-- ouro-claim-release: %s -->' "$session" "$session")"
  say "released #$n. The assignee is unchanged."
}

# A probe PR carries the probe label, and gh pr create fails on a label the repository lacks, so make it first. --force
# only updates the label's colour and description; a failure here is said, and gh pr create reports it if it matters.
ensure_probe_label() {
  if [ "$dry" = 1 ]; then
    run gh label create probe --color BFD4F2 --description "$probe_description" --force
  elif ! gh label create probe --color BFD4F2 --description "$probe_description" --force >/dev/null 2>&1; then
    say "could not create the probe label; gh pr create may fail without it."
  fi
}

main() {
title="" body_file="" base="" dry=0 merge_pr="" as="" probe=0 claim_cmd="" claim_issue="" take_over="" take_over_set=0
extra=()
if [ "${1:-}" = merge ]; then
  [ $# -ge 2 ] || { echo "ouro-pr: merge needs a pull request number or URL" >&2; exit 2; }
  merge_pr=$2; shift 2
fi
if [ "${1:-}" = claim ] || [ "${1:-}" = release ]; then
  claim_cmd=$1
  [ $# -ge 2 ] || { echo "ouro-pr: $claim_cmd needs an issue number" >&2; exit 2; }
  claim_issue=${2#\#}; shift 2
  case $claim_issue in ''|*[!0-9]*) echo "ouro-pr: $claim_cmd needs an issue number, such as 12" >&2; exit 2 ;; esac
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --title|-t|--body-file|-F|--base|-B)
      [ $# -ge 2 ] || { echo "ouro-pr: $1 needs a value" >&2; exit 2; }
      case "$1" in --title|-t) title="$2" ;; --body-file|-F) body_file="$2" ;; *) base="$2" ;; esac
      shift 2 ;;
    --dry-run) dry=1; shift ;;
    --as) [ $# -ge 2 ] || { echo "ouro-pr: --as needs a session name" >&2; exit 2; }; as=$2; shift 2 ;;
    --take-over) [ $# -ge 2 ] || { echo "ouro-pr: --take-over needs a reason" >&2; exit 2; }; take_over=$2; take_over_set=1; shift 2 ;;
    --probe) probe=1; shift ;;
    --draft|-d) echo "ouro-pr: no drafts. Publish when the work is done and has passed every review and local check." >&2; exit 2 ;;
    -h|--help) sed -n '2,/^set -euo/{/^set -euo/!p;}' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null || true
      echo "Usage: gh ouro-pr [--title T] [--body-file F] [--base B] [--as name] [--take-over \"<reason>\"] [--probe] [--dry-run] [gh pr create flags]"
      echo "       gh ouro-pr claim <issue> [--as name] [--take-over \"<reason>\"] | release <issue> [--as name] | merge <pr-or-url>"; exit 0 ;;
    *) extra+=("$1"); shift ;;
  esac
done

# Your session's name: --as, else OURO_SESSION. It goes into comments and markers, so it is kept plain.
session=${as:-${OURO_SESSION:-}}
if [ -n "$session" ] && ! [[ $session =~ ^[A-Za-z0-9._-]+$ ]]; then
  say "a session name uses letters, digits, dots, underscores and dashes: '$session' does not."; exit 2
fi
if [ "$take_over_set" = 1 ]; then
  [ -n "${take_over//[[:space:]]/}" ] || { say "--take-over needs a reason, such as --take-over \"the claimant stopped; this is its plan\"."; exit 2; }
  [ -n "$session" ] || { say "--take-over needs a session name: set OURO_SESSION or pass --as <name>."; exit 2; }
fi

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

if [ -n "$claim_cmd" ]; then
  git remote get-url origin >/dev/null 2>&1 || { say "run $claim_cmd from a clone of the repository."; exit 2; }
  name=$(gh repo view "$(git remote get-url origin)" --json nameWithOwner --jq .nameWithOwner)
  if [ "$claim_cmd" = claim ]; then do_claim "$name" "$claim_issue" "$session"; else do_release "$name" "$claim_issue" "$session"; fi
  exit 0
fi

branch=$(git symbolic-ref --short HEAD 2>/dev/null) || { say "not on a branch"; exit 2; }
# A branch named probe/... is a probe, the same as --probe.
case $branch in probe/*) probe=1 ;; esac
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

# A live claim by another session on an issue this PR is for refuses, or is taken over with --take-over, before anything is
# pushed. It reads the body as the author wrote it, so it runs before the one-writer check below rewrites closing keywords.
# A probe builds nothing and skips it; a pull request already open has been published, so there is nothing new to refuse.
if [ -z "$url" ] && [ "$probe" != 1 ]; then
  check_claims "$name" "$session" "$body_file"
fi

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

probe_labels=()
if [ "$probe" = 1 ]; then probe_labels=(--label probe); fi
if [ -z "$url" ]; then
  if [ "$probe" = 1 ]; then ensure_probe_label; fi
  if [ "$dry" = 1 ]; then
    run gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$body_file" "${extra[@]+"${extra[@]}"}" "${probe_labels[@]+"${probe_labels[@]}"}"
    say "body would be:"; cat "$body_file" >&2
    url="(new PR)"
  else
    url=$(gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$body_file" "${extra[@]+"${extra[@]}"}" "${probe_labels[@]+"${probe_labels[@]}"}")
  fi
else
  say "PR already open: $url"
  if [ "$probe" = 1 ]; then run gh pr edit "$url" --add-label probe || say "could not add the probe label."; fi
fi

# A probe reads one CI result and is never merged, so it gets no auto-merge. Its author closes it once it is read.
if [ "$probe" = 1 ]; then
  say "probe: auto-merge stays off, because a probe is never merged. Read its CI result, then close it."
  echo "$url"
  exit 0
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

# Read the whole script before running any of it. A test that needs only the functions loads it with OURO_PR_LIB=1.
if [ -z "${OURO_PR_LIB:-}" ]; then
  run_main_copy "$@"
  main "$@"
fi
