#!/usr/bin/env bash
# Compatibility notice for the retired manual confirmation flow.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
api GET /api/deploy | jq '{active, recent: [.recent[0:3][] | {id,status,target_sha,detail}]}'
die "人工存活确认已停用：启动健康门通过即成功；启动失败自动恢复上一个验证包"
