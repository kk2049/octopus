# 权限中心 — 持久授权意图与 requested/granted/effective 投影

> 2026-07-31 新增。执行规格：`doc/development/session-hub-v3-execution-plan.md`。

## 一句话

**内核决定「现在能不能」，这里记录「谁同意过什么」。** 一行 grant 自己不授权任何东西。
Session Hub 把 `effectiveFor()` 的投影交给自己的 `open()`；Session Plus 的
`IntentGrantResolver` 在 `HostCapabilities` 派生时直接读取同一行。两条路径最后都必须经过 Gate，
而 `effectiveFor()` 只负责 UI 投影。发布者变化也进入通用投影输入，旧发布者的行不会被显示成
新发布者的有效授权。

## 文件

| 文件 | 职责 |
|---|---|
| `catalog.ts` | 不可变、显式注入的 subject operation 目录；Session Hub 保留 UI 别名映射，Session Plus 使用六个 Gate 原名；同一行不能既 alwaysApprove 又 mayAutoAllow（组合时失败） |
| `effective.ts` | 目录参数化的纯函数 `computeEffective()`：三列 + 机器可读 reason codes；`permissionDiff()` 供授权确认页 |
| `service.ts` | `PermissionService`：grant / revoke / 撤销传播 / bootstrap / 审计 / 投影 |
| `app-trust.ts` | 发布者代码信任的持久记录；只回答能否加载 package，不回答任何 capability |
| `studio.ts` | Permission Studio 的统一只读投影与两步 frozen proposal facade；不直接调用 adapter，不把兼容行冒充统一执行 |
| `../authorization/` | canonical domain/resource/exact-permit store、可信 typed rule program 与 intent-only decision；与 legacy `GrantIntent` 并存 |
| `capability-bits.ts` | 账号 admin/dev/deploy 位的无依赖解析；Dashboard 与部署入口共用，不做路由判定或 Gate 判定 |
| `packages/dashboard-web/src/pages/PermissionsPage.tsx` | `/permissions` 页面（2026-08-06 起是 React 组件；服务端仍然算好三列，前端**不做任何权限运算**） |
| `effective.test.ts` | 纯函数用例 + **与内核的差分测试** |
| `permissions.e2e.test.ts` | 真 HTTP 多用户负向矩阵 |
| `packages/dashboard-web/src/pages/PermissionsPage.test.tsx` | 三列不合并、Agent 渲染在 App 内、受信服务无控件、只渲染服务端 `explanation` |

## Permission Studio 不是新的执行门（2026-08-15）

`PermissionStudioService` 从 canonical authorization、generic grant、Tentacle、MCP、shared App 和旧
cross-user ACL 组装一个 source-labelled read model。它只允许两类写入：已有 user-managed generic
grant，以及尚无通用 installer 消费者的 App draft defaults。canonical permit 在 Studio 中只读；
Tentacle 由自己的精确对象 share/revoke 控件管理。浏览器只能提交服务端冻结的 opaque proposal id，
不能提交 authority、规则 AST 或任意 resource selector。

可信 `PolicyRule[]` 只可由 composition 注入，启动时验证，production 默认空。规则 inventory 与
resource × holder 的直接 permit 矩阵分开展示：条件规则在运行时 facts 到齐之前必须写成“尚未求值”，
不能显示为某个 holder 已经 ALLOW。`studio:` 是 projection-only 保留 namespace，canonical domain 或
resource 不能注册在该 namespace，避免 legacy command facade 与 organization authority plane 碰撞。

统一显示不表示统一 enforcement。每条 resource 都必须标明 `enforced`、`intent-only`、
`compatibility` 或 `unenforced`；没有活 consumer attestation 时，即使持久行看起来像 Tentacle，也只能
显示 intent-only。EXPLAIN/APPLY 的 baseline 必须覆盖实际 authorization contract identity，防止预演后
release/contract 切换把未审核的新权限写入。

## 权限中心的浏览方式（2026-09-05）

`/permissions` 内分应用授权、权限树、连接与设备、活动记录；旧 `/access-preview` 仅作受鉴权的
兼容跳转。权限树使用 Studio 真实投影，按 URL 分段逐栏浏览，软链接只导航到当前可见目标。
中间目录不产生权限，不把父节点的许可合并到子节点，也不把条件规则渲染成已授予某人的许可。
授权表按操作类别折叠；全选、全不选、整组选择仅改变当前主体草稿，保存仍走原 grant API。
页签保持挂载，切换和刷新保留选择；三列、执行接入标记、配置只读和服务端解释保持原义。

## 三列为什么不能合成一个对勾

合起来正好说两个谎，而且都是真发生过的：

- 「设备已经撤销，但页面还说这个 App 可以读」
- 「新版本多要了 `exec`，旧的对勾看起来像原授权自动覆盖了它」

所以：**Requested**（声明想要，不产生任何权限）/ **Granted**（持久意图，代码更新不动它，
撤销即死）/ **Effective**（此刻算上账户真实权限、父授权、agent 收窄、契约版本、过期之后
真正可用的）。每一行都带 reason codes：`not_granted` `revoked` `expired` `superseded`
`publisher_changed` `contract_expanded` `agent_narrowed` `parent_revoked` `device_revoked`
`account_lacks_operation` `unknown_operation`。**前端只渲染 `explanation`，不自己算结论。** 唯一在浏览器里算的东西是「按下保存会改变什么」的
预览 diff，而它只比较勾选框与服务端已经送来的 `granted` 集合，仍然不对 `effective` 下任何结论。

reason 是**全量列表**不是单一主因：「你从没授权过」与「新版本多要了」是两件不同的
待办，只留一个会藏起另一个。

## 「账户此刻持有什么」是两个 root 的并集（2026-07-31）

`accountOperations`（旧名 `accountRunnerOps`）= 笔记本 Runner root ∪ **bot 主机 root**。
两个资源用**同一批 operation 名字**（`catalog.ts` 把一个 hub operation 映到唯一一个底层名字），
所以取并集是安全的，而且投影不需要按资源分支。

这带来两句更准的话：

- 摘掉最后一台设备**不会**清空一个只靠 bot 主机的账号——那是另一个 root，它什么也没丢；
- `append_session` 这时报 `account_lacks_operation`（**只有设备能背书它**）而不是笼统的
  `device_revoked`。两者是不同的句子，对应不同的待办。`device_revoked` 现在只在
  「既没有设备、bot 主机上也没有可扫描目录」时出现。

并集**说不出**「会由哪个资源作答」——那是 hub 的事，它对两个资源各派生一次。

## 撤销：同步安全，异步清理

`revoke()` **先落行，再拆**。这个顺序就是安全内容：从它返回那一刻起，新的
`effectiveFor()` 已经不含该 operation，所以即使后面的拆解抛异常、被打断、失败，
也不可能再派生出这条权限。然后才关闭**该 subject** 已经开着的东西：

1. 对 Session Hub：池化的 Context，**两个资源都拆**（`caps.dropPooled(owner)` +
   `local.dropPooled(owner)`，**硬销毁**——一张在旧授权下建出来的批准卡不能因为
   「它还没被点」而活下来）。第二行就是本轮修的那个洞：只关笔记本、把 bot 主机上
   同一批 transcript 留着可读，是「撤销」这个词不该有的意思；
2. 对 Session Hub：正在跟随的 SSE 流和 append 单写者租约；
3. 对 Session Plus：它自己的 instance bundle、两个 App Context 与 transcript subscription。

不同 subject 互不代拆：撤 Session Plus 不会清空 Hub 的 pooled Context 或 live stream；撤 Hub 也
不会销毁 Plus instance。通用 `onRevoked` 事件携带 subject identity，各消费者只处理自己的行。

反过来做——先拆再落行——会留下一个窗口：这期间的请求从一条正在消失的 grant 上重新派生。

**收窄走同一条路**：`grant()` 拿到的是**整套新集合**不是增量（勾选框保存的就是勾上的
那些），diff 里 `removed` 非空就对那些 operation 跑同一套拆解。

## bootstrap 是 bootstrap，不是「用户点了同意」

在这之前，owner 已经可以 list/read/search/tail 自己的会话——那是路由里一行
`identity.username === username`。把它导入成一行 grant **没有扩大任何权限**，只是让它
**可见、可撤销**（执行规格 §10）。所以那一行写 `source: "bootstrap"`、
`createdBy: "system:bootstrap"`，**不写 `user`**：把它记成「用户点了同意」是伪造同意，
而读这个页面的人有权知道哪些权限是自己真的选的。

`append_session` / `resume_session` 也在 bootstrap 集合里（它们本来就对 owner 可达）。2026-10-15（O1）
起它们是普通的可静默 grant term：bootstrap 行默认把它们写进 autoAllow（旧 bootstrap 行在下一次
`sessionHubEffective` 时补齐），所以 owner 从网页、脚本或 MCP 发给自己会话都不再排卡；user/config
行保持原样，显式收窄的行仍会排卡。浏览器的 `directSelfAutoAllow` 例外保留，跨用户调用拿不到任何 grant。

Session Plus 另有 `sessionPlusEffective(owner, activeDigest)`：首次打开时 bootstrap 当前 release 声明的
全部本人本地操作（`SESSION_PLUS_OWNER_LOCAL_OPERATIONS`：会话、工作区、本人文件、终端），全部静默，
不再要求 release 契约的 autoAllow 包含它们（O1）。新 release 声明的本人本地操作也会补进 owner 自己的
bootstrap 行与 user 行（O2，免重新同意；config 行与已撤销的行不动）。CRDT 共享文档与 outbound
notification 不在 bootstrap；整条 App grant 被撤销后不会复活。

## 差分测试：两个方向要问两个不同的问题

`effective.test.ts` 最后一段。投影可能错两次，而它们不是同一个问题：

| 方向 | 问谁 | 为什么是它 |
|---|---|---|
| 说「有效」的必须真有效 | **内核** | 只有它知道「摘掉最后一台设备」撤销了账户根 |
| 说「无效」的必须真无效 | **服务** | 数落到假 transport 上的**帧数**。「返回了一个错误」不算证据——先 dispatch 再报错的服务已经把事做了 |

表里六行：无设备 / bootstrap 授权 / 收窄后的授权 / 授权后摘设备 / 撤销授权 / append 已授权。
最后一行验证 append 已授权时，owner browser 会产生一帧且没有卡；另有 Bearer 路径继续验证
没有可信浏览器在场时仍停在批准队列。

## 只有显式组合且被执行路径消费的 subject 才能有控件（2026-08-04）

`SubjectInfo.enforced` 说的是：**有没有一条执行路径真的会读这个 subject 的 grant。**
默认组合只有 `session-hub`。启用 Session Plus 时，组合根额外注入一个
`app:session-plus` 目录；其 `grant_intents` 行由 owner-aware `IntentGrantResolver` 读取并交给
普通 `HostCapabilities`，所以它也是真正的 `enforced: true`，不是展示占位。

原先 `/api/permissions/grant` 接受任意 `subject_type: "app" | "agent"` 加任意 id，
写下行，页面再给它渲染三列表格、计数、保存与撤销按钮——而**没有任何东西读这些行**
（旧 v3 App 的权限来自 `v3_host.apps.*` + 进程内 `GrantLedger`）。于是整张卡是一个
**伪造的安全控件**：一个人取消勾选并保存，会以为自己收回了什么。

所以现在的规则是：

- `PermissionService` 构造时只接受一组不可变 `SubjectCatalogEntry`；不存在全局可变 App registry。
- `grant` 与 `revoke` 对**未组合或未接线**的 app/agent 返回 400。知道一个任意 id 不能创建一行
  无消费者的装饰性授权。
- 路由只有在 entry 的 `userManaged` 为真时才允许用户创建自己的行；已经存在的
  `source=config` 行在 grant 与 revoke 两条 API 上都不可覆盖。Session Plus 允许没有配置行的
  owner 写 `source=user` 并随时撤销，配置行仍展示真实 effective 三列且保持只读。
- 页面对 `enforced: false` 的 subject 给 **尚未接入执行路径** 徽章、**不给控件**，
  并写清权限实际来自哪里。feature 关闭时不渲染一个并不存在的 Session Plus subject。
- 受信服务（开发工厂）的 `enforced` 也是 `false`，但理由不同：它的权限根本不来自 grant。

Session Hub 与 Session Plus 共用的是**意图表、目录投影和 Gate**，不共用 authority：Hub 继续走
自己的 service 路径；Plus 用两个独立单根 plane。`PermissionService` 仍然只描述意图与 effective
投影，最终 allow/deny 只来自 capability Gate。

Session Plus 另有一张很小的 `app_trust` 表。这不是第二套权限：它只记录 owner 是否愿意加载
某 publisher 的精确 package（或跟随后续更新）。首开先过发布者信任，随后即使零 capability grant
也可打开空权限 View；撤销 trust 只停止 package 与实例，撤销 grant 只停止 capability，两者互不
伪装。两条记录都不能代替 Gate。本仓库构建的 release（publisher 以 `octopus:` 开头）不经过这道门：
`status()` 直接返回 `first_party`、不写行，revoke 是 no-op（2026-10-15，O12）；其他 publisher 不变。

## 已知边界

- `GrantIntent` 当前覆盖 **Session Hub** 与显式启用的 **Session Plus**。任意第三方 App 仍然
  不可写，直到它被组合根注入目录且确有执行路径读取；仅有 YAML 声明不够。
- **开发工厂（`system:dev-factory`）在这里只被描述，不被授权**：它的权限不来自 grant，
  页面给它一个受信服务徽章、列出真实边界、**没有授权按钮**，`/api/permissions/grant`
  对它直接 400。声称它「已经通过普通 App Agent 授权」是执行规格明令禁止的那句谎。
- 撤销后**已经打开的页面不会自动重绘**（除了 SSE 会被断开）；它下一次轮询会拿到新的
  effective 集合。
- `permission_audit` 是证据不是日志：`prunePermissionAudit()` 按每人上限裁剪，默认 2000 条，
  目前没有定时调用者。
