---
decision_status: proposed
realization_status: not_applicable
supersedes: []
superseded_by: []
tickets: [151]
---
# Octopus 收敛“留 / 让”线

> **全文状态：提案草案,待用户确认后才执行任何退役/降级。**
>
> 本文不是退役决定，不授权删除代码、停止服务、改变默认路由、收窄兼容性、迁移数据或发布/部署；
> 本次交付只把候选边界、证据、风险和可能路线写清，供用户逐项确认。

- 日期：2026-08-15
- 状态：**Proposed / 未接受**
- 触发：战略审查指出 A 轨完成了真实的治理，但还没有完成“让出通用 harness 职责”的减法
- 依据：`/home/ubuntu/lht/octo-coordination/reports/verify-intent-report.md`，尤其 §三
  “治理，还不是收敛”与 §七纠偏 4；仓库 `architecture/atlas.json`；commit
  `c94c5d5ae325c804bef4c1cbf73ba1f67ba25215` 的 Architecture Observatory clean 快照
- 相关已接受边界：[ADR 0001](./0001-session-plus-trust-boundaries.md)、
  [ADR 0002](./0002-agentic-app-publisher-trust-and-capability-grants.md)、
  [ADR 0007](./0007-guarded-shared-state-machine-apps.md)、
  [C3 fleet reference hosting profile](./2026-08-15-c3-fleet-reference-profile.md)

## 1. 提案要解决什么

> **提案草案,待用户确认后才执行任何退役/降级。**

Octopus 的目标不是成为另一个单信任域 agent harness，而是在每个用户拥有一个完整 dsh（或其他
单信任域端点）的世界里，提供端点之间不可替代的多用户层：身份、跨用户授权、资源契约、共享
App、通知和可撤销的能力织物。

A1/A4/A5/A6 已经解环、拆组合根、拆 Store 和消除重复 UI；这些工作让保留部分更健康，但没有回答：
现有 Octopus 自有 engine、agent 会话 UI、App runtime 和单机执行路径中，哪些职责以后不应继续
长在 Octopus。没有这条线，代码可以一边被治理，一边继续作为第二套 harness 扩张。

本提案因此只做三件事：

1. 定义长期应由 Octopus **留**住的核心；
2. 列出需要用户逐项裁决的 **让**候选及迁移条件；
3. 在裁决前提出“冻结新投入”护栏，阻止候选面继续无意识增重。

## 2. 判线原则

> **提案草案,待用户确认后才执行任何退役/降级。**

一项能力满足下列任一条件，倾向于“留”：

- 它决定用户 A 是否可触达用户 B 的对象，或必须在撤销时跨端点立即失效；
- 它为不同 harness 提供同一份有界 typed-port 契约、资源句柄或拒绝语义；
- 它维护多用户共享事实、App 发布身份、授权证据、通知投递或跨用户审计；
- 它必须从可信闭包绑定身份、对象和 scope，不能相信 View、dsh 或消息 payload 自报。

一项能力同时满足下列特征，倾向于“让”：

- 即使与 Octopus 断网，它仍是一个用户在自己机器/实例内完成 agent 工作所必需的；
- 它拥有模型/CLI adapter、agent loop、本地 transcript、工作目录、插件、终端或本机工具生命周期；
- 它主要优化单用户 composer、会话名册、文件浏览或本机执行体验；
- Octopus 只需经 typed port 读取有界投影或提出动作，不需要成为该能力的事实源。

两个重要的反例：

- “代码在 Octopus 仓库里”不等于必须留；
- “代码可以搬到 dsh”也不等于应该让。共享 App 的 ACL、动作裁决、事件链和 viewer-safe 投影仍是
  多用户权威面，不能为了减行数下放给某一个用户的 dsh。

目标关系是：

```text
每用户 dsh：本地 UI / agent loop / 插件 / transcript / workspace / machine effects
       │
       │ harness-specific thin seam
       ▼
Octopus typed ports ── tentacle fabric ── capability-kernel Gate ── 另一用户 dsh
       │                                      │
       ├── identity / Store / notify           └── 每次跨用户访问重新裁决
       └── App registry / shared App state / viewer-safe projection
```

## 3. “留”的核心

> **提案草案,待用户确认后才执行任何退役/降级。**

### 3.1 Gate / capability-kernel

保留唯一的跨用户强制力：Object、Context、逐层衰减、mandatory policy、approval 恢复时重进原
Gate、撤销后销毁派生能力。dsh 的本地 per-call ask 是端点自己的门，不能替代 Octopus 的
standing cross-user grant；Octopus 也不能替 dsh 回答本地 ask。

### 3.2 typed-port 契约

保留 provider-neutral 的动作、参数上限、投影、refusal、request/response echo 和生命周期契约。
View、dsh、pi、旧 Runner 或未来端点都只实现契约；harness 的事件词表、路径、凭据、设备名和工具
实现不进入契约。协议平台无关，seam 才允许平台专属。

### 3.3 Store

保留多用户和控制面的 durable truth：身份、登录/设备证据、grants、对象与撤销、App release/
activation、共享 App 事件、投递/审计 receipt、通知游标及必要的兼容迁移。

Store 不应继续成为 dsh 本地 transcript、prompt 草稿、workspace 内容、插件配置、模型设置或工具
日志的第二事实源。为迁移保留的只读索引必须标明来源、TTL 与可删除性。

### 3.4 notify

保留跨 App、跨用户和跨 channel 的有界通知意图、投递状态与去重；飞书等 channel adapter 仍是
Octopus 的不可替代入口。通知只携带契约允许的摘要或 opaque resource，不复制完整 dsh 会话作为
新的权威历史。

### 3.5 App registry 与共享 App 权威面

保留 publisher/source/build/package digest 链、安装与 active pointer、permission contract、
release availability，以及共享 App 的 ACL、事件链、纯 action/projection 和 viewer-scoped 投影。
App View 继续只渲染 projection、只 propose 已声明 action；身份、role、scope、approval 和
capability 均由 trusted Host 绑定。

`app-runtime` 的 release-bound 纯计算和 `app-state` 的共享事件事实因此不是整体“让”候选。候选仅是
其中替用户运行模型/CLI/本机副作用的部分，见 §4.5。

### 3.6 身份

保留 provider-neutral 的用户/principal、GitHub/飞书等登录绑定、browser session、设备 `rt_` 与
衰减 `mcp_` 凭据、撤销和审计。dsh 可以确认自己的本地操作者，但不能铸造 Octopus 跨用户身份，
也不能通过请求 payload 选择 owner 或 target。

### 3.7 跨用户织物面（tentacle）

保留连接认证、目标路由、可靠 ACK/去重、schema-pinned Object adapter、逐次 Gate、投影裁剪和
撤销 stop。tentacle 核心必须继续对 harness 零知识；dsh/pi 形状只在各自 seam。当前 dsh transcript
词表仍长在 Octopus 本体的部分是待收窄债，不应扩写成通用 dsh runtime。

### 3.8 已接受的相邻边界：fleet 不是核心产品面

[C3 fleet ADR](./2026-08-15-c3-fleet-reference-profile.md) 已独立接受：每用户 dsh 的认证入口、
OS/网络隔离、凭据注入和最小 provision 只是一份 reference hosting profile，因为它们守的是用户间
边界或让端点最小可用。通用插件管理、dsh 配置代管、模型管理、计费套餐和 harness 内部运维不进入
上述“留”核心；它们属于 dsh 侧工具或外部托管系统。本文不重复改变该已接受护栏。

## 4. “让”候选及路线

> **提案草案,待用户确认后才执行任何退役/降级。以下均为候选，不是已批准计划。**

### 4.1 规模口径

下表来自 source watermark `c94c5d5ae325c804bef4c1cbf73ba1f67ba25215` 的 clean observatory
快照；此后至本文起草时的 `v4` 变化只有文档，不改变下列源码规模。`生产 codeLoc` 是
`files[].isTest == false` 的 `codeLoc` 之和；括号内是模块物理 LOC（含测试）。它们衡量当前审阅
表面积，**不是预计净删行数**。混合模块必须先拆权威职责与本地职责，不能按表格整包删除；各行也
不能简单相加，因为“家族上下文”会包含另一个候选的依赖。

| 候选 | 当前规模 | 初步处置 |
|---|---:|---|
| Bot 原生 `AgentSession` | 2,824（模块 LOC 4,716） | 退役候选 |
| Engine `AgentPlane` / CLI/MCP adapter | 1,201（2,111） | 退役候选 |
| 独立 v3 Host/factory 分发面 | 3,762（8,146），其中含必须先提取的共享 Host 职责 | 降为 registry/launch 薄面候选 |
| Octopus 原生会话/工作台 View | 5,662（13,204） | 降为薄投影候选 |
| App runtime 家族 | 2,216（5,251）；直接候选 `app-agents` 为 555（1,281） | 只让单用户 agent/effect 子面 |
| Runner/本机资源家族 | 11,383（27,325）；直接候选 `runner-device` 为 5,851（11,020） | dsh provider 替代候选 |

### 4.2 Bot 原生 AgentSession

**范围与规模。** `architecture/atlas.json` 的 `agent-session`：`packages/bot/src/session/`，
2,824 生产 codeLoc / 4,716 模块 LOC。它持有 Claude SDK、OpenAI 请求、plugin/MCP 装配、queue、
resume、transcript 事件、workdir 和单机生命周期。

**为何属 dsh。** 这些都是单个用户的 agent harness 内部事务；每用户已有完整 dsh 后，Octopus 再
维护第二套模型连接、插件装配和本地 transcript 会形成双事实源，并持续追赶上游 harness 生态。

**候选路线。** 先让 dsh 经 typed session port 暴露 start/list/read/send/stop 与有界 activity
projection；Octopus channel、App 和 Dashboard 只持 opaque session ref。新会话默认路由 dsh 后，
旧 AgentSession 进入只修 bug 的兼容期；历史记录以只读 archive 投影保留，确认无调用者和回滚窗口
结束后，另提退役决定。

**风险与依赖。** `router`、飞书 channel、HQ/reporting、user-memory/user-skills、dev pipeline 与
`app-agents` 当前直接依赖它；dsh 不在线时的 IM 投递、长任务恢复、交互卡、quota/模型选择和旧
session resume 都必须有可观察的替代。dsh 与 Head 同时崩溃时尚无 durable outbound spool，当前
不足以批准完整退役。

### 4.3 Engine AgentPlane 与独立 v3 harness 面

**范围与规模。** `engine-agent` 为 1,201 生产 codeLoc / 2,111 模块 LOC；混合的
`engine-host + v3-host` 为 3,762 / 8,146，包含 HTTP surface、factory、frame delivery、capability
broker 和分发。后者不是整包可删范围。

**为何属 dsh。** model/CLI adapter、MCP shim、agent inbox/pump、factory 中的单用户 agent 配置与
本地工作台属于 harness。Octopus 不应继续发展一套平行 dsh 的通用 factory 与 agent runtime。

**候选路线。** 立即把新增 adapter/模型配置需求导向 dsh seam；先从混合 Host 中提取并保留
trusted frame、Gate binding、release identity 等共享职责，再把 `/factory` 和独立 v3 agent Host
降成“打开/连接用户 dsh”与 App registry 的薄入口。`engine-core` 中共享 action/projection 语义在
App registry 完成承接前继续保留。

**风险与依赖。** 现有 probe、devpipe、App packaging、frame hardening 和历史 v3 App 仍消费
engine public API；粗暴移除会连带削弱发布者信任、CSP 和共享 App 执行。必须先证明提取后的可信
闭包不扩大、旧 release 可回放、View-only 更新与版本路由不退化。

### 4.4 Octopus 原生 agent 会话 UI / 工作台

**范围与规模。** `agent-sessions-view` 4,450、`session-plus-view` 439、`chat-ui-commons` 773，
合计 5,662 生产 codeLoc / 13,204 模块 LOC。范围包含 roster/search/new/chat/operations、composer、
transcript、文件优先导航和 Session Plus 组合接线；它不等于全部 App View 生态。

**为何属 dsh。** 单用户会话创建、composer、transcript 浏览、模型/effort 选择、workspace/file
导航的主体验应由用户自己的完整 dsh 提供。Octopus 继续在这些交互上竞速，会把“多用户织物”重新
拉回通用 harness 竞争。

**候选路线。** 默认入口逐步改为受认证的用户 dsh UI。Octopus 只保留薄投影：跨用户共享摘要、
批准/拒绝、通知、presence/health、opaque deep link，以及飞书/无浏览器场景所需的有界文本视图。
薄 View 不维护第二业务状态机，不提前显示权威变化，也不获得身份或 capability 坐标。先冻结新的
单用户工作台增强，再以真实流量与功能矩阵逐模块降级，而不是一次删除整个 View 包。

**风险与依赖。** Session Plus 同时是 typed-port、App module 和浏览器信任边界的验证样板；它还
承载草稿保持、request_user_input、文件链接、跨设备 roster 与 App hot-release 验证。dsh UI 的
认证 origin、可访问性、移动端、IM fallback 和深链稳定性未达到对等前，不得降级这些路径。

### 4.5 App runtime 中的单用户 agent/effect 子面

**范围与规模。** 当前家族为 `app-agents` 555、`app-runtime` 250、`app-state` 725、
`engine-runtime` 686，共 2,216 生产 codeLoc / 5,251 模块 LOC。**直接“让”候选只有
`app-agents` 的 agent loop 与未来接入的单用户 effects**；其余数字是拆分上下文，不是删除目标。

**为何属 dsh。** 某用户代理 App 调模型、跑 CLI 或操作自己的机器，是该用户 dsh 的执行职责。
Octopus 应决定这个 actor 是否可以对共享对象提出动作，而不应替 actor 托管另一套模型 loop。

**候选路线。** 保留 `app-runtime` 的 release-bound、无状态、纯 JSON action/projection 计算和
`app-state` 共享事件链；把 App agent 变成 dsh 上的 remote actor，通过 typed port 接收有界 inbox、
提出声明动作，所有 effect 仍由可信 Gate 绑定并逐次裁决。个人 App 的任意本地 backend 可整体在
dsh；多人 App 的状态机与 viewer-safe projection 继续在 Octopus。

**风险与依赖。** 必须保住真实 actor、预算、幂等/重放、inbox cursor、state revision、release
digest、Agent 不继承 human auto-allow、撤销后停止和 dsh 离线语义。若把共享 fold 下放到某一用户
dsh，会产生单方控制多方事实的错误拓扑，因此明确禁止。

### 4.6 Runner 与单机资源执行路径

**范围与规模。** `runner-device` 直接执行机器 probe、workspace、terminal、agent 和副作用，
为 5,851 生产 codeLoc / 11,020 模块 LOC。连同 `runner-authority`、`workspace-files-plane`、
`session-resource`、`resource-stream-broker` 的当前家族为 11,383 / 27,325；后 5,532 生产 codeLoc
混合了应留的 Gate/provider mediation，不是整包退役目标。

**为何属 dsh。** 文件、终端、workspace、模型进程和本机工具的实现都在一个用户的单信任域内。
dsh 已拥有这些能力与本地 ask；Octopus 只需跨用户地发现一个有类型的资源、铸 Object 并转发，
不需要维护自己的设备执行器。

**候选路线。** 让 dsh seam 实现现有 typed session/files/resource-stream contracts；所有跨用户
调用继续经 tentacle + Gate。新本机能力不再扩 Runner RPC；先把 Runner 标为 legacy provider，
保留非 dsh/旧设备兼容 adapter，完成自托管非 fleet dsh 常驻验收和使用量归零后，再分别决定停止
配对、只读兼容、最终移除 `runner-device`。

**风险与依赖。** 当前 App resources、Session Plus、CRDT、workspace-files 写路径、CLI hooks、
Windows/非 Linux 端点和部署运维都依赖 Runner。迁移必须保持 expected digest、atomic replace、
`retrySafe`、pull/cancel/single-in-flight、审批不风暴和 revoke-after-await；dsh seam 的 pre-1.0
升级债及 durable spool 也是阻塞项。

## 5. 冻结新投入护栏

> **提案草案,待用户确认后才执行任何退役/降级。此护栏本身也要用户确认后才成为工程政策。**

在用户确认本 ADR 前，建议把下列检查作为评审问题；确认后才可升级为强制门：

任何新功能若主要落在 §4 的候选面，brief/PR 必须先回答：

1. 它守的是用户与用户之间的边，还是只改善一个用户自己的 harness 体验？
2. 为什么不能由 dsh provider 实现现有 typed port，再由 Octopus 做薄投影？
3. 它是否新增模型/CLI adapter、agent loop、composer/transcript、workspace、插件或机器副作用？
4. 它是迁移使能、安全/兼容修复，还是让候选面的永久产品扩张？
5. 若仍投 Octopus，实现中哪里留下明确 seam、使用量证据和撤回条件？

默认裁决建议：

- **允许**：安全修复、数据保全、迁移使能、typed contract、Gate mediation、兼容期可观测性；
- **先质疑，默认不投**：新的本地模型/agent adapter、原生单用户会话 UI、Runner 本机能力、通用
  fleet 插件/配置管理、个人 App backend 托管；
- **必须单独用户确认**：改变默认路由、停止兼容、冻结数据写入、迁移/删除历史、移除包或服务。

例外不能只写“以后会迁移”；必须说明为什么现在不做 dsh 侧、期限/owner、对目标边界的净影响。

## 6. 若用户接受，建议的后续决策顺序

> **提案草案,待用户确认后才执行任何退役/降级。**

1. **只确认边界与冻结护栏。** 不改路由、不删代码；给候选面加 usage/依赖观测。
2. **先补 dsh provider parity。** 优先 session/files/resource-stream 与自托管 dsh 常驻验收；补
   Head+dsh 双崩溃恢复故事。
3. **新流量先走 dsh。** 仅对新用户/新会话 opt-in，旧路径保留可回滚，不迁移共享 App 事实。
4. **原生 UI 降为薄投影。** 先保 IM、跨用户分享、审批、通知和 archive，再减少单用户工作台。
5. **逐候选单独退役。** 每一项都要新的实施 brief、数据迁移/回滚、真实验收和用户确认；本 ADR
   即使被接受，也不自动批准任何一项删除。

## 7. 本提案明确不做

> **提案草案,待用户确认后才执行任何退役/降级。**

- 不退役、不降级、不删代码，不改变 feature flag、路由、Store schema、fleet、Runner 或 App release；
- 不宣布 dsh 已具备全部 parity，不把 pre-1.0 seam 风险隐藏在“薄适配”口号里；
- 不把共享 App runtime、App state、Gate 或身份下放给某一用户 dsh；
- 不以 LOC 目标驱动拆分，不为得到净删数字破坏可信闭包；
- 不把本提案的“冻结建议”伪装成已经生效的治理政策。

## 8. 接受与复审条件

只有用户明确接受后，本文才可从 Proposed 改为 Accepted；接受边界不等于接受退役。每个候选进入
实现前，还需记录 owner、依赖清单、流量/数据证据、迁移与回滚、dsh parity、非 fleet 接入验收和
新的用户确认。

每次 observatory 模块边界、dsh 主版本、tentacle 契约或共享 App 权威模型发生实质变化时复审本线。

> **终止标记：提案草案,待用户确认后才执行任何退役/降级。**
