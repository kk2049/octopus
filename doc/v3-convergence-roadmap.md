# 从 v2 控制面到 v3 权限平台：收敛路线图与决策书

> **历史文档。** 记录 2026-07 v3 收敛期的路线与排序，v4 已是当前可部署水位，其中排期与阶段动作不再成立；当前落地流程见 `doc/runbooks/development-workflow.md`，架构裁决见 `doc/adr/`。

> - 面向：产品与架构负责人
> - 审查基线：`experiment/auth-opus5-kernel` @ `1f09a4c`
> - 配套执行文档：`doc/v3-security-remediation-backlog.md`

## 1. 先给结论

建议不要立刻把 v2 的 Session 页面和自举工单系统重写成 v3 App。它们是目前最成熟、也最能帮助系统继续开发自己的两条自动化管线。正确顺序是：

1. 固化已经完成的 SEC-01～03，并执行 SEC-06 的 cloud App 架构禁令；现有 v2 Session Hub 侧栏/会话操作与 owner-only 特权路径不受禁令影响。SEC-04/05 已由负责人接受延期，不再阻断本轮。
2. 增加一个明确的“最小 v3 模式”，默认只开放身份/session、Runner、Session Hub、Dev Factory、审批与权限中心；把秘书网络、HQ、Delegate、广泛飞书工具、legacy remote 等复杂功能关掉。
3. 暂时保留 v2 Dashboard 作为受信控制面，稳定 Session Hub 和 Dev Factory 两条生产管线。
4. 建立 App/Agent 权限数据模型和用户可理解的权限前端。
5. 接通生产 AgentPlane 和统一 ToolObject broker。
6. 再用 Session Hub 与 Dev Factory 驱动其余 v2 功能逐项迁移，达到行为一致，而不是复制 v2 的内部复杂度。

这是一条“先保住造系统的工具，再用它们替换系统其余部分”的路线。过早重写这两条管线，会同时失去开发反馈、远程操控、测试、合入和部署能力，反而让 v3 收敛更慢、更难验证。

## 2. 目标状态到底是什么

本文把目标状态定义为一个可实际使用、可继续自举开发的 v3 基线，而不是“所有 v2 功能都已经迁完”。达到该基线时，系统应具备以下四块能力。

### 2.1 Session Hub：从 Web 看见并操作自己的本地 Agent

用户从浏览器登录后可以：

- 看见自己所有在线设备和 bot-host 上允许展示的 Claude Code/Codex sessions。
- 按设备、目录、项目、最近活跃状态汇总浏览，支持搜索和 rich transcript。
- 实时看到 Agent 的 thinking/tool/responding/idle 状态和新日志。
- 选择一个本地 session，输入新指令，通过受控的 `append_session`/resume 操作让本地 Agent 继续工作。
- 看见该操作会在哪台设备、哪个 session、以什么权限执行；危险操作需要批准时可以在同一 Web 控制面完成。
- 撤销设备或 session 后，已有页面、live stream、pending approval 和后续调用都失效。

“连上 Web 操作本地 Agent”不是让浏览器直接持有 Runner token，也不是远程接管 tmux。浏览器只持有用户 session；服务端从该 session 派生一个受限 capability，再由 Runner 在指定设备上执行 headless resume。

### 2.2 Dev Factory：可观察、可约束的自动工单开发

用户可以：

- 在 Web 创建工单、补充消息、暂停、取消和继续。
- 看见开发 Agent 的完整 session、当前工具、diff、测试和门禁结果。
- Agent 在独立 worktree 中工作，通过唯一的 claim/submit/land 管线修改 staging。
- 保护路径、脏树、base 移动、rebase 冲突、测试失败都有明确终态，不会静默跳过。
- 部署仍由 supervisor、健康门、存活确认和 stable 水位控制；失败能回滚。
- 每个动作有署名、对象、权限来源和审计记录。

初期 Dev Factory 可以继续作为“受信系统服务”，而不是伪装成一个已经完全沙箱化的普通 Agent。界面和文档必须如实标注这个边界。后续再把它的 repo、worktree、shell、gate、land、deploy 操作逐步建模成 ToolObject。

### 2.3 权限中心：用户看得懂 App 和 Agent 能做什么

用户可以看到：

- 已安装/可用的 App，以及每个 App 请求、获批、当前有效和已撤销的权限。
- App 下每个 Agent 的独立权限；Agent 的有效权限永远是 App 权限的子集。
- 权限对应的真实资源，例如“我的 laptop”“仓库 octopus”“我的飞书日历”，而不是 opaque capability id。
- operation 的人类可读效果，例如只读、写入、执行命令、向外发送、跨用户披露。
- 条款：设备、目录、仓库、目标用户、过期时间、是否允许自动执行、是否每次批准。
- 权限为什么有效或无效：来自用户授权、管理员策略、App 声明、Agent 衰减、设备撤销或代码版本变化。
- pending approval、近期调用和撤销入口。

权限 UI 不是把 kernel 表直接展示出来。Context、slot、capability id 是实现细节；前端需要一个稳定的 `GrantView`/`EffectivePermissionView` 投影。

### 2.4 v3 Runtime：所有受保护副作用经过同一权限框架

- 用户、App、Agent、系统服务都有明确 principal。
- AppInstance、AgentRun、ControllerRun 都从同一个 account authority 派生。
- 每个受保护工具对应一个 Object operation，声明 schema、effect、retrySafe、resource binding、policy 和 semantic version。
- LLM、App 代码和浏览器都不能提供自己的 principal、Context 或“已批准”声明。
- 外部副作用只能由 Gate 后的 adapter 执行；没有第二条 SSH/MCP/SDK 直连路径。
- 纯计算或严格沙箱内的局部工具可以不成为 capability operation，但必须没有外部资源和持久副作用。

达到上述四点后，才适合宣称“v3 已成为可继续承载 v2 功能的统一权限平台”。

## 3. 前因后果：为什么现在是这个形态

### 3.1 v2 的优势和问题

v2 已经拥有大量真实使用过的功能：多用户 Router、飞书/CLI channel、SessionManager、Runner、多设备 session 浏览、live view、headless append、工单开发、git worktree、门禁、land、部署 supervisor、审批卡片、HQ、秘书汇报、Delegate、memory 和各种 MCP。

它的问题不是“没有功能”，而是安全边界分散：

- 用户身份、卡片 owner、Dashboard role、Runner token、MCP env token 各自表达权限。
- Router 和 `AgentSession.buildMcpServers()` 组合了大量插件，难以证明一个 Agent 最终拿到了什么。
- memory、HQ、飞书、devpipe、Delegate、remote MCP、内建 Read/Write 等走不同执行边界。
- 一些 Agent 直接继承 bot 服务账号、开发者账号或飞书应用身份。
- v2 的复杂 Router/Session 不能直接复制进 v3，否则只是把旧边界搬家。

### 3.2 v3 已经解决了什么

本分支新增的 v3 安全底座包括：

- 自研 capability graph：Context 生命周期、slot、capability、rights/terms 衰减和完整祖先链重查。
- 单一 Gate：参数 schema、canonical hash、mandatory policy、approval、adapter。
- SQLite 持久化、pending 状态机、CAS、危险调用恢复和 exactly-once/unknown 语义。
- Runner account root：用户和设备 token 每次重查，设备撤销会杀死派生能力。
- Dashboard server-side session、Origin/CSRF、Cedar 路由授权。
- v3 Host instance handle 与 session、app、scope、Context、code digest 绑定。
- SES Compartment、Node permission child process 和 fail-closed App runtime。
- machines MCP loopback 与 v3 action tool 已能进入 capability Gate。

这些工作证明了“统一权限框架可以工作”，但覆盖面目前主要是 Runner。

### 3.3 v3 还没有解决什么

- 生产 bot 组合明确没有挂 AgentPlane；独立 `packages/v3-host` 虽有 AgentPlane，却使用 `authorityFor: () => null`，不能访问真实 Runner authority。
- v3 `tickets` 只是共享事件日志和评论的 probe，没有 git worktree、开发 Agent、gate、land 或 deploy。
- v3 没有 Session Hub App；现有 Session 页面仍属于 v2 Dashboard。
- `/admin` 只展示粗粒度 `dev/deploy` 位；`/pending` 只展示待批准调用，没有 App/Agent grants 视图。
- App permissions 目前来自运维配置 `v3_host.apps.*.rights/actions/agents`，不是用户安装和授权流程。
- delivery、飞书 MCP、Delegate、Claude 文件工具等还存在修复项；详见安全修复任务书。
- memory、HQ、飞书、devpipe、ask-user、project creator、内建工具仍未统一进入 Gate。

因此当前 v3 更准确的定位是“有真实 Runner 垂直切片的安全内核和应用引擎 probe”，不是 v2 的可替代版本。

## 4. 两条启动管线的当前完成度

### 4.1 Session Hub

| 能力 | v2 当前状态 | v3/权限状态 | 到目标还缺什么 |
|---|---|---|---|
| 多设备 session 汇总 | 已实现，Runner 与 bot-host 双源合并 | list/read/search 已能走 Runner capability | 明确 minimal mode 暴露面；统一审计与资源展示 |
| Rich transcript | 已实现 Claude/Codex rich parse、分页、工具配对 | 主要是展示层，不依赖 v3 App | 保留并抽稳定 API，不急于重写页面 |
| Live view | 已实现 SSE/tailer/activity 推导 | read 权限沿用 Session 页面规则 | 将 live 订阅和设备撤销、session 退出绑定得更明确 |
| Web append/resume | 已实现，owner-only，经 Runner `append_session` | 已进入 capability approval 路径 | 形成完整的设备/operation/批准 UX；补 step-up 决策 |
| 身份 | `dt_` 长期 key 换 server-side session | Cedar 和 web-trust 已接入 | OIDC/MFA、登录限速、session/device 管理 |
| 用户可见权限 | 只有功能可用/不可用和 pending 页面 | 无 App/Agent grant 投影 | 新权限中心 |

结论：Session Hub 的功能主体已经存在，正确策略是先把它当作 v3 的受信控制面使用，并补齐身份、权限展示和生命周期，而不是先重做 UI。

### 4.2 Dev Factory

| 能力 | v2 当前状态 | v3/权限状态 | 到目标还缺什么 |
|---|---|---|---|
| 工单对话 | 已实现，消息驱动 Agent 继续一轮 | v3 tickets 只有 open/comment/close probe | 继续复用 v2 service/page |
| 独立 worktree | 已实现 | 不在 capability kernel | 固定 repo/worktree binding，强化 OS/path 隔离 |
| claim/submit | 已实现 devpipe MCP、全局开发锁、ff-only | MCP token 是局部控制，不是统一 ToolObject | 建模为 Repo/Worktree operations |
| 门禁与合入 | 已实现 install/build/test/gate/land | Dev Agent 仍有 bot-host 开发者权限 | 暂列受信系统服务，后续收权 |
| 实时围观 | 工单页复用 session live view | 展示层可直接保留 | 与 Session Hub 使用同一 session projection |
| 部署与回滚 | supervisor/intent/confirm/stable 已实现 | 不是 v3 App capability | 先保留冻结服务，后续建 DeployObject |
| 工单 Agent 权限 | 实际接近开发者账号 | 没有用户可见权限清单 | 独立 system principal、固定仓库、工具清单、审计 |

结论：Dev Factory 是有价值但高权限的自举基础设施。初期应隔离并冻结，不应把它包装成“普通 v3 Agent 已受统一权限保护”。

## 5. 建议保留和默认关闭的 v2 功能

### 5.1 minimal v3 mode 必须保留

- UserManager、身份映射和最小 Feishu/CLI 通知入口。
- Dashboard 登录、server-side session、Cedar、web-trust。
- RunnerGateway、Runner token/device 管理、capability kernel、pending approval。
- Session Hub：list/search/read/live/append。
- Dev Factory：tickets、ticket messages、worktree、gate、land、deploy supervisor、verify。
- 权限中心和 audit 页面。
- v3 Host 的 App action 路径，以及一个无跨用户副作用的示例 App 用于验收。

### 5.2 默认关闭，等迁移后再开

- legacy `remoteMcp` SSH/隧道入口。
- 广泛的飞书 lark MCP 工具；只保留登录/OAuth 所需的最小 channel 能力。
- Delegate、project creator、ask-user 和跨用户 file query。
- 秘书汇报网络、报告群、自动 cross-user delivery。
- HQ、memory 自动写入、daily scheduler。
- RAG、workspace 自动建群、remote deploy 等非启动必需功能。
- v3 `reports`、`hq`、`factory architect` 等尚未完成统一授权的示例能力。

“关闭”应是启动时不注册路由、不注入插件、不启动后台任务、不展示导航，而不只是前端隐藏按钮。建议新增一个集中式 profile，例如：

```yaml
profile: minimal-v3
features:
  session_hub: true
  dev_factory: true
  permissions: true
  reports: false
  hq: false
  delegate: false
  broad_feishu_tools: false
  legacy_remote_mcp: false
```

配置解析后应生成唯一的 `EffectiveFeatureSet`，Router、Dashboard、session plugin composition 和 scheduler 都消费这一个结果，避免四处 if 再次漂移。

## 6. 推荐的目标架构

```text
                         +-------------------------+
Browser / Feishu / CLI ->| Identity + Web Session  |
                         +------------+------------+
                                      |
                         +------------v------------+
                         | Authorization Control   |
                         | App/Agent grants        |
                         | pending / revoke / audit|
                         +------------+------------+
                                      |
                 +--------------------+--------------------+
                 |                                         |
       +---------v----------+                    +----------v---------+
       | Session Hub        |                    | Dev Factory        |
       | session/device UI  |                    | ticket/worktree UI |
       +---------+----------+                    +----------+---------+
                 |                                          |
       +---------v------------------------------------------v---------+
       | CapabilityService + ToolObject registry + mandatory Gate    |
       +---------+------------------------------------------+---------+
                 |                                          |
       +---------v----------+                    +----------v---------+
       | Runner adapters    |                    | Repo/Deploy adapters|
       | local user devices |                    | isolated service    |
       +--------------------+                    +---------------------+

v3 AppInstance -> AgentRun -> ControllerRun 也只能进入同一个 Gate。
```

短期 v2 Dashboard 可以承载图中的三个 Web 页面，但业务逻辑要逐步从 `dashboard/server.ts` 和 `router.ts` 抽到独立 service。v3 App 后续消费这些 service API，而不是复制实现。

## 7. 完整 Roadmap

### R0：已决安全边界和发布基线 — ✅ 已完成（2026-07-31）

**目标**：使现有 Runner/v3 垂直切片的安全声明成立，同时不把已接受的试运营风险伪装成必须先做的功能开发。

**工作**：SEC-01～03 已完成并归档到 `doc/worklogs/2026-07-31-sec-01-03.md`。SEC-06 已完成并归档到 `doc/worklogs/2026-07-31-session-hub-permissions.md`：`cloud-multi-user` v3 App 禁止使用宿主 Claude Code/Codex adapter；现有 v2 `/sessions` 侧栏、owner-bound Session Hub 操作、显式 local-owner 和 Dev Factory 特权执行器不受这条禁令影响。SEC-04/05 已接受延期；SEC-07 随 Delegate 保持关闭；SEC-08/09 按触及范围维护。

**退出条件**（已满足）：SEC-01～03 的负向测试继续通过；cloud App 无法经 manifest、运行时配置、旧配置或 secure-mode 开关启动 coding CLI（`runtime/deployment.test.ts`，每例断言 `runTurn` 调用数为 0）；v2 Session Hub 侧栏/list/read/live/append、local-owner 与 Dev Factory 特权路径不受误伤。对外或多租户部署前重新评估 SEC-04/05。

### R1：建立 minimal v3 mode 和边界清单

**目标**：把系统缩到能支撑后续开发的最小运行集合。

**工作**：

- 新增集中式 feature profile 和 `EffectiveFeatureSet`。
- minimal-v3 只启用 Session Hub、Dev Factory、Runner、审批、权限中心所需服务。
- 生成启动报告：启用了哪些 HTTP route、scheduler、MCP server、LLM adapter、后台任务和直接凭据。
- 对所有现存工具做 inventory，标注 `brokered`、`sandbox-local`、`trusted-service`、`legacy-bypass` 四类。
- `legacy-bypass` 在 minimal-v3 下必须为 0；`trusted-service` 初期只允许 Dev Factory supervisor/agent，并明确 owner。

**退出条件**：从启动日志和机器可读 inventory 可以证明复杂功能没有被注册；不是“用户看不见但进程仍在跑”。

### R2：把 Session Hub 产品化为第一条 v3 控制管线 — 🟡 大部分完成（2026-07-31）

> 已完成：`SessionHubService` 抽取（`packages/bot/src/sessionhub/`）、规范化
> `deviceId/sessionId/cliKind/owner/activity` 与 opaque `resourceId`、append 页面在提交前
> 显示设备/会话/effect/批准要求、live 订阅绑定 Web session 与 Runner device 生命周期
> （撤销即断流）、统一 audit（`permission_audit`）、用户可见的设备与 Web session 列表 +
> revoke current / revoke others。端到端验收 1-5 全部有对应负向测试
> （`packages/bot/src/permissions/permissions.e2e.test.ts`）。
>
> 未完成：`/api/sessions/live` 的 `resourceId` 已支持但 v2 页面仍传 `device+id`（兼容期
> 有意保留）；step-up 认证未做（D2/D4 的后半段）。

**目标**：用户能从 Web 安全地查看并继续本地 Agent，会话页成为日常入口。

**工作**：

- 保留现有 sessions page、rich parser、SSE live view 和 Runner RPC，不重写展示层。
- 把 list/search/read/live/append 的服务逻辑抽成 `SessionHubService` 或同等稳定边界；Dashboard 只是调用者。
- 每个响应返回规范化 `deviceId/sessionId/source/owner/activity`，不让前端拼安全 identity。
- append 页面在提交前显示设备、session、operation effect 和批准要求；结果与 pending 页面互相链接。
- live tailer 绑定用户 session 和 Runner device 生命周期；设备撤销或 Web logout 后停止流。
- 为每个 session operation 记录统一 audit view。
- 增加用户可见的 Web session 和 Runner device 列表，支持 revoke current、revoke other、logout all。

**端到端验收**：

1. Alice 在公网 Web 登录，看见自己的 laptop sessions。
2. Alice 打开正在运行的 session，实时看到工具状态。
3. Alice 输入指令，系统产生绑定到 laptop/session/argsHash 的批准；批准后本地 CLI 续跑。
4. Bob 无法读取、订阅或 append Alice 的 session。
5. 删除 laptop token 或注销 Web session 后，旧页面、SSE、pending 和重放全部失效。

### R3：把 Dev Factory 固化为第二条自举管线

**目标**：让 Agent 能可靠开发 v3，但不把开发者级权限扩散给普通 App/Agent。

**工作**：

- 保留现有 `DevPipeline`、ticket page、worktree、gate、land、DeployService 和 supervisor；冻结其外部 API。
- 把 ticket agent 标识为独立 `system:dev-factory` principal，不使用请求用户的普通 Agent 权限冒充开发者。
- 配置固定 repo allowlist、worktree root、保护路径、允许命令/门禁和最大并发。
- ticket agent 的 plugin 列表缩到开发所需；移除飞书、HQ、Delegate、用户 memory 等无关插件。
- ticket session 在 Session Hub 中可查看，工单页复用同一个 transcript/live projection。
- diff、提交 sha、gate 日志、base 变化、land 和 deploy 结果形成不可覆盖的审计链。
- 将 `claim_workspace`、`submit`、`land`、`deploy` 的资源和 effect 先登记到权限目录；即使第一版 adapter 仍是 trusted service，也要让用户看见真实边界。

**端到端验收**：创建工单 -> Agent 领取 worktree -> 修改 -> 测试失败后修复 -> gate 通过 -> ff-only land -> 可选部署 -> 存活确认。期间 Agent 不能访问 repo allowlist 外路径，不能直接移动 staging/stable，不能绕过 gate。

### R4：建立 App/Agent grants 后端和权限中心 — 🟡 Session Hub 一侧完成（2026-07-31）

> 已完成：持久 `GrantIntent`（migration v24）、`GrantView`/`EffectivePermissionView`
> 投影与 reason codes、`/permissions` 四个视图（App 与服务 / 设备与 CLI / Web session /
> 活动记录）、撤销传播（Context 硬销毁 + SSE 断流 + 租约释放）、与内核的差分测试。
>
> 未完成：**v3 App/Agent 尚未接进这张表**——`subject_type` 已经是三值、表和 API 都能承载，
> 但 `HostCapabilities` 仍从 `v3_host.apps.*` 读声明。接缝是 `GrantLedger.authorize()`。
> 用户安装/启用 App 的流程、grant 绑定 operation semantic version（依赖 SEC-05）同样未做。

**目标**：授权从运维 YAML 中的隐式配置，升级为用户可见、可撤销、可解释的数据。

**核心模型**：

```text
Principal: user | app | agent | system-service
Resource:  runner-device | session | repo | worktree | deploy-target | feishu-resource | ...
Operation: name + schema + effect + retrySafe + semanticVersion
Grant:     subject + resource + operations + terms + source + status + expiry
Context:   一次 launch/run/dispatch 的短期生命周期，不直接展示给用户
```

**有效权限计算**：

```text
Account 当前持有
  intersect App 获批上限
  intersect Agent 获批上限
  intersect 本次 Context terms
  intersect 当前 policy / device / version 状态
  = Effective permissions
```

**后端工作**：

- App manifest 声明 requested operations 和人类可读 reason；manifest 本身不能创建 grant。
- 用户安装/启用 App 时产生 grant；Agent 权限必须显式声明且只能从 App grant 衰减。
- 提供面向 UI 的 `GrantView`、`EffectivePermissionView`、`PendingView`、`AuditView`。
- grant 绑定 App/operation semantic version；版本变化按本文决策 D7 处理。
- revoke 会撤销 roots/contexts/pending，并在下一次 authorize 立即生效。

**前端最少四个视图**：

1. **我的 App**：每个 App 的请求权限、有效权限、资源范围、最近使用和撤销。
2. **App 详情**：Agent 树，每个 Agent 的子集和自动执行条款。
3. **待批准**：具体 operation、目标设备/资源、参数摘要、发起 App/Agent、认证强度。
4. **活动记录**：allow/deny/approval/result，支持按 App、Agent、设备和 operation 过滤。

**退出条件**：用户无需阅读 YAML 或 capability id，就能回答“这个 Agent 为什么能在我的哪台机器上执行什么”；撤销后有端到端测试证明旧 Context 和 pending 均不能调用 adapter。

### R5：接通生产 AgentPlane 和统一 ToolObject broker

**目标**：真正让生产 v3 Agent 在同一个权限框架内运行。

**工作**：

- 在 bot 进程的 `composeV3Host()` 挂 AgentPlane，并使用现有 `RunnerCapabilities.accountAuthority(username)`。
- 每一轮创建 AgentRun，每个 action tool 再创建 ControllerRun；模型不能传 Context id。
- 将 MCP/SDK/CLI 工具统一注册为 ToolObject operation。
- 受保护 MCP 不再直接注入 CLI stdio；使用 brokered shim 和短期 bound token。
- Agent 子进程不拿 Runner token、数据库、飞书 app secret、用户 OAuth 明文或 bot 完整环境。
- direct-to-CLI MCP 只允许被证明为 `sandbox-local`、无外部资源的服务。
- 启动时发现未分类工具或同一资源存在第二入口即失败。

**优先迁移顺序**：

1. shell、文件写入、git、deploy、飞书写操作。
2. session append、跨用户读取和对外发送。
3. memory/HQ 持久写入。
4. 只读 session/file/search。
5. 纯计算和公共只读工具。

**退出条件**：生产 Agent 能完成一个 Runner action；去掉 capability grant 后同一 tool 从模型侧仍可见或不可见均可，但 adapter 调用必须为 0。代码库中没有能到达同一资源的 legacy direct path。

### R6：用两条自动化管线逐项收敛到 v2 行为一致

**目标**：恢复真正需要的 v2 用户能力，同时保持 v3 的权限和生命周期模型。

每个 v2 功能迁移必须经过同一模板：

1. 说明用户行为和真实资源，不复制旧 Router/Session 内部结构。
2. 在 ToolObject catalog 声明 operations、effect、schema、semantic version。
3. 定义 App grant 和每个 Agent 的衰减权限。
4. 先做权限中心展示和 deny 测试，再接 adapter。
5. 用 Dev Factory 开发、gate、land；用 Session Hub 围观和干预。
6. v3 端到端验收后才关闭对应 v2 route/plugin/scheduler。

建议迁移顺序：

- **低风险本地功能**：clips、只读 session 工具、受限 memory read。
- **个人持久功能**：HQ/memory write、个人 scheduler。
- **跨用户功能**：reports、ask-user、共享 App；先有 recipient/resource policy。
- **外部 SaaS**：飞书 user-identity tools，再评估 app-identity tools。
- **高权限自动化**：Delegate、project creator、通用 remote、dev agent 完全去 trusted-service 化。

行为一致的定义是“用户任务能完成、数据可迁移、权限可解释”，不是文件、路由或状态机逐行一致。

### R7：退出 v2 运行时

**目标**：v2 只剩迁移工具和历史数据读取，不再承担在线授权或 Agent 执行。

**退出条件**：

- Session Hub、Dev Factory、权限中心都由稳定 service/API 支撑，页面可以是新 v3 shell，也可以保留已抽空业务逻辑的 Dashboard shell。
- 所有启用功能都在 tool inventory 中，没有 `legacy-bypass` 和未说明的 `trusted-service`。
- v2 与 v3 对同一资源不再同时拥有写入口。
- 数据迁移可回滚，旧数据只读验证完成。
- 运维、恢复、部署文档只描述一个生产组合。

## 8. 权限前端应如何表达

### 8.1 不要只显示“有/没有权限”

用户真正需要的是五个问题：

1. **谁**：哪个 App、哪个 Agent、哪个系统服务。
2. **对什么**：哪台设备、哪个 session、哪个 repo、哪个飞书资源。
3. **能做什么**：read、append、exec、write、send、deploy 等。
4. **在什么条件下**：目录、目标用户、过期时间、自动允许或逐次批准。
5. **为什么还有效**：谁授权、哪个版本、父权限是什么、是否刚被使用。

### 8.2 建议的页面层级

```text
权限
├── App 列表
│   └── App 详情
│       ├── App 自身权限
│       └── Agents
│           └── Agent 有效子集
├── 待批准
├── 设备与 Web sessions
└── 活动记录
```

App 列表适合按真实产品名展示，不按 slot/object id 展示。高风险 effect 使用稳定标签，例如“执行命令”“修改文件”“向外发送”“跨用户读取”，但最终批准卡仍要展示参数摘要和目标资源。

### 8.3 请求、获批、有效必须分开

- **Requested**：manifest 想要什么，不代表系统已经给了。
- **Granted**：用户/管理员曾同意什么，是持久意图。
- **Effective**：当前 Context、设备、版本、policy 下现在真正可用什么。

这三者混成一个绿色勾，会导致“设备已经撤销但页面还说 App 有权限”或“App 新版本多要了 exec，看起来像原授权自动扩大”。

### 8.4 权限变化规则

- 权限新增或范围扩大：必须重新同意。
- 权限删除或范围收窄：自动生效，不需要重新同意。
- 设备、用户、App 禁用：立即撤销派生 Context 和 pending。
- Agent 永远不能独立扩大 App grant。
- App 代码或 operation 语义变化如何处理，见决策 D7。

## 9. 需要负责人决策的事项

以下问题会显著改变实现或安全承诺，不应由开发 Agent 自行猜测。表中的“建议”是本路线图默认采用的方案。

| ID | 需要决定什么 | 主要选项 | 建议 |
|---|---|---|---|
| D1 | Session/工单 UI 先放哪里 | 立即改写成 v3 App；暂留 v2 Dashboard 控制面 | **暂留 Dashboard**，先抽 service/API，R6 后再换 shell |
| D2 | 启动阶段的登录方式 | 继续 `dt_`；先做 OIDC/MFA | 内部自举期可继续 `dt_`，但仅限受控用户；对外或多人正式使用前必须 OIDC + step-up |
| D3 | 管理员能否读所有用户 sessions | 保留全局可读；仅本人；逐次授权 | 默认仅本人；故障排查使用显式、限时、可审计的 support grant，而不是永久隐形全读 |
| D4 | Web append 的批准策略 | 每次批准；近期 session 预授权；低风险自动 | 初期每次绑定设备/session/argsHash 批准；稳定后再引入短期、可见、可撤销的预授权 |
| D5 | Dev Factory Agent 的身份 | 普通用户 Agent；受信系统服务；独立外部 CI | 初期作为 `system:dev-factory` 受信服务并明确标注，固定 repo/worktree；R5 后逐步去特权 |
| D6 | App 与 Agent 的权限关系 | Agent 自动继承 App 全部；Agent 单独授权；显式子集 | App 是上限，Agent 必须声明并展示显式子集；绝不默认继承全部 |
| D7 | App 代码变化是否要求重新同意 | 每次代码变更；仅权限 manifest/语义变化；按 publisher 信任级别 | 可信签名 App 在权限 manifest 不变时保留 grant但重建 Context；Agent 生成/本地未签名 App 每个 semantic version 重新同意 |
| D8 | “所有工具统一权限”中的“所有” | 所有工具调用；只管外部副作用 | 所有外部资源和持久副作用必须 Gate；纯计算/严格 sandbox-local 工具可不建 Object，但必须 inventory 可证明 |
| D9 | 是否近期支持跨用户 App | 保留 reports/ask-user；先全部关闭 | 在 recipient consent、delivery Object、审计 UI 完成前全部关闭 |
| D10 | 首个正式部署是单组织还是多租户 | 单组织多用户；互联网多租户 | 先单组织多用户；多租户需要 tenant 隔离、IdP 生命周期和独立密钥域，不能靠当前 username 扩展 |
| D11 | 谁能发布/安装 App | 管理员；用户本地；Agent 自动 | Agent 可生成草稿但不能自行发布或加权限；管理员/用户必须审核 manifest diff 和权限请求 |
| D12 | 自动部署默认是否开启 | gate 后自动部署；人工触发；仅 land | 默认自动 land、人工 deploy；稳定期积累足够回滚证据后再考虑自动 deploy |

如果这些决策暂时没有结论，开发 Agent 应按“建议”列实施，并把选择写进配置和文档，不要把两种语义同时留在运行时。

## 10. 建议立即创建的开发工单

当前按以下顺序推进；本轮把第 1～4、7～8 与 SEC-06 合并成
`doc/development/session-hub-v3-execution-plan.md` 交给一个 Agent 端到端实施
（已于 2026-07-31 完成，见 `doc/worklogs/2026-07-31-session-hub-permissions.md`）：

1. ✅ `SEC-06 App adapter ban + startup inventory`。
2. ✅ `SessionHubService extraction`，保持现有页面行为不变。
3. ✅ `Web session / Runner device management + logout-all`。
4. ✅ `Session append approval UX + audit projection`。
5. `Dev Factory system principal + repo/worktree allowlist`（principal 已命名并出现在
   inventory 与权限中心，**执行管线未动**）。
6. `Dev Factory plugin minimization + shared session live projection`。
7. ✅ `Persistent GrantIntent + GrantView/EffectivePermissionView API`（Session Hub 一侧；
   v3 App/Agent 待接）。
8. ✅ `Permissions UI: Apps -> Agents + CLI/devices -> pending -> audit`。
9. `Production AgentPlane composition with real account authority`。
10. `Tool inventory enforcement + first brokered shell/file/deploy operations`。

每张工单必须包含一个用户可见验收故事和一个负向安全故事。例如 Session append 既要证明 Alice 能续跑自己的 laptop，也要证明 Bob、旧 cookie、已撤销设备和旧 pending 都不能让 Runner 收到一个字节。

## 11. 里程碑判断

### M1：可安全自举

- R0、R1 完成。
- 只运行 Session Hub、Dev Factory、Runner、审批和必要身份服务。
- 两条管线可以继续开发系统，其余复杂能力真正关闭。

### M2：目标功能完成度

- R2、R3、R4 完成。
- 用户能从 Web 汇总/查看/继续本地 Agent。
- 工单 Agent 能完成开发、测试、land，并可观察、可回滚。
- 用户能看到并撤销每个 App/Agent 的请求、获批和有效权限。

这就是本轮需求所描述的目标状态，也是开始系统性追赶 v2 行为一致的正确检查点。

### M3：统一权限成立

- R5 完成。
- 生产 AgentPlane 使用真实 authority。
- 所有启用的外部副作用都经过 ToolObject/Gate，没有直连凭据或 legacy 第二入口。

### M4：v2 行为收敛

- R6、R7 完成。
- 需要的 v2 功能已逐项迁移，不需要的保持删除/关闭。
- 只有一套生产入口、权限解释和运维恢复流程。

## 12. 最终审查标准

到 M2 时应重新做一次架构和安全审查，至少回答：

- 从登录到 account authority 的 principal 是否唯一、可撤销、可追踪？
- Session Hub 和 Dev Factory 是否都通过明确 Object/operation 访问资源？
- 权限中心展示的 effective permissions 是否与 Gate 实际决定一致？
- App/Agent 版本变化是否会错误继承旧权限或旧 pending？
- 每个启用的 Agent 工具是否有 inventory 分类，是否存在同资源第二入口？
- 用户撤销 App、Agent、设备或 Web session 后，旧 Context、SSE、pending 和 token 是否同步失效？
- Dev Factory 是否仍拥有未声明的 bot-host 开发者能力？如果有，是否仍被明确列为 trusted service？
- `pnpm audit --prod`、全量测试、负向矩阵和真实多用户 E2E 是否全部通过？

只有这些问题都有证据支持的答案，系统才算从“安全内核实验”进入“可用的 v3 权限平台”。
