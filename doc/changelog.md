# 已修复问题历史

> **本文件已冻结，不再维护。** 它只覆盖 2026 年 3 月项目起步阶段（编译修复、
> 飞书卡片对齐、首轮端到端联调），此后的改动一律没有记在这里。当作那段历史的
> 存档读，不要当作现状。
>
> 最近发生了什么，看 `doc/deliveries/README.md`。

> 从 CLAUDE.md 归档。按批次记录，供需要时查阅。

---

## 已修复（2026-03-16 编译修复）

1. `user/manager.ts` — `require("node:fs")` 改为 ESM 顶层 import
2. `session/session.ts` — `import.meta.dirname` 改为 `fileURLToPath(import.meta.url)` + `path.dirname`
3. `session/manager.ts` — `@anthropic-ai/claude-code-sdk` 改为 `@anthropic-ai/claude-agent-sdk`（正确包名）
4. `router/commands.ts` — `require("node:fs")` 改为 ESM 顶层 import
5. `session/session.ts` — `systemPrompt` 改为 `{ type: "preset", preset: "claude_code", append }` 格式
6. `package.json` — SDK 依赖改为 `@anthropic-ai/claude-agent-sdk@^0.2.76`
7. `pnpm-lock.yaml` — 依赖已安装，编译通过
8. `channel/feishu.ts` — 飞书 SDK API 对齐（`LoggerLevel.warn`、`wsClient.start({eventDispatcher})`）
9. `config.ts` — `deepMerge` 类型转换修复
10. `session/session.ts` — `EventEmitter` 改为命名导入；`mcpServers` 改为 `Record<string, Config>` 格式

## 已修复（2026-03-16 端到端测试）

11. 飞书卡片 `header.title` 必须为 `{ tag: "plain_text", content }` 对象，不能是裸字符串
12. 飞书卡片 `collapsible_panel` 需要 `expanded`、`header`（非 `title`）、`vertical_spacing`、`background_color`
13. 飞书卡片文本元素应为 `{ tag: "div", text: { tag: "lark_md", content } }`，非 `{ tag: "markdown", content }`
14. 注册卡片使用了飞书不支持的 `input` action 元素 → 改为文本消息交互注册
15. SDK `env` 参数是替换 `process.env` 而非合并 → `session.ts` 改为先 spread `process.env` 再覆盖自定义字段
16. 未知命令 fallthrough 给 Agent → 改为回复 "未知命令"
17. `text` + `result` 事件重复发文本消息 → 飞书端统一走 progress 通道更新卡片
18. `result`/`status_change` 事件进了节流队列被覆盖丢失 → 关键事件绕过节流直接发送
19. 缺少消息收发日志 → router/session 加了 incoming message、executing prompt、session event 日志

## 已修复（2026-03-16 飞书 UI + 命令修复批次）

20. E1: /agent 命令缺失 → 实现交互式卡片模式：agent card mode + followup form + card↔session 映射
21. E2: /sessions 无飞书 UI → 飞书端显示 `buildSessionSelectCard` 按钮卡片，支持 switch/resume 模式
22. E3: /config 无飞书卡片 → 实现 `buildConfigCard` 表单（code_preset toggle + prompt checkers + plugin checkers + form_submit）
23. E4: 飞书插件 manifest 缺失 → 创建 `plugins/feishu-file/manifest.json` 和 `plugins/feishu-lark-mcp/manifest.json`
24. E5: /auth 无效 → `feishu-oauth.ts` 补全 Device Flow（startDeviceAuth + pollForToken），/auth /auth-status /auth-revoke 三个命令接入
25. E6: Delegate 架构偏差 → Delegate 实际已是 Router 第一方（DelegateHandler 在 Router 内实例化），MCP server 仅作底层工具传输。委派卡片改用 `buildDelegationApprovalCard()`
26. 飞书卡片回调未注册 → FeishuProvider 注册 `card.action.trigger` 事件处理器，解析 action_data + form_value，转为 ChannelEvent.action
27. 缺少 /clear /resume 命令 → 新增 /clear（/new 别名）、/resume（飞书卡片选择 UI）
28. /remote 无飞书选择卡片 → 实现 `buildRemoteSelectCard` 按钮卡片
29. Router handleAction 不完整 → 扩展支持 session_select/session_cancel/remote_select/remote_off/remote_cancel/config_submit/agent_followup
30. index.ts 未初始化 authManager → 添加 FeishuAuthManager 初始化并传给 Router

## 已修复（2026-03-16 Router + Card 回调修复批次）

31. F1: 卡片回调 channel 解析失败 → 飞书 card.action.trigger 回调数据是嵌套结构（`operator.open_id` / `context.open_chat_id`），原代码读的是顶层平铺字段。同时 `open_chat_id` 在 P2P 和群聊中都存在，需尝试两种 channel ID 模式
32. F2: /new 不能创建新对话 → /new 命令未调用 `exitAgentCardMode()`，导致新 session 事件仍更新旧卡片
33. F3: Agent 卡片步骤无法展开查看细节 → `tool_start` 未存储 `event.input` 到 detail，且 collapsible 只显示最后 3 个改为 5 个
34. F4/F5: /config 和 /resume 卡片提交无效 → 依赖 F1 修复（channel 解析问题）
35. cardSessionMap 3 秒 setTimeout 不可靠 → 改为在 handleSessionEvent 中每次事件都尝试注册映射

## 已修复（2026-03-16 卡片替换 + /resumecard 批次）

36. 卡片按钮点击后不消失 → `handleCardAction()` 现在返回同步卡片替换（`{ card: { type: "raw", data }, toast }`），6 个确认/取消卡片
37. /resume 后第一轮结果覆盖选择卡片 → `ChannelOutput.card` 新增 `trackAsProgressCard` 标志，选择/配置等瞬态卡片不设置 `cardMessageId`
38. 缺少 /resumecard → 新增命令，支持 `/resumecard [N]`，通过 `status="ready"` 触发带 followup form 的卡片
39. /config 卡片提交无效果 → 同步卡片替换已覆盖（`buildConfigSavedCard` 展示保存结果），Router 仅做 DB 持久化
40. Router action handler 发重复文本消息 → 移除 remote_select/remote_off/config_submit 中被同步卡片替换覆盖的文本发送

## 已修复（2026-03-16 TaskRegistry + 卡片修复批次）

41. G1: /agent 会话隔离不完整 → 引入 `TaskRegistry`（`router/task-registry.ts`），/agent 和 delegation 统一为 `SpawnedTask`。`startAgentCard()` 不再调用 `switchSession()`，通过 TaskRegistry 独立路由事件到卡片。主聊天框的 `userActiveSession` 不受影响。支持多个 /agent 并发卡片
42. G2: /resumecard 恢复的卡片缺少历史信息 → 新增 `reconstructHistory()`（`feishu-card.ts`），从 DB rounds 表解析事件 JSON 重建 `HistoryRound[]`。/resumecard 在 `enterAgentCardMode()` 后、发送 ready 卡片前注入历史
43. G3: /config 卡片表单不显示 → `buildConfigCard()` 中 `md()` 元素（人设选择、插件标题）从 form 内移到 form 外。飞书 form 只包含 checker + submit button
44. 卡片工具步骤重复显示 → `buildAgentProgressCard()` 移除 `md(stepContent)` 摘要列表，改为每个 step 独立 `collapsible` 面板（匹配 v1 Python 格式）
45. FeishuChannel `agentCardMode` boolean → `activeTaskId: string | null`，支持 task 级别的卡片状态跟踪
46. DelegateHandler 事件路由统一 → 不再内部监听 delegate session 事件，改由 Router 通过 TaskRegistry 统一路由。结果注入父 session 逻辑移至 `Router.handleTaskSessionEvent()`

## 已修复（2026-03-17 MCP 装饰器批次）

47. MCP 装饰器未实现 → 创建 `plugins/mcp-decorator/src/index.ts`（NDJSON stdio 中间人），自动注入 `useUAT: true` + `task_v2_task_create` members 验证。`session.ts` 在 `buildMcpServers()` 中用装饰器包装 lark-mcp。Router 传递 `userOpenId` 到 SessionConfig
48. SessionConfig 缺少 userOpenId → `types.ts` 新增字段，Router 从 `user_identities` 表查 feishu open_id 并注入
49. plugins 路径错误 → `session.ts` 中 `buildMcpServers()` 引用 decorator 和 delegate 的路径用了 `../../plugins/`，从 `packages/bot/src/session/` 只回到 `packages/bot/`，实际 plugins 在项目根 `v2/plugins/`。改为 `../../../../plugins/`
50. OAuth token 刷新 crash → `feishu-oauth.ts` 的 `refreshUserToken()` 未检查 API 错误响应，`data.data` 为 undefined 时 crash。添加 `code !== 0` 检查
51. /auth 成功后不生效 → `/auth` 完成后未清除当前活跃 session 绑定，导致后续消息复用旧 session（无 UAT）。添加 `clearActiveSession()` 调用
52. Agent 不知道用户 open_id → `session.ts` 构建系统提示词时注入 `当前用户信息` 段落（open_id + username）

## 已修复（2026-03-17 Python CLI + session 管理批次）

53. CLI 缺乏 Rich 渲染 → 新建 `cli/cli.py`（Python Rich CLI），从 v1 移植，对接 v2 WebSocket JSON 协议
54. formatter 导致 CLI 文本重复 → `text` 和 `result` session event 统一为 `progress` 类型
55. CLI 提示符 `> >` 重复 → 改用 v1 的 `response_done` 事件同步模式
56. `/sessions` 显示大量空 session → 所有 session 列表命令加 `filterSessions()` 过滤
57. session firstPrompt 为 "(auto)" → `session.send()` 中 placeholder 值被实际用户消息覆盖；`SessionManager` 在 `status_change: running` 时同步 DB
58. 跨客户端输入不同步 → Router 发送 `user_input` 事件

## 已修复（2026-03-17 跨端同步 + 显示修复批次）

59. `user_input` 类型缺失 → `ChannelOutput` 新增 `user_input` 变体
60. session 列表显示 "(auto)" → 新增 `displayPrompt()` 辅助函数，统一 14 处 session 显示

## 已修复（2026-03-17 统一事件路由重构）

61. Router 双路由（BindingManager + TaskRegistry）导致事件路由碎片化 → 新增 `getAllSubscribers()` 合并两个管理器的 channel，统一广播循环。删除 `handleTaskSessionEvent()`、`broadcastToChannels()`
62. `broadcastUserInput()` 散在多处（handleMessage + agent_followup + startAgentCard）→ Session `send(prompt, meta?)` 发射 `user_input` SessionEvent，Router 统一路由。`SessionEvent` 新增 `user_input` 类型 + `UserInputMeta` 接口
63. `startRound()` / `trackRoundEvent()` 并发消息覆盖 roundState → 改为事件驱动的 `onUserInput()` / `onResult()`，prompt↔result 配对由 session 顺序保证（`user_input(A) → result(A) → user_input(B) → result(B)`）
64. `/resumecard` 卡片 followup 发送到错误 session → `session_select` resumecard 处理中，`channel.send()` 后未注册 cardMessageId 到 TaskRegistry。`agent_followup` 的 `findByCardMessageId()` 失败后回退到 channel 的 active session（错误）。修复：await 卡片发送后立即 `registerCardMessageId()`
65. Router 调试日志不足 → `getAllSubscribers()`、`user_input` 路由、`agent_followup` session resolution 添加 debug 级别日志
