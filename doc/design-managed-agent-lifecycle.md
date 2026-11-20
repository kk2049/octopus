# 托管 Agent 生命周期与灰度验收

状态：实现边界与可选验收清单；报告须区分实际验证、未运行及待用户验收。

统一稳定身份、期望状态、观测状态、依赖等待及恢复决策。领域适配器保留授权、
输入和结果的持久记录；不创建一个拥有所有工具和权限的 Agent 基类。Head 负责
受托意图，Runner 负责已接收 provider 轮次的续接。一次用户输入与一整轮工作分别
留证，不能把前者接收成功显示成后者完成。

## 实际生产消费者

此表按 `bootstrap-v3.ts` 的构造路径和已声明 App 校验。不能用文件名包含 agent
推断线上已启用；配置关闭的生产能力仍属于需要覆盖的发布面。

| 功能入口 | 当前实现 | 恢复所有者与效果边界 | 必须实测 |
|---|---|---|---|
| 工单开发、继续、CI 修复工单 | DevPipeline → TicketRunnerAccess → Runner | Head 保存 inbox/operation，Runner 保存已接收轮次；交付和合并锁归工单 | 新任务、capacity 后继续、split 工作区离线、Head/Runner 重启、暂停/撤权 |
| Sessions+ 新建、继续、接管、切换账号、停止 | SessionResourceOperationExecutor → SessionOperationCoordinator | 原操作回执与 provider 生命周期分开；接管/账号切换不能当普通 append 重试 | 两个虚拟用户、同机/split、用户可见等待、原回执恢复、停止 |
| Research 项目 lead agent 与会话动作 | ResearchSessionPlane → 同一 SessionResourceService/Coordinator | 项目及成员权限单独判定；不借用 Sessions+ 人工静默权限 | 真实科研 agent、实验输出、成员撤销、原项目续接 |
| 第一方 MCP 给会话发消息 | McpSurface → SessionOperationCoordinator (`mcp:sessions`) → SessionHubOperationExecutor | 与网页共用持久回执；bearer 身份仍需原有批准 | 真实父 agent 调用工具、批准/拒绝、原回执恢复 |
| dsh / 本机 CLI 跨端点执行与 split scope | SessionExecutionRegistry + Runner 协议 | 这是精确执行授权，不是独立 Agent；外部 CLI/父任务持有输入权 | 真实命令、scope 重签/撤销、子会话不直接接管 |
| App agents：Sessions+ keeper、科研 secretary / mcp、PPT presenter、Chess luna | 声明 app.yaml → AppAgentPlane → AgentLoop | Head HTTP 模型与 App actor Gate；App child 不得到网络或凭据 | 每个声明真实模型轮次和至少一次受控工具；approval 收束与恢复、撤权 |
| 讨论秘书与专题顾问 | DiscussionService → DiscussionModelClient → AgentLoop | 会议持续委托；公开发言有 outbox，未知发送不能重发 | 合成会议输入＋真实秘书/顾问；外发捕获，暂停/重启/未知效果 |
| 知识助手 | KnowledgeChatService → AgentLoop | 个人只读对话；没有 effectful 工具 | 两个用户知识对话、网络恢复、重启、隔离 |
| 外部 TUI、历史会话、provider parent_owned 子 agent | Runner discovery / projection | observed 或 parent；无自动输入权 | 可观察但无自动续跑/接管（负向验收） |
| HQ、engine probe | 旧原型；bootstrap-v3 不构造（旧 Router/SessionManager 已于 2026-10-15 随 v2 组合根删除） | 不把遗留代码误称为生产消费者 | composition 测试；不重新激活 |

研究中的入口必须进一步追踪到具体配置、action 和测试；本表不是通过清单。

## 恢复决策

- `desired=paused/cancelled`：不派发。授权撤销是拒绝，不是网络等待。
- `not_sent`：只有持久证据和当前授权均成立，Head 才可派发原意图。
- `sent/uncertain`：只查询原 operation ID；超时、缺失响应或进程退出不是未执行证明。
- `acknowledged_interrupted`：只由 Runner 恢复原 provider session lineage。
- 恢复先持久化 preparing，依赖离线保存等待；越过 provider 派发前写 dispatching。
  第二次重启可以重试 preparing/waiting，不能重放 dispatching。
- `provider_capacity`：正常终态；新输入可以开启下一轮，不自动无限重试模型容量限制。
- HTTP agent 的工具调用也有独立副作用边界，不能因为模型请求可重试而重放整个工具循环。

## 集成灰度路径

1. 从当前权威 v4 创建功能分支、独立源码/依赖/数据目录；4090 运行完整测试 Head。
2. 只使用虚拟用户与任务，关闭真实 channel/fleet/部署 worker。使用独立模型与执行
   Runner 注入断线和重启；既有 Runner 的多 Head 兼容验证不能替代候选 Runner 验证。
3. 端口只在 loopback 和 SSH 通道中可达。保留生产 control/update 归属，不让灰度 Head
   向生产常驻 Runner 推送中间构建。
4. 每个正向验收必须有真实模型输出/真实任务结果；单元测试、伪 provider 和 HTTP 200
   都不能替代它。外部通知使用明确捕获端，不能给真实用户发测试消息。
5. 记录精确候选 SHA、构建摘要、入口、task/operation/session ID、故障时间、状态迁移、
   原输入次数、任务副作用次数与最终结果。credentials、prompt 和用户历史不进报告。
6. 对照最新 v4 的并行落地重新核对消费入口和契约，合并后重新构建并验证受影响入口。
   结合已完成的真实灰度和最后改动的针对性测试，将完整 patch 送入现有合并锁/FF 门。
7. 正常 CLI 报告、知识回执、交付文档、land 与 deploy 门全部保留。验收材料不能豁免
   启动健康、精确水位、App 发布或 Runner bundle 激活。

## 故障验收矩阵

每项记录 pass/fail/blocked 与证据；禁止预填 pass。

- 10 秒闪断；超过 60 秒离线；超过旧 30 分钟 observer 截止仍能恢复。
- 模型机先上线、执行机后上线；重复/丢失上线事件；等待期间 Head 重启。
- Runner 在准备、等待、派发确认窗口、已接收轮次中重启；恢复中再次重启。
- 等待期间暂停、取消、撤权、共享 runtime 收回；异用户与 App actor 审批隔离。
- 原工作区缺失、协议不兼容、capacity、原操作结果未知；不重建或重发来掩盖错误。
- 原工作树及 session lineage 保留；一次输入至多派发一次；效果未知时保持可见。

旧审计文档的“每阶段独立上线”不适用于本次任务：用户要求完整集成灰度通过后一次上线。

## 声明与运行入口的区别

声明清单由 `architecture/managed-agent-consumers.json` 固化。Sessions+ `keeper` 有 backend，
但当前页面没有发送入口；通过既有 App inbox 的集成驱动验证。Research `mcp` 还作为
外部 Apps MCP 调用的 actor：这类单次 App 操作属于调用它的父 Agent，不另起一个恢复所有者；
其声明的 HTTP loop 路径单独验证。讨论过滤器是只读分流，顾问是无外部工具的 parent-owned 子调用。

不能把持久授权句柄当作 Agent。SessionExecutionRegistry 的工作是把允许的 runtime、执行设备、
workspace 和 credential 绑定起来；原生 Agent 的停止、续接和 provider lineage 仍归 Runner。
会话操作协调器只跟踪已经接受的输入回执，不在 Head 重启后重建浏览器临时批准并重发 prompt。

工单现在也由同一个 Head supervisor 调度。DevPipeline 仍独占 inbox、Runner operation、
工作树、工具 token、合并锁及交付状态。调度器在重启/唤醒时重读这些领域记录；已派发的
原 operation 只能查询。旧 `dev-ticket-launch/` 等待会迁入通用记录，不保留第二套恢复计时器。

HTTP agent 每次尝试重新打开当前 App/会议/知识授权。模型断线可重试；已经完成的工具
结果由 checkpoint 保留；不确定的工具副作用停在 unknown。批准是领域交接，不把 pending
批准卡当作断网任务循环重试。等待中的不同实例不占模型并发名额，同一实例仍保持串行。

## 可复用验收入口

`doc/runbooks/refactor-staging.md` 记录实验节点、候选构建、Runner 更新、真实模型验收、
最终同步与整体晋级方式。验收记录写在实验节点 artifacts 中，Git 仅保留有界结果与摘要。
`realAgentAcceptance=pending` 的启动回执只证明 Head 已启动，不代表真实任务已通过。
本次请求者最终选择：完成必要测试后正常合入、部署，由请求者验收；不以完整长时矩阵
或额外物料摘要检查作为新增上线门。

## 实现边界与灰度发现

Head 的 `ManagedExecutionSupervisor` 使用独立持久记录、revision/lease 围栏及有界并发，
领域适配器重读当前权限。迁移 77 只新增表；checkpoint 私有且有大小上限。Runner 继续使用
兼容 v2 的本地恢复账本；在线事件唤醒与定时扫描并存，事件不是授权。等待一分钟后明确
显示等待环境恢复，显式 stop 清除托管意图。App 的可信 Host 仅显示当前授权 scope 的有界
状态和最终答复，3 秒只读查询不会重试写操作，stop 通过同一调度器取消。

真实故障演练发现了三个仅靠模型 mock 难以覆盖的问题：Codex 包装进程退出后原生子进程
仍持有 writer lease；split 私有目录的首次读取与后续推送读取走不同路径，造成已停止却仍
显示等待；Codex MCP 空表单确认被静默拒绝。修复分别使用受托进程组的有界关闭、精确
session 授权下的同一日志目录投影，以及原有用户批准 broker。带字段表单和 URL elicitation
仍不自动接受；恢复 scope 必须再次检查持久 token 有效性，不能从缓存 grant 复活已撤销授权。

具体轮次和成功水位以灰度 artifacts 和最后 CLI 简报为准。设计矩阵包含负向、协议及并发
用例；单元测试负责穷举不可安全反复制造的窗口，真实 agent 负责逐个消费入口及实际故障。

批准卡片与可信交互绑定共用 `agent-sessions-contract.currentRuntimeOf`，按可比较的
`observed_at` 选择 roster/transcript 最新事实，平局或不可比较时沿用 roster。旧回执不能
挡住更新请求，更新的已清除状态不能被旧 transcript 复活；Runner 仍核对一次性请求。

共享 HTTP 工具循环位于 `managed-execution/loop.ts`，原 App 路径只保留兼容导出。
共享恢复适配器不反向导入 App 领域实现；atlas 将它登记为独立职责模块，避免新基础设施
隐入 Bot composition。架构审阅区分已有 finding 和本次新增循环，不以失败数量相同代替依赖分析。
