---
decision_status: accepted
realization_status: not_applicable
supersedes: []
superseded_by: []
tickets: [150]
---
# ADR — C3 fleet 是参考托管剖面，不是产品方向

- 状态：**已接受（架构护栏）**（2026-08-15）；2026-10-15 fleet 代码随 A8 清理删除（生产一直 `fleet.enabled: false`），本护栏仅作历史依据。
- 适用范围：`packages/bot/src/fleet/`、`/home/ubuntu/lht/octo-fleet`，以及所有以 fleet 为依赖的后续 brief
- 背景实现：[每用户完整 dsh 交付](../deliveries/2026-08-15-per-user-dsh-fleet.md)
- 运维边界：[Dashboard、Runner 与 C3 暴露面](../deploy-dashboard-security.md)

## 1. 决策

> **fleet 是 Octopus 接入织物的一份参考托管剖面（reference hosting profile），不是产品方向。**

它证明没有自有基础设施的用户也能获得一个受隔离、可认证、可接入 Octopus Gate 的 dsh 端点；
它不把 Octopus 变成 dsh 托管平台，也不改变自托管 dsh 与 fleet dsh 使用同一 Tentacle 协议、
同一 `rt_` + `mcp_` 注册门和同一 capability Gate 的事实。

每个新增或扩大的 fleet 功能必须且只能归入以下一类，并在 brief、ADR 或 delivery 中写明分类和
最小必要性：

1. **用户间边界强制**：阻止一个用户冒充、观察、进入或调用另一个用户的资源。包括 OS/网络
   隔离、浏览器认证、Host/Origin/session 绑定、端口选择的可信闭包，以及 `rt_`/`mcp_` 凭据的
   铸造、衰减、轮换、撤销和失败关闭。
2. **最小 provision**：只完成参考实例从“没有”到“可安全接入 Gate”所必需的安装与生命周期。
   包括固定且可审计的 dsh/Tentacle 构件、一个用户一个实例、有界资源、启动/停止、证明实例与
   Tentacle 同时健康所需的探针，以及失败时回到已知可用构件的回滚。

无法明确归入其中一类的功能默认拒绝。不能用“fleet 已经监管进程”“方便集中运维”或“以后可能
需要”作为第三类理由；拆成若干步骤后仍须逐步满足同一判据。

## 2. 拒绝的托管代管面

Harness 内部事务仍归 dsh 及其生态所有。下面这些能力不得进入 Octopus fleet 控制面：

- 通用 dsh 插件目录、安装、升级、卸载、套装、依赖求解或 App → dsh 插件声明；
- 对任意 `dsh.profile`、模型、provider、agent preset 或用户工作区配置的集中代管；
- 按量计费、用量产品化、租户套餐或以商业托管为目标的计量面；
- 与用户间边界无关的通用 harness 运维工作流。

确有用户价值时，这些能力应实现成 dsh 侧工具或贡献给 dsh 上游，由 dsh 自己定义配置、权限、
持久化和交互语义。Octopus 可以通过既有 Tentacle/capability 契约调用一项有界能力，但不得复制
其事实源或在 fleet 中建立第二套管理面。

## 3. C5 的唯一允许范围

C5 不再是“舰队插件管理”。它只可负责 **Octopus Tentacle 自身版本**在参考 fleet 实例中的
分发与升级：选择已审核且 digest/revision 固定的 Tentacle 构件，经最小 provision 路径切换，
验证 Gate 注册与健康，并在失败时回滚到上一已知可用版本。

这个例外属于上面两类的交集：Tentacle 是 fleet 端点连接 Octopus 身份与 Gate 的边界适配器，
其兼容版本是安全接入的必要构件；它不是授权 Octopus 管理其他 dsh 插件的先例。同一 Tentacle
构件还必须能由自托管 dsh 独立安装和接入，避免把开放织物退化为 fleet 专用协议。

C5 最初在本 ADR 接受时**不启动**；旧 brief 中的通用套装、profile 改写和“一键安装应用依赖”
至今仍不有效。

### 2026-08-15 实施授权补充

用户随后明确批准 C5 的收窄实现。实现仍受本 ADR 的二分判据约束，只增加：最多八项的审核
Tentacle release 集合（commit、tree、source-archive SHA-256 全固定）、每实例可审计的
desired/observed/previous/last-attempt 状态、显式 plan/switch 动作、Gate+dsh 双健康确认和
失败时的新凭据回滚。配置默认关闭；只增加既有 Dashboard 信任域内、要求 `Administer` 的
plan/upgrade 运维 API，没有浏览器 UI、普通用户入口或公网专用路由，也不自动切版本。

release 输入只有审核 ID；Octopus、Store 和 root helper 均不接受任意 URL、包名、profile、命令
或通用插件描述。实现与验收见
[`2026-08-15-c5-tentacle-distribution.md`](../deliveries/2026-08-15-c5-tentacle-distribution.md)。

## 4. 评审与验收门

任何 fleet 提案在开工前必须回答：

1. 它归入“用户间边界强制”还是“最小 provision”？被保护的边或不可再删的 provision 步骤是什么？
2. 若不由 Octopus 实现，是否会破坏跨用户隔离、身份真实性或参考端点接入 Gate？若答案是否，拒绝。
3. 是否读取、解释或改写了通用 dsh 内部状态？若是，移到 dsh 侧工具；Octopus 只保留有界契约。
4. 自托管 dsh 是否仍能通过同一 `rt_` + `mcp_` 路径完整接入 Gate？若不能，拒绝。
5. 是否已有固定构件、升级/滚动重建、健康判定与失败回滚故事？没有则不得扩面或部署。

delivery 必须逐项记录结果；“默认关闭”只能限制部署面，不能替代上述产品身份判断。

## 5. 影响与非目标

- 保留 C3 已交付的可选参考剖面及其安全加固，不删除现有 fleet。
- 后续投入优先维护协议开放性、身份与隔离边界；fleet 的功能数量不是产品进展指标。
- 不在本 ADR 中启动 C5、修改代码/配置、改动 Caddy 或部署生产。
- 不决定 dsh 上游如何设计自己的插件市场、配置工具或商业服务。

被否决的替代是把 C3 supervisor 视为通用托管控制面，并由此承接插件管理、配置和计费。该方案会
复制 harness 的内部职责，使 Octopus 的不可替代价值从跨用户 Gate/契约织物漂移到通用 dsh
托管，因此拒绝。
