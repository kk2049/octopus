---
decision_status: accepted
realization_status: partial
supersedes: []
superseded_by: []
tickets: []
---
# ADR 0002 — Agentic App 的发布者信任、源码透明与能力授权是三件事

> 状态：**已接受（架构决策）**，发布/安装流程尚未实施（2026-08-04）
> 适用范围：未来由第一方、第三方或用户生成并分发的 Agentic App
> 前置边界：`doc/adr/0001-session-plus-trust-boundaries.md`
> 当前实现审计：`doc/development/session-plus-m0-m1-convergence-audit.md`

## 1. 决策

平台把下面三件事作为独立状态、独立提示和独立审计记录：

1. **发布者信任（Publisher Trust）**：用户是否愿意运行这个发布者提供的代码，并把投影数据交给
   它处理；
2. **源码透明（Source Transparency）**：当前实际运行的包，能否追溯到平台托管的精确源码快照、
   构建记录和产物 digest；
3. **能力授权（Capability Grant）**：这个 App 及其 Agent 能否在当前用户仍然拥有的资源上执行
   哪些 operation、带哪些约束、是否需要逐次批准。

任何一项都不能替代另一项：

- 源码公开不代表用户已经信任发布者；
- 信任发布者不代表授予了任何数字资产权限；
- 授予一个只读 capability 不代表用户同意把所有可读数据都投影给 App；
- iframe、CSP 或不同 eTLD+1 不能把已经交给 JavaScript 的数据重新变成秘密。

## 2. 两道用户闸门

### 2.1 第一道：是否运行并披露给这个发布者

在首次运行 publisher-JS App 前，可信外层至少显示：

- App 名称与稳定 `appId`；
- 发布者的稳定身份、来源说明与验证状态；
- 当前 release/version 与 `packageDigest`；
- 平台托管的源码快照、许可证、构建记录及其绑定状态；
- 运行 profile：平台声明式 renderer，或发布者自带 JavaScript；
- 将向 App 投影的数据类别。

用户可以选择只信任这一个精确 release，也可以选择在约定条件内信任该发布者的后续更新。
这是类似 VS Code 扩展市场的信任决定：平台说明“谁发布、哪份源码、现在跑哪份产物”，用户决定
是否运行。

### 2.2 第二道：是否授予真实能力

权限提示单独显示：

- 请求的 operation 及可读效果；
- 对应的真实资源（设备、目录、仓库、会话、日历等）；
- 约束（目录、目标、过期时间、次数、是否允许自动执行）；
- App 与内部 Agent 的衰减关系；
- 哪些操作仍然每次要求人在可信外层批准。

用户可以信任某个 App 运行，但不给它任何 capability；也可以撤销 capability 而保留安装与界面。
反过来，历史 grant 也不能让一个尚未通过发布者信任闸门的新包自动开始运行。

## 3. 有效权限只有一条计算公式

```text
effective authority
  = 用户当前仍持有的 account authority
  ∩ 当前 App 声明的 permission contract
  ∩ 用户持久 App grant
  ∩ App instance / action / Agent 的逐层收窄
  ∩ 当前仍有效的资源与条款
```

是否能**自动执行**还要继续经过 mandatory policy、grant terms 与逐次 approval；它不是上式里
operation 存在的同义词。

代码位置与职责保持清楚：

- Dashboard Cedar (`dashboard/authz.ts`) 只回答“这个人能否访问主站某条路由”；
- `GrantLedger` 只回答“这个 publisher + App contract 是否已获授权”；
- capability kernel 只回答“这个 live Context 此刻是否仍持有某个受约束 operation”；
- 可信 Host 负责把不可信 View 的 proposal 绑定到服务器持有的 owner/App/instance Context；
- App View 永远不持有 bearer、浏览器 session、CSRF、root capability 或 instance handle。

新增 App 不应新增一套权限判断，也不应给 Cedar 增加 App operation。只有主站本身出现新的“人对
控制面”的权限语义时，才应修改 Cedar policy。

## 4. 读权限同时是披露预算

凡是可信 Host 投影给 App View 的数据，按“已经披露给该 package/publisher”设计。App 可把它保留、
重排或通过浏览器允许的机制带走；撤销只能停止未来投影和未来动作，不能收回已经披露的数据。

因此 `read_session` 这类 grant 至少要同时回答：

- App 能在服务端读取什么；
- 哪一部分会进入哪个 View package；
- 用户看到的披露类别是什么；
- 撤销后哪些缓存/持久状态要删除，哪些历史披露无法撤回。

网络出口限制仍可作为纵深与产品 profile，但**不作为 authority 证明**。当前
`connect-src 'none'` 会阻止常见主动连接 API，却不能构成“代码绝不对外发出任何比特”的证明；
这不影响 capability 边界，因为 capability 和凭据从未交给 View。

## 5. 两种前端 profile 可以并存

### 平台声明式 renderer

- App 只提交受限的声明式 UI/事件结构；
- 平台代码负责渲染；
- 适合低信任、易审核、希望更强一致性的 App；
- 仍需对投影数据和 capability 单独授权。

### Publisher JavaScript

- 平台托管并按 digest 发布发布者提供的前端源码/产物；
- 在独立 origin 的 sandbox iframe 中执行；
- 可以获得更强交互能力，但投影给它的数据视为已向该发布者披露；
- 首次运行前必须通过发布者信任闸门。

两种 profile 共用同一个 proposal → trusted Host → capability Gate 管线。profile 变化（尤其从声明式
变成 publisher JS）必须重新提示发布者信任，但不应自动扩大 capability grant。

使用不同 eTLD+1 是可选的高强度部署 profile，不是第三方 App 的逻辑前置条件。同一 registrable
site 也必须使用不同 hostname、host-only `__Host-` Cookie、精确 origin、无 App Cookie、无 App
CORS；不同 eTLD+1 再增加 cross-site 纵深。

## 6. “开源且由平台托管”的可审计含义

只放一个仓库链接不够。平台必须能展示并验证下面这条链：

```text
publisher identity
  → immutable source snapshot digest
  → build recipe / toolchain record
  → produced package digest
  → digest-addressed App origin currently loaded
```

最低记录包括：

- 不可变源码快照及其 digest；
- 构建入口、依赖锁文件、工具链版本和构建日志；
- 产物清单与 `packageDigest`；
- App 声明、permission contract 及其 digest；
- 发布者对 release 的签名或平台接收/构建证明；
- 平台实际服务的包与该记录一致的验证结果。

优先使用可复现构建；暂时不可复现时，平台必须明确标为“平台构建并见证”，不能暗示任何人仅凭
源码就能重现字节。`packageDigest` 绑定运行字节，`sourceSnapshotDigest` 绑定供人审阅的源码，二者
不得互相推导。

## 7. 重新提示与撤销

至少在这些情况重新提示**发布者信任**：

- publisher 身份变化；
- 运行 profile 变得更强；
- 源码快照/构建记录缺失或与运行包不一致；
- 用户选择的是“仅信任精确 release”，而 package 发生变化。

至少在这些情况重新提示**能力授权**：

- permission contract 扩大；
- 新增资源类别、外发/写入效果或更宽条款；
- App/Agent 衰减关系变宽。

收窄立即生效，无需确认。publisher 改变不继承 grant。撤销 capability 时先持久化拒绝事实，再销毁
派生 Context、pending approval、流和租约；撤销 publisher trust 时停止加载该发布者的包。两种撤销
都不能声称已收回过去披露的数据。

## 8. 当前 Session Plus 的真实状态

M1 只走完了边界骨架：

- 已有稳定 `appId`、publisher、package digest 与空 permission-contract digest；
- publisher 与 digest 显示在可信外层；
- App View 只收到假 projection，只能提议无害假动作；
- permission contract 为空，没有 Runner/Session capability；
- 没有安装、发布者同意、源码快照绑定或持久 App grant UI；
- `GrantLedger.authorize()` 仍只是未来用户同意流程的接缝，当前生产 App grant 来自运维配置。

所以 M1 既没有“错误接入权限系统”，也没有“权限闭环已上线”：它刻意没有申请任何权限。M5 才
把这三种状态做成真实、持久、可撤销的用户流程。

## 9. 非目标

本 ADR 不决定 App Store 排名、审核 SLA、证书颁发、付费、恶意软件响应和具体 UI 排版；也不要求
M1 立刻实现第三方发布。它只固定日后实现时不能混在一起的信任与授权边界。
