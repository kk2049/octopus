#!/usr/bin/env bash
# A release job cannot borrow the live bot's unrestricted process budget.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
action="${1:?install, backup or prune required}"; shift
case "$action" in
  install|backup|prune) command=(python3 "$root/release-$action.py" "$@") ;;
  *) exit 64 ;;
esac
# Staging is foreground work. Garbage collection and backup retain the smaller
# maintenance budget; neither inherits the live application's resource budget.
if [[ "$action" == install ]]; then
  export OCTOPUS_RELEASE_PROFILE="${OCTOPUS_RELEASE_STAGING_PROFILE:-staging}"
else
  export OCTOPUS_RELEASE_PROFILE=maintenance
fi
if [[ "$OCTOPUS_RELEASE_PROFILE" == staging && "${OCTOPUS_RELEASE_SYSTEMD:-0}" == 1 ]]; then
  if ! python3 - "$root/release-budget.py" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location('budget', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sys.exit(0 if module.staging_parent_has_headroom() else 1)
PY
  then
    echo 'container I/O limit leaves insufficient foreground reserve; using maintenance profile' >&2
    export OCTOPUS_RELEASE_PROFILE=maintenance
  fi
fi
case "$OCTOPUS_RELEASE_PROFILE" in
 staging)
  # About half of the service container's own cgroup budget (32/16 MB/s,
  # 1400/1000 IOPS, 2.5 CPUs); the other half stays with the foreground.
  cpu=125%; read_bps=16M; write_bps=8M; read_iops=700; write_iops=500
  memory_high=512M; memory_max=768M
  ;;
 maintenance)
  cpu=25%; read_bps=8M; write_bps=4M; read_iops=200; write_iops=100
  memory_high=256M; memory_max=384M
  ;;
 *) echo 'unknown release resource profile' >&2; exit 64 ;;
esac
if [[ "${OCTOPUS_RELEASE_SYSTEMD:-0}" == 1 ]]; then
  # Configured on the Head service, where the existing operator account has
  # sudo. Failure is closed: never silently retry outside this cgroup.
  exec sudo -n systemd-run --quiet --wait --pipe --collect \
    --uid="$(id -u)" --gid="$(id -g)" \
    --setenv="OCTOPUS_RELEASE_PROFILE=$OCTOPUS_RELEASE_PROFILE" \
    --setenv="OCTOPUS_RELEASE_DEPENDENCY_CACHE=${OCTOPUS_RELEASE_DEPENDENCY_CACHE:-1}" \
    -p "CPUQuota=$cpu" -p "MemoryHigh=$memory_high" -p "MemoryMax=$memory_max" -p MemorySwapMax=0 \
    -p Type=oneshot -p TimeoutStartSec=2700 -p TimeoutStopSec=30 \
    -p UMask=0077 -p TasksMax=24 -p Nice=15 -p IOSchedulingClass=idle \
    -p "IOReadBandwidthMax=${OCTOPUS_RELEASE_BLOCK_DEVICE:-/home/ubuntu/lht} $read_bps" \
    -p "IOWriteBandwidthMax=${OCTOPUS_RELEASE_BLOCK_DEVICE:-/home/ubuntu/lht} $write_bps" \
    -p "IOReadIOPSMax=${OCTOPUS_RELEASE_BLOCK_DEVICE:-/home/ubuntu/lht} $read_iops" \
    -p "IOWriteIOPSMax=${OCTOPUS_RELEASE_BLOCK_DEVICE:-/home/ubuntu/lht} $write_iops" \
    -- "${command[@]}"
fi
exec nice -n 15 ionice -c 3 "${command[@]}"
