---
decision_status: accepted
realization_status: partial
supersedes: []
superseded_by: []
tickets: [296, 299, 301]
---
# ADR 0010:外部资源按拥有权常驻、按调用判定可用、恢复时通知等待的 agent

- 日期:2026-08-22
- 状态:**Accepted**;实现状态 partial(工单车道已落地,聊天/HQ/MCP 端点的通知器待接)
- 触发:#296/#299/#301 在 CI 机器恢复后仍然没有机器工具,也没有人告诉它们机器回来了
- 设计全文:`doc/design-resource-recovery.md`

## 决定

- 经 Octopus 启动的 agent 所持有的外部工具,其**存在**由拥有权/授权决定,其**可用性**在每次调用时判定;不再在回合开始时按资源在线与否增删工具。
- 调用不可达资源必须返回带固定标记的结构化失败:`资源暂不可达 ⟨<kind>:<id>⟩:<原因>`,并由 agent 进来的那扇门(能力回环、流水线同步、后续的 MCP 端点)把 `(scope, resource)` 登记为持久化等待者。
- 资源提供方必须发布恢复事件(Runner 网关:设备注册 → `recovered("runner:<owner>/<device>")`);恢复时按 scope 前缀把等待者交给对应通知器;通知失败保留等待者。
- 工单 agent 的通知器是一条 pipeline 消息:空闲工单由它唤醒,运行中的回合以 priority-now 插入;文本说明工具一直在、先 `devpipe_ci_sync` 再继续。
- `runner_offline`(没发出)与 `runner_gone`/`runner_timeout`(结果未知)是两类错误码,永不共用。

## 原则

- 提示词不得描述回合里没有的工具,也不得隐藏回合里有但此刻不可达的工具;两种情况都必须如实说明。
- 登记的作用域只来自可信的 grant label,不来自请求体。
- 恢复通知只说"可以再试",不重放任何失败的调用。

## 非目标

- 不改变任何授权边界、设备所有权或 `runner_device_scope` 语义。
- 不在 bot 重启后重放 `append_session` 等写操作。
- 不为一次链路抖动合并或去重多次恢复通知(文本含计数即可)。

## 风险

- 等待者在工单落地/取消后才恢复:通知器丢弃之。
- 没有通知器的作用域(暂未接入的 bot 类型)会累积等待者;表可查,接入通知器后自然消化。

## 被拒绝的替代方案

- 在回合开始时等待资源上线再发车:把 agent 的整轮绑在链路上,CI 机器黑洞 10–48 分钟时什么都做不了。
- 让 agent 自己轮询 `machines_list`:设备级 grant 无枚举权,且轮询本身就是"反复重试"。
- 用 MCP `tools/list_changed` 动态增删工具:三个 CLI 对它的支持不一,且工具消失本身就是信息丢失。
