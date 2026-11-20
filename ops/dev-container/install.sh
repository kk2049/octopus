#!/usr/bin/env bash
# Provision a contributor's dev container ON THE CONTRIBUTOR'S OWN MACHINE.
#
#   OCTOPUS_RUNNER_TOKEN=rt_xxx ops/dev-container/install.sh
#   ops/dev-container/install.sh --update     # rebuild + recreate, keep /work
#
# Needs Docker and a device token minted on the dashboard (总览 → 设备令牌,
# or POST /api/runner-token). Everything else — the image, the Runner bundle,
# the persistent /work volume — is done here and is idempotent. The container
# holds NO repository credential: code arrives from the bot pipeline as
# bundles, per ticket, through the Runner. See README.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_URL="${OCTOPUS_DASHBOARD_URL:-https://bot.example.org}"
RUNNER_URL="${OCTOPUS_URL:-wss://bot.example.org/octopus-runner/v1}"
DEVICE="${RUNNER_DEVICE:-$(id -un)-dev}"
CONTAINER="${OCTOPUS_DEV_CONTAINER:-octopus-dev}"
IMAGE="${OCTOPUS_DEV_IMAGE:-octopus-dev-container:latest}"
ROOT="${OCTOPUS_DEV_ROOT:-$HOME/.octopus-dev}"
MODE="${1:-install}"
EXTRA_RUN_ARGS="${OCTOPUS_DEV_RUN_ARGS:-}"

if [[ "$MODE" != "install" && "$MODE" != "--update" ]]; then
  echo "usage: $0 [--update]" >&2
  exit 2
fi
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

mkdir -p "$ROOT/work"
if [[ "$MODE" == "install" ]]; then
  : "${OCTOPUS_RUNNER_TOKEN:?set OCTOPUS_RUNNER_TOKEN to the rt_ device token minted on the dashboard}"
  install -m 0600 /dev/null "$ROOT/runner-token"
  printf '%s\n' "$OCTOPUS_RUNNER_TOKEN" >"$ROOT/runner-token"
elif [[ ! -r "$ROOT/runner-token" ]]; then
  echo "--update needs an existing $ROOT/runner-token; run a plain install first" >&2
  exit 1
fi

echo "==> building $IMAGE (first build pulls the Playwright base + Node 22; several minutes)"
docker build --tag "$IMAGE" "$SCRIPT_DIR"

echo "==> (re)creating $CONTAINER (device=$DEVICE)"
docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
# shellcheck disable=SC2086
docker run --detach --name "$CONTAINER" \
  --restart unless-stopped \
  --volume "$ROOT/work:/work" \
  --volume "$ROOT/runner-token:/run/secrets/runner-token:ro" \
  --env OCTOPUS_URL="$RUNNER_URL" \
  --env OCTOPUS_DASHBOARD_URL="$DASHBOARD_URL" \
  --env OCTOPUS_RUNNER_TOKEN_FILE=/run/secrets/runner-token \
  --env RUNNER_DEVICE="$DEVICE" \
  $EXTRA_RUN_ARGS \
  "$IMAGE" >/dev/null

echo "==> waiting for the Runner to register"
for _ in $(seq 1 60); do
  out="$(docker logs --tail 40 "$CONTAINER" 2>&1 || true)"
  case "$out" in
    *"registered as"*) echo "$out" | tail -3; echo "==> Runner registered as device $DEVICE."; break ;;
    *"no device token"*|*"download failed and no cached"*|*"refusing"*) echo "$out" | tail -5; echo "==> container refused to start (see above)"; exit 1 ;;
  esac
  sleep 3
done

cat <<MSG

Provisioned. Next:
  1. 打开 dashboard 总览,确认设备 $DEVICE 在线。
  2. 请维护者在 config.yaml 里登记你的开发机(一次):

       selfhosting:
         dev_machines:
           <你的用户名>: { device: $DEVICE, checkout_dir: /work/octopus }

  3. 在 /tickets 新建工单。agent 会把代码同步进这个容器(/work/tickets/ticket-<id>)
     编译、跑相关测试,通过后推到 GitLab 的 contrib 分支进入评审。
  4. 想用自己的 Codex:\`docker exec -it $CONTAINER codex login\`,之后在 Sessions+ 选这台设备新建会话。

Re-run with --update to rebuild the image; /work(代码、node_modules、pnpm store)会保留。
MSG
