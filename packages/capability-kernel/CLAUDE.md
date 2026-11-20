# @claude-bot/capability-kernel — 权限内核

场景无关、policy 无关的最小权限内核。本文件即规范；各入口如何接到内核见 `doc/tcb-reading-guide.md`。

**本包不依赖 bot / runner / HTTP / MCP / engine**，只依赖 node 内置模块与 better-sqlite3。反过来也成立：不可信的 App/Controller/Agent 从不 import 它，它们只在通道另一头拿到一个 `BoundCapabilities`。

## 一句话模型

```
request(slot, operation, args)          # 不可信侧能说的全部
  -> gate.invoke(boundContext, slot, operation, args)
```

`boundContext` 不是请求字段，是可信通道预先绑定的后端对象。系统只证明：**当前认证到的 Context，在自己的某个 slot 里持有指向固定 Object、包含该 operation 的有效 capability，并且通过了该 Object 的强制 policy。**

## 分层：按「错了会怎样」排序

审计时按这个顺序读。

| 文件 | 代码行 | 职责 | **一个 bug 的代价** |
|---|---:|---|---|
> 行数以 `tcb-budget.json` 的口径为准（剔注释与空行），闭包内五个文件由测试每次重算。

| 文件 | 代码行 | 职责 | **一个 bug 的代价** |
|---|---:|---|---|
| `core.ts` | 230 | Context 树、slot 表、capability 链、`authorize` | **隔离失效**——A 账户碰到 B 的资源。这是唯一必须完美的文件 |
| `gate.ts` | 161 | 唯一的门：authorize → validateArgs → hashArgs → policy → adapter | 同上（deny/待批准绝不接触 adapter 就在这里保证） |
| `canonical.ts` | 18 | 参数规范化与哈希（键排序；`__proto__` **拒绝**而不是静默丢弃） | 批准绑定的参数与执行的参数不一致 |
| `objects.ts` | 152 | Object 注册表、参数 schema（含 `retrySafe` 默认解析）、字节上限、adapter 分发 | 畸形调用打到 adapter（adapter 自己也会拒） |
| `approval.ts` | 327 | PendingCall 状态机、原子 claim、`resume`、中断恢复 | **同意与幂等**——可能执行两次、或没人点头就执行。**但不可能跨账户**：resume 是把原调用整条重跑一遍 gate |
| `service.ts` | 231 | 接线 + Context 生命周期（deferred destroy、回收） | 权限泄漏时间过长/过短 |
| `store.ts` + `sqlite-store.ts` | 677 | **唯一表示**（WAL、synchronous=FULL、0600、单写者租约） | 持久化损坏；不是授权判定 |

上一版把这些全塞在一个 `kernel.ts` + `service.ts` 里，于是「必须完美」的面是 ~1000 行。现在是 **409 行**（core+gate+canonical），其余可以错得更便宜。

## 不变量（改这里之前先读）

1. Context 来自通道绑定，不来自 payload；接口里根本没有身份字段。
2. `(Context, slot)` 才定位 capability——slot 本身不是 bearer 权限。
3. Object 由 capability 固定，args/header/调用方 ID 都换不掉它。
4. `derive` 只能保持 Object、rights 取子集、**terms 取子集**。
5. 任一祖先 capability 撤销或祖先 Context 销毁 → 全部后代拒绝（每次 authorize 走完整父链，并**重新断言** rights 与 terms 的衰减，所以被改坏的行也不能变宽）。
6. deny 与 approval_required **不接触真实资源**；adapter 是资源的唯一持有者。
7. 批准不创造权限：`resume` 用保存下来的 Context/slot/operation/args 重跑完整 gate。
8. 未知 Context/slot/Object/operation/参数/状态一律 fail closed；policy 抛错 = deny。
9. Object 一个 id 只注册一次；定义被深冻结（注册方留着的字面量不再是权限）。重启后身份不符 = 拒绝注册；没被重新注册 = 该 Object 的 capability 一律 deny。
10. slot 不会被静默覆盖（mintRoot/derive 遇到已占用即抛错）；derive 目标必须是来源 Context 的后代。
11. 所有字节上限按 **UTF-8 字节**；adapter 的返回也有上限。
12. `unknown` 只能由 adapter 抛 `IndeterminateOutcome` 声明，不从错误文本猜。
13. **只有一份表示**：Context/capability/slot/pending/claim/result/audit 全在 SQLite，没有内存缓存。重启即恢复；重启时仍是 `claimed` 的记录**按 operation 声明的 `retrySafe` 分流**——不可重跑的判终态 `unknown`（`exec`/写文件），可重跑的**退回 `pending`**（原到期时间不变）交还给人。**恢复过程本身从不执行任何调用。**
14. 祖先关系一律**向上走**（`isWithin`），O(深度)。没有任何一处枚举全部 Context。

## Effect / GrantTerms / retrySafe（三个互不替代的问题）

- **`OperationSpec.effect`**：`observe | read | modify | execute`，在注册表里**声明一次**。内核不从它推导任何权限，它只做两件事：给 root 的默认 terms 定调、进 `PolicyInput` 供 policy 使用。
- **`GrantTerms.autoAllow`**：这条 capability **无需逐次批准**就能行使的 operation 集合。它挂在 capability 上而不是 operation 上，所以会随 `derive` 衰减——后代永远不能给自己放宽。
- `mintRoot` 的默认 terms = 请求 rights 中 effect 为 `observe`/`read` 的那些。**root 从不默认放行 `modify`/`execute`**，所以注册表里新加一个危险 operation，从存在的那一刻起就是要批准的，而不是从有人想起来分类的那一刻起。
- 于是「read_file 要不要批准」是**发放方**的一行：`open({ rights, autoAllow })`。policy 里没有对应的分支。
- **`OperationSpec.retrySafe`**：跑第二遍与跑一遍是否等价。默认由 effect 推出（`observe`/`read` 是，`modify`/`execute` 不是），显式写只为**推翻**这个默认。它只被**中断恢复**读，创建 PendingCall 时抄进行里（重启时还没有 Object 注册，查不到注册表；抄下来的也正是人当时被问的那一版）。

> `read_file` 证明这三者互相独立：effect 是 `read`，chat agent 的授权**不** auto-allow 它（被 prompt injection 的模型能点名 `~/.ssh/id_ed25519`），而读两遍与读一遍等价。用其中任何一个去猜另一个都会错。

## 两个容易踩的点

- **`destroyContext(ctx, {deferWhilePending})`**：短命持有者（一次 HTTP 请求、一次 dispatch）释放时若留了未决批准，销毁要推迟到该批准落定——因为批准是在**原 Context** 里重跑原调用。硬 destroy（run 结束/撤销）不带这个选项，立即生效。
- **outcome 不只有成功/失败**：mutating 调用结果不可判定时记 `unknown`（adapter 抛 `IndeterminateOutcome`），调用方不得自动重试；重复 approve 同一个 id 返回**记录下来的结果**，不会再执行一次。结果视图里的 `retrySafe` 是**给调用方的分流依据**——`unknown` 对 `exec` 是「别再发」，对 `read_file` 是「重发即可，会再排一张卡」。
- **pending id 不是取结果的凭据**：`resultOf(contextId, pendingId)` 要求 contextId 就是发起方（或其祖先），换个 Context 拿同一个 id 什么也读不到。
- **Context 会被回收**：销毁满 `contextRetentionMs`（默认 1h）、没有任何 pending 行提到它、且没有活的子 Context 时，它的行会被删。别把 ContextId 当长期外部标识符。
- **审计有保留期**：无人值守、已允许且成功的 `observe`/`read` 调用不写 `cap_audit`（`audit` 回调照常收到）；拒绝、待批准、批准台事件、失败与 `modify`/`execute` 都写。`pruneAudit(before)` 每次只删一页旧行，由控制面分批定时调用（生产为 30 天）。

## TCB 预算（`tcb-budget.json` + `src/tcb-budget.test.ts`）

每次跑测试都会算一遍**可信闭包**：从 `core.ts`/`gate.ts` 出发、沿**值导入**的传递闭包（`import type` 不算）。这是「可信」的操作化定义——把逻辑挪进新文件躲不过去，闭包会跟过去。

- 涨过 `tolerance`（50 行）→ 把**准入标准**打到测试者面前（见测试文件里的 `ADMISSION`：一个问题 + 四条搬法）
- 有文件新进闭包且未登记 → 最响的一条警告，那正是该读一遍准入标准的时刻
- 缩小超 20 行 → 提醒把 baseline 落下来（棘轮只往紧的方向转）
- **永不失败、永不阻塞**：阻塞会让人去改 baseline 而不是去读代码

搬不动的，在 `justifications` 里一行一条写清「为什么这行必须可信」并调 baseline——那是一次刻意的人类动作。改 `core.ts`/`gate.ts` 时，review 里要说明它属于上面哪条不变量；改不了任何一条的代码，大概就不该在这两个文件里。

## 测试

```bash
npx vitest run packages/capability-kernel
npx tsc --noEmit -p packages/capability-kernel/tsconfig.json
```

| 文件 | 测什么 |
|---|---|
| `core.test.ts` | 图本身：authorize 的四问、O(深度) 祖先、**terms 衰减与被改坏的行**、Context 回收（含"有未决批准就不回收"） |
| `gate.test.ts` | 负向矩阵逐条（`doc/tcb-reading-guide.md` §5）；每条都断言**假 adapter 有没有被调用** |
| `invariants.test.ts` | 注册表不可变、深冻结、伪造 ApprovalEvidence（facade 无参数 + gate 品牌校验两面） |
| `approval` 相关 | 在 `gate.test.ts` 尾部与 `persistence.test.ts`：exactly-once、重放读记录、过期、按 Context 的配额、**中断恢复按 `retrySafe` 分流**（同为 `read` effect、声明相反 → 结局相反；恢复不执行；退回的卡不延期） |
| `store.test.ts` | 单写者租约与驱逐、时钟回退、身份行不可覆盖、去重索引迁移 |

真实入口的 frame 级断言在 `packages/bot/src/runner/capability.integration.test.ts`。
