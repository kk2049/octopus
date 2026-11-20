---
decision_status: accepted
realization_status: planned
supersedes: []
superseded_by: []
tickets: []
---
# ADR 0006 — View 唤醒通道：可信页代订阅，同一条 MessagePort 上转发一条**无内容**的帧

- 状态：**已接受（架构决策）**，尚未实施（2026-08-08）。**本 ADR 不产生代码。**
- 触发它的撞墙记录：`doc/development/crdt-p6c-worklog.md` **墙 2**（「没有推送形态——协作目前是一个同步按钮」）
  与 **墙 4**（presence 往哪放）。那里写了「它值得单独一份 ADR」，这就是那一份。
- 前置：[ADR 0001](./0001-session-plus-trust-boundaries.md)（两个浏览器信任域与 MessagePort）、
  [ADR 0003](./0003-dashboard-react-frontend.md) §「能力型 GET 不许自动重放」、
  [ADR 0005](./0005-backend-composition-combinators.md)（后端组合只在可信组合根里）
- 现状实现（本 ADR 描述它的演进，不是它今天的形状）：
  `packages/web-trust/src/frame-protocol.ts`、
  `packages/dashboard-web/src/session-plus/frame-host.ts`、
  `packages/dashboard-web/src/pages/SessionPlusPage.tsx`、
  `packages/bot/src/dashboard/server.ts::apiSessionPlusStream`、
  `packages/bot/src/session-plus/{instance,app-service}.ts`、
  `packages/agent-view-react/src/client.ts`

---

## 1. 背景：为什么「有人改了」在 View 那一侧**说不出来**

不可信 Agent View 跑在一个 opaque origin 的 iframe 里，`connect-src 'none'`，
唯一的通道是一条 MessagePort，**唯一的动词是 `propose`**。所以：

- 它发不出 `fetch` / `XHR` / `WebSocket` / `EventSource`；
- 它**只能问**，问完**只会收到自己那次提议的回执**；
- 于是「服务端主动告诉你有人改了」这句话，在这一侧**没有拼写**。不是没实现，是说不出来。

P6c 的 CRDT 纵切因此只能做成一个**显式「同步」按钮**，页脚直说「本视图不会自动接收别人的改动」。
一个协作文档编辑器如果永远只有一个同步按钮，它不是协作编辑器。

**同一堵墙挡住的不止 CRDT**：会话 transcript 的实时跟随、后端 agent 轮次的进度、
别的标签页刚刚改完的文件、以及（见 §7）presence。今天这些在 Session Plus 的 View 里
要么不存在，要么由**可信侧把内容推给 View**（`view` / `op` 两种帧，见下节）——
而后者对**用户资源**不成立，那正是这份 ADR 要解决的那件事。

---

## 2. 这个平台已经有一半了（这是本 ADR 最重要的事实）

「可信页订阅服务端 → 经同一条 MessagePort 转发给 View」**不是一个新架构**，
它今天就在生产里跑着，服务的是 App 自己的投影与 operation 生命周期：

| 环节 | 今天的实现 |
|---|---|
| 服务端订阅 | `apiSessionPlusStream`：一条 SSE，按 **instance handle + principal** 作用域（`app.subscribe(handle, principal, …)`），不是按用户名 |
| 事件词表 | `InstanceEvent = {type:"view"} \| {type:"op"} \| {type:"closed"}`（`session-plus/instance.ts`） |
| 可信页消费 | `SessionPlusPage.tsx`：`fetch` + reader（不是 `EventSource`，因为 instance handle 必须走 header），按 `event:` 分派 |
| 转发到 View | `hostRef.current?.update(projection)` / `hostRef.current?.operation(op)` → `port.postMessage({t: MSG.view…})` / `({t: MSG.op…})` |
| View 消费 | `client.ts::onPortMessage` 里两个 `if` |

**所以本 ADR 要加的不是一套机制，而是这套机制里的第三种事件**——并且是**唯一一种不带内容的**。

为什么前两种可以带内容而第三种不行，是整份文档的枢纽，写在 §3.2。

---

## 3. 决定

### 3.1 形态：三步，一条无内容的帧

> 1. **可信侧**为一个**已打开的实例**订阅服务端变化，只广播
>    **「binding B 的 ref R 变了」**——**不带任何内容**；
> 2. **可信页（frame host）**收到后，往**已有的那条 MessagePort** 发一条
>    **新的 host→view 帧** `wake`；
> 3. **View** 收到后**自己发起一次 `propose(read…)`**——于是那次读**仍然完整地过 capability Gate**、
>    仍然可能变成一张批准卡、仍然由 App 的 binding plan 解析、仍然记在 App 头上。

三条性质因此成立，并且每一条都要在实现里有对应的测试（§9）：

- **推送不携带数据** → 它不是一条绕过 Gate 的旁路；
- **推送不是授权** → 它只说「值得再问一次」，不说「你可以读」；
- **View 仍然说不出它在读谁的东西** → wake 里的 ref 是**这个 scope 自己已经持有的那一个**，
  不是一个新披露的标识符（§3.3）。

### 3.2 为什么 `view`/`op` 可以带内容，而 `wake` 不可以

这不是保守，是两类数据的**授权来源不同**：

| | `view`（投影） / `op`（operation 生命周期） | 用户资源（CRDT 文档、工作区文件、transcript） |
|---|---|---|
| 谁产生它 | App 自己的 Runtime/State 子进程 + 平台的 operation 协调器 | 用户的设备 / 用户的文档 |
| 谁决定它可以被看见 | **可信侧的 declassify**：投影函数跑完，可信侧已经决定这份数据可以进这个 iframe | **capability Gate**，按 App 的 binding plan 与 owner 的 grant |
| 可信页转发它意味着什么 | 转发一份**已经解密过的**数据 | 代替 App 发起一次**资源读** |

第二列的那次转发就是**授权洗白**（authority laundering）：可信页握着浏览器凭据，
它去读一次文档是**以人的身份**读的；把结果 postMessage 给 View，就等于让「谁的授权、记在谁头上」
有了两个答案。P6c worklog 已经点名否掉了这个「次优形态」，本 ADR 把它抬成硬规则：

> **可信页永远不代替 App 发起资源读。** 它可以说「有变化」，不可以说「变化是什么」。

### 3.3 wake 里带不带 ref：带，并且写下代价

两种形状：

- **(a) 带 ref**：`{t:"wake", binding, ref}`。View 只重读那一份。
- **(b) 不带**：`{t:"wake", binding}`。View 必须重读这个 binding 下的**每一份**。

**采纳 (a)**，理由是 (b) 把一次唤醒放大成 N 次能力型读——而每一次都可能是一张批准卡，
那正好把本 ADR 想避免的问题做大 N 倍。

**ref 不构成新的披露**：ref 是 provider 在 **scope 打开时**铸给这个 scope 的，
View 手里本来就有；可信侧**只对它自己铸给这个 scope 的 ref 发 wake**，
所以一条 wake 永远命名不出一个这个 scope 寻址不到的东西。
（`crdt-doc` 的 `onScopeOpened` 接缝正是为这件事留的；`notify/v1` 有同样的缺口，见 worklog 墙 6。）

**残留代价，写清楚**：一条 wake 告诉 View **「别人在这一刻动了这份文档」**。
这是一个**低带宽的时序侧信道**，泄漏的是另一个人的活动节奏，上界由去抖窗口决定（§5）。
它已经**很接近 presence**，而这正是 §7 里 presence 必须单独决定、不能顺手长在这条通道上的原因。

---

## 4. 协议轴：这是 `session-plus/2` 的词表扩张，**不 bump 版本**

**结论：新增一个可选的 host→view 帧类型不构成不兼容变更，`SESSION_PLUS_PROTOCOL` 不动。**

论证分四步，每一步都对着代码：

**① 版本标记只在握手那一刻被比较。**
`SESSION_PLUS_PROTOCOL` 出现在两处：Host 在 `port` 与 `boot` 帧上写它，
View 在 `client.ts` 的 `onWindowMessage` 里比 `data.t !== MSG.port || data.protocol !== SESSION_PLUS_PROTOCOL`。
握手之后的帧**不带**版本标记。所以 bump 它的实际语义是
**一个握手期的总开关**：改一个字符，所有已发布 release 的 View bundle 会**拒绝接受端口**，
每一个开着的标签页当场变成空白，直到有人重新 pack + 激活一版新的 release。
这个代价只应该在真的不兼容时付。

**② 「不兼容」的判据：按旧规则行事的那一侧会不会得出错误结果。**
- 旧 View + 新 Host 发来的 wake：`onPortMessage` 依次比完 `boot`/`view`/`op`/`result` 四个 `if`，
  全不匹配，**直接返回**。没有状态变化、没有异常、没有崩溃。
  这个 App 的行为与「wake 不存在」时**逐字相同**——也就是一个带同步按钮的编辑器。
- 新 View + 旧 Host：它永远收不到 wake。只要 View **不把「收到过 wake」当成功能的前提**，
  它的行为同样与今天相同。这是一条**对 View 作者的硬要求**，写在 §6.2：
  **手动同步入口永远保留**，不得因为「有推送了」而删掉。

由此得到可以复用的判据：

> **一个新增的可选帧是兼容的，当且仅当「永远收不到它」是对方**已经**正确处理的一个状态。**

wake 满足它，因为「永远收不到 wake」就是今天已发布的那个形态。

**③ 本仓库有先例，而且是同一个方向的帧。**
`MSG.op`（host→view，operation 生命周期）是在 commit `d14ed47`「Complete Session Plus operation flow」
里**加进 `protocol.ts` 的一行**，`SESSION_PLUS_PROTOCOL` 保持 `session-plus/2` 没动。
本 ADR 提的是同一种改动。

**④ 什么时候就必须 bump 了**（写下来，免得这条先例被拿去覆盖真正的不兼容）：
- wake **带内容**，而 View 必须解读它 → 旧 View 会漏掉数据；
- wake 需要 View **回执**，Host 依赖那个回执 → 旧 View 沉默会被误读成故障；
- **「没有 wake」开始有含义**（比如约定「没收到 wake 就代表没变化」）→ 旧 Host 的沉默变成一句谎话；
- 改变某个**既有**帧类型的含义或字段语义；
- View→Host 方向新增动词（那一侧有 `admitMessage` 熔断与 `normalizeParams` 抄写，
  加一个动词等于改可信侧的解析面）。

**⑤ 一个必须同时改的东西：`frame-protocol.ts` 顶部那张 asymmetry 清单。**
它列着 `host → view   port, boot, view, result`——**今天就已经漏了 `op`**。
注释不是执行点，但一份少报了词表的注释，正是下一个人据以断定「这里没有推送」的东西。
加 wake 的那次改动必须把这张表补齐（连同 `op`）。

---

## 5. 速率：合并在可信侧，冷却在 View 侧，两道预算都写下来

### 5.1 先看今天的数字

| 事实 | 数字 | 出处 |
|---|---|---|
| 每端口熔断窗口 | **10 000 ms / 100 条** | `frame-protocol.ts` `PORT_WINDOW_MS` / `PORT_WINDOW_MESSAGES` |
| 熔断的后果 | `port.close()` + `degraded` + 退休 provider streams，**不是拒绝这一条** | `frame-host.ts::admitMessage` |
| 熔断**只数** view→host | `admitMessage()` 只在 `onPortMessage` 里被调用 | 同上 |
| 单帧上限 | 512 KiB | `PORT_MESSAGE_BYTES` |
| 一次 durable append | ~10 ms（本机实测） | worklog 墙 3 |

**关键的不对称**：host→view 的 `update()` / `operation()` **完全不过熔断**。
所以「服务端话痨」本身不会烧掉 View 的预算——**但它诱发的读会**：
每条 wake 让 View 发一次 `propose`，而 `propose` 是被数的那一侧。
**10 条/秒的 wake 就足以在 10 秒内把通道熔断**，而熔断不是一次可恢复的拒绝，
是「视图挂了」。

### 5.2 因此两道机制都是必需的，且分工写死

- **合并（去抖）在可信侧，因为不可信侧的自律不是保证。**
  按 `(instance, binding, ref)` 去抖：窗口内 N 次变化 → **至多 1 条** wake。
  再叠一个每实例的硬上限（滚动窗口内最多 K 条 wake），超了就**丢**——
  丢是安全的：wake 无内容且**幂等**，下一条 wake 与被丢掉的那条含义完全相同。
  这与投影推送不同（投影带 revision，丢了要补），是 wake 无内容换来的直接好处。

- **冷却（cooldown）在 View 侧，因为只有它看得见拒绝。**
  见 §6.3。

- **两个常量与熔断常量放在一起**（`frame-protocol.ts`），因为它们必须一起被读：
  wake 的预算必须**显著小于** `PORT_WINDOW_MESSAGES`，而且要给**人自己的操作**留出余量——
  同一条通道上还跑着用户点的每一个按钮。建议起点：去抖 ≥ 600 ms（与 P6c 本地编辑去抖同量级）、
  每实例每 10 s ≤ 10 条 wake（熔断预算的 1/10）。**数字可调，"wake 预算 ≪ 熔断预算" 不可调。**

---

## 6. 唤醒**不是**重放——论证，以及使它成立的两条硬约束

ADR 0003 立了一条纪律：**能力型 GET 不许自动重放**。
`/api/session(s)`、`search`、`live` 会穿过 capability kernel，
免批被撤销时一次读会**生成一张待批准卡**，所以 retry / window-focus / reconnect / remount / prefetch
全部关掉，轮询只对 `REPLAY_SAFE`（纯服务端本地读）开放。

wake 触发的读**也**穿过 Gate。所以必须回答：这是不是在给同一条纪律开后门？

### 6.1 三条区别，逐条对着那条纪律的**理由**

那条纪律禁的不是「自动」，禁的是
**「机器按环境事件重复一次用户没有要求、也无法预期的读」**。逐条对：

| | 被禁的自动重放 | wake |
|---|---|---|
| **触发源** | alt-tab、wifi 抖动、组件重挂、导航、预取——**环境事件**，与用户在做什么无关 | **一次用户态订阅的延续**：这个人打开了这个实例、这个 App 打开了这份文档的 scope。alt-tab / 重挂 / 导航**不产生 wake** |
| **次数上界** | 与「有没有变化」无关。轮询在一份从没变过的文档上一天也能发几千次 | 上界 = **变化次数**，再被去抖压一层。**没有人改动 = 一次读都没有** |
| **被拒之后** | 下一次环境事件照样再来一遍 → 一次撤销变成一串批准卡 | **冷却**：拒绝一次就退回手动（§6.3） |

第二行是最硬的一条：轮询是**开环**的，wake 是**闭环**的——
它的信息源就是「确实发生了一件值得再问一次的事」。
把「值得再问」这件事从客户端的猜测变成服务端的事实，正是这条通道存在的意义。

### 6.2 硬约束一：手动同步入口永远保留

- 因为旧 Host / SSE 断开 / 熔断 / 部署切换都会让 wake 停掉，而**保留手动入口**是
  「永远收不到 wake 是一个已被正确处理的状态」（§4②）在 UI 上的那一半；
- 也因为它是**降级目标**：冷却之后，界面就是今天那个形态。

### 6.3 硬约束二：拒绝即冷却，冷却由 View 持有

一条 wake 触发的读若被拒绝为 `approval_required` / `no_authority`：

- View **必须**对这个 ref 进入手动模式，直到**人**做了一个动作（点「同步」、或去批准那张卡）；
- 后续 wake 只更新一个「有新改动」的标记，**不再自动发起读**。

**为什么这一条不能省**：写这份文档的人**不是**看这份文档的人。
一个话痨的（或恶意的）协作者，可以靠自己不停打字，在**我的** `/pending` 里生成一串批准卡。
没有冷却，这就是一条**跨用户的批准卡泛洪**。有了冷却，它最多产生一张——
之后界面老老实实说「有新改动，点击同步」。

**为什么冷却在 View 而不在 Host**：只有 View 看得见那次 `propose` 的回执码
（Host 只在 `lastAnswer` 里留一个诊断用的 code，而且 Host 不知道哪次 propose 是 wake 引发的）。
让 Host 去猜等于让它开始解读 App 的动作语义，那是它明确不做的事。

### 6.4 结论

wake 不进 `REPLAY_SAFE`，也不需要进——`REPLAY_SAFE` 管的是**可信面板自己**的 HTTP 轮询，
而 wake 是可信面板→不可信 View 的一条通知。两者唯一的共同点是**都不许把一次撤销变成一串批准卡**，
而 §6.3 是 wake 这一侧兑现它的机制。

---

## 7. 明确不做

1. **内容推送**（服务端把 update / 文件内容 / transcript 直接推给 View）。理由见 §3.2：授权洗白。
2. **presence（谁在看、光标在哪）**。它需要的是一条**独立的 ephemeral 通道**
   （可信侧内存中继、不落盘、不进 Gate、只在已授权实例之间广播），而不是 wake 的第四个字段。
   而且 §3.3 已经指出 wake 本身就带了一个时序侧信道——把 presence 长在它上面，
   等于在没有单独决定的情况下把那个侧信道扩容成一个特性。
   **在 presence 有自己的决定之前，不要往 wake 里加任何与「谁」有关的字段。**
3. **View→Host 的订阅管理动词**（View 说「我要订阅 X」）。能申请订阅的 View 就是能枚举的 View；
   订阅集合由**可信侧铸给这个 scope 的 ref**导出，不由 View 声明。
4. **View 侧的回执 / 双向流 / 通用「服务端事件」总线**。第三条会立刻把 payload 长回来（§4④）。
5. **第二条 MessagePort、`BroadcastChannel`、放宽 `connect-src`**。
   通道只有一条是 ADR 0001 的结构，不是实现细节。
6. **把 wake 做成「保证送达」**。它是提示不是账本：允许丢、允许合并、允许重复。
   任何依赖「每次变化恰好一条 wake」的设计都要改成「wake 之后去读」。

---

## 8. 备选方案与否决理由

| | 方案 | 结论 |
|---|---|---|
| a | **View 轮询**（`setInterval` + `propose(read)`） | **否决**。开环重复能力型读，正是 ADR 0003 那条纪律禁的形状；P6c 已经在 `architecture.test.ts` 里禁掉 `setInterval` |
| b | **可信页代拉 + postMessage 内容** | **否决**。授权洗白（§3.2）。P6c worklog 已否 |
| c | **给 View 一个受限 `EventSource`**（放宽 `connect-src`） | **否决**。`connect-src 'none'` 是承重边界：有网络的 View 是能把已披露数据发出去的 View。为了一个提示通道换掉整条边界，代价与收益不成比例 |
| d | **长轮询 `propose`**（View 发一个 `wait_for_change` 动作，可信侧挂起到有变化） | **否决**，但它是唯一一个**零协议变更**的方案，所以理由要写全：① 它把一次**读**塞进 Gate 的请求/响应模型当**订阅**用；② 挂起期间若这次调用需要批准，人在 `/pending` 看到的是一张「等待变化」的卡——一张永远说不清自己在做什么的卡；③ App Runtime 与 dispatcher 都没有「挂起这次调用」的概念，做出来是一条新的生命周期而不是省掉一个帧；④ 熔断数的是条数不是时长，所以它躲开的那个预算本来也不是瓶颈。**省下的一行 `MSG.wake` 不值这些。** |
| e | **bump 到 `session-plus/3`** | **否决**。§4：代价是所有开着的标签页与所有已安装 release 的兼容性，换来的安全性质是 0 |
| f | **wake 不带 ref** | **否决**。§3.3：把一次唤醒放大成 N 次能力型读 |

---

## 9. 落地清单（当它被实施时）

按依赖顺序；每一步括号里是它欠的那条测试。

1. **`packages/web-trust/src/frame-protocol.ts`**：`MSG.wake`；补齐顶部 asymmetry 清单（连同今天漏掉的 `op`）；
   `WAKE_DEBOUNCE_MS` / `WAKE_WINDOW_MESSAGES` 与熔断常量放在一起。
   （测试：常量关系 `WAKE_WINDOW_MESSAGES * k < PORT_WINDOW_MESSAGES`，用断言写死那个不等式。）
2. **变化的来源**：`CrdtDocumentStore` 加一个**可信侧到可信侧**的 `onChanged(docId)` 接缝，
   与既有的 `crdtDocProvider({ onScopeOpened })` 同类。（测试：一次 `applyUpdate` 恰好触发一次回调；
   compaction 不触发。）
3. **`session-plus/instance.ts`**：`InstanceEvent` 加 `{type:"wake"; binding; ref}`；
   协调器把「文档变了」映射到**持有该 ref 的实例**，按 `(instance, binding, ref)` 去抖。
   （测试：窗口内 N 次变化 → 1 条 wake；**不持有该 ref 的实例收不到**；发起变化的那个实例自己收不收——
   实现时挑一个并写下来，建议**不发给发起者**，它已经知道。）
4. **`apiSessionPlusStream`**：转发 `wake` SSE 事件。
   （测试：`event: wake` 的 data 里**没有**文档内容、没有 owner、没有 device、没有路径。）
5. **`SessionPlusPage.tsx`**：`event === "wake"` → `hostRef.current?.wake(value)`；
   **重连后无条件补发一条 wake**（幂等，见 §7.6），因为断线期间的变化没有别的补偿机制。
   （测试：断开 → 重连 → 恰好一条 wake。）
6. **`frame-host.ts`**：`wake(next)` → `port.postMessage({t: MSG.wake, …})`；
   host 侧硬上限，超了丢。（测试：熔断计数**不因** wake 增加；上限之上被丢弃。）
7. **`agent-view-react/src/client.ts`**：快照里加一个**单调递增的 wake token（按 ref）**，
   由 `useWake(ref)` 暴露。**client 自己绝不发起读**——读是模块的决定。
   （测试：旧帧类型的处理逐字不变；未知 `t` 仍然被忽略。）
8. **模块侧**（第一个消费者是 CRDT 编辑器）：wake → 一次 `read_updates`；
   拒绝为 `approval_required` / `no_authority` → 进入手动模式直到人操作。
   （测试：§6.3 那条——连续 10 条 wake，第一条被拒之后**总 dispatch 次数不再增加**。）
9. **可信 chrome 的 liveness 指示归可信侧**：只有可信页知道 SSE 活没活，
   所以「正在实时接收」这句话必须由**可信 chrome** 渲染，不能由 View 自称。
   （测试：SSE 断开时可信侧状态从 live 变为非 live；View 的界面不因此声称自己是实时的。）

**验收判据（一句话）**：没有人改动时 wake 数与读数都是 0；有人改动时读数被去抖窗口封顶；
一次 Gate 拒绝之后自动读数归零。

---

## 10. 这份 ADR 之外的三件相关事

- **`notify/v1` 的 ref bootstrap 缺口**（worklog 墙 6）与本 ADR 同源但不同题：
  那是「谁把 ref 交给 View」，这是「ref 对应的东西变了怎么通知」。前者先做，后者才有对象。
- **每 action 的 wire 界限**（P6b 的支线）不被本 ADR 依赖：wake 无内容，它不受 512 字符参数上限的影响。
  但 CRDT 编辑器要**用**这条通道，仍然需要 P6b——wake 让它知道「该读了」，
  能不能把读回来的东西送过去是另一堵墙。
- **本 ADR 不为 Session Plus 之一家而写**：`frame-protocol.ts` 是所有 Agentic App 共用的边界词表，
  wake 一旦存在就是**平台能力**。这也是它必须是一份 ADR 而不是某个模块实现细节的原因。
