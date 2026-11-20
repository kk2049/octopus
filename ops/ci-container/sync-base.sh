#!/usr/bin/env bash
# Make the CI container's checkout contain a given commit. Run from the bot host.
#
#   ops/ci-container/sync-base.sh <sha-or-ref>        # default: v4
#
# The container solves the ENVIRONMENT problem (Node, pnpm, browsers, a warm
# node_modules). It must never solve the "which code" problem by standing
# still: a repair agent that cannot check out the failing sha cannot reproduce
# the failure, and a container pinned to whatever `install.sh` last shipped
# goes stale within a day of ordinary landings. So the pipeline calls this
# before every CI repair turn, and it is cheap enough to call every time.
#
# Cheap because the bundle is INCREMENTAL: the container reports what it
# already has, and only the missing commits travel. A no-op sync is one ssh
# round-trip; a day of landings is a few dozen KB. A container that has fallen
# too far behind (or lost its checkout) falls back to a full bundle rather than
# failing — being slow once beats being wrong.
set -euo pipefail

WANT_REF="${1:-v4}"
SSH_HOST="${OCTOPUS_CI_HOST:-lht-val15}"
CONTAINER="${OCTOPUS_CI_CONTAINER:-octopus-ci-agent}"
REMOTE_ROOT="${OCTOPUS_CI_ROOT:-/mnt/disk/octopus-ci/agent}"
DOCKER_HOST_SOCK="${OCTOPUS_CI_DOCKER_HOST:-unix:///run/user/1000/octopus-ci-docker.sock}"
CHECKOUT="${OCTOPUS_CI_CHECKOUT:-/work/octopus}"
REPO_DIR="${OCTOPUS_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

remote() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "$@"; }
dock() { remote "DOCKER_HOST=$DOCKER_HOST_SOCK docker $*"; }

want="$(git -C "$REPO_DIR" rev-parse --verify "$WANT_REF^{commit}")"

# Already there? Then this is a no-op and we say so without shipping anything.
if dock "exec '$CONTAINER' git -C '$CHECKOUT' cat-file -e '${want}^{commit}'" >/dev/null 2>&1; then
  echo "sync: container already has ${want:0:12} ($WANT_REF)"
  exit 0
fi

# What does it have? `git bundle create <basis>..<want>` needs a commit the
# other side definitely holds, so ask rather than assume.
have="$(dock "exec '$CONTAINER' git -C '$CHECKOUT' rev-parse --verify HEAD" 2>/dev/null | tr -d '\r\n' || true)"
bundle="$(mktemp /tmp/octopus-sync.XXXXXX.bundle)"
trap 'rm -f "$bundle"' EXIT

# A bundle must carry at least one REF; `A..B` alone is objects with nothing to
# name them ("Refusing to create empty bundle"). The right shape is
# `^<basis> <ref>`: exclude what the other side has, include the ref by name.
# The ref shipped is always the base branch, because every landed sha — and so
# every sha a red batch can pin — is reachable from it.
BASE_BRANCH="${OCTOPUS_CI_BASE:-v4}"
if [[ -n "$have" ]] && git -C "$REPO_DIR" cat-file -e "${have}^{commit}" 2>/dev/null; then
  echo "sync: incremental ${have:0:12}..${want:0:12}"
  git -C "$REPO_DIR" bundle create "$bundle" "^$have" "$BASE_BRANCH" >/dev/null
else
  echo "sync: full bundle (container has no usable basis)"
  git -C "$REPO_DIR" bundle create "$bundle" "$BASE_BRANCH" >/dev/null
fi

scp -q -o BatchMode=yes "$bundle" "$SSH_HOST:$REMOTE_ROOT/work/sync.bundle.new"
remote "mv '$REMOTE_ROOT/work/sync.bundle.new' '$REMOTE_ROOT/work/sync.bundle'"

# Unbundle, then move the working tree to the wanted commit. Detached on
# purpose: the container's checkout is a scratch space the pipeline owns, not a
# branch anybody is committing to. `reset --hard` + `clean -fd` discards the
# previous repair's edits, which is what makes each repair turn start from a
# known tree instead of inheriting the last agent's half-finished attempt.
dock "exec '$CONTAINER' git -C '$CHECKOUT' fetch --quiet /work/sync.bundle '+refs/heads/*:refs/remotes/sync/*'" \
  || dock "exec '$CONTAINER' git -C '$CHECKOUT' fetch --quiet /work/sync.bundle"
dock "exec '$CONTAINER' git -C '$CHECKOUT' cat-file -e '${want}^{commit}'"
dock "exec '$CONTAINER' git -C '$CHECKOUT' reset --hard --quiet '$want'"
dock "exec '$CONTAINER' git -C '$CHECKOUT' clean -fdq -e node_modules -e dist"

echo "sync: container now at ${want:0:12} ($WANT_REF)"
