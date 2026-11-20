---
decision_status: accepted
realization_status: partial
supersedes: []
superseded_by: []
tickets: [166]
---
# ADR 0008 — Policy Domain 与可解释 Permission Program

- 状态：**已接受；首个运行时纵切与 C2/C3 门禁已在 feature branch 完成，landing pending**（2026-08-15）
- 产品原型：[`doc/prototypes/permission-studio/`](../prototypes/permission-studio/)
- 详细设计：[`doc/development/policy-domain-authorization-design.md`](../development/policy-domain-authorization-design.md)
- 前置决策：
  [ADR 0002](./0002-agentic-app-publisher-trust-and-capability-grants.md)、
  [ADR 0007](./0007-guarded-shared-state-machine-apps.md)、
  [`doc/tcb-reading-guide.md`](../tcb-reading-guide.md)

## 1. 背景

Octopus 已有多条真实授权路径：Agentic App grant、capability-kernel、shared App ACL、
Tentacle、MCP 与 Dashboard cross-user route policy。它们保护的对象、事实源、审批语义和撤销
生命周期不同。此前的 `/permissions` 只能编辑其中一部分；本纵切新增统一、source-labelled 的 Studio
read model，目标是诚实回答用户最关心的问题：

> 我登记的哪些资源，被哪个 user、App、agent、organization 或 workspace，以什么动作、确认
> 模式、继承来源和目标受众持有；某个具体动作为什么 allow、ask 或 deny？

把现有表拼成一张“统一权限表”会制造两个错误印象：所有平面已经共用同一执行门，以及浏览器
能编辑全部底层状态。两者都不成立。相反，只向用户暴露 kernel 的 Context、slot、Object 或
digest，也不能形成可编程的日常心智模型。

本 ADR 决定产品模型、新 canonical 层、对象粒度和兼容纪律。第 3 节单独列出 feature branch 已实现的
运行时纵切与仍属 future 的产品能力；文档状态不等于 landing 或 deployment 状态。

## 2. 决策摘要

### 2.1 kernel 始终是 sole enforcement

对已进入 capability-kernel 的资源，唯一可产生实际 effect 的路径仍是：可信代码绑定身份和
资源，进入 `gate.invoke()`，由 kernel 重新验证 live authority、参数、mandatory policy 与批准
证据，再调用固定 adapter。

新 Permission Studio、policy program、exact permit、解释结果和 compatibility projection 都不能：

- 直接调用资源 adapter；
- 向浏览器发 bearer、Context、slot、Object 或 credential；
- 让一次“保存成功”替代 Gate 或 provider/service 的执行时重检；
- 让 approval 创造原本不存在的 authority；
- 让旧 compatibility row 在撤销后继续放行。

尚未进入 kernel 的 shared App、MCP 子平面与 Dashboard cross-user route 继续由各自当前 service/
Cedar/ACL 门执行并重检。它们迁入统一 Gate 之前，文档和 UI 必须明确标出真实 enforcement source，
不能把“在同一页面可见”写成“已由 kernel 统一保护”。

### 2.2 人类模型固定为 Authority / Domain (Audience) / Permit

日常产品只使用三个概念：

- **Authority**：谁有权为资源作授权决定；
- **Domain (Audience)**：资源当前属于哪个边界，以及结果会被谁看到或影响谁；
- **Permit**：某个 holder 对一个动作的精确许可。

产品结果为 `allow`、`ask`、`deny` 或少量 `block`：

- absence 即 `deny`，不持久化一张普通 deny permit；
- permit 只包含 `allow` 或 `ask`；UI 把无需逐次确认的 `allow` 显示为 `AUTO`；
- `ask` 是已有 permit 的确认属性，不会补出缺失 authority；
- `block` 只属于受信 mandatory program 的少量硬阻断，不能成为另一种随处可写的 deny；
- `delete`、`send`、`pay`、`publish`、`execute`、`manage_access`、
  `use_credential` 始终独立，不从 read/create/update 推导。

Context、slot、Object、contract digest 等仍是内部执行证据，不进入普通 Permission Studio UI。

### 2.3 新 canonical 层是 program + exact permit + compatibility projection

新的 canonical 权限模型包含三类受信材料：

1. **可信、可解释的 typed policy program**：由可信组合代码注入的不可变规则，表达 organization
   mandatory authority、domain/audience 规则和少量 mandatory block；它不是浏览器记录，也不要求
   与 permit 一样持久化；
2. **durable exact permit**：目标模型绑定稳定 resource id、精确 holder、独立 action、`ask|allow`、
   authority、audience、来源、版本和生命周期；当前 v45 首切只持久化 subject/resource/operation/
   mode/authority/source 与创建/撤销证据，audience/version 仍待 schema 演进；
3. **compatibility projection**：把 canonical 决定投影成既有 grant/ACL/service 可消费的窄记录，
   或把尚未迁移的既有事实以 source-labelled 只读行投影进 Studio。

policy program 不是浏览器可提交的任意 DSL。当前核心能验证 organization mandatory typed rules，
且 trusted composition 已有显式 `authorizationRules` 注入 seam；省略时规则集为空，production 默认
没有组织程序。domain-wide 与 future-member 规则最终必须由这种受信 program 表达，不能靠一批
浏览器生成的 wildcard permit 模拟。

解释是对某个 evaluation 的可信、可检查 evidence，不是 authority token。当前 explanation 没有
持久 decision/event 记录，不能冒充审计日志。compatibility projection 是迁移和互操作机制，不是
第二个授权真相。

### 2.4 两套 Authority，不互相覆盖

- **Personal owner authority** 管理用户登记并仍拥有的个人资源；用户可以在 App 安装上限内授予、
  收紧和撤销 exact permit。
- **Organization mandatory authority** 管理机构托管资源；只有经组织授权的 steward 能修改其
  typed program。个人 owner、App 和 workspace 都不能放宽或覆盖它。

workspace 是 audience 与受信 policy holder，不自动成为个人或机构资源的 authority。它可以管理
复制进 workspace 后的新工作副本，或在上游 authority 已允许时管理 live read-only view 的成员受众。

App 安装许可只给出长期上限。单资源 permit、App 内部 agent 的衰减、当前 resource 状态、mandatory
policy 与执行时 Gate 继续取交集。人类 plane 的 AUTO 不自动传给 App agent plane。

### 2.5 安全默认是稳定 resource id + exact permit

每个可授权资源使用由可信 provider/registry 签发的稳定 resource id；展示 label 不是 identity。
默认授权对象是：

```text
exact resource × exact holder × exact action × exact audience
```

目录、workspace、domain 或“未来成员”不是可由客户端扩大匹配的通配符。确有批量语义时，由一个
类型化 policy program 生成或在执行时评估 exact result，并保留 program version 与解释来源。

### 2.6 workspace history policy 先只支持可诚实执行的模式

当前 shared App 的 viewer projection 从 folded state 产生。新成员看到的当前状态可能已经包含加入
前事件的影响，因此当前公开产品/API 只支持值 `all`（即 all-history 语义）；UI 不得提供看似可用的
`since_join`。内部 planning type 出现该值不代表已有公开保存 API 或隔离保证。

`since_join` 只有在服务端记录可信 join event/sequence boundary，projection contract 能按该边界
折叠且每个 App 证明边界语义正确后才能启用。仅有 `joined_at` 时间戳或前端过滤不能提供这个保证。

### 2.7 跨 domain 只产生三种明确产物

- **shared snapshot**：`publish/copy` 生成静态副本；之后不随源更新；
- **live read-only view**：`link` 保留源 authority，目标 audience 只有 read；可撤销未来访问；
- **editable work copy**：`copy` 生成新 resource id 和新 authority；后续编辑不改源资源。

“把源标签带到目标、在 sink 前检查 flow decision”只能作为粗粒度纵深，不能声称是完整 information
flow control。没有全链路来源传播、派生跟踪和所有 sink mediation 时，不对间接复制或手工重述作
机密性保证。

### 2.8 credential 永远是 opaque handle

Permission Studio 只展示安全 label 和 `use_credential` permit；凭据值不进入投影、解释、日志或
App View。系统不实现“把真实 key 换成假 key 再让任意代码运行”的 substitution 方案：只要任一
网络、命令、日志或文件 sink 未被完整中介，假替换就不能证明凭据或效果安全。完整 sink mediation
成立之前，只有可信 adapter 能解析 opaque handle，并且每次使用仍经 Gate。

### 2.9 Permission Studio 是 trusted Dashboard bespoke surface

该产品需要跨 App、user、organization、workspace 与兼容平面查看和修改可信控制面状态，因此实现
形态是 trusted Dashboard 中的 bespoke surface，不是 Agent View，也不在 iframe 内持有 proposal
client。它仍必须：

- 只渲染 viewer-safe、source-labelled 的服务端响应；
- 经 Dashboard session、CSRF/mutation gate、route policy 和 handler recheck 提交变更；
- 不把 DOM 隐藏当作角色隐私边界；
- 把 pending、refused、read-only 和 revoked terminal 作为服务端状态呈现；
- 对共享数据 label/说明按不可信文本渲染，防 prompt injection 与 active content。

## 3. Current 与 future 边界

### Feature branch current（尚未 landing/deploy）

- v45 已建立 policy domains、稳定 resources、当前窄 schema 的 durable exact permits 与持久 App
  defaults；没有 authorization event 表；
- `AuthorizationService` 是可信 program/evaluation 边界，提供 `decideAccess`、`decideFlow`、
  authoritative `explain`。mutation 先提交 durable row，再向进程内 listeners 发 notification；
  notification 不是持久审计事件，重启后不重放；
- organization typed-rule validator/evaluator 核心与 trusted compose injection seam 已存在，但省略输入
  时为空，production 默认没有组织 program；因而不能从接口存在推断 ACME mandatory policy 已启用；
- App defaults 已持久化，但当前没有通用 installer consumer；它们只作为未来安装表单的草稿初值，
  不给现有或新 App 自动创建 permit；
- Tentacle 是首个真实 canonical exact-permit consumer：新 share 只写 canonical permit，旧 grant
  继续 read-compatible，revoke 同时终结 canonical 与旧记录；每个 effect 仍进入既有 Gate；
- trusted Dashboard Studio UI、GET projection、owner-only `explain` / `apply` 已实现；apply 只接受
  服务端冻结的 opaque proposal，浏览器不能提交任意 program/DSL 或 authority。通用 Studio 只写
  generic grant 与 App default；canonical domain/resource/permit 行只读，Tentacle exact permit 由下方
  专用 share/revoke 控件写；
- 统一投影已经纳入 generic grants、canonical/Tentacle、MCP token attenuation（仅单向 opaque
  handle）、shared App membership（history=`all`）、legacy cross-user default ASK，以及无执行门的
  trusted service honest `unenforced` 状态；同屏出现不改变各自执行门；
- capability-kernel/Gate 仍是 canonical resource effect 的 sole enforcement，既有 service/ACL/Cedar
  继续在各自边界重检；
- C0 prototype 仍是纯假数据，不能当作 production evidence；production Dashboard UI 已实现矩阵、
  窄屏列表、解释、frozen proposal apply 和拒绝保留草稿。repository final gates 与 owner 可用纵切的
  C3 browser 对照已通过；完整 steward/workspace/auditor workflow 仍是 future，不能从只读 inventory 推断。

以上是当前 feature branch 的实现事实，不是 deployed production 状态。landing pending；deployment
未请求且未发生。

### Future implementation

- 保持已通过的 trusted Dashboard production build、整页 smoke、390px、keyboard focus 与 owner
  explain/apply/no-poll browser gate；新增 steward/workspace/auditor workflow 时再扩展对应 actor matrix；
- 保持 organization rule compose input 为显式 trusted-only；production default 继续无 program，任何真实
  规则注入都必须先有部署配置、负向测试与 review，并另行完成 steward workflow；
- 如需让 installer 消费持久 App defaults，新增独立安装确认 contract；默认值只能预填 draft；
- 为 generic grants、MCP、shared App、legacy cross-user 与 honest-unenforced service 逐一决定只读、
  round-trip edit 或长期兼容姿态，不能因统一投影而假装统一 enforcement；
- 扩大 canonical consumer 前逐平面补齐执行时 freshness/recheck、迁移与回滚证明；
- 在具备 event/seq boundary 后才启用 `since_join`；
- 在真实 provider 支持后才启用三种跨 domain 产物的生产动作。

## 4. 兼容纪律

1. 每个旧平面必须单独记录 **enforcement**、**source of truth**、可编辑范围与撤销语义。
2. 未迁移平面在 Studio 中默认只读，并显示来源；不能从 UI 形似相同推断底层相同。Tentacle 是
   当前例外：它已成为 canonical exact-permit consumer，但仍保留旧 grant read compatibility。
3. canonical → legacy projection 必须检查 freshness 或直接重读 canonical result；当前 Studio revision
   是投影摘要，不是 v45 permit row version。异步投影延迟时 fail closed。
4. legacy → Studio projection 不获得反向写权限。只有定义了完整 round-trip 与冲突策略的平面才能编辑。
5. publisher trust/source transparency 继续与 resource permit 分离；一个勾选不能同时改变两者。
6. shared App 领域规则仍留在 sandboxed pure action/projector；Permission Program 只表达通用 authority、
   audience 与 permit，不吞并 App 业务规则。

## 5. 结果与代价

### 收益

- 用户获得稳定、可解释的日常模型，同时保留现有 kernel 强制边界；
- exact permit 让撤销和 EXPLAIN 能指向同一个稳定对象；完整持久审计仍需独立 event/evidence 设计；
- typed program 能表达 domain-wide/future-member 语义，而不向浏览器开放任意策略语言；
- compatibility projection 允许逐平面迁移，不要求一次性重写全部授权系统。

### 代价

- 迁移期同一页面会出现 Studio 可编辑的 generic/default 行，以及 source-labelled 只读 canonical/legacy
  行；canonical exact permit 当前只由 Tentacle 专用控件写；
- 每个兼容平面都需要单独的 freshness、撤销和回滚证明；
- 完整 EXPLAIN 只能覆盖已有可信 evidence 的路径，不能用猜测填补旧系统的缺失来源；
- trusted rule evaluator 与 decision evidence 已进入授权审查边界；production 默认空 program。未来开放
  compose injection 或扩大 rule family 时需要预算、负向测试和人工安全复审。

## 6. 被拒绝的替代方案

- **让浏览器写通用 policy DSL**：扩大 TCB、难以审计，并可用 wildcard 绕开 exact-resource 默认。
- **把现有数据库表直接合并成一张 grant 表**：丢失各平面的 enforcement 与生命周期差异。
- **让 Permission Studio 自己执行资源动作**：形成 Gate 旁路。
- **把所有 deny 都存成 BLOCK**：破坏 absence-deny，令继承和解释不可理解。
- **用 resource label/path 作为授权 identity**：重命名、碰撞和注入会改变授权靶点。
- **现在提供 `since_join`**：folded state 无可信 event/seq boundary，UI 会承诺系统不能执行的历史隔离。
- **把 source label flow 称为完整 IFC**：缺少全派生链和 sink mediation，不具备该保证。
- **fake-key substitution**：任一未中介 sink 都能绕过或泄露，且会给用户错误安全感。

## 7. 后续决策门

下一纵切必须先为所选兼容平面或 program family 补齐同等级 source/enforcement、负向测试与 actor C3，
不能把本次 owner/Tentacle 纵切的通过结果外推到尚未实现的 steward/workspace/credential workflow。
organization steward 委派、`since_join`、跨域 artifact provider 与全 sink credential mediation 仍是
明确 future。触及 kernel policy/TCB 闭包时，按 `doc/tcb-reading-guide.md` 重新计算并审查闭包；
feature branch 测试通过、landing 与 deployment 是三个分离状态。
