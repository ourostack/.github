#!/usr/bin/env bash
# A stub gh for ouro-pr's tests: test/run.sh puts it first on PATH. It logs every call to $STUB_DIR/log and answers only
# what the script reads: the repository, the state and comments of issue 7 (from $STUB_DIR/state and $STUB_DIR/events,
# where events are the "kind|session|login|epoch|created_at|url" lines that gh's own jq prints), the open PRs that reference
# it (from $STUB_DIR/pushes, the same form), and no open PR for the branch. A $STUB_DIR/fail file makes every read fail.
# Anything else succeeds silently.
echo "$*" >>"$STUB_DIR/log"
case "$*" in
  "repo view "*"nameWithOwner,defaultBranchRef"*) echo "ourostack/example main" ;;
  "repo view "*"nameWithOwner"*) echo "ourostack/example" ;;
  "api "*"repos/ourostack/example/commits/"*) cat "$STUB_DIR/commit-date" ;;
  "api "*"repos/ourostack/example/issues/"*)
    [ ! -f "$STUB_DIR/fail" ] || exit 1
    case "$*" in
      *"/comments"*) cat "$STUB_DIR/events" ;;
      *) cat "$STUB_DIR/state" ;;
    esac ;;
  "pr list "*)
    [ ! -f "$STUB_DIR/fail" ] || exit 1
    case "$*" in
      *headRefOid*) cat "$STUB_DIR/pushes" ;;
      *) echo "[]" ;;
    esac ;;
  "pr view "*) exit 1 ;;
  "pr create "*) echo "https://github.com/ourostack/example/pull/9" ;;
esac
exit 0
