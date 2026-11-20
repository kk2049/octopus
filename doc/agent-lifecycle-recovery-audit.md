# Agent 托管与恢复审计（2026-09-16）

## 结论

Octopus 已经共享 provider 控制和会话操作协议，但还没有覆盖所有入口的持久托管生命周期。工单、Sessions+、自动科研台不是三种完全不同的 agent；它们是不同的意图/授权入口，最终调用相同 Runner。应统一依赖等待、恢复协调和状态投影，保留工单交付、项目权限、会话输入等领域边界。

本次交付修复工单 603 暴露的恢复断点，并以既有 resource_waiters 提供通用暂停原语。它没有把 Sessions+、Research、外部 CLI 全部迁到新的 supervisor；下文是后续重组计划，不能视为这些入口已经具备一分钟等待恢复。

## 603 的证据链

- 2026-09-16 06:10:10 UTC，原 start_session 收到 provider 的 model at capacity 终态；该轮按预期结束。
- 06:12 起 4090 的设备心跳消失，06:13:11 网关确认断线。用户随后两次继续输入（消息 3416、3418）在开发工作区预检失败；没有生成 append_session 操作，消息却被标成已消费且失败。
- 当时没有该工单的 resource_waiter，因此上线事件没有可唤醒的意图。原会话与脏开发树仍在；这不是工作丢失，也不是 capacity 本身导致的挂死。
- 06:39 UTC 设备自行注册上线，SSH 和 Runner 均恢复。人工确认原开发树保留了 UI 与测试的未提交修改。
- 另一个独立断点：旧工具恢复通知写入的消息预设 delivered_turn，调度器只取 delivered_turn IS NULL，因此“通知成功”也可能没有实际续跑。

## 当前抽象及缺口

| 层 | 已共用的实现 | 仍缺什么 |
|---|---|---|
| Provider 与身份 | Runner AgentControlPlane、AgentRuntimeRegistry、ProviderSessionRefs；Codex/Claude/OMP 原生会话统一控制 | 运行状态与恢复状态分散，不能从一个持久模型区分等待依赖、终态、未知 |
| 输入/操作 | Runner SessionOperationJournal，Head SessionOperationCoordinator，provider 接收回执与原操作查询 | 工单 dev_runner_turns 是独立调度器；两侧不能各自决定重发或续跑 |
| 执行放置/授权 | SessionExecutionRegistry、原 owner/runtime/execution device/workspace 绑定与恢复 scope | 授权拒绝、依赖离线、准备失败缺乏贯穿所有边界的错误类型 |
| 设备恢复 | ManagedRecoveryJournal 保存 acknowledged active 轮次，Runner 启动后恢复原会话 | recoverInterrupted 的 recoverStarted 一次性开关；预派发恢复准备失败也 markUnknown，后续上线不会再次尝试 |
| Head 资源恢复 | ResourceRecoveryService、SQLite resource_waiters、Gateway presence | 旧实现先删 waiter 再通知；部分 scope 没有消费者；没有一个统一 supervisor 扫描全部受托意图 |
| 工单 | inbox、工作区准备、原 Runner 操作观察、本次 ResourceSuspension | 现已支持一分钟后显式等待、释放槽位、重启恢复；领域调度仍需适配统一 supervisor |
| Sessions+ / 科研台 | ResearchSessionPlane 明确复用 SessionResourceService、AppOperationBinding、SessionOperationCoordinator | receipt observer 最多轮询 30 分钟，主要恢复回执而非 agent 托管意图；暂未共用一分钟等待状态 |
| 其他 agent | App runtime agents、Router/HQ 等入口有自己的循环 | 不应因名称带 agent 就认定已纳入 Runner 托管；需要逐个登记恢复所有者 |

自动科研项目还可展示历史/外部 CLI 来源。可读的 transcript 不等于 Octopus 拥有输入权；provider 声明的 parent_owned 子 agent 只能通过父会话恢复。Sessions+ 和 Research 的权限合同应分别保留，不能把共用生命周期变成共用授权。

## 建议重组

不创建包罗万象的 Agent 基类。统一一个小型、持久的 ManagedExecution 契约：

- 稳定身份：execution ID、owner、source（ticket / session / research）、provider、logical/native session lineage、runtime 与执行 workspace。
- 意图与事实分开：desired = running / paused / cancelled；observed = preparing / running / reconnecting / waiting_resource / completed / failed / unknown。
- 恢复事实：dependency keys、first unavailable、next retry、last error class、dispatch operation ID、input receipt、recovery epoch/lease。
- 一个 resume owner：Head 负责入站意图、授权与依赖协调；Runner 负责 provider 进程与已接受轮次恢复。接口显式返回 query_original / resume_acknowledged / dispatch_prepared / wait / refuse，不能两边都发“继续”。
- Gateway 上线事件只唤醒协调器。协调器重新验证授权/原 workspace，查询原回执，证明可重试后才派发。启动扫描和低频检查弥补丢失事件；恢复过程再次重启仍沿用同一恢复 ID。
- transport_unavailable 才进入一分钟等待；authorization_revoked、workspace_missing、protocol_incompatible 可见拒绝；provider_capacity 是轮次终态；effect_unknown 保持查询，不能靠超时假定“未执行”。

## 分阶段交付与验收

1. **本次：修正 Head 工单等待。** 保留 inbox/operation ID、等待持久化、先通知后条件确认、真实唤醒、UI 重连与等待状态、暂停撤权保护。既有开发树和会话身份不变。
2. **下一步：Runner 恢复准备与派发分界。** ManagedRecoveryJournal 增加 retryable preparing/waiting；移除一次性恢复扫描的限制，采用每记录 single-flight 与有界重试。只有尚未越过 provider 派发边界的网络失败能自动重试；prepared/recovering 的不明崩溃窗口仍需原生证据。先覆盖同机与 split 放置，再接 presence/ready 事件。
3. **共享 Head supervisor 与投影。** 从本次 ResourceSuspension 提取稳定接口，分别接工单、SessionOperationCoordinator、Research；业务 inbox 和权限仍由各自适配器持有。将 30 分钟回执轮询停止改为持久等待，统一展示原因、等待时间、自动恢复承诺和暂停入口。
4. **入口审计与收口。** 逐个为 App runtime / HQ / Router 声明 managed 或 observed，指定恢复所有者；删除已被共享原语替代的私有 retry loop。外部 TUI、历史会话、parent_owned 子会话不得自动接管。

每一步单独落地部署；不需要一次性重写三套产品。发布门至少覆盖：10 秒闪断、超过一分钟掉线、模型机先于执行机上线、Head/Runner 在恢复各阶段重启、重复/丢失 presence、scope 过期重签、撤权/暂停/取消、原工作区缺失、capacity、未知执行结果、恢复中第二次掉电。断线演练应证明一个原输入最多派发一次、原工作树未重建、任务在可见状态等待、授权已撤销的任务不会重启。

建议观察：waiting 数与年龄、恢复延迟、无人消费的 wait scope、长期 unknown 数、重复派发数、持有槽位的离线任务数。指标按入口和 provider 分组；不要采集 prompt 或凭据。

## 阅读入口

`packages/runner/src/agent-control-plane.ts`、`managed-recovery.ts`、`session-operations.ts`；`packages/bot/src/sessionhub/operations.ts`、`app-registry/research-sessions.ts`、`mcp/session-execution.ts`、`resources/suspension.ts`、`devpipe/pipeline.ts`。现行资源契约见 [资源恢复](./design-resource-recovery.md)。
