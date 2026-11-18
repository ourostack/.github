#!/usr/bin/env bash
# Tests for check.mjs, with a list of made-up words, so no real internal name appears here either.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
check="$here/../check.mjs"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fails=0
expect() { # expect <0|1|2> <name> <command...>
  local want=$1 name=$2; shift 2
  "$@" >"$tmp/out" 2>&1; local got=$?
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name (exit $got, wanted $want)"; sed 's/^/     /' "$tmp/out"; fails=1; fi
}
export INTERNAL_NAMES_FILE="$tmp/hashes.txt"
{ echo "# made-up words"; node "$check" --hash zorblax; node "$check" --hash acme-internal; } > "$INTERNAL_NAMES_FILE"
text() { printf '%b' "$1" | node "$check" --text; }

expect 0 "clean text passes" text 'Fix the sheet\n\nA consuming app saw it.'
expect 1 "a listed word fails" text 'Seen in Zorblax.'
expect 1 "a possessive fails" text "Zorblax's rail logo"
expect 1 "a hyphenated listed word fails, in a URL" text 'see https://github.com/acme-internal/x/issues/1'
expect 1 "a listed word inside a longer hyphenated word fails" text 'acme-internal-tools'
expect 0 "a word that only contains a listed word passes" text 'zorblaxian'
expect 0 "half of a hyphenated listed word passes" text 'acme widgets'
text 'one\ntwo zorblax\nthree' 2>"$tmp/err"; grep -q "line 2" "$tmp/err" && ! grep -qi zorblax "$tmp/err" && echo "ok   names the line, never the word" || { echo "FAIL the message names the word or the wrong line"; cat "$tmp/err"; fails=1; }

# Commit messages in a range.
repo="$tmp/repo"; git init -q "$repo"; cd "$repo"; git config user.email t@example.com; git config user.name t
git commit -q --allow-empty -m base; base=$(git rev-parse HEAD)
git commit -q --allow-empty -m "Clean subject"
expect 0 "a range of clean commits passes" node "$check" "$base..HEAD"
git commit -q --allow-empty -m "Subject" -m "Body naming Zorblax"
expect 1 "a commit whose message names a listed word fails" node "$check" "$base..HEAD"
grep -q "$(git rev-parse --short=12 HEAD)" "$tmp/out" && echo "ok   names the commit" || { echo "FAIL the commit is not named"; fails=1; }
cd "$here"

expect 2 "no mode is a usage error" node "$check"
# The real list: four hashes, each 64 hex characters.
unset INTERNAL_NAMES_FILE
n=$(grep -cE '^[0-9a-f]{64}$' "$here/../hashes.txt"); [ "$n" -ge 4 ] && echo "ok   the list holds $n hashes" || { echo "FAIL the list holds $n hashes"; fails=1; }
exit $fails
