#!/usr/bin/env bash
# Tests for ouro-pr.sh. The claim rules, the lapse and the closing-reference parser run as pure functions (OURO_PR_LIB=1 loads
# the script without running it). The claim, lapse, take-over, release, claim-check and probe rules run the script in a clone
# with a bare origin, with stub-gh.sh answering for gh, so nothing reaches GitHub and refusals are checked before any push.
# The one-writer-per-issue tests (#330) run last, with their own fake gh.
# shellcheck disable=SC2329 # the helpers below are called as arguments to check and expect, which shellcheck cannot follow
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/../ouro-pr.sh"
# Scratch lives in this folder and is removed on exit, so the tests write nothing outside the repository.
work="$here/.scratch-$$"
rm -rf "$work"; mkdir -p "$work/bin" "$work/stub"
trap 'rm -rf "$work"' EXIT
ln -s "$here/stub-gh.sh" "$work/bin/gh"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; if [ -n "${2:-}" ]; then sed 's/^/     /' "$2"; fi; fails=1; }
check() { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
expect() { # expect <exit> <name> <command...>: the command's output lands in $work/out
  local want=$1 name=$2; shift 2
  "$@" >"$work/out" 2>&1; local got=$?
  if [ "$got" = "$want" ]; then ok "$name"; else bad "$name (exit $got, wanted $want)" "$work/out"; fi
}
same() { # same <name> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$3', wanted '$2'"; fi
}

# Pure functions: run in their own shell, so the script's set -e never reaches this one.
lib() { OURO_PR_LIB=1 OURO_PR_MAIN=1 bash -c 'source "$1"; shift; "$@"' _ "$script" "$@"; }
ev() { printf '%s|%s|%s|%s|%s|%s\n' "$@"; } # ev <kind> <session> <login> <epoch> <created_at> <url>
status() { lib claim_status "$@"; }         # status <now> <lapse seconds>, with issue events on stdin
LAPSE=7200
B=1000 # the claim's epoch in the pure tests

same "no event: no claim stands" "" "$(printf '' | status $B $LAPSE)"
same "a live claim by another session stands" "live|session-a|C1|u1|C1" "$(ev claim session-a alice $B C1 u1 | status $((B+60)) $LAPSE)"
same "a claim then a release by the same session: no claim" "" "$({ ev claim session-a alice $B C1 u1; ev release session-a alice $((B+1)) R2 u2; } | status $((B+2)) $LAPSE)"
same "a release by a different session does not release" "live|session-a|C1|u1|C1" "$({ ev claim session-a alice $B C1 u1; ev release session-b bob $((B+1)) R2 u2; } | status $((B+2)) $LAPSE)"
same "of two claims the latest stands" "live|session-b|C2|u2|C2" "$({ ev claim session-a alice $B C1 u1; ev claim session-b bob $((B+5)) C2 u2; } | status $((B+6)) $LAPSE)"
same "an earlier claimant releasing does not drop a later claim" "live|session-b|C2|u2|C2" "$({ ev claim session-a alice $B C1 u1; ev claim session-b bob $((B+5)) C2 u2; ev release session-a alice $((B+6)) R3 u3; } | status $((B+7)) $LAPSE)"
same "a claim made after a release stands" "live|session-b|C3|u3|C3" "$({ ev claim session-a alice $B C1 u1; ev release session-a alice $((B+5)) R2 u2; ev claim session-b bob $((B+6)) C3 u3; } | status $((B+7)) $LAPSE)"
same "a claim with no sign of life for two hours lapses" "lapsed|session-a|C1|u1|C1" "$(ev claim session-a alice $B C1 u1 | status $((B+7201)) $LAPSE)"
same "a claim exactly two hours old still stands" "live|session-a|C1|u1|C1" "$(ev claim session-a alice $B C1 u1 | status $((B+7200)) $LAPSE)"
same "a comment by the claimant after the claim keeps it alive" "live|session-a|C1|u1|N5" "$({ ev claim session-a alice $B C1 u1; ev note "" alice $((B+5000)) N5 u5; } | status $((B+9000)) $LAPSE)"
same "a comment by another account does not" "lapsed|session-a|C1|u1|C1" "$({ ev claim session-a alice $B C1 u1; ev note "" bob $((B+5000)) N5 u5; } | status $((B+9000)) $LAPSE)"
same "a comment by the claimant from before the claim does not" "lapsed|session-a|C1|u1|C1" "$({ ev note "" alice $((B-500)) N0 u0; ev claim session-a alice $B C1 u1; } | status $((B+9000)) $LAPSE)"
same "a push to a referencing PR after the claim keeps it alive" "live|session-a|C1|u1|P5" "$({ ev claim session-a alice $B C1 u1; ev push "" "" $((B+5000)) P5 pr5; } | status $((B+9000)) $LAPSE)"
same "a push before the claim does not" "lapsed|session-a|C1|u1|C1" "$({ ev push "" "" $((B-500)) P0 pr0; ev claim session-a alice $B C1 u1; } | status $((B+9000)) $LAPSE)"
same "the later of a comment and a push is the last sign of life" "live|session-a|C1|u1|N6" "$({ ev claim session-a alice $B C1 u1; ev push "" "" $((B+3000)) P5 pr5; ev note "" alice $((B+6000)) N6 u6; } | status $((B+9000)) $LAPSE)"

refs=$(printf '%s\n' 'Fixes #1' 'closed #2' 'Resolves #3' 'Refs #4' 'Relates to #5' 'Fixes other/repo#6' 'Refs other/repo#7' \
  'prefixes #8' 'fixes ourostack/example#9' | lib closing_issues ourostack/example | tr '\n' ' ')
same "closing, fixing, resolving, refs and relates-to count; other repositories and longer words do not" "1 2 3 4 5 9 " "$refs"
same "a dot in the repository name is a dot, not any character" "3 " "$(printf 'Fixes ourostack/.github#3\nFixes ourostackxgithub#4\n' | lib closing_issues ourostack/.github | tr '\n' ' ')"

# The stub gh and the script in a clone.
# new_repo <dir>: a bare origin with main, and a clone on branch feature with one commit that is not pushed.
new_repo() {
  rm -rf "$1"; mkdir -p "$1"
  git init -q --bare "$1/origin.git"
  git init -q -b main "$1/clone"
  git -C "$1/clone" config user.email t@example.com
  git -C "$1/clone" config user.name t
  git -C "$1/clone" config commit.gpgsign false
  git -C "$1/clone" remote add origin "$1/origin.git"
  git -C "$1/clone" commit -q --allow-empty -m base
  git -C "$1/clone" push -q origin main
  git -C "$1/clone" checkout -q -b feature
  git -C "$1/clone" commit -q --allow-empty -m "Build the thing"
}
# The clock the script reads (OURO_PR_NOW), and times relative to it.
NOW=1800000000
RECENT=$((NOW-600)); RECENT_ISO=2027-01-15T07:50:00Z   # ten minutes ago
OLD=$((NOW-9000)); OLD_ISO=2027-01-15T05:30:00Z         # two and a half hours ago
# stub <events> [state] [fail]: what the stub gh answers for issue 7, and resets its log and its PR pushes.
stub() {
  : >"$work/stub/log"; printf '%s\n' "$1" >"$work/stub/events"; printf '%s\n' "${2:-open}" >"$work/stub/state"; : >"$work/stub/pushes"; : >"$work/stub/commit-date"
  rm -f "$work/stub/fail"; if [ "${3:-}" = fail ]; then : >"$work/stub/fail"; fi
}
# pushes <url<TAB>head sha>: what the stub gh lists as the open PRs that reference issue 7; commit_date <epoch|created_at>:
# the committer date it answers for a head commit.
pushes() { printf '%s\n' "$1" >"$work/stub/pushes"; }
commit_date() { printf '%s\n' "$1" >"$work/stub/commit-date"; }
# ouro <clone> <session or ""> <args...>: runs the script in the clone, with the stub gh first on PATH and the clock at NOW.
ouro() {
  local clone=$1 sess=$2; shift 2
  (cd "$clone" && env -u OURO_SESSION ${sess:+"OURO_SESSION=$sess"} OURO_PR_NOW="$NOW" OURO_PR_MAIN=1 STUB_DIR="$work/stub" PATH="$work/bin:$PATH" bash "$script" "$@")
}
logged() { grep -qF -- "$1" "$work/stub/log"; }
lacks() { ! grep -qF -- "$1" "$work/stub/log"; }
outputs() { grep -qF -- "$1" "$work/out"; }
pushed() { git --git-dir="$1/origin.git" rev-parse -q --verify refs/heads/"$2" >/dev/null; }
not_pushed() { ! pushed "$1" "$2"; }
# claim7 <session> [epoch created_at]: a claim on issue 7 by session's account alice, made ten minutes ago unless told otherwise.
claim7() { ev claim "$1" alice "${2:-$RECENT}" "${3:-$RECENT_ISO}" https://example.test/c1; }
body="$work/body.md"
printf 'Fixes #7\n' >"$body"

# claim and release.
new_repo "$work/c1"
stub "$(claim7 session-a)"
expect 1 "claim refuses an issue another session holds" ouro "$work/c1/clone" session-b claim 7
check "the refusal names the claimant and when" outputs "#7 is claimed by session-a since 2027-01-15T07:50:00Z (https://example.test/c1). Coordinate with that session, have it run gh ouro-pr release 7, or take the issue over with --take-over \"<reason>\"."
check "the refused claim assigns and comments nothing" lacks "issue edit"
check "the refused claim comments nothing" lacks "issue comment"
stub "" open
expect 2 "claim needs a session name" ouro "$work/c1/clone" "" claim 7
check "the missing name is said" outputs "claim needs a session name: set OURO_SESSION or pass --as <name>"
stub "$(claim7 session-a)"
expect 1 "--as overrides OURO_SESSION" ouro "$work/c1/clone" session-a claim 7 --as session-b
stub ""
expect 0 "claiming a free issue assigns the claimant and comments the marker" ouro "$work/c1/clone" session-b claim 7
check "the claimant is assigned to the issue" logged "issue edit 7 --repo ourostack/example --add-assignee @me"
check "the comment says so, with the hidden marker" logged "<!-- ouro-claim: session-b -->"
stub "$(claim7 session-b)"
expect 0 "a claim this session already holds is left alone" ouro "$work/c1/clone" session-b claim 7
check "it says so" outputs "#7 is already claimed by session-b"
check "it assigns and comments nothing" lacks "issue edit"
stub "" closed
expect 2 "a closed issue has nothing to claim" ouro "$work/c1/clone" session-b claim 7
stub "$(claim7 session-b)"
expect 0 "release by the holder comments the release marker" ouro "$work/c1/clone" session-b release 7
check "the release marker is posted" logged "<!-- ouro-claim-release: session-b -->"
check "the release does not unassign" lacks "issue edit"
stub "$(claim7 session-a)"
expect 0 "release by another session does nothing" ouro "$work/c1/clone" session-b release 7
check "no comment is posted" lacks "issue comment"
expect 2 "claim with no issue number is a usage error" ouro "$work/c1/clone" session-b claim
expect 0 "help lists the claim commands and the probe flag" ouro "$work/c1/clone" "" --help
check "help names claim, release, --as, --take-over and --probe" bash -c "grep -qF 'gh ouro-pr claim <issue>' '$work/out' && grep -qF -- '--probe' '$work/out' && grep -qF -- 'release <issue>' '$work/out' && grep -qF -- '--as name' '$work/out' && grep -qF -- '--take-over' '$work/out'"

# Opening a pull request refuses before anything is pushed.
new_repo "$work/r1"
stub "$(claim7 session-a)"
expect 1 "opening refuses an issue another session claimed" ouro "$work/r1/clone" session-b --body-file "$body"
check "the refusal names the claim and how to resolve it" outputs "ouro-pr: #7 is claimed by session-a since 2027-01-15T07:50:00Z (https://example.test/c1). Coordinate with that session, have it run gh ouro-pr release 7, or take the issue over with --take-over \"<reason>\"."
check "nothing was pushed" not_pushed "$work/r1" feature
check "no PR was opened" lacks "pr create"
new_repo "$work/r2"
stub "$(claim7 session-a)"
expect 1 "without a session name a claimed issue is refused too" ouro "$work/r2/clone" "" --body-file "$body"
check "the refusal says to set one" outputs "this run has no session name. Set OURO_SESSION or pass --as <name>."
check "nothing was pushed without a name either" not_pushed "$work/r2" feature
new_repo "$work/r3"
stub "$(claim7 session-b)"
expect 0 "a claim this session holds passes" ouro "$work/r3/clone" session-b --body-file "$body"
check "the branch is pushed" pushed "$work/r3" feature
check "the PR is opened" logged "pr create"
new_repo "$work/r4"
stub "$({ claim7 session-a; ev release session-a alice 1800000100 2027-01-15T08:01:40Z https://example.test/c2; })"
expect 0 "a claim its own session has released passes" ouro "$work/r4/clone" session-b --body-file "$body"
new_repo "$work/r5"
stub "" open fail
expect 0 "an issue that cannot be read does not block publishing" ouro "$work/r5/clone" session-b --body-file "$body"
check "the failed read is said" outputs "could not read #7, so its claim is not checked."
check "the branch is pushed after a failed read" pushed "$work/r5" feature
new_repo "$work/r6"
stub "$(claim7 session-a)" closed
expect 0 "a claim on a closed issue is not checked" ouro "$work/r6/clone" session-b --body-file "$body"
new_repo "$work/r7"
stub "$(claim7 session-a)"
expect 0 "a probe skips the claim check, and carries the probe label" ouro "$work/r7/clone" session-b --probe --body-file "$body"
check "the probe label is created first" logged "label create probe --color BFD4F2"
check "the PR carries the probe label" logged "--label probe"
check "the probe is pushed" pushed "$work/r7" feature
check "a probe gets no auto-merge" lacks "api graphql"
check "it says why" outputs "probe: auto-merge stays off, because a probe is never merged."
new_repo "$work/r8"
git -C "$work/r8/clone" branch -q -m probe/try
stub ""
expect 0 "a probe/ branch is a probe without the flag" ouro "$work/r8/clone" "" --body-file "$body"
check "the probe/ PR carries the label" logged "--label probe"
check "the probe/ PR gets no auto-merge" lacks "api graphql"
new_repo "$work/r9"
stub ""
expect 0 "an ordinary PR gets no probe label and goes on to auto-merge" ouro "$work/r9/clone" "" --body-file "$body"
check "no label is passed" lacks "--label"
check "auto-merge is looked at" logged "api graphql"
new_repo "$work/r10"
stub "$(claim7 session-a)"
expect 0 "--dry-run --probe prints the label and the PR and pushes nothing" ouro "$work/r10/clone" session-b --probe --dry-run --body-file "$body"
check "the label is printed, not created" outputs "[dry-run] gh label create probe"
check "the PR is printed" outputs "[dry-run] gh pr create"
check "the printed PR carries the probe label" outputs "--label probe"
check "nothing is pushed in a dry run" not_pushed "$work/r10" feature

# A lapsed claim (no sign of life for two hours) no longer refuses, and says so.
new_repo "$work/l1"
stub "$(claim7 session-a "$OLD" "$OLD_ISO")"
expect 0 "a lapsed claim does not refuse a PR" ouro "$work/l1/clone" session-b --body-file "$body"
check "it says the claim lapsed, with the time of its last activity" outputs "ouro-pr: the claim on #7 by session-a lapsed (no activity since $OLD_ISO)."
check "the branch is pushed" pushed "$work/l1" feature
check "the PR is opened" logged "pr create"
new_repo "$work/l2"
stub "$({ claim7 session-a "$OLD" "$OLD_ISO"; ev note "" alice "$RECENT" "$RECENT_ISO" https://example.test/c3; })"
expect 1 "a claim with a recent comment from the claimant still refuses" ouro "$work/l2/clone" session-b --body-file "$body"
check "the refusal says when the claim was made" outputs "#7 is claimed by session-a since $OLD_ISO"
check "nothing was pushed" not_pushed "$work/l2" feature
new_repo "$work/l3"
stub "$(claim7 session-a "$OLD" "$OLD_ISO")"
pushes "https://github.com/ourostack/example/pull/3	abc123"
commit_date "$RECENT|$RECENT_ISO"
expect 1 "a claim with a recent push to a PR that references the issue still refuses" ouro "$work/l3/clone" session-b --body-file "$body"
check "nothing was pushed" not_pushed "$work/l3" feature
new_repo "$work/l6"
stub "$(claim7 session-a "$OLD" "$OLD_ISO")"
pushes "https://github.com/ourostack/example/pull/3	abc123"
commit_date "$((OLD-100))|2027-01-15T05:28:20Z"
expect 0 "a referencing PR whose head commit predates the claim is no sign of life" ouro "$work/l6/clone" session-b --body-file "$body"
check "the lapse is said" outputs "the claim on #7 by session-a lapsed"
stub "$(claim7 session-a "$OLD" "$OLD_ISO")"
expect 0 "a lapsed claim is replaced by claim, with its own marker" ouro "$work/c1/clone" session-b claim 7
check "the lapse is said" outputs "the claim on #7 by session-a lapsed (no activity since $OLD_ISO)."
check "the new claim is posted" logged "<!-- ouro-claim: session-b -->"
stub "$(claim7 session-a "$OLD" "$OLD_ISO")"
expect 0 "a lapsed claim can still be released by its session" ouro "$work/c1/clone" session-a release 7
check "the release is posted" logged "<!-- ouro-claim-release: session-a -->"

# --take-over: a reason and a session name are needed; with both, it overrides a live claim.
stub "$(claim7 session-a)"
expect 2 "--take-over with an empty reason fails" ouro "$work/c1/clone" session-b --take-over "" --body-file "$body"
check "it says it needs a reason" outputs "--take-over needs a reason"
expect 2 "--take-over with a blank reason fails" ouro "$work/c1/clone" session-b --take-over "   " --body-file "$body"
expect 2 "--take-over without a session name fails" ouro "$work/c1/clone" "" --take-over "plan changed" --body-file "$body"
check "it says it needs a session name" outputs "--take-over needs a session name"
check "it posts nothing" lacks "issue comment"
new_repo "$work/t1"
stub "$(claim7 session-a)"
expect 0 "--take-over with a reason takes a live claim over and proceeds" ouro "$work/t1/clone" session-b --take-over "session-a stopped at the plan" --body-file "$body"
check "the takeover is posted, with the reason" logged "Taken over by session-b from session-a: session-a stopped at the plan"
check "it carries the marker for the new session" logged "<!-- ouro-claim: session-b -->"
check "it says so" outputs "took #7 over from session-a."
check "the branch is pushed" pushed "$work/t1" feature
check "the PR is opened" logged "pr create"
new_repo "$work/t2"
stub "$(claim7 session-a)"
expect 0 "--take-over in a dry run only prints" ouro "$work/t2/clone" session-b --take-over "plan changed" --dry-run --body-file "$body"
check "the takeover is printed, not posted" outputs "[dry-run] gh issue comment 7"
check "nothing is pushed" not_pushed "$work/t2" feature
stub "$(claim7 session-a)"
expect 0 "claim --take-over takes the issue over" ouro "$work/c1/clone" session-b claim 7 --take-over "stopped"
check "the taker is assigned" logged "issue edit 7 --repo ourostack/example --add-assignee @me"
check "the takeover is posted, with the marker" logged "Taken over by session-b from session-a: stopped"
check "no separate claim is posted" lacks "Claimed by session-b"

# A session name is plain: it goes into comments and markers.
stub ""
expect 2 "a session name with a space is refused" ouro "$work/c1/clone" "bad name" claim 7

rm -f "$work/stub/fail"

# The one-writer-per-issue tests from #330: the other PR is named, the body is relaxed for that issue, and nothing is refused.
one_writer_tests() (
  set -euo pipefail
  fail() { echo "FAIL: $*" >&2; exit 1; }
  tmp="$work/one-writer"
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/gh" <<'GH'
#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo "o/r main" ;;
  "pr view") exit 1 ;;
  "pr list") echo "${FAKE_OPEN_PRS:-[]}" ;;
  *) exit 0 ;;
esac
GH
  chmod +x "$tmp/bin/gh"
  git init -q --bare "$tmp/origin.git"
  git init -q -b main "$tmp/work"
  cd "$tmp/work"
  git config user.email t@example.com; git config user.name t
  git remote add origin "$tmp/origin.git"
  git commit -q --allow-empty -m base && git push -q origin main
  git checkout -q -b fix
  git commit -q --allow-empty -m "Fix the thing" -m "Fixes #7"
  export PATH="$tmp/bin:$PATH" OURO_PR_MAIN=1

  dup='[{"number":3,"url":"https://github.com/o/r/pull/3","headRefName":"other","body":"Closes #7."}]'
  printf 'Fixes #7 and fixes #8.\n' >"$tmp/body"
  FAKE_OPEN_PRS=$dup bash "$script" --dry-run --body-file "$tmp/body" >"$tmp/out" 2>&1 || fail "a second PR for #7 was blocked: $(cat "$tmp/out")"
  grep -q "pull/3 is already open and closes #7" "$tmp/out" || fail "the other PR is not named: $(cat "$tmp/out")"
  grep -q "Relates to #7 and fixes #8" "$tmp/out" || fail "the body was not relaxed for #7 only: $(cat "$tmp/out")"

  FAKE_OPEN_PRS='[{"number":3,"url":"https://github.com/o/r/pull/3","headRefName":"other","body":"Closes #70"}]' \
    bash "$script" --dry-run --body-file "$tmp/body" >"$tmp/out" 2>&1 || fail "dry run failed"
  grep -q "Fixes #7 and fixes #8" "$tmp/out" || fail "#70 was taken for #7"

  FAKE_OPEN_PRS='[{"number":3,"url":"https://github.com/o/r/pull/3","headRefName":"fix","body":"Closes #7"}]' \
    bash "$script" --dry-run --body-file "$tmp/body" >"$tmp/out" 2>&1 || fail "dry run failed"
  grep -q "Fixes #7 and fixes #8" "$tmp/out" || fail "the branch's own PR counted as a duplicate"
  echo "ok   one writer per issue (#330): the other PR is named, the body relaxed for that issue, nothing refused"
)
one_writer_tests || fails=1

exit $fails
