#!/usr/bin/env bash
# Bring the persistent CI container up, then hand the process to the Runner.
#
# Everything here is idempotent and cheap on a warm volume: the expensive
# provisioning (seed the checkout, first install, build the runner) happens on
# the first boot and is skipped afterwards. A restart of this container must
# not cost a repair agent ten minutes.
set -euo pipefail

WORK="${OCTOPUS_WORK:-/work}"
CHECKOUT="${OCTOPUS_CHECKOUT:-$WORK/octopus}"
SEED="$WORK/seed.bundle"
# `git bundle create <file> v4` writes refs/heads/v4 and NO HEAD, so a plain
# clone of it checks nothing out ("remote HEAD refers to nonexistent ref") and
# leaves an empty tree that fails at the first pnpm command. The branch has to
# be named at clone time. Caught by the first real provisioning run.
BASE_REF="${OCTOPUS_BASE_REF:-v4}"

log() { printf '[ci-container] %s\n' "$*" >&2; }

mkdir -p "$WORK" "${PNPM_STORE_DIR:-$WORK/pnpm-store}" "${XDG_CACHE_HOME:-$WORK/cache}"
pnpm config set store-dir "${PNPM_STORE_DIR:-$WORK/pnpm-store}" >/dev/null 2>&1 || true

# ── the checkout ──────────────────────────────────────────────────────────
# Seeded from a Git bundle shipped over ssh by `install.sh`, deliberately not
# cloned from GitLab: a clone of a private project would mean putting a
# long-lived credential inside a container that an agent has a shell in, to
# fetch bytes the bot host already has. A bundle is a file, carries no
# authority, and `install.sh` can drop a fresher one whenever the base moves.
if [[ ! -d "$CHECKOUT/.git" ]]; then
  if [[ ! -f "$SEED" ]]; then
    log "no checkout and no $SEED — run ops/ci-container/install.sh from the bot host first"
    exit 1
  fi
  log "seeding $CHECKOUT from $SEED at $BASE_REF"
  git clone --quiet --branch "$BASE_REF" "$SEED" "$CHECKOUT"
  git -C "$CHECKOUT" remote rename origin seed
  test -f "$CHECKOUT/package.json" || { log "seed produced no working tree — is $BASE_REF in the bundle?"; exit 1; }
fi
git config --global --add safe.directory "$CHECKOUT" || true

# A newer bundle than the checkout's last seed = the base moved. Fetch it in,
# but never move the working tree: a repair agent may be mid-fix in here.
if [[ -f "$SEED" ]]; then
  git -C "$CHECKOUT" fetch --quiet seed '+refs/heads/*:refs/remotes/seed/*' || log "seed fetch failed; keeping the existing checkout"
fi

# ── dependencies and the runner build ────────────────────────────────────
if [[ ! -d "$CHECKOUT/node_modules" ]]; then
  log "cold install (first boot only; this takes a few minutes)"
  (cd "$CHECKOUT" && pnpm install --frozen-lockfile --prefer-offline)
fi
if [[ ! -f "$CHECKOUT/packages/runner/dist/index.js" ]]; then
  log "building the runner"
  # The build is judged by its ARTEFACT, not by its exit status, and the scope
  # of that exception is narrow and measured. Building THIS ONE package in
  # isolation (`--filter`, or a bare `npx tsup` in its directory) emits every
  # chunk, prints "Build success", and then esbuild's service dies at teardown
  # with "Unexpected end of JSON input" — with and without --dts. dist/index.js
  # is complete and runs; the non-zero exit is the teardown, not the bundle.
  #
  # The workspace-wide build CI actually runs is unaffected: `pnpm -r build` in
  # this same container exits 0 (verified 2026-08-17, DTS included). So this
  # tolerance covers one isolated build on the way to starting the Runner, and
  # nothing an agent does inside the container afterwards — there, a build
  # failure is a build failure, exactly as in CI.
  (cd "$CHECKOUT" && pnpm --filter @claude-bot/runner run build) || \
    log "runner build exited non-zero; checking whether the bundle came out anyway"
  if [[ ! -f "$CHECKOUT/packages/runner/dist/index.js" ]]; then
    log "runner build produced no dist/index.js — refusing to start"
    exit 1
  fi
fi

# ── register the checkout as a Runner workspace ──────────────────────────
# Canonical paths never cross the Runner wire; the bot only ever sees an opaque
# workspace id and a display label (packages/runner/src/workspaces.ts).
node "$CHECKOUT/packages/runner/dist/index.js" workspace add "$CHECKOUT" "octopus-ci" >/dev/null 2>&1 || true

if [[ -z "${OCTOPUS_URL:-}" ]]; then
  log "OCTOPUS_URL is unset — refusing to start a Runner that cannot dial home"
  exit 1
fi
if [[ -z "${OCTOPUS_RUNNER_TOKEN:-}" && -z "${OCTOPUS_RUNNER_TOKEN_FILE:-}" ]]; then
  log "no device token — mint one with /runner-token and restart this container"
  exit 1
fi

# ── which Runner build runs ──────────────────────────────────────────────
# The checkout's dist/ is built ONCE (above) and then frozen: a container
# provisioned on 08-17 was still running that Runner on 08-22 while five
# Runner fixes landed. The Runner now keeps itself current: it reports the
# sha256 of its entry file on register, and the bot hands it the standalone
# bundle it was deployed with, which the Runner stages at the MANAGED PATH
# under RUNNER_SCAN_HOME (/work here, so it survives container recreation)
# and then exits 75 for us to restart it from there. `--restart
# unless-stopped` brings this entrypoint back, and it prefers the managed
# bundle over the frozen checkout build. OCTOPUS_RUNNER_SUPERVISED=1 is what
# tells the Runner "exit, don't spawn" — docker is the supervisor.
MANAGED_RUNNER="${RUNNER_SCAN_HOME:-$WORK}/.octopus/runner/standalone.js"
if [[ -f "$MANAGED_RUNNER" ]]; then
  RUNNER_ENTRY="$MANAGED_RUNNER"
else
  RUNNER_ENTRY="$CHECKOUT/packages/runner/dist/index.js"
fi
export OCTOPUS_RUNNER_SUPERVISED=1
log "runner starting: device=${RUNNER_DEVICE:-$(hostname)} url=$OCTOPUS_URL entry=$RUNNER_ENTRY"
exec node "$RUNNER_ENTRY"
