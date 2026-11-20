#!/usr/bin/env bash
# Bring a contributor's dev container up and hand the process to the Runner.
#
# Idempotent and cheap on a warm volume. The checkout is NOT seeded here: the
# pipeline ships the exact commit of each ticket as a bundle on the ticket's
# first turn, so a fresh container only needs an empty object store to fetch
# into. `pnpm install` for a ticket workspace therefore happens on the first
# sync, inside the Runner's 5-minute exec budget — on a slow network that
# first install may need a second `devpipe_ci_sync`, which the agent is told.
set -euo pipefail

WORK="${OCTOPUS_WORK:-/work}"
CHECKOUT="${OCTOPUS_CHECKOUT:-$WORK/octopus}"
RUNNER_JS="$WORK/runner.js"

log() { printf '[dev-container] %s\n' "$*" >&2; }

mkdir -p "$WORK" "$WORK/home" "$WORK/tickets" "${PNPM_STORE_DIR:-$WORK/pnpm-store}" "${XDG_CACHE_HOME:-$WORK/cache}"
pnpm config set store-dir "${PNPM_STORE_DIR:-$WORK/pnpm-store}" >/dev/null 2>&1 || true
git config --global user.email "${GIT_AUTHOR_EMAIL:-dev-container@octopus.local}" || true
git config --global user.name "${GIT_AUTHOR_NAME:-octopus dev container}" || true
git config --global --add safe.directory '*' || true

# An empty object store is enough: `runner-machine-sync.ts` fetches bundles
# into it and adds per-ticket worktrees beside it.
if [[ ! -d "$CHECKOUT/.git" ]]; then
  log "initialising empty object store at $CHECKOUT"
  git init --quiet "$CHECKOUT"
fi

: "${OCTOPUS_URL:?set OCTOPUS_URL — the Runner dials the bot, outbound only}"
: "${OCTOPUS_DASHBOARD_URL:?set OCTOPUS_DASHBOARD_URL — where runner.js is downloaded from}"
TOKEN="${OCTOPUS_RUNNER_TOKEN:-}"
if [[ -z "$TOKEN" && -n "${OCTOPUS_RUNNER_TOKEN_FILE:-}" && -r "$OCTOPUS_RUNNER_TOKEN_FILE" ]]; then
  TOKEN="$(tr -d '[:space:]' <"$OCTOPUS_RUNNER_TOKEN_FILE")"
fi
if [[ -z "$TOKEN" ]]; then
  log "no device token — mint one on the dashboard (总览 → 设备令牌) and restart this container"
  exit 1
fi

# Always refresh the Runner bundle: it is not secret, it is small, and a stale
# runner is the one thing an `install.sh --update` cannot fix from outside.
log "downloading runner.js from $OCTOPUS_DASHBOARD_URL"
if ! curl -fsSL -H "Authorization: Bearer $TOKEN" -o "$RUNNER_JS.new" "${OCTOPUS_DASHBOARD_URL%/}/download/runner.js"; then
  if [[ -f "$RUNNER_JS" ]]; then
    log "download failed; starting the previously downloaded runner.js"
  else
    log "download failed and no cached runner.js — check the token and OCTOPUS_DASHBOARD_URL"
    exit 1
  fi
else
  mv "$RUNNER_JS.new" "$RUNNER_JS"
fi

# Register the object store as a workspace so Sessions+ can start the
# contributor's own Codex session in it; harmless before the first sync.
node "$RUNNER_JS" workspace add "$CHECKOUT" "octopus-dev" >/dev/null 2>&1 || true

log "runner starting: device=${RUNNER_DEVICE:-$(hostname)} url=$OCTOPUS_URL work=$WORK"
export OCTOPUS_RUNNER_TOKEN="$TOKEN"
exec node "$RUNNER_JS"
