#!/usr/bin/env bash
# ops/status.sh — one screen: deploy state, watermarks, tickets, bot liveness.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

echo "== 部署 =="
api GET /api/deploy | jq -r '
  "base=\(.base_branch) stable=\(.stable_branch) may_deploy=\(.may_deploy)",
  (if .active then "ACTIVE #\(.active.id) \(.active.status) target=\(.active.target_sha[0:10]) by \(.active.triggered_by)" else "active: (无)" end),
  (.recent[]? | "  #\(.id) \(.status) \(.target_sha[0:10]) by \(.triggered_by) @\(.created_at)")' | head -12

echo "== 水位 =="
repo="$(git rev-parse --show-toplevel 2>/dev/null || echo "$OPS_REPO_ROOT")"
for ref in "$OPS_BASE_BRANCH" "$OPS_STABLE_BRANCH"; do
  printf "  %-8s %s\n" "$ref" "$(git -C "$repo" log -1 --format='%h %s' "$ref" 2>/dev/null || echo '(不存在)')"
done
run_dir="${OCTOPUS_RUN_TREE:-$OPS_REPO_ROOT}"
printf "  %-8s %s\n" "线上" "$(git -C "$run_dir" log -1 --format='%h %s' 2>/dev/null || echo '(读不到)')"

echo "== 主基线树 =="
primary_tree="${OCTOPUS_PRIMARY_TREE:-/home/ubuntu/lht/octopus}"
if git -C "$primary_tree" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  primary_branch="$(git -C "$primary_tree" branch --show-current)"
  primary_head="$(git -C "$primary_tree" rev-parse HEAD)"
  base_head="$(git -C "$primary_tree" rev-parse "$OPS_BASE_BRANCH")"
  dirty="clean"
  [[ -z "$(git -C "$primary_tree" status --porcelain)" ]] || dirty="DIRTY"
  aligned="aligned"
  [[ "$primary_head" == "$base_head" ]] || aligned="STALE"
  printf "  %s branch=%s %s %s head=%s\n" "$primary_tree" "$primary_branch" "$dirty" "$aligned" "${primary_head:0:10}"
  if git -C "$primary_tree" rev-parse --verify -q "refs/remotes/origin/$OPS_BASE_BRANCH" >/dev/null 2>&1; then
    divergence="$(git -C "$primary_tree" rev-list --left-right --count "$OPS_BASE_BRANCH...origin/$OPS_BASE_BRANCH")"
    printf "  local...origin/%s = %s (fetch only; do not auto-pull)\n" "$OPS_BASE_BRANCH" "$divergence"
  fi
else
  printf "  %s (读不到)\n" "$primary_tree"
fi

echo "== 工单 =="
api GET /api/tickets | jq -r '.counts as $c | "counts: \($c)", (.tickets[]? | select(.dev_status != "gated" or .deploy_status != "verified") | "  #\(.id) [\(.kind)/\(.dev_status)\(if .deploy_status then "·"+.deploy_status else "" end)] \(.title)")' | head -15
