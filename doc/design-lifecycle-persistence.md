# 生命周期与持久化设计 — drain 式优雅重启

> **历史文档。** 记录 2026-07 drain 与恢复机制的设计，其中表名、关闭顺序和部署脚本细节不再代表 v4；当前操作读 `doc/runbooks/deployment.md`，实现读 `packages/bot/src/lifecycle.ts`。

> 2026-07-20。动机：双人联调期间任何重部署都会重启 bot 进程；要求 ①活跃任务服务完再退出 ②准备期不接新 agentic loop ③任务/session/汇报过程重启后正确恢复。
> 现状实锤：07-19 15:04 重启撞 30s 强杀（`Shutdown timeout exceeded`），且新旧进程并存 20s 抢飞书 WS。
> 原则：持久化是一等需求，状态各归其位，不打散补丁。

## 1. 目标与非目标

**目标**
- SIGTERM 后进入 **draining**：不再让新消息进入 agent loop（排队落库+回执），等进行中的轮次/秘书任务自然完成（预算内），然后才断开 provider、退出。
- 重启后：openai 会话历史与人设无缝恢复（已由 `llm_conversations`/ConversationCache 完成）；排队消息重放；跨用户审批恢复；被打断的秘书起草给用户诚实通知；旁听笔记不丢。
- 部署脚本先 build 后杀、等旧 PID 消失再起新进程。

**非目标（本轮明确不做，记录理由）**
- **零空窗蓝绿**：同一飞书 app 只允许一个 WS 事件客户端，双进程 handoff 不可行。残余空窗 = 旧进程断 WS → 新进程 ready（~10-20s），此窗内飞书消息不推送也不补发，接受并靠脚本压缩窗口。
- **TaskRegistry 落库**（/agent 卡片、委派任务映射）：v1 主线功能、秘书网络联调不依赖；重启后旧 /agent 卡按钮失效，记入已知限制。
- **中断轮次的 prompt 找回**：drain 预算内绝大多数轮次自然完成；预算耗尽被 abort 的轮次刷卡片终态告知用户，不做 prompt 级重放（半执行的 agent 轮重放有副作用风险）。
- Responses 路径 `initialized` 后不带 instructions 的既有行为：原样持久化、不改语义。

## 2. 内存态盘点与处置裁决

| 状态 | 位置 | 重启影响 | 处置 |
|------|------|----------|------|
| openai 会话历史+人设 | llm-query 两个 Map | 全部失忆+丢人设 | ✅ 已落库 `llm_conversations`（v10，write-through ConversationCache） |
| 进行中/排队轮次 | `activeRounds` + Semaphore waiting + Router roundState | prompt 未落库，打断即丢 | **drain 等完**；超时 abort + 卡片终态 |
| draining 期间新消息 | （原：直接进 loop 或断线丢失） | 丢失无感知 | **`pending_inbound` 表**：落库+回执，启动后经 provider 重放 |
| 跨用户审批 pending | `pendingCrossUserQueries` Map | 审批卡变死、结果卡永不来（发起方不阻塞，字段全可序列化） | **`cross_user_pending` 表**：写入即落库，启动恢复进 Map，>7 天弃 |
| 秘书起草/整理任务 | `drafting`/`reformatting` Set + lease | DB 无半成品（幂等安全），但用户等一张永远不来的卡 | **`secretary_jobs` 表**：任务起止登记；启动 sweep → 给发起 channel 发"已中断请重发"卡 |
| 对齐群旁听笔记 | `pendingRoomNotes` Map | 会议秘书漏一段群聊上下文 | **`room_notes` 表**：push 即落库，flush 即删 |
| 进行中旁听轮标记 | `silentRounds`/`revealedBystanderRounds` | 轮次已被 drain 等完/abort，标记无残值 | 不持久化（无意义） |
| 并发分支历史标记 | `sessionsNeedingHistoryContext` | 重启后无进行中并发分支 | 不持久化（llm_conversations 已根治失忆） |
| 活跃进度卡 message id | FeishuChannel 私有 `cardSlots` | 卡片永远停在"运行中" | Channel 接口新增 `finalizeActiveCards(note)`；**仅 drain 超时 abort 路径**调用 |
| Runner 连接 | RunnerGateway conns | Runner 自动重连（15s keepalive 已修） | 无需处理 ✓ |
| /agent、委派任务 | TaskRegistry 三个 Map | 旧卡按钮失效 | 本轮不做（见非目标） |

## 3. 生命周期状态机 — `lifecycle.ts`

```
running ──beginDrain()──▶ draining ──drain() settle/超时──▶ stopped
```

`LifecycleController`：
- `phase`: `running | draining | stopped`；`isDraining` 供 Router 闸门查询。
- `drain(waiters, budgetMs)`：500ms 轮询各 waiter 的 `busy()` 计数直到全 0 或预算耗尽；返回 `{clean, stragglers}`。waiter 是"名字+计数函数"，不搞回调编织，可测。
- Waiters：`SessionManager.runningRoundCount()`（activeRounds 含 semaphore 排队者，status=running 即涵盖）+ `SecretaryService.activeJobCount()`（drafting.size + reformatting.size；lease 轮间隙也算 busy）。

**新 shutdown 顺序（index.ts）**：
1. `lifecycle.beginDrain()` —— Router 闸门即刻生效；**飞书 WS 保持在线**（继续收消息→排队，不丢）
2. `lifecycle.drain(waiters, config.lifecycle.drain_timeout_s*1000)`（默认 180s）
3. 不干净时：对活跃 channel `finalizeActiveCards("⏸ 服务重启，本轮已中断，请稍后重发")` → `sessionManager.shutdown()`（abort 残余）
4. `providers.shutdown()`（此刻才断飞书 WS）→ `runnerGateway.stop()` → `router.shutdown()` → `store.close()`
5. 总兜底强杀计时 = drain 预算 + 30s（替代原固定 30s）

## 4. Router 闸门与重放

**闸门**：`Router.onChannelEvent` 顶部检查 `lifecycle.isDraining`：
- `message` → `store.savePendingInbound(channelId, senderId, text)` + 回执"🔄 正在升级重启，消息已排队，完成后自动处理"
- `action`（按钮）→ 回执"⏳ 系统正在重启，请稍后重试此操作"。**不排队**：approve/send 类动作重放有二次执行风险，明确拒绝比静默重放诚实。
- `disconnect` → 放行（无副作用）

**重放**：新进程 `providers.start()` 完成后（WS 已连，channel 基建可用），`store.takePendingInbound()`（事务：读全部+删除），按 channelId 前缀分发给对应 provider 的 `replayInbound(channelId, senderId, text)`——feishu 实现 = getOrCreateChannel + onChannelEvent 原链路，channel 必然存在；ws 客户端未重连的丢弃+日志。重放 fire-and-forget，不 await 轮完成，与新入站消息自然交错。

## 5. 存储 — migration v11

```sql
pending_inbound(id PK AUTOINC, channel_id, sender_id, text, received_at)
cross_user_pending(request_id PK, payload /*PendingCrossUserQuery JSON*/, created_at)
secretary_jobs(id PK, username, kind /*draft|revise|reformat*/, progress_channel_id, description, started_at)
room_notes(id PK AUTOINC, channel_id, note, created_at) + idx(channel_id)
```

接线：
- cross-user：`enqueueCrossUserApproval` 写 Map+表；approve/reject 删两处；`restore()` 载表进 Map（>7 天丢弃）。
- secretary_jobs：`guardDrafting`/reformat 守卫进入时 insert、finally delete；`restore()` sweep 残行 → 向 `progress_channel_id` 发中断卡 + 删行。
- room_notes：`pushRoomNote`/`flushRoomNotes` 改为 store 读写（保留 20 条上限语义）。

## 6. 部署流程 — `scripts/dev-restart.sh`

build（旧进程仍在服务，失败即中止）→ SIGTERM → 等 PID 消失（≤240s，覆盖 drain 预算）→ 起新进程 → 等日志 ready 标记。杜绝 07-19 的双进程并存。

## 7. 测试策略

- LifecycleController：waiter 归零/超时路径单测。
- session.drain：running 轮自然结束 vs 超时 abort。
- Store 新表 CRUD + takePendingInbound 事务语义。
- room_notes/cross_user_pending/secretary_jobs 各自的重启恢复单测（新建 Store 实例模拟重启）。
- e2e（harness）：draining 闸门排队→回执→重放全链路；会议秘书"重启后记忆仍在"（ConversationCache 已覆盖组件级，e2e 补 Router 级）。
