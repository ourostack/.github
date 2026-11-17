#!/bin/bash
# Ari's laptop, stage 1: from a blank Mac to the personal desk's checkout, then hand over to the kit.
#   curl -fsSL https://raw.githubusercontent.com/ourostack/.github/main/bootstrap/arimendelow-laptop.sh | bash
# Public on purpose and holds no secret: the kit (arimendelow/desk, private) does the real work in stage 2.
# Safe to rerun: every step first checks whether it is already done. Bash 3.2 (the macOS one) is enough.
set -u
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "this is for an Apple Silicon Mac"
[ "$(id -u)" != 0 ] || die "run it as yourself, not root"

say "Your Mac password, once (it installs the developer tools and Homebrew)"
sudo -n true 2>/dev/null || sudo -v || die "no admin password"
( while true; do sudo -n true; sleep 50; kill -0 "$$" 2>/dev/null || exit; done ) 2>/dev/null &

if ! xcode-select -p >/dev/null 2>&1; then
  say "Command Line Tools"
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  label=$(softwareupdate -l 2>/dev/null | sed -n 's/^\* Label: \(Command Line Tools.*\)$/\1/p' | tail -1)
  [ -n "$label" ] || label=$(softwareupdate -l 2>/dev/null | sed -n 's/^ *\* \(Command Line Tools.*\)$/\1/p' | tail -1)
  [ -n "$label" ] && sudo softwareupdate -i "$label" --verbose
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  xcode-select -p >/dev/null 2>&1 || die "Command Line Tools did not install; run xcode-select --install and rerun"
fi

if [ ! -x /opt/homebrew/bin/brew ]; then
  say "Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || die "Homebrew did not install"
fi
eval "$(/opt/homebrew/bin/brew shellenv)"
grep -q 'brew shellenv' "$HOME/.zprofile" 2>/dev/null || echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"

say "git and gh"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1
for f in git gh; do brew list --formula "$f" >/dev/null 2>&1 || brew install "$f" || die "brew install $f failed"; done

say "GitHub sign-in: arimendelow (a code appears; open the page, enter it, approve)"
if ! gh auth status -h github.com 2>/dev/null | grep -q 'account arimendelow '; then
  if [ -n "${LAPTOP_GH_TOKEN:-}" ]; then  # test runs only: a token in place of the device code
    printf '%s' "$LAPTOP_GH_TOKEN" | gh auth login -h github.com -p https --with-token || die "token sign-in failed"
  else
    gh auth login -h github.com -p https -s repo,read:org,workflow,gist,admin:public_key -w || die "GitHub sign-in did not finish"
  fi
fi
gh auth setup-git >/dev/null 2>&1

git config --global user.name >/dev/null 2>&1 || git config --global user.name "Ari Mendelow"

desk="$HOME/personal-desk"
if [ ! -d "$desk/.git" ]; then
  say "Cloning the personal desk"
  # Same thinning as the lean-worktree hook: images, video, audio and bundles stay in Git but are not downloaded.
  git clone --filter=blob:none --no-checkout https://arimendelow@github.com/arimendelow/desk.git "$desk" || die "could not clone the personal desk"
  git -C "$desk" sparse-checkout set --no-cone '/*' '!*.png' '!*.jpg' '!*.jpeg' '!*.mp4' '!*.mov' '!*.mp3' '!*.bundle' '!*.gz'
  git -C "$desk" checkout -q main || die "could not check out the personal desk"
else
  git -C "$desk" pull --rebase --autostash -q 2>/dev/null || true
fi
git -C "$desk" remote set-url origin https://arimendelow@github.com/arimendelow/desk.git
git -C "$desk" config user.email 16390116+arimendelow@users.noreply.github.com

exec bash "$desk/agent-capacity/mac-mini-work-machine-setup/bootstrap-laptop.sh" "$@"
