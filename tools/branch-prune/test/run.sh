#!/usr/bin/env bash
# Tests for prune.mjs: the decisions (screen, decide, recentPushReason), the arguments, and run() against a fake gh.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec node --test "$here/prune.test.mjs"
