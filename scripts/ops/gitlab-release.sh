#!/usr/bin/env bash
# Invoke over SSH on the service device when the application API is unavailable.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec corepack pnpm --dir "$repo" exec tsx "$repo/ctl/release.ts" "$@"
