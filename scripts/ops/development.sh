#!/usr/bin/env bash
# No service token or online Octopus dependency. Keep local state commands serial.
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
git_dir="$(git rev-parse --absolute-git-dir)"
state_dir="$git_dir/octopus-development"
umask 077
mkdir -p "$state_dir"
exec flock -w 60 "$state_dir/command.lock" corepack pnpm --dir "$repo" exec tsx "$repo/ctl/development.ts" "$@"
