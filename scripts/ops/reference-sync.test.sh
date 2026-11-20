#!/usr/bin/env bash
# Real-Git safety checks, isolated from service and production repositories.
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/reference-sync.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export OCTOPUS_REFERENCE_DIR="$fixture/mirror"
export OCTOPUS_REFERENCE_STATE_DIR="$fixture/state"
git init -q -b v4 "$fixture/head"
printf 'one\n' > "$fixture/head/source"
git -C "$fixture/head" add source
git -C "$fixture/head" commit -qm initial
git clone -q "$fixture/head" "$fixture/mirror"
refuse() {
  local before
  before="$(git -C "$fixture/mirror" rev-parse HEAD)"
  if bash "$script" > "$fixture/output" 2>&1; then cat "$fixture/output"; echo "unexpected success: $*"; exit 1; fi
  [[ "$(git -C "$fixture/mirror" rev-parse HEAD)" == "$before" ]]
  printf 'PASS refuse %s\n' "$*"
}
refuse 'unenrolled checkout'
git -C "$fixture/mirror" config octopus.referenceMirror true
git -C "$fixture/mirror" config octopus.referenceSource "$fixture/head"
bash "$script" > /dev/null
mkdir "$fixture/mirror/.octopus-attachment-test"
printf 'user attachment' > "$fixture/mirror/.octopus-attachment-test/file"
printf 'two\n' >> "$fixture/head/source"
git -C "$fixture/head" commit -qam advance
bash "$script" > /dev/null
[[ "$(git -C "$fixture/mirror" rev-parse HEAD)" == "$(git -C "$fixture/head" rev-parse HEAD)" ]]
[[ "$(cat "$fixture/mirror/.octopus-attachment-test/file")" == 'user attachment' ]]
echo 'PASS exact fast-forward and preserved attachment'
printf 'user edit\n' >> "$fixture/mirror/source"
refuse 'tracked change'
git -C "$fixture/mirror" add source
refuse 'staged change'
git -C "$fixture/mirror" restore --staged --worktree source
touch "$fixture/mirror/unknown"
refuse 'unknown untracked file'
rm "$fixture/mirror/unknown"
git -C "$fixture/mirror" switch -qc feature
refuse 'wrong branch'
git -C "$fixture/mirror" switch -q v4
printf 'local\n' >> "$fixture/mirror/source"
git -C "$fixture/mirror" commit -qam local
refuse 'mirror ahead of source'
printf 'remote\n' >> "$fixture/head/source"
git -C "$fixture/head" commit -qam remote
refuse 'divergent histories'
git -C "$fixture/mirror" config octopus.referenceSource "$fixture/missing"
refuse 'unreachable source'
echo 'All reference mirror safety checks passed'
