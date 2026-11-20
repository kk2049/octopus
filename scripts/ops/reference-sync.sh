#!/usr/bin/env bash
# One-way fast-forward of an explicitly enrolled reference mirror. Never run on Head.
set -euo pipefail
mirror="${OCTOPUS_REFERENCE_DIR:-/home/ubuntu/lht/octopus}"
state_dir="${OCTOPUS_REFERENCE_STATE_DIR:-/home/ubuntu/.cache/octopus-reference-sync}"
mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -w 50 9 || { echo 'reference-sync: another sync did not finish within 50s' >&2; exit 1; }
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$state_dir/sync.log"; }
fail() { log "ERROR $*" >&2; exit 1; }
trap 'log "ERROR sync failed at line $LINENO; mirror freshness is unverified" >&2' ERR
cd "$mirror"
[[ "$(git rev-parse --show-toplevel)" == "$(pwd -P)" ]] || fail 'target must be the repository root'
[[ "$(git config --local --get octopus.referenceMirror || true)" == true ]] || fail 'repository is not enrolled as a reference mirror'
source_url="$(git config --local --get octopus.referenceSource)"
[[ -n "$source_url" ]] || fail 'missing explicit authoritative source'
[[ "$(git branch --show-current)" == v4 ]] || fail 'expected branch v4'
for operation in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  [[ ! -e "$(git rev-parse --git-path "$operation")" ]] || fail "unfinished Git operation: $operation"
done
git diff --quiet && git diff --cached --quiet || fail 'tracked or staged changes; preserve and review them'
# -z handles newlines/spaces without accidentally admitting an unknown path.
status_file="$(mktemp "$state_dir/status.XXXXXX")"
trap 'rm -f "$status_file"' EXIT
git status --porcelain=v1 -z --untracked-files=normal > "$status_file"
while IFS= read -r -d '' entry; do
  case "$entry" in
    '?? .octopus-attachment-'*/) ;;
    *) fail "unexpected worktree change: $entry" ;;
  esac
done < "$status_file"
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2'
timeout 60 git -c gc.auto=0 fetch --quiet --no-tags --no-recurse-submodules "$source_url" \
  '+refs/heads/v4:refs/remotes/authoritative/v4'
current="$(git rev-parse HEAD)"
target="$(git rev-parse refs/remotes/authoritative/v4)"
if [[ "$current" != "$target" ]]; then
  git merge-base --is-ancestor "$current" "$target" || fail "non-fast-forward: mirror=$current authoritative=$target; manual reconciliation required"
  git -c core.hooksPath=/dev/null merge --ff-only --no-edit --no-stat "$target"
fi
[[ "$(git rev-parse HEAD)" == "$target" ]] || fail 'post-sync SHA mismatch'
# Atomic success receipt; failure leaves the prior timestamp visible as stale evidence.
printf '%s %s\n' "$(date -u +%FT%TZ)" "$target" > "$state_dir/last-success.tmp"
mv "$state_dir/last-success.tmp" "$state_dir/last-success"
log "OK $target"
