# 资源恢复:工具常驻、调用时判定、恢复即通知

状态:现行(2026-08-22;2026-10-15 起 v2 飞书聊天会话随 v2 组合根下线)。适用于所有经 Octopus 启动、通过 MCP/能力回环取得外部工具的 agent:工单 agent、HQ、以及后续接入同一回环的任何 bot。

## 1. 问题

Octopus 给 agent 的外部工具天然是动态的:笔记本 Runner、CI 容器、远端 DSH、飞书 MCP 后端都可能离线几分钟再回来。2026-08-21 夜里三张工单(#296、#299、#301)在 CI 机器 `lht-val15-ci` 可达的情况下整夜没有 `machine_*` 工具:

- 工单回合在**回合开始那一刻**判定机器是否在线,离线就整轮不给工具、提示词也不提(`bootstrap-v3.ts` 的 `ciMachineOpener` 要求 `deviceOnline`);
- bot 重启后流水线在 Runner 网关监听之前就恢复了回合,于是每次重启后的续跑回合都没有机器车道;
- 机器回来时没有任何东西告诉 agent,agent 以"基础设施阻塞"结束回合。

## 2. 三条规则

1. **工具按拥有权常驻,可用性按调用判定。** 请求人拥有配置的设备,就得到机器车道和工具,不看此刻在线与否。提示词如实说"设备此刻离线"。调用离线资源返回一个结构化失败,文本以固定标记命名资源:`资源暂不可达 ⟨runner:<owner>/<device>⟩:<原因>。已登记等待,资源恢复时会通知本会话…`(`resources/recovery.ts` 的 `unavailableMessage`)。
2. **不可达即登记等待。** agent 进来的那扇门负责登记:能力回环(`runner/loopback.ts`)知道 grant 的 label(= agent 作用域,如 `dev-ticket/296`、`chat-feishu/lht`、`hq/<user>`)和失败文本,解析标记后调用 `ResourceRecoveryService.note(scope, resource, detail)`。流水线自己的同步失败同理登记。等待标记持久化在 `resource_waiters` 表(migration 55),bot 重启不丢承诺。
3. **恢复按作用域通知。** 资源提供方宣布恢复(Runner 网关在设备注册时 `subscribePresence` → `recovered("runner:owner/device")`),服务取出该资源的所有等待者,按 scope 前缀交给注册的通知器:`dev-ticket/` 发一条 pipeline 消息(空闲工单被唤醒;运行中的回合以 priority-now 插入);通知失败或没有通知器的等待者保留,下次恢复再试。

## 3. 组件与边界

| 组件 | 职责 | 不做 |
|---|---|---|
| `packages/bot/src/resources/recovery.ts` | 等待者登记/取出/通知分发;标记文本的唯一定义;`runner:` 键的拼法 | 不知道 runner 是什么,不发消息 |
| `store/repositories/resource-waiters.ts` + migration 55 | 持久化 `(scope, resource)` 等待者与计数 | — |
| `runner/gateway.ts` | `runner_offline` 错误码(与 `runner_gone`/`runner_timeout` 区分:前者没发出,后者结果未知);`subscribePresence` | 不判断作用域 |
| `runner/dispatch.ts` | 把 `runner_offline` 变成 `ResourceUnavailableError`(携带资源键与标记文本) | 不登记 |
| `runner/loopback.ts` | 回环上的失败文本含标记 → 以 grant label 登记等待;返回 503 + `resource_unavailable` | 不通知 |
| `devpipe/pipeline.ts` | 注册 `dev-ticket/` 通知器;同步失败登记;提示词声明离线 | — |
| `bootstrap-v3.ts` | 组装:服务实例、网关在线事件 → `recovered`、回环与流水线注入;`ciMachineOpener` 改为按拥有权 | — |

信任边界没有变化:登记的 scope 来自可信的 grant label,不来自请求体;通知内容不携带设备数据;`runner_offline` 不会把一次真正发出的调用伪装成"没执行"。

## 4. 各类 bot 的落点

| 启动方式 | 进门的门 | scope label | 通知器 | 状态 |
|---|---|---|---|---|
| 工单 agent(devpipe) | 能力回环 + 流水线自身同步 | `dev-ticket/<id>` | pipeline 消息(唤醒/插入) | 已实现 |
| HQ | 能力回环 | `hq/<user>` | 待接 | 同上 |
| Session Plus / 外部 CLI 经 MCP 端点 | `mcp/service.ts`(非回环) | `mcp/<credential>` | 待接:会话通道系统消息 | 门与通知器都待接 |

待接的部分只需两步:在那扇门里 `parseUnavailable` 后 `note(label, …)`,再 `registerScope(prefix, notifier)`。服务、持久化与恢复事件是共享的。

## 5. 运维与观察

- bot.log:`resource unavailable; waiter recorded`、`resource recovered; waiters notified`、`devpipe: resource recovered; ticket notified`。
- 工单对话里出现 `⚡ 资源已恢复:<device> 重新在线(离线期间本票有 N 次调用被拒)`。
- `resource_waiters` 表可直接查看谁还在等什么。
- 关闭方式:不注入 `resourceRecovery`(流水线/回环都可选)。

## 6. 非目标与风险

- 不改变授权:离线设备的调用仍经过同一 Gate;`runner_device_scope` 等元数据不变。
- 不重放失败的调用:恢复通知只告诉 agent"可以再试",由 agent 决定重试什么。
- 等待者可能在工单已落地/取消后才恢复:通知器对这类工单直接丢弃等待者。
- 多次恢复抖动会多次通知同一工单(每次掉线后的失败会重新登记);文本含计数,agent 可据此判断链路不稳。

## 7. 工单启动/观察等待（2026-09-16）

工单调度接入 `ResourceSuspension`，用 `dev-ticket-launch/<id>` 区别工具调用的通知 scope。首次断线立即持久化，前一分钟每 5 秒探测，随后投影为 `waiting_resource`、每 30 秒兜底探测；Gateway presence 可立即唤醒。等待期间不占执行槽位。在线事件与旧失败回调交错时，以事件版本触发立即重查。

派发前保留原 inbox；派发后保留原 operation ID，仅查询其回执。暂停、取消和撤权阻止新输入；暂停已派发操作仍需向原设备确认停止。恢复不得重建原开发树或换会话。API `runtime_wait` 向工单页提供 reconnecting/waiting_resource、资源与起始时间，暂停入口在等待期间仍可用。

通知改为读取 waiter，回调成功后按快照条件确认删除；崩溃或再次失败不会提前吃掉等待。旧 `dev-ticket/` 恢复消息经普通未读 inbox 唤醒。通用 Runner dispatch 将只读超时/掉线转换成可等待的资源标记；有副作用的失联仍是 indeterminate。

这些语义本次只在工单编排完整接线。全部 agent 的统一托管恢复现状与分阶段计划见 [生命周期审计](./agent-lifecycle-recovery-audit.md)。
