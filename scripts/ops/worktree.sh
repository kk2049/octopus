#!/usr/bin/env bash
# Create one human/CLI development worktree and materialise its own pnpm links.
#
# Root node_modules cannot be shared with another worktree: pnpm's workspace
# links point at packages in the tree that created them, so sharing would make
# tests silently import a different branch. The content-addressed pnpm store is
# already shared; a frozen prefer-offline install is therefore the safe, cheap
# way to make a new worktree immediately usable.

set -euo pipefail

usage() {
  echo "usage: scripts/ops/worktree.sh <branch> [worktree-path] [base-ref]" >&2
  echo "example: scripts/ops/worktree.sh dev/codex-ticket-filter" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 3 ]] || usage

branch="$1"
git check-ref-format --branch "$branch" >/dev/null 2>&1 || {
  echo "worktree: invalid branch name: $branch" >&2
  exit 2
}

script_repo="$(git -C "$(dirname "${BASH_SOURCE[0]}")/../.." rev-parse --show-toplevel)"
common_git_dir="$(git -C "$script_repo" rev-parse --path-format=absolute --git-common-dir)"
reference_repo="$(dirname "$common_git_dir")"
configured_parent="$(git -C "$reference_repo" config --get octopus.worktreesDir || true)"
worktrees_parent="${OCTOPUS_WORKTREES_DIR:-${configured_parent:-$(dirname "$reference_repo")/octopus-worktrees}}"
default_name="${branch//\//-}"
worktree_path="${2:-$worktrees_parent/$default_name}"
base_ref="${3:-v4}"
if [[ $# -lt 3 && "${OCTOPUS_MAINLINE_AUTHORITY:-gitlab}" != head ]]; then
  base_ref="$(git -C "$reference_repo" ls-remote origin refs/heads/v4 | awk '{print $1}')"
  [[ "$base_ref" =~ ^[0-9a-f]{40}$ ]] || { echo 'worktree: GitLab v4 is unavailable; an offline base must be supplied explicitly' >&2; exit 1; }
  git -C "$reference_repo" fetch --no-tags --no-write-fetch-head origin "$base_ref"
fi

git -C "$reference_repo" rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null || {
  echo "worktree: unknown base ref: $base_ref" >&2
  exit 2
}
if git -C "$reference_repo" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "worktree: branch already exists: $branch" >&2
  exit 2
fi
[[ ! -e "$worktree_path" ]] || {
  echo "worktree: path already exists: $worktree_path" >&2
  exit 2
}

mkdir -p "$(dirname "$worktree_path")"
git -C "$reference_repo" worktree add -b "$branch" "$worktree_path" "$base_ref"

if [[ "${OCTOPUS_COMPUTE_ROLE:-}" == control || "${OCTOPUS_SOURCE_ONLY:-0}" == 1 ]]; then
  echo "== source worktree ready: $worktree_path; prepare dependencies and builds on the registered execution provider =="
  exit 0
fi
echo "== preparing isolated dependencies in $worktree_path =="
if ! corepack pnpm -C "$worktree_path" install --frozen-lockfile --prefer-offline; then
  echo "worktree: dependency preparation failed; the new worktree was preserved at $worktree_path" >&2
  echo "worktree: retry with: pnpm -C '$worktree_path' install --frozen-lockfile --prefer-offline" >&2
  exit 1
fi

echo "== building test-ready workspace outputs in $worktree_path =="
if ! corepack pnpm -C "$worktree_path" \
  --filter @claude-bot/runner \
  --filter @claude-bot/plugin-sessions \
  --filter @claude-bot/dashboard-web \
  build; then
  echo "worktree: dependency install succeeded but test-ready workspace build failed" >&2
  echo "worktree: the new worktree was preserved at $worktree_path" >&2
  echo "worktree: retry the runner, plugin-sessions, and dashboard-web builds shown above" >&2
  exit 1
fi

echo "== ready: $worktree_path ($branch from $base_ref) =="
