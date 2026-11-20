#!/usr/bin/env bash
# ops/ticket.sh — ticket-panel buttons from the terminal.
#   ticket.sh list
#   ticket.sh show <id>
#   ticket.sh create <requester> <title> <body…>   # 代提;requester 即验收人。
#       可加环境变量 KIND=simple|complex MODEL=<model-id>(默认服务端定)
#       body 也可从 stdin 喂:ticket.sh create lht "标题" - < body.md
#   ticket.sh msg <id> <text…>       # 对话框发言(送达 agent 下一轮)
#   ticket.sh approve <id>           # 「确认方案,开始开发」
#   ticket.sh requeue <id>           # needs_human → 重新排队
#   ticket.sh kind <id> simple|complex
#   ticket.sh cancel <id>
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cmd="${1:-list}"; id="${2:-}"
case "$cmd" in
  list)
    api GET /api/tickets | jq -r '.tickets[] | "#\(.id) [\(.kind)/\(.dev_status)\(if .deploy_status then "·"+.deploy_status else "" end)] \(.title)  (by \(.requester))"' ;;
  show)
    [[ -n "$id" ]] || die "用法: ticket.sh show <id>"
    api GET "/api/tickets/$id" | jq '{ticket: .ticket, messages: [.messages[] | {author, via, body, created_at}]}' ;;
  create)
    requester="$id"; title="${3:-}"
    [[ -n "$requester" && -n "$title" && -n "${4:-}" ]] || die "用法: ticket.sh create <requester> <title> <body…|->"
    shift 3
    if [[ "$1" == "-" ]]; then body_text="$(cat)"; else body_text="$*"; fi
    payload="$(jq -cn --arg r "$requester" --arg t "$title" --arg b "$body_text" \
      --arg k "${KIND:-}" --arg m "${MODEL:-}" \
      '{requester:$r, title:$t, body:$b} + (if $k != "" then {kind:$k} else {} end) + (if $m != "" then {model:$m} else {} end)')"
    api POST /api/tickets "$payload" | jq -c '{ok, id: .ticket.id, dev_status: .ticket.dev_status}' ;;
  msg)
    [[ -n "$id" && -n "${3:-}" ]] || die "用法: ticket.sh msg <id> <text…>"
    shift 2
    api POST "/api/tickets/$id/message" "$(jq -cn --arg b "$*" '{body:$b}')" | jq -c '{ok, id: .message.id}' ;;
  approve)
    [[ -n "$id" ]] || die "用法: ticket.sh approve <id>"
    api POST "/api/tickets/$id/approve-spec" '{}' | jq -c . ;;
  requeue)
    [[ -n "$id" ]] || die "用法: ticket.sh requeue <id>"
    api POST "/api/tickets/$id/requeue" '{}' | jq -c . ;;
  kind)
    [[ -n "$id" && -n "${3:-}" ]] || die "用法: ticket.sh kind <id> simple|complex"
    api POST "/api/tickets/$id/kind" "$(jq -cn --arg k "$3" '{kind:$k}')" | jq -c . ;;
  cancel)
    [[ -n "$id" ]] || die "用法: ticket.sh cancel <id>"
    api POST "/api/tickets/$id/cancel" '{}' | jq -c . ;;
  *) die "未知子命令 $cmd(list|show|msg|approve|requeue|kind|cancel)" ;;
esac
