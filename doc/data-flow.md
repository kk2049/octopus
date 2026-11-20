# 数据流全景

> **历史文档。** 记录 2026-03 Claude Bot v2 的消息与会话流，路径和持久化模型不再代表 v4；当前行为从相关包级文档、`.claude/rules/` 与代码进入。

## 1. 正常消息流（飞书私聊）

```
飞书私聊消息 "帮我写脚本" (open_id: ou_xxx)
  │
  ① FeishuProvider (WS 线程) 收到事件
  ② 查找/创建 FeishuChannel(type: "feishu_p2p", id: "feishu:p2p:ou_xxx")
  ③ handler.onChannelEvent("feishu:p2p:ou_xxx", { type: "message", text: "帮我写脚本", senderId: "ou_xxx" })
  │
  ④ Router.handleEvent("feishu:p2p:ou_xxx", ...)
  ⑤ userManager.resolve("feishu", "ou_xxx") → User("alice")
  ⑥ 查 channelSession["feishu:p2p:ou_xxx"] → 无
  ⑦ sessionManager.create({ workdir: "/data/users/alice/workspace/20260315_xxx", ownerUsername: "alice" }) → Session#1
  ⑧ 绑定: channelToUser["feishu:p2p:ou_xxx"] = "alice"
  ⑨       channelSession["feishu:p2p:ou_xxx"] = "session-1"
  ⑩       sessionChannels["session-1"] = Set(["feishu:p2p:ou_xxx"])
  │
  ⑪ Session#1.send("帮我写脚本", { sender: "alice", via: "飞书", channelId: "feishu:p2p:ou_xxx" })
  │  → emit({ type: "user_input", text: "帮我写脚本", meta: { sender, via, channelId } })
  │  → Router.handleSessionEvent: onUserInput() 持久化 round, 广播到其他订阅者（排除发送者 channel）
  │  env: HOME=/data/users/alice, CLAUDE_CONFIG_DIR=/data/users/alice/claude-sessions
  │
  ⑫ Session#1 内部:
  │  status = "running"
  │  for await (msg of query({ prompt, options })):
  │    emit(thinking/tool_start/text/result)
  │    → Router.handleSessionEvent: getAllSubscribers() → 广播到所有订阅者
  │
  ⑬ result 事件 → Router.onResult() → store.saveRound("session-1", roundData)
```

## 2. 飞书群聊（personal 模式）

```
群聊 @Bot "帮我查日志" (chat_id: oc_xxx, sender: ou_alice)
  │
  ① FeishuChannel(type: "feishu_group", id: "feishu:group:oc_xxx")
  ② senderId = "ou_alice"
  │
  ③ Router: userManager.resolve("feishu", "ou_alice") → User("alice")
  ④ getOrCreateSession(user="alice", channel="feishu:group:oc_xxx")
  │  → 群聊 personal 模式: 每个用户独立 session
  │  → Session#3 (alice 在这个群的 session)
  │
  ⑤ Session#3.send("[alice] 帮我查日志")
  ⑥ 结果广播 → FeishuChannel → 飞书群消息（@alice 前缀）
```

## 3. 飞书群聊（shared 模式）

```
群聊 @Bot "帮我写方案" (chat_id: oc_xxx, sender: ou_alice)
  │
  ① FeishuChannel(type: "feishu_group", id: "feishu:group:oc_xxx")
  ② Router: resolveUser → User("alice")（但不绑定到 channelToUser）
  ③ getGroupSession("feishu:group:oc_xxx")
  │  → 查 group_config → group_mode = "shared"
  │  → Session 归属于群组，不归属于特定 user
  │  → 已有 Session#5 → 复用
  │
  ④ Session#5.send("[alice] 帮我写方案")
  ⑤ 结果广播 → FeishuChannel → 群消息（所有人可见）

随后 bob @Bot "上面这个方案加上成本分析"
  → 同一个 Session#5.send("[bob] 上面这个方案加上成本分析")
  → Agent 能看到 alice 和 bob 的完整对话历史
```

## 4. 跨平台 session 共享

```
Alice 在飞书私聊中进行了 3 轮对话（Session#1）

Alice 在 CLI 连接 Bot:
  WS 认证: { token: "token-alice-xxx" } → User("alice")
  │
  Router: channelSession 中无 CLI channel 的绑定
  → getOrCreateSession() 创建新 session 或绑定到已有 session
  → CLI 输入 → Session.send(text, { sender: "alice", via: "cli", channelId: "cli:xxx" })
    → Session emit user_input 事件
    → Router.handleSessionEvent: getAllSubscribers() → 飞书 + CLI
    → 飞书 channel 收到 user_input（sender: "alice", via: "cli"）
    → Agent 响应事件统一广播到所有订阅者
```

## 5. Delegate 子任务流

```
Session#1 (alice) 执行中:
  Agent 调用 delegate_task 工具
    → MCP Server 写 spec 到 /data/users/alice/workspace/xxx/.delegate/task-1.json
  Agent 继续执行...
  Agent 执行完成

Session#1.scanDelegations():
  → 发现 task-1.json → emit({ type: "delegation_request", taskId: "task-1", spec })

Router.handleSessionEvent("session-1", delegation_request):
  ① pendingDelegations.set("task-1", { spec, parentSessionId: "session-1", username: "alice" })
  ② channel 是飞书 → 发送审批卡片

用户点击 "批准":
  ③ Router.approveDelegation("task-1")
  ④ sessionManager.create({
       workdir: "/data/users/alice/workspace/delegate-task-1",
       ownerUsername: "alice",
       enableDelegate: false,
       remoteMcp: spec.remote ? remotes[spec.remote] : null,
     }) → DelegateSession#4
  ⑤ sessionChannels["session-4"] = Set([...session-1 的 channels])
  ⑥ DelegateSession#4.send(spec.prompt)
     → 流式事件 → Router 广播

DelegateSession#4 完成:
  ⑦ Router 格式化结果
  ⑧ Session#1.send("[委派任务完成] 任务: xxx\n结果: ...")
  ⑨ DelegateSession#4.destroy()
```

## 6. 新用户注册流

```
未注册用户在飞书 @Bot "你好" (open_id: ou_new)
  │
  ① Router: userManager.resolve("feishu", "ou_new") → undefined
  ② FeishuChannel.send({ type: "card", card: buildRegistrationCard(...) })
  │
  ③ 用户在卡片输入 "charlie"
  ④ Router 收到 action: { actionId: "register", payload: { username: "charlie" } }
  ⑤ userManager.register("charlie", { provider: "feishu", externalId: "ou_new" })
     → mkdir /data/users/charlie/...
     → INSERT INTO users, user_identities
  ⑥ channel.send({ type: "text", content: "欢迎 charlie！" })
  │
  ⑦ 下次消息 → 正常流程
```
