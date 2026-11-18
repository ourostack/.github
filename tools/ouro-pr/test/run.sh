#!/usr/bin/env bash
# Tests the one-writer-per-issue guard with a fake gh and a throwaway repository.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
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

fail() { echo "FAIL: $*" >&2; exit 1; }

FAKE_OPEN_PRS='[{"number":3,"url":"https://github.com/o/r/pull/3","headRefName":"other","body":"Closes #7."}]' \
  bash "$here/ouro-pr.sh" --dry-run >"$tmp/out" 2>&1 && fail "a second PR for #7 was allowed"
grep -q "pull/3 is already open and closes #7" "$tmp/out" || fail "the message does not name the other PR: $(cat "$tmp/out")"

FAKE_OPEN_PRS='[{"number":3,"url":"https://github.com/o/r/pull/3","headRefName":"other","body":"Closes #70"}]' \
  bash "$here/ouro-pr.sh" --dry-run >/dev/null 2>&1 || fail "#70 was taken for #7"

FAKE_OPEN_PRS='[{"number":3,"url":"https://github.com/o/r/pull/3","headRefName":"fix","body":"Closes #7"}]' \
  bash "$here/ouro-pr.sh" --dry-run >/dev/null 2>&1 || fail "the branch's own PR counted as a duplicate"

FAKE_OPEN_PRS='[{"number":3,"url":"https://github.com/o/r/pull/3","headRefName":"other","body":"Closes #7"}]' OURO_PR_ALLOW_DUPLICATE=1 \
  bash "$here/ouro-pr.sh" --dry-run >/dev/null 2>&1 || fail "OURO_PR_ALLOW_DUPLICATE=1 did not override"
echo "ouro-pr tests passed"
