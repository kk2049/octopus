#!/usr/bin/env bash
# Provision the persistent CI container on lht-val15. Run this FROM THE BOT
# HOST: it ships a Git bundle of the current base over ssh, then builds and
# starts the container against the rootless Docker daemon that already serves
# the GitLab runner there.
#
#   OCTOPUS_URL=wss://bot.example/octopus-runner/v1 \
#   RUNNER_KNOWLEDGE_INPUT_ORIGIN=https://bot.example \
#   OCTOPUS_RUNNER_OWNER=alice OCTOPUS_RUNNER_TOKEN=rt_xxx \
#     ops/ci-container/install.sh
#
# The device token is the one thing this script cannot produce: it is minted
# per device with `/runner-token` and only its sha256 is stored. Everything
# else — image, volume, checkout, dependencies, the Runner build — is done
# here and is idempotent, so re-running after a token rotation is cheap.
set -euo pipefail

SSH_HOST="${OCTOPUS_CI_HOST:-lht-val15}"
DEVICE="${RUNNER_DEVICE:-lht-val15-ci}"
CONTAINER="${OCTOPUS_CI_CONTAINER:-octopus-ci-agent}"
IMAGE="${OCTOPUS_CI_IMAGE:-octopus-ci-agent:latest}"
# This host's root filesystem is 95% full, so everything large lives on
# /mnt/disk — but /mnt/disk itself is root-owned. `/mnt/disk/octopus-ci` is the
# directory `lht` already owns (the GitLab runner's root), so the agent
# container's state goes beside it rather than needing root to create a peer.
REMOTE_ROOT="${OCTOPUS_CI_ROOT:-/mnt/disk/octopus-ci/agent}"
DOCKER_HOST_SOCK="${OCTOPUS_CI_DOCKER_HOST:-unix:///run/user/1000/octopus-ci-docker.sock}"
MIN_FREE_GB="${OCTOPUS_CI_MIN_FREE_GB:-50}"
BASE_REF="${OCTOPUS_CI_BASE:-v4}"
REPO_DIR="${OCTOPUS_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-install}"
if [[ "$MODE" != "install" && "$MODE" != "--check-storage" ]]; then
  echo "usage: $0 [--check-storage]" >&2
  exit 2
fi

remote() { ssh -o BatchMode=yes "$SSH_HOST" "$@"; }
dock() { remote "DOCKER_HOST=$DOCKER_HOST_SOCK docker $*"; }

if [[ ! "$MIN_FREE_GB" =~ ^[1-9][0-9]*$ ]]; then
  echo "OCTOPUS_CI_MIN_FREE_GB must be a positive integer" >&2
  exit 2
fi

check_capacity() {
  local label="$1" path="$2" stats available_kb mount min_kb
  stats="$(remote "df -Pk '$path' | awk 'NR == 2 { print \$4, \$6 }'")"
  read -r available_kb mount <<<"$stats"
  min_kb=$((MIN_FREE_GB * 1024 * 1024))
  if [[ ! "$available_kb" =~ ^[0-9]+$ ]]; then
    echo "Could not read free space for $label at $path" >&2
    exit 1
  fi
  if (( available_kb < min_kb )); then
    echo "$label is on $mount with less than ${MIN_FREE_GB}GiB free." >&2
    echo "Set OCTOPUS_CI_ROOT to an owned directory on a roomier mounted disk;" >&2
    echo "rootless Docker's data-root must also live on a roomier disk." >&2
    exit 1
  fi
  echo "==> $label: $path on $mount ($((available_kb / 1024 / 1024))GiB free)"
}

verify_work_mount() {
  local mounted_source expected_source
  mounted_source="$(dock "inspect '$CONTAINER' --format '{{range .Mounts}}{{if eq .Destination \"/work\"}}{{.Source}}{{end}}{{end}}'" | tr -d '\r\n')"
  expected_source="$(remote "readlink -f '$REMOTE_ROOT/work'" | tr -d '\r\n')"
  if [[ "$mounted_source" != "$expected_source" ]]; then
    echo "Container /work mount mismatch: expected $expected_source, got ${mounted_source:-<none>}" >&2
    return 1
  fi
  echo "==> container /work bind source: $mounted_source"
}

if [[ "$MODE" == "--check-storage" ]]; then
  echo "==> checking $REMOTE_ROOT on $SSH_HOST"
  if ! remote "test -d '$REMOTE_ROOT/work'"; then
    echo "CI persistent root does not exist at $REMOTE_ROOT/work" >&2
    exit 1
  fi
else
  echo "==> preparing $REMOTE_ROOT on $SSH_HOST"
  remote "mkdir -p '$REMOTE_ROOT/work' '$REMOTE_ROOT/build'"
fi
check_capacity "CI persistent root" "$REMOTE_ROOT"

# `/work` is not the only large consumer: image layers and build cache live in
# rootless Docker's data-root. Refuse to build when either side points at a
# cramped disk, otherwise moving only the bind mount gives a false sense of
# safety while the next image build still fills `/`.
docker_root="$(dock "info --format '{{.DockerRootDir}}'" | tr -d '\r\n')"
if [[ -z "$docker_root" ]]; then
  echo "Could not determine rootless Docker data-root" >&2
  exit 1
fi
check_capacity "rootless Docker data-root" "$docker_root"

if [[ "$MODE" == "--check-storage" ]]; then
  verify_work_mount
  echo "==> storage checks passed"
  exit 0
fi

: "${OCTOPUS_URL:?set OCTOPUS_URL to the public TLS endpoint, e.g. wss://bot.example/octopus-runner/v1}"
: "${RUNNER_KNOWLEDGE_INPUT_ORIGIN:?set RUNNER_KNOWLEDGE_INPUT_ORIGIN to the exact dashboard HTTPS origin}"
: "${OCTOPUS_RUNNER_OWNER:?set OCTOPUS_RUNNER_OWNER to the bot username that minted this device token}"
if [[ -z "${OCTOPUS_RUNNER_TOKEN:-}" ]] && ! remote "test -s '$REMOTE_ROOT/work/.runner-token'"; then
  echo "set OCTOPUS_RUNNER_TOKEN for first install; an existing mode-0600 token file may be reused on later installs" >&2
  exit 2
fi
case "$OCTOPUS_URL" in
  wss://*/octopus-runner/v1) ;;
  *) echo "OCTOPUS_URL must use wss:// and the /octopus-runner/v1 endpoint" >&2; exit 2 ;;
esac
case "$RUNNER_KNOWLEDGE_INPUT_ORIGIN" in
  https://* ) ;;
  *) echo "RUNNER_KNOWLEDGE_INPUT_ORIGIN must be an HTTPS origin" >&2; exit 2 ;;
esac
MODEL_DIR="${OCTOPUS_KNOWLEDGE_MODEL_DIR:-/work/knowledge-model-cache}"
case "$MODEL_DIR" in
  /work/* ) ;;
  *) echo "OCTOPUS_KNOWLEDGE_MODEL_DIR must be an absolute path under /work" >&2; exit 2 ;;
esac
echo "==> shipping a bundle of $BASE_REF"
bundle="$(mktemp /tmp/octopus-seed.XXXXXX.bundle)"
trap 'rm -f "$bundle"' EXIT
git -C "$REPO_DIR" bundle create "$bundle" "$BASE_REF" >/dev/null
scp -q -o BatchMode=yes "$bundle" "$SSH_HOST:$REMOTE_ROOT/work/seed.bundle.new"
remote "mv '$REMOTE_ROOT/work/seed.bundle.new' '$REMOTE_ROOT/work/seed.bundle'"

echo "==> shipping the image context"
scp -q -o BatchMode=yes "$SCRIPT_DIR/Dockerfile" "$SCRIPT_DIR/entrypoint.sh" "$SSH_HOST:$REMOTE_ROOT/build/"
remote "chmod 0755 '$REMOTE_ROOT/build/entrypoint.sh'"

echo "==> building $IMAGE (first build pulls apt + Node 22; several minutes)"
dock "build --tag '$IMAGE' '$REMOTE_ROOT/build'"

echo "==> (re)creating $CONTAINER"
dock "rm --force '$CONTAINER'" >/dev/null 2>&1 || true
# The token reaches the container through a mode-0600 file rather than the
# container definition, so `docker inspect` does not print it.
if [[ -n "${OCTOPUS_RUNNER_TOKEN:-}" ]]; then
  remote "install -m 0600 /dev/null '$REMOTE_ROOT/work/.runner-token' && cat > '$REMOTE_ROOT/work/.runner-token'" <<<"$OCTOPUS_RUNNER_TOKEN"
else
  remote "chmod 0600 '$REMOTE_ROOT/work/.runner-token'"
  echo "==> reusing existing persistent Runner token file"
fi
# Budget, not the whole box (2026-08-22): the host also runs the GitLab
# runner, sshd and whatever the lab uses it for. Unbounded, three concurrent
# ticket syncs drove the 48-core machine to load 48, which starved the
# Runner's keepalive (a minute of silence = offline) and sshd's key exchange
# (LoginGraceTime). Half the cores by default; memory only when given. The
# Runner also runs every `exec` at nice 10 + idle IO (RUNNER_EXEC_NICE), so an
# agent's build cannot outrank the Runner that carries it.
CPUS="${OCTOPUS_CI_CPUS:-24}"
MEMORY="${OCTOPUS_CI_MEMORY:-}"
# Rootless Docker can only enforce CPU quota when the user's cgroup v2 tree
# delegates the cpu controller (measured on lht-val15 2026-08-22: it does not —
# "NanoCPUs can not be set"). Ask the daemon before asking for a quota, so a
# missing controller degrades to "no quota" instead of a refused `docker run`;
# the nice/ionice budget inside the container still applies either way.
if [[ "$(dock "info --format '{{.CPUCfsQuota}}'" | tr -d '\r\n')" == "true" ]]; then
  QUOTA_FLAGS="--cpus '$CPUS'"
else
  echo "==> rootless daemon reports no CPU CFS quota support; container runs without --cpus (delegate the cpu controller to enable it)"
  QUOTA_FLAGS=""
fi
dock "run --detach --name '$CONTAINER' \
  --restart unless-stopped \
  $QUOTA_FLAGS ${MEMORY:+--memory '$MEMORY'} \
  --volume '$REMOTE_ROOT/work:/work' \
  --env OCTOPUS_URL='$OCTOPUS_URL' \
  --env OCTOPUS_RUNNER_TOKEN_FILE=/work/.runner-token \
  --env RUNNER_DEVICE='$DEVICE' \
  --env RUNNER_KNOWLEDGE_INPUT_ORIGIN='$RUNNER_KNOWLEDGE_INPUT_ORIGIN' \
  --env OCTOPUS_KNOWLEDGE_MODEL_DIR='$MODEL_DIR' \
  --env RUNNER_SCAN_HOME=/work \
  --env RUNNER_EXEC_NICE='${OCTOPUS_CI_EXEC_NICE:-10}' \
  '$IMAGE'"

if ! verify_work_mount; then
  dock "rm --force '$CONTAINER'" >/dev/null 2>&1 || true
  exit 1
fi

# NOT `logs --follow`: backgrounding it over ssh keeps the channel open long
# after the container is healthy, so the installer appears to hang (measured:
# still running at 10 minutes against an already-registered Runner). Poll the
# log for a terminal marker instead, with a bound.
echo "==> first boot (seed + cold install + runner build) — this can take several minutes"
registered=0
knowledge_ready=0
for _ in $(seq 1 120); do
  out="$(dock "logs --tail 80 '$CONTAINER'" 2>&1 || true)"
  [[ "$out" == *"registered as"* ]] && registered=1
  [[ "$out" == *"knowledge index jobs ready"* ]] && knowledge_ready=1
  if [[ "$out" == *"no device token"* || "$out" == *"refusing to start"* || "$out" == *"Refusing"* || "$out" == *"knowledge index jobs unavailable"* ]]; then
    echo "$out" | tail -8
    echo "==> container refused required Runner capabilities"
    exit 1
  fi
  if (( registered && knowledge_ready )); then
    echo "$out" | tail -5
    echo "==> Runner registered with knowledge-index support."
    break
  fi
  sleep 5
done
if (( ! registered || ! knowledge_ready )); then
  echo "Runner did not become registered and knowledge-index ready before the startup deadline" >&2
  exit 1
fi

cat <<EOF

Provisioned. Next:
  1. Confirm the device shows up online (dashboard, or ask the bot to list machines).
  2. Point the repair lane at it in config.yaml:

       selfhosting:
         ci_machine:
           owner: $OCTOPUS_RUNNER_OWNER
           device: $DEVICE
           checkout_dir: /work/octopus

  3. Restart the bot. The next CI repair ticket gets machine_* tools bound to
     this container, running unsupervised — see doc/runbooks/ci-triage.md.

Re-run this script to ship a fresher base bundle; the checkout, node_modules
and the pnpm store survive.
EOF
