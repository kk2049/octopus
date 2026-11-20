# TCB 导读：可信闭包约 730 行，其中约 410 行必须完美

> 目的：让一个人在**一次坐下**的时间里，判断「A 账户能不能碰到 B 的资源」。
> 其余所有代码的作用只是**收窄**这个答案，不能放宽它。

> **路径写法**（2026-10-15 复核）：`core.ts`、`gate.ts`、`approval.ts` 等内核文件在
> `packages/capability-kernel/src/`（`tcb-budget.json` 在该包根目录）；`dashboard/`、`runner/`、
> `router/`、`workspace-files/`、`v3/`、`session/` 在 `packages/bot/src/`；`engine/...` 指
> `packages/engine/src/...`；`web-trust/src/` 指 `packages/web-trust/src/`。文中的
> `文件:行号` 是 2026-08 的快照，行号已漂移，以函数名为准；行数以 `tcb-budget.test.ts`
> 的实时统计为准。代码侧的同一份路径清单是 `packages/bot/src/devpipe/policy-paths.ts` 的 `TCB_PATHS`。

---

## 0. 要证明的那一句话

> **当前认证到的 Context，在自己的某个 slot 里持有指向固定 Object、包含该 operation 的有效 capability，并且通过了该 Object 的强制 policy。**

不可信侧能说的全部只有三个字符串：`request(slot, operation, args)`。没有 principal、没有 Context、没有 Object、没有 `approved`。

---

## 1. 可信闭包：五个文件

> 行数都是**代码行**（已剔注释与空行）。
>
> 「可信」的定义不能靠手画：它是从 `core.ts` / `gate.ts` 出发、沿**值导入**（`import type` 不算，编译后什么都不剩）算出的**传递闭包**——授权判定真正会执行到的全部代码。把逻辑挪进一个新文件躲不过去。这个数由 `src/tcb-budget.test.ts` 每次跑测试时算，涨过 50 行就把准入标准打到测试者面前。

| 文件 | 基线代码行 | 错了会怎样 |
|---|---:|---|
| **`core.ts`** | 230 | 权限图本身。**跨账户** |
| **`gate.ts`** | 161 | 唯一的门。**绕过 policy 直达资源** |
| **`canonical.ts`** | 18 | 批准冻结的参数 ≠ 执行的参数 |
| `objects.ts` | 152 | 混合：`register`/`dispatch` 是关键的（换掉 Object 就是给所有持有者换靶），参数 schema 与 `retrySafe` 默认解析错了只是畸形调用打到 adapter、或恢复时判错一次重试 |
| `types.ts` | 155 | 大半是编译后不存在的类型声明；但 `ApprovalEvidence` 的铸造令牌在里面，那是关键的 |

粗体三个 = **409 行「错了就是隔离失效」**。审查时间有限就只看它们，下面的顺序按重要性排。

### 按这个顺序读 core.ts

| 位置 | 函数 | 审查要点 |
|---|---|---|
| `core.ts:255` | **`authorize`** | **从这里开始。** 四问：Context 活着 → slot 在**本 Context 内** → 整条父链有效 → operation 在 rights 内。不看参数、不看 policy、不碰资源 |
| `core.ts:339` | `validateChain` | 向上走到根：任一祖先 capability 撤销 / 任一持有 Context 销毁 → 全部后代拒绝。**并在此重新断言 rights 与 terms 的衰减**——被手改的库行也不能变宽 |
| `core.ts:180` | `derive` | 唯一的授权分发口。Object 不变、rights 取子集、terms 取子集、目标必须是来源的**后代**（`derive` 到兄弟不可表达） |
| `core.ts:139` | `mintRoot` | 唯一的凭空创权口。只有可信控制面能调；slot 已占用即抛错 |
| `core.ts:118` | `isWithin` | 祖先判定**向上走**，O(深度)。全表扫描已删 |
| `core.ts:235` `:80` | `revoke` / `destroyContext` | 都是单向终态，销毁的 Context 永不复活 |

### gate.ts 只有一个函数，五步

`gate.ts:64` `invoke()` — 每一步只能收窄上一步：

```
:99  authorize        Object 来自 capability，永不来自调用方
:103 validateArgs     封闭 schema：未知键/错类型/缺必填 = 拒
:109 hashArgs         冻结「刚刚校验过的那一份」
:128 policy           deny 与 approval_required 在此返回 —— 不接触资源
:175 adapter          只有到这里，唯一持有固定 binding 的代码才被调用
```

**审查时盯这一件事**：第 128 步之后、第 175 步之前，没有任何分支能跳过 policy。

---

## 2. 第二层：错了也不会跨账户

这些**不在闭包里**——`gate.invoke` 不调用它们，是它们调用 gate。

| 文件 | 代码行 | 一个 bug 的代价 |
|---|---:|---|
| `approval.ts` | 327 | **同意与幂等**：可能执行两次、或没人点头就执行。**不可能跨账户**——`resume` 是把原调用整条重跑一遍 gate。中断恢复按 operation 的 `retrySafe` 分流（`exec` 判终态 `unknown`，读类退回待批准），**两条都不执行任何调用** |
| `objects.ts` | 152 | 畸形调用打到 adapter（adapter 自己也会拒） |
| `service.ts` | 231 | 接线 + Context 生命周期：权限存活过长/过短 |
| `store.ts` + `sqlite-store.ts` | 677 | 持久化损坏，不是授权判定 |

`approval.ts:292` `approve()` → `:334` `resume()` 是整个批准机制的安全论证：**批准不创造权限**，它只是让 policy 有机会放行一个 capability 链**仍然有效**的调用。

---

## 3. 各部件到 TCB 的路径

每条道都终止于 `gate.invoke → core.authorize`。差别只在**谁决定了 Context**。

### 面板（浏览器）

**这条链现在整条跑在一个 Fastify `onRequest` 钩子里**（`DashboardServer.gate`，2026-08-06
v4 Phase 2）。位置本身是安全内容：`onRequest` 在 **body 解析之前**，所以一个该拿 401/403/404
的调用方不会先被告知「你的 JSON 坏了」或「你少了一个字段」。钩子挂在一个 Fastify **scope**
上，注册在里面的路由**跳不过**它——「这条路由过没过门」从此是结构问题，不是把 if 链读到底
才能回答的问题。身份门**之前**回答的路径（`/login` `/logout` `/download/runner.js` `/api/devpipe/*`
`/ui/*` 等，完整清单见 `dashboard/authz.ts` 的 `PRE_ROUTES`）在另一个 scope，各自带
`PRE_ROUTES` 的 id 并只过 surface 门。

```
[Fastify onRequest hook, guarded scope]           dashboard/server.ts  gate
identify()                 dashboard/server.ts        ← bearer / 服务端会话 / 无 token 回环三条通道
mutationGate()             dashboard/server.ts        ← 非安全方法的唯一闸门（规则在 web-trust）
authorizeRoute()           dashboard/authz.ts         ← 路由表 + Cedar 策略（10 条 permit）；表外路径 = 404
  └─ mayRead / mayWriteAs                             ← 跨用户读 vs 跨用户写，两个谓词永不混用
                                                         （body 里带目标账号的路由由 handler 再问一次同一份策略）
[handler]                                             ← 只有钩子放行才拿得到 identity（WeakMap）
runnerGrantFor()           dashboard/server.ts        ← owner-only；pool 按 (user,surface) 复用 Context
  └─ RunnerCapabilities.open()   runner/capability.ts
       └─ authorityFor()          runner/account-authority.ts   ← 每次重查用户行 + 设备令牌，任一为空即撤销
       └─ svc.derive(...)                 → core.ts:180
  └─ grant.request() → svc.bind() → gate.invoke()    → gate.ts:64
```

判定用的是**请求路径**，不是路由上声明的 rule id：两者一致由 `dashboard/routes.test.ts`
逐条走真实路由表证明，而直接问表让两个方向都 fail closed——注册了却没有规则的路由在这里
404，写了规则却没人注册的路径在路由器那里 404。读声明的 id 会把前者变成一条**自己给自己
授权**的路由。

### Chat agent（MCP 子进程）

```
machinesPlugin()           router/router.ts:~470     ← 授予 MACHINE_OPS + MACHINE_AUTO_ALLOW
  └─ runnerLoopbackFor()   router/router.ts:~420     ← 铸一个 per-grant 回环令牌
       └─ CapabilityLoopback.mint()  runner/loopback.ts
子进程 → POST /rpc          runner/loopback.ts:149
  └─ FORBIDDEN_BODY_KEYS   :29   ← body 里带 user/appId/approved 等身份声明 = 400（不是交叉检查）
  └─ grant.capabilities.request(slot, operation, args)  → gate.ts:64
```

### v3 应用（生成代码，跑在沙箱子进程里）

```
POST /api/act              engine/host/server.ts  ← Context 来自 instance handle，不读 body 的 app/scope
  └─ dispatch()            engine/dispatch.ts          ← 谓词词表 any/owner/admin
       └─ controllerRun()  engine/host/server.ts:336
            └─ HostCapabilities.openControllerRun()  engine/host/capability-plane.ts
                 └─ narrow()  :241   ← account ∩ app ∩ action，只能收窄
       └─ runHandler()     engine/host/server.ts  → engine/runtime/sandbox.ts（一次调用一个新 Compartment + 可撤销 facade）
            └─ broker(slot, op, args)  → gate.ts:64
```
应用免批范围由 `appAutoAllow`（`capability-plane.ts:122`）决定，来源是 config 的 `auto_allow`（`v3/compose.ts:209`）——**不写 = 一个都不放行**。

### 批准（人在回路）

```
GET  /pending                                  dashboard/navigation.ts  ← 兼容入口，跳到服务端撰写摘要的批准页
POST /api/capabilities/pending/:id/(approve|reject)  dashboard/routes/mcp.ts
  └─ requireApprover()  dashboard/server.ts   ← 必须是真实浏览器会话；Bearer 一律不能批准
  └─ ApprovalDesk.approve()  approval.ts:292
       └─ store.claimPending()   ← 唯一的 exactly-once 原语（一条条件 UPDATE）
       └─ resume()  approval.ts:334  → gate.invoke() 重跑完整检查
```

### 资源侧（唯一持有 binding 的地方）

```
runnerAdapter()      runner/capability.ts:321
  └─ transport.dispatch(owner, ...)   ← owner 来自 Object 的固定 binding
       └─ gateway.dispatchForOwner()  runner/gateway.ts:272
            ← device 必须指名（未指名即拒），不在线即拒
claimTransport()     runner/gateway.ts:126   ← 全进程只能被领取一次
```

同一条 transport 上还有**第二个** Object（2026-08-06，v4 resource binding）。它是**另一个** Object，
不是同一个 Object 的两个新方法——每装一个后端模块就把账户 Object 升一版，会作废全体账户的 capability
与未决批准卡：

```
workspaceFilesAdapter()   workspace-files/capability.ts   ← 只调共享的 dispatchToRunner()
  └─ dispatchToRunner()   runner/dispatch.ts              ← 一份实现，两个 Object 共用
WORKSPACE_FILES_OPERATIONS  workspace-files/capability.ts ← 三个 observe/read，没有 path/directory
workspaceFilesPolicy()      workspace-files/capability.ts ← 同样三行，批准人固定为 Object owner
```

### 权限来源与撤销

```
mintDeviceToken()    runner/capability.ts  ← 顺序即安全：先删旧行 → 再撤授权+踢连接+通知其它平面 → 才写新凭据
onTargetSetChanged() runner/capability.ts  ← 依赖同一个设备集合的平面在这里登记；全部尝试，**同步**抛异常者阻止签发
                                             （异步释放失败只记录：安全性质在同步那一步已经成立）
revokeAccount()      runner/capability.ts  ← 从持久化根表撤，重启后仍正确
RUNNER_OPERATIONS    runner/capability.ts  ← 封闭词表 + effect 声明
runnerPolicy()       runner/capability.ts  ← 三行：凭据匹配 / terms 放行 / 否则要批准
```

---

## 4. 浏览器信任层（两个 surface 共用一份）

`packages/web-trust/src/` — 每条规则**只有一份实现**（主要文件如下）：

| 文件 | 内容 |
|---|---|
| `origin.ts` | `allowedOrigins()`（启动时算一次：配置的 `public_url`，否则实际绑定端口的回环源，都没有=空列表）+ `originOk(origin, allowed)` 只做集合判定——**请求侧没有参数可以塞 `Host`/`x-forwarded-proto`**；`cookieSecure`、`secretEquals`、`readCookie` |
| `sessions.ts` | 会话签发/解析/撤销；idle + 绝对过期 + 时间戳不可读 = 过期 |
| `gate.ts` | `mutationGate`——**只有两条通道**：`cookie`(环境自带)要 Origin + 有秘密时的 CSRF，`bearer`(显式头)放行；原 `readJsonBody` 已删除——两个 surface 都跑在 Fastify 上，超限 body 在 handler 之前被 `bodyLimit` 拒绝，这里只剩 `parseJsonBodyText`（空=`{}`、坏 JSON/非对象=拒绝）的语义解析 |

存储各自决定：面板落 SQLite（重启不踢人），v3 Host 用内存（重启即全清）。

---

## 5. 反例在哪

审查一条不变量时，先看它有没有被钉住：

| 测试 | 钉住什么 |
|---|---|
| `capability-kernel/src/core.test.ts` | authorize 四问、O(深度) 祖先、**terms 衰减 + 被手改的库行**、Context 回收 |
| `capability-kernel/src/gate.test.ts` | 负向矩阵逐条，每条都断言**假 adapter 有没有被调用** |
| `capability-kernel/src/invariants.test.ts` | 注册表不可变、深冻结、伪造 ApprovalEvidence（facade 无参数 + gate 品牌校验两面） |
| `capability-kernel/src/store.test.ts` | 单写者租约与驱逐、时钟回退、身份行不可覆盖 |
| `bot/src/runner/capability.integration.test.ts` | **真 WebSocket 的 frame 级断言**：「拒绝」= 对方笔记本一个字节都没收到 |
| `web-trust/src/gate.test.ts` | 四种凭据通道 × 安全/非安全方法、代理头骗术、四条会话过期轴 |
| `capability-kernel/src/tcb-budget.test.ts` | **闭包的规模与成员**。永不失败：它只在该被读一遍的时刻把准入标准放到眼前。预算与已记录的理由在 `tcb-budget.json` |

---

## 6. 不在 TCB 里（诚实边界）

capability 系统覆盖的是 **Runner 这一类资源**。以下各有自己的老边界，**不能因为 Runner 接完就说「统一权限系统已保护」**：

- bot 主机上的本地 `scan_home` 扫描、记忆目录（`session/path-jail.ts` 的 realpath jail）
- Git / deploy / 飞书 / devpipe（dev agent 以 bot 进程账号跑，权限等同人类开发者）
- v3 沙箱：网络隔离已由 SES 的 endowment 表接手（`engine/runtime/sandbox-child.mjs`，`fetch`/`node:net` 不存在而不是被拒绝），但**算力**没有边界——应用留下的微任务循环靠超时杀进程与 `maxCalls` 回收兜；**Compartment 逃逸 = 那个子进程完全失守**
