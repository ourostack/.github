#!/usr/bin/env bash
# Tests for check.sh: ack list skips only listed SHAs (sweep and range), new offenders stay red, PR text is checked.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
check="$here/../check.sh"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fails=0
expect() { # expect <0|1> <name> <command...>
  local want=$1 name=$2; shift 2
  "$@" >"$tmp/out" 2>&1; local got=$?
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name (exit $got, wanted $want)"; sed 's/^/     /' "$tmp/out"; fails=1; fi
}

# A fake gh serving one repo whose main has a clean commit, an acknowledged offender and a new offender.
mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'G'
#!/usr/bin/env bash
case "$*" in
  *"orgs/ourostack/repos"*) echo demo ;;
  *"--jq .default_branch"*) echo main ;;
  *"repos/ourostack/demo/commits"*) cat "$FAKE_COMMITS" ;;
  *) exit 1 ;;
esac
G
chmod +x "$tmp/bin/gh"
old=1111111111111111111111111111111111111111; new=2222222222222222222222222222222222222222; clean=3333333333333333333333333333333333333333
printf '%s | ourostack/demo | copilot-swe-agent[bot] | test reason | ourostack/.github#1\n' "$old" > "$tmp/ack.txt"
sweep() { PATH="$tmp/bin:$PATH" FAKE_COMMITS="$tmp/commits.json" ACK_FILE="$tmp/ack.txt" bash "$check" --sweep; }
commit_json() { printf '{"sha":"%s","commit":{"message":"%s"}}' "$1" "$2"; }
trailer='Subject (#1)\n\nCo-authored-by: copilot-swe-agent[bot] <1+Copilot@users.noreply.github.com>'

printf '[%s,%s]' "$(commit_json $clean 'Clean (#2)')" "$(commit_json $old "$trailer")" > "$tmp/commits.json"
expect 0 "sweep is green when the only offender is acknowledged" sweep
printf '[%s,%s,%s]' "$(commit_json $clean 'Clean (#2)')" "$(commit_json $old "$trailer")" "$(commit_json $new "$trailer")" > "$tmp/commits.json"
expect 1 "sweep is red for a new offender beside an acknowledged one" sweep
grep -q "${new:0:12}" "$tmp/out" && ! grep -q "${old:0:12}" "$tmp/out" && echo "ok   only the new offender is reported" || { echo "FAIL wrong offenders reported"; fails=1; }

# Dependency bots signing off their own bump are not AI credit; an AI co-author line still is.
dep=4444444444444444444444444444444444444444; dep2=5555555555555555555555555555555555555555; imp=6666666666666666666666666666666666666666
signoff='build(deps): bump x\n\nSigned-off-by: dependabot[bot] <support@github.com>'
bot_json() { printf '{"sha":"%s","author":{"login":"%s"},"commit":{"message":"%s"}}' "$1" "$2" "$3"; }
printf '[%s]' "$(bot_json $dep 'dependabot[bot]' "$signoff")" > "$tmp/commits.json"
expect 0 "sweep accepts a dependabot sign-off on its own commit" sweep
printf '[%s]' "$(bot_json $dep2 'dependabot[bot]' "$signoff\n\nCo-authored-by: Copilot <1+Copilot@users.noreply.github.com>")" > "$tmp/commits.json"
expect 1 "sweep still fails a dependabot commit with an AI co-author" sweep
printf '[%s]' "$(bot_json $imp 'someone' "$signoff")" > "$tmp/commits.json"
expect 1 "sweep fails a dependabot sign-off on a non-bot commit" sweep

# Range mode on a real repository.
unset GIT_CONFIG_COUNT # an ambient signing config must not leak into the scratch repo
git init -q "$tmp/repo" && cd "$tmp/repo" && git config user.email t@t && git config user.name t && git config commit.gpgsign false
git commit -q --allow-empty -m base
git commit -q --allow-empty -m "feat: x" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
bad=$(git rev-parse HEAD)
expect 1 "range flags an unacknowledged trailer" bash "$check" HEAD~1..HEAD
printf '%s | ourostack/demo | Copilot | test | ourostack/.github#1\n' "$bad" > "$tmp/ack.txt"
expect 0 "range skips an acknowledged SHA" env ACK_FILE="$tmp/ack.txt" bash "$check" HEAD~1..HEAD
git commit -q --allow-empty -m "feat: y" -m "Co-authored-by: Ari Mendelow <ari@example.com>"
expect 0 "a human co-author is fine" env ACK_FILE="$tmp/ack.txt" bash "$check" HEAD~1..HEAD

git commit -q --allow-empty --author='dependabot[bot] <support@github.com>' -m "build(deps): bump y" -m "Signed-off-by: dependabot[bot] <support@github.com>"
expect 0 "range accepts a dependabot sign-off by dependabot" env ACK_FILE="$tmp/ack.txt" bash "$check" HEAD~1..HEAD
git commit -q --allow-empty -m "build(deps): bump z" -m "Signed-off-by: dependabot[bot] <support@github.com>"
expect 1 "range fails that sign-off from a human author" env ACK_FILE="$tmp/ack.txt" bash "$check" HEAD~1..HEAD

# Pull request title and body.
expect 1 "PR body with a bot credit fails" bash -c "printf 'Body\n\nCo-authored-by: ouro-current[bot] <1+x@users.noreply.github.com>\n' | bash '$check' --text"
expect 0 "clean PR body passes" bash -c "printf 'Subject\n\nA clean body.\n' | bash '$check' --text"

exit $fails
