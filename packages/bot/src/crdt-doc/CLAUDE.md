# CRDT Doc — 可信侧的协作文档副本、持久化、capability 平面与 wake 扇出

> 2026-08-07 新增（平台收敛计划 P6c，决定 8 的第三步：**架构压力测试**）。
> 2026-08-10 起是生产平面：capability Object、种子文档与 ADR 0006 的 wake 扇出都在这里。
> 计划：`doc/development/agentic-app-platform-convergence-plan.md` §决定 8、§决定 12
> 设计前提：`doc/development/agentic-app-module-system-design.md` §15.1、§15.4
> 交付记录：`doc/development/crdt-p6c-worklog.md`、`doc/deliveries/2026-08-10-crdt-doc-app.md`

## 一句话

每份文档一个 `Y.Doc` 活在可信进程里，真相是**「append-only update log + 定期 compaction」**；
`apply_update` 的顺序写死为 **校验 → append+fsync → 内存 apply → 作答**。
每次读与每份文档每次打开期间的首次编辑（edit lease）由 `crdt-doc-v1:<owner>`
capability Object 决定；成功的合并经 `onChanged` 变成无内容的 wake。

## Yjs 是第三方依赖，四问的答案

1. **仓库里有没有？** 没有。`packages/app-state` 是**事件日志**（JSON commit 链 + hash chain），
   不是 CRDT：它靠 `expectedRevision` 冲突检测串行化写者，而协作编辑要的正是**并发写不冲突**。
2. **生态里有没有被审过的？** 有，Yjs 就是这个领域的事实标准（ProseMirror/CodeMirror/Monaco 的
   协作绑定、Hocuspocus、Liveblocks、Evernote/JupyterLab 都在用），零依赖，格式稳定多年。
3. **自研能提供什么？** 没有。合并不满足交换律的 CRDT 会**几个月后**才表现为「两个副本内容不同」，
   而那时已经没有一份可信的历史可以对账。设计文档 §12 明令不自研。
4. **要关掉它的什么？** 什么都不用关——本层只用它的**数据结构**（`applyUpdate`/`encodeStateAsUpdate`/
   `encodeStateVector`/`decodeUpdate`/`mergeUpdates`）。`y-websocket` 那一族 **provider 包一个都不装**：
   它们自带连接，而这条链路上唯一的通道是 App 那一条 MessagePort。

## 顺序就是安全内容

```
decodeUpdate(bytes)   ← 坏 update 绝不进日志：日志每次打开都要重放，
                        一条毒记录会让文档永久打不开
size ceiling          ← 拒绝，不截断，也不静默丢
log.append + fsync    ← 说了「收到」就已经在盘上
Y.applyUpdate         ← 崩在这一行之前 = 下次打开重放；之后 = 已经记下了
answer                ← 回执是编辑器松手的信号，所以它必须最后发生
```

反过来写（先 apply、先作答、后台落盘）正是丢一整段文字的那种写法。

## 为什么 compaction 不需要两阶段协议

`packages/app-state` 的 commit 是**哈希链**，重放两次不等于重放一次，所以它必须在
rename 与 SQLite commit 之间做 fault-point 对账。CRDT 的 merge 是**幂等且可交换**的，
于是这里只有一条顺序：**先把新 base 落durable，再清空日志**。任何一个崩溃点重放出来的
文档都相同（`store.test.ts` 用「把 compaction 前的日志原样放回去」直接钉住）。
这是本纵切里 CRDT 让平台**变简单**的地方——其余地方都是反过来的。

## capability 平面（2026-08-10）

`capability.ts` 是**第一个不由 Runner 背书的 capability Object**：
`crdt-doc-v1:<owner>`，封闭表两个词元。`read_document`（read）逐次过 Gate，
可被 auto-allow；`edit_document`（modify）是**每 (实例, 文档) 一次的编辑租约**
——kernel 出一张批准卡，批准覆盖本次打开内对该文档的后续合并，实例结束或
撤销即失效。adapter 只做授权应答，**不搬内容**：字节仍走 store 的既有校验
顺序，租约内每次合并前 provider 复查 `alive()`（context 存活 + 权限仍在），
所以打开中途的撤销拦得住下一次合并。这个形态是 2026-08-09 交付里
「edit_document 的同意行两种拼法都被平台拒绝」的解：有了执行者，
`sessions-workspace-write-crdt/v1` 才可声明。

## wake 扇出（ADR 0006 的可信半边）

`wake.ts`：provider 的 `onScopeOpened/onScopeClosed` 报进出，store 的
`onChanged(docId, origin)` 报变化，hub 按 (scope, doc) 去抖、按实例窗口限额
（超了**丢**，wake 无内容所以丢是安全的）、**不叫醒发起改动的 scope**，
然后 `deliver(instanceKey, binding, ref)` → Session Plus 协调器发无内容的
`wake` 实例事件 → SSE → frame host → View。

## 文件

| 文件 | 职责 |
|---|---|
| `log.ts` | 帧格式（`u32 长度 · u32 crc32 · payload`）、torn tail 截断恢复、base + log 两文件、compaction。document id 是**文法**不是路径 |
| `store.ts` | 每 doc 一个 `Y.Doc`；`read`/`applyUpdate`/`diff`/`stateVector`；文档大小**默认不设上限**（2026-10-20 起；`crdt-doc/v2` 以有界窗口流式读、分段写），research-docs 页面同样按窗口读写、目录与讨论按游标分页，research-canvas 图从不整份出 Head，均不再传 `maxDocumentBytes`；`inspect` 原地只读活副本（不编码、不复制；读回调里发生写事务即丢弃该副本并拒绝）；拒绝码用的就是 `crdt-doc/v1` 的；`onChanged` 变化接缝（apply 之后、仅成功、compaction 不触发） |
| `capability.ts` | `crdt-doc-v1:<owner>` Object：封闭表、强制策略、编辑租约。见上 |
| `wake.ts` | ADR 0006 可信扇出。见上 |
| `seed.ts` | 部署预置的演示文档（《协作文档使用说明》《团队便签》），只在文档为空时合并，幂等 |
| `types.ts` | `CrdtScopeGrant`：文档清单 + `mayEdit` + store + `authority`（Gate 三个动词）+ `close()` |
| `local-port.ts` | 进程内可信消费者用的 `CrdtDocPort`。**它存在本身是撞墙记录的一部分**：`createRemoteCall` 因为 `wireProblems` 非空拒绝构造，所以到达校验只能手写（用 kit 的零件拼，缺的那一件因此看得见） |

## 明确不做

- **不存 presence/awareness**：§15.4 要求临时状态不进持久文档，最便宜的保证是**没有地方放**。
- **不做服务端 UndoManager**：undo 属于握着用户意图的编辑器；服务端的 undo 会撤销同事的工作。
- **不做内容推送**：wake（`wake.ts`）只说「变了」，从不带一个字节的内容——
  内容要过 Gate，而那条 SSE 不是 App 的授权路径（ADR 0006 §3.2）。
- **不复用 `app-state`**：§15.1 明令「不得把 CRDT 高频二进制 update 塞进 JSON App event stream」。
  实测理由见 worklog：那边每次读都 `readSince(0)` 全量重投影，且没有任何 compaction。

## 授权接缝

`session-resource/crdt-grant.ts`，与 `workspace-grant.ts` / `notify-grant.ts` **同构四步**，
第三步经 `CrdtDocCapabilities.open` 派生真实 kernel Context（池化每实例一份）。
2026-08-10 起 `sessions-workspace-write-crdt/v1` 声明两个词元；在任何**更老**
契约 digest 下打开的实例仍然全部 `no_authority`——激活不重释旧同意。

## 测试

```bash
npx vitest run --project node packages/bot/src/crdt-doc packages/bot/src/agent-resources/crdt-doc.e2e.test.ts packages/bot/src/session-resource/crdt-grant.test.ts --maxWorkers=1
```

| 文件 | 证明什么 |
|---|---|
| `log.test.ts` | document id 挡住穿越；torn tail 丢弃、之前的全留；校验和不符即停；不是本格式的文件**拒绝打开**而不是覆盖；compaction 的崩溃窗；坏 base 降级回日志 |
| `store.test.ts` | 「答复之前已在盘上」（不 close 就换一个 store 打开）；坏 update 一个字节也不写；超限拒绝且旧内容完好；删除-only 的 diff 不算 empty；compaction 崩溃窗下文档一致 |
| `wake.test.ts` | 一阵合并 = 一条 wake；发起者不被叫醒；scope 关了拦在半路；窗口限额丢弃；`onChanged` 只在成功合并后触发、compaction 不触发、监听者抛异常不吞合并 |
| `../agent-resources/crdt-doc-v2.e2e.test.ts` | v2：App 适配器经协调器逐参数窗口（`wire-limits`）→ provider → store；1.5 MB 粘贴分段推送、另一实例流式打开、400 KB 增量流式跟随、重开 store 一致；小文档仍是 v1 字段集；分段缺口拒绝并丢弃、从 0 重来成功；无编辑租约不暂存；实例关闭释放流 |
| `../agent-resources/crdt-doc.e2e.test.ts` | 整条纵切 + **两副本同位置并发编辑收敛**；每次读花一个 `read_document` 决定；**编辑租约**：一张卡、等待中不重复出卡、批准后合并、拒绝后 no_authority、撤销后停在下一次合并；`list_docs` 是第一叫得动的动作；各拒绝零 store 调用；kit 的 conformance |
| `../session-resource/crdt-grant.test.ts` | 旧契约实例照旧全拒且原因是词元；第五契约经**真实 kernel** 全链路：读免批、编辑出真卡、owner 批准、别人看不见卡、撤销后 `alive()` 变假；种子幂等且不覆盖人写过的文档 |
