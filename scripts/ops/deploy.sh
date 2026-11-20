#!/usr/bin/env bash
# ops/deploy.sh [target-ref] — trigger a deploy and watch it to completion.
#
# Same action as the panel's 🚀 button / Feishu /deploy: POST /api/deploy.
# Default target: the control plane's configured base branch (v3). Prints the
# supervisor's progression and exits at a terminal state. A passed startup
# health gate succeeds automatically; no human confirmation step remains.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

target="${1:-}"
body="{}"
[[ -n "$target" ]] && body="$(jq -cn --arg t "$target" '{target:$t}')"
if [[ "$target" == --check ]]; then
  api POST /api/deploy/check '{}'
  exit 0
fi
catalog="$(api GET /api/deploy)"
if [[ "$(jq -r '.releases.enabled // false' <<<"$catalog")" == true ]]; then
  checked_sha="$(jq -r '.releases.snapshot.ready.sha // empty' <<<"$catalog")"
  checked_digest="$(jq -r '.releases.snapshot.ready.manifestSha256 // empty' <<<"$catalog")"
  [[ -n "$checked_sha" && -n "$checked_digest" ]] || die "先执行 scripts/ops/deploy.sh --check 并等待发布包暂存完成"
  [[ -z "$target" || "$target" == "$checked_sha" ]] || die "目标不是已检查的发布包 SHA"
  body="$(jq -cn --arg target "$checked_sha" --arg manifest_sha256 "$checked_digest" '{target:$target,manifest_sha256:$manifest_sha256}')"
fi

resp="$(api POST /api/deploy "$body")"
echo "$resp" | jq -e '.ok' >/dev/null || die "触发失败: $(echo "$resp" | jq -r '.error // .')"
id="$(echo "$resp" | jq -r '.intent.id')"
echo "intent #$id target=$(echo "$resp" | jq -r '.intent.target_sha[0:10]') — 等 supervisor 领取…"
note="$(echo "$resp" | jq -r '.intent.detail // empty')"
[[ -z "$note" ]] || echo "$note"

last=""
for _ in $(seq 1 900); do # 上限 ~30 分钟（覆盖冷缓存全量构建、drain 与启动健康门）
  # 自举部署会重启我们正在轮询的 bot:重启窗内 API 连不上是预期行为,不是失败。
  st="$(api GET /api/deploy 2>/dev/null | jq -r --argjson id "$id" '.recent[] | select(.id==$id) | .status' 2>/dev/null || echo "")"
  if [[ -z "$st" ]]; then
    [[ "$last" != "(restarting…)" ]] && { echo "  → (bot 重启中,API 暂不可达)"; last="(restarting…)"; }
    sleep 2; continue
  fi
  [[ "$st" != "$last" ]] && { echo "  → $st"; last="$st"; }
  case "$st" in
    confirm_wait) die "检测到旧版 supervisor 的人工确认窗；先更新/重启 ring-0 supervisor" ;;
    succeeded)    echo "已完成"; exit 0 ;;
    failed|rolled_back|rollback_failed) die "部署进入 $st,看 supervisor.log" ;;
  esac
  sleep 2
done
die "30 分钟内未完成,自己查 ops/status.sh 或 supervisor 日志"
