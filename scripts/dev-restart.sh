#!/usr/bin/env bash
# dev-restart.sh — the one sanctioned way to redeploy the dev bot.
#
# Order of operations is the point:
#   1. build FIRST (plugins/runner dist) — if the build fails the old bot
#      keeps running and nothing was lost;
#   2. SIGTERM the old bot and WAIT for the PID to disappear — the bot
#      drains in-flight agent rounds before exiting, and starting a new
#      process early would fight it for the Feishu WS connection and the
#      SQLite file (observed 2026-07-19: two bots coexisted for 20s);
#   3. start the new bot and wait for its ready line in the log.
#
# Usage:
#   scripts/dev-restart.sh              # full cycle
#   scripts/dev-restart.sh --no-build   # skip the build (docs-only change)
#
# Env overrides:
#   OCTOPUS_WORKTREE  bot source tree   (default /home/ubuntu/lht/octopus-run)
#   OCTOPUS_DEV_DIR   runtime dir       (default /home/ubuntu/lht/octopus-dev)
#   DRAIN_WAIT_S      max wait for the old bot to exit (default 240)

set -euo pipefail

WORKTREE="${OCTOPUS_WORKTREE:-/home/ubuntu/lht/octopus-run}"
DEV_DIR="${OCTOPUS_DEV_DIR:-/home/ubuntu/lht/octopus-dev}"
DRAIN_WAIT_S="${DRAIN_WAIT_S:-240}"
LOG="$DEV_DIR/bot.log"
PIDFILE="$DEV_DIR/bot.pid"
MARKER="${OCTOPUS_READY_MARKER:-v3 bootstrap ready}"
ENTRY="${OCTOPUS_ENTRY:-packages/bot/src/bootstrap-v3.ts}"
NODE_BIN="${OCTOPUS_NODE_BIN:-/usr/bin/node}"

say() { echo "[dev-restart] $*"; }

find_bot_pids() {
  # The tsx-launched bot's cmdline contains this path; the runner
  # (packages/runner/dist) does not. Exclude ourselves defensively.
  pgrep -f "packages/bot/src/(index|bootstrap-v3)\.ts" 2>/dev/null | grep -vw "$$" || true
}

# ── 1. build while the old bot still serves ──
if [[ "${OCTOPUS_COMPUTE_ROLE:-}" == control || -f "$WORKTREE/.octopus-release.json" ]]; then
    export OCTOPUS_COMPUTE_ROLE=control
    [[ -f "$WORKTREE/.octopus-release.json" && -f "$WORKTREE/.octopus-verified" ]] || {
      say "Control node requires a complete verified release; prepare/deploy it on the Runner first."; exit 1;
    }
    say "restarting the complete verified release; local build disabled"
elif [[ "${1:-}" != "--no-build" ]]; then
  say "building (old bot keeps serving; a failed build aborts the restart)…"
  (cd "$WORKTREE" && pnpm -r build) || { say "BUILD FAILED — old bot left running."; exit 1; }
fi

# ── 2. graceful stop: SIGTERM, then wait for the drain to finish ──
PIDS="$(find_bot_pids)"
if [[ -n "$PIDS" ]]; then
  say "stopping old bot (pid $PIDS) with SIGTERM; waiting up to ${DRAIN_WAIT_S}s for drain…"
  kill -TERM $PIDS 2>/dev/null || true
  waited=0
  while [[ -n "$(find_bot_pids)" && $waited -lt $DRAIN_WAIT_S ]]; do
    sleep 2
    waited=$((waited + 2))
    if (( waited % 30 == 0 )); then say "still draining (${waited}s)…"; fi
  done
  LEFT="$(find_bot_pids)"
  if [[ -n "$LEFT" ]]; then
    say "old bot still alive after ${DRAIN_WAIT_S}s — SIGKILL as last resort."
    kill -9 $LEFT 2>/dev/null || true
    sleep 2
  fi
  say "old bot stopped after ${waited}s."
else
  say "no running bot found; fresh start."
fi

# ── 3. start the new bot and confirm readiness ──
# Nothing holds the log open now: rotate it before the new process opens it.
if (( $(stat -c %s "$LOG" 2>/dev/null || echo 0) > ${BOT_LOG_MAX_BYTES:-67108864} )); then mv -f "$LOG" "$LOG.1" || true; fi
START_LINE=$(wc -l <"$LOG" 2>/dev/null || echo 0)
say "starting new bot…"
(
  cd "$WORKTREE"
  setsid nohup env CONFIG_PATH="$DEV_DIR/config.yaml" DATA_DIR="$DEV_DIR/data" \
    "$NODE_BIN" --max-old-space-size="${SUP_NODE_HEAP_MB:-768}" --no-turbo-inline-js-wasm-calls --import tsx "$ENTRY" >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
)
NEW_PID=$(cat "$PIDFILE")
say "new bot pid $NEW_PID; waiting for '$MARKER' in $LOG…"

waited=0
while (( waited < 90 )); do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    say "NEW BOT DIED DURING STARTUP — recent log:"
    tail -n 25 "$LOG"
    exit 1
  fi
  if tail -n "+$((START_LINE + 1))" "$LOG" 2>/dev/null | grep -q "$MARKER"; then
    say "ready. replayed/queued messages (if any) are being processed."
    exit 0
  fi
  sleep 2
  waited=$((waited + 2))
done

say "TIMED OUT waiting for readiness — recent log:"
tail -n 25 "$LOG"
exit 1
