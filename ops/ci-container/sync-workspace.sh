#!/usr/bin/env bash
# Sync one ticket's exact commit into an isolated CI-container worktree.
#
#   ops/ci-container/sync-workspace.sh <sha-or-ref> <ticket-key>
#
# The shared /work/octopus checkout is only the object store and Runner host.
# Ticket agents work in /work/tickets/<ticket-key>, so concurrent builds never
# reset, clean, or relink another ticket's workspace. Git objects and the pnpm
# content store remain shared; node_modules and generated workspace links do
# not.
set -euo pipefail

WANT_REF="${1:-HEAD}"
TICKET_KEY="${2:-}"
if [[ ! "$TICKET_KEY" =~ ^ticket-[0-9]+$ ]]; then
  echo "sync: ticket key must match ticket-<number>" >&2
  exit 2
fi

SSH_HOST="${OCTOPUS_CI_HOST:-lht-val15}"
CONTAINER="${OCTOPUS_CI_CONTAINER:-octopus-ci-agent}"
REMOTE_ROOT="${OCTOPUS_CI_ROOT:-/mnt/disk/octopus-ci/agent}"
DOCKER_HOST_SOCK="${OCTOPUS_CI_DOCKER_HOST:-unix:///run/user/1000/octopus-ci-docker.sock}"
OBJECT_REPO="${OCTOPUS_CI_CHECKOUT:-/work/octopus}"
WORKSPACE_ROOT="${OCTOPUS_CI_WORKSPACES:-/work/tickets}"
WORKSPACE="$WORKSPACE_ROOT/$TICKET_KEY"
REPO_DIR="${OCTOPUS_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REMOTE_BUNDLE="$REMOTE_ROOT/work/sync-$TICKET_KEY.bundle"

remote() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "$@"; }
dock() { remote "DOCKER_HOST=$DOCKER_HOST_SOCK docker $*"; }

want="$(git -C "$REPO_DIR" rev-parse --verify "$WANT_REF^{commit}")"

# Ship only missing objects. HEAD is a valid bundle ref and, unlike the local
# ticket branch name, is stable across every ticket/worktree naming scheme.
if ! dock "exec '$CONTAINER' git -C '$OBJECT_REPO' cat-file -e '${want}^{commit}'" >/dev/null 2>&1; then
  have="$(dock "exec '$CONTAINER' git -C '$OBJECT_REPO' rev-parse --verify HEAD" 2>/dev/null | tr -d '\r\n' || true)"
  bundle="$(mktemp "/tmp/octopus-$TICKET_KEY.XXXXXX.bundle")"
  trap 'rm -f "$bundle"' EXIT

  if [[ -n "$have" ]] && git -C "$REPO_DIR" cat-file -e "${have}^{commit}" 2>/dev/null; then
    echo "sync: incremental ${have:0:12}..${want:0:12} for $TICKET_KEY"
    git -C "$REPO_DIR" bundle create "$bundle" "^$have" HEAD >/dev/null
  else
    echo "sync: full bundle for $TICKET_KEY"
    git -C "$REPO_DIR" bundle create "$bundle" HEAD >/dev/null
  fi

  scp -q -o BatchMode=yes "$bundle" "$SSH_HOST:$REMOTE_BUNDLE.new"
  remote "mv '$REMOTE_BUNDLE.new' '$REMOTE_BUNDLE'"
  # A ticket branch is rebased by devpipe before landing, so its commit graph
  # may legitimately stop being a fast-forward. This is a pipeline-owned
  # transfer ref, never a user branch: force only that exact ref while keeping
  # every other ticket and the shared base untouched.
  dock "exec '$CONTAINER' git -C '$OBJECT_REPO' fetch --quiet '/work/sync-$TICKET_KEY.bundle' '+HEAD:refs/remotes/ticket-sync/$TICKET_KEY'"
fi

dock "exec '$CONTAINER' git -C '$OBJECT_REPO' cat-file -e '${want}^{commit}'"
dock "exec '$CONTAINER' mkdir -p '$WORKSPACE_ROOT'"
if dock "exec '$CONTAINER' git -C '$WORKSPACE' rev-parse --git-dir" >/dev/null 2>&1; then
  dock "exec '$CONTAINER' git -C '$WORKSPACE' reset --hard --quiet '$want'"
else
  dock "exec '$CONTAINER' git -C '$OBJECT_REPO' worktree prune"
  dock "exec '$CONTAINER' git -C '$OBJECT_REPO' worktree add --quiet --detach '$WORKSPACE' '$want'"
fi
dock "exec '$CONTAINER' git -C '$WORKSPACE' clean -fdq -e node_modules -e dist"
dock "exec '$CONTAINER' git config --global --add safe.directory '$WORKSPACE'"

# A ticket workspace owns its links and generated outputs. The pnpm store is
# shared, so this is a warm relink on ordinary turns and a one-time setup on a
# new ticket, not a cold network install.
dock "exec '$CONTAINER' sh -lc \"cd '$WORKSPACE' && pnpm install --frozen-lockfile --prefer-offline\""
dock "exec '$CONTAINER' sh -lc \"cd '$WORKSPACE' && pnpm --filter @claude-bot/runner --filter @claude-bot/plugin-sessions --filter @claude-bot/dashboard-web build\""

echo "sync: workspace $WORKSPACE now at ${want:0:12} ($WANT_REF)"
