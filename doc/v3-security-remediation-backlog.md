# v3 安全加固与延期项

> **历史文档。** 记录 2026-07 v3 阶段的安全事项与延期裁决，不是 v4 的当前 backlog；当前安全边界读 `doc/tcb-reading-guide.md` 与 `doc/adr/`，当前工作状态以工单系统为准。

> - 审查基线：`experiment/auth-opus5-kernel` @ `1f09a4c`
> - 本文只记录尚未完成、已接受延期或随功能启用才生效的安全事项。
> - SEC-01～03 已完成并移入 `doc/worklogs/2026-07-31-sec-01-03.md`，不再是待办。
> - **SEC-06 已完成**（2026-07-31），实现记录移入
>   `doc/worklogs/2026-07-31-session-hub-permissions.md`；下面第 4 节保留为架构
>   决策的正文，因为它记录的是**为什么**这条禁令存在，那部分不随实现完成而过期。
> - Session Hub 与权限中心的本轮执行规格见
>   `doc/development/session-hub-v3-execution-plan.md`。

## 1. 当前裁决

| 编号 | 当前结论 | 当前阶段动作 |
|---|---|---|
| SEC-04 | 依赖 advisory 是运维维护风险，不是当前权限架构缺陷 | 已接受延期；试运营阶段不处理，不交给本轮 Agent |
| SEC-05 | Object 语义跨长期持久化后的版本迁移风险当前不可达或影响很小 | 已接受延期；出现跨版本 durable capability/pending 后再处理 |
| SEC-06 | 不应把宿主机 Claude Code/Codex CLI 建成多用户云 App 的 Agent 后端 | ✅ **已完成**：部署执行分类 + 加载期 fail-closed + 启动 inventory + 负向测试 |
| SEC-07 | Delegate/Task owner binding 风险只在该旧功能启用时存在 | minimal-v3 关闭 Delegate；另行排期，不属于本轮 |
| SEC-08 | 文档/示例漂移是质量项 | 随触及模块修正，不单独阻断 Session Hub |
| SEC-09 | 全量测试负载下的偶发 timeout 是工程稳定性项 | 本轮只修由本轮改动引入或暴露的确定性问题 |

SEC-04/05 的“延期”不是声称风险不存在，而是负责人在当前内部试运营、第一方代码和
短生命周期权限前提下接受它们。对外部署、攻击面变化或 durable 授权模型变化时必须
重新评估。

## 2. SEC-04：依赖 advisory（已接受延期）

历史审查中 `pnpm audit --prod` 报告了 critical/high 传递依赖，涉及飞书 SDK 及其
依赖树。当前决定是不把依赖树清理作为 Session Hub/权限系统开发的前置门槛。

重新打开本项的触发条件：

- 准备对外或多租户正式部署；
- advisory 被证明可由公网输入到达；
- 直接依赖已有低风险升级路径；
- 合规或发布基线要求 critical/high 为零。

重新处理时必须做可达性分析、升级/override 兼容验证、全量构建测试和飞书真实链路
回归，不能只为了数字清零盲目覆盖传递版本。

## 3. SEC-05：持久 Object 安全语义版本（已接受延期）

历史问题是：若一个 ObjectId、operation 名和持久 capability/pending 跨软件版本
长期存活，而 operation schema、effect、policy 或 adapter 语义已经变化，旧授权可能
指向新含义。

当前阶段的 Context/roots 主要随进程和 session 生命周期结束，第一方 App 由管理员
维护，SEC-02 也已经处理 App 运行版本与权限契约扩大，因此本项暂不投入开发。

重新打开本项的触发条件：

- Grant、root capability 或 pending approval 开始跨进程/发布持久恢复；
- operation 同名升级且希望自动继承旧授权；
- 引入第三方/用户生成 App；
- 权限中心承诺展示并撤销长期稳定的 operation identity。

届时采用显式 `semanticVersion`/`semanticDigest`，覆盖 schema、effect、retrySafe 以及
显式 policy/adapter 版本；旧 identity 不允许静默套用当前版本。

## 4. SEC-06：禁止把本地 coding CLI 当公共 App Agent 后端（已实现）

> 2026-07-31 完成。本节保留的是**架构决策与理由**；具体落点、测试与残留边界见
> `doc/worklogs/2026-07-31-session-hub-permissions.md`。
>
> 实现的一句话摘要：`packages/engine/src/runtime/deployment.ts` 引入由运维配置
> 决定的执行分类（`cloud-multi-user` 缺省 / `local-owner` / `trusted-service`），
> 与 secure mode **组合而非合并**，且 profile 先答——所以 `secure_mode: false`
> 到不了这个判定。唯一谓词 `appAgentAdapterVerdict` 守住 manifest 加载、运行时
> 覆盖 API、`send()`、transcript 视图与轮次本身。

### 4.1 最终架构决策

Claude Code 和 Codex CLI 是完整的开发者代理：默认拥有原生文件、shell、网络、
配置、插件、会话和凭据语义。把宿主机上的一个 CLI 进程当成多用户公共服务，会把
过大的权限域、宿主凭据、资源竞争和跨会话状态带进应用 TCB。

因此，受支持的生产模型是：

```text
用户自己的 Claude/Codex/OpenCode CLI
  = 一个 owner-bound 的粗粒度外部资源
  = Session Hub 只控制 list/read/live/append/resume
  = CLI 内部工具权限由设备所有者配置

多用户云 App 的第一方 Agent
  = AgentPlane + 轻量 provider loop
  = 模型只得到声明过的 capability tools
  = callTool -> AgentRun -> ControllerRun -> Gate -> trusted adapter
  = 不得到宿主路径、shell、数据库、系统凭据或任意 MCP

Dev Factory
  = owner-only 的 system:dev-factory trusted service
  = 可以使用重型 coding CLI，但不伪装成普通 App Agent
  = 固定 repo/worktree/命令边界并完整审计
```

**`cloud-multi-user` 部署中的普通 App manifest 和运行时配置不得选择 `claude-code`
或 `codex` 作为 Agent adapter。** `secure_mode=false` 也不能替这种部署取消限制。
App Agent 和用户本地 CLI session 必须是两种不同的资源/类型/入口。

这不是全局禁用 CLI。以下路径明确不受本禁令影响：

- 现有 v2 `/sessions` 页面及其侧栏链接、scanner、search、rich transcript、live tail
  和 owner 发起的 append/resume。它们是在操作用户已有的 CLI session，不是在给 App
  配置一个公共 Agent 后端。
- 明确标记为 `local-owner` 的单人本地部署；它可以保留 CLI adapter，但启动日志和
  UI 必须说明它不提供多用户文件隔离承诺。
- `system:dev-factory` trusted service。它是 owner-only 特权执行路径，不是普通 App
  Agent。

“不受禁令影响”不等于没有身份控制：Session Hub 仍必须只向 owner 展示/续跑 session，
并让 list/read/live/append/resume 服从本轮建设的授权和撤销生命周期。

### 4.2 只禁原生工具是否理论可行

理论上可行：如果 Claude/Codex 进程从结构上只能看到几个 brokered capability
tools，原生 `Read/Write/Edit/Glob/Grep/Bash/NotebookEdit/Task`、网络工具、插件、hooks、
额外 MCP 和设置源全部不可用，那么 symlink 逃逸没有入口，CLI 只是一个昂贵的
tool-calling loop。

但“提示它不要用”或只加一张易漂移的 `disallowedTools` 黑名单不够。要把这种模式
称为安全，至少需要：

- 启动参数使用封闭 allowlist，未知/新增工具默认拒绝；绝不使用
  `--dangerously-skip-permissions`。
- 禁用项目/用户 settings、插件、hooks、skills、浏览器集成、自动 MCP 发现和子
  Agent；恢复旧 session 不能恢复更宽配置。
- 只装载服务端生成的 strict MCP 配置，工具参数仍进入统一 Gate，CLI 不持有资源
  token 或真实凭据。
- 使用短白名单环境；CLI 进程不能读取 bot 配置、capability 数据库、其他用户 home
  或宿主的 Claude/Codex 凭据。
- 最好运行在独立 UID/容器 worker 内；否则 CLI 自身漏洞仍发生在 bot 的 OS 权限域。
- 每次 CLI 升级都重新验证工具集合和 fail-closed 行为。

这套证明和运维成本高于直接使用 provider API/OpenAI-loop，而且 CPU、内存、会话目录
和并发压力也更大。本项目当前不实现该例外。未来如确有需求，必须作为新的
`isolated-cli-worker` 产品能力单独审查，不能重新打开普通 App adapter。

### 4.3 旧 symlink 发现如何处理

`packages/bot/src/session/isolation.ts` 的词法路径 Hook 无法阻止 workspace 内 symlink
指向根外。它仍是一个真实的 legacy 缺陷，但只影响“允许宿主 Claude SDK/CLI 使用
原生文件工具，同时声称 workspace 是强隔离”的部署。

本轮不对它叠加 `realpath` 补丁，原因是 check-then-open 仍有 TOCTOU，且会继续让人
误以为 Hook 是 OS sandbox。处理方式改为让该路径在受支持的多用户 App 架构中不可达。
用户本地 CLI 的内部文件权限由用户/设备负责；Session Hub 只授权会话操作。

### 4.4 本轮必须实现的加固

1. 增加由可信部署配置决定、不能由 App/browser 自我声明的执行分类，至少区分
   `cloud-multi-user`、`local-owner` 和 `trusted-service`。默认生产分类为
   `cloud-multi-user`。
2. 在 `cloud-multi-user` 中，manifest 的普通 App Agent 出现 `claude-code`/`codex`
   必须在加载时明确失败，不能等到第一轮才提示；运行时配置 API 和历史 config 也
   不能绕过。
3. `cloud-multi-user` 的 production `composeV3Host()` 不为普通 AgentPlane 注册 coding
   CLI adapter；关闭 secure mode 不能改变这条性质。不要从共享 CLI 工具库中全局删除
   adapter，以免误伤 Session Hub/local-owner/Dev Factory。
4. Dev Factory 的 CLI 执行保留在独立 trusted-service 路径，principal 固定为
   `system:dev-factory`；Session Hub 的 append/resume 走 owner-bound CLI Resource。
5. 启动 inventory 明确列出所有 loop adapter、CLI executor 和 trusted service；普通
   App 可达的 coding CLI 数量必须为 0。
6. 测试覆盖 cloud profile 下的 manifest、runtime override、残留 config、secure mode
   开关和直接构造请求等路径，并断言 CLI adapter 的 `runTurn` 调用次数为 0；另有
   回归测试证明 v2 Session Hub 侧栏/list/read/live/append 和显式 local-owner 路径未被
   禁令误伤。
7. 同步删除/修正 factory probe 等仍把 App Agent 配成 `claude-code` 的样例。需要
   coding CLI 的 Dev Factory UI 只展示 trusted service 状态，不通过 App Agent 启动它。

### 4.5 完成定义

- `cloud-multi-user` 中任意共享/每用户 v3 App 都不能通过 manifest、UI、API、旧 config 或
  `secure_mode=false` 启动 Claude Code/Codex Agent adapter。
- 用户仍能通过原 v2 风格 Session Hub 侧栏查看和续跑**自己的**本地 CLI；显式
  `local-owner` 和 Dev Factory 路径仍能运行。
- 代码、启动报告和权限 UI 都不会把这两类 CLI 误呈现为普通 App Agent 权限。

## 5. 其他延期项

### SEC-07：Delegate/Task owner binding

旧 Delegate 卡片动作存在 owner binding 不完整的历史风险。minimal-v3 默认不注册
Delegate route、watcher 或插件，因此本轮不修。若重新启用，必须先统一 owner guard，
覆盖 approve/reject/stop/followup/cc-parent 全生命周期。

### SEC-08：文档和配置漂移

触及到的文档必须与实现同步；历史设计若保留，应标注已被替代。它是每次交付的完成
条件，不再作为一个让所有功能停工的独立安全编号。

### SEC-09：资源竞争型测试 timeout

不以提高全局 timeout 或吞异常掩盖问题。本轮新增/修改的测试必须确定性通过；旧集成
测试负载问题另行维护。

## 6. 本轮执行边界

负责 Session Hub 的 Agent 只执行 SEC-06 和
`doc/development/session-hub-v3-execution-plan.md`。不得顺手实施 SEC-04、SEC-05、
SEC-07～09，也不得重写已经完成的 SEC-01～03。

**这一轮已经结束**（2026-07-31）：SEC-06 与执行规格均已实施，记录在
`doc/worklogs/2026-07-31-session-hub-permissions.md`。后续 Agent 不得为了整理代码
恢复以下入口：普通 App Agent 的 coding CLI adapter 选择、把 GrantIntent 当作执行
授权（内核仍是唯一的授权者）、或让 `/permissions` 上出现开发工厂的授权按钮。
