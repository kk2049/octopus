---
decision_status: accepted
realization_status: planned
supersedes: []
superseded_by: []
tickets: []
---
# ADR 0005 — 后端组合是可信组合根里的组合子，不是 App 能声明的管线

- 状态：**已接受（架构决策）**，尚未实施（2026-08-07）
- 上游决定：`doc/development/agentic-app-platform-convergence-plan.md` **决定 3**（本 ADR 就是它点名要的那一份）、
  **决定 5**（port kit）、**决定 6**（授权原则）
- 前置：[ADR 0002](./0002-agentic-app-publisher-trust-and-capability-grants.md)；
  `doc/development/agentic-app-module-system-design.md` §3、§5.1、§7.3、§8、§21、§22
- 现状实现（本 ADR 描述的是它的演进方向，不是它今天的形状）：
  `packages/bot/src/agent-resources/{types,catalog,workspace-files-provider}.ts`、
  `packages/workspace-files-contract/src/{port,remote}.ts`
- 落地阶段：形状随 **P1**（port kit）定稿，第一个真实消费者由 **P6**（写路径：文件写入 → CRDT）驱动。
  **本 ADR 今天不产生代码。**

---

## 1. 背景：这条记录为什么必须存在

平台迟早要在一个 typed port 上加横切能力：**并发控制**（两个标签页不能同时改一个文件）、
**审计**（这个 contract 上发生过哪些调用）、**限流**、**CRDT 封装**（把一份文件变成一个协作文档）。

这类需求有三条候选路径：

| | 形态 | 结论 |
|---|---|---|
| **a** | App 在自己的数据里声明管线（`pipeline: ["lock", "audit", "files"]`） | **否决**（§6） |
| **b** | 平台侧**组合子库**：`withLock(inner)` 等普通函数，部署者把结果注册成新的 contract id | **采纳** |
| **c** | 部署侧的参数化组合模板 / 组合 DSL | **推迟**，等真实重复出现（§6） |

决定 3 已经拍板选 b，并且明确要求"需要一份 ADR 把这条正面写下来"。**为什么需要一份**：
`agentic-app-module-system-design.md` §7.3 有四条关于后端托管的禁令，§5.1 有一条关于通用 `invoke`
的禁令，而"后端可以被组合"这句话**读起来**像是在削弱它们。它不削弱——但"读起来像"本身就是一个
风险：下一个人会在没有这份记录的情况下，把 b 当成 a 的许可。所以本 ADR 的一半篇幅是 §3 的逐条回应。

---

## 2. 决定

### 2.1 组合子是可信组合根里的普通代码

```ts
// packages/bot/src/dashboard/server.ts —— 今天已经存在的那段构造代码
const files  = workspaceFilesProvider({ service, openGrant });
const locked = withLock(files, { contract: "workspace-files-locked/v1", manager: locks, /* … */ });

catalog.register(locked);
catalog.seal();
```

四条性质，每一条都是"它为什么不是一个插件系统"的一部分：

1. **它是函数，不是配置。** `withLock` 由 TypeScript 类型检查、进 git、进构建、进 review、进 diff。
   没有名字解析、没有注册表查找、没有 `combinatorRegistry.lookup("lock")`。一个组合子被用到，
   **当且仅当**有人 import 它并调用它。
2. **它的输入和输出都是 `ResourceProviderDefinition`。** 目录（`AgentResourceCatalog`）一行不用改，
   也一个问题都不能少问：组合结果仍然要声明精确 contract、封闭 action 集与 `open`/`dispatch`/`close`
   三个方法，仍然经过同一个 `register()` 的形状校验，仍然被 `seal()` 封存。
3. **组合结果注册成一个新的 contract id。** 这是接口轴上唯一的表达方式（§4.2）。同一个 id 注册两次
   仍然抛错——"哪一把锁"不能取决于注册顺序。
4. **组合发生在进程构造期，`seal()` 之前。** 之后调用图冻结：`withLock → workspaceFilesProvider →
   Runner adapter` 这条链的每一条边都不再变化，没有任何运行期的值能改变它。这正是 §4.4 的分界线。

### 2.2 App 的 binding plan 一个字不变

App 侧看到的仍然只是一个扁平契约：

```json
{
  "schema": "agent-resource-bindings/v1",
  "app": "super-workspace",
  "bindings":    [{ "binding": "workspace", "contract": "workspace-files-locked/v1" }],
  "connections": [{ "instance": "files", "port": "workspace-files/v1", "binding": "workspace" }]
}
```

App 说的是**一个 contract id**。它不知道那后面有几层，也说不出层数、层序或层的参数——
`agent-resource-bindings/v1` 的字段闭集里没有地方能写下这些（`bindings` 只有 `binding` + `contract`，
`connections` 只有 `instance` + `port` + `binding`，未知字段是拒绝而不是忽略）。

模块看到的也一个字不变：`WorkspaceFilesPort` 的三个具名方法。wire 上的 action 字符串
（`resource.open_text` 等）里**本来就没有 contract**——目录从 binding 解析 contract——所以换成组合
contract 之后，remote adapter、模块代码、View bundle 全都逐字不动。

### 2.3 不需要扩展 capability 系统

组合子调用 `inner` 是**同进程可信代码之间的普通函数调用**，不跨任何信任边界：没有序列化、
没有传输、没有第二个进程、没有第二个 principal。因此它不产生新的授权点，也不需要内核认识
"转发"这个概念（§4.3）。

---

## 3. 对四条禁令与通用 `invoke` 禁令的逐条回应

§7.3 的四条禁的是**同一件事的四种形状**：让不可信的 App 数据决定可信进程加载并执行什么。
组合子发生在可信侧、构建期/部署期，四条实质一条也没碰。

### 3.1 §7.3-①「App manifest 指向一个 Node module 路径，Host 直接 `import()`」

- **它防的失效**：一份能点名实现的 manifest，就是一份能安装实现的 manifest。
- **组合子为什么不触碰**：组合子的模块路径写在 composition root 的**源码**里。App 说出的仍然只有
  一个 contract id，而 contract id 在这条路径上**只被比较，从不被解析**——`register()` 建的是精确
  相等的查表，`missingContracts()` 用的是同一张表，`serve()` 的第三问也是同一张表。一个 App 声明
  `workspace-files-locked/v1` 而部署没装它，结果是 `no_authority`（并且它的 release 在
  `prepare()` 阶段就因为 `missingContracts` 非空而 fail closed），**不是**去某处找一个叫这个名字的包。

### 3.2 §7.3-②「下载某个 App 时顺便把它的 backend callback 注册进 Gate」

- **它防的失效**：安装一个前端等于安装一段后端权限。
- **组合子为什么不触碰**：`register()` 与 App 的 install/activate 路径之间**没有边**。register 只在
  `DashboardServer` 构造期被可信代码调用，`seal()` 之后再调是抛异常而不是拒绝。一个 release 能做的
  极限是**声明一个本部署没装的 contract**，而那让它不可激活。**这条在组合之后反而更强**：组合子是
  部署者写的一行代码，它连"被 App 携带"这个形状都不具备。

### 3.3 §7.3-③「用一个通用 HTTP proxy、MCP proxy 或 `invokeArbitrary` 代替 resource contract」与 §5.1「模块不能拿一个通用 `invoke(name, args)`」

- **它们防的失效**：一个通用入口会让"这个 App 有哪些能力"从一个可读的闭集变成一个开放集合，
  目录的四问里前三问随之失去意义。
- **组合子为什么不触碰**（三层，逐层说）：
  - **模块那一层**：模块拿到的仍然是 `WorkspaceFilesPort` 的三个具名方法。组合子在 port 的**另一侧**
    （模块 → 远端 typed port → wire action → 目录 dispatcher → provider，组合子插在最后一步的内部），
    所以模块的类型一个字不变，它连"这里有一层锁"都表达不出来。
  - **wire 那一层**：action 仍然来自 contract 的封闭词表，仍然经过 `provider.actions` 的集合判定。
  - **provider 接口那一层**：**组合子的输出上没有 `invoke`**，因为 `ResourceProviderDefinition` 上
    没有这个形状。而且组合结果的 action 集必须**显式声明**并被校验为 inner 的子集（§7.3）——
    组合子可以少服务，不能凭空多服务。
- 补一条 §5.1 的相邻约束：「App 不能通过字符串选择真实文件路径、用户名、capability 或 **provider
  instance**」。contract id **不是** provider instance 的名字——一个 contract 至多一个 provider
  （重复注册抛错），所以 App 说的是"我要这个契约"，不是"我要这个实例"。

### 3.4 §7.3-④「为了'无需重启'把可写目录 watcher 当作后端发布权限」

- **它防的失效**：谁能写文件，谁就有后端发布权限。
- **组合子为什么不触碰**：组合子不带来任何新的加载机制。它增加的只是源码里多了一个函数调用。
  装一个新 provider（包括组合出来的）仍然是一次**部署**——决定 2 已经写死：新的 typed-port provider
  永远是平台级可信代码，走评审与部署。热更新的对象是 App release（前端 + 三份组装数据），
  **不是** provider。

### 3.5 一句话总结这一节

> 四条禁令禁的是"**App 数据点名实现 / 运行时 watcher / 通用 proxy**"。组合子既不是 App 数据说的话，
> 也不是运行时发现的东西，也没有通用入口。它是**部署者在源码里多写的一个函数调用**。

---

## 4. 授权模型

### 4.1 入口一次判定

决定 6 的原则（架构层，不涉内核实现）：

> 每个意图在其**来源**进入可信代码时授权一次；可信代码内部调用链不设检查；真实进程边界两端互验；
> agent 无论跑在哪一侧永远是不可信意图来源。
> 静态构造的可信管线调用图在构造期冻结，**入口一次判定覆盖全链**。

落到本 ADR：

- **入口**是 View 的一次 `propose` 到达可信侧的那一刻。那里做三件事：身份来自 instance handle
  （View 说的 owner/app/scope/instance **不被读取**）、目录的四问、以及 provider `open()` 里的
  **权限接缝** `openGrant(context)`。
- **内部**是组合子调 inner。那里**不再检查**，因为组合子没有自己的意图，也没有自己的身份可以被授权。
- **每个 operation 仍然过 Gate**——但那属于资源轴（下一节），是同一次授权在求值时与用户当前实际持有
  的权限求交集，**不是**接口轴上的第二次判定。

### 4.2 两根正交的轴

| 轴 | 问的问题 | 组合子在这一轴上是什么 |
|---|---|---|
| **接口轴** | App 被授了**哪个 contract id** 的**哪些操作** | 一个新的 contract id |
| **资源轴** | 用户**此刻实际持有**的资源范围（单份、求值时交集、显式收窄钉死不自动扩大） | 完全不可见 |

**"走锁 vs 直连"是接口轴上的两个 contract id**，天然区分：一个 App 被授权
`workspace-files-locked/v1`，另一个被授权 `workspace-files/v1`，policy 引擎看到的是两个不同的字符串，
**它不需要理解"转发"这个概念**。这比"给同一个 contract 加一个 `locked: true` 参数"强，因为参数不是
身份——两个 App 拿着同一个 id、其中一个声称自己走锁，那句声称没有任何东西在执行。

**两轴的连接不在任何表里，在部署者写下的构造代码里**：`withLock(inner, { manager, serialize, … })`
的**构造参数就是连接点**——哪个 lock manager、哪些 action 被串行化、转发给哪个 inner。这不是
"配置缺失"，这是这条设计的核心：一张表能表达的连接，就是一张能被别人写进去的连接。

### 4.3 组合子不是 principal，转发 authority 不复制 authority

三条，各自都是一句"因此不需要做什么"：

1. **组合子不注册权限词——"锁权限"不存在。** 用户不会在同意页上看到 `acquire_lock`，因为没有人
   在**用户的资源**上要求它：锁的对象是平台自己的并发状态，不是用户的文件。一个只对平台自身状态起
   作用的机制不进用户的权限词表；把它写进去只会让同意页多一个没有人能判断的条目。
2. **转发不复制。** 组合子持有的是 `inner.open(context)` 的返回值（provider 的 per-scope state），
   它**不派生第二条 capability 链、不持有第二个 Context、不认识 authority 这个词**。它的全部权力是
   **不往下调**（拒绝、排队、限流）。它做不到的是"调一个 inner 没被授权做的事"——因为它能调的只有
   inner 自己声明的那些方法，而那些方法背后是同一次 `openGrant` 派生出来的同一条链。
3. **明确否掉 per-provider principal 与同进程对称互查**（决定 6 已否，这里复述判据）：同进程内没有
   隔离可言（组合子与 inner 共享堆、共享 `close` 的时序、共享失败域），对称检查只提供复杂度不提供
   隔离；而每个 provider 一个 principal 会让授权词表按 provider 数量爆炸，并需要一台委托链机器。

### 4.4 构造期冻结 vs agent 运行期决策：分界线画在哪

> 分界线画在"**调用图是构造期冻结还是运行期决定**"上。

- **组合子在冻结的一侧。** `register()` 之后每条边都固定，所以入口一次判定覆盖全链。
- **agent 在另一侧。** agent 的每个新决定是一个新的意图，因此是一个新的检查点。一个 agent 通过
  **MCP 面**（决定 5：contract 是单一真相，MCP 面在可信边界机械派生）调这个 contract 时，那次调用
  **以 agent 自己的身份**重新过一次入口判定。链上有几层组合子不会让 agent 少过一次门。
- **判定规则，写下来以便将来可判定**：一个"根据模型输出选择转发给哪个 inner"的东西**不是组合子**，
  它是一个运行期决策者，必须回到入口判定那一侧。组合子的构造参数可以是运行期值（一个 lock manager
  实例、一个 sink），但**拓扑不可以**：谁转发给谁，在 `register()` 之后不再是一个问题。

### 4.5 一次"走锁的文件读"的完整调用链

```text
FileViewer（不可信 View：只有三个具名方法，不知道锁存在）
  │ port.openText(ref)
  ▼
remote adapter（workspace-files-contract/src/remote.ts）
  │ propose("resource.open_text", { binding: "workspace", ref })
  ▼ ────────────── 唯一那条 MessagePort（session-plus/2，未 bump，未新增第二条通道）
SessionPlusAppService.dispatchResource
  │ ① 身份全部来自 instance handle：owner / publisher / app / packageDigest /
  │    permissionContractDigest / instance。View 声称的一律不读
  │ ② 代次比对：旧 iframe 的迟到提议 → scope_closed
  ▼
AgentResourceCatalog.serve —— 四问，顺序就是安全内容
  │ 1. 哪个 binding？   ← 从 handle 的 plan **快照**，不是从 action 字符串
  │ 2. 哪个 contract？  ← 那个 binding 声明的 = workspace-files-locked/v1
  │ 3. 哪个 provider？  ← 精确查表；没有通用 proxy 兜底
  │ 4. action 在不在这个 provider 的封闭集合里？
  ▼
withLock.open(context)                      ← 第一次用到时懒开
  │ 原样转发 inner.open(context)：同一个 context、同一个**派生的** scope key
  ▼
workspaceFilesProvider.open(context)
  │ openGrant(context) —— 【权限接缝，本 ADR 不展开其内部】
  │   exact contract digest → 与 owner 的 grant 求交集 → 收窄到本平面的 operation
  │   → 派生一条 capability Context；空 = no_authority
  ▼
withLock.dispatch(state, "open_text", params, context)
  │ ③ 取 (scope, ref) 的锁；拿不到 → 有界拒绝，**inner 一次也没被调用**
  │ ④ 调 inner.dispatch(…)：同进程函数调用，不跨信任边界，**不再授权**
  ▼
workspaceFilesProvider.dispatch
  │ ref → vault.resolve(scope, owner, kind) → binding → backend → authority → Gate → device
  ▼
Runner（设备是最终权威：realpath、containment、UTF-8、digest 都在那一侧重做）
```

**这张图上授权只发生两处**：`openGrant` 那一次（接口轴 ∩ 资源轴，一次判定），以及 Gate 对每个
operation 的求值（资源轴的求值时交集，可能产生一张批准卡）。③ 与 ④ 之间**没有第二道门**，组合子
唯一的权力是不往下调。

---

## 5. worked examples（签名级，不是实现）

三个例子的共同形状：`provider → provider`。输入输出都是目录已经认识的东西，
所以目录不用改、也不能少问一个问题。

```ts
/** 组合结果的 per-scope 状态：原样持有 inner 的那份，加上自己的。 */
interface Wrapped<P, Own = unknown> {
  readonly inner: P;
  readonly own: Own;
}
```

### 5.1 `withLock` —— 并发控制管理器（同 interface，换 id）

```ts
/** 平台自己的并发控制。它的对象是平台状态，不是用户资源——所以没有权限词。 */
export interface ResourceLockManager {
  /** 取一把锁，或在有界等待后给出 null。key 由组合子派生，调用方给不了。 */
  acquire(key: string, options: { timeoutMs: number }): Promise<ResourceLease | null>;
}
export interface ResourceLease { release(): void }

export interface WithLockOptions {
  /** 组合结果的 contract id。**必须**与 inner 不同——这是接口轴上唯一的区分方式。 */
  contract: string;
  /** 组合结果的 interface（见 §7.3 的 linker 接缝）：与 inner 相同。 */
  interface: string;
  manager: ResourceLockManager;
  /** 显式的 action 集，`register()` 校验它是 inner.actions 的子集。 */
  actions: readonly string[];
  /** 哪些 action 要串行化。闭集，不是谓词函数——一个函数没法被 inventory 打印出来。 */
  serialize: readonly string[];
  /** 锁键。只许读 context（**派生的** scope）与 contract 声明过的参数字段。 */
  keyOf(
    context: ResourceProviderContext,
    action: string,
    params: Readonly<Record<string, string>>,
  ): string;
  timeoutMs: number;
}

export function withLock<P>(
  inner: ResourceProviderDefinition<P>,
  options: WithLockOptions,
): ResourceProviderDefinition<Wrapped<P, ResourceLease | null>>;
```

两个不明显的点：

- **拒绝码不自造。** 取不到锁走 contract 已有的闭集（今天是目录的四个码 + port 自己那一组）。
  如果将来真的需要在 UI 上区分"排队超时"，那是**contract 的拒绝码闭集加一个词**，要过 conformance 与
  评审，不是组合子私自发明一个字符串。
- **`serialize` 是数据不是函数**，因为它要能被启动 inventory 打印出来（§7.1）。

### 5.2 `withAuditLog` —— 运维审计（同 interface，换 id）

```ts
export interface ResourceAuditEntry {
  readonly at: number;
  /** 派生的 scope key，不是提议里的任何东西。 */
  readonly scope: string;
  readonly owner: string;
  readonly publisher: string;
  readonly app: string;
  readonly packageDigest: string;
  readonly permissionContractDigest: string;
  readonly binding: string;
  readonly contract: string;
  /** 组合链里的哪一层记的。过界的是拒绝码，不过界的是层名——层名只进日志。 */
  readonly layer: string;
  readonly action: string;
  /** **白名单**取值，缺省空集。绝不整包记 params，绝不记 ref 指向的内容。 */
  readonly params: Readonly<Record<string, string>>;
  readonly outcome: "ok" | "refused" | "unavailable";
  readonly refusalCode?: string;
  readonly durationMs: number;
}

export interface ResourceAuditSink { record(entry: ResourceAuditEntry): void }

export interface WithAuditLogOptions {
  contract: string;
  interface: string;
  actions: readonly string[];
  sink: ResourceAuditSink;
  /** 每个 action 允许进审计的参数键。默认空——"记录"不是默认更多。 */
  record: Readonly<Record<string, readonly string[]>>;
}

export function withAuditLog<P>(
  inner: ResourceProviderDefinition<P>,
  options: WithAuditLogOptions,
): ResourceProviderDefinition<Wrapped<P>>;
```

三个必须写下来的边界：

- **它不是 `permission_audit`。** 那张表是**同意与授权**的证据；这个 sink 是"某个 contract 上发生过
  哪些调用"的运维记录。合并它们会让一份证据被一批运维噪声稀释。
- **canonical path 与 provider 异常原文仍然不过界。** 目录层已经写死这一条（provider 抛出的错误是这条
  路径上唯一稳定携带路径的东西），组合子不能把它绕开——审计 sink 是可信侧的，但"可信"不等于
  "可以持有 canonical path"。
- **组合顺序是语义。** `withAuditLog(withLock(files))` 记的是**含等锁时间**的一次调用，
  `withLock(withAuditLog(files))` 记的是**拿到锁之后**的执行。两者都对，但它们回答不同的问题——
  所以顺序必须进 inventory（§7.1），不能只活在源码的一行里。

### 5.3 `crdtPipeline(files)` —— 管线（**换 interface，换 id**）

```ts
/**
 * inner 是 `workspace-files/v1`，产出是 `crdt-doc/v1`。
 *
 * 它不是装饰器：action 集、参数与结果形状全换，所以它是一个**新的 provider**，
 * 有自己的契约文本、自己的 conformance suite、自己的拒绝码闭集。
 * 它复用的只是 inner 这一个具体依赖。
 */
export interface CrdtPipelineOptions {
  contract: "crdt-doc/v1";
  interface: "crdt-doc/v1";
  /** Yjs 文档在可信侧。View 拿到的仍然是一个 typed port。 */
  documents: CrdtDocumentStore;
  /** 初始快照与 commit 落盘都走 inner 的封闭 action，不绕过它。 */
  files: ResourceProviderDefinition<unknown>;
  /** 一次 commit 的 mutation receipt 由平台服务发（§8 的概念端口），不由这里发明。 */
  receipts: MutationReceiptSink;
}

export function crdtPipeline(options: CrdtPipelineOptions): ResourceProviderDefinition<CrdtScope>;
```

**装饰器与管线的区别要写清楚**，因为它决定了要跑哪套 conformance：

| | contract id | interface | conformance |
|---|---|---|---|
| 装饰器（`withLock` / `withAuditLog`） | **必须换** | 不变 | 跑 inner interface 的**整套** |
| 管线（`crdtPipeline`） | 换 | **换** | 跑新 interface 自己那套；inner 的那套仍由 inner 跑 |

### 5.4 构造参数即"两轴连接点"的论证

看这三个签名里出现了什么、没出现什么：

- **出现的**：`manager`、`sink`、`documents`、`files`、`serialize`、`record`、`keyOf`。
  全部是**部署者手里的对象与部署者的策略**。
- **没出现的**：owner、app、publisher、device、workspace id、Context、grant、token、
  capability、用户名、路径、URL、包名。一个也没有——组合子拿到 owner 的唯一途径是
  `dispatch(state, action, params, context)` 里那个**目录派生的、只读的** `context`。

所以：**接口轴**由 `contract` 这一个字段决定（App 被授权哪个 id），**资源轴**由 inner 的
`openGrant` 决定（用户此刻持有什么），而**两者的连接就是这一次 `withLock(files, …)` 调用**。
连接点是一行代码而不是一张表，正是因为一张表能表达的连接，就是一张别人也能往里写的表。

---

## 6. 明确不做

- **不做 App 数据声明管线（选项 a）。** 三条理由，任何一条都足够：
  ① 它把"用哪个实现"变回 App 能说的话——一份能点名组合子的 manifest，就是一份能组装可信调用图的
  manifest，那是 §7.3-① 的实质，与字符串是不是路径无关；
  ② **组合顺序是语义**（§5.2），让 App 排列它等于让 App 决定审计记什么、锁的粒度是什么；
  ③ 授权轴会崩：如果 App 能自己拼链，"被授权的是哪个 contract"就不再是 release 里的一个固定字符串，
  而是一次运行期求值的结果。
- **不做参数化组合模板（选项 c）——推迟，不是否决。** 触发条件写下来：**出现第三个"同一组包装、
  只有参数不同"的部署**时再抽。理由：一个组合配置 DSL 是第二个求值器，而 TypeScript 已经是一个
  （有类型检查、有 IDE、有 diff、有 review、有栈）。
- **不做 per-provider principal，不做同进程对称互查**（决定 6 已否，判据见 §4.3）。
- **不做组合子间的运行时发现。** 没有 `combinatorRegistry`，没有按名字装配，没有组合子目录，
  没有 `providers.d/` 之类的可写目录。
- **不给 provider 接口加通用 `invoke`**（既有规则，组合之后更重要）。
- **不把组合子当热更新单元。** provider（含组合出来的）随部署走；热更新的对象是 App release。

---

## 7. 失效模式分析

### 7.1 组合子的**声明**与**构造**漂移

**失效形状**：`withLock(files, { serialize: ["open_text"] })` 注册成功、名字叫
`workspace-files-locked/v1`、启动无告警，而 App 实际用的是 `list_directory`——于是"走锁"在生产上
是**空的**：每个人都以为有锁，没有人有锁。这类缺陷不会报错，只会在一次并发写事故里第一次出现。

**三条抓法**：

1. **契约文本是评审对象。** 一个组合 contract 必须有一份写下来的契约文本：id、interface、
   它相对基础 contract 多承诺了什么、拒绝码闭集。它的机器可读部分就是 port kit 的 `contract` 自述
   字段（决定 5）。**没有文本的组合结果不许 `register()`。**
2. **组合链进启动 inventory。** `catalog.contracts()` 今天只给 id；组合之后它必须给出每个 contract
   的**完整链**，并进启动日志与 `/permissions` 的边界清单：

   ```text
   workspace-files-locked/v1
     = withLock(serialize=[open_text, list_directory], timeout=5s)
     → withAuditLog(record={open_text:[ref]})
     → workspace-files/v1 (runner)
   ```

   一条只在源码里成立的链，是一条没有人会在事故中复核的链。
3. **conformance 对组合结果也跑一遍**（§8）。组合子最容易破坏的恰恰是 inner 契约本身的性质。

**诚实地说抓不到的**：组合子**声称**串行化了、而锁键选错（两次调用取到两把不同的锁）。
没有任何结构能替它证明这一点——只能靠组合子自己的测试。写下来是为了不让人以为 inventory 覆盖了它。

### 7.2 深管线的调试与审计故事

组合对模块与 View **不可见**——那是它的价值，也是它的调试代价：FileViewer 上只会出现一句
"暂时无法完成"。规则因此是两条：

- **过界的是拒绝码，不过界的是层名。** 拒绝码仍然是 contract 的闭集（不许每层自造码），
  但可信侧的日志与审计条目**必须带层标签**（`ResourceAuditEntry.layer`）。
- **组合链必须可打印**（§7.1-②），并且它与拒绝日志用**同一个层名**。

**关于深度**：**决定**——组合链是 inventory 的一等数据，必须能被打印和 review。
**建议**——在 `register()` 时校验一个深度上限（起始值 **3**）。理由不是性能而是可解释性：一条用户
看不见、拒绝码相同、只有日志里才有层名的链，超过三层之后没有人能在事故中读懂它。这个数字可以被
第一个真实反例推翻；**不可推翻的是它存在并被检查**。

### 7.3 组合子的版本演进：inner 变了怎么办

| inner 的变化 | 组合 contract 的处置 | 为什么 |
|---|---|---|
| **实现**变（provider 内部改，contract 不变） | **不动** | 这正是组合子存在的理由之一 |
| **契约扩张**（inner 加一个 action） | **不自动继承** | 见下 |
| **契约 major 升版**（`workspace-files/v2`） | 组合 contract 也换 id（`workspace-files-locked/v2`），**与旧的并存注册** | 旧 App release 继续绑旧 id——这正是"旧 release 可回滚"要求的形状 |

**"不自动继承"是一个必须堵的口子**：如果 `withLock` 的 `actions` 从 `inner.actions` 快照来，
inner 加第 4 个 action 时组合结果会**默默**多服务一个，而它的契约文本只被审过 3 个。所以
§5.1 的签名里 `actions` 是**显式必填**的，`register()` 校验它是 inner 的**子集**（超集 = 抛错：
组合子不能凭空发明能力）。代价是 inner 加一个 action 要改两处——**那正是我们要的**：
加一个 action 是一次接口轴上的变化，它应该出现在 diff 里。

**与权限契约的接缝（只标注，不展开）**：contract id 是接口轴的身份，所以
**换组合 contract id = App 的权限契约变了 = 用户重新同意**。这与"旧六项 / 新八项两份契约同时存在、
安装与激活都不授权"是同一条规则，不是新规则。

### 7.4 一个 contract id 只有一个 provider

`register()` 今天已经对重复 contract 抛错。组合之后这条更重要：两处代码各自
`withLock(files, …)` 并注册成同一个 id，"哪一把锁"就取决于注册顺序。抛错是对的。

### 7.5 linker 的接缝：`interface` 与 `id` 第一次分开（必须在 P1 解决）

今天 `linkResourceBindings` 要求 `manifest.ports` 里的字符串与 binding 的 `contract` **完全相等**。
组合子第一次让这两者分开：模块声明它能消费 `workspace-files/v1` 这个**接口形状**，而 App 的 binding
提供 `workspace-files-locked/v1` 这个**授权身份**——按今天的检查，这会被拒绝。

**处置方向**（形状由 P1 的 port kit 定稿，这里只钉住原则）：contract 的自述里同时有 `id`
与 `interface`；linker 比对 **interface**，binding plan 与授权层用 **id**。

这不是放宽检查，而是把两个不同的问题分开：

- linker 问的是"**这个模块能不能消费这个形状**"——模块确实不在乎有没有锁；
- 授权层问的是"**这个 App 被授权了哪个 id**"——那由 binding plan 决定，而 binding plan 被
  package digest 覆盖，并且是权限契约推导的输入。

**同时要处理的**：release adapter 的形状闭集（`modular-v2` 的 contract 集合必须**恰好**等于其权限
契约蕴含的那一组，§21.2）——引入一个组合 contract 就是一次形状/契约的显式扩张，走的是与
`modular-v2` 完全相同的那条路，**不允许**用"同 interface 所以算同一个"糊过去。

---

## 8. 与 port kit（决定 5）的关系

**组合子实现的是 port 形状的接口，不是一个新抽象。** 输入输出都是 `ResourceProviderDefinition`，
所以 kit 统一的那几样——`Reply<T>` 形状、拒绝码闭集约定、`contract` 自述字段、remote adapter 构造器、
流动词标准接入——**对组合子原样适用，一条都不用特化**。

**conformance 骨架同样适用于组合子**，而且是强制的：

- 一个**装饰器**的组合结果必须跑它 interface 的**整套** conformance
  （`workspace-files-locked/v1` 跑 `workspace-files/v1` 那一套）。理由直白：
  "包装之后还是同一个契约"是它唯一的卖点，不跑就是没有验证过这个卖点。
- 这正是 §7.4 已经要求的"provider conformance suite：同一 contract 的不同实现跑同一组测试"——
  **组合结果就是'另一个实现'**，不是一个新品类。

kit 需要为组合子**额外**提供三样（都是断言，不是框架）：

1. **组合子专用的附加断言**，钉住三条最容易被包装破坏的性质：
   - **inner 的调用次数**：拒绝路径上 inner 必须被调用 **0** 次；一次成功路径上 **恰好 1** 次
     （组合子不许悄悄重试——重试一次被批准的写就是第二次副作用）；
   - **`close` 的同步语义被保持**：目录依赖"`close()` 返回时新工作已经不可能开始"。一个把它变成
     异步的组合子会**悄悄**破坏撤销，而且不会有任何测试自然地失败；
   - **拒绝码不被重写**：inner 的 `approval_required` 到达 View 时仍然是 `approval_required`
     （它是一条指令，不是一次失败）。
2. **`contract` 自述字段里的 `interface`**（§7.5 的 linker 接缝）。
3. 已有的内存 harness 直接可用（`resource-stream-contract/src/testing.ts` 的
   `memoryResourceStreamSource`、各 port 的 memory 实现）——**组合子的测试不需要 Runner、不需要
   浏览器、不需要真授权**，这也是它能被廉价地反复验证的原因。

**kit 明确不提供**：组合子基类、组合子框架、组合子生命周期钩子。`withLock` 是一个函数，不是一个要
继承的东西——一个"组合子框架"会立刻需要一个注册表，而注册表正是 §6 否掉的那件事。

---

## 9. 代价与边界（写下来，不粉饰）

- **组合对模块与 View 不可见。** 事故时"为什么这个读被串行化了"只能靠 inventory + 带层名的日志回答；
  用户和模块作者都看不到链。这是接口不可见性的直接代价，缓解手段只有 §7.2 那两条。
- **contract id 会随组合增长。** `workspace-files/v1` / `-locked/v1` / 未来 `-audited/v1`。
  组合爆炸（lock × audit × ratelimit = 8 个 id）是**真实风险**。缓解**不是**参数化 DSL（已推迟），
  而是"部署只注册它真的要用的那几个"——注册表是部署者一行一行写的，不是笛卡尔积。
- **给现有 App 加一层锁不是一次无声的运维动作。** 换 contract id = 换权限契约 = 用户重新同意
  （§7.3）。这条会让"临时加个审计层看看"这种想法在第一次尝试时就撞墙，**这是对的**——
  一次能悄悄改变授权身份的运维动作，正是两根轴分开要防的东西。
- **组合子共享 inner 的失败域**：同进程、同堆、同 `close` 时序。它**不是隔离机制**，与
  §21.5"共享 Provider 是模块化机制，不是安全边界"是同一条。
- **今天没有消费者。** 本 ADR 不产生代码。第一个真实组合子应当由 P6 的写路径（文件写入 → CRDT）
  驱动，而不是先造一个库等需求——决定 5 对 port kit 定的也是同一条纪律（第一个消费者 = 下一个真实
  port，用真需求驱动形状）。

---

## 10. 落地判据（实现这一条时逐项对照）

1. `register()` 校验组合结果的 action 集是 inner 的**子集**（超集抛错）；
2. 组合链进**启动 inventory** 与 `/permissions` 的边界清单，与拒绝日志共用同一套层名；
3. 装饰器的组合结果跑它 interface 的**整套** conformance，外加 kit 的三条附加断言
   （inner 调用次数 / `close` 同步语义 / 拒绝码不被重写）；
4. 组合 contract 有一份被评审过的**契约文本**，其机器可读部分是 kit 的 `contract` 自述字段；
5. `interface` 与 `id` 在 port kit 里分开，linker 比对 interface、授权层比对 id（§7.5）；
6. 换组合 contract id 走**与 `modular-v2` 相同的那条路**：新的形状闭集、新的权限契约、用户重新同意；
7. 组合子**不新增权限词、不派生第二条 capability 链、不读提议里的任何身份字段**。
