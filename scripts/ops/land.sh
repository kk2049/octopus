#!/usr/bin/env bash
# GitLab is the integration door. Legacy Head mode is an explicit bootstrap
# choice and must prove the shared authority has not been activated.
set -euo pipefail
ops="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${OCTOPUS_MAINLINE_AUTHORITY:-gitlab}" == head ]]; then
  exec bash "$ops/land-head.sh" "$@"
fi
exec bash "$ops/development.sh" land "$@"
