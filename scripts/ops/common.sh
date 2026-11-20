# shellcheck shell=bash
# scripts/ops/common.sh — shared plumbing for the ops CLI wrappers.
#
# These scripts are thin clients of the SAME /api/* endpoints the dashboard
# buttons call ("ops 单一动作层": one action layer, many frontends). They exist
# so a terminal session — human or CLI agent — can drive deploy/tickets without
# leaving for Feishu or the web panel.
#
# Auth: admin key, read from the deploy env's token file by default.
#   OCTOPUS_OPS_URL         bot base url        (default http://127.0.0.1:9820)
#   OCTOPUS_OPS_TOKEN       admin token         (overrides the file)
#   OCTOPUS_OPS_TOKEN_FILE  where to read it    (default octopus-dev/dashboard-token.txt)
#   OCTOPUS_OPS_PUBLIC_URL  public ingress used by confirm.sh evidence checks
#                           (default https://bot.example.org)
#   OCTOPUS_REPO_ROOT       deployed run tree   (default octopus-run)
#   OCTOPUS_BASE_BRANCH     deployable watermark (default v3)
#   OCTOPUS_STABLE_BRANCH   rollback watermark (default v3-stable)

set -euo pipefail

OPS_URL="${OCTOPUS_OPS_URL:-http://127.0.0.1:9820}"
OPS_PUBLIC_URL="${OCTOPUS_OPS_PUBLIC_URL:-https://bot.example.org}"
OPS_TOKEN_FILE="${OCTOPUS_OPS_TOKEN_FILE:-/home/ubuntu/lht/octopus-dev/dashboard-token.txt}"
OPS_REPO_ROOT="${OCTOPUS_REPO_ROOT:-/home/ubuntu/lht/octopus-run}"
# 2026-08-07 起水位线改名 v4/v4-stable;v3/v3-stable 是停止前移的历史锚。
# 过渡期缺省按「v4 分支存在则用 v4,否则回退 v3 并提示」——让老 checkout 上的脚本仍然可用。
_ops_repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_ops_default_branch() {
  if git -C "$_ops_repo_dir" rev-parse --verify -q "refs/heads/$1" >/dev/null 2>&1; then echo "$1"; else
    echo "⚠️  分支 $1 不存在,回退 $2(v3 别名将在下一阶段移除)" >&2; echo "$2"
  fi
}
OPS_BASE_BRANCH="${OCTOPUS_BASE_BRANCH:-$(_ops_default_branch v4 v3)}"
OPS_STABLE_BRANCH="${OCTOPUS_STABLE_BRANCH:-$(_ops_default_branch v4-stable v3-stable)}"
if [[ -z "${OCTOPUS_OPS_TOKEN:-}" ]]; then
  [[ -r "$OPS_TOKEN_FILE" ]] || { echo "ops: 读不到管理密钥 $OPS_TOKEN_FILE(可用 OCTOPUS_OPS_TOKEN 覆盖)" >&2; exit 1; }
  OCTOPUS_OPS_TOKEN="$(tr -d '[:space:]' <"$OPS_TOKEN_FILE")"
fi

api() { # api METHOD PATH [json-body]
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Authorization: Bearer $OCTOPUS_OPS_TOKEN" -H "Content-Type: application/json")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" "$OPS_URL$path"
}

api_code() { # api_code METHOD PATH JSON-BODY OUTFILE [MAX_TIME_S]
  local method="$1" path="$2" body="$3" out="$4" max="${5:-120}" code
  local args=(-sS -o "$out" -w '%{http_code}' --max-time "$max" -X "$method"
              -H "Authorization: Bearer $OCTOPUS_OPS_TOKEN" -H "Content-Type: application/json")
  [[ -n "$body" ]] && args+=(-d "$body")
  code="$(curl "${args[@]}" "$OPS_URL$path" 2>/dev/null)" || true
  echo "${code:-000}"
}

die() { echo "ops: $*" >&2; exit 1; }
