# Agent Module Contract — 模块 ABI（纯数据）

> 2026-08-06 新增（v4 模块平台第一纵切）。
> 设计：`doc/development/agentic-app-module-system-design.md` §18.1–18.3
> 交付：`doc/deliveries/2026-08-06-agentic-app-module-platform.md`

## 一句话

一个模块系统的两半必须同意的东西：module manifest、`agent-module-lock/v1`、
`agent-composition/v1`、**五个固定 slot**、`open-resource/v1`。全部是纯数据 + 规范编码 + 严格校验。

## 零依赖是设计不是巧合

| 不依赖 | 为什么 |
|---|---|
| React | 一个 release adapter 在 Node 里读 composition，永远不渲染；浏览器包会渲染。**一份定义，两个消费者** |
| Host / Bot / 传输 | 这里不知道 MessagePort 是什么、capability 是什么、谁登录了。module id 只被**比较**，resource ref 只被**携带**——都不会被解析、拼成路径或 fetch |
| 抛异常 | 每个 reader 返回 `{ok:false, issues}`，字段级、有界。两个消费者都必须在**不打扰正在工作的东西**的前提下拒绝 |

唯一会抛的是 `moduleLockOf()`：它从本 bundle 编译进来的 manifest 构造 lock，失败是编程错误而不是不可信输入。

## 文件

| 文件 | 职责 |
|---|---|
| `src/slots.ts` | 五个 slot，**而且恰好是五个**。第六个 slot 是一次设计变更，应该表现为这里和每条一致性测试的 diff。**2026-08-10 起还有 `DOCUMENT_SLOTS`**（primary/secondary/overlay）——「哪些 slot 放的是文档而不是一条 widget 带」是 template 能不能派生的判据，第二处拼出这三个名字就是第六个 slot 到来时会漏掉的那一处 |
| `src/ids.ts` | 全部标识符文法。每个都窄，因为每个都是**键**：module id 键静态 registry，instance id 键 React 子树（因而键着读者没写完的草稿），contract id 键 port |
| `src/manifest.ts` | 模块自述：id/version/implementation/title + `slots`（可放哪）/`ports`（要绑什么契约）/`opens`（能显示哪类资源） |
| `src/lock.ts` | `agent-module-lock/v1`：bundle 里到底有什么。**从 manifest 派生**，不是手写 |
| `src/composition.ts` | `agent-composition/v1`：实例 + slot + 有限 open rule；`linkComposition` 做跨文档校验 |
| `src/bindings.ts` | `agent-resource-bindings`：App 需要哪些 typed port（`bindings`）、哪个模块实例接哪个（`connections`），**v2 起**哪些被接线的实例可以派生成一族运行时 panel（`templates`）；`linkResourceBindings` 做跨文档校验，**先按 schema 分支** |
| `src/permissions-doc.ts` | **2026-08-08**：`app-permissions/v1`——release **自己说出**它申请哪份权限契约。**只有一个字段 `contract`**，见下方一节 |
| `src/resource.ts` | `ResourceLink` 与 `open-resource/v1`：模块能对布局说的**唯一**一件事。**2026-08-07 起 intent 可带 `context`**（不透明有界 KV，"打开并跳到 120 行"）：平台只运输**永不解释**，语义归 resource kind 词表（与 ref 同一哲学）；**不进复用身份**——同资源换 context 是同一个 panel 换指令 |
| `src/config.ts` | **2026-08-07（决定 7）**：实例配置与 intent context 的两条有界值通道。模块 manifest 声明 `config`（扁平、typed、可评审），composition 实例带值；**值对声明的检查只发生在 registry 在场处**（浏览器与 pack 路径，与 linker 的 manifests 规则同一条）。没有表达式、没有嵌套、没有计算 |
| `src/validate.ts` | 共用的拒绝机制：未知字段是**拒绝**不是忽略；诊断有界且去掉控制字符 |

## 三条不可协商

1. **未知字段 = 拒绝。** 这些文档是被 package digest 覆盖的 release 资产。本构建不认识的字段
   要么是更新的 schema（不能乐观解释），要么是一个**悄悄关掉了某个东西**的拼写错误。
2. **composition 只能引用 lock 里的 module。** 一个 composition 不能把模块**说**出来；它只能接线
   构建期已经编译进去的实现。反过来读：改这两个文件就改 `packageDigest`，就换主机名。
3. **round-trip 是字节相等。** 每个 normalizer 用**一个固定字段顺序**构造结果，所以
   `encode(parse(x)) === x` 是一条测试能断言的等式，而不是关于排序函数的主张。

## linker 的 `manifests` 参数：给不给是身份问题，不是严格度问题（2026-08-07）

`linkComposition` / `linkResourceBindings` 的 `manifests` 可选。**给 = 调用方声称「这份 registry 就是
bundle 的实现清单」**，于是 lock 必须是它的精确身份（`module_identity`）、slot/opens/ports 全按 manifest
执行。只有两类调用方有资格这么说：**浏览器**（registry 与 bundle 出自同一次编译）与 **pack 路径**
（`packages/bot/src/app-registry/session-plus-package.ts` 的 `checkoutPlanProblem`，bundle 正从这个
checkout 打出来）。release adapter 对**已安装**的 release 一律**不给** manifests——历史 release 与它自己
的 bundle 被同一个 packageDigest 覆盖、天然自洽；拿今天的清单去审它是在检查一个不相关的等式，后果是
模块版本一 bump、全部历史 release 不可回滚（收敛计划·决定 11）。

## `agent-resource-bindings/v1` 为什么是第三份文档

`agent-composition/v1` 回答「挂了什么、挂在哪」，它回答「接到什么上」。**不合并**，因为 composition
的字段闭集是被 package digest 覆盖的，往里加一个键的 release adapter 就是在接受一个它读不懂的更新
schema；加一份文档是 reviewer 看得见的变化，把一份文档变宽则看起来什么都没发生。两者的生命周期也不同：
换布局不该动依赖，加依赖不该动屏幕上的任何东西。

它**只**声明需要与接线。里面没有 provider 包名、Node import、URL、owner、device、workspace id、
Context、grant、token、启动命令或版本范围——满足需求的是部署者在 composition root 里显式注册的静态
目录（`packages/bot/src/agent-resources/`），这是 Backstage 的规则：能点名实现的 manifest 就是能安装
实现的 manifest。

`port`（模块 manifest 声明要绑的契约）与 `contract`（binding 向部署者要的契约）都写出来、由 linker
比对：两者几乎总是同一个字符串，而它们不同的那一次正是这份文档要抓的错。

**2026-08-06 起它是 Session Plus 的第三份 release 资产**（`view/resource-bindings.json`，`modular-v2`
10 资产闭集）。legacy 7 与 modular-v1 9 继续可 prepare / activate / rollback——它们的 `resourceBindings`
是 `null`，所以 resource proposal 一律有界拒绝，会话行为逐字不变。

## `agent-resource-bindings/v2`：template 说的那一句话（2026-08-10）

v1 接线的是**具名的 composition 实例**。所以在它旁边铸出来的运行时 panel 是匿名的——那份决定「什么
被连接」的文档里没有它——而因为 App 的 provider 挂在整个 workspace 之上，它在屏幕上看起来又像是有
port 的。布局内核诚实地堵住了这一点（连接过的 surface 上 `mode:"new"` 被拒绝），代价就是一个 Session
Plus 工作区只能开一个文件。

template 是那句缺失的话：**从这个具名实例派生出来的 panel，继承它的 module `config` 与它那一整族
connection，上限由 release 写出来。**

```jsonc
{ "schema": "agent-resource-bindings/v2", …, "templates": [{ "instance": "file-viewer", "maxInstances": 12 }] }
```

四条：

1. **两个字段，闭集。** 没有 provider、owner、app、scope、URL、路径、权限或代码——与 v1 同一张清单，
   同一种执行方式（一条两字段记录 + 其余每个键都是拒绝）。
2. **它不扩大任何授权。** 派生 panel 继承的是一个**已经存在的 binding 名**，而 provider scope 在可信
   侧按 `[owner, app, appInstance, binding]` 派生——所以十二个文件 tab 仍然是一个 scope、一个 ref
   vault、一份可撤销的 grant。权限契约、`SHAPE_CONTRACT` 与 `CONTRACT_RESOURCES` 一个字节没动：
   一份 plan 长出一条 template，**不能读起来像一次新的 ask**。
3. **`maxInstances` 把常驻实例本身算进去**（1‥`RESOURCE_TEMPLATE_MAX_INSTANCES` = 16），因为那正是
   读者拿来跟「这里最多能开几个 tab」比对的那个数。
4. **为什么是第二份 schema 而不是 v1 的一个新字段。** 与这份文档存在的理由完全相同：v1 里的未知键是
   拒绝，所以一个早于 template 的构建**不能、也不该**悄悄接受一份它永远不会产出那些 panel 的 plan。
   v1 的 reader、encoder、canonical 字节与 open-surface 规则因此原样保留在自己的分支里。

**校验分层沿用 v1 那条界线**：文档内部的事归 reader（唯一性、有界上限、`templates` 非空、prototype
至少接了一条 binding），跨文档的事归 linker——而 linker 的 template 检查**不需要 manifests**（template
点名一个实例，它主张的每个 port 都写在这份文档自己的 connections 里），所以 `prepare()` 那条**不给
registry** 的安装路径同样会拒绝悬空、错 slot 与有歧义的 template。

**路由的单位是 `(module, open slot, port)`**，因为那正是后续 resolver 手上握着的三元组。同一条路由上
两个 template，或者一个 template 与一个被接线的直接 surface 并存，都是 fail closed：否则选择权落到
数组顺序或某种隐式优先级上，而赢的那个决定了新 panel 继承谁的 `config` 与 connection。

**public reader 返回联合类型 `ResourceBindingPlan`**，这是强制函数——每个消费者都被类型系统要求表个态。
`AgentResourceBindings` 这个名字**仍然只指 v1**，所以 `packages/agent-view-react` 与
`session-plus-view/src/plan.ts` 是**零改动**：把一份 v2 plan 交给 `createWorkspacePlan` 今天是**编译
错误**，直到 layout 集成票放宽它。也就是说**本 checkout 打不出一个 v2 的 release，而且这件事由类型
系统说出来**——ABI 已经冻结，运行时（第 13 个 tab 怎么办、config 怎么继承）不在本票。

不要在消费者里写 `plan.schema === …` 分支：用 `planTemplates(plan)`（v1 得到 `[]`）与
`templateFor(plan, instance)`。前者存在的理由就是让「这个 surface 能不能被复制」成为一个问题，
而不是让「这是哪个 schema」成为一个会在 v3 到来那天过期的分支。

## `app-permissions/v1` 为什么只有一个字段（2026-08-08）

在它之前，「这个 release 申请哪份权限契约」只由**资产形状**回答：平台内部一张 `SHAPE_CONTRACT` 表把
`modular-v2` 映到八词元契约，descriptor 的 digest 与它比对。那是一个够用的**检查**，却是一句空白的
**声明**——拿着字节的人无法在不读服务端源码（而且是将来会服务它的那一版源码）的情况下知道自己被要求
同意什么。权限 ask 恰好是一个 release 里唯一需要人点头的东西，它应该在 release 里可读。

所以 release 把它说出来，**而形状表原样保留**，两者必须一致，不一致两个方向都拒绝。这是**防笔误，
不是双真相**：平台仍然是唯一决定「有哪些契约、每种形状可以声明哪一份、它们各自是什么意思」的一方，
也仍然是唯一授权的一方——**没有任何授权、投影或审计路径读这份文档**。

字段只有 `contract` 一个，而且必须保持只有一个。不放 operation 列表、不放 auto-allow 集合、不放 scope、
不放理由文本：能枚举自己 operation 的 release 就是能发明一个的 release，而那份枚举已经在平台的闭集
目录里存在一次——只有它能把一个 operation 映到 Gate 词元、同意页的一行和一条审计记录。这里的 id 只被
**比较**，永不被解析成权限、路径或 URL；未知 id 不是「更小的 ask」，而是本构建无法投影、授权或审计的
ask，唯一诚实的答案是拒绝——与 descriptor digest 得到的答案完全相同。

文法复用 `isContractId`：权限契约 id 不是 typed port，但它是**同一种字符串**（短、带命名空间、带版本、
只被比较），第二套文法就是第二个会以同样方式写错的地方——与 `bindings.ts` 复用 instance-id 文法同一条
理由。

**2026-08-08 起它是 Session Plus 的第四份 release 资产**（`view/permissions.json`，`modular-v3` 11 资产
闭集，声明九词元的 `sessions-workspace-write/v1`）。前三种形状继续可 prepare / activate / rollback，
并且它们的权限推导路径**逐字未动**——那条路径决定回滚目标的 permission digest，进而决定它们的
package digest；重新描述一个老包会让人回滚到一个从未存在过的 release。

## 测试

```bash
npx vitest run --project node packages/agent-module-contract
npx tsc --noEmit -p packages/agent-module-contract/tsconfig.json
```

`src/contract.test.ts` 覆盖 canonical round-trip 与每一条关键拒绝分支：版本范围、重复 instance、
lock 外引用、未知 slot / open mode / 字段、坏 JSON、像 URL 的 implementation。

`src/bindings.test.ts` 覆盖 plan：重复 binding、悬空 binding、`port` 与 binding 的 contract 不符、
同一实例同一 port 接两次、未知字段、非法标识符、canonical 字节 round-trip 与排序归一，以及 linker 的
五条（实例必须在 composition 里、模块 manifest 必须声明该 port、**给了 registry 却缺这个 module 一律拒绝**、
无 registry 时只校验形状、跨 App 直接拒绝）。

最后那条容易写错：`manifests` 是可选的，但**给了它就等于说「模块只有这些」**。对缺失的 module 跳过端口
检查是三种结果里最坏的一种——它读起来像通过了。

同一个文件里还有两块 v2 专属的：`v1 outcomes are frozen` 断言**整个结果**（每条 issue 的 code、
message、`at` 与顺序），因为「v1 由没有改过的代码读」是 v2 作为第二份 schema 的全部价值，
而那句主张只值它那条测试的钱；`linking a v2 plan` 逐条钉住 slot 不是文档区、module 不是 open target、
prototype 所在 slot 没有对应 open rule、同一路由两个 template、以及 template 与直接 surface 抢同一路由。
**改到要动 golden 的那一刻，那个 diff 本身就是发现**。

`src/permissions-doc.test.ts` 覆盖两类：说得太多（未知字段、别的 schema、像路径/URL/无版本的 contract
id、非对象、坏 JSON）与**一份声明的第二种字节表示**（紧凑 JSON、多余空白、键序颠倒都能 parse 成同一份
声明，但都不是 canonical 字节——那正是 adapter 拒绝的东西）。

代码行数不再设预算测试（2026-10-15 评审：行数预算只制造 CI 红灯，不保护行为）。不要把 resource-binding ABI 与 module ABI 合成一个读取器；不要靠新建未枚举文件绕开既有边界。

resource-binding ABI 里的重复是**刻意的**：v1 的 reader、encoder、canonical 字节与 open-surface 规则
作为自己的分支保留，v2 的 template 规则是另一组、永不反向套用。合成一个通用 reader 会更短，
代价是让每一个历史 release 都依赖这次改动写对了。
